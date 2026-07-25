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

export interface ScorecardInput {
  d1: Record<string, D1Report>;
  d2: Record<string, D2Report>;
  d4: D4Report;
  coverage?: Record<string, ReturnType<typeof import('../scorers/d1-depth.scorer').crossToolCoverage>>;
  graphs: Record<string, ToolGraph>;
  caveats: string[];
  generatedAt: string;
  commitSha: string;
  /** Fraction of oracle edges with type-checker-resolved targets. */
  oracleResolvedRate?: number;
}

const pct = (n: number): string => n == null ? '—' : `${(n * 100).toFixed(1)}%`;
const num = (n: number): string => n == null ? '—' : n.toLocaleString();

export function generateScorecard(input: ScorecardInput): string {
  const toolNames = Object.keys(input.d2);
  const lines: string[] = [];

  // ── Title + reader's guide ──────────────────────────────────────────────────
  lines.push('# Code-Graph Eval — Scorecard (v2)');
  lines.push('');
  lines.push(`_Generated ${input.generatedAt} · repo: BabylonJS/Babylon.js @ \`${input.commitSha}\` · tools: ${toolNames.join(', ')} · oracle: **type-checker-backed**_`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('## How to read this scorecard');
  lines.push('');
  lines.push('This document compares how well different code-indexing tools build a **code knowledge graph** — a structured representation of a codebase where nodes are code symbols (classes, methods, functions) and edges are relationships between them (calls, imports, inheritance). A better graph means AI agents get more accurate answers about the codebase.');
  lines.push('');
  lines.push('### The setup');
  lines.push('');
  lines.push('- **Repo:** BabylonJS/Babylon.js — a large TypeScript codebase (~8,400 files, ~80,000 symbols). All tools indexed the same commit.');
  lines.push('- **The oracle (ground truth):** The TypeScript compiler **with type checking**. Unlike a parse-only oracle, this can resolve which specific method a call targets, which class is extended, which symbol is imported. It is the language\'s own semantics — neutral, not favoring any tool.');
  if (input.oracleResolvedRate !== undefined) {
    lines.push(`- **Oracle resolution:** ${pct(input.oracleResolvedRate)} of oracle edges have type-checker-resolved targets (the rest are dynamic/external calls the compiler couldn't resolve).`);
  }
  lines.push(`- **Tools:** ${toolNames.map((t) => `**${t}**`).join(' and ')}.`);
  lines.push('');
  lines.push('### Key terms');
  lines.push('');
  lines.push('| Term | Meaning |');
  lines.push('|------|---------|');
  lines.push('| **Node** | A code symbol (class, method, function, property). |');
  lines.push('| **Edge** | A relationship between two nodes (A calls B, C extends D). |');
  lines.push('| **Oracle** | Ground truth from the TS type checker. Neither tool\'s graph is the oracle. |');
  lines.push('| **TP** | True Positive — tool found something the oracle confirms. ✅ |');
  lines.push('| **FP** | False Positive — tool claims something the oracle doesn\'t confirm. ❌ |');
  lines.push('| **FN** | False Negative — oracle has it, tool missed it. ⚠️ |');
  lines.push('| **Precision** | `TP / (TP + FP)` — of what the tool claims, how much is correct. |');
  lines.push('| **Recall** | `TP / (TP + FN)` — of what exists, how much the tool found. |');
  lines.push('| **F1** | Harmonic mean of precision and recall. 100% = perfect. |');
  lines.push('| **Target accuracy** | Of the tool\'s correct edges (TPs), what fraction point to the **same specific target** the type checker resolves to (by file + line)? This measures "does the edge point to the RIGHT code?" — not just "does the relationship exist?" |');
  lines.push('');
  lines.push('### What\'s different from v1');
  lines.push('');
  lines.push('| v1 (parse-only oracle) | v2 (type-checker oracle) |');
  lines.push('|---|---|');
  lines.push('| Oracle couldn\'t resolve call targets — Vyazen\'s resolved edges couldn\'t be confirmed | Oracle CAN resolve call targets — Vyazen\'s resolved edges are now properly confirmed |');
  lines.push('| "Resolution rate" compared apples to oranges (compiler assertion vs heuristic confidence) | "Target accuracy" measures the same thing for both tools: does the edge point to the target the type checker confirms? |');
  lines.push('| IMPORTS scored at symbol-level only (GitNexus got 0 TP due to File→File vs File→Symbol mismatch) | IMPORTS scored at TWO levels: module dependency (both tools) + symbol-level (Vyazen advantage) |');
  lines.push('| USES_TYPE, ACCESSES, METHOD_OVERRIDES excluded entirely | Scored separately — each tool on what it produces |');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Headline ───────────────────────────────────────────────────────────────
  lines.push('## Headline');
  lines.push('');
  lines.push('| Tool | Nodes | Edges | Node F1 | Edge F1 | CALLS precision | CALLS recall | CALLS target accuracy |');
  lines.push('|------|-------|-------|---------|---------|------------------|--------------|----------------------|');
  lines.push('| | _Symbols extracted_ | _Comparable edges_ | _Symbol accuracy_ | _Edge accuracy_ | _Of calls claimed, how many are real?_ | _Of real calls, how many found?_ | _Of correct calls, how many point to the exact target?_ |');
  for (const name of toolNames) {
    const g = input.graphs[name];
    const d2 = input.d2[name];
    const calls = d2.edges.byType.CALLS;
    lines.push(
      `| **${name}** | ${num(g.meta.nodeCount)} | ${num(g.meta.edgeCount)} | ${pct(d2.nodes.overall.f1)} | ${pct(d2.edges.overall.f1)} | ${calls ? pct(calls.precision) : '—'} | ${calls ? pct(calls.recall) : '—'} | ${calls ? pct(calls.targetAccuracy) : '—'} |`,
    );
  }
  lines.push('');
  lines.push('> **Target accuracy** is the key new metric. It answers: "if a coding agent follows this edge, does it land on the right code?" A tool can have high precision (the relationship exists) but low target accuracy (it points to the wrong overload or the wrong file).');
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── D2 — Fidelity ──────────────────────────────────────────────────────────
  lines.push('## D2 — Fidelity');
  lines.push('');
  lines.push('**What this measures:** How accurately each tool reproduces the oracle\'s symbols and edges. For each symbol kind and edge type, we compute precision, recall, F1, and **target accuracy** (does the edge point to the right target?).');
  lines.push('');
  lines.push('### Symbol (node) fidelity by kind');
  lines.push('');
  for (const name of toolNames) {
    const d2 = input.d2[name];
    lines.push(`#### ${name}`);
    lines.push('');
    lines.push(`Node match rate: **${pct(d2.nodes.toolMatchRate)}** (tool) / **${pct(d2.nodes.oracleMatchRate)}** (oracle)`);
    lines.push('');
    lines.push('| Kind | TP | FP | FN | Precision | Recall | F1 |');
    lines.push('|------|----|----|----|-----------|--------|------|');
    for (const [kind, m] of Object.entries(d2.nodes.byKind)) {
      if (!m || m.tp + m.fp + m.fn === 0) continue;
      lines.push(`| ${kind} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`);
    }
    lines.push(`| **Overall** | ${num(d2.nodes.overall.tp)} | ${num(d2.nodes.overall.fp)} | ${num(d2.nodes.overall.fn)} | ${pct(d2.nodes.overall.precision)} | ${pct(d2.nodes.overall.recall)} | ${pct(d2.nodes.overall.f1)} |`);
    lines.push('');
    lines.push(`**Macro F1:** ${pct(d2.nodes.macroF1)}`);
    lines.push('');
  }

  // ── D2 Edges ───────────────────────────────────────────────────────────────
  lines.push('### Relationship (edge) fidelity by type');
  lines.push('');
  lines.push('| Column | Meaning |');
  lines.push('|--------|---------|');
  lines.push('| TP | Edges the oracle confirms (by name or resolved target) |');
  lines.push('| FP | Edges the tool claims that the oracle doesn\'t confirm |');
  lines.push('| FN | Edges the oracle has that the tool missed |');
  lines.push('| Precision | Of the tool\'s edges, how many are real |');
  lines.push('| Recall | Of real edges, how many the tool found |');
  lines.push('| F1 | Balanced score |');
  lines.push('| Target confirmed | Of TPs, how many point to the exact target the type checker resolves to (by file + line) |');
  lines.push('| Name only | Of TPs, how many were confirmed by name only (oracle couldn\'t resolve the target) |');
  lines.push('| Target accuracy | `Target confirmed / TP` — does the edge point to the RIGHT code? |');
  lines.push('');

  for (const name of toolNames) {
    const d2 = input.d2[name];
    lines.push(`#### ${name}`);
    lines.push('');
    lines.push('| Edge | TP | FP | FN | Precision | Recall | F1 | Target confirmed | Name only | Target accuracy |');
    lines.push('|------|----|----|----|-----------|--------|------|-------------------|-----------|-----------------|');
    for (const [type, m] of Object.entries(d2.edges.byType)) {
      if (!m || m.tp + m.fp + m.fn === 0) continue;
      lines.push(
        `| ${type} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} | ${num(m.targetConfirmed)} | ${num(m.nameOnlyConfirmed)} | ${pct(m.targetAccuracy)} |`,
      );
    }
    lines.push(`| **Overall** | ${num(d2.edges.overall.tp)} | ${num(d2.edges.overall.fp)} | ${num(d2.edges.overall.fn)} | ${pct(d2.edges.overall.precision)} | ${pct(d2.edges.overall.recall)} | ${pct(d2.edges.overall.f1)} | — | — | **${pct(d2.edges.targetAccuracy)}** |`);
    lines.push('');
    lines.push(`**Self-loop leak:** ${num(d2.edges.selfLoopLeak)} · **Unresolved abstentions (excluded from precision):** ${num(d2.edges.abstained)} · **Dangling endpoint rate:** ${pct(d2.edges.danglingEndpointRate)}`);
    lines.push('');
  }

  // ── Module-level IMPORTS ───────────────────────────────────────────────────
  lines.push('### IMPORTS — module-level (File → File)');
  lines.push('');
  lines.push('**What this measures:** IMPORTS scored at module-dependency granularity — "does file X depend on file Y?" Both tools can compete at this level, regardless of whether they model imports as File→Symbol (Vyazen) or File→File (GitNexus).');
  lines.push('');
  lines.push('| Tool | Tool pairs | Oracle pairs | TP | FP | FN | Precision | Recall |');
  lines.push('|------|------------|--------------|----|----|----|-----------|--------|');
  for (const name of toolNames) {
    const m = input.d2[name].edges.importsModuleLevel;
    lines.push(`| ${name} | ${num(m.toolPairs)} | ${num(m.oraclePairs)} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${pct(m.precision)} | ${pct(m.recall)} |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── D1 — Depth moat ────────────────────────────────────────────────────────
  lines.push('## D1 — Depth moat');
  lines.push('');
  lines.push('**What this measures:** Vyazen uses the TS compiler to resolve edges — it knows "method A calls method B specifically", not just "A calls something named B". The question: of Vyazen\'s resolved edges, how many does the competitor also find, and how many point to the right target?');
  lines.push('');

  for (const name of toolNames) {
    const d1 = input.d1[name];
    lines.push(`### ${name}`);
    lines.push('');
    lines.push('| Edge | Tool claimed | TP (oracle) | FP (rejected) | FN (missed) | Precision | Oracle recall | Target confirmed |');
    lines.push('|------|--------------|-------------|---------------|-------------|-----------|---------------|-------------------|');
    for (const m of d1.perType) {
      lines.push(
        `| ${m.edgeType} | ${num(m.toolClaimed)} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${pct(m.toolPrecision)} | ${pct(m.oracleRecall)} | ${num(m.targetConfirmed)} |`,
      );
    }
    lines.push('');

    if (name === 'Vyazen') {
      lines.push('#### Vyazen resolved-edge slice — the headline');
      lines.push('');
      lines.push('Vyazen marks edges as `resolved=true` when the TS compiler confirmed the target. Of those: how many does the oracle confirm (edge exists)? And how many have the **correct target** (same file + line as the type checker)?');
      lines.push('');
      lines.push('| Edge | Resolved total | Oracle confirms | Target confirmed | Edge confirmation rate | Target accuracy |');
      lines.push('|------|---------------|-----------------|-------------------|------------------------|-----------------|');
      for (const m of d1.perType) {
        if (m.vyazenResolvedTotal !== undefined && m.vyazenResolvedConfirmed !== undefined && m.vyazenResolvedTargetConfirmed !== undefined) {
          const confRate = m.vyazenResolvedTotal > 0 ? m.vyazenResolvedConfirmed / m.vyazenResolvedTotal : 0;
          const tgtRate = m.vyazenResolvedTotal > 0 ? m.vyazenResolvedTargetConfirmed / m.vyazenResolvedTotal : 0;
          lines.push(`| ${m.edgeType} | ${num(m.vyazenResolvedTotal)} | ${num(m.vyazenResolvedConfirmed)} | ${num(m.vyazenResolvedTargetConfirmed)} | ${pct(confRate)} | ${pct(tgtRate)} |`);
        }
      }
      lines.push('');
      lines.push('> **Edge confirmation rate** = of Vyazen\'s resolved edges, how many the oracle confirms exist (by name or target). **Target accuracy** = of Vyazen\'s resolved edges, how many point to the exact target the type checker resolves to. The gap between these two numbers shows edges where the relationship exists but Vyazen\'s target might differ from the oracle\'s (e.g. different overloads).');
      lines.push('');
    }
  }

  // ── Cross-tool coverage ────────────────────────────────────────────────────
  if (input.coverage) {
    lines.push('### Cross-tool coverage — does the competitor find what Vyazen finds?');
    lines.push('');
    lines.push('Of Vyazen\'s resolved edges, how many does the competitor also emit? This is **raw coverage**, not correctness.');
    lines.push('');
    for (const [compName, coverage] of Object.entries(input.coverage)) {
      lines.push(`#### Vyazen → ${compName}`);
      lines.push('');
      lines.push('| Edge | Vyazen resolved | Competitor covers | Competitor misses | Coverage rate |');
      lines.push('|------|-----------------|-------------------|-------------------|---------------|');
      for (const c of coverage) {
        const rate = c.vyazenResolved > 0 ? c.competitorCovers / c.vyazenResolved : 0;
        lines.push(`| ${c.edgeType} | ${num(c.vyazenResolved)} | ${num(c.competitorCovers)} | ${num(c.competitorMisses)} | ${pct(rate)} |`);
      }
      lines.push('');
    }
  }

  lines.push('---');
  lines.push('');

  // ── Extended edge types ────────────────────────────────────────────────────
  lines.push('## Extended edge types (scored separately)');
  lines.push('');
  lines.push('**What this measures:** Edge types that only one tool produces. Each is scored against the oracle — the tool is evaluated on the accuracy of what it emits, not penalized for what it doesn\'t.');
  lines.push('');
  lines.push('| Edge type | Tool | TP | FP | FN | Precision | Recall | F1 |');
  lines.push('|-----------|------|----|----|----|-----------|--------|------|');
  for (const name of toolNames) {
    const ext = input.d2[name].edges.extendedByType;
    for (const [type, m] of Object.entries(ext)) {
      if (!m) continue;
      lines.push(`| ${type} | ${name} | ${num(m.tp)} | ${num(m.fp)} | ${num(m.fn)} | ${pct(m.precision)} | ${pct(m.recall)} | ${pct(m.f1)} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── D4 — Capability envelope ───────────────────────────────────────────────
  lines.push('## D4 — Capability envelope');
  lines.push('');
  lines.push('What each tool can do at all — including things the other can\'t.');
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
    lines.push(`| ${row.capability} | ${toolNames.map((t) => row.tools[t] ?? 'N/A').join(' | ')} |`);
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
  lines.push('| **ACCESSES** | Edge from a code location to a property it accesses (e.g. `this.foo` → `foo` property). GitNexus-only. |');
  lines.push('| **AST** | Abstract Syntax Tree — parsed structure of source code. |');
  lines.push('| **CALLS** | Edge from a caller to a callee. "A calls B". |');
  lines.push('| **Compiler resolution** | Using the TS type checker to determine the exact target of a call/import/inheritance. |');
  lines.push('| **EXT***REMOVED***S** | Edge from a child class/interface to its parent. |');
  lines.push('| **F1** | Harmonic mean of precision and recall. Punishes imbalanced scores. |');
  lines.push('| **IMPLEMENTS** | Edge from a class to an interface it implements. |');
  lines.push('| **IMPORTS (module-level)** | File→File dependency. "file X imports from file Y". Both tools. |');
  lines.push('| **IMPORTS (symbol-level)** | File→Symbol dependency. "file X imports symbol `foo`". Vyazen advantage. |');
  lines.push('| **METHOD_OVERRIDES** | Edge from a method to the parent method it overrides. GitNexus-only. |');
  lines.push('| **Oracle** | Ground truth from the TS type checker. Neutral — it\'s the language\'s semantics. |');
  lines.push('| **Precision** | `TP / (TP + FP)`. "Of what I claim, how much is correct?" |');
  lines.push('| **Recall** | `TP / (TP + FN)`. "Of what exists, how much did I find?" |');
  lines.push('| **Target accuracy** | Of correct edges (TPs), fraction that point to the exact target the type checker resolves to (by file + line ±2). |');
  lines.push('| **Target confirmed** | TPs where the tool\'s to-node matches the oracle\'s resolved target by file + line. |');
  lines.push('| **TP / FP / FN** | True Positive / False Positive / False Negative. |');
  lines.push('| **USES_TYPE** | Edge from a typed element to the type it references (e.g. `x: Foo` → `Foo`). Vyazen-only. |');
  lines.push('');

  // ── Deliverables ───────────────────────────────────────────────────────────
  lines.push('## Deliverables');
  lines.push('');
  lines.push('| Item | Location |');
  lines.push('|------|----------|');
  lines.push('| This scorecard | `CODE_GRAPH_EVAL_SCORECARD.md` |');
  lines.push('| Eval plan | `CODE_GRAPH_EVAL_PLAN.md` |');
  lines.push('| Eval harness | `scripts/eval/code-graph/` |');
  lines.push('| Per-tool JSONL | `scripts/eval/code-graph/data/{tool}/nodes.jsonl`, `edges.jsonl` |');
  lines.push('| Oracle JSONL | `scripts/eval/code-graph/data/oracle/oracle-symbols.jsonl`, `oracle-edges.jsonl` |');
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_To re-run: `bun run scripts/eval/code-graph/runner.ts --use-cache --skip-oracle`_');

  return lines.join('\n');
}
