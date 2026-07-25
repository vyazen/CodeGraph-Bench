/**
 * Edge adjudicator (v2 — proper O(1) indexing for target-based matching).
 *
 * Two-tier matching:
 * 1. **Target-based** (preferred): oracle edge has resolved target → tool's
 *    to-node must match by (path, startLine±2)
 * 2. **Name-based** (fallback): oracle edge has no resolved target → match by
 *    target name
 */

import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  OracleEdge,
  OracleSymbol,
} from '../types';

export interface NodeMatch {
  oracle: OracleSymbol;
  tool: GraphNode;
}

export interface EdgeAdjudication {
  falseNegatives: OracleEdge[];
  falsePositives: GraphEdge[];
  truePositives: GraphEdge[];
  targetConfirmed: GraphEdge[];
  nameOnlyConfirmed: GraphEdge[];
}

const LINE_TOLERANCE = 2;

function indexNodesById(nodes: GraphNode[]): Map<string, GraphNode> {
  const m = new Map<string, GraphNode>();
  for (const n of nodes) m.set(n.id, n);
  return m;
}

function linesMatch(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return Math.abs(a - b) <= LINE_TOLERANCE;
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Build oracle edge indices for O(1) lookup.
 * - byName: Map<`${fromLocalId}\0${type}\0${targetName}`, OracleEdge[]>
 * - byTargetPath: Map<`${fromLocalId}\0${type}\0${targetPath}`, OracleEdge[]>
 *   (for target-based matching, keyed by path; line matching done on candidates)
 * - byFromAndType: Map<`${fromLocalId}\0${type}`, OracleEdge[]>
 *   (for scanning all oracle edges from a given source with a given type)
 */
function buildOracleIndices(oracleEdges: OracleEdge[]) {
  const byName = new Map<string, OracleEdge[]>();
  const byFromAndType = new Map<string, OracleEdge[]>();

  for (const e of oracleEdges) {
    const nameKey = `${e.fromLocalId}\0${e.type}\0${e.targetName}`;
    let arr = byName.get(nameKey);
    if (!arr) { arr = []; byName.set(nameKey, arr); }
    arr.push(e);

    const ftKey = `${e.fromLocalId}\0${e.type}`;
    let ftArr = byFromAndType.get(ftKey);
    if (!ftArr) { ftArr = []; byFromAndType.set(ftKey, ftArr); }
    ftArr.push(e);
  }

  return { byFromAndType, byName };
}

export function adjudicateEdges(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
  nodeMatches: NodeMatch[],
  _oracleSymbols: OracleSymbol[],
): EdgeAdjudication {
  const toolNodeById = indexNodesById(toolNodes);
  const toolToOracle = new Map<string, OracleSymbol>();
  for (const m of nodeMatches) {
    toolToOracle.set(m.tool.id, m.oracle);
  }

  const { byFromAndType, byName } = buildOracleIndices(oracleEdges);
  const matchedOracleEdges = new Set<OracleEdge>();

  const truePositives: GraphEdge[] = [];
  const falsePositives: GraphEdge[] = [];
  const targetConfirmed: GraphEdge[] = [];
  const nameOnlyConfirmed: GraphEdge[] = [];

  for (const edge of toolEdges) {
    const fromTool = toolNodeById.get(edge.fromId);
    const toTool = toolNodeById.get(edge.toId);
    if (!fromTool || !toTool) {
      falsePositives.push(edge);
      continue;
    }

    // Resolve oracle from-key
    let oracleFromKey: string;
    if (edge.type === 'IMPORTS') {
      oracleFromKey = fromTool.path;
    } else {
      const oracleSym = toolToOracle.get(edge.fromId);
      if (!oracleSym) {
        falsePositives.push(edge);
        continue;
      }
      oracleFromKey = oracleSym.localId;
    }

    const ftKey = `${oracleFromKey}\0${edge.type}`;
    const candidates = byFromAndType.get(ftKey);
    if (!candidates) {
      falsePositives.push(edge);
      continue;
    }

    // Tier 1: Try target-based matching (tool's to-node vs oracle's resolved target)
    let matched = false;
    if (toTool.path && toTool.startLine !== null) {
      for (const cand of candidates) {
        if (matchedOracleEdges.has(cand)) continue;
        if (!cand.targetPath) continue; // oracle didn't resolve this one
        if (normPath(cand.targetPath) === normPath(toTool.path) && linesMatch(cand.targetStartLine, toTool.startLine)) {
          matchedOracleEdges.add(cand);
          truePositives.push(edge);
          targetConfirmed.push(edge);
          matched = true;
          break;
        }
      }
    }

    if (matched) continue;

    // Tier 2: Name-based fallback
    const nameKey = `${oracleFromKey}\0${edge.type}\0${toTool.name}`;
    const nameCandidates = byName.get(nameKey);
    if (nameCandidates) {
      for (const cand of nameCandidates) {
        if (matchedOracleEdges.has(cand)) continue;
        matchedOracleEdges.add(cand);
        truePositives.push(edge);
        nameOnlyConfirmed.push(edge);
        matched = true;
        break;
      }
    }

    if (!matched) {
      falsePositives.push(edge);
    }
  }

  // FN = oracle edges not matched
  const falseNegatives: OracleEdge[] = [];
  for (const e of oracleEdges) {
    if (!matchedOracleEdges.has(e)) {
      falseNegatives.push(e);
    }
  }

  return { truePositives, falsePositives, falseNegatives, targetConfirmed, nameOnlyConfirmed };
}
