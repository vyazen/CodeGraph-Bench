/**
 * D1 — Depth moat scorer.
 *
 * Per CODE_GRAPH_EVAL_PLAN.md §7 D1:
 *   Of Vyazen's N resolved CALLS edges, what fraction does each
 *   competitor get right / wrong / miss? Same for EXT***REMOVED***S, IMPLEMENTS, IMPORTS.
 *
 * Adjudicated by the TS compiler oracle (parse-only — see methodology caveat).
 *
 * For Vyazen specifically, we also slice by `resolved` to test the headline
 * claim: "47,046 resolved CALLS edges". Of those resolved edges,
 * how many does the oracle confirm?
 *
 * Confusion matrix per tool per edge type:
 *   TP = tool edge confirmed by oracle
 *   FP = tool edge NOT confirmed by oracle
 *   FN = oracle edge missed by tool
 *   oracleRecall = TP / (TP + FN) — how much of the oracle's ground truth the tool captured
 *   toolPrecision = TP / (TP + FP) — how much of what the tool claims is correct
 */

import {
  adjudicateEdges,
  type EdgeAdjudication,
  type NodeMatch,
} from '../matching/edge-adjudicator';
import { matchNodes, matchToolNodes } from '../matching/node-identity.matcher';
import type { EdgeType, GraphEdge, GraphNode, OracleEdge, OracleSymbol } from '../types';
import { COMPARABLE_EDGE_TYPES } from '../types';
import { partitionEdgesForScoring } from './d2-fidelity.scorer';

export interface DepthConfusionMatrix {
  edgeType: EdgeType;
  fn: number;
  fp: number;
  /** How many of the tool's edges are confirmed by the oracle (by name OR target). */
  oracleConfirmed: number;
  oracleRecall: number;
  /** F9 — of the deduped scoreable oracle rows, what fraction of their original call/reference sites got matched. */
  siteCoverage: number;
  /** Of oracleConfirmed, how many were confirmed by the type checker's resolved target (not just name). */
  targetConfirmed: number;
  /**
   * Tool's total raw edges of this type — NOT the precision denominator
   * (that's `tp + fp`). Includes edges routed to other tables by
   * `partitionEdgesForScoring` (F6 File-granularity IMPORTS, F8 member-level
   * IMPLEMENTS) and self-loop abstentions (F24).
   */
  toolClaimed: number;
  toolPrecision: number;
  tp: number;
  /** F9 — oracle rows of this type excluded as unscoreable (target knowably external, or unresolvable). */
  unscoreableExcluded: number;
  /** F18 — tool edges of this type that matched a `scoreable: false` oracle row instead of a genuine FP; excluded from precision and recall alike. */
  unscoreableMatched: number;
  /** For Vyazen: of the tool's resolved edges, how many does the oracle confirm. */
  vyazenResolvedConfirmed?: number;
  /** For Vyazen: of the tool's resolved edges, how many does the type checker confirm the target. */
  vyazenResolvedTargetConfirmed?: number;
  /** For Vyazen: total resolved edges of this type. */
  vyazenResolvedTotal?: number;
}

/** F9/F18 — see the twin helper in d2-fidelity.scorer.ts for rationale. */
function computeEdgeFairness(
  adjudication: Pick<
    EdgeAdjudication,
    'scoreableOracleEdges' | 'unscoreableMatched' | 'unscoreableOracleEdges'
  >,
  type: EdgeType,
  tp: number
): { siteCoverage: number; unscoreableExcluded: number; unscoreableMatched: number } {
  const totalSites = adjudication.scoreableOracleEdges
    .filter((e) => e.type === type)
    .reduce((sum, e) => sum + (e.siteCount ?? 1), 0);
  return {
    siteCoverage: safeDiv(tp, totalSites),
    unscoreableMatched: adjudication.unscoreableMatched.filter((e) => e.type === type).length,
    unscoreableExcluded: adjudication.unscoreableOracleEdges.filter((e) => e.type === type).length,
  };
}

export interface D1Report {
  perType: DepthConfusionMatrix[];
  /** Summary line for the scorecard. */
  summary: {
    totalFn: number;
    totalFp: number;
    totalTp: number;
  };
}

function safeDiv(num: number, den: number): number {
  return den === 0 ? 0 : num / den;
}

/**
 * Compute D1 depth-moat confusion matrix for a tool vs the oracle.
 *
 * @param isVyazen If true, also compute the resolved-edge slice (Vyazen-only).
 */
export function scoreD1(
  toolNodes: GraphNode[],
  toolEdges: GraphEdge[],
  oracleSymbols: OracleSymbol[],
  oracleEdges: OracleEdge[],
  isVyazen = false
): D1Report {
  const matchResult = matchNodes(toolNodes, oracleSymbols);
  const nodeMatches: NodeMatch[] = matchResult.matched;

  // F24 — the same partition `scoreD2` applies (F6 IMPORTS granularity, F8
  // member-vs-class IMPLEMENTS), so D1 and D2 report identical tp/fp/fn — and
  // therefore identical precision — for the same tool and edge type.
  const partition = partitionEdgesForScoring(toolEdges, toolNodes, oracleEdges, oracleSymbols);
  const adjudication = adjudicateEdges(
    partition.symbolLevelToolEdges,
    toolNodes,
    partition.classLevelOracleEdges,
    nodeMatches,
    oracleSymbols
  );

  const perType: DepthConfusionMatrix[] = [];
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;

  for (const t of COMPARABLE_EDGE_TYPES) {
    const tp = adjudication.truePositives.filter((e) => e.type === t).length;
    const fp = adjudication.falsePositives.filter((e) => e.type === t).length;
    const fn = adjudication.falseNegatives.filter((e) => e.type === t).length;
    const toolClaimed = toolEdges.filter((e) => e.type === t).length;
    const targetConfirmed = adjudication.targetConfirmed.filter((e) => e.type === t).length;

    totalTp += tp;
    totalFp += fp;
    totalFn += fn;

    let matrix: DepthConfusionMatrix = {
      edgeType: t,
      fn,
      fp,
      oracleConfirmed: tp,
      oracleRecall: safeDiv(tp, tp + fn),
      targetConfirmed,
      toolClaimed,
      toolPrecision: safeDiv(tp, tp + fp),
      tp,
      ...computeEdgeFairness(adjudication, t, tp),
    };

    if (isVyazen) {
      const resolvedEdges = toolEdges.filter((e) => e.type === t && e.resolved === true);
      const resolvedTp = adjudication.truePositives.filter(
        (e) => e.type === t && e.resolved === true
      ).length;
      const resolvedTargetConfirmed = adjudication.targetConfirmed.filter(
        (e) => e.type === t && e.resolved === true
      ).length;
      matrix = {
        ...matrix,
        vyazenResolvedConfirmed: resolvedTp,
        vyazenResolvedTargetConfirmed: resolvedTargetConfirmed,
        vyazenResolvedTotal: resolvedEdges.length,
      };
    }

    perType.push(matrix);
  }

  return {
    perType,
    summary: { totalFn, totalFp, totalTp },
  };
}

/**
 * Cross-tool coverage: of Vyazen's resolved edges, how many does the competitor
 * also have (regardless of oracle)? This measures raw coverage, not correctness.
 */
export function crossToolCoverage(
  vyazenNodes: GraphNode[],
  vyazenEdges: GraphEdge[],
  competitorNodes: GraphNode[],
  competitorEdges: GraphEdge[],
  competitorName: string
): Array<{
  competitorCovers: number;
  competitorMisses: number;
  edgeType: EdgeType;
  vyazenResolved: number;
}> {
  // Match competitor nodes to Vyazen nodes (treating Vyazen as the reference).
  // Both sides are GraphNode — matchNodes' claim key reads OracleSymbol.localId,
  // which GraphNode doesn't have, so it must not be reused here (see
  // matchToolNodes' doc comment).
  const matchResult = matchToolNodes(competitorNodes, vyazenNodes);
  const nodeMatches = matchResult.matched;

  // Build competitor → vyazen node id map
  const compToVyaz = new Map<string, GraphNode>();
  for (const m of nodeMatches) {
    compToVyaz.set(m.tool.id, m.reference);
  }

  // Index nodes by id (first occurrence wins, matching Array.find semantics).
  const competitorById = new Map<string, GraphNode>();
  for (const n of competitorNodes) {
    if (!competitorById.has(n.id)) {
      competitorById.set(n.id, n);
    }
  }
  const vyazenById = new Map<string, GraphNode>();
  for (const n of vyazenNodes) {
    if (!vyazenById.has(n.id)) {
      vyazenById.set(n.id, n);
    }
  }

  // Index competitor edges by (vyazen-from-id, vyazen-to-name, type)
  const compEdgeIdx = new Map<string, number>();
  for (const e of competitorEdges) {
    if (!COMPARABLE_EDGE_TYPES.has(e.type)) {
      continue;
    }
    const compFrom = competitorById.get(e.fromId);
    const compTo = competitorById.get(e.toId);
    if (!(compFrom && compTo)) {
      continue;
    }
    const vyazFrom = compToVyaz.get(compFrom.id);
    if (!vyazFrom) {
      continue;
    }
    const key = `${vyazFrom.id}\0${compTo.name}\0${e.type}`;
    compEdgeIdx.set(key, (compEdgeIdx.get(key) ?? 0) + 1);
  }

  const results: Array<{
    competitorCovers: number;
    competitorMisses: number;
    edgeType: EdgeType;
    vyazenResolved: number;
  }> = [];

  for (const t of COMPARABLE_EDGE_TYPES) {
    const vyazenResolved = vyazenEdges.filter((e) => e.type === t && e.resolved === true);
    let covers = 0;
    let misses = 0;
    for (const e of vyazenResolved) {
      const vyazFrom = vyazenById.get(e.fromId);
      const vyazTo = vyazenById.get(e.toId);
      if (!(vyazFrom && vyazTo)) {
        misses++;
        continue;
      }
      const key = `${vyazFrom.id}\0${vyazTo.name}\0${t}`;
      if ((compEdgeIdx.get(key) ?? 0) > 0) {
        covers++;
      } else {
        misses++;
      }
    }
    results.push({
      competitorCovers: covers,
      competitorMisses: misses,
      edgeType: t,
      vyazenResolved: vyazenResolved.length,
    });
  }

  void competitorName;
  return results;
}
