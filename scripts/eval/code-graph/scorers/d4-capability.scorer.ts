/**
 * D4 — Capability envelope matrix.
 *
 * Per CODE_GRAPH_EVAL_PLAN.md §7 D4:
 *   Matrix of ontology + query surface: what each tool can answer *at all*.
 *   Qualitative; fastest to produce; weakest as evidence — but it is where
 *   Vyazen's USES_TYPE and the competitors' extras get their fair hearing.
 *
 * This is a static matrix — the entries are encoded from the tool's documented
 * ontology + observed graph schema. It doesn't run queries; it reports capability.
 */

import type { EdgeType, SymbolType } from '../types';

export interface CapabilityEntry {
  /** What the capability is (e.g. "resolved CALLS", "Leiden communities"). */
  capability: string;
  /** Per-tool values: "yes" / "no" / "partial" / "N/A". */
  tools: Record<string, 'yes' | 'no' | 'partial' | 'N/A'>;
}

export interface D4Report {
  /** Ontology coverage — which symbol kinds each tool emits. */
  ontologyCoverage: Array<{
    tools: Record<string, 'yes' | 'no'>;
    kind: SymbolType;
  }>;
  /** Edge-type coverage — which semantic edges each tool emits. */
  edgeTypeCoverage: Array<{
    tools: Record<string, 'yes' | 'no'>;
    type: EdgeType;
  }>;
  /** Capability matrix — features beyond the basic ontology. */
  capabilityMatrix: CapabilityEntry[];
}

/**
 * Build the D4 capability report from observed node/edge kinds per tool.
 *
 * @param observedKinds Per tool: the set of SymbolType kinds actually present in the tool's graph
 * @param observedEdgeTypes Per tool: the set of EdgeType types actually present
 * @param toolNames Tool names (column headers)
 */
export function scoreD4(
  observedKinds: Record<string, Set<SymbolType>>,
  observedEdgeTypes: Record<string, Set<EdgeType>>,
  toolNames: string[],
): D4Report {
  const allKinds = new Set<SymbolType>();
  for (const set of Object.values(observedKinds)) {
    for (const k of set) allKinds.add(k);
  }
  const allEdgeTypes = new Set<EdgeType>();
  for (const set of Object.values(observedEdgeTypes)) {
    for (const t of set) allEdgeTypes.add(t);
  }

  const ontologyCoverage = [...allKinds].map((kind) => ({
    kind,
    tools: Object.fromEntries(
      toolNames.map((t) => [t, (observedKinds[t]?.has(kind) ? 'yes' : 'no') as 'yes' | 'no']),
    ),
  }));

  const edgeTypeCoverage = [...allEdgeTypes].map((type) => ({
    type,
    tools: Object.fromEntries(
      toolNames.map((t) => [t, (observedEdgeTypes[t]?.has(type) ? 'yes' : 'no') as 'yes' | 'no']),
    ),
  }));

  // Static capability matrix — encoded from observed schemas + documented features
  const capabilityMatrix: CapabilityEntry[] = [
    {
      capability: 'Compiler/type-aware edge resolution (resolved=true)',
      tools: { GitNexus: 'no', Vyazen: 'yes' },
    },
    {
      capability: 'resolutionKind slice (compiler-symbol vs receiver-type)',
      tools: { GitNexus: 'no', Vyazen: 'yes' },
    },
    {
      capability: 'USES_TYPE edges (type usage tracking)',
      tools: { GitNexus: 'no', Vyazen: 'yes' },
    },
    {
      capability: 'Leiden community clustering',
      tools: { GitNexus: 'yes', Vyazen: 'no' },
    },
    {
      capability: 'Process tracing (execution flow nodes)',
      tools: { GitNexus: 'yes', Vyazen: 'no' },
    },
    {
      capability: 'BM25 + semantic hybrid search',
      tools: { GitNexus: 'yes', Vyazen: 'no' },
    },
    {
      capability: 'Code embeddings (vector search)',
      tools: { GitNexus: 'yes', Vyazen: 'yes' },
    },
    {
      capability: 'Incremental re-indexing',
      tools: { GitNexus: 'yes', Vyazen: 'yes' },
    },
    {
      capability: 'Blast-radius / impact analysis',
      tools: { GitNexus: 'yes', Vyazen: 'yes' },
    },
    {
      capability: 'METHOD_OVERRIDES edges',
      tools: { GitNexus: 'yes', Vyazen: 'no' },
    },
    {
      capability: 'ACCESSES edges (property access tracking)',
      tools: { GitNexus: 'yes', Vyazen: 'no' },
    },
  ];

  return { ontologyCoverage, edgeTypeCoverage, capabilityMatrix };
}
