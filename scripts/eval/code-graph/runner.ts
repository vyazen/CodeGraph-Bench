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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGitNexusAdapter } from './adapters/gitnexus.adapter';
import { runGraphifyAdapter } from './adapters/graphify.adapter';
import { runPotpieAdapter } from './adapters/potpie.adapter';
import { runVyazenAdapter } from './adapters/vyazen.adapter';
import { deriveScoreable, runTypeCheckerOracle } from './oracle/ts-typechecker.oracle';
import { generateScorecard } from './report/scorecard.generator';
import { crossToolCoverage, scoreD1 } from './scorers/d1-depth.scorer';
import { scoreD2 } from './scorers/d2-fidelity.scorer';
import { scoreD4 } from './scorers/d4-capability.scorer';
import type { EdgeType, SymbolType, ToolGraph } from './types';
import { COMPARABLE_EDGE_TYPES, EXT***REMOVED***ED_EDGE_TYPES } from './types';

const DATA_DIR = join(import.meta.dir, 'data');
const BABYLONJS_PATH = process.env.BABYLONJS_EVAL_PATH;
const COMMIT_SHA = '4efc0490';
const POTPIE_REPO_PATH = join(import.meta.dir, '..', 'potpie');
const POTPIE_NDJSON_PATH = join(import.meta.dir, '..', 'potpie-out', 'graph.ndjson');

if (!BABYLONJS_PATH) {
  console.error(
    '[runner] BABYLONJS_EVAL_PATH env var is not set. Point it at the BabylonJS checkout (e.g. scripts/eval/babylonjs).'
  );
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const useCache = args.has('--use-cache');
const skipOracle = args.has('--skip-oracle');
const skipVyazen = args.has('--skip-vyazen');
const skipGitnexus = args.has('--skip-gitnexus');
const skipGraphify = args.has('--skip-graphify');
const skipPotpie = args.has('--skip-potpie');

async function main(): Promise<void> {
  console.log('=== Code-Graph Eval Runner (v2 — type-checker oracle) ===');
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`BabylonJS: ${BABYLONJS_PATH}`);
  console.log(
    `Flags: useCache=${useCache} skipOracle=${skipOracle} skipVyazen=${skipVyazen} skipGitnexus=${skipGitnexus} skipGraphify=${skipGraphify} skipPotpie=${skipPotpie}`
  );
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
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    // F9: derive `scoreable` from the existing `targetLocalId` field — no
    // oracle re-run needed for this fix, see deriveScoreable's doc comment.
    const edges = deriveScoreable(
      readFileSync(join(DATA_DIR, 'oracle', 'oracle-edges.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    );
    oracle = {
      edges,
      symbols,
      resolvedCount: edges.filter((e: any) => e.targetLocalId).length,
      totalEdges: edges.length,
    };
    console.log(
      `[runner] Loaded oracle from cache: ${symbols.length} symbols, ${edges.length} edges (${oracle.resolvedCount} resolved)`
    );
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

  // ── 3b. Graphify ───────────────────────────────────────────────────────────
  let graphifyGraph: ToolGraph | null = null;
  if (!skipGraphify) {
    console.log('\n[runner] Phase: Graphify');
    try {
      graphifyGraph = await runGraphifyAdapter({
        outDir: join(DATA_DIR, 'graphify'),
        repoPath: BABYLONJS_PATH,
        useCache,
      });
    } catch (err) {
      console.error(`[runner] Graphify adapter failed: ${err}`);
    }
  }

  // ── 3c. Potpie ─────────────────────────────────────────────────────────────
  let potpieGraph: ToolGraph | null = null;
  if (!skipPotpie) {
    console.log('\n[runner] Phase: Potpie');
    try {
      potpieGraph = await runPotpieAdapter({
        ndjsonPath: POTPIE_NDJSON_PATH,
        outDir: join(DATA_DIR, 'potpie'),
        potpiePath: POTPIE_REPO_PATH,
        useCache,
      });
    } catch (err) {
      console.error(`[runner] Potpie adapter failed: ${err}`);
    }
  }

  // ── 4. Score ───────────────────────────────────────────────────────────────
  console.log('\n[runner] Phase: Scoring');
  const graphs: Record<string, ToolGraph> = {};
  if (vyazenGraph) {
    graphs.Vyazen = vyazenGraph;
  }
  if (gitnexusGraph) {
    graphs.GitNexus = gitnexusGraph;
  }
  if (graphifyGraph) {
    graphs.Graphify = graphifyGraph;
  }
  if (potpieGraph) {
    graphs.Potpie = potpieGraph;
  }

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
      if (n.path) {
        toolFilePaths.add(n.path);
      }
    }
  }
  const filteredOracleSymbols = oracle.symbols.filter((s: any) => toolFilePaths.has(s.path));
  // F11: filter directly on the edge's own path-qualified fromPath rather than
  // a last-writer-wins localId→path map, which silently mis-attributed edges
  // whose fromLocalId recurs across files (e.g. `_Registered`, `useStyles`).
  const filteredOracleEdges = oracle.edges.filter((e: any) => toolFilePaths.has(e.fromPath));
  console.log(
    `[runner] Oracle filtered: ${filteredOracleSymbols.length}/${oracle.symbols.length} symbols, ${filteredOracleEdges.length}/${oracle.edges.length} edges (files indexed by tools: ${toolFilePaths.size})`
  );

  const filterEdges = (g: ToolGraph): ToolGraph['edges'] =>
    g.edges.filter((e) => COMPARABLE_EDGE_TYPES.has(e.type) || EXT***REMOVED***ED_EDGE_TYPES.has(e.type));

  // F10: how much of the oracle's CALLS ground truth is oracle-certain
  // (symbol/signature resolution) vs. best-effort (property/union fan-out,
  // optional-chain retry) vs. still unresolved after every tier — so readers
  // can judge how much of "ground truth" to trust at face value.
  const resolutionTiers: Record<string, number> = {};
  for (const e of filteredOracleEdges) {
    if (e.type === 'CALLS' && e.resolutionTier) {
      resolutionTiers[e.resolutionTier] = (resolutionTiers[e.resolutionTier] ?? 0) + 1;
    }
  }

  const d2: Record<string, ReturnType<typeof scoreD2>> = {};
  const d1: Record<string, ReturnType<typeof scoreD1>> = {};
  for (const [name, graph] of Object.entries(graphs)) {
    console.log(`[runner] Scoring ${name}...`);
    const filteredEdges = filterEdges(graph);
    d2[name] = scoreD2(graph.nodes, filteredEdges, filteredOracleSymbols, filteredOracleEdges);
    d1[name] = scoreD1(
      graph.nodes,
      graph.edges,
      filteredOracleSymbols,
      filteredOracleEdges,
      name === 'Vyazen'
    );
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
      'GitNexus'
    );
  }
  if (vyazenGraph && graphifyGraph) {
    console.log('[runner] Computing cross-tool coverage (Vyazen → Graphify)...');
    coverage.Graphify = crossToolCoverage(
      vyazenGraph.nodes,
      vyazenGraph.edges,
      graphifyGraph.nodes,
      graphifyGraph.edges,
      'Graphify'
    );
  }
  if (vyazenGraph && potpieGraph) {
    console.log('[runner] Computing cross-tool coverage (Vyazen → Potpie)...');
    coverage.Potpie = crossToolCoverage(
      vyazenGraph.nodes,
      vyazenGraph.edges,
      potpieGraph.nodes,
      potpieGraph.edges,
      'Potpie'
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
      "**TypeScript is Vyazen's best case.**   A TS-only result overstates the general moat.",
      "**Oracle is type-checker-backed (v2).** The oracle uses the full TS compiler with TypeChecker — it can resolve specific call targets, inheritance, and imports. This is neutral: the type checker IS the language's semantics. If a heuristic tool's edge matches the type checker's resolution, it's a TP.",
      '**Target accuracy replaces "resolution rate".** Instead of comparing a boolean "resolved" (which meant different things per tool), we now measure: of the tool\'s TPs, what fraction point to the SAME target the type checker resolves to (by path + startLine ±2)? This is "does the edge point to the right code?"',
      "**Two-level IMPORTS scoring.** Level 1: module dependency (File→File) — both tools compete. Level 2: symbol-level (File→Symbol) — Vyazen advantage. GitNexus's 0 TP on symbol-level IMPORTS is a granularity difference, not a quality failure.",
      '**Extended edge types scored separately.** USES_TYPE (Vyazen), ACCESSES + METHOD_OVERRIDES (GitNexus) are scored per-tool against the oracle — each tool on what it produces.',
      '**`USES_TYPE` still excluded from head-to-head** — no GitNexus equivalent for the combined score.',
      '**Node identity matching** uses (path, name, startLine±2) per §5. Overloads resolved by nearest line. Anonymous/computed names skipped.',
      '**Single repo.** BabylonJS is one large, mature, TS-heavy codebase. Does not generalize to small repos, monorepos, or polyglot.',
      `**Graphify ran via the public \`graphify update\` command (v${process.env.GRAPHIFY_VERSION ?? '0.9.27'})** — deterministic tree-sitter extraction, no LLM. \`--mode deep\` (AST + semantic LLM) was deliberately not scored: its LLM-minted nodes aren't comparable to tree-sitter edges.`,
      "**Graphify's `graph.json` carries no symbol-kind field for TS/JS** (class/interface/enum/alias/property/variable are indistinguishable). Kind is reconstructed structurally (File / Method / Function via edge + label heuristics); everything else is `Unknown`. Since F2, `Unknown` nodes still get full credit for symbol identity (matched by path + name) in the node-fidelity tables above — they're excluded only from *kind-labelling accuracy* (a separate table), where they count as `unlabelled` rather than wrong or absent. See `adapters/graphify.adapter.ts` for the exact rule. `AMBIGUOUS` confidence was not observed in this run (0% per the tool's own report).",
      "**Graphify's `extends` relation is config-level (e.g. package.json `eslint.extends`), not class inheritance** — verified by sampling; real class/interface heritage is the `inherits` relation. The adapter maps `inherits`→EXT***REMOVED***S and excludes `extends`. Its `references` relation (generic identifier/property references) has no equivalent edge type in our ontology and is excluded, unlike GitNexus's ACCESSES.",
      '**Graphify `EXTRACTED` confidence ≠ target-verified.** Its TS/JS CALLS edges are bare-name matches with no scope, overload, or receiver-type resolution — `EXTRACTED` only means the reference was found, not that it was resolved with type-level certainty.',
      `**Potpie ran the production \`potpie-parse\` path at git SHA \`${potpieGraph?.meta.version ?? 'e643020'}\`** — not a PyPI release; the published \`potpie\` 2.0.0 wheel excludes \`parsing/\`/\`sandbox/\` (§7.1). The legacy Docker stack (Postgres/Neo4j/Redis/Hatchet) was deliberately not stood up: its Neo4j write is a 1:1 dump of this same payload with no resolution, enrichment, or inference (§2.2), so it would measure nothing this pass doesn't already measure.`,
      '**Potpie emits no CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS for TypeScript, by construction** — its tree-sitter tag query has no `call_expression` capture and no import/heritage capture for TS/JS (verified against a fixture, `POTPIE_EVAL_PLAN.md` §3). These are reported as explicit `0 claimed` rows, not blanks — a structural absence, not a parse failure.',
      "**Potpie's `REFERENCES` is scored as `USES_TYPE`**, single mapping, no charitable upper bound. The relation is built from type-annotation and `new`-expression references only (`tree-sitter-typescript-tags.scm`) — mapping it to CALLS would invent a call graph Potpie doesn't have.",
      '**Potpie has no Enum/Alias/Property/GlobalVariable/Namespace/Module in its ontology** — recall on those kinds is 0 by design, not a measurement gap. Interface/enum double-tagging, getter/setter, and overload collapse (first-definition-wins on `path:Class.name`) further deflate its node count relative to the oracle.',
      '**Potpie resolution is bare-name, no receiver-type or scope inference** — same-file definitions preferred, else edges to every cross-file definition sharing that name. Fan-out is real on common names (`constructor`/`this.constructor` hit 2,156 distinct targets from a single reference site on this run) — reported as a precision-context number, not smoothed over.',
      '**Potpie suppresses the reverse direction of a `REFERENCES` edge and has no `resolved`/`confidence` field** — `resolved`/`confidence` are recorded as `null`, never synthesized `true`; mutual type references between two interfaces are silently unrepresentable by design.',
      "**Potpie's LLM docstring/inference layer and temporal claim graph (`valid_at`/`invalid_at`) were not scored** — different ontology, out of scope for this AST-graph comparison.",
      "**Potpie's \"blast-radius / impact analysis\" (capability matrix) runs over LLM-agent-curated claims, not the deterministic AST graph scored here** — `InfraTopologyReader` (`context-engine/.../readers/infra_topology.py`) does bounded-depth `DEP***REMOVED***S_ON` traversal, but those claims are proposed/committed by an LLM harness, unlike GitNexus/Graphify/Vyazen's compiler- or heuristic-derived call graphs. **No incremental re-indexing** — `extract_graph`/`parser_runner` always does a full fresh parse; there's no file-hash/mtime-based changed-files-only path.",
    ],
    commitSha: COMMIT_SHA,
    coverage,
    d1,
    d2,
    d3: {
      // Measured manually via `/usr/bin/time -l` during this eval pass (2026-07-26/27) —
      // not reproduced automatically by this script. Re-measure if re-running D3.
      GitNexus: {
        indexSize:
          '1.04 GB (.gitnexus/, embeddings skipped — 86,920 nodes exceeds the 50k safety cap)',
        notes: '`gitnexus analyze --embeddings --force`',
        peakRss: '4.00 GiB',
        wallClock: '71.8s',
      },
      Graphify: {
        indexSize: '95.6 MB (graphify-out/graph.json)',
        notes: '`graphify update . --force`, 56,412 nodes / 163,985 raw edges, 1,941 communities',
        peakRss: '3.03 GiB',
        wallClock: '149.5s',
      },
      Potpie: {
        indexSize:
          '169 MiB (potpie-out/graph.ndjson, raw NDJSON — no persisted index; the payload is normally written straight to Neo4j as a 1:1 dump, §2.2)',
        notes:
          '`potpie-parse <babylonjs>`, 54,034 nodes / 182,139 raw edges (47,399 CONTAINS + 134,740 REFERENCES). Dramatically lighter than expected (§Phase 3 predicted a 3-4 GiB band matching GitNexus/Graphify) — Rust + rayon-parallel tree-sitter tagging with no scope/type resolution is simply a smaller workload than a resolved-edge or communities-clustering index.',
        peakRss: '1.03 GiB (maximum resident set size, `/usr/bin/time -l`)',
        wallClock: '8.1s',
      },
      Vyazen: {
        indexSize: '—',
        notes:
          'Live deployment, indexed prior to this eval pass — this run only performed a read-only Cypher export (minutes), not a fresh index build. Not comparable to a cold-start number.',
        peakRss: '—',
        wallClock: '—',
      },
    },
    d4,
    generatedAt: new Date().toISOString(),
    graphs,
    oracleResolvedRate: oracle.resolvedCount > 0 ? oracle.resolvedCount / oracle.totalEdges : 0,
    resolutionTiers,
  });

  const { writeFileSync } = await import('node:fs');
  const scorecardPath = join(import.meta.dir, '..', 'CODE_GRAPH_EVAL_SCORECARD.md');
  writeFileSync(scorecardPath, scorecard);
  console.log(`\n[runner] Scorecard written to ${scorecardPath}`);
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
