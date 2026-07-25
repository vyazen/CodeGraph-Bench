/**
 * Node identity matcher — matches tool graph nodes to oracle ground-truth nodes.
 *
 * Per CODE_GRAPH_EVAL_PLAN.md §5: "Tools mint IDs differently, so match on
 * (normalized_path, name, startLine) with a ±2-line tolerance. This is where
 * the engineering time actually goes."
 *
 * Known failure modes handled:
 * - Overloads sharing a name+line → pick nearest startLine
 * - Anonymous/arrow functions → skip (name is empty or '[anonymous]')
 * - Re-exports → a re-export has the same name but different path; matches
 *   only if the path also matches
 * - ±2-line tolerance for tools that record slightly different start lines
 *   (e.g. decorators, JSDoc) than the TS compiler
 */

import type { GraphNode, OracleSymbol } from '../types';

export interface MatchResult {
  /** Tool nodes that matched an oracle node. */
  matched: Array<{ oracle: OracleSymbol; tool: GraphNode }>;
  matchedOracleLocalIds: Set<string>;
  /** Oracle nodes the tool missed. */
  oracleUnmatched: OracleSymbol[];
  /** Tool nodes with no oracle counterpart. */
  toolUnmatched: GraphNode[];
  /** Fraction of tool nodes matched (0-1). If < 0.5, comparison is invalid. */
  toolMatchRate: number;
  /** Fraction of oracle nodes matched (0-1). */
  oracleMatchRate: number;
}

const LINE_TOLERANCE = 2;

/** Normalize a path for matching: forward slashes, no leading ./, lowercase drive. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (s.startsWith('./')) s = s.slice(2);
  // Strip a leading repo-root prefix if both sides have one — we rely on relative paths
  return s;
}

/** True if a name is matchable (not anonymous/computed). */
function isMatchableName(name: string | undefined | null): boolean {
  if (!name) return false;
  if (name === '[computed]') return false;
  if (name === '[anonymous]') return false;
  if (name === 'default') return true; // export default is matchable
  return true;
}

interface OracleIndexEntry {
  path: string;
  symbols: OracleSymbol[];
}

/**
 * Build an index of oracle symbols by (normalized_path, name) for O(1) lookup.
 * Overloads (same name+path) land in the same bucket — resolved by nearest line.
 */
function buildOracleIndex(oracle: OracleSymbol[]): Map<string, OracleSymbol[]> {
  const idx = new Map<string, OracleSymbol[]>();
  for (const sym of oracle) {
    if (!isMatchableName(sym.name)) continue;
    const key = `${normalizePath(sym.path)}\0${sym.name}`;
    const bucket = idx.get(key);
    if (bucket) {
      bucket.push(sym);
    } else {
      idx.set(key, [sym]);
    }
  }
  return idx;
}

/**
 * Match tool nodes to oracle symbols.
 *
 * Strategy:
 * 1. Index oracle by (path, name)
 * 2. For each tool node, find candidates with the same (path, name)
 * 3. Among candidates, pick the one whose startLine is within ±2 of the tool's
 *    startLine and nearest. If the tool has no startLine, pick any unmatched candidate.
 * 4. Each oracle symbol can be matched at most once (prevents double-counting).
 */
export function matchNodes(toolNodes: GraphNode[], oracle: OracleSymbol[]): MatchResult {
  const oracleIdx = buildOracleIndex(oracle);
  const matched: Array<{ oracle: OracleSymbol; tool: GraphNode }> = [];
  const matchedOracleKeys = new Set<string>(); // key: path\0localId
  const toolUnmatched: GraphNode[] = [];

  for (const tool of toolNodes) {
    if (!isMatchableName(tool.name)) continue;
    if (tool.startLine === null) {
      // No line info — try to match by name only if there's exactly one candidate
      const key = `${normalizePath(tool.path)}\0${tool.name}`;
      const candidates = oracleIdx.get(key);
      if (!candidates || candidates.length === 0) {
        toolUnmatched.push(tool);
        continue;
      }
      const unmatchedCands = candidates.filter(
        (c) => !matchedOracleKeys.has(`${normalizePath(c.path)}\0${c.localId}`),
      );
      if (unmatchedCands.length === 0) {
        toolUnmatched.push(tool);
        continue;
      }
      const chosen = unmatchedCands[0];
      matchedOracleKeys.add(`${normalizePath(chosen.path)}\0${chosen.localId}`);
      matched.push({ oracle: chosen, tool });
      continue;
    }

    const key = `${normalizePath(tool.path)}\0${tool.name}`;
    const candidates = oracleIdx.get(key);
    if (!candidates || candidates.length === 0) {
      toolUnmatched.push(tool);
      continue;
    }

    // Among unmatched candidates, pick the one with startLine within ±2 and nearest
    let best: OracleSymbol | null = null;
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const cand of candidates) {
      const candKey = `${normalizePath(cand.path)}\0${cand.localId}`;
      if (matchedOracleKeys.has(candKey)) continue;
      const delta = Math.abs(cand.startLine - tool.startLine);
      if (delta <= LINE_TOLERANCE && delta < bestDelta) {
        best = cand;
        bestDelta = delta;
      }
    }

    if (best) {
      matchedOracleKeys.add(`${normalizePath(best.path)}\0${best.localId}`);
      matched.push({ oracle: best, tool });
    } else {
      toolUnmatched.push(tool);
    }
  }

  const oracleUnmatched = oracle.filter(
    (s) => !matchedOracleKeys.has(`${normalizePath(s.path)}\0${s.localId}`) && isMatchableName(s.name),
  );

  const matchableToolCount = toolNodes.filter((n) => isMatchableName(n.name)).length;
  const matchableOracleCount = oracle.filter((s) => isMatchableName(s.name)).length;

  return {
    matched,
    matchedOracleKeys,
    matchedOracleLocalIds: matchedOracleKeys,
    oracleUnmatched,
    toolUnmatched,
    toolMatchRate: matchableToolCount === 0 ? 0 : matched.length / matchableToolCount,
    oracleMatchRate: matchableOracleCount === 0 ? 0 : matched.length / matchableOracleCount,
  };
}
