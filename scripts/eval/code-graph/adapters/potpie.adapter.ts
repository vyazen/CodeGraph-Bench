/**
 * Potpie adapter — streams the NDJSON payload written by `potpie-parse <repo_dir>`
 * (the Rust `extract_graph` path, `parsing_rs`; production parser, see
 * POTPIE_EVAL_PLAN.md §2.1/§3).
 *
 * Schema facts that drove this adapter (measured, not inferred — POTPIE_EVAL_PLAN.md §3):
 *
 * 1. Records are `{kind:'header'|'node'|'edge'|'footer'}`. The footer carries
 *    `node_count`/`edge_count`/`elapsed_s` and, on parser failure, an `error`
 *    field — a silent partial graph would otherwise score as a low number
 *    instead of a crash, so the footer is checked, not skipped blindly.
 * 2. FILE nodes carry the entire file text (`text`). On BabylonJS this makes
 *    the NDJSON ~180MB — stream with `readline`, never `readFileSync`, and
 *    drop `text` on ingest (nothing downstream uses it).
 * 3. Lines are 0-based (`node.start_position().row`) — `+1` on both `line` and
 *    `end_line` to match the oracle's 1-based convention.
 * 4. `class_name` (present only on FUNCTION nodes owned by a class) gives
 *    exact Method/Function/Constructor separation — see `normalizePotpieKind`.
 * 5. No Class→Method containment — only File→symbol via `CONTAINS`. `parentId`
 *    is populated from the `CONTAINS` edge whose target is this node.
 * 6. No confidence field. `resolved`/`confidence` are always `null` — never
 *    synthesized `true`. Potpie never emits a `fromId === toId` self-edge, so
 *    the abstention path (edge-adjudicator.ts) never triggers for Potpie.
 */

import { execSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { GraphEdge, GraphNode, ToolGraph, ToolMeta } from '../types';
import { normalizePotpieEdgeType, normalizePotpieKind } from '../types';

export interface PotpieAdapterOptions {
  ndjsonPath: string;
  outDir: string;
  potpiePath: string;
  useCache?: boolean;
}

interface RawNode {
  class_name?: string;
  end_line: number;
  file: string;
  id: string;
  kind: 'node';
  line: number;
  name: string;
  node_type: string;
  text?: string;
}

interface RawEdge {
  end_ref_line?: number;
  ident?: string;
  kind: 'edge';
  ref_line?: number;
  relationship_type: string;
  source_id: string;
  target_id: string;
}

interface RawFooter {
  edge_count: number;
  elapsed_s: number;
  error?: string;
  kind: 'footer';
  node_count: number;
}

/** Get the git SHA of the Potpie source checkout — the recorded "version" (no PyPI release, §7.1). */
function potpieVersion(potpiePath: string): string {
  if (process.env.POTPIE_VERSION) {
    return process.env.POTPIE_VERSION;
  }
  try {
    return execSync('git rev-parse --short HEAD', { cwd: potpiePath, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

export async function runPotpieAdapter(opts: PotpieAdapterOptions): Promise<ToolGraph> {
  mkdirSync(opts.outDir, { recursive: true });
  const nodesPath = join(opts.outDir, 'nodes.jsonl');
  const edgesPath = join(opts.outDir, 'edges.jsonl');
  const version = potpieVersion(opts.potpiePath);

  if (opts.useCache && existsSync(nodesPath) && existsSync(edgesPath)) {
    return readCachedGraph(nodesPath, edgesPath, version);
  }

  if (!existsSync(opts.ndjsonPath)) {
    throw new Error(
      `[potpie] ${opts.ndjsonPath} not found — run \`potpie-parse <repo_dir> > ${opts.ndjsonPath}\` first`
    );
  }

  console.log(`[potpie] Streaming ${opts.ndjsonPath}...`);
  // parentId is derived from CONTAINS edges (FILE -> symbol), which stream
  // interleaved with the nodes they reference — buffer and backfill after.
  const allNodes: GraphNode[] = [];
  const nodeIndexById = new Map<string, number>();
  const allEdges: GraphEdge[] = [];
  const containsBySource = new Map<string, string[]>(); // fileId -> [targetId, ...]
  let footer: RawFooter | null = null;
  let unmappedRelations = 0;

  const rl = createInterface({
    input: createReadStream(opts.ndjsonPath, { encoding: 'utf8' }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of rl) {
    if (!line.trim()) {
      continue;
    }
    const rec = JSON.parse(line) as RawNode | RawEdge | RawFooter | { kind: 'header' };
    if (rec.kind === 'header') {
      continue;
    }
    if (rec.kind === 'footer') {
      footer = rec;
      continue;
    }
    if (rec.kind === 'node') {
      const kind = normalizePotpieKind(rec.node_type, rec.class_name ?? null, rec.name);
      nodeIndexById.set(rec.id, allNodes.length);
      allNodes.push({
        endLine: rec.end_line + 1,
        id: rec.id,
        kind,
        name: rec.name,
        originalKind: rec.node_type,
        parentId: null,
        path: rec.file,
        startLine: rec.line + 1,
        toolId: rec.id,
      });
      continue;
    }
    if (rec.kind === 'edge') {
      if (rec.relationship_type === 'CONTAINS') {
        let arr = containsBySource.get(rec.source_id);
        if (!arr) {
          arr = [];
          containsBySource.set(rec.source_id, arr);
        }
        arr.push(rec.target_id);
        continue; // structural — not a scored edge (outside COMPARABLE/EXT***REMOVED***ED sets)
      }
      const type = normalizePotpieEdgeType(rec.relationship_type);
      if (type === 'UNKNOWN') {
        unmappedRelations++;
        continue;
      }
      allEdges.push({
        confidence: null,
        edgeKind: rec.relationship_type,
        fromId: rec.source_id,
        resolved: null,
        toId: rec.target_id,
        type,
      });
    }
  }

  if (footer?.error) {
    throw new Error(`[potpie] Parser reported a failure in the footer: ${footer.error}`);
  }

  // Backfill parentId from buffered CONTAINS edges (FILE -> symbol only, §Phase 4).
  for (const [sourceId, targetIds] of containsBySource) {
    for (const targetId of targetIds) {
      const idx = nodeIndexById.get(targetId);
      if (idx !== undefined) {
        allNodes[idx].parentId = sourceId;
      }
    }
  }

  console.log(
    `[potpie] Streamed: ${allNodes.length} nodes, ${allEdges.length} comparable edges, ${unmappedRelations} unmapped relations excluded`
  );
  if (footer) {
    console.log(
      `[potpie] Footer: node_count=${footer.node_count} edge_count=${footer.edge_count} elapsed_s=${footer.elapsed_s}`
    );
  }
  console.log(
    `[potpie] Nodes by kind: ${JSON.stringify(
      Object.fromEntries([
        ...allNodes.reduce(
          (m, n) => m.set(n.kind, (m.get(n.kind) ?? 0) + 1),
          new Map<string, number>()
        ),
      ])
    )}`
  );

  writeJsonl(nodesPath, allNodes);
  writeJsonl(edgesPath, allEdges);
  console.log(
    `[potpie] Wrote ${allNodes.length} nodes, ${allEdges.length} edges to ${opts.outDir}`
  );

  const meta: ToolMeta = {
    commitSha: '4efc0490',
    edgeCount: allEdges.length,
    name: 'Potpie',
    nodeCount: allNodes.length,
    version,
  };

  return { edges: allEdges, meta, nodes: allNodes };
}

function writeJsonl(path: string, records: unknown[]): void {
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  writeFileSync(path, lines + (lines.length > 0 ? '\n' : ''));
}

function readCachedGraph(nodesPath: string, edgesPath: string, version: string): ToolGraph {
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
  console.log(`[potpie] Cached: ${nodes.length} nodes, ${edges.length} edges`);
  return {
    edges,
    meta: {
      commitSha: '4efc0490',
      edgeCount: edges.length,
      name: 'Potpie',
      nodeCount: nodes.length,
      version,
    },
    nodes,
  };
}
