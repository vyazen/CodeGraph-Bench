#!/usr/bin/env bun
/**
 * Code-Graph Eval Runner (v2) — type-checker oracle + target accuracy.
 *
 * Usage:
 *   bun run scripts/eval/code-graph/runner.ts                 # full run
 *   bun run scripts/eval/code-graph/runner.ts --use-cache      # reuse cached JSONL
 *   bun run scripts/eval/code-graph/runner.ts --skip-oracle    # skip oracle (use cache)
 *   bun run scripts/eval/code-graph/runner.ts --skip-vyazen    # skip Vyazen dump
 *   bun run scripts/eval/code-graph/runner.ts --skip-gitnexus  # skip GitNexus dump
 *
 * Produces CODE_GRAPH_EVAL_SCORECARD.md.
 */

import { join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { runTypeCheckerOracle } from './oracle/ts-typechecker.oracle';
import { runVyazenAdapter } from './adapters/vyazen.adapter';
import { runGitNexusAdapter } from './adapters/gitnexus.adapter';
import { scoreD1, crossToolCoverage } from './scorers/d1-depth.scorer';
import { scoreD2 } from './scorers/d2-fidelity.scorer';
import { scoreD4 } from './scorers/d4-capability.scorer';
import { generateScorecard } from './report/scorecard.generator';
import type { EdgeType, GraphNode, SymbolType, ToolGraph } from './types';
import { COMPARABLE_EDGE_TYPES, EXT***REMOVED***ED_EDGE_TYPES } from './types';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const DATA_DIR = join(import.meta.dir, 'data');
const BABYLONJS_PATH = '/var/folders/d0/ffzf72s50hlfnby7_tz8shg80000gn/T/opencode/babylonjs-eval/babylonjs';
const COMMIT_SHA = '4efc0490';

const args = new Set(process.argv.slice(2));
const useCache = args.has('--use-cache');
const skipOracle = args.has('--skip-oracle');
const skipVyazen = args.has('--skip-vyazen');
const skipGitnexus = args.has('--skip-gitnexus');

async function main(): Promise<void> {
  console.log('=== Code-Graph Eval Runner (v2 — type-checker oracle) ===');
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`BabylonJS: ${BABYLONJS_PATH}`);
  console.log(`Flags: useCache=${useCache} skipOracle=${skipOracle} skipVyazen=${skipVyazen} skipGitnexus=${skipGitnexus}`);
  console.log('');

  // ── 1. Oracle (type-checker-backed) ────────────────────────────────────────
  let oracle;
  if (skipOracle) {
    console.log('[runner] Skipping oracle (assumed cached)');
  } else {
    console.log('[runner] Phase: Type-checker oracle');
    oracle = await runTypeCheckerOracle({
      repoPath: BABYLONJS_PATH,
      outDir: join(DATA_DIR, 'oracle'),
      useCache,
    });
  }

  if (!oracle) {
    const symbols = readFileSync(join(DATA_DIR, 'oracle', 'oracle-symbols.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const edges = readFileSync(join(DATA_DIR, 'oracle', 'oracle-edges.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    oracle = { edges, symbols, resolvedCount: edges.filter((e: any) => e.targetLocalId).length, totalEdges: edges.length };
    console.log(`[runner] Loaded oracle from cache: ${symbols.length} symbols, ${edges.length} edges (${oracle.resolvedCount} resolved)`);
  }

  // ── 2. Vyazen ──────────────────────────────────────────────────────────────
  let vyazenGraph: ToolGraph | null = null;
  if (!skipVyazen) {
    console.log('\n[runner] Phase: Vyazen');
    try {
      vyazenGraph = await runVyazenAdapter({
        outDir: join(DATA_DIR, 'vyazen'),
        useCache,
      });
    } catch (err) {
      console.error(`[runner] Vyazen adapter failed: ${err}`);
    }
  }

  // ── 3. GitNexus ────────────────────────────────────────────────────────────
  let gitnexusGraph: ToolGraph | null = null;
  if (!skipGitnexus) {
    console.log('\n[runner] Phase: GitNexus');
    try {
      gitnexusGraph = await runGitNexusAdapter({
        outDir: join(DATA_DIR, 'gitnexus'),
        repoPath: BABYLONJS_PATH,
        useCache,
      });
    } catch (err) {
      console.error(`[runner] GitNexus adapter failed: ${err}`);
    }
  }

  // ── 4. Score ───────────────────────────────────────────────────────────────
  console.log('\n[runner] Phase: Scoring');
  const graphs: Record<string, ToolGraph> = {};
  if (vyazenGraph) graphs.Vyazen = vyazenGraph;
  if (gitnexusGraph) graphs.GitNexus = gitnexusGraph;

  if (Object.keys(graphs).length === 0) {
    console.error('[runner] No tool graphs available — nothing to score');
    process.exit(1);
  }

  // Filter oracle to only include symbols/edges from files that at least one
  // tool indexes. The type-checker oracle sees all program files (including
  // test/config files the tools don't index); this removes that noise.
  const toolFilePaths = new Set<string>();
  for (const g of Object.values(graphs)) {
    for (const n of g.nodes) {
      if (n.path) toolFilePaths.add(n.path);
    }
  }
  const filteredOracleSymbols = oracle.symbols.filter((s: any) => toolFilePaths.has(s.path));
  const filteredOracleEdges = oracle.edges.filter((e: any) => {
    // Keep edges whose from-side file is indexed by a tool
    const fromPath = e.type === 'IMPORTS' ? e.fromLocalId : null;
    const symPath = oracle.symbols.find((s: any) => s.localId === e.fromLocalId)?.path;
    return toolFilePaths.has(fromPath || symPath || '');
  });
  console.log(`[runner] Oracle filtered: ${filteredOracleSymbols.length}/${oracle.symbols.length} symbols, ${filteredOracleEdges.length}/${oracle.edges.length} edges (files indexed by tools: ${toolFilePaths.size})`);

  const filterEdges = (g: ToolGraph): ToolGraph['edges'] =>
    g.edges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type) || EXT***REMOVED***ED_EDGE_TYPES.has(e.type));

  const d2: Record<string, ReturnType<typeof scoreD2>> = {};
  const d1: Record<string, ReturnType<typeof scoreD1>> = {};
  for (const [name, graph] of Object.entries(graphs)) {
    console.log(`[runner] Scoring ${name}...`);
    const filteredEdges = filterEdges(graph);
    d2[name] = scoreD2(graph.nodes, filteredEdges, filteredOracleSymbols, filteredOracleEdges);
    d1[name] = scoreD1(graph.nodes, graph.edges, filteredOracleSymbols, filteredOracleEdges, name === 'Vyazen');
  }

  // Cross-tool coverage
  const coverage: Record<string, ReturnType<typeof crossToolCoverage>> = {};
  if (vyazenGraph && gitnexusGraph) {
    console.log('[runner] Computing cross-tool coverage (Vyazen → GitNexus)...');
    coverage.GitNexus = crossToolCoverage(
      vyazenGraph.nodes,
      vyazenGraph.edges,
      gitnexusGraph.nodes,
      gitnexusGraph.edges,
      'GitNexus',
    );
  }

  // D4 capability matrix — include extended edge types
  const observedKinds: Record<string, Set<SymbolType>> = {};
  const observedEdgeTypes: Record<string, Set<EdgeType>> = {};
  for (const [name, graph] of Object.entries(graphs)) {
    observedKinds[name] = new Set(graph.nodes.map((n) => n.kind));
    observedEdgeTypes[name] = new Set(graph.edges.map((e) => e.type));
  }
  const d4 = scoreD4(observedKinds, observedEdgeTypes, Object.keys(graphs));

  // ── 5. Generate scorecard ──────────────────────────────────────────────────
  console.log('\n[runner] Phase: Scorecard generation');
  const scorecard = generateScorecard({
    caveats: [
      '**TypeScript is Vyazen\'s best case.**   A TS-only result overstates the general moat.',
      '**Oracle is type-checker-backed (v2).** The oracle uses the full TS compiler with TypeChecker — it can resolve specific call targets, inheritance, and imports. This is neutral: the type checker IS the language\'s semantics. If a heuristic tool\'s edge matches the type checker\'s resolution, it\'s a TP.',
      '**Target accuracy replaces "resolution rate".** Instead of comparing a boolean "resolved" (which meant different things per tool), we now measure: of the tool\'s TPs, what fraction point to the SAME target the type checker resolves to (by path + startLine ±2)? This is "does the edge point to the right code?"',
      '**Two-level IMPORTS scoring.** Level 1: module dependency (File→File) — both tools compete. Level 2: symbol-level (File→Symbol) — Vyazen advantage. GitNexus\'s 0 TP on symbol-level IMPORTS is a granularity difference, not a quality failure.',
      '**Extended edge types scored separately.** USES_TYPE (Vyazen), ACCESSES + METHOD_OVERRIDES (GitNexus) are scored per-tool against the oracle — each tool on what it produces.',
      '**`USES_TYPE` still excluded from head-to-head** — no GitNexus equivalent for the combined score.',
      '**Node identity matching** uses (path, name, startLine±2) per §5. Overloads resolved by nearest line. Anonymous/computed names skipped.',
      '**Single repo.** BabylonJS is one large, mature, TS-heavy codebase. Does not generalize to small repos, monorepos, or polyglot.',
      '**Potpie + Graphify not evaluated** in this pass — deferred per their private-API / legacy-stack complications (§6.3, §6.4).',
    ],
    commitSha: COMMIT_SHA,
    coverage,
    d1,
    d2,
    d4,
    generatedAt: new Date().toISOString(),
    graphs,
    oracleResolvedRate: oracle.resolvedCount > 0 ? oracle.resolvedCount / oracle.totalEdges : 0,
  });

  const { writeFileSync } = await import('node:fs');
  const scorecardPath = join(ROOT, 'CODE_GRAPH_EVAL_SCORECARD.md');
  writeFileSync(scorecardPath, scorecard);
  console.log(`\n[runner] Scorecard written to ${scorecardPath}`);
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
