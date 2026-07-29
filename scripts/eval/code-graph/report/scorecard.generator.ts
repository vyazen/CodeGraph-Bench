/**
 * Scorecard generator (v2) — type-checker oracle + target accuracy.
 *
 * Every metric includes a plain-English explanation. New in v2:
 * - Target accuracy (replaces "resolution rate")
 * - Two-level IMPORTS (module-level + symbol-level)
 * - Extended edge types (USES_TYPE, ACCESSES, METHOD_OVERRIDES)
 * - Oracle resolved rate (how much of the oracle is type-checker-confirmed)
 */

import type { D1Report } from '../scorers/d1-depth.scorer';
import type { D2Report } from '../scorers/d2-fidelity.scorer';
import type { D4Report } from '../scorers/d4-capability.scorer';
import type { ToolGraph } from '../types';

export interface D3PipelineCost {
  /** On-disk index size, e.g. "1.04 GB (.gitnexus/)". */
  indexSize: string;
  notes?: string;
  /** e.g. "4.0 GiB". */
  peakRss: string;
  /** e.g. "71.8s (`/usr/bin/time -l gitnexus analyze --embeddings --force`)". */
  wallClock: string;
}

export interface ScorecardInput {
  caveats: string[];
  commitSha: string;
  coverage?: Record<
    string,
    ReturnType<typeof import('../scorers/d1-depth.scorer').crossToolCoverage>
  >;
  d1: Record<string, D1Report>;
  d2: Record<string, D2Report>;
  /** D3 — pipeline cost (wall-clock/RSS/disk), measured manually per CODE_GRAPH_EVAL_PLAN.md §D3. */
  d3?: Record<string, D3PipelineCost>;
  d4: D4Report;
  generatedAt: string;
  graphs: Record<string, ToolGraph>;
  /** Fraction of oracle edges with type-checker-resolved targets. */
  oracleResolvedRate?: number;
  /** F10 — oracle CALLS counts by resolution tier (symbol/signature/property/optional-chain-stripped/unresolved). */
  resolutionTiers?: Record<string, number>;
}

const pct = (n: number): string => (n == null ? '—' : `${(n * 100).toFixed(1)}%`);
const num = (n: number): string => (n == null ? '—' : n.toLocaleString());

/**
 * F13 — a cell must never read `0.0%` when the honest answer is "not
 * measured". Two independent conditions make a metric unmeasurable rather
 * than a real zero:
 * - **No oracle** (`tp + fn === 0`): the oracle has zero ground-truth rows of
 *   this type, so ANY tool claim is mathematically forced to precision 0% —
 *   that's a fact about the oracle, not the tool (the exact "0 TP / N FP / 0
 *   FN by construction" bug GitNexus's pre-F7 METHOD_OVERRIDES row had).
 *   Takes priority: if there's no oracle, nothing here is measurable at all.
 * - **Not emitted** (`tp + fp === 0`): the tool made zero claims of this
 *   type. Precision (a fact about claims) is undefined, not zero. Recall is
 *   NOT affected by this — "found 0 of N real relationships" is a genuine,
 *   informative measurement, not a missing one.
 */
function hasNoOracle(m: { fn: number; tp: number }): boolean {
  return m.tp + m.fn === 0;
}
function notEmitted(m: { fp: number; tp: number }): boolean {
  return m.tp + m.fp === 0;
}
function fmtPrecision(m: { fn: number; fp: number; tp: number }): string {
  if (hasNoOracle(m)) {
    return 'n/a — no oracle';
  }
  return notEmitted(m) ? 'n/a — not emitted' : pct(m.tp / (m.tp + m.fp));
}
function fmtRecall(m: { fn: number; tp: number }): string {
  return hasNoOracle(m) ? 'n/a — no oracle' : pct(m.tp / (m.tp + m.fn));
}
function fmtF1(m: { f1: number; fn: number; fp: number; tp: number }): string {
  if (hasNoOracle(m)) {
    return 'n/a — no oracle';
  }
  return notEmitted(m) ? 'n/a — not emitted' : pct(m.f1);
}

/**
 * F13 — the two remaining `n/a` cases beyond precision/recall/F1:
 * - **granularity**: a tool that only models IMPORTS at File→File can never
 *   produce a symbol-level edge; its `0.0%`/`not emitted` here would
 *   conflate "doesn't compete at this level" with "competed and lost" — the
 *   granularity is already scored fairly in the module-level table.
 * - **kind unlabelled**: a tool whose matched symbols of a kind are 100%
 *   `Unknown` (never correct, never mislabelled) reads `0.0%` accuracy the
 *   same as a tool that confidently mislabels every one — those are not the
 *   same failure.
 */
function fmtGranularityAware(cell: string, onlyFileGranularity: boolean | undefined): string {
  return onlyFileGranularity ? 'n/a — granularity' : cell;
}

/**
 * F13 — "publish the ceiling next to every recall figure": recall is already
 * computed over the scoreable-only denominator (F9), so it can't be improved
 * by fixing the oracle further. The ceiling answers a different question —
 * "what's the most any tool could ever score against the RAW oracle count
 * for this type, before F9 excluded the unscoreable rows?" — which is what
 * lets a reader judge how much of the gap to a hypothetical 100% is real vs.
 * an artifact of an oracle row nothing built from this repo could ever name.
 */
function fmtRecallWithCeiling(m: { fn: number; tp: number; unscoreableExcluded?: number }): string {
  const recall = fmtRecall(m);
  const unscoreable = m.unscoreableExcluded ?? 0;
  if (recall.startsWith('n/a') || unscoreable === 0) {
    return recall;
  }
  const rawTotal = m.tp + m.fn + unscoreable;
  const ceiling = rawTotal === 0 ? 0 : (m.tp + m.fn) / rawTotal;
  return `${recall} (ceiling ${pct(ceiling)})`;
}
function fmtKindLabelAccuracy(kl: { correct: number; mislabelled: number; total: number }): string {
  if (kl.total === 0) {
    return '—';
  }
  return kl.correct === 0 && kl.mislabelled === 0
    ? 'n/a — kind unlabelled'
    : pct(kl.correct / kl.total);
}

/** Grammatical list join: "A", "A and B", "A, B and C" — not "A and B and C". */
function listJoin(items: string[]): string {
  if (items.length <= 1) {
    return items.join('');
  }
  if (items.length === 2) {
    return items.join(' and ');
  }
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

export function generateScorecard(input: ScorecardInput): string {
  const toolNames = Object.keys(input.d2);
  const lines: string[] = [];

  // ── Title + reader's guide ──────────────────────────────────────────────────
  lines.push('# Code-Graph Eval — Scorecard (v2)');
  lines.push('');
  lines.push(
    `_Generated ${input.generatedAt} · repo: BabylonJS/Babylon.js @ \`${input.commitSha}\` · tools: ${toolNames.join(', ')} · oracle: **type-checker-backed**_`
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## How to read this scorecard');
  lines.push('');
  lines.push(
    'This document compares how well different code-indexing tools build a **code knowledge graph** — a structured representation of a codebase where nodes are code symbols (classes, methods, functions) and edges are relationships between them (calls, imports, inheritance). A better graph means AI agents get more accurate answers about the codebase.'
  );
  lines.push('');
  lines.push('### The setup');
  lines.push('');
  lines.push(
    '- **Repo:** BabylonJS/Babylon.js — a large TypeScript codebase (~8,400 files, ~80,000 symbols). All tools indexed the same commit.'
  );
  lines.push(
    "- **The oracle (ground truth):** The TypeScript compiler **with type checking**. Unlike a parse-only oracle, this can resolve which specific method a call targets, which class is extended, which symbol is imported. It is the language's own semantics — neutral, not favoring any tool."
  );
  if (input.oracleResolvedRate !== undefined) {
    lines.push(
      `- **Oracle resolution:** ${pct(input.oracleResolvedRate)} of oracle edges have type-checker-resolved targets (the rest are dynamic/external calls the compiler couldn't resolve).`
    );
  }
  lines.push(`- **Tools:** ${listJoin(toolNames.map((t) => `**${t}**`))}.`);
  lines.push('');
  lines.push('### Key terms');
  lines.push('');
  lines.push('| Term | Meaning |');
  lines.push('|------|---------|');
  lines.push('| **Node** | A code symbol (class, method, function, property). |');
  lines.push('| **Edge** | A relationship between two nodes (A calls B, C extends D). |');
  lines.push(
    "| **Oracle** | Ground truth from the TS type checker. Neither tool's graph is the oracle. |"
  );
  lines.push('| **TP** | True Positive — tool found something the oracle confirms. ✅ |');
  lines.push("| **FP** | False Positive — tool claims something the oracle doesn't confirm. ❌ |");
  lines.push('| **FN** | False Negative — oracle has it, tool missed it. ⚠️ |');
  lines.push(
    '| **Precision** | `TP / (TP + FP)` — of what the tool claims, how much is correct. |'
  );
  lines.push('| **Recall** | `TP / (TP + FN)` — of what exists, how much the tool found. |');
  lines.push('| **F1** | Harmonic mean of precision and recall. 100% = perfect. |');
  lines.push(
    '| **Target accuracy** | Of the tool\'s correct edges (TPs), what fraction point to the **same specific target** the type checker resolves to (by file + line)? This measures "does the edge point to the RIGHT code?" — not just "does the relationship exist?" |'
  );
  lines.push(
    "| **`n/a — no oracle`** | The oracle has zero ground-truth rows of this type — any tool claim is mathematically forced to 0% precision, which measures the oracle's coverage, not the tool. Shown instead of a fabricated `0.0%` (F13). |"
  );
  lines.push(
    '| **`n/a — not emitted`** | The tool made zero claims of this type — precision (a fact about claims) is undefined, not zero. Recall is unaffected and still reports a real number (F13). |'
  );
  lines.push(
    '| **`n/a — granularity`** | The tool models this relationship only at a coarser granularity (e.g. File→File IMPORTS, never File→Symbol) — it structurally cannot compete at this level. Scored fairly at its own granularity elsewhere in this document (F13/F6). |'
  );
  lines.push(
    '| **`n/a — kind unlabelled`** | The tool identified the symbol (matched by path + name) but tags it as `Unknown` rather than guessing a kind — not the same failure as confidently mislabelling it (F13/F2). |'
  );
  lines.push(
    '| **Unscoreable (excluded)** | Oracle rows dropped before scoring because the target is knowably outside the repo, or unresolvable even to the compiler after every fallback tried. Never counted as FN — recall is computed over the achievable denominator only (F9). |'
  );
  lines.push(
    "| **Site coverage** | Of a matched relationship's original call/reference sites (before deduplication), what fraction the tool's edges account for. A tool that emits one edge per unique pair rather than one per site scores full recall but partial site coverage — informational, not a penalty (F9). |"
  );
  lines.push('');
  lines.push("### What's different from v1");
  lines.push('');
  lines.push('| v1 (parse-only oracle) | v2 (type-checker oracle) |');
  lines.push('|---|---|');
  lines.push(
    "| Oracle couldn't resolve call targets — Vyazen's resolved edges couldn't be confirmed | Oracle CAN resolve call targets — Vyazen's resolved edges are now properly confirmed |"
  );
  lines.push(
    '| "Resolution rate" compared apples to oranges (compiler assertion vs heuristic confidence) | "Target accuracy" measures the same thing for both tools: does the edge point to the target the type checker confirms? |'
  );
  lines.push(
    '| IMPORTS scored at symbol-level only (GitNexus got 0 TP due to File→File vs File→Symbol mismatch) | IMPORTS scored at TWO levels: module dependency (both tools) + symbol-level (Vyazen advantage) |'
  );
  lines.push(
    '| USES_TYPE, ACCESSES, METHOD_OVERRIDES excluded entirely | Scored separately — each tool on what it produces |'
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Headline ───────────────────────────────────────────────────────────────
  lines.push('## Headline');
  lines.push('');
  lines.push(
    '| Tool | Nodes | Edges | Node F1 | Edge F1 | CALLS precision | CALLS recall | CALLS target accuracy |'
  );
  lines.push(
    '|------|-------|-------|---------|---------|------------------|--------------|----------------------|'
  );
  lines.push(
    '| | _Symbols extracted_ | _Comparable edges_ | _Symbol accuracy_ | _Edge accuracy_ | _Of calls claimed, how many are real?_ | _Of real calls, how many found?_ | _Of correct calls, how many point to the exact target?_ |'
  );
  for (const name of toolNames) {
    const g = input.graphs[name];
    const d2 = input.d2[name];
    const calls = d2.edges.byType.CALLS;
    lines.push(
      `| **${name}** | ${num(g.meta.nodeCount)} | ${num(g.meta.edgeCount)} | ${pct(d2.nodes.overall.f1)} | ${pct(d2.edges.overall.f1)} | ${calls ? fmtPrecision(calls) : '—'} | ${calls ? fmtRecall(calls) : '—'} | ${calls ? pct(calls.targetAccuracy) : '—'} |`
    );
  }
  lines.push('');
  lines.push(
    '> **Target accuracy** is the key new metric. It answers: "if a coding agent follows this edge, does it land on the right code?" A tool can have high precision (the relationship exists) but low target accuracy (it points to the wrong overload or the wrong file).'
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── D2 — Fidelity ──────────────────────────────────────────────────────────
  lines.push('## D2 — Fidelity');
  lines.push('');
  lines.push(
    "**What this measures:** How accurately each tool reproduces the oracle's symbols and edges. For each symbol kind and edge type, we compute precision, recall, F1, and **target accuracy** (does the edge point to the right target?)."
  );
  lines.push('');
  lines.push('### Symbol (node) fidelity by kind');
  lines.push('');
  for (const name of toolNames) {
    const d2 = input.d2[name];
    lines.push(`#### ${name}`);
    lines.push('');
    lines.push(
      `Node match rate: **${pct(d2.nodes.toolMatchRate)}** (tool) / **${pct(d2.nodes.oracleMatchRate)}** (oracle)`
    );
    lines.push('');
    lines.push('| Kind | TP | FP | FN | Precision | Recall | F1 |');
    lines.push('|------|----|----|----|-----------|--------|------|');
    for (const [kind, m] of Object.entries(d2.nodes.byKind)) {
      if (!m || m.tp + m.fp + m.fn === 0) {
        continue;
      }
      lines.push(
        `| ${kind} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtPrecision(m)} | ${fmtRecall(m)} | ${fmtF1(m)} |`
      );
    }
    lines.push(
      `| **Overall** | ${num(d2.nodes.overall.tp)} | ${num(d2.nodes.overall.fp)} | ${num(d2.nodes.overall.fn)} | ${fmtPrecision(d2.nodes.overall)} | ${fmtRecall(d2.nodes.overall)} | ${fmtF1(d2.nodes.overall)} |`
    );
    lines.push('');
    lines.push(`**Macro F1:** ${pct(d2.nodes.macroF1)}`);
    lines.push('');

    // F2: kind-labelling accuracy — separate from symbol identity above. A
    // tool that finds the symbol but can't label its kind (e.g. Graphify's
    // `Unknown` bucket) is "unlabelled", not "wrong" — conflating the two
    // used to fabricate an FP+FN pair out of a real match.
    lines.push('##### Kind-labelling accuracy (of matched symbols, F2)');
    lines.push('');
    lines.push(
      "**What this measures:** of the symbols this tool correctly *identified* (matched the oracle by path + name), what fraction did it also correctly *label* with the right kind? `Unlabelled` (e.g. Graphify's `Unknown` bucket) is a capability gap, not a wrong answer."
    );
    lines.push('');
    lines.push('| Kind | Matched | Correct | Mislabelled | Unlabelled | Accuracy |');
    lines.push('|------|---------|---------|-------------|------------|----------|');
    for (const [kind, kl] of Object.entries(d2.nodes.kindLabelling.byKind)) {
      if (!kl || kl.total === 0) {
        continue;
      }
      lines.push(
        `| ${kind} | ${num(kl.total)} | ${num(kl.correct)} | ${num(kl.mislabelled)} | ${num(kl.unlabelled)} | ${fmtKindLabelAccuracy(kl)} |`
      );
    }
    const klOverall = d2.nodes.kindLabelling.overall;
    lines.push(
      `| **Overall** | ${num(klOverall.total)} | ${num(klOverall.correct)} | ${num(klOverall.mislabelled)} | ${num(klOverall.unlabelled)} | ${fmtKindLabelAccuracy(klOverall)} |`
    );
    lines.push('');
  }

  // ── D2 Edges ───────────────────────────────────────────────────────────────
  lines.push('### Relationship (edge) fidelity by type');
  lines.push('');
  lines.push('| Column | Meaning |');
  lines.push('|--------|---------|');
  lines.push('| TP | Edges the oracle confirms (by name or resolved target) |');
  lines.push("| FP | Edges the tool claims that the oracle doesn't confirm |");
  lines.push('| FN | Edges the oracle has that the tool missed |');
  lines.push("| Precision | Of the tool's edges, how many are real |");
  lines.push('| Recall | Of real edges, how many the tool found |');
  lines.push('| F1 | Balanced score |');
  lines.push(
    '| Target confirmed | Of TPs, how many point to the exact target the type checker resolves to (by file + line) |'
  );
  lines.push(
    "| Name only | Of TPs, how many were confirmed by name only (oracle couldn't resolve the target) |"
  );
  lines.push(
    '| Target accuracy | `Target confirmed / TP` — does the edge point to the RIGHT code? |'
  );
  lines.push(
    '| Unscoreable (excl.) | Oracle rows for this type dropped before scoring — target knowably external, or unresolvable even to the compiler (F9). Never folded into FN; this column IS the recall ceiling context: `recall` here is already computed over the achievable denominator. |'
  );
  lines.push(
    "| Site coverage | Of the deduped relationship's original call/reference sites, what fraction the tool's matched edges account for (F9). A tool that emits one edge per unique pair — not one per site — scores full recall but partial site coverage; that is a modelling-granularity note, not a penalty. |"
  );
  lines.push('');

  for (const name of toolNames) {
    const d2 = input.d2[name];
    lines.push(`#### ${name}`);
    lines.push('');
    lines.push(
      '| Edge | TP | FP | FN | Precision | Recall | F1 | Target confirmed | Name only | Target accuracy | Unscoreable (excl.) | Site coverage |'
    );
    lines.push(
      '|------|----|----|----|-----------|--------|------|-------------------|-----------|-----------------|----------------------|---------------|'
    );
    for (const [type, m] of Object.entries(d2.edges.byType)) {
      if (!m || (m.tp + m.fp + m.fn === 0 && !m.onlyFileGranularity)) {
        continue;
      }
      lines.push(
        `| ${type} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtGranularityAware(fmtPrecision(m), m.onlyFileGranularity)} | ${fmtGranularityAware(fmtRecallWithCeiling(m), m.onlyFileGranularity)} | ${fmtGranularityAware(fmtF1(m), m.onlyFileGranularity)} | ${num(m.targetConfirmed)} | ${num(m.nameOnlyConfirmed)} | ${pct(m.targetAccuracy)} | ${num(m.unscoreableExcluded)} | ${pct(m.siteCoverage)} |`
      );
    }
    lines.push(
      `| **Overall** | ${num(d2.edges.overall.tp)} | ${num(d2.edges.overall.fp)} | ${num(d2.edges.overall.fn)} | ${fmtPrecision(d2.edges.overall)} | ${fmtRecall(d2.edges.overall)} | ${fmtF1(d2.edges.overall)} | — | — | **${pct(d2.edges.targetAccuracy)}** | — | — |`
    );
    lines.push('');
    lines.push(
      `**Self-loop leak:** ${num(d2.edges.selfLoopLeak)} · **Unresolved abstentions (excluded from precision):** ${num(d2.edges.abstained)} · **Dangling endpoint rate:** ${pct(d2.edges.danglingEndpointRate)}`
    );
    lines.push('');
  }

  // ── Module-level IMPORTS ───────────────────────────────────────────────────
  lines.push('### IMPORTS — module-level (File → File)');
  lines.push('');
  lines.push(
    '**What this measures:** IMPORTS scored at module-dependency granularity — "does file X depend on file Y?" Every tool can compete at this level, regardless of whether it models imports at File→Symbol granularity (an advantage on the symbol-level table above) or only File→File.'
  );
  lines.push('');
  lines.push('| Tool | Tool pairs | Oracle pairs | TP | FP | FN | Precision | Recall |');
  lines.push('|------|------------|--------------|----|----|----|-----------|--------|');
  for (const name of toolNames) {
    const m = input.d2[name].edges.importsModuleLevel;
    lines.push(
      `| ${name} | ${num(m.toolPairs)} | ${num(m.oraclePairs)} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtPrecision(m)} | ${fmtRecall(m)} |`
    );
  }
  lines.push('');

  // ── F8: IMPLEMENTS — member-level ───────────────────────────────────────────
  lines.push('### IMPLEMENTS — member-level (a class member satisfying an interface member)');
  lines.push('');
  lines.push(
    "**What this measures:** the oracle's class-level IMPLEMENTS (heritage clause, e.g. `class C implements I`) and member-level IMPLEMENTS (`C.m` satisfies `I.m`) are different relations that happen to share an edge type. A tool that only models one must not be penalised against the other — this table is member-level only; class-level is in the main edge table above."
  );
  lines.push('');
  lines.push('| Tool | TP | FP | FN | Precision | Recall | F1 |');
  lines.push('|------|----|----|----|-----------|--------|------|');
  for (const name of toolNames) {
    const m = input.d2[name].edges.implementsMemberLevel;
    lines.push(
      `| ${name} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtPrecision(m)} | ${fmtRecall(m)} | ${fmtF1(m)} |`
    );
  }
  lines.push('');

  // ── F4: USES_TYPE — from-side-agnostic ──────────────────────────────────────
  lines.push('### USES_TYPE — from-side-agnostic');
  lines.push('');
  lines.push(
    '**What this measures:** the strict USES_TYPE table (extended edge types, below) attributes each type reference to a specific container — matching the oracle\'s own attribution convention exactly. This table drops that requirement: per file, "was this type referenced at all", regardless of which container each side attributes it to. This is the only way to score a tool whose from-side convention differs from the oracle\'s (e.g. Potpie attributes to File/Function/Method where the oracle attributes to the specific Property or Method) at all, instead of reporting an arithmetic near-zero that measures attribution-convention mismatch, not capability.'
  );
  lines.push('');
  lines.push('| Tool | TP | FP | FN | Precision | Recall | F1 |');
  lines.push('|------|----|----|----|-----------|--------|------|');
  for (const name of toolNames) {
    const m = input.d2[name].edges.usesTypeFromAgnostic;
    lines.push(
      `| ${name} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtPrecision(m)} | ${fmtRecall(m)} | ${fmtF1(m)} |`
    );
  }
  lines.push('');

  // ── F10: oracle CALLS resolution tiers ──────────────────────────────────────
  if (input.resolutionTiers && Object.keys(input.resolutionTiers).length > 0) {
    const TIER_LABELS: Record<string, string> = {
      symbol: 'symbol (direct — oracle-certain)',
      signature: 'signature (overload/generic resolution — oracle-certain)',
      property: 'property (union fan-out — best-effort)',
      'optional-chain-stripped': 'optional-chain-stripped (retry after `?.`/`!` — best-effort)',
      unresolved: 'unresolved (external, builtin, or genuinely dynamic)',
    };
    const tierTotal = Object.values(input.resolutionTiers).reduce((a, b) => a + b, 0);
    lines.push('### Oracle CALLS resolution tiers (F10)');
    lines.push('');
    lines.push(
      "**What this measures:** not every oracle CALLS row is equally trustworthy ground truth. `symbol`/`signature` are the compiler's direct answer; `property`/`optional-chain-stripped` are best-effort fallbacks for receivers the compiler can't resolve in one step; `unresolved` rows are excluded from every recall denominator entirely (F9) — they're external/builtin targets or genuinely dynamic dispatch, not a target any tool built from this repo's source could ever name."
    );
    lines.push('');
    lines.push('| Tier | Count | Share |');
    lines.push('|------|-------|-------|');
    for (const [tier, count] of Object.entries(input.resolutionTiers)) {
      lines.push(`| ${TIER_LABELS[tier] ?? tier} | ${num(count)} | ${pct(count / tierTotal)} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');

  // ── D1 — Depth moat ────────────────────────────────────────────────────────
  lines.push('## D1 — Depth moat');
  lines.push('');
  lines.push(
    '**What this measures:** Vyazen uses the TS compiler to resolve edges — it knows "method A calls method B specifically", not just "A calls something named B". The question: of Vyazen\'s resolved edges, how many does the competitor also find, and how many point to the right target?'
  );
  lines.push('');

  for (const name of toolNames) {
    const d1 = input.d1[name];
    lines.push(`### ${name}`);
    lines.push('');
    lines.push(
      '| Edge | Tool claimed | TP (oracle) | FP (rejected) | FN (missed) | Precision | Oracle recall | Target confirmed | Unscoreable (excl.) | Site coverage |'
    );
    lines.push(
      '|------|--------------|-------------|---------------|-------------|-----------|---------------|-------------------|----------------------|---------------|'
    );
    for (const m of d1.perType) {
      lines.push(
        `| ${m.edgeType} | ${num(m.toolClaimed)} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtPrecision(m)} | ${fmtRecallWithCeiling(m)} | ${num(m.targetConfirmed)} | ${num(m.unscoreableExcluded)} | ${pct(m.siteCoverage)} |`
      );
    }
    lines.push('');

    if (name === 'Vyazen') {
      lines.push('#### Vyazen resolved-edge slice — the headline');
      lines.push('');
      lines.push(
        'Vyazen marks edges as `resolved=true` when the TS compiler confirmed the target. Of those: how many does the oracle confirm (edge exists)? And how many have the **correct target** (same file + line as the type checker)?'
      );
      lines.push('');
      lines.push(
        '| Edge | Resolved total | Oracle confirms | Target confirmed | Edge confirmation rate | Target accuracy |'
      );
      lines.push(
        '|------|---------------|-----------------|-------------------|------------------------|-----------------|'
      );
      for (const m of d1.perType) {
        if (
          m.vyazenResolvedTotal !== undefined &&
          m.vyazenResolvedConfirmed !== undefined &&
          m.vyazenResolvedTargetConfirmed !== undefined
        ) {
          const confRate =
            m.vyazenResolvedTotal > 0 ? m.vyazenResolvedConfirmed / m.vyazenResolvedTotal : 0;
          const tgtRate =
            m.vyazenResolvedTotal > 0 ? m.vyazenResolvedTargetConfirmed / m.vyazenResolvedTotal : 0;
          lines.push(
            `| ${m.edgeType} | ${num(m.vyazenResolvedTotal)} | ${num(m.vyazenResolvedConfirmed)} | ${num(m.vyazenResolvedTargetConfirmed)} | ${pct(confRate)} | ${pct(tgtRate)} |`
          );
        }
      }
      lines.push('');
      lines.push(
        "> **Edge confirmation rate** = of Vyazen's resolved edges, how many the oracle confirms exist (by name or target). **Target accuracy** = of Vyazen's resolved edges, how many point to the exact target the type checker resolves to. The gap between these two numbers shows edges where the relationship exists but Vyazen's target might differ from the oracle's (e.g. different overloads)."
      );
      lines.push('');
    }
  }

  // ── Cross-tool coverage ────────────────────────────────────────────────────
  if (input.coverage) {
    lines.push('### Cross-tool coverage — does the competitor find what Vyazen finds?');
    lines.push('');
    lines.push(
      "Of Vyazen's resolved edges, how many does the competitor also emit? This is **raw coverage**, not correctness."
    );
    lines.push('');
    for (const [compName, coverage] of Object.entries(input.coverage)) {
      lines.push(`#### Vyazen → ${compName}`);
      lines.push('');
      lines.push(
        '| Edge | Vyazen resolved | Competitor covers | Competitor misses | Coverage rate |'
      );
      lines.push(
        '|------|-----------------|-------------------|-------------------|---------------|'
      );
      for (const c of coverage) {
        const rate = c.vyazenResolved > 0 ? c.competitorCovers / c.vyazenResolved : 0;
        lines.push(
          `| ${c.edgeType} | ${num(c.vyazenResolved)} | ${num(c.competitorCovers)} | ${num(c.competitorMisses)} | ${pct(rate)} |`
        );
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');

  // ── Extended edge types ────────────────────────────────────────────────────
  lines.push('## Extended edge types (scored separately)');
  lines.push('');
  lines.push(
    "**What this measures:** Edge types that only one tool produces. Each is scored against the oracle — the tool is evaluated on the accuracy of what it emits, not penalized for what it doesn't."
  );
  lines.push('');
  lines.push(
    '| Edge type | Tool | TP | FP | FN | Precision | Recall | F1 | Unscoreable (excl.) | Site coverage |'
  );
  lines.push(
    '|-----------|------|----|----|----|-----------|--------|------|----------------------|---------------|'
  );
  for (const name of toolNames) {
    const ext = input.d2[name].edges.extendedByType;
    for (const [type, m] of Object.entries(ext)) {
      if (!m) {
        continue;
      }
      // F13: a tool that claims zero edges of this type reads "n/a — not
      // emitted", never "0.0%" — the previous table contradicted its own
      // header ("evaluated on the accuracy of what it emits") by printing a
      // fabricated zero for types a tool simply doesn't produce.
      lines.push(
        `| ${type} | ${name} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${fmtPrecision(m)} | ${fmtRecallWithCeiling(m)} | ${fmtF1(m)} | ${num(m.unscoreableExcluded)} | ${pct(m.siteCoverage)} |`
      );
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── D3 — Pipeline cost ──────────────────────────────────────────────────────
  if (input.d3) {
    lines.push('## D3 — Pipeline cost');
    lines.push('');
    lines.push(
      "**What this measures:** what it costs to stand up each tool's index — wall-clock, peak memory, on-disk size. Measured directly (`/usr/bin/time -l`), not estimated. Per methodology: a crash or timeout here is a finding, not a blank cell."
    );
    lines.push('');
    lines.push('| Tool | Wall-clock | Peak RSS | Index size | Notes |');
    lines.push('|------|-----------|----------|------------|-------|');
    for (const name of toolNames) {
      const d3 = input.d3[name];
      if (!d3) {
        lines.push(`| ${name} | — | — | — | Not measured |`);
        continue;
      }
      lines.push(
        `| ${name} | ${d3.wallClock} | ${d3.peakRss} | ${d3.indexSize} | ${d3.notes ?? ''} |`
      );
    }
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // ── D4 — Capability envelope ───────────────────────────────────────────────
  lines.push('## D4 — Capability envelope');
  lines.push('');
  lines.push("What each tool can do at all — including things the other can't.");
  lines.push('');
  lines.push('### Symbol-kind coverage');
  lines.push('');
  lines.push(`| Kind | ${toolNames.join(' | ')} |`);
  lines.push(`|------|${toolNames.map(() => '------').join('|')}|`);
  for (const row of input.d4.ontologyCoverage) {
    lines.push(`| ${row.kind} | ${toolNames.map((t) => row.tools[t] ?? 'no').join(' | ')} |`);
  }
  lines.push('');
  lines.push('### Edge-type coverage');
  lines.push('');
  lines.push(`| Edge | ${toolNames.join(' | ')} |`);
  lines.push(`|------|${toolNames.map(() => '------').join('|')}|`);
  for (const row of input.d4.edgeTypeCoverage) {
    lines.push(`| ${row.type} | ${toolNames.map((t) => row.tools[t] ?? 'no').join(' | ')} |`);
  }
  lines.push('');
  lines.push('### Capability matrix');
  lines.push('');
  lines.push(`| Capability | ${toolNames.join(' | ')} |`);
  lines.push(`|------|${toolNames.map(() => '------').join('|')}|`);
  for (const row of input.d4.capabilityMatrix) {
    lines.push(
      `| ${row.capability} | ${toolNames.map((t) => row.tools[t] ?? 'N/A').join(' | ')} |`
    );
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Methodology caveats ────────────────────────────────────────────────────
  lines.push('## Methodology caveats');
  lines.push('');
  for (let i = 0; i < input.caveats.length; i++) {
    lines.push(`${i + 1}. ${input.caveats[i]}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Glossary ───────────────────────────────────────────────────────────────
  lines.push('## Glossary');
  lines.push('');
  lines.push('| Term | Definition |');
  lines.push('|------|------------|');
  lines.push(
    '| **ACCESSES** | Edge from a code location to a property it accesses (e.g. `this.foo` → `foo` property). Emitted by GitNexus only, among the tools in this scorecard. |'
  );
  lines.push('| **AST** | Abstract Syntax Tree — parsed structure of source code. |');
  lines.push('| **CALLS** | Edge from a caller to a callee. "A calls B". |');
  lines.push(
    '| **Compiler resolution** | Using the TS type checker to determine the exact target of a call/import/inheritance. |'
  );
  lines.push('| **EXT***REMOVED***S** | Edge from a child class/interface to its parent. |');
  lines.push('| **F1** | Harmonic mean of precision and recall. Punishes imbalanced scores. |');
  lines.push('| **IMPLEMENTS** | Edge from a class to an interface it implements. |');
  lines.push(
    '| **IMPORTS (module-level)** | File→File dependency. "file X imports from file Y". Both tools. |'
  );
  lines.push(
    '| **IMPORTS (symbol-level)** | File→Symbol dependency. "file X imports symbol `foo`". Advantage for tools that model imports at symbol granularity. |'
  );
  lines.push(
    '| **METHOD_OVERRIDES** | Edge from a method to the parent method it overrides. Emitted by GitNexus only, among the tools in this scorecard. |'
  );
  lines.push(
    "| **Oracle** | Ground truth from the TS type checker. Neutral — it's the language's semantics. |"
  );
  lines.push('| **Precision** | `TP / (TP + FP)`. "Of what I claim, how much is correct?" |');
  lines.push('| **Recall** | `TP / (TP + FN)`. "Of what exists, how much did I find?" |');
  lines.push(
    '| **Target accuracy** | Of correct edges (TPs), fraction that point to the exact target the type checker resolves to (by file + line ±2). |'
  );
  lines.push(
    "| **Target confirmed** | TPs where the tool's to-node matches the oracle's resolved target by file + line. |"
  );
  lines.push('| **TP / FP / FN** | True Positive / False Positive / False Negative. |');
  lines.push(
    '| **USES_TYPE** | Edge from a typed element to the type it references (e.g. `x: Foo` → `Foo`). Emitted by Vyazen (resolved) and Potpie (type-annotation + `new`-expression references only, §4). |'
  );
  lines.push('');

  // ── Deliverables ───────────────────────────────────────────────────────────
  lines.push('## Deliverables');
  lines.push('');
  lines.push('| Item | Location |');
  lines.push('|------|----------|');
  lines.push('| This scorecard | `CODE_GRAPH_EVAL_SCORECARD.md` |');
  lines.push('| Eval plan | `CODE_GRAPH_EVAL_PLAN.md` |');
  lines.push('| Eval harness | `scripts/eval/code-graph/` |');
  lines.push(
    '| Per-tool JSONL | `scripts/eval/code-graph/data/{tool}/nodes.jsonl`, `edges.jsonl` |'
  );
  lines.push(
    '| Oracle JSONL | `scripts/eval/code-graph/data/oracle/oracle-symbols.jsonl`, `oracle-edges.jsonl` |'
  );
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_To re-run: `bun run scripts/eval/code-graph/runner.ts --use-cache --skip-oracle`_');

  return lines.join('\n');
}
