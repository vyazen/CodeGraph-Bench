# CodeGraph-Bench

A **code knowledge graph benchmark** — how well do different code-indexing tools build a graph of a real codebase, and how does the graph hold up against ground truth?

The code knowledge graph is a structured representation of a repo where **nodes** are code symbols (classes, methods, functions, properties) and **edges** are relationships between them (calls, imports, inheritance, type usage). A better graph means AI agents that answer questions about the codebase — "what calls this?", "what implements that interface?", "what type does this return?" — get more accurate answers.

## What gets measured

Four tools index the **same pinned commit** of the same repo, each is run through an adapter that normalizes its output into a common graph schema, and every tool's graph is scored against the same oracle:

| Tool | Approach |
|------|----------|
| **Vyazen** | TypeScript-resolved-edge semantic linking (edge resolution `resolved: true`) |
| **GitNexus** | LadybugDB (Kùzu) index via `gitnexus analyze` — heuristic extraction + Leiden communities |
| **Graphify** | Deterministic tree-sitter extraction via `graphify update` — no LLM |
| **Potpie** | Rust + rayon tree-sitter tagging via `potpie-parse` — no type/scope resolution |

### The oracle (ground truth)

The oracle is the **TypeScript compiler with full type checking** (`ts.TypeChecker`) — it can resolve which specific method a call targets, which class is extended, which symbol is imported, which type a property uses. It is the language's own semantics, neutral and favoring no tool. Where the compiler itself cannot resolve a target (external/builtin packages, genuinely dynamic dispatch), those rows are excluded from scoring as **unscoreable** rather than counted against any tool.

### The metrics (D1–D4)

- **D1 — Depth moat:** of Vyazen's compiler-*resolved* edges, how many the oracle confirms, and how many point to the *exact* target the type checker resolves to.
- **D2 — Fidelity:** per symbol kind and edge type, precision / recall / F1 against the oracle, plus **target accuracy** — of a tool's correct edges, what fraction point to the *right* code (same file + line), not just *some* code with the right name.
- **D3 — Pipeline cost:** wall-clock, peak RSS, and on-disk index size to build each tool's index (`/usr/bin/time -l`).
- **D4 — Capability envelope:** what each tool can do at all — symbol kinds, edge types, incremental indexing, vector search, etc.

Scoring correctness safeguards: node identity is matched by `(path, name, startLine ± 2)`; self-loop `resolved: false` edges are **abstentions**, not assertions; `n/a — not emitted` / `n/a — granularity` / `n/a — no oracle` distinguish "tool doesn't claim this" from "tool claimed and failed" (see the scorecards' F-numbered notes).

## Repos benchmarked

Two very different targets, run separately so one never clobbers the other (separate data dirs and scorecard files):

| Target | Repo | Notes |
|--------|------|-------|
| `babylonjs` (default) | BabylonJS/Babylon.js @ `4efc0490` | Single monorepo game engine, ~8,400 files, ~80,000 symbols |
| `vscode` | microsoft/vscode @ `0102a4dbe` | 84 independent TS projects, 5,108 TS/JS files / 7,326 total files |

## Highlights — BabylonJS

Headline numbers (oracle resolves 74.1% of edges; **target accuracy** = does the edge land on the exact code the type checker resolves to):

| Tool | Nodes | Edges (asserted) | Node F1 | Edge F1 | CALLS precision | CALLS recall | CALLS target accuracy |
|------|------:|------------------:|--------:|--------:|----------------:|-------------:|----------------------:|
| **Vyazen** | 79,324 | 120,815 | **98.7%** | **84.7%** | **84.9%** | **74.6%** | **99.8%** |
| GitNexus | 80,773 | 259,345 | 80.4% | 42.8% | 46.7% | 60.0% | 96.9% |
| Graphify | 56,412 | 133,845 | 60.1% | 67.3% | 68.1% | 33.8% | 96.4% |
| Potpie | 54,034 | 134,740 | 57.1% | 0.0% | n/a — not emitted | 0.0% | — |

- **Vyazen resolved slice:** 47,046 resolved CALLS → 84.8% oracle-confirmed, 84.6% exact-target; 33,141 resolved IMPORTS → 84.8% / 84.8%; EXT***REMOVED***S 97.0% / 97.0%.
- **Cross-tool coverage of Vyazen's resolved CALLS:** GitNexus 57.0%, Graphify 40.3%, Potpie 0% (Potpie emits no TS call edges at all).
- **Head-to-head:** Vyazen CALLS precision 84.9% vs GitNexus 46.7% / Graphify 68.1%, at recall 74.6% vs 60.0% / 33.8%. Graphify wins IMPORTS module-level recall (98.6% vs Vyazen 88.2%).
- **D3 cost (BabylonJS):** Vyazen not re-measured (live deployment); GitNexus 71.8s / 4.00 GiB / 1.04 GB; Graphify 149.5s / 3.03 GiB / 95.6 MB; Potpie 8.1s / 1.03 GiB / 169 MiB.

## Highlights — VS Code

Headline numbers (oracle resolves 80.7% of edges):

| Tool | Nodes | Edges (asserted) | Node F1 | Edge F1 | CALLS precision | CALLS recall | CALLS target accuracy |
|------|------:|------------------:|--------:|--------:|----------------:|-------------:|----------------------:|
| **Vyazen** | 155,531 | 332,624 | **94.4%** | **86.6%** | **92.2%** | **79.1%** | **99.8%** |
| GitNexus | 124,956 | 361,198 | 73.0% | 36.5% | 44.0% | 44.7% | 94.2% |
| Graphify | 94,260 | 280,370 | 68.6% | 67.0% | 84.7% | 36.4% | 93.4% |
| Potpie | 85,658 | 241,724 | 67.5% | 0.0% | n/a — not emitted | 0.0% | — |

- **Vyazen resolved slice:** 125,598 resolved CALLS → 92.2% oracle-confirmed, 92.0% exact-target; IMPORTS 81.2% / 81.2%; EXT***REMOVED***S 99.9% / 99.9%.
- **Cross-tool coverage of Vyazen's resolved CALLS:** GitNexus 46.4%, Graphify 44.1%, Potpie 0%.
- **Head-to-head:** Vyazen CALLS precision 92.2% vs GitNexus 44.0% / Graphify 84.7%, at recall 79.1% vs 44.7% / 36.4%. Vyazen's overall edge target accuracy is 99.9%.
- **This target drove a Vyazen fix:** vscode's many per-project tsconfigs (including `src/tsconfig.json` with no adjacent `package.json`) used to break both the oracle's and Vyazen's project detection (V1/V2). Fixed at the source — resolution went IMPORTS 5.4%→97.1%, CALLS 25.6%→72.5%, EXT***REMOVED***S 30.7%→72.4%, IMPLEMENTS 29.1%→98.5%, USES_TYPE 33.4%→87.4%.
- **D3 cost (vscode):** Vyazen 69.9s / 2.37 GiB (local cold-build); GitNexus 146.3s / 5.57 GiB / 1.36 GB; Graphify 140.3s / 3.93 GiB / 186 MiB; Potpie 6.8s / 1.74 GiB / 436 MiB.

## The takeaway, in one line

Vyazen is the only tool with **edge resolution**: it finds far more real relationships than its nearest competitor while landing essentially every edge on the exact code the type checker resolves to (99.8% target accuracy), at a build cost comparable to or better than the others. The honest caveats are in every scorecard — TypeScript is Vyazen's best case, the oracle is the language's own semantics, and Graphify/Potpie are deliberately LLM-free in what's scored here.

## Layout

```
scripts/eval/
  code-graph/
    runner.ts                 # the eval: oracle → tools → score → scorecard
    adapters/                 # per-tool normalization (vyazen, gitnexus, graphify, potpie)
    oracle/                   # TS-compiler oracle (project discovery, type-checker)
    scorers/                  # D1 depth, D2 fidelity, D4 capability
    matching/                 # node identity matcher + edge adjudication
    report/scorecard.generator.ts
    data/                     # babylonjs run cache (nodes/edges JSONL per tool + oracle)
    data-vscode/              # vscode run cache
  babylonjs/  vscode/         # pinned repo checkouts (gitignored)
  gitnexus/  potpie/  potpie-out/  # tool checkouts / outputs (gitignored)
```

The scorecards are generated artifacts and deliberately **not committed** — regenerate with:

```bash
# babylonjs (default target)
bun run scripts/eval/code-graph/runner.ts --use-cache --skip-oracle
# vscode
bun run scripts/eval/code-graph/runner.ts --use-cache --skip-oracle --target=vscode
```

Cache lives in `data/` / `data-vscode/` so both scorecards reproduce offline. A full fresh run (dropping `--use-cache`) re-invokes each tool; the `--skip-*` flags skip individual tool phases.
