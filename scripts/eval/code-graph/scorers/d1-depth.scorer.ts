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

import type {
  EdgeType,
  GraphEdge,
  GraphNode,
  OracleEdge,
  OracleSymbol,
} from '../types';
import { COMPARABLE_EDGE_TYPES } from '../types';
import { adjudicateEdges, type NodeMatch } from '../matching/edge-adjudicator';
import { matchNodes } from '../matching/node-identity.matcher';

export interface DepthConfusionMatrix {
  edgeType: EdgeType;
  fn: number;
  fp: number;
  /** How many of the tool's edges are confirmed by the oracle (by name OR target). */
  oracleConfirmed: number;
  oracleRecall: number;
  /** Of oracleConfirmed, how many were confirmed by the type checker's resolved target (not just name). */
  targetConfirmed: number;
  /** Tool's total edges of this type. */
  toolClaimed: number;
  toolPrecision: number;
  tp: number;
  /** For Vyazen: of the tool's resolved edges, how many does the oracle confirm. */
  vyazenResolvedConfirmed?: number;
  /** For Vyazen: of the tool's resolved edges, how many does the type checker confirm the target. */
  vyazenResolvedTargetConfirmed?: number;
  /** For Vyazen: total resolved edges of this type. */
  vyazenResolvedTotal?: number;
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
  isVyazen = false,
): D1Report {
  const matchResult = matchNodes(toolNodes, oracleSymbols);
  const nodeMatches: NodeMatch[] = matchResult.matched;

  const adjudication = adjudicateEdges(
    toolEdges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type)),
    toolNodes,
    oracleEdges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type)),
    nodeMatches,
    oracleSymbols,
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
      toolClaimed,
      toolPrecision: safeDiv(tp, tp + fp),
      tp,
    };

    if (isVyazen) {
      const resolvedEdges = toolEdges.filter((e) => e.type === t && e.resolved === true);
      const resolvedTp = adjudication.truePositives.filter(
        (e) => e.type === t && e.resolved === true,
      ).length;
      const resolvedTargetConfirmed = adjudication.targetConfirmed.filter(
        (e) => e.type === t && e.resolved === true,
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
  competitorName: string,
): Array<{
  competitorCovers: number;
  competitorMisses: number;
  edgeType: EdgeType;
  vyazenResolved: number;
}> {
  // Match competitor nodes to Vyazen nodes (treating Vyazen as the reference)
  const matchResult = matchNodes(competitorNodes, vyazenNodes);
  const nodeMatches: NodeMatch[] = matchResult.matched;

  // Build competitor → vyazen node id map
  const compToVyaz = new Map<string, GraphNode>();
  for (const m of nodeMatches) {
    compToVyaz.set(m.tool.id, m.oracle as unknown as GraphNode);
  }

  // Index competitor edges by (vyazen-from-id, vyazen-to-name, type)
  const compEdgeIdx = new Map<string, number>();
  for (const e of competitorEdges) {
    if (!COMPARABLE_EDGE_TYPES.has(e.type)) continue;
    const compFrom = competitorNodes.find((n) => n.id === e.fromId);
    const compTo = competitorNodes.find((n) => n.id === e.toId);
    if (!compFrom || !compTo) continue;
    const vyazFrom = compToVyaz.get(compFrom.id);
    if (!vyazFrom) continue;
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
      const vyazFrom = vyazenNodes.find((n) => n.id === e.fromId);
      const vyazTo = vyazenNodes.find((n) => n.id === e.toId);
      if (!vyazFrom || !vyazTo) {
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
