/**
 * D4 — Capability envelope matrix.
 *
 * Matrix of ontology + query surface: what each tool can answer *at all*.
 * Qualitative; fastest to produce; weakest as evidence — but it is where
 * a tool's USES_TYPE and the competitors' extras get their fair hearing.
 *
 * The qualitative matrix is data-driven from each tool's declared
 * capabilities (opt-in). The ontology/edge-type coverage tables are always
 * computed from observed data.
 */

import type { EdgeType, SymbolType } from '../types';

export interface CapabilityEntry {
  /** What the capability is (e.g. "resolved CALLS", "Leiden communities"). */
  capability: string;
  /** Per-tool values: "yes" / "no" / "partial" / "N/A". */
  tools: Record<string, 'yes' | 'no' | 'partial' | 'N/A'>;
}

export interface D4Report {
  /** Capability matrix — features beyond the basic ontology. */
  capabilityMatrix: CapabilityEntry[];
  /** Edge-type coverage — which semantic edges each tool emits. */
  edgeTypeCoverage: Array<{
    tools: Record<string, 'yes' | 'no'>;
    type: EdgeType;
  }>;
  /** Ontology coverage — which symbol kinds each tool emits. */
  ontologyCoverage: Array<{
    tools: Record<string, 'yes' | 'no'>;
    kind: SymbolType;
  }>;
}

/**
 * Build the D4 capability report from observed node/edge kinds per tool.
 *
 * @param observedKinds Per tool: the set of SymbolType kinds actually present in the tool's graph
 * @param observedEdgeTypes Per tool: the set of EdgeType types actually present
 * @param toolNames Tool names (column headers)
 * @param declaredCapabilities Optional: per tool, a list of extra capability labels
 *   (e.g. "Leiden community clustering"). Rows = union of all declared labels;
 *   per-tool = "yes" if in that tool's list. Tools that declare nothing get "no"
 *   on every qualitative row — the ontology/edge-type tables still cover them.
 */
export function scoreD4(
  observedKinds: Record<string, Set<SymbolType>>,
  observedEdgeTypes: Record<string, Set<EdgeType>>,
  toolNames: string[],
  declaredCapabilities: Record<string, string[]> = {}
): D4Report {
  const allKinds = new Set<SymbolType>();
  for (const set of Object.values(observedKinds)) {
    for (const k of set) {
      allKinds.add(k);
    }
  }
  const allEdgeTypes = new Set<EdgeType>();
  for (const set of Object.values(observedEdgeTypes)) {
    for (const t of set) {
      allEdgeTypes.add(t);
    }
  }

  const ontologyCoverage = [...allKinds].map((kind) => ({
    kind,
    tools: Object.fromEntries(
      toolNames.map((t) => [t, (observedKinds[t]?.has(kind) ? 'yes' : 'no') as 'yes' | 'no'])
    ),
  }));

  const edgeTypeCoverage = [...allEdgeTypes].map((type) => ({
    type,
    tools: Object.fromEntries(
      toolNames.map((t) => [t, (observedEdgeTypes[t]?.has(type) ? 'yes' : 'no') as 'yes' | 'no'])
    ),
  }));

  // Qualitative capability matrix — data-driven from declared capabilities.
  // Rows = union of all tools' declared labels; per-tool = "yes" if declared.
  const allCapabilityLabels = new Set<string>();
  for (const caps of Object.values(declaredCapabilities)) {
    for (const c of caps) {
      allCapabilityLabels.add(c);
    }
  }
  const capabilityMatrix: CapabilityEntry[] = [...allCapabilityLabels].map((capability) => ({
    capability,
    tools: Object.fromEntries(
      toolNames.map((t) => [
        t,
        (declaredCapabilities[t]?.includes(capability) ? 'yes' : 'no') as 'yes' | 'no',
      ])
    ),
  }));

  return { ontologyCoverage, edgeTypeCoverage, capabilityMatrix };
}
