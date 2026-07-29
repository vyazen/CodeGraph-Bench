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

/**
 * Choose the best oracle symbol for a tool node among same-(path,name) candidates.
 *
 * Line is a tie-breaker, not a gate: prefer candidates of the same kind, then the
 * one nearest by startLine. If the tool node has no startLine, take the first
 * available candidate. A single candidate is always accepted regardless of the
 * line delta (see the module header — doc-comment/decorator line conventions).
 */
function pickBest(tool: GraphNode, candidates: OracleSymbol[]): OracleSymbol {
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

  let best = pool[0];
  let bestDelta = Math.abs(best.startLine - tool.startLine);
  for (const cand of pool) {
    const delta = Math.abs(cand.startLine - tool.startLine);
    if (delta < bestDelta) {
      best = cand;
      bestDelta = delta;
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
  const oracleIdx = buildOracleIndex(oracle);
  const matched: Array<{ oracle: OracleSymbol; tool: GraphNode }> = [];
  const matchedOracleKeys = new Set<string>(); // key: path\0localId
  const toolUnmatched: GraphNode[] = [];

  const claimKey = (s: OracleSymbol) => `${normalizePath(s.path)}\0${s.localId}`;

  for (const tool of toolNodes) {
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

  const oracleUnmatched = oracle.filter(
    (s) =>
      !matchedOracleKeys.has(`${normalizePath(s.path)}\0${s.localId}`) && isMatchableName(s.name)
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
