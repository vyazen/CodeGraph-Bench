/**
 * D2 — Fidelity scorer (v2: target accuracy + module-level IMPORTS).
 *
 * Per CODE_GRAPH_EVAL_PLAN.md §7 D2, plus improvements:
 * - **Target accuracy**: of the tool's TPs, what fraction were confirmed by
 *   the type checker's resolved target (path + startLine) vs. name only?
 *   This measures "does the edge point to the RIGHT target?"
 * - **Module-level IMPORTS**: IMPORTS scored at File→File granularity (both
 *   tools) in addition to File→Symbol (Vyazen advantage).
 * - **Extended edge types**: USES_TYPE, ACCESSES, METHOD_OVERRIDES scored
 *   separately — each tool on what it produces.
 */

import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  OracleEdge,
  OracleSymbol,
  SymbolType,
} from '../types';
import { COMPARABLE_EDGE_TYPES, EXT***REMOVED***ED_EDGE_TYPES } from '../types';
import { adjudicateEdges, type NodeMatch } from '../matching/edge-adjudicator';
import { matchNodes } from '../matching/node-identity.matcher';

export interface KindMetrics {
  f1: number;
  fn: number;
  fp: number;
  precision: number;
  recall: number;
  tp: number;
}

export interface EdgeTypeMetrics extends KindMetrics {
  /** Of TPs, how many were confirmed by resolved target (not just name). */
  nameOnlyConfirmed: number;
  resolutionRate: number;
  /** Of TPs, how many were confirmed by the type checker's resolved target. */
  targetConfirmed: number;
  /** targetConfirmed / tp — "does the edge point to the right target?" */
  targetAccuracy: number;
}

export interface ImportModuleLevelMetrics {
  fn: number;
  fp: number;
  precision: number;
  recall: number;
  /** Oracle file→file dependency pairs. */
  oraclePairs: number;
  /** Tool file→file dependency pairs. */
  toolPairs: number;
  tp: number;
}

export interface D2Report {
  edges: {
    byType: Partial<Record<EdgeType, EdgeTypeMetrics>>;
    /** Extended edge types (USES_TYPE, ACCESSES, METHOD_OVERRIDES) — scored separately. */
    extendedByType: Partial<Record<EdgeType, KindMetrics>>;
    danglingEndpointRate: number;
    /** Module-level IMPORTS (File→File) — fair comparison for both tools. */
    importsModuleLevel: ImportModuleLevelMetrics;
    overall: KindMetrics;
    selfLoopLeak: number;
    /** Unresolved self-edges set aside as abstentions (excluded from precision). */
    abstained: number;
    /** Overall target accuracy across all comparable edge types. */
    targetAccuracy: number;
  };
  nodes: {
    byKind: Partial<Record<SymbolType, KindMetrics>>;
    macroF1: number;
    overall: KindMetrics;
    oracleMatchRate: number;
    toolMatchRate: number;
  };
}

function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function computeMetrics(tp: number, fp: number, fn: number): KindMetrics {
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  return { f1, fn, fp, precision, recall, tp };
}

/**
 * Compute module-level IMPORTS: convert File→Symbol edges to File→File pairs.
 * Both tools can compete at this level.
 */
function scoreImportsModuleLevel(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
): ImportModuleLevelMetrics {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));

  // Convert tool IMPORTS edges to file→file pairs
  const toolPairs = new Set<string>();
  for (const e of toolEdges) {
    if (e.type !== 'IMPORTS') continue;
    const from = toolNodeById.get(e.fromId);
    const to = toolNodeById.get(e.toId);
    if (!from || !to) continue;
    // File→File pair: (from.path, to.path)
    if (from.path && to.path) {
      const key = `${from.path}\0${to.path}`;
      toolPairs.add(key);
    }
  }

  // Convert oracle IMPORTS edges to file→file pairs.
  // Oracle IMPORTS: fromLocalId = file path, targetPath = resolved target file (if available)
  const oraclePairs = new Set<string>();
  for (const e of oracleEdges) {
    if (e.type !== 'IMPORTS') continue;
    if (e.targetPath) {
      // Type-checker resolved: we know the target file
      oraclePairs.add(`${e.fromLocalId}\0${e.targetPath}`);
    }
    // If no targetPath, we can't determine the target file — skip
  }

  // Compute P/R/F1 on file pairs
  let tp = 0;
  for (const p of toolPairs) {
    if (oraclePairs.has(p)) tp++;
  }
  const fp = toolPairs.size - tp;
  const fn = oraclePairs.size - tp;

  return {
    fn,
    fp,
    precision: safeDiv(tp, tp + fp),
    recall: safeDiv(tp, tp + fn),
    oraclePairs: oraclePairs.size,
    toolPairs: toolPairs.size,
    tp,
  };
}

export function scoreD2(
  toolNodes: GraphNode[],
  toolEdges: GraphEdge[],
  oracleSymbols: OracleSymbol[],
  oracleEdges: OracleEdge[],
): D2Report {
  const comparableToolNodes = toolNodes.filter((n) =>
    ['Class', 'Interface', 'Enum', 'Alias', 'Function', 'Method', 'Constructor',
     'Property', 'GlobalVariable', 'Module', 'Namespace'].includes(n.kind),
  );

  // ── Node fidelity ──────────────────────────────────────────────────────────
  const matchResult = matchNodes(comparableToolNodes, oracleSymbols);
  const nodeMatches: NodeMatch[] = matchResult.matched;

  // Edge adjudication needs matches for ALL tool nodes, not just the
  // kind-filtered comparable set above. A tool whose adapter can't classify a
  // symbol's kind (e.g. Graphify has no Class/Interface tag for TS/JS — see
  // graphify.adapter.ts) would otherwise have every edge FROM that node
  // (EXT***REMOVED***S, IMPLEMENTS, ...) forced to FP/FN, since the adjudicator can't
  // resolve the from-node's oracle identity. D1 (d1-depth.scorer.ts) already
  // matches on the full node set for this reason; D2 must too, or the same
  // edges score correctly in one section and as 0% in the other.
  const edgeNodeMatches: NodeMatch[] = matchNodes(toolNodes, oracleSymbols).matched;

  const comparableSymbolTypes = new Set<SymbolType>([
    'Class', 'Interface', 'Enum', 'Alias', 'Function', 'Method', 'Constructor',
    'Property', 'GlobalVariable', 'Module', 'Namespace',
  ]);

  const byKind = new Map<SymbolType, KindMetrics>();
  for (const kind of comparableSymbolTypes) {
    const tp = nodeMatches.filter((m) => m.oracle.kind === kind).length;
    const fp = matchResult.toolUnmatched.filter((n) => n.kind === kind).length;
    const fn = matchResult.oracleUnmatched.filter((s) => s.kind === kind).length;
    byKind.set(kind, computeMetrics(tp, fp, fn));
  }

  const totalTp = nodeMatches.length;
  const totalFp = matchResult.toolUnmatched.length;
  const totalFn = matchResult.oracleUnmatched.length;
  const overallNodes = computeMetrics(totalTp, totalFp, totalFn);

  const inPlayKinds = [...comparableSymbolTypes].filter((k) => {
    const m = byKind.get(k);
    return m && (m.tp + m.fp + m.fn) > 0;
  });
  const macroF1 = safeDiv(
    inPlayKinds.reduce((sum, k) => sum + (byKind.get(k)?.f1 ?? 0), 0),
    inPlayKinds.length,
  );

  // ── Edge fidelity (comparable types: CALLS, IMPORTS, EXT***REMOVED***S, IMPLEMENTS) ──
  const adjudication = adjudicateEdges(
    toolEdges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type)),
    toolNodes,
    oracleEdges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type)),
    edgeNodeMatches,
    oracleSymbols,
  );

  const byType = new Map<EdgeType, EdgeTypeMetrics>();
  let totalTargetConfirmed = 0;
  let totalTpEdges = 0;

  for (const t of COMPARABLE_EDGE_TYPES) {
    const tp = adjudication.truePositives.filter((e) => e.type === t).length;
    const fp = adjudication.falsePositives.filter((e) => e.type === t).length;
    const fn = adjudication.falseNegatives.filter((e) => e.type === t).length;
    const targetConfirmed = adjudication.targetConfirmed.filter((e) => e.type === t).length;
    const nameOnlyConfirmed = adjudication.nameOnlyConfirmed.filter((e) => e.type === t).length;
    const allToolEdgesOfType = toolEdges.filter((e) => e.type === t);
    const resolvedCount = allToolEdgesOfType.filter((e) => e.resolved === true).length;

    totalTargetConfirmed += targetConfirmed;
    totalTpEdges += tp;

    byType.set(t, {
      ...computeMetrics(tp, fp, fn),
      nameOnlyConfirmed,
      resolutionRate: safeDiv(resolvedCount, allToolEdgesOfType.length),
      targetAccuracy: safeDiv(targetConfirmed, tp),
      targetConfirmed,
    });
  }

  const overallEdges = computeMetrics(
    adjudication.truePositives.length,
    adjudication.falsePositives.length,
    adjudication.falseNegatives.length,
  );

  // ── Extended edge types (USES_TYPE, ACCESSES, METHOD_OVERRIDES) ────────────
  const extendedByType = new Map<EdgeType, KindMetrics>();
  for (const t of EXT***REMOVED***ED_EDGE_TYPES) {
    const toolEdgesOfType = toolEdges.filter((e) => e.type === t);
    const oracleEdgesOfType = oracleEdges.filter((e) => e.type === t);
    if (toolEdgesOfType.length === 0 && oracleEdgesOfType.length === 0) continue;

    const adj = adjudicateEdges(toolEdgesOfType, toolNodes, oracleEdgesOfType, edgeNodeMatches, oracleSymbols);
    extendedByType.set(t, computeMetrics(adj.truePositives.length, adj.falsePositives.length, adj.falseNegatives.length));
  }

  // ── Module-level IMPORTS ───────────────────────────────────────────────────
  const importsModuleLevel = scoreImportsModuleLevel(toolEdges, toolNodes, oracleEdges);

  // ── Structural metrics ─────────────────────────────────────────────────────
  const selfLoopLeak = toolEdges.filter((e) => e.fromId === e.toId).length;
  const nodeIds = new Set(toolNodes.map((n) => n.id));
  const danglingCount = toolEdges.filter(
    (e) => !nodeIds.has(e.fromId) || !nodeIds.has(e.toId),
  ).length;
  const danglingEndpointRate = safeDiv(danglingCount, toolEdges.length);

  return {
    edges: {
      abstained: adjudication.abstained.length,
      byType: Object.fromEntries(byType) as Partial<Record<EdgeType, EdgeTypeMetrics>>,
      danglingEndpointRate,
      extendedByType: Object.fromEntries(extendedByType) as Partial<Record<EdgeType, KindMetrics>>,
      importsModuleLevel,
      overall: overallEdges,
      selfLoopLeak,
      targetAccuracy: safeDiv(totalTargetConfirmed, totalTpEdges),
    },
    nodes: {
      byKind: Object.fromEntries(byKind) as Partial<Record<SymbolType, KindMetrics>>,
      macroF1,
      overall: overallNodes,
      oracleMatchRate: matchResult.oracleMatchRate,
      toolMatchRate: matchResult.toolMatchRate,
    },
  };
}
