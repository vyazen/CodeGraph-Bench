/**
 * Edge adjudicator (v2 — proper O(1) indexing for target-based matching).
 *
 * Two-tier matching:
 * 1. **Target-based** (preferred): oracle edge has resolved target → tool's
 *    to-node must match by (path, startLine±2)
 * 2. **Name-based** (fallback): oracle edge has no resolved target → match by
 *    target name
 */

import type { GraphEdge, GraphNode, OracleEdge, OracleSymbol } from '../types';

export interface NodeMatch {
  oracle: OracleSymbol;
  tool: GraphNode;
}

export interface EdgeAdjudication {
  /**
   * Abstentions: edges where the tool detected a relationship but did not
   * resolve a distinct target (`fromId === toId` with `resolved === false`).
   * Vyazen exports unresolved calls as self-edges — these are not target
   * claims, so scoring them as false positives punishes the tool for declining
   * to guess. Excluded from precision; reported separately (no silent drop).
   */
  abstained: GraphEdge[];
  falseNegatives: OracleEdge[];
  falsePositives: GraphEdge[];
  /** F9 — the deduped/matched subset of `scoreableOracleEdges`, for call-site multiplicity ("siteCoverage") reporting. */
  matchedOracleEdgesList: OracleEdge[];
  nameOnlyConfirmed: GraphEdge[];
  /** F9 — the oracle rows actually used as the recall denominator: `scoreable !== false` rows collapsed to unique (fromPath, fromLocalId, type, target), each carrying a summed `siteCount`. */
  scoreableOracleEdges: OracleEdge[];
  targetConfirmed: GraphEdge[];
  truePositives: GraphEdge[];
  /**
   * F18 — tool edges that would otherwise be a false positive, but happen to
   * match a `scoreable: false` oracle row by (fromPath, fromLocalId, type,
   * targetName). The oracle couldn't verify the target (external, or
   * unresolvable after every fallback), so the tool's claim can't be
   * confirmed OR refuted — it must not be charged FP for a gap in the
   * oracle's own resolution. Excluded from precision and recall alike;
   * reported as its own column, never silently dropped.
   */
  unscoreableMatched: GraphEdge[];
  /** F9 — oracle rows dropped before matching because `scoreable === false` (target knowably external, or unresolvable after every F10/F12 fallback). Reported as a coverage column, never folded into FN. */
  unscoreableOracleEdges: OracleEdge[];
}

const LINE_TOLERANCE = 2;

function indexNodesById(nodes: GraphNode[]): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const n of nodes) {
    m.set(n.id, n);
  }
  return m;
}

function linesMatch(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return false;
  }
  return Math.abs(a - b) <= LINE_TOLERANCE;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Build oracle edge indices for O(1) lookup, keyed on (fromPath, fromLocalId)
 * rather than fromLocalId alone.
 *
 * F11: `localId` is not unique across files — a class/function/variable name
 * like `_Registered` or `useStyles` recurs in hundreds of files. Keying on
 * `fromLocalId` alone lets a tool edge in file A be "confirmed" by an oracle
 * edge that actually originates from a same-named container in file B. Every
 * oracle edge is path-qualified at push time (see `OracleEdge.fromPath`), so
 * the fix is purely in how the index is keyed.
 *
 * - byName: Map<`${fromPath}\0${fromLocalId}\0${type}\0${targetName}`, OracleEdge[]>
 * - byFromAndType: Map<`${fromPath}\0${fromLocalId}\0${type}`, OracleEdge[]>
 *   (for scanning all oracle edges from a given source with a given type)
 */
function buildOracleIndices(oracleEdges: OracleEdge[]) {
  const byName = new Map<string, OracleEdge[]>();
  const byFromAndType = new Map<string, OracleEdge[]>();

  for (const e of oracleEdges) {
    const ftKey = fromKey(e.fromPath, e.fromLocalId, e.type);
    const nameKey = `${ftKey}\0${e.targetName}`;
    let arr = byName.get(nameKey);
    if (!arr) {
      arr = [];
      byName.set(nameKey, arr);
    }
    arr.push(e);

    let ftArr = byFromAndType.get(ftKey);
    if (!ftArr) {
      ftArr = [];
      byFromAndType.set(ftKey, ftArr);
    }
    ftArr.push(e);
  }

  return { byFromAndType, byName };
}

function fromKey(fromPath: string, fromLocalId: string, type: string): string {
  return `${normPath(fromPath)}\0${fromLocalId}\0${type}`;
}

function isScoreable(e: OracleEdge): boolean {
  return e.scoreable !== false;
}

function targetKeyFor(e: OracleEdge): string {
  return e.targetLocalId
    ? `id:${normPath(e.targetPath ?? '')}\0${e.targetLocalId}`
    : `name:${e.targetName}`;
}

/**
 * F9 — collapse the oracle to unique (fromPath, fromLocalId, type, target)
 * rows before adjudication, carrying `siteCount`, and set aside rows
 * explicitly marked `scoreable: false` (target knowably external, or
 * unresolvable after every F10/F12 fallback tried — see `OracleEdge.scoreable`
 * in `types.ts`). Matching below is strictly 1:1 per oracle edge; without
 * collapsing, a tool that emits ONE edge per unique (caller, target) pair —
 * rather than one per call site — is hard-capped on recall by the oracle's own
 * site-count, which measures call-site multiplicity, not tool quality.
 */
function prepareOracleEdges(oracleEdges: OracleEdge[]): {
  edges: OracleEdge[];
  unscoreable: OracleEdge[];
} {
  const unscoreable: OracleEdge[] = [];
  const byKey = new Map<string, OracleEdge>();
  for (const e of oracleEdges) {
    if (!isScoreable(e)) {
      unscoreable.push(e);
      continue;
    }
    const key = `${fromKey(e.fromPath, e.fromLocalId, e.type)}\0${targetKeyFor(e)}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.siteCount = (existing.siteCount ?? 1) + (e.siteCount ?? 1);
      continue;
    }
    byKey.set(key, { ...e, siteCount: e.siteCount ?? 1 });
  }
  return { edges: [...byKey.values()], unscoreable };
}

export function adjudicateEdges(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
  nodeMatches: NodeMatch[],
  _oracleSymbols: OracleSymbol[]
): EdgeAdjudication {
  const toolNodeById = indexNodesById(toolNodes);
  const toolToOracle = new Map<string, OracleSymbol>();
  for (const m of nodeMatches) {
    toolToOracle.set(m.tool.id, m.oracle);
  }

  const { edges: scoreableOracleEdges, unscoreable: unscoreableOracleEdges } =
    prepareOracleEdges(oracleEdges);
  const { byFromAndType, byName } = buildOracleIndices(scoreableOracleEdges);
  // F18 — a second index over the rows the oracle couldn't verify, keyed
  // identically to the scoreable index. Consulted only after both scoreable
  // tiers miss, so it never steals a legitimate TP from the scoreable index.
  const { byName: unscoreableByName } = buildOracleIndices(unscoreableOracleEdges);
  const matchedOracleEdges = new Set<OracleEdge>();

  const truePositives: GraphEdge[] = [];
  const falsePositives: GraphEdge[] = [];
  const targetConfirmed: GraphEdge[] = [];
  const nameOnlyConfirmed: GraphEdge[] = [];
  const abstained: GraphEdge[] = [];
  const unscoreableMatched: GraphEdge[] = [];

  for (const edge of toolEdges) {
    // Abstention: a self-edge with no resolved target is "relationship detected,
    // target not asserted" — not a false claim. Set aside, don't count as FP.
    if (edge.fromId === edge.toId && edge.resolved === false) {
      abstained.push(edge);
      continue;
    }

    const fromTool = toolNodeById.get(edge.fromId);
    const toTool = toolNodeById.get(edge.toId);
    if (!(fromTool && toTool)) {
      falsePositives.push(edge);
      continue;
    }

    // Resolve oracle from-key (path-qualified — F11). IMPORTS and module-scope
    // calls (from a File node) are keyed by file path — the oracle attributes
    // both to the file's relPath, so fromPath === fromLocalId there. Everything
    // else is keyed by the from-node's matched oracle symbol's own (path,
    // localId): localId alone is not unique across files (e.g. `_Registered`,
    // `useStyles` recur in hundreds of files), so path-qualifying prevents a
    // tool edge in file A from being confirmed by an oracle edge that actually
    // originates in a same-named container in file B.
    let oracleFromPath: string;
    let oracleFromLocalId: string;
    if (edge.type === 'IMPORTS' || fromTool.kind === 'File') {
      oracleFromPath = fromTool.path;
      oracleFromLocalId = fromTool.path;
    } else {
      const oracleSym = toolToOracle.get(edge.fromId);
      if (!oracleSym) {
        falsePositives.push(edge);
        continue;
      }
      oracleFromPath = oracleSym.path;
      oracleFromLocalId = oracleSym.localId;
    }

    const ftKey = fromKey(oracleFromPath, oracleFromLocalId, edge.type);
    const candidates = byFromAndType.get(ftKey);
    const nameKey = `${ftKey}\0${toTool.name}`;
    let matched = false;

    if (candidates) {
      // Tier 1: Try target-based matching (tool's to-node vs oracle's resolved target).
      //
      // Preferred: bridge through node identity. The tool's to-node was matched to
      // an oracle symbol (toOracle); if that symbol IS the oracle edge's resolved
      // target (same path + localId), the edge points at the right code. This is
      // robust to per-tool line conventions (doc-comment/decorator offsets) because
      // the node matcher already absorbed them.
      //
      // Fallback: raw (path, line±2) comparison, for to-nodes the matcher couldn't
      // bind to an oracle symbol (e.g. external targets, unmatched nodes).
      const toOracle = toolToOracle.get(edge.toId);
      for (const cand of candidates) {
        if (matchedOracleEdges.has(cand)) {
          continue;
        }
        if (!cand.targetPath) {
          continue; // oracle didn't resolve this one
        }

        let hit = false;
        if (toOracle && cand.targetLocalId) {
          hit =
            normPath(cand.targetPath) === normPath(toOracle.path) &&
            cand.targetLocalId === toOracle.localId;
        }
        if (!hit && toTool.path && toTool.startLine !== null && toTool.startLine !== undefined) {
          hit =
            normPath(cand.targetPath) === normPath(toTool.path) &&
            linesMatch(cand.targetStartLine, toTool.startLine);
        }

        if (hit) {
          matchedOracleEdges.add(cand);
          truePositives.push(edge);
          targetConfirmed.push(edge);
          matched = true;
          break;
        }
      }
    }

    // Tier 2: Name-based fallback
    if (!matched) {
      const nameCandidates = byName.get(nameKey);
      if (nameCandidates) {
        for (const cand of nameCandidates) {
          if (matchedOracleEdges.has(cand)) {
            continue;
          }
          matchedOracleEdges.add(cand);
          truePositives.push(edge);
          nameOnlyConfirmed.push(edge);
          matched = true;
          break;
        }
      }
    }

    if (!matched) {
      // F18: before charging FP, check whether this edge matches a row the
      // oracle itself couldn't verify (scoreable: false) — by the same
      // (fromPath, fromLocalId, type, targetName) key as Tier 2. If so, the
      // oracle has neither confirmed nor refuted the claim; score it as
      // neither rather than penalising the tool for the oracle's own gap.
      const unscoreableCandidates = unscoreableByName.get(nameKey);
      if (unscoreableCandidates && unscoreableCandidates.length > 0) {
        unscoreableMatched.push(edge);
      } else {
        falsePositives.push(edge);
      }
    }
  }

  // FN = scoreable oracle edges not matched (F9: unscoreable rows never enter
  // this denominator — they're reported separately via `unscoreableOracleEdges`).
  const falseNegatives: OracleEdge[] = [];
  for (const e of scoreableOracleEdges) {
    if (!matchedOracleEdges.has(e)) {
      falseNegatives.push(e);
    }
  }

  return {
    truePositives,
    falsePositives,
    falseNegatives,
    targetConfirmed,
    nameOnlyConfirmed,
    abstained,
    scoreableOracleEdges,
    unscoreableOracleEdges,
    unscoreableMatched,
    matchedOracleEdgesList: [...matchedOracleEdges],
  };
}
