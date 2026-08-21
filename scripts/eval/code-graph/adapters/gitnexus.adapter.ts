/**
 * GitNexus adapter — queries the local LadybugDB graph via `gitnexus cypher`.
 *
 * GitNexus has a clean CLI path. The `cypher`
 * subcommand is the export escape hatch. The only output format is markdown
 * tables (no --json flag), and the CLI truncates output at 64KB, so we page
 * through large results with SKIP/LIMIT.
 *
 * LadybugDB (Kùzu) schema (observed via `CALL show_tables()`):
 *   Nodes: Method, Property, Function, Const, File, Variable, Class, Community,
 *          Interface, Section, Folder, Process, Route, Constructor, Enum,
 *          TypeAlias, Namespace, Struct, Record, ...
 *   Edges: single CodeRelation table with a `type` property (CALLS, IMPORTS,
 *          EXT***REMOVED***S, IMPLEMENTS, CONTAINS, ACCESSES, METHOD_OVERRIDES, ...)
 *          and a `confidence` (0-1) — no boolean `resolved`.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GraphEdge, GraphNode, ToolGraph, ToolMeta } from '../types';
import { normalizeGitNexusEdgeType, normalizeGitNexusKind } from '../types';

const PAGE_SIZE = 800; // Keep well under 64KB per page (~80 bytes/row)

/**
 * Run a Cypher query via gitnexus cypher and parse the markdown table into rows.
 *
 * `--repo` is required once more than one repo is registered globally (`gitnexus
 * list`) — cwd-based auto-detection only works with a single registered repo, and
 * silently erroring on every query here would otherwise produce a false "0 nodes,
 * 0 edges" result rather than a loud failure.
 */
function runCypher(
  repoPath: string,
  repoName: string,
  cypher: string
): Array<Record<string, string>> {
  const escaped = cypher.replace(/"/g, '\\"');
  let raw: string;
  try {
    raw = execSync(`gitnexus cypher -r "${repoName}" "${escaped}"`, {
      cwd: repoPath,
      maxBuffer: 1024 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (err) {
    console.warn(`[gitnexus] Query failed: ${String(err).slice(0, 200)}`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Output truncated at 64KB — caller should use paging
    console.warn('[gitnexus] JSON parse failed (likely truncated at 64KB). Use paging.');
    return [];
  }
  if (Array.isArray(parsed)) {
    return [];
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const obj = parsed as { markdown?: string; error?: string };
    if (obj.error) {
      console.warn(`[gitnexus] Query error: ${obj.error}`);
      return [];
    }
    if (!obj.markdown) {
      return [];
    }
    return parseMarkdownTable(obj.markdown);
  }
  return [];
}

/** Run a Cypher query with paging, accumulating all rows. */
function runCypherPaged(
  repoPath: string,
  repoName: string,
  baseCypher: string
): Array<Record<string, string>> {
  const allRows: Array<Record<string, string>> = [];
  let skip = 0;
  // If the base query has a RETURN clause, inject SKIP/LIMIT before any ORDER BY
  while (true) {
    const paged = `${baseCypher} SKIP ${skip} LIMIT ${PAGE_SIZE}`;
    const rows = runCypher(repoPath, repoName, paged);
    if (rows.length === 0) {
      break;
    }
    allRows.push(...rows);
    if (rows.length < PAGE_SIZE) {
      break; // last page
    }
    skip += PAGE_SIZE;
    if (skip % 5000 === 0) {
      console.log(`[gitnexus]   ... ${skip} rows so far`);
    }
  }
  return allRows;
}

/** Parse a markdown table into an array of {column: value} records. */
function parseMarkdownTable(md: string): Array<Record<string, string>> {
  const lines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) {
    return [];
  }

  const splitRow = (line: string): string[] =>
    line
      .split('|')
      .map((c) => c.trim())
      .filter((c, i, arr) => !((i === 0 && c === '') || (i === arr.length - 1 && c === '')));

  const headers = splitRow(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = splitRow(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = cells[idx] ?? '';
    });
    rows.push(row);
  }
  return rows;
}

export interface GitNexusAdapterOptions {
  outDir: string;
  /** Name as registered with `gitnexus list` — required to disambiguate once more than one repo is indexed. */
  repoName: string;
  repoPath: string;
  useCache?: boolean;
}

const NODE_LABELS = [
  'Class',
  'Interface',
  'Enum',
  'TypeAlias',
  'Function',
  'Method',
  'Constructor',
  'Property',
  'Variable',
  'Const',
  'Static',
  'Module',
  'Namespace',
  'Struct',
  'Record',
];

const EDGE_TYPES = [
  'CALLS',
  'IMPORTS',
  'EXT***REMOVED***S',
  'IMPLEMENTS',
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'METHOD_OVERRIDES',
];

// Labels that DON'T have startLine/endLine (structural nodes)
const STRUCTURAL_LABELS = new Set(['File', 'Folder']);

export async function runGitNexusAdapter(opts: GitNexusAdapterOptions): Promise<ToolGraph> {
  mkdirSync(opts.outDir, { recursive: true });
  const nodesPath = join(opts.outDir, 'nodes.jsonl');
  const edgesPath = join(opts.outDir, 'edges.jsonl');

  if (opts.useCache && existsSync(nodesPath) && existsSync(edgesPath)) {
    return readCachedGraph(nodesPath, edgesPath);
  }

  // ── Symbol nodes (with startLine) ──────────────────────────────────────────
  const allNodes: GraphNode[] = [];
  for (const label of NODE_LABELS) {
    console.log(`[gitnexus] Dumping ${label} nodes...`);
    const cypher = `MATCH (n:${label}) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine, '${label}' AS label`;
    const rows = runCypherPaged(opts.repoPath, opts.repoName, cypher);
    for (const r of rows) {
      if (!(r.id && r.name)) {
        continue;
      }
      const startLine = r.startLine ? Number.parseInt(r.startLine, 10) : null;
      const endLine = r.endLine ? Number.parseInt(r.endLine, 10) : null;
      allNodes.push({
        endLine: Number.isNaN(endLine as number) ? null : endLine,
        id: r.id,
        kind: normalizeGitNexusKind(r.label || label),
        name: r.name,
        originalKind: r.label || label,
        parentId: null,
        path: r.filePath || '',
        startLine: Number.isNaN(startLine as number) ? null : startLine,
        toolId: r.id,
      });
    }
  }

  // ── File nodes (no startLine) — needed as edge endpoints for IMPORTS ───────
  console.log('[gitnexus] Dumping File nodes...');
  const fileRows = runCypherPaged(
    opts.repoPath,
    opts.repoName,
    `MATCH (n:File) RETURN n.id AS id, n.name AS name, n.filePath AS filePath, '${'File'}' AS label`
  );
  for (const r of fileRows) {
    if (!r.id) {
      continue;
    }
    allNodes.push({
      endLine: null,
      id: r.id,
      kind: 'File' as const,
      name: r.name || r.id,
      originalKind: 'File',
      parentId: null,
      path: r.filePath || r.name || '',
      startLine: null,
      toolId: r.id,
    });
  }
  console.log(`[gitnexus] Total nodes: ${allNodes.length}`);

  // ── Edges (paged) ──────────────────────────────────────────────────────────
  const allEdges: GraphEdge[] = [];
  for (const rawType of EDGE_TYPES) {
    console.log(`[gitnexus] Dumping ${rawType} edges...`);
    const cypher = `MATCH (a)-[e:CodeRelation]->(b) WHERE e.type='${rawType}' RETURN a.id AS fromId, e.type AS type, e.confidence AS confidence, b.id AS toId, b.name AS toName`;
    const rows = runCypherPaged(opts.repoPath, opts.repoName, cypher);
    for (const r of rows) {
      if (!(r.fromId && r.toId)) {
        continue;
      }
      const normalizedType = normalizeGitNexusEdgeType(r.type || rawType);
      if (normalizedType === 'UNKNOWN') {
        continue;
      }
      allEdges.push({
        confidence: r.confidence ? Number.parseFloat(r.confidence) : null,
        edgeKind: r.type || rawType,
        fromId: r.fromId,
        resolved: r.confidence ? Number.parseFloat(r.confidence) >= 0.5 : null,
        toId: r.toId,
        type: normalizedType,
      });
    }
    console.log(`[gitnexus]   ${rawType}: ${rows.length} rows`);
  }
  console.log(`[gitnexus] Total comparable edges: ${allEdges.length}`);

  writeJsonl(nodesPath, allNodes);
  writeJsonl(edgesPath, allEdges);
  console.log(
    `[gitnexus] Wrote ${allNodes.length} nodes, ${allEdges.length} edges to ${opts.outDir}`
  );

  const meta: ToolMeta = {
    commitSha: '4efc0490',
    edgeCount: allEdges.length,
    name: 'GitNexus',
    nodeCount: allNodes.length,
    version: '1.6.9',
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
  console.log(`[gitnexus] Cached: ${nodes.length} nodes, ${edges.length} edges`);
  return {
    edges,
    meta: {
      commitSha: '4efc0490',
      edgeCount: edges.length,
      name: 'GitNexus',
      nodeCount: nodes.length,
      version: '1.6.9',
    },
    nodes,
  };
}

// Suppress unused warning
void STRUCTURAL_LABELS;
