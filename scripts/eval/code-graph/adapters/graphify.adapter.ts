/**
 * Graphify adapter — parses `graphify-out/graph.json` written by
 * `graphify update <path> --force` (public CLI, no LLM, per
 * GRAPHIFY_EVAL_PLAN.md §2/§4).
 *
 * `graph.json` is a networkx node-link JSON: `{ nodes: [...], links: [...] }`.
 * Two schema facts drove the design below (verified by inspecting a real
 * BabylonJS run, not from source reading):
 *
 * 1. **No symbol-kind field for TS/JS.** `node.metadata.kind` only exists for
 *    bash nodes (5 of 56,412 in the BabylonJS run) — every TS/JS node (class,
 *    interface, enum, type alias, function, method, property, variable) is a
 *    bare `{ id, label, source_file, source_location, community, ... }`
 *    record with no discriminator. Class vs. interface vs. enum vs. type
 *    alias vs. variable is genuinely unrecoverable from this file. Kind is
 *    reconstructed structurally instead:
 *      - `File`: label equals the basename of its own source_file (Graphify
 *        emits exactly one such per-file placeholder node).
 *      - `Method`: label ends in `()` AND the node is the target of at least
 *        one `method` relation (i.e. some owner claims it as a member).
 *      - `Function`: label ends in `()` but has no incoming `method` edge
 *        (top-level, unowned callable).
 *      - Everything else → `Unknown` (auto-excluded from node fidelity per
 *        the existing convention — see types.ts). This silently swallows
 *        Class/Interface/Enum/Alias/Property/GlobalVariable; there is no way
 *        to recover them from this file. Disclosed in the scorecard caveats,
 *        not worked around.
 *
 * 2. **`source_location` is a single line (`"L48"`), never a range.** There
 *    is no end-line anywhere in the schema. `endLine` is always `null` — an
 *    honest gap, not a bug.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { GraphEdge, GraphNode, SymbolType, ToolGraph, ToolMeta } from '../types';
import { normalizeGraphifyEdgeType } from '../types';

export interface GraphifyAdapterOptions {
  useCache?: boolean;
  outDir: string;
  repoPath: string;
}

interface RawNode {
  id: string;
  label: string;
  source_file?: string;
  source_location?: string;
  metadata?: { kind?: string; language?: string };
}

interface RawLink {
  relation: string;
  confidence: string; // 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' (never observed)
  confidence_score?: number;
  source: string;
  target: string;
}

interface RawGraph {
  nodes: RawNode[];
  links: RawLink[];
  built_at_commit?: string;
}

/** Parse "L48" → 48. Returns null for anything else (never observed, but the schema doesn't guarantee it). */
function parseLineMarker(loc: string | undefined): number | null {
  if (!loc) return null;
  const m = /^L(\d+)$/.exec(loc);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Strip a leading '.' and a trailing "()" to recover the bare symbol name (e.g. ".IsSupported()" -> "IsSupported"). */
function bareName(label: string): string {
  return label.replace(/^\./, '').replace(/\(\)$/, '');
}

function classifyNodes(raw: RawGraph): Map<string, SymbolType> {
  const methodTargets = new Set<string>();
  for (const l of raw.links) {
    if (l.relation === 'method') methodTargets.add(l.target);
  }

  const kinds = new Map<string, SymbolType>();
  for (const n of raw.nodes) {
    const base = n.source_file ? basename(n.source_file) : null;
    if (base && n.label === base) {
      kinds.set(n.id, 'File');
    } else if (n.label.endsWith('()')) {
      kinds.set(n.id, methodTargets.has(n.id) ? 'Method' : 'Function');
    } else {
      kinds.set(n.id, 'Unknown');
    }
  }
  return kinds;
}

export async function runGraphifyAdapter(opts: GraphifyAdapterOptions): Promise<ToolGraph> {
  mkdirSync(opts.outDir, { recursive: true });
  const nodesPath = join(opts.outDir, 'nodes.jsonl');
  const edgesPath = join(opts.outDir, 'edges.jsonl');

  if (opts.useCache && existsSync(nodesPath) && existsSync(edgesPath)) {
    return readCachedGraph(nodesPath, edgesPath);
  }

  const graphJsonPath = join(opts.repoPath, 'graphify-out', 'graph.json');
  if (!existsSync(graphJsonPath)) {
    throw new Error(
      `[graphify] ${graphJsonPath} not found — run \`graphify update ${opts.repoPath} --force\` first`,
    );
  }
  console.log(`[graphify] Reading ${graphJsonPath}...`);
  const raw: RawGraph = JSON.parse(readFileSync(graphJsonPath, 'utf8'));
  console.log(`[graphify] Raw: ${raw.nodes.length} nodes, ${raw.links.length} links (commit ${raw.built_at_commit ?? 'unknown'})`);

  const kinds = classifyNodes(raw);

  const allNodes: GraphNode[] = raw.nodes.map((n) => {
    const kind = kinds.get(n.id) ?? 'Unknown';
    const name = kind === 'File' ? n.label : bareName(n.label);
    return {
      endLine: null,
      id: n.id,
      kind,
      name,
      originalKind: n.label,
      parentId: null,
      path: n.source_file ?? '',
      startLine: parseLineMarker(n.source_location),
      toolId: n.id,
    };
  });

  const allEdges: GraphEdge[] = [];
  let unknownRelations = 0;
  for (const l of raw.links) {
    const type = normalizeGraphifyEdgeType(l.relation);
    if (type === 'UNKNOWN') {
      unknownRelations++;
      continue;
    }
    const resolved = l.confidence === 'EXTRACTED';
    allEdges.push({
      confidence: l.confidence_score ?? (resolved ? 1.0 : 0.5),
      edgeKind: l.relation,
      fromId: l.source,
      resolved,
      toId: l.target,
      type,
    });
  }
  console.log(`[graphify] Nodes by kind: ${JSON.stringify(Object.fromEntries(
    [...allNodes.reduce((m, n) => m.set(n.kind, (m.get(n.kind) ?? 0) + 1), new Map<string, number>())],
  ))}`);
  console.log(`[graphify] Edges: ${allEdges.length} mapped, ${unknownRelations} excluded (unmapped relation)`);

  writeJsonl(nodesPath, allNodes);
  writeJsonl(edgesPath, allEdges);
  console.log(`[graphify] Wrote ${allNodes.length} nodes, ${allEdges.length} edges to ${opts.outDir}`);

  const meta: ToolMeta = {
    commitSha: raw.built_at_commit ?? '4efc0490',
    edgeCount: allEdges.length,
    name: 'Graphify',
    nodeCount: allNodes.length,
    version: process.env.GRAPHIFY_VERSION ?? '0.9.27',
  };

  return { edges: allEdges, meta, nodes: allNodes };
}

function writeJsonl(path: string, records: unknown[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, lines + (lines.length > 0 ? '\n' : ''));
}

function readCachedGraph(nodesPath: string, edgesPath: string): ToolGraph {
  const nodes = readFileSync(nodesPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GraphNode);
  const edges = readFileSync(edgesPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as GraphEdge);
  console.log(`[graphify] Cached: ${nodes.length} nodes, ${edges.length} edges`);
  return {
    edges,
    meta: {
      commitSha: '4efc0490',
      edgeCount: edges.length,
      name: 'Graphify',
      nodeCount: nodes.length,
      version: process.env.GRAPHIFY_VERSION ?? '0.9.27',
    },
    nodes,
  };
}
