#!/usr/bin/env bun

/**
 * Code-Graph Eval Runner (v2) — type-checker oracle + target accuracy.
 *
 * Usage:
 *   bun run scripts/eval/code-graph/runner.ts                       # full run (babylonjs, default target)
 *   bun run scripts/eval/code-graph/runner.ts --target=vscode        # full run against vscode
 *   bun run scripts/eval/code-graph/runner.ts --use-cache            # reuse cached JSONL
 *   bun run scripts/eval/code-graph/runner.ts --skip-oracle          # skip oracle (use cache)
 *   bun run scripts/eval/code-graph/runner.ts --skip-gitnexus        # skip GitNexus dump
 *
 * Target selection: `--target=<name>` > `EVAL_TARGET` env var > 'babylonjs'.
 * Each target has its own repo checkout path, pinned commit, data-cache
 * directory and scorecard output file so a vscode run never clobbers a
 * babylonjs one.
 *
 * Produces CODE_GRAPH_EVAL_SCORECARD.md (babylonjs) or CODE_GRAPH_EVAL_SCORECARD_VSCODE.md (vscode).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runGitNexusAdapter } from './adapters/gitnexus.adapter';
import { runGraphifyAdapter } from './adapters/graphify.adapter';
import { runPotpieAdapter } from './adapters/potpie.adapter';
import { discoverProjects, walkRepoFiles } from './oracle/project-discovery';
import { deriveScoreable, runTypeCheckerOracle } from './oracle/ts-typechecker.oracle';
import { type D3PipelineCost, generateScorecard } from './report/scorecard.generator';
import { crossToolCoverage, scoreD1 } from './scorers/d1-depth.scorer';
import { scoreD2 } from './scorers/d2-fidelity.scorer';
import { scoreD4 } from './scorers/d4-capability.scorer';
import type { EdgeType, SymbolType, ToolGraph } from './types';
import { COMPARABLE_EDGE_TYPES, EXT***REMOVED***ED_EDGE_TYPES } from './types';

type EvalTargetName = 'babylonjs' | 'vscode';

interface RepoTargetConfig {
  /** Pinned commit SHA for this target. */
  commitSha: string;
  d3: Record<string, D3PipelineCost>;
  /** Cache subdirectory under code-graph/ — keeps two targets' caches from colliding. */
  dataDirName: string;
  /** Used only if none of `repoPathEnvVars` is set. */
  defaultRepoPath?: string;
  /** Appended after the target-agnostic caveats. */
  extraCaveats: string[];
  /** Name as registered with `gitnexus list` — required by `gitnexus cypher -r` once more than one repo is indexed. */
  gitnexusRepoName: string;
  /** Potpie NDJSON filename under scripts/eval/potpie-out/. */
  potpieNdjsonName: string;
  repoLabel: string;
  /** Filesystem env vars checked in order for the repo checkout path — generic name first, legacy name last. */
  repoPathEnvVars: string[];
  repoStats: string;
  /** Scorecard output filename under scripts/eval/. */
  scorecardFileName: string;
}

const REPO_TARGETS: Record<EvalTargetName, RepoTargetConfig> = {
  babylonjs: {
    commitSha: '4efc0490',
    repoPathEnvVars: ['EVAL_REPO_PATH', 'BABYLONJS_EVAL_PATH'],
    dataDirName: 'data',
    scorecardFileName: 'CODE_GRAPH_EVAL_SCORECARD.md',
    potpieNdjsonName: 'graph.ndjson',
    gitnexusRepoName: 'Babylon.js',
    repoLabel: 'BabylonJS/Babylon.js',
    repoStats: '~8,400 files, ~80,000 symbols',
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
    },
    extraCaveats: [],
  },
  vscode: {
    commitSha: '0102a4dbe6c84ca2f9bdd2e662a419ef07b491b3',
    repoPathEnvVars: ['EVAL_REPO_PATH', 'VSCODE_EVAL_PATH'],
    defaultRepoPath: join(import.meta.dir, '..', 'vscode'),
    dataDirName: 'data-vscode',
    scorecardFileName: 'CODE_GRAPH_EVAL_SCORECARD_VSCODE.md',
    potpieNdjsonName: 'vscode-graph.ndjson',
    gitnexusRepoName: 'vscode',
    repoLabel: 'microsoft/vscode',
    repoStats: '5,108 TS/JS files / 7,326 total files',
    d3: {
      // Measured directly against the pinned commit's checkout during Phase 3
      // — index sizes re-measured on disk 2026-07-31 (`du`), wall-clock/RSS
      // as recorded by each tool's own run.
      GitNexus: {
        indexSize:
          '1.36 GiB (.gitnexus/, embeddings skipped — 132,925 nodes exceeds the 50k safety cap, same as BabylonJS)',
        notes: '`gitnexus analyze --embeddings --force`; 132,925 nodes / 522,198 edges',
        peakRss: '5.57 GiB',
        wallClock: '146.3s',
      },
      Graphify: {
        indexSize: '186 MiB (graphify-out/graph.json)',
        notes:
          '`graphify update . --force`, `GRAPHIFY_MAX_GRAPH_BYTES=2147483648` (precautionary — actual output well under even the default 512 MiB cap); 94,260 nodes / 338,945 raw edges',
        peakRss: '3.93 GiB',
        wallClock: '140.3s',
      },
      Potpie: {
        indexSize:
          '436 MiB (potpie-out/vscode-graph.ndjson, raw NDJSON — no persisted index; written straight to Neo4j as a 1:1 dump in the legacy stack, §2.2)',
        notes:
          '`potpie-parse vscode` via the existing scripts/eval/potpie/.venv (no cargo rebuild needed — potpie-parse was already installed from the BabylonJS setup); 85,658 nodes / 320,001 raw edges',
        peakRss: '1.74 GiB',
        wallClock: '6.8s',
      },
    },
    extraCaveats: [],
  },
};

const argv = process.argv.slice(2);
const args = new Set(argv);
const useCache = args.has('--use-cache');
const skipOracle = args.has('--skip-oracle');
const skipGitnexus = args.has('--skip-gitnexus');
const skipGraphify = args.has('--skip-graphify');
const skipPotpie = args.has('--skip-potpie');

const TARGET_NAME: EvalTargetName = (() => {
  const fromArg = argv.find((a) => a.startsWith('--target='))?.split('=')[1];
  const name = fromArg ?? process.env.EVAL_TARGET ?? 'babylonjs';
  if (name !== 'babylonjs' && name !== 'vscode') {
    console.error(`[runner] Unknown --target "${name}" — expected one of: babylonjs, vscode`);
    process.exit(1);
  }
  return name as EvalTargetName;
})();

const TARGET_CONFIG = REPO_TARGETS[TARGET_NAME];
const DATA_DIR = join(import.meta.dir, TARGET_CONFIG.dataDirName);
const REPO_PATH_MAYBE =
  TARGET_CONFIG.repoPathEnvVars.map((v) => process.env[v]).find(Boolean) ??
  TARGET_CONFIG.defaultRepoPath;
const COMMIT_SHA_OVERRIDE = argv.find((a) => a.startsWith('--commit-sha='))?.split('=')[1];
const COMMIT_SHA = COMMIT_SHA_OVERRIDE ?? TARGET_CONFIG.commitSha;
const POTPIE_REPO_PATH = join(import.meta.dir, '..', 'potpie');
const POTPIE_NDJSON_PATH = join(
  import.meta.dir,
  '..',
  'potpie-out',
  TARGET_CONFIG.potpieNdjsonName
);

if (!REPO_PATH_MAYBE) {
  console.error(
    `[runner] No repo path set for target "${TARGET_NAME}" — set ${TARGET_CONFIG.repoPathEnvVars[0]} ` +
      `(or one of: ${TARGET_CONFIG.repoPathEnvVars.slice(1).join(', ')}).`
  );
  process.exit(1);
}
const REPO_PATH: string = REPO_PATH_MAYBE;

async function main(): Promise<void> {
  console.log('=== Code-Graph Eval Runner (v2 — type-checker oracle) ===');
  console.log(`Target: ${TARGET_NAME} (commit ${COMMIT_SHA})`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Repo: ${REPO_PATH}`);
  console.log(
    `Flags: useCache=${useCache} skipOracle=${skipOracle} skipGitnexus=${skipGitnexus} skipGraphify=${skipGraphify} skipPotpie=${skipPotpie}`
  );
  console.log('');

  // ── 1. Oracle (type-checker-backed) ────────────────────────────────────────
  let oracle;
  if (skipOracle) {
    console.log('[runner] Skipping oracle (assumed cached)');
  } else {
    console.log('[runner] Phase: Type-checker oracle');
    oracle = await runTypeCheckerOracle({
      repoPath: REPO_PATH,
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

  // ── 2. GitNexus ────────────────────────────────────────────────────────────
  let gitnexusGraph: ToolGraph | null = null;
  if (!skipGitnexus) {
    console.log('\n[runner] Phase: GitNexus');
    try {
      gitnexusGraph = await runGitNexusAdapter({
        outDir: join(DATA_DIR, 'gitnexus'),
        repoPath: REPO_PATH,
        repoName: TARGET_CONFIG.gitnexusRepoName,
        useCache,
      });
    } catch (err) {
      console.error(`[runner] GitNexus adapter failed: ${err}`);
    }
  }

  // ── 2b. Graphify ───────────────────────────────────────────────────────────
  let graphifyGraph: ToolGraph | null = null;
  if (!skipGraphify) {
    console.log('\n[runner] Phase: Graphify');
    try {
      graphifyGraph = await runGraphifyAdapter({
        outDir: join(DATA_DIR, 'graphify'),
        repoPath: REPO_PATH,
        useCache,
      });
    } catch (err) {
      console.error(`[runner] Graphify adapter failed: ${err}`);
    }
  }

  // ── 2c. Potpie ─────────────────────────────────────────────────────────────
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
    // Data-driven: compute the resolved-edge slice iff this tool's graph
    // actually emits `resolved: true` edges (not gated on a hardcoded name).
    const includeResolvedSlice = graph.edges.some((e) => e.resolved === true);
    d1[name] = scoreD1(
      graph.nodes,
      graph.edges,
      filteredOracleSymbols,
      filteredOracleEdges,
      includeResolvedSlice
    );
  }

  // Cross-tool coverage — pairwise over the tools present, using each tool
  // that emits resolved edges as the "reference" tool. Measures raw coverage
  // of the reference tool's resolved edges by every other tool.
  const coverage: Record<string, ReturnType<typeof crossToolCoverage>> = {};
  const referenceTools = Object.entries(graphs).filter(([, g]) =>
    g.edges.some((e) => e.resolved === true)
  );
  const otherTools = Object.entries(graphs);
  for (const [refName, refGraph] of referenceTools) {
    for (const [otherName, otherGraph] of otherTools) {
      if (otherName === refName) {
        continue;
      }
      console.log(`[runner] Computing cross-tool coverage (${refName} → ${otherName})...`);
      coverage[`${refName}→${otherName}`] = crossToolCoverage(
        refGraph.nodes,
        refGraph.edges,
        otherGraph.nodes,
        otherGraph.edges,
        otherName
      );
    }
  }

  // D4 capability matrix — include extended edge types
  const observedKinds: Record<string, Set<SymbolType>> = {};
  const observedEdgeTypes: Record<string, Set<EdgeType>> = {};
  for (const [name, graph] of Object.entries(graphs)) {
    observedKinds[name] = new Set(graph.nodes.map((n) => n.kind));
    observedEdgeTypes[name] = new Set(graph.edges.map((e) => e.type));
  }

  // Each shipped adapter declares its extra capabilities (opt-in qualitative
  // rows). Tools that declare nothing still get the data-driven
  // ontology/edge-type coverage tables.
  const DECLARED_CAPABILITIES: Record<string, string[]> = {
    GitNexus: [
      'Leiden community clustering',
      'Process tracing (execution flow nodes)',
      'BM25 + semantic hybrid search',
      'Code embeddings (vector search)',
      'Incremental re-indexing',
      'Blast-radius / impact analysis',
      'METHOD_OVERRIDES edges',
      'ACCESSES edges (property access tracking)',
      'Emits call edges for TS at all',
      'Symbol kinds beyond FILE/CLASS/INTERFACE/FUNCTION',
    ],
    Graphify: [
      'Leiden community clustering',
      'Incremental re-indexing',
      'Blast-radius / impact analysis',
      'Generic identifier/property reference edges (references, not scored)',
      'Emits call edges for TS at all',
      'LLM docstring/inference layer (not scored)',
    ],
    Potpie: [
      'USES_TYPE edges (type usage tracking)',
      'BM25 + semantic hybrid search',
      'Code embeddings (vector search)',
      'Blast-radius / impact analysis',
      'Qdrant hybrid dense+BM25+ColBERT search',
      'Temporal claim graph (valid_at/invalid_at)',
      'LLM docstring/inference layer (not scored)',
    ],
  };

  // Drift guard: warn if a tool declares an edge-type capability but emits
  // zero matching edges, or vice versa.
  for (const [name, caps] of Object.entries(DECLARED_CAPABILITIES)) {
    if (!graphs[name]) {
      continue;
    }
    const observed = observedEdgeTypes[name];
    for (const cap of caps) {
      for (const et of ['CALLS', 'USES_TYPE', 'METHOD_OVERRIDES', 'ACCESSES'] as EdgeType[]) {
        if (cap.includes(et) && !observed.has(et)) {
          console.warn(
            `[runner] Drift: ${name} declares "${cap}" but emits zero ${et} edges`
          );
        }
      }
    }
  }

  const d4 = scoreD4(observedKinds, observedEdgeTypes, Object.keys(graphs), DECLARED_CAPABILITIES);

  // ── 5. Generate scorecard ──────────────────────────────────────────────────
  console.log('\n[runner] Phase: Scorecard generation');

  // §4/Appendix A: replaces the old hardcoded "Single repo" claim, which was
  // factually wrong even for BabylonJS (83 package.jsons; it worked because
  // one root tsconfig's globs happened to cover the whole tree). Computed from
  // this run's own project discovery — cheap (filesystem walk only, no
  // ts.Program) — rather than a target-specific literal that drifts from
  // whatever the oracle actually saw.
  const oracleFiles = walkRepoFiles(REPO_PATH);
  const oracleProjects = discoverProjects(oracleFiles);
  const oracleProjectsWithTsconfig = oracleProjects.filter((p) => p.tsconfigPath).length;
  const monorepoCaveat =
    `**${oracleProjects.length} project(s) detected** by the oracle's project-discovery rules — ` +
    'one per `package.json` (TS-capable iff a `tsconfig*.json` sits alongside it), plus, since F17, one per ' +
    "`tsconfig*.json` directory that has **no** adjacent `package.json` (e.g. this repo's `src/`, whose " +
    '`src/tsconfig.json` sets `baseUrl`/`paths`/`module: amd`) — ' +
    `${oracleProjectsWithTsconfig} with their own tsconfig, ${oracleProjects.length - oracleProjectsWithTsconfig} ` +
    'falling back to inferred compiler options. Each project is analyzed by its own `ts.Program`. ' +
    'The oracle\'s job is the language\'s real semantics, not a copy of whatever detection gap a tool under ' +
    "test happens to have — before F17: 94.3% of oracle IMPORTS rows had no resolvable target; after: 4.6%, " +
    "in line with BabylonJS's 11.3%.";

  const scorecard = generateScorecard({
    caveats: [
      "**TypeScript is a resolved-edge tool's best case.**   A TS-only result overstates the general advantage for resolved-edge tools.",
      "**Oracle is type-checker-backed (v2).** The oracle uses the full TS compiler with TypeChecker — it can resolve specific call targets, inheritance, and imports. This is neutral: the type checker IS the language's semantics. If a heuristic tool's edge matches the type checker's resolution, it's a TP.",
      '**Target accuracy replaces "resolution rate".** Instead of comparing a boolean "resolved" (which meant different things per tool), we now measure: of the tool\'s TPs, what fraction point to the SAME target the type checker resolves to (by path + startLine ±2)? This is "does the edge point to the right code?"',
      "**Two-level IMPORTS scoring.** Level 1: module dependency (File→File) — all tools compete. Level 2: symbol-level (File→Symbol) — an advantage for tools that model imports at symbol granularity. GitNexus's 0 TP on symbol-level IMPORTS is a granularity difference, not a quality failure.",
      '**Extended edge types scored separately.** USES_TYPE, ACCESSES + METHOD_OVERRIDES are scored per-tool against the oracle — each tool on what it produces.',
      '**`USES_TYPE` still excluded from head-to-head** — not all tools emit it for the combined score.',
      '**Node identity matching** uses (path, name, startLine±2). Overloads resolved by nearest line. Anonymous/computed names skipped.',
      monorepoCaveat,
      "**File ownership: deepest matching project owns a file.** The oracle assigns each file to the project with the longest `rootPath` prefix match, so every symbol/edge is emitted exactly once — asserted at runtime; a file walked by more than one project throws rather than silently duplicating. This is a deliberate divergence from a tool's own overlapping prefix scoping: the oracle has a ground-truth uniqueness requirement a per-project graph-write step doesn't.",
      "**`.d.ts` edge-fidelity asymmetry.** The oracle's F3 policy includes declaration files in edge extraction; a resolved-edge tool's edge resolver may skip them outright. Node-fidelity is unaffected — AST-based tools still emit `.d.ts` nodes tools can match — but the oracle can hold `.d.ts`-sourced edges no tool's resolution stage had a chance to produce. Larger on repos that ship more declaration files.",
      `**Graphify ran via the public \`graphify update\` command (v${process.env.GRAPHIFY_VERSION ?? '0.9.27'})** — deterministic tree-sitter extraction, no LLM. \`--mode deep\` (AST + semantic LLM) was deliberately not scored: its LLM-minted nodes aren't comparable to tree-sitter edges.`,
      "**Graphify's `graph.json` carries no symbol-kind field for TS/JS** (class/interface/enum/alias/property/variable are indistinguishable). Kind is reconstructed structurally (File / Method / Function via edge + label heuristics); everything else is `Unknown`. Since F2, `Unknown` nodes still get full credit for symbol identity (matched by path + name) in the node-fidelity tables above — they're excluded only from *kind-labelling accuracy* (a separate table), where they count as `unlabelled` rather than wrong or absent. See `adapters/graphify.adapter.ts` for the exact rule. `AMBIGUOUS` confidence was not observed in this run (0% per the tool's own report).",
      "**Graphify's `extends` relation is config-level (e.g. package.json `eslint.extends`), not class inheritance** — verified by sampling; real class/interface heritage is the `inherits` relation. The adapter maps `inherits`→EXT***REMOVED***S and excludes `extends`. Its `references` relation (generic identifier/property references) has no equivalent edge type in our ontology and is excluded, unlike GitNexus's ACCESSES.",
      '**Graphify `EXTRACTED` confidence ≠ target-verified.** Its TS/JS CALLS edges are bare-name matches with no scope, overload, or receiver-type resolution — `EXTRACTED` only means the reference was found, not that it was resolved with type-level certainty.',
      `**Potpie ran the production \`potpie-parse\` path at git SHA \`${potpieGraph?.meta.version ?? 'e643020'}\`** — not a PyPI release; the published \`potpie\` 2.0.0 wheel excludes \`parsing/\`/\`sandbox/\` (§7.1). The legacy Docker stack (Postgres/Neo4j/Redis/Hatchet) was deliberately not stood up: its Neo4j write is a 1:1 dump of this same payload with no resolution, enrichment, or inference (§2.2), so it would measure nothing this pass doesn't already measure.`,
      '**Potpie emits no CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS for TypeScript, by construction** — its tree-sitter tag query has no `call_expression` capture and no import/heritage capture for TS/JS (verified against a fixture). These are reported as explicit `0 claimed` rows, not blanks — a structural absence, not a parse failure.',
      "**Potpie's `REFERENCES` is scored as `USES_TYPE`**, single mapping, no charitable upper bound. The relation is built from type-annotation and `new`-expression references only (`tree-sitter-typescript-tags.scm`) — mapping it to CALLS would invent a call graph Potpie doesn't have.",
      '**Potpie has no Enum/Alias/Property/GlobalVariable/Namespace/Module in its ontology** — recall on those kinds is 0 by design, not a measurement gap. Interface/enum double-tagging, getter/setter, and overload collapse (first-definition-wins on `path:Class.name`) further deflate its node count relative to the oracle.',
      '**Potpie resolution is bare-name, no receiver-type or scope inference** — same-file definitions preferred, else edges to every cross-file definition sharing that name. Fan-out is real on common names (`constructor`/`this.constructor` hit 2,156 distinct targets from a single reference site on this run) — reported as a precision-context number, not smoothed over.',
      '**Potpie suppresses the reverse direction of a `REFERENCES` edge and has no `resolved`/`confidence` field** — `resolved`/`confidence` are recorded as `null`, never synthesized `true`; mutual type references between two interfaces are silently unrepresentable by design.',
      "**Potpie's LLM docstring/inference layer and temporal claim graph (`valid_at`/`invalid_at`) were not scored** — different ontology, out of scope for this AST-graph comparison.",
      "**Potpie's \"blast-radius / impact analysis\" (capability matrix) runs over LLM-agent-curated claims, not the deterministic AST graph scored here** — `InfraTopologyReader` (`context-engine/.../readers/infra_topology.py`) does bounded-depth `DEP***REMOVED***S_ON` traversal, but those claims are proposed/committed by an LLM harness, unlike GitNexus/Graphify's heuristic-derived call graphs. **No incremental re-indexing** — `extract_graph`/`parser_runner` always does a full fresh parse; there's no file-hash/mtime-based changed-files-only path.",
      ...TARGET_CONFIG.extraCaveats,
    ],
    commitSha: COMMIT_SHA,
    coverage,
    d1,
    d2,
    d3: TARGET_CONFIG.d3,
    d4,
    generatedAt: new Date().toISOString(),
    graphs,
    oracleResolvedRate: oracle.resolvedCount > 0 ? oracle.resolvedCount / oracle.totalEdges : 0,
    repoLabel: TARGET_CONFIG.repoLabel,
    repoStats: TARGET_CONFIG.repoStats,
    resolutionTiers,
  });

  const { writeFileSync } = await import('node:fs');
  const scorecardPath = join(import.meta.dir, '..', TARGET_CONFIG.scorecardFileName);
  writeFileSync(scorecardPath, scorecard);
  console.log(`\n[runner] Scorecard written to ${scorecardPath}`);
  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
