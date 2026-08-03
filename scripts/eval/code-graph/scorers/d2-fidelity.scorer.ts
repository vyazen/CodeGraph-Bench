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
  /**
   * F18 — tool edges of this type that would otherwise be FP, but matched a
   * `scoreable: false` oracle row instead (the oracle couldn't verify the
   * target, so the claim can't be judged). Excluded from precision and
   * recall alike; never folded into FP.
   */
  unscoreableMatched: number;
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
  /**
   * F19 — unmatched tool pairs excused because the oracle couldn't resolve
   * enough of that file's imports to judge them. See `scoreImportsModuleLevel`
   * for the budget mechanism. Excluded from `fp`; never silently dropped.
   */
  unscoreableExcluded: number;
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
    /**
     * Phase 5 (VSCODE_CODE_GRAPH_EVAL_PLAN.md §5, item 2): METHOD_OVERRIDES
     * scored from-side-agnostically — per (containing class, base target)
     * pair, ignoring whether the edge is attributed to the class or the
     * overriding method. GitNexus attributes to the Class; the oracle
     * attributes to the overriding Method. Same mismatch shape as USES_TYPE
     * (F4), scored the same way.
     */
    methodOverridesFromAgnostic: KindMetrics;
  };
  nodes: {
    byKind: Partial<Record<SymbolType, KindMetrics>>;
    /** F2: kind-labelling accuracy, separate from symbol identity — see KindLabellingMetrics. */
    kindLabelling: {
      byKind: Partial<Record<SymbolType, KindLabellingMetrics>>;
      overall: KindLabellingMetrics;
    };
    macroF1: number;
    /**
     * F22 — tool node rows collapsed as duplicates of an already-seen
     * (path, canonicalName, kind, startLine) row before matching. A tool
     * emitting the same symbol twice is a modelling note, not N-1 fabricated
     * false positives.
     */
    duplicateNodesCollapsed: number;
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
/**
 * F21 — the oracle's `targetName` is always present, resolved or not; a tool
 * pair should therefore match by strict identity (bound to the same oracle
 * symbol) OR by bare target name, whichever line up. Building only an
 * identity-format key for a resolved oracle row and only a name-format key
 * for a tool whose to-node never bound to an oracle symbol made the two
 * formats mutually exclusive by construction — the two keys could never be
 * equal even when they plainly named the same target. This tracks both
 * dimensions and counts a match on either.
 */
function scoreUsesTypeFromAgnostic(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
  edgeNodeMatches: NodeMatch[]
): KindMetrics {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));
  const toolToOracle = new Map(edgeNodeMatches.map((m) => [m.tool.id, m.oracle]));

  const oracleIdKeys = new Set<string>();
  const oracleNameKeys = new Set<string>();
  const oracleCanonicalPairs = new Set<string>();
  for (const e of oracleEdges) {
    if (e.type !== 'USES_TYPE') {
      continue;
    }
    const from = normPathLocal(e.fromPath);
    const nameKey = `${from}\0name:${e.targetName}`;
    oracleNameKeys.add(nameKey);
    if (e.targetLocalId) {
      const idKey = `${from}\0id:${normPathLocal(e.targetPath ?? '')}\0${e.targetLocalId}`;
      oracleIdKeys.add(idKey);
      oracleCanonicalPairs.add(idKey);
    } else {
      oracleCanonicalPairs.add(nameKey);
    }
  }

  const toolCanonicalPairs = new Set<string>();
  let tp = 0;
  for (const e of toolEdges) {
    if (e.type !== 'USES_TYPE') {
      continue;
    }
    const fromNode = toolNodeById.get(e.fromId);
    const toNode = toolNodeById.get(e.toId);
    if (!(fromNode && toNode)) {
      continue;
    }
    const toOracle = toolToOracle.get(toNode.id);
    const from = normPathLocal(fromNode.path);
    const idKey = toOracle
      ? `${from}\0id:${normPathLocal(toOracle.path)}\0${toOracle.localId}`
      : null;
    const nameKey = `${from}\0name:${toOracle ? toOracle.name : toNode.name}`;
    const canonicalKey = idKey ?? nameKey;

    if (toolCanonicalPairs.has(canonicalKey)) {
      continue; // already counted this distinct (from, target) relationship
    }
    toolCanonicalPairs.add(canonicalKey);

    if ((idKey && oracleIdKeys.has(idKey)) || oracleNameKeys.has(nameKey)) {
      tp++;
    }
  }

  return computeMetrics(tp, toolCanonicalPairs.size - tp, oracleCanonicalPairs.size - tp);
}

/**
 * Phase 5, item 2 — METHOD_OVERRIDES, from-side-agnostic. The oracle
 * attributes an override to the overriding Method (`fromLocalId` is the
 * method itself); GitNexus attributes it to the containing Class instead
 * (verified against `data/gitnexus/edges.jsonl`: `fromId` is always a
 * `Class:...` node, `toId` the base `Method:...`). That's a from-side
 * convention mismatch, not a quality difference — scoring it strictly (as
 * `extendedByType` does) forces 0 TP by construction, same failure shape F4
 * fixed for USES_TYPE. Score per (containing class, base target) pair,
 * climbing the tool's from-node up to its containing class when it isn't
 * one already, so both conventions land on the same key.
 */
function scoreMethodOverridesFromAgnostic(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
  oracleSymbols: OracleSymbol[],
  edgeNodeMatches: NodeMatch[]
): KindMetrics {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));
  const toolToOracle = new Map(edgeNodeMatches.map((m) => [m.tool.id, m.oracle]));
  const oracleByPathLocalId = new Map(
    oracleSymbols.map((s) => [`${normPathLocal(s.path)}\0${s.localId}`, s])
  );

  const classKey = (path: string, localId: string): string =>
    `id:${normPathLocal(path)}\0${localId}`;
  const classKeyFallback = (path: string, name: string): string =>
    `name:${normPathLocal(path)}\0${name}`;

  // Fallback only: walk the tool's own parentId chain to find a containing
  // Class. Not the primary path — a tool's parentId wiring is adapter-specific
  // and not guaranteed, whereas the oracle match (below) is authoritative
  // whenever it exists.
  const climbToClass = (node: GraphNode): GraphNode => {
    let cur: GraphNode | undefined = node;
    let hops = 0;
    while (cur && cur.kind !== 'Class' && cur.parentId && hops < 10) {
      cur = toolNodeById.get(cur.parentId);
      hops++;
    }
    return cur && cur.kind === 'Class' ? cur : node;
  };

  /**
   * Resolve the (containing class) half of the pair key for a tool's
   * from-node, regardless of whether that node IS the class (GitNexus's
   * convention) or the overriding method (the oracle's convention, and any
   * tool that matched it). Preferring the oracle match over the tool's own
   * graph structure means this works even when a tool's `parentId` isn't
   * populated (e.g. a from-node matched directly to an oracle Method symbol
   * already carries `parentLocalId` — no tree-walk needed).
   */
  const resolveClassKey = (fromNode: GraphNode): string => {
    const oracleSym = toolToOracle.get(fromNode.id);
    if (oracleSym) {
      if (oracleSym.kind === 'Class') {
        return classKey(oracleSym.path, oracleSym.localId);
      }
      if (oracleSym.parentLocalId) {
        return classKey(oracleSym.path, oracleSym.parentLocalId);
      }
    }
    const classNode = climbToClass(fromNode);
    const classOracle = toolToOracle.get(classNode.id);
    return classOracle
      ? classKey(classOracle.path, classOracle.localId)
      : classKeyFallback(classNode.path, classNode.name);
  };

  // F21 — same identity-or-name fix as scoreUsesTypeFromAgnostic, applied to
  // the target half of the (class, target) pair key. The class half (cKey)
  // is untouched: the oracle side is always id-based there (a `fromSym` is
  // always found via `?? e.fromLocalId`), so that dimension never hits the
  // mismatch this fix addresses.
  const oracleIdPairs = new Set<string>();
  const oracleNamePairs = new Set<string>();
  const oracleCanonicalPairs = new Set<string>();
  for (const e of oracleEdges) {
    if (e.type !== 'METHOD_OVERRIDES') {
      continue;
    }
    const fromSym = oracleByPathLocalId.get(`${normPathLocal(e.fromPath)}\0${e.fromLocalId}`);
    const containingClassLocalId = fromSym?.parentLocalId ?? e.fromLocalId;
    const cKey = classKey(e.fromPath, containingClassLocalId);
    const nameKey = `${cKey}\0name:${e.targetName}`;
    oracleNamePairs.add(nameKey);
    if (e.targetLocalId) {
      const idKey = `${cKey}\0id:${normPathLocal(e.targetPath ?? '')}\0${e.targetLocalId}`;
      oracleIdPairs.add(idKey);
      oracleCanonicalPairs.add(idKey);
    } else {
      oracleCanonicalPairs.add(nameKey);
    }
  }

  const toolCanonicalPairs = new Set<string>();
  let tp = 0;
  for (const e of toolEdges) {
    if (e.type !== 'METHOD_OVERRIDES') {
      continue;
    }
    const fromNode = toolNodeById.get(e.fromId);
    const toNode = toolNodeById.get(e.toId);
    if (!(fromNode && toNode)) {
      continue;
    }
    const cKey = resolveClassKey(fromNode);
    const toOracle = toolToOracle.get(toNode.id);
    const idKey = toOracle
      ? `${cKey}\0id:${normPathLocal(toOracle.path)}\0${toOracle.localId}`
      : null;
    const nameKey = `${cKey}\0name:${toOracle ? toOracle.name : toNode.name}`;
    const canonicalKey = idKey ?? nameKey;

    if (toolCanonicalPairs.has(canonicalKey)) {
      continue; // already counted this distinct (class, target) relationship
    }
    toolCanonicalPairs.add(canonicalKey);

    if ((idKey && oracleIdPairs.has(idKey)) || oracleNamePairs.has(nameKey)) {
      tp++;
    }
  }

  return computeMetrics(tp, toolCanonicalPairs.size - tp, oracleCanonicalPairs.size - tp);
}

function computeMetrics(tp: number, fp: number, fn: number): KindMetrics {
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const f1 = safeDiv(2 * precision * recall, precision + recall);
  return { f1, fn, fp, precision, recall, tp };
}

export interface EdgeScoringPartition {
  /** Comparable oracle edges eligible for the main table (member-level IMPLEMENTS excluded). */
  classLevelOracleEdges: OracleEdge[];
  /** Oracle IMPLEMENTS edges sourced from a class member (F8) — scored separately. */
  memberImplementsOracleEdges: OracleEdge[];
  /** Tool IMPLEMENTS edges sourced from a class member (F8) — scored separately (`implementsMemberLevel`), never in the main table. */
  memberImplementsToolEdges: GraphEdge[];
  /** Comparable tool edges eligible for the main table: symbol-level IMPORTS, class-level IMPLEMENTS, and every other comparable type unfiltered. */
  symbolLevelToolEdges: GraphEdge[];
}

/**
 * F24 — the F6 (IMPORTS granularity) and F8 (member- vs class-level
 * IMPLEMENTS) partitioning used to live only inside `scoreD2`, so `scoreD1`
 * adjudicated the *unpartitioned* comparable-edge set and printed a different
 * precision/FP count for the same tool and the same edge type (e.g. Vyazen
 * IMPORTS 96.9% in D2 vs 75.5% in D1 — D1 was charging FP for File-granularity
 * IMPORTS that D2 correctly routes to the module-level table instead). Both
 * scorers must partition identically before adjudicating, so this is
 * extracted once and shared rather than reimplemented per scorer.
 */
export function partitionEdgesForScoring(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[],
  oracleSymbols: OracleSymbol[]
): EdgeScoringPartition {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));
  const oracleSymbolKind = new Map<string, SymbolType>();
  for (const s of oracleSymbols) {
    oracleSymbolKind.set(`${s.path}\0${s.localId}`, s.kind);
  }
  const isOracleMemberImplements = (e: OracleEdge) =>
    e.type === 'IMPLEMENTS' &&
    isMemberSourceKind(oracleSymbolKind.get(`${e.fromPath}\0${e.fromLocalId}`));
  const isToolMemberImplements = (e: GraphEdge) =>
    e.type === 'IMPLEMENTS' && isMemberSourceKind(toolNodeById.get(e.fromId)?.kind);

  const symbolLevelToolEdges: GraphEdge[] = [];
  const memberImplementsToolEdges: GraphEdge[] = [];
  for (const e of toolEdges) {
    if (!COMPARABLE_EDGE_TYPES.has(e.type)) {
      continue;
    }
    if (e.type === 'IMPORTS' && toolNodeById.get(e.toId)?.kind === 'File') {
      continue;
    }
    if (isToolMemberImplements(e)) {
      memberImplementsToolEdges.push(e);
      continue;
    }
    symbolLevelToolEdges.push(e);
  }

  const classLevelOracleEdges: OracleEdge[] = [];
  const memberImplementsOracleEdges: OracleEdge[] = [];
  for (const e of oracleEdges) {
    if (!COMPARABLE_EDGE_TYPES.has(e.type)) {
      continue;
    }
    if (isOracleMemberImplements(e)) {
      memberImplementsOracleEdges.push(e);
    } else {
      classLevelOracleEdges.push(e);
    }
  }

  return {
    classLevelOracleEdges,
    memberImplementsOracleEdges,
    memberImplementsToolEdges,
    symbolLevelToolEdges,
  };
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
  adjudication: Pick<
    EdgeAdjudication,
    'scoreableOracleEdges' | 'unscoreableMatched' | 'unscoreableOracleEdges'
  >,
  type: EdgeType,
  tp: number
): EdgeFairnessMetrics {
  const totalSites = adjudication.scoreableOracleEdges
    .filter((e) => e.type === type)
    .reduce((sum, e) => sum + (e.siteCount ?? 1), 0);
  return {
    siteCoverage: safeDiv(tp, totalSites),
    unscoreableMatched: adjudication.unscoreableMatched.filter((e) => e.type === type).length,
    unscoreableExcluded: adjudication.unscoreableOracleEdges.filter((e) => e.type === type).length,
  };
}

/**
 * Compute module-level IMPORTS: convert File→Symbol edges to File→File pairs.
 * Both tools can compete at this level.
 *
 * F19 — an oracle IMPORTS row with no `targetPath` (the type checker couldn't
 * resolve the import specifier to a file) can't be turned into a file-pair at
 * all, so it was previously just skipped — the correct call for the recall
 * side (an unresolvable row was never going to be in the denominator), but
 * unresolved rows still silently vanished from the tool's side of the ledger
 * too: a tool's file-pair guess that happens to be right can never be
 * confirmed (no oraclePairs entry to match), and one that's wrong is charged
 * FP identically to a genuinely fabricated dependency. Both look the same:
 * "not in oraclePairs".
 *
 * Fix: give each source file a per-file *budget* equal to its count of
 * oracle-unresolved imports — the number of dependencies that file has which
 * the oracle itself couldn't verify. Any of that file's unmatched tool pairs,
 * up to the budget, are excused (`unscoreableExcluded`) rather than charged
 * FP. This is deliberately a capacity bound, not an exact identity match
 * (unlike F18's symbol-level fix): the oracle knows a file has N unverifiable
 * imports but not which N target files they resolve to, so there is no exact
 * key to match a tool's guess against. Any unmatched pairs beyond the budget
 * are still FP — a tool cannot claim more file-level dependencies than the
 * file has unverifiable imports and expect all of them excused.
 */
function scoreImportsModuleLevel(
  toolEdges: GraphEdge[],
  toolNodes: GraphNode[],
  oracleEdges: OracleEdge[]
): ImportModuleLevelMetrics {
  const toolNodeById = new Map(toolNodes.map((n) => [n.id, n]));

  // Convert tool IMPORTS edges to file→file pairs, grouped by source file so
  // the per-file budget below can be applied.
  const toolPairsByFrom = new Map<string, Set<string>>();
  for (const e of toolEdges) {
    if (e.type !== 'IMPORTS') {
      continue;
    }
    const from = toolNodeById.get(e.fromId);
    const to = toolNodeById.get(e.toId);
    if (!(from?.path && to?.path)) {
      continue;
    }
    let bucket = toolPairsByFrom.get(from.path);
    if (!bucket) {
      bucket = new Set<string>();
      toolPairsByFrom.set(from.path, bucket);
    }
    bucket.add(to.path);
  }

  // Convert oracle IMPORTS edges to file→file pairs.
  // Oracle IMPORTS: fromLocalId = file path, targetPath = resolved target file (if available)
  const oraclePairs = new Set<string>();
  const unresolvedImportBudget = new Map<string, number>();
  for (const e of oracleEdges) {
    if (e.type !== 'IMPORTS') {
      continue;
    }
    if (e.targetPath) {
      // Type-checker resolved: we know the target file
      oraclePairs.add(`${e.fromLocalId}\0${e.targetPath}`);
    } else {
      // Unresolved: can't form a pair, but this file has one more import the
      // oracle can't judge — grant a budget slot instead of skipping silently.
      unresolvedImportBudget.set(
        e.fromLocalId,
        (unresolvedImportBudget.get(e.fromLocalId) ?? 0) + 1
      );
    }
  }

  let tp = 0;
  let fp = 0;
  let unscoreableExcluded = 0;
  let toolPairsTotal = 0;
  for (const [fromPath, toPaths] of toolPairsByFrom) {
    toolPairsTotal += toPaths.size;
    let budget = unresolvedImportBudget.get(fromPath) ?? 0;
    for (const toPath of toPaths) {
      if (oraclePairs.has(`${fromPath}\0${toPath}`)) {
        tp++;
      } else if (budget > 0) {
        budget--;
        unscoreableExcluded++;
      } else {
        fp++;
      }
    }
  }
  const fn = oraclePairs.size - tp;

  return {
    fn,
    fp,
    precision: safeDiv(tp, tp + fp),
    recall: safeDiv(tp, tp + fn),
    oraclePairs: oraclePairs.size,
    toolPairs: toolPairsTotal,
    tp,
    unscoreableExcluded,
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

  // F8/F24: the oracle's class-level IMPLEMENTS (heritage clause) and
  // member-level IMPLEMENTS (a member satisfying an interface member) share
  // the EdgeType but must not share a denominator — a tool emitting only one
  // of the two must not be penalised against the other. Shared with `scoreD1`
  // via `partitionEdgesForScoring` so both scorers adjudicate the identical
  // edge population for a given type (F24).
  const partition = partitionEdgesForScoring(toolEdges, toolNodes, oracleEdges, oracleSymbols);
  const symbolLevelToolEdges = partition.symbolLevelToolEdges;
  const adjudication = adjudicateEdges(
    symbolLevelToolEdges,
    toolNodes,
    partition.classLevelOracleEdges,
    edgeNodeMatches,
    oracleSymbols
  );

  const memberImplementsAdj = adjudicateEdges(
    partition.memberImplementsToolEdges,
    toolNodes,
    partition.memberImplementsOracleEdges,
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

  // ── Phase 5: METHOD_OVERRIDES, from-side-agnostic ──────────────────────────
  const methodOverridesFromAgnostic = scoreMethodOverridesFromAgnostic(
    toolEdges,
    toolNodes,
    oracleEdges,
    oracleSymbols,
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
      methodOverridesFromAgnostic,
      overall: overallEdges,
      selfLoopLeak,
      targetAccuracy: safeDiv(totalTargetConfirmed, totalTpEdges),
      usesTypeFromAgnostic,
    },
    nodes: {
      byKind: Object.fromEntries(byKind) as Partial<Record<SymbolType, KindMetrics>>,
      duplicateNodesCollapsed: matchResult.duplicateToolNodesCollapsed,
      kindLabelling,
      macroF1,
      overall: overallNodes,
      oracleMatchRate: matchResult.oracleMatchRate,
      toolMatchRate: matchResult.toolMatchRate,
    },
  };
}
