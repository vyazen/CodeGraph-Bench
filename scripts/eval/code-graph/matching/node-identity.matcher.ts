/**
 * Node identity matcher — matches tool graph nodes to oracle ground-truth nodes.
 *
 * Per CODE_GRAPH_EVAL_PLAN.md §5: "Tools mint IDs differently, so match on
 * (normalized_path, name, startLine) with a ±2-line tolerance. This is where
 * the engineering time actually goes."
 *
 * Known failure modes handled:
 * - Overloads sharing a name → pick nearest startLine (+ same kind)
 * - Anonymous/arrow functions → skip (name is empty or '[anonymous]')
 * - Re-exports → a re-export has the same name but different path; matches
 *   only if the path also matches
 * - Line-number conventions differ per tool. Some tools record a symbol's start
 *   at its leading JSDoc/decorator block; the TS compiler records it at the
 *   `class`/`function` keyword. Those offsets are routinely 3–10 lines. So the
 *   start line is used only to DISAMBIGUATE between same-(path,name) candidates
 *   (nearest wins), NOT as a hard gate. A unique (path,name) match is accepted
 *   regardless of line delta — otherwise a correctly-extracted symbol whose doc
 *   comment shifts its line is scored as both a false positive and a false
 *   negative (double penalty for a correct result).
 */

import type { GraphNode, OracleSymbol } from '../types';

export interface MatchResult {
  /**
   * F22 — tool nodes collapsed as duplicates of an already-seen
   * (path, canonicalName, kind, startLine) row before matching even ran.
   * These are neither matched nor counted in `toolUnmatched`/FP: a tool
   * emitting the same symbol twice is a modelling note, not N-1 wrong
   * answers. Reported as its own column, never silently dropped.
   */
  duplicateToolNodesCollapsed: number;
  /** Tool nodes that matched an oracle node. */
  matched: Array<{ oracle: OracleSymbol; tool: GraphNode }>;
  matchedOracleLocalIds: Set<string>;
  /** Fraction of oracle nodes matched (0-1). */
  oracleMatchRate: number;
  /** Oracle nodes the tool missed. */
  oracleUnmatched: OracleSymbol[];
  /** Fraction of tool nodes matched (0-1). If < 0.5, comparison is invalid. */
  toolMatchRate: number;
  /** Tool nodes with no oracle counterpart. */
  toolUnmatched: GraphNode[];
}

/** Normalize a path for matching: forward slashes, no leading ./, lowercase drive. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('./')) {
    s = s.slice(2);
  }
  // Strip a leading repo-root prefix if both sides have one — we rely on relative paths
  return s;
}

/** True if a name is matchable (not anonymous/computed). */
function isMatchableName(name: string | undefined | null): boolean {
  if (!name) {
    return false;
  }
  if (name === '[computed]') {
    return false;
  }
  if (name === '[anonymous]') {
    return false;
  }
  if (name === 'default') {
    return true; // export default is matchable
  }
  return true;
}

/**
 * Strip an accessor naming convention so `get:min`/`set:min` (the oracle's and
 * Vyazen's convention) matches a plain `min` (GitNexus/Graphify/Potpie's
 * convention). Per F1 in CODE_GRAPH_EVAL_FAIRNESS_PLAN.md: matching is
 * name-exact, so without this every accessor is scored as both FP and FN for
 * any tool that doesn't share the oracle's naming convention.
 *
 * Recognized conventions: `get:x` / `set:x`, `get x` / `set x`, `getter:x` /
 * `setter:x`, `[get]x` / `[set]x`.
 */
export function canonicalName(name: string): string {
  const bracketed = /^\[(?:get|set)\](.+)$/.exec(name);
  if (bracketed) {
    return bracketed[1];
  }
  const prefixed = /^(?:get|set)(?:ter)?[: ](.+)$/.exec(name);
  return prefixed ? prefixed[1] : name;
}

/** True if a name uses a recognized accessor-prefix convention. */
export function isAccessorName(name: string): boolean {
  return canonicalName(name) !== name;
}

interface OracleIndexEntry {
  path: string;
  symbols: OracleSymbol[];
}

/**
 * F22 — a tool that emits the same symbol twice (same path, canonicalName,
 * kind and startLine) shouldn't have its second row fail to match and land
 * in `toolUnmatched` as a fabricated FP: it isn't a distinct wrong answer,
 * it's the same right answer twice. Collapse before matching and report the
 * collapsed count separately, so the effect is visible without punishing it.
 */
function dedupeToolNodes(nodes: GraphNode[]): {
  duplicatesCollapsed: number;
  nodes: GraphNode[];
} {
  const seen = new Map<string, GraphNode>();
  let duplicatesCollapsed = 0;
  for (const n of nodes) {
    const key = `${normalizePath(n.path)}\0${canonicalName(n.name)}\0${n.kind}\0${n.startLine}`;
    if (seen.has(key)) {
      duplicatesCollapsed++;
      continue;
    }
    seen.set(key, n);
  }
  return { duplicatesCollapsed, nodes: [...seen.values()] };
}

/**
 * F22 — duplicate oracle rows sharing (path, localId) make the recall
 * denominator tool-dependent: `matchNodes` claims an oracle symbol at most
 * once, so a tool that matches one copy makes the other vanish from
 * `oracleUnmatched`, while a tool that matches neither is charged an FN for
 * each copy — the same oracle ground truth then has a different `tp + fn`
 * total depending on which tool is being scored. Collapse to one row per
 * (path, localId) so the denominator is identical for every tool.
 */
function dedupeOracleSymbols(symbols: OracleSymbol[]): OracleSymbol[] {
  const seen = new Map<string, OracleSymbol>();
  for (const s of symbols) {
    const key = `${normalizePath(s.path)}\0${s.localId}`;
    if (!seen.has(key)) {
      seen.set(key, s);
    }
  }
  return [...seen.values()];
}

/**
 * Build an index of oracle symbols by (normalized_path, name) for O(1) lookup.
 * Overloads (same name+path) land in the same bucket — resolved by nearest line.
 */
function buildOracleIndex(oracle: OracleSymbol[]): Map<string, OracleSymbol[]> {
  const idx = new Map<string, OracleSymbol[]>();
  for (const sym of oracle) {
    if (!isMatchableName(sym.name)) {
      continue;
    }
    const key = `${normalizePath(sym.path)}\0${canonicalName(sym.name)}`;
    const bucket = idx.get(key);
    if (bucket) {
      bucket.push(sym);
    } else {
      idx.set(key, [sym]);
    }
  }
  return idx;
}

/** Shape both `OracleSymbol` and `GraphNode` satisfy — enough for `pickBest` to disambiguate. */
interface PickableCandidate {
  kind: GraphNode['kind'];
  name: string;
  startLine: number | null;
}

/**
 * Choose the best candidate for a tool node among same-(path,name) candidates.
 * Generic over `OracleSymbol` (oracle matching) and `GraphNode` (cross-tool
 * matching, see `matchToolNodes`) — the disambiguation logic doesn't care
 * which ground truth it's picking from.
 *
 * Line is a tie-breaker, not a gate: prefer candidates of the same kind, then the
 * one nearest by startLine. If the tool node has no startLine, take the first
 * available candidate. A single candidate is always accepted regardless of the
 * line delta (see the module header — doc-comment/decorator line conventions).
 */
function pickBest<T extends PickableCandidate>(tool: GraphNode, candidates: T[]): T {
  // Tools disagree on whether a getter/setter is a Method or a Property — that
  // disagreement is not a fidelity failure (F1). If either side's raw name
  // carries an accessor prefix, treat Method/Property as the same kind for
  // tie-breaking purposes.
  const accessorInvolved =
    isAccessorName(tool.name) || candidates.some((c) => isAccessorName(c.name));
  const isMethodOrProperty = (k: string) => k === 'Method' || k === 'Property';
  const sameKind = candidates.filter((c) =>
    accessorInvolved && isMethodOrProperty(c.kind) && isMethodOrProperty(tool.kind)
      ? true
      : c.kind === tool.kind
  );
  const pool = sameKind.length > 0 ? sameKind : candidates;

  if (tool.startLine === null || tool.startLine === undefined) {
    return pool[0];
  }

  // Candidate startLine is only nullable for the GraphNode-vs-GraphNode path
  // (matchToolNodes) — OracleSymbol.startLine is never null. Treat null as
  // "no line info", i.e. never preferred over a candidate that has one.
  const delta = (candLine: number | null, toolLine: number): number =>
    candLine === null ? Number.POSITIVE_INFINITY : Math.abs(candLine - toolLine);

  let best = pool[0];
  let bestDelta = delta(best.startLine, tool.startLine);
  for (const cand of pool) {
    const d = delta(cand.startLine, tool.startLine);
    if (d < bestDelta) {
      best = cand;
      bestDelta = d;
    }
  }
  return best;
}

/**
 * Match tool nodes to oracle symbols.
 *
 * Strategy:
 * 1. Index oracle by (path, name)
 * 2. For each tool node, find unmatched candidates with the same (path, name)
 * 3. Among them, pick the best by kind + nearest startLine (line is a
 *    tie-breaker, NOT a gate — see the module header)
 * 4. Each oracle symbol can be matched at most once (prevents double-counting)
 */
export function matchNodes(toolNodes: GraphNode[], oracle: OracleSymbol[]): MatchResult {
  // F22 — dedupe both sides before matching so the denominator is
  // tool-independent and a tool's own duplicate rows don't fabricate FPs.
  const { duplicatesCollapsed: duplicateToolNodesCollapsed, nodes: dedupedToolNodes } =
    dedupeToolNodes(toolNodes);
  const dedupedOracle = dedupeOracleSymbols(oracle);

  const oracleIdx = buildOracleIndex(dedupedOracle);
  const matched: Array<{ oracle: OracleSymbol; tool: GraphNode }> = [];
  const matchedOracleKeys = new Set<string>(); // key: path\0localId
  const toolUnmatched: GraphNode[] = [];

  const claimKey = (s: OracleSymbol) => `${normalizePath(s.path)}\0${s.localId}`;

  for (const tool of dedupedToolNodes) {
    if (!isMatchableName(tool.name)) {
      continue;
    }

    const key = `${normalizePath(tool.path)}\0${canonicalName(tool.name)}`;
    const candidates = oracleIdx.get(key);
    if (!candidates || candidates.length === 0) {
      toolUnmatched.push(tool);
      continue;
    }

    const available = candidates.filter((c) => !matchedOracleKeys.has(claimKey(c)));
    if (available.length === 0) {
      toolUnmatched.push(tool);
      continue;
    }

    const chosen = pickBest(tool, available);
    matchedOracleKeys.add(claimKey(chosen));
    matched.push({ oracle: chosen, tool });
  }

  const oracleUnmatched = dedupedOracle.filter(
    (s) =>
      !matchedOracleKeys.has(`${normalizePath(s.path)}\0${s.localId}`) && isMatchableName(s.name)
  );

  const matchableToolCount = dedupedToolNodes.filter((n) => isMatchableName(n.name)).length;
  const matchableOracleCount = dedupedOracle.filter((s) => isMatchableName(s.name)).length;

  return {
    duplicateToolNodesCollapsed,
    matched,
    matchedOracleLocalIds: matchedOracleKeys,
    oracleUnmatched,
    toolUnmatched,
    toolMatchRate: matchableToolCount === 0 ? 0 : matched.length / matchableToolCount,
    oracleMatchRate: matchableOracleCount === 0 ? 0 : matched.length / matchableOracleCount,
  };
}

export interface ToolNodeMatchResult {
  matched: Array<{ reference: GraphNode; tool: GraphNode }>;
  toolUnmatched: GraphNode[];
}

/**
 * Match one tool's nodes against another tool's nodes — for cross-tool
 * coverage comparisons where there is no oracle, one tool (e.g. Vyazen)
 * stands in as the reference. Same (path, canonicalName) + nearest-line
 * strategy as `matchNodes`, but claims each reference node by its own `id`.
 *
 * `matchNodes`' claim key reads `OracleSymbol.localId`, which `GraphNode`
 * doesn't have — passing `GraphNode[]` there collapsed every reference node in
 * a file to the same `path\0undefined` key, capping matches at one per file.
 * This is a separate function rather than a generic parameter on `matchNodes`
 * so that path stays untouched (it's covered by fairness tests) and this one
 * carries its own claim semantics explicitly.
 */
export function matchToolNodes(
  toolNodes: GraphNode[],
  referenceNodes: GraphNode[]
): ToolNodeMatchResult {
  const referenceIdx = new Map<string, GraphNode[]>();
  for (const ref of referenceNodes) {
    if (!isMatchableName(ref.name)) {
      continue;
    }
    const key = `${normalizePath(ref.path)}\0${canonicalName(ref.name)}`;
    const bucket = referenceIdx.get(key);
    if (bucket) {
      bucket.push(ref);
    } else {
      referenceIdx.set(key, [ref]);
    }
  }

  const matched: Array<{ reference: GraphNode; tool: GraphNode }> = [];
  const claimedIds = new Set<string>();
  const toolUnmatched: GraphNode[] = [];

  for (const tool of toolNodes) {
    if (!isMatchableName(tool.name)) {
      continue;
    }

    const key = `${normalizePath(tool.path)}\0${canonicalName(tool.name)}`;
    const candidates = referenceIdx.get(key);
    if (!candidates || candidates.length === 0) {
      toolUnmatched.push(tool);
      continue;
    }

    const available = candidates.filter((c) => !claimedIds.has(c.id));
    if (available.length === 0) {
      toolUnmatched.push(tool);
      continue;
    }

    const chosen = pickBest(tool, available);
    claimedIds.add(chosen.id);
    matched.push({ reference: chosen, tool });
  }

  return { matched, toolUnmatched };
}
