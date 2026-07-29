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

import {
  adjudicateEdges,
  type EdgeAdjudication,
  type NodeMatch,
} from '../matching/edge-adjudicator';
import { isAccessorName, matchNodes } from '../matching/node-identity.matcher';
import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  OracleEdge,
  OracleSymbol,
  SymbolType,
} from '../types';
import { COMPARABLE_EDGE_TYPES, EXT***REMOVED***ED_EDGE_TYPES } from '../types';

export interface KindMetrics {
  f1: number;
  fn: number;
  fp: number;
  precision: number;
  recall: number;
  tp: number;
}

/**
 * F9 — fairness bookkeeping shared by every edge-fidelity metric: how many
 * oracle rows for this type were excluded as unscoreable (target knowably
 * external, or unresolvable after every fallback), and of the scoreable rows
 * that survived deduplication, what fraction of their total call/reference
 * *sites* got matched. `siteCoverage` is informational only — recall is
 * computed on deduped relationships, not sites — but a tool emitting one
 * edge per unique pair should still get credit visible somewhere for the
 * sites it can't distinguish.
 */
export interface EdgeFairnessMetrics {
  siteCoverage: number;
  unscoreableExcluded: number;
}

export interface EdgeTypeMetrics extends KindMetrics, EdgeFairnessMetrics {
  /** Of TPs, how many were confirmed by resolved target (not just name). */
  nameOnlyConfirmed: number;
  /**
   * F13/F6 — true only for the IMPORTS row of a tool that emits IMPORTS
   * exclusively at File→File granularity. Its symbol-level precision/recall
   * would otherwise read as a genuine `0.0%`/`not emitted`, which conflates
   * "can't compete at this granularity" with "competed and lost" — the
   * granularity itself is already scored fairly in `importsModuleLevel`.
   */
  onlyFileGranularity?: boolean;
  resolutionRate: number;
  /** targetConfirmed / tp — "does the edge point to the right target?" */
  targetAccuracy: number;
  /** Of TPs, how many were confirmed by the type checker's resolved target. */
  targetConfirmed: number;
}

export interface ImportModuleLevelMetrics {
  fn: number;
  fp: number;
  /** Oracle file→file dependency pairs. */
  oraclePairs: number;
  precision: number;
  recall: number;
  /** Tool file→file dependency pairs. */
  toolPairs: number;
  tp: number;
}

/**
 * F2: of matched nodes, what fraction carry the oracle's kind? A tool that
 * finds the symbol but can't label its kind (e.g. Graphify's `Unknown`
 * bucket) is "unlabelled", not "wrong" — a fabricated FP+FN was the bug.
 */
export interface KindLabellingMetrics {
  /** correct / total. */
  accuracy: number;
  /** Matched, tool kind agrees with the oracle (or both are Method/Property on an accessor). */
  correct: number;
  /** Matched, tool kind disagrees with the oracle and isn't 'Unknown'. */
  mislabelled: number;
  /** Matched pairs considered (denominator). */
  total: number;
  /** Matched, tool emitted the symbol as kind 'Unknown'. */
  unlabelled: number;
}

export interface D2Report {
  edges: {
    byType: Partial<Record<EdgeType, EdgeTypeMetrics>>;
    /** Extended edge types (USES_TYPE, ACCESSES, METHOD_OVERRIDES) — scored separately. */
    extendedByType: Partial<Record<EdgeType, KindMetrics & EdgeFairnessMetrics>>;
    danglingEndpointRate: number;
    /** Module-level IMPORTS (File→File) — fair comparison for both tools. */
    importsModuleLevel: ImportModuleLevelMetrics;
    /**
     * F8: member-source IMPLEMENTS (a class member satisfying an interface
     * member) scored separately from the class-source head-to-head table —
     * a tool that only models class-level `implements` isn't penalised for
     * not modelling member-level satisfaction, and vice versa.
     */
    implementsMemberLevel: KindMetrics;
    overall: KindMetrics;
    selfLoopLeak: number;
    /** Unresolved self-edges set aside as abstentions (excluded from precision). */
    abstained: number;
    /** Overall target accuracy across all comparable edge types. */
    targetAccuracy: number;
    /**
     * F4: USES_TYPE scored from-side-agnostically — per file, "was this type
     * referenced at all", ignoring which container the reference is
     * attributed to. The only way to measure a tool (e.g. Potpie) that
     * attributes type references to a different container than the oracle.
     */
    usesTypeFromAgnostic: KindMetrics;
  };
  nodes: {
    byKind: Partial<Record<SymbolType, KindMetrics>>;
    /** F2: kind-labelling accuracy, separate from symbol identity — see KindLabellingMetrics. */
    kindLabelling: {
      byKind: Partial<Record<SymbolType, KindLabellingMetrics>>;
      overall: KindLabellingMetrics;
    };
    macroF1: number;
    overall: KindMetrics;
    oracleMatchRate: number;
    toolMatchRate: number;
  };
}

function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

function normPathLocal(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** F8: from-node kinds that make an IMPLEMENTS edge member-level rather than class-level. */
function isMemberSourceKind(kind: SymbolType | undefined): boolean {
  return kind === 'Method' || kind === 'Constructor' || kind === 'Property';
}

/**
 * F4 — USES_TYPE, from-side-agnostic: per file, the set of type-symbol
 * references, ignoring which container each side attributes the reference
 * to. This is the only way to score a tool whose from-side convention
 * doesn't match the oracle's (e.g. Potpie attributes to File/Function/Method
 * where the oracle attributes to Property) at all, instead of an arithmetic
 * near-zero.
 */
function scoreUsesTypeFromAgnostic(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
  edgeNodeMatches: NodeMatch[]
): KindMetrics {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));
  const toolToOracle = new Map(edgeNodeMatches.map((m) => [m.tool.id, m.oracle]));

  const oraclePairs = new Set<string>();
  for (const e of oracleEdges) {
    if (e.type !== 'USES_TYPE') {
      continue;
    }
    const targetKey = e.targetLocalId
      ? `${normPathLocal(e.targetPath ?? '')}\0${e.targetLocalId}`
      : `name:${e.targetName}`;
    oraclePairs.add(`${normPathLocal(e.fromPath)}\0${targetKey}`);
  }

  const toolPairs = new Set<string>();
  for (const e of toolEdges) {
    if (e.type !== 'USES_TYPE') {
      continue;
    }
    const fromNode = toolNodeById.get(e.fromId);
    if (!fromNode) {
      continue;
    }
    const toNode = toolNodeById.get(e.toId);
    const toOracle = toNode ? toolToOracle.get(toNode.id) : undefined;
    const targetKey = toOracle
      ? `${normPathLocal(toOracle.path)}\0${toOracle.localId}`
      : toNode
        ? `name:${toNode.name}`
        : null;
    if (!targetKey) {
      continue;
    }
    toolPairs.add(`${normPathLocal(fromNode.path)}\0${targetKey}`);
  }

  let tp = 0;
  for (const p of toolPairs) {
    if (oraclePairs.has(p)) {
      tp++;
    }
  }
  return computeMetrics(tp, toolPairs.size - tp, oraclePairs.size - tp);
}

function computeMetrics(tp: number, fp: number, fn: number): KindMetrics {
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  return { f1, fn, fp, precision, recall, tp };
}

/**
 * F9 — derive the fairness columns for one edge type from an adjudication
 * result: how many oracle rows were excluded as unscoreable, and — of all the
 * original (pre-dedup) call/reference sites behind the scoreable rows — what
 * fraction the tool's matched (deduped) edges account for. A tool emitting
 * one edge per unique (caller, target) pair, rather than one per call site,
 * scores full `recall` (it found the relationship) but partial `siteCoverage`
 * (it didn't assert every site) — that's a capability note, not a penalty.
 */
function computeEdgeFairness(
  adjudication: Pick<EdgeAdjudication, 'scoreableOracleEdges' | 'unscoreableOracleEdges'>,
  type: EdgeType,
  tp: number
): EdgeFairnessMetrics {
  const totalSites = adjudication.scoreableOracleEdges
    .filter((e) => e.type === type)
    .reduce((sum, e) => sum + (e.siteCount ?? 1), 0);
  return {
    siteCoverage: safeDiv(tp, totalSites),
    unscoreableExcluded: adjudication.unscoreableOracleEdges.filter((e) => e.type === type).length,
  };
}

/**
 * Compute module-level IMPORTS: convert File→Symbol edges to File→File pairs.
 * Both tools can compete at this level.
 */
function scoreImportsModuleLevel(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[]
): ImportModuleLevelMetrics {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));

  // Convert tool IMPORTS edges to file→file pairs
  const toolPairs = new Set<string>();
  for (const e of toolEdges) {
    if (e.type !== 'IMPORTS') {
      continue;
    }
    const from = toolNodeById.get(e.fromId);
    const to = toolNodeById.get(e.toId);
    if (!(from && to)) {
      continue;
    }
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
    if (e.type !== 'IMPORTS') {
      continue;
    }
    if (e.targetPath) {
      // Type-checker resolved: we know the target file
      oraclePairs.add(`${e.fromLocalId}\0${e.targetPath}`);
    }
    // If no targetPath, we can't determine the target file — skip
  }

  // Compute P/R/F1 on file pairs
  let tp = 0;
  for (const p of toolPairs) {
    if (oraclePairs.has(p)) {
      tp++;
    }
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
  oracleEdges: OracleEdge[]
): D2Report {
  // F2: symbol identity is kind-agnostic — match on (path, canonicalName) over
  // every tool node except File/Directory (which the oracle never emits as
  // symbols), 'Unknown' included. A tool that finds the symbol but can't label
  // its kind (e.g. Graphify's Unknown bucket) must still get identity credit;
  // whether it also got the kind right is a separate metric (kindLabelling,
  // below) — conflating the two turned "found it, mislabeled it" into a
  // fabricated FP+FN pair.
  const identityToolNodes = toolNodes.filter((n) => n.kind !== 'File' && n.kind !== 'Directory');

  // ── Node fidelity ──────────────────────────────────────────────────────────
  const matchResult = matchNodes(identityToolNodes, oracleSymbols);
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
    'Class',
    'Interface',
    'Enum',
    'Alias',
    'Function',
    'Method',
    'Constructor',
    'Property',
    'GlobalVariable',
    'Module',
    'Namespace',
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

  // F13: macro F1 must exclude kinds the oracle has zero instances of. Using
  // `tp+fp+fn > 0` (pre-fix) let a kind the oracle never emits but a tool
  // fabricates (fp>0, tp=fn=0 → f1=0) drag the average down — a fabricated
  // zero, not a measured one. Gate on the oracle's own presence instead.
  const inPlayKinds = [...comparableSymbolTypes].filter((k) => {
    const m = byKind.get(k);
    return m && m.tp + m.fn > 0;
  });
  const macroF1 = safeDiv(
    inPlayKinds.reduce((sum, k) => sum + (byKind.get(k)?.f1 ?? 0), 0),
    inPlayKinds.length
  );

  // ── F2: kind-labelling accuracy (separate from symbol identity) ───────────
  const isMethodOrProperty = (k: SymbolType) => k === 'Method' || k === 'Property';
  const labelIsCorrect = (oracleKind: SymbolType, toolKind: SymbolType, oracleName: string) =>
    toolKind === oracleKind ||
    (isMethodOrProperty(oracleKind) && isMethodOrProperty(toolKind) && isAccessorName(oracleName));

  const kindLabellingByKind = new Map<SymbolType, KindLabellingMetrics>();
  for (const kind of comparableSymbolTypes) {
    const matchesOfKind = nodeMatches.filter((m) => m.oracle.kind === kind);
    const unlabelled = matchesOfKind.filter((m) => m.tool.kind === 'Unknown').length;
    const correct = matchesOfKind.filter((m) =>
      labelIsCorrect(m.oracle.kind, m.tool.kind, m.oracle.name)
    ).length;
    const total = matchesOfKind.length;
    kindLabellingByKind.set(kind, {
      accuracy: safeDiv(correct, total),
      correct,
      mislabelled: total - correct - unlabelled,
      total,
      unlabelled,
    });
  }
  const totalUnlabelled = nodeMatches.filter((m) => m.tool.kind === 'Unknown').length;
  const totalCorrectLabel = nodeMatches.filter((m) =>
    labelIsCorrect(m.oracle.kind, m.tool.kind, m.oracle.name)
  ).length;
  const kindLabelling = {
    byKind: Object.fromEntries(kindLabellingByKind) as Partial<
      Record<SymbolType, KindLabellingMetrics>
    >,
    overall: {
      accuracy: safeDiv(totalCorrectLabel, nodeMatches.length),
      correct: totalCorrectLabel,
      mislabelled: nodeMatches.length - totalCorrectLabel - totalUnlabelled,
      total: nodeMatches.length,
      unlabelled: totalUnlabelled,
    },
  };

  // ── Edge fidelity (comparable types: CALLS, IMPORTS, EXT***REMOVED***S, IMPLEMENTS) ──
  //
  // F6: the oracle's IMPORTS edges are always symbol-granularity (fromLocalId
  // = importing file, targetName = the imported symbol) — it has no File→File
  // relation to match against. A tool that models an import as File→File
  // (GitNexus, and ~94% of Vyazen's symbol-level IMPORTS FPs — see
  // CODE_GRAPH_EVAL_FAIRNESS_PLAN.md F6) can never score a TP here by
  // construction; that granularity mismatch is scored fairly in
  // `importsModuleLevel` below and must not also be charged as FP in the
  // symbol-level table. Applied identically to every tool.
  const toolNodeByIdForRouting = new Map(toolNodes.map((n) => [n.id, n]));

  // F8: the oracle's class-level IMPLEMENTS (heritage clause) and
  // member-level IMPLEMENTS (a member satisfying an interface member) share
  // the EdgeType but must not share a denominator — a tool emitting only one
  // of the two must not be penalised against the other. Kind of the
  // *oracle's* from-symbol decides which table an oracle edge belongs to;
  // kind of the *tool's* from-node decides which table a tool edge belongs to.
  const oracleSymbolKind = new Map<string, SymbolType>();
  for (const s of oracleSymbols) {
    oracleSymbolKind.set(`${s.path}\0${s.localId}`, s.kind);
  }
  const isOracleMemberImplements = (e: OracleEdge) =>
    e.type === 'IMPLEMENTS' &&
    isMemberSourceKind(oracleSymbolKind.get(`${e.fromPath}\0${e.fromLocalId}`));
  const isToolMemberImplements = (e: GraphEdge) =>
    e.type === 'IMPLEMENTS' && isMemberSourceKind(toolNodeByIdForRouting.get(e.fromId)?.kind);

  const symbolLevelToolEdges = toolEdges.filter((e) => {
    if (!COMPARABLE_EDGE_TYPES.has(e.type)) {
      return false;
    }
    if (e.type === 'IMPORTS' && toolNodeByIdForRouting.get(e.toId)?.kind === 'File') {
      return false;
    }
    if (isToolMemberImplements(e)) {
      return false;
    }
    return true;
  });
  const adjudication = adjudicateEdges(
    symbolLevelToolEdges,
    toolNodes,
    oracleEdges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type) && !isOracleMemberImplements(e)),
    edgeNodeMatches,
    oracleSymbols
  );

  const memberImplementsAdj = adjudicateEdges(
    toolEdges.filter(isToolMemberImplements),
    toolNodes,
    oracleEdges.filter(isOracleMemberImplements),
    edgeNodeMatches,
    oracleSymbols
  );
  const implementsMemberLevel = computeMetrics(
    memberImplementsAdj.truePositives.length,
    memberImplementsAdj.falsePositives.length,
    memberImplementsAdj.falseNegatives.length
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
    const fairness = computeEdgeFairness(adjudication, t, tp);

    totalTargetConfirmed += targetConfirmed;
    totalTpEdges += tp;

    // F13/F6: a tool that models IMPORTS only at File→File granularity has
    // zero edges left after the symbol-level partition above — its
    // precision/recall here would otherwise read as a fabricated
    // `0.0%`/`not emitted` rather than "this granularity isn't modelled".
    const onlyFileGranularity =
      t === 'IMPORTS'
        ? (() => {
            const allImports = toolEdges.filter((e) => e.type === 'IMPORTS');
            const hasFileLevel = allImports.some(
              (e) => toolNodeByIdForRouting.get(e.toId)?.kind === 'File'
            );
            const hasSymbolLevel = allImports.some(
              (e) => toolNodeByIdForRouting.get(e.toId)?.kind !== 'File'
            );
            return hasFileLevel && !hasSymbolLevel;
          })()
        : undefined;

    byType.set(t, {
      ...computeMetrics(tp, fp, fn),
      ...fairness,
      nameOnlyConfirmed,
      onlyFileGranularity,
      resolutionRate: safeDiv(resolvedCount, allToolEdgesOfType.length),
      targetAccuracy: safeDiv(targetConfirmed, tp),
      targetConfirmed,
    });
  }

  const overallEdges = computeMetrics(
    adjudication.truePositives.length,
    adjudication.falsePositives.length,
    adjudication.falseNegatives.length
  );

  // ── Extended edge types (USES_TYPE, ACCESSES, METHOD_OVERRIDES) ────────────
  const extendedByType = new Map<EdgeType, KindMetrics>();
  for (const t of EXT***REMOVED***ED_EDGE_TYPES) {
    const toolEdgesOfType = toolEdges.filter((e) => e.type === t);
    const oracleEdgesOfType = oracleEdges.filter((e) => e.type === t);
    if (toolEdgesOfType.length === 0 && oracleEdgesOfType.length === 0) {
      continue;
    }

    const adj = adjudicateEdges(
      toolEdgesOfType,
      toolNodes,
      oracleEdgesOfType,
      edgeNodeMatches,
      oracleSymbols
    );
    extendedByType.set(t, {
      ...computeMetrics(
        adj.truePositives.length,
        adj.falsePositives.length,
        adj.falseNegatives.length
      ),
      ...computeEdgeFairness(adj, t, adj.truePositives.length),
    });
  }

  // ── Module-level IMPORTS ───────────────────────────────────────────────────
  const importsModuleLevel = scoreImportsModuleLevel(toolEdges, toolNodes, oracleEdges);

  // ── F4: USES_TYPE, from-side-agnostic ──────────────────────────────────────
  const usesTypeFromAgnostic = scoreUsesTypeFromAgnostic(
    toolEdges,
    toolNodes,
    oracleEdges,
    edgeNodeMatches
  );

  // ── Structural metrics ─────────────────────────────────────────────────────
  const selfLoopLeak = toolEdges.filter((e) => e.fromId === e.toId).length;
  const nodeIds = new Set(toolNodes.map((n) => n.id));
  const danglingCount = toolEdges.filter(
    (e) => !(nodeIds.has(e.fromId) && nodeIds.has(e.toId))
  ).length;
  const danglingEndpointRate = safeDiv(danglingCount, toolEdges.length);

  return {
    edges: {
      abstained: adjudication.abstained.length,
      byType: Object.fromEntries(byType) as Partial<Record<EdgeType, EdgeTypeMetrics>>,
      danglingEndpointRate,
      extendedByType: Object.fromEntries(extendedByType) as Partial<
        Record<EdgeType, KindMetrics & EdgeFairnessMetrics>
      >,
      implementsMemberLevel,
      importsModuleLevel,
      overall: overallEdges,
      selfLoopLeak,
      targetAccuracy: safeDiv(totalTargetConfirmed, totalTpEdges),
      usesTypeFromAgnostic,
    },
    nodes: {
      byKind: Object.fromEntries(byKind) as Partial<Record<SymbolType, KindMetrics>>,
      kindLabelling,
      macroF1,
      overall: overallNodes,
      oracleMatchRate: matchResult.oracleMatchRate,
      toolMatchRate: matchResult.toolMatchRate,
    },
  };
}
