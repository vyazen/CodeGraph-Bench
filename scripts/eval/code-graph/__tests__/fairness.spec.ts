/**
 * Phase 5 — fairness regression harness (CODE_GRAPH_EVAL_FAIRNESS_PLAN.md §5).
 *
 * Five invariants that encode the plan's guiding principle mechanically, so
 * the next regression is caught by CI rather than by a human re-auditing the
 * scorecard: "a scoring rule is only admissible if it would produce the same
 * verdict when the tools' names were swapped."
 *
 * 1. Name-swap invariance
 * 2. Oracle-blindness invariance
 * 3. Granularity invariance
 * 4. Denominator soundness (PerfectTool)
 * 5. Symmetry audit
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adjudicateEdges } from '../matching/edge-adjudicator';
import { matchNodes } from '../matching/node-identity.matcher';
import { deriveScoreable, TsTypeCheckerOracle } from '../oracle/ts-typechecker.oracle';
import { scoreD1 } from '../scorers/d1-depth.scorer';
import { scoreD2 } from '../scorers/d2-fidelity.scorer';
import type { GraphEdge, GraphNode, OracleEdge, OracleSymbol } from '../types';

// ── Shared fixture helpers ────────────────────────────────────────────────────

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    lib: ['ES2020'],
    module: 'commonjs',
    skipLibCheck: true,
    strict: false,
    target: 'ES2020',
  },
});

/** Write a fixture repo to a temp dir and run the real type-checker oracle on it. */
function runOracle(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'fairness-fixture-'));
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  try {
    const result = new TsTypeCheckerOracle().analyze(dir);
    // Mirrors what `runTypeCheckerOracle` does after every fresh analysis
    // (runner.ts) — without it, CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS rows with no
    // resolved target would default to `scoreable: true` here, which is only
    // correct for cached pre-F9 data being backfilled, not a fresh run.
    deriveScoreable(result.edges);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function mkToolNode(
  id: string,
  name: string,
  path: string,
  startLine: number | null,
  kind: GraphNode['kind']
): GraphNode {
  return { endLine: null, id, kind, name, parentId: null, path, startLine };
}
function mkToolEdge(fromId: string, toId: string, type: GraphEdge['type']): GraphEdge {
  return { confidence: null, fromId, resolved: true, toId, type };
}

/**
 * Item 4 — build a "perfect tool" graph directly from the oracle's own
 * output: one tool node per oracle symbol (identical path/name/kind/line —
 * trivially a perfect node match), a File node per source path, and one tool
 * edge per SCOREABLE oracle edge, pointed wherever the oracle itself
 * resolved the target (by id when it has one, by name otherwise — the same
 * two tiers `adjudicateEdges` itself tries). IMPORTS edges also get a
 * redundant File→File edge (legal per F6 — a tool may model both
 * granularities without penalty) so the perfect tool can win the
 * module-level table too.
 *
 * If the fixture is well-formed (every scoreable row names something that
 * actually exists in the fixture), this tool must score P=R=F1=100% on every
 * metric the oracle can judge. Any shortfall is an eval-harness bug, not a
 * tool limitation, by construction — this is what "denominator soundness"
 * means (F9's guiding principle) and is the single test the plan says
 * "would have caught F1, F2, F5, F6, F9 and F12."
 */
function buildPerfectToolFromOracle(
  symbols: OracleSymbol[],
  edges: OracleEdge[]
): { edges: GraphEdge[]; nodes: GraphNode[] } {
  const symId = (path: string, localId: string) => `sym:${path}::${localId}`;
  const fileId = (path: string) => `file:${path}`;
  const symByKey = new Map(symbols.map((s) => [`${s.path}::${s.localId}`, s]));
  const filePaths = [...new Set(symbols.map((s) => s.path))];

  const nodes: GraphNode[] = [
    ...filePaths.map((path) => mkToolNode(fileId(path), path, path, null, 'File')),
    ...symbols.map((s) =>
      mkToolNode(symId(s.path, s.localId), s.name, s.path, s.startLine, s.kind)
    ),
  ];

  const resolveFromId = (e: OracleEdge): string | null => {
    const sym = symByKey.get(`${e.fromPath}::${e.fromLocalId}`);
    if (sym) {
      return symId(sym.path, sym.localId);
    }
    // IMPORTS / module-scope calls: fromLocalId is the file's own path.
    return filePaths.includes(e.fromPath) ? fileId(e.fromPath) : null;
  };
  const resolveToId = (e: OracleEdge): string | null => {
    if (e.targetLocalId) {
      const sym = symByKey.get(`${e.targetPath ?? e.fromPath}::${e.targetLocalId}`);
      if (sym) {
        return symId(sym.path, sym.localId);
      }
    }
    const byName = symbols.find((s) => s.name === e.targetName);
    return byName ? symId(byName.path, byName.localId) : null;
  };

  const seen = new Set<string>();
  const toolEdges: GraphEdge[] = [];
  const pushUnique = (fromId: string, toId: string, type: GraphEdge['type']) => {
    const key = `${fromId}\0${toId}\0${type}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    toolEdges.push(mkToolEdge(fromId, toId, type));
  };

  for (const e of edges) {
    if (e.scoreable === false) {
      continue; // unscoreable rows are excluded from the denominator (F9) — a perfect tool owes them nothing
    }
    const fromId = resolveFromId(e);
    const toId = resolveToId(e);
    if (!(fromId && toId)) {
      continue;
    }
    pushUnique(fromId, toId, e.type);
    if (e.type === 'IMPORTS') {
      const toSym = e.targetLocalId
        ? symByKey.get(`${e.targetPath ?? ''}::${e.targetLocalId}`)
        : undefined;
      const targetFile = toSym?.path ?? e.targetPath;
      if (targetFile && filePaths.includes(e.fromPath) && filePaths.includes(targetFile)) {
        pushUnique(fileId(e.fromPath), fileId(targetFile), 'IMPORTS');
      }
    }
  }

  return { edges: toolEdges, nodes };
}

// ── 1. Name-swap invariance ───────────────────────────────────────────────────

describe('1. Name-swap invariance', () => {
  it('scores identically regardless of which recognized accessor convention the tool uses', () => {
    // Oracle always uses its own get:/set: convention (ts-typechecker.oracle.ts).
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 20,
        kind: 'Class',
        localId: 'Foo',
        name: 'Foo',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
      {
        endLine: 5,
        kind: 'Constructor',
        localId: 'Foo.constructor',
        name: 'constructor',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 2,
      },
      {
        endLine: 9,
        kind: 'Method',
        localId: 'Foo.get:min',
        name: 'get:min',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 6,
      },
      {
        endLine: 13,
        kind: 'Method',
        localId: 'Foo.set:min',
        name: 'set:min',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 10,
      },
      {
        endLine: 18,
        kind: 'Method',
        localId: 'Foo.bar',
        name: 'bar',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 14,
      },
    ];

    // Two tools, each internally consistent, but using DIFFERENT accessor
    // conventions from each other and from the oracle. Both also emit an
    // unnamed inline-callback node ('[anonymous]') — unmatchable on both
    // sides, so it must not tip the score either way.
    const toolAccessorConvention = (
      get: (n: string) => string,
      set: (n: string) => string
    ): GraphNode[] => [
      mkToolNode('t:Foo', 'Foo', 'src/a.ts', 1, 'Class'),
      mkToolNode('t:ctor', 'constructor', 'src/a.ts', 2, 'Constructor'),
      mkToolNode('t:get', get('min'), 'src/a.ts', 6, 'Method'),
      mkToolNode('t:set', set('min'), 'src/a.ts', 10, 'Method'),
      mkToolNode('t:bar', 'bar', 'src/a.ts', 14, 'Method'),
      mkToolNode('t:anon', '[anonymous]', 'src/a.ts', 16, 'Function'),
    ];

    const toolA = toolAccessorConvention(
      (n) => `get:${n}`,
      (n) => `set:${n}`
    ); // oracle's own convention
    const toolB = toolAccessorConvention(
      (n) => `[get]${n}`,
      (n) => `[set]${n}`
    ); // bracketed convention

    const reportA = scoreD2(toolA, [], oracleSymbols, []);
    const reportB = scoreD2(toolB, [], oracleSymbols, []);

    expect(reportA.nodes.overall.f1).toBeCloseTo(1, 5);
    expect(reportB.nodes.overall.f1).toBeCloseTo(1, 5);
    expect(Math.abs(reportA.nodes.overall.f1 - reportB.nodes.overall.f1)).toBeLessThanOrEqual(
      0.005
    );
    expect(Math.abs(reportA.nodes.macroF1 - reportB.nodes.macroF1)).toBeLessThanOrEqual(0.005);
    // Neither convention accidentally scores the anonymous node as FP.
    expect(reportA.nodes.overall.fp).toBe(0);
    expect(reportB.nodes.overall.fp).toBe(0);
  });
});

// ── 2. Oracle-blindness invariance ────────────────────────────────────────────

describe('2. Oracle-blindness invariance', () => {
  it('a tool modelling declare module / declare global / .d.ts / mixin extends scores zero FP', () => {
    // These four constructs were the oracle's actual blind spots pre-F3/F12
    // (CODE_GRAPH_EVAL_FAIRNESS_PLAN.md F3, F12): tool nodes/edges for them
    // used to be charged as FP because the oracle simply had no row to match
    // against. Post-fix, the oracle sees all four — so this fixture now
    // serves as the regression guard: if the F3/F12 fix ever regresses, the
    // FP set for a tool that still models these constructs reappears here.
    const { symbols, edges } = runOracle({
      'x.ts': 'export interface Base { id: number }',
      'ambient.d.ts': `
        declare class AmbientThing {
          doStuff(): void;
        }
      `,
      'a.ts': `
        declare module "./x" {
          export interface Y {
            z(): void;
          }
        }
        declare global {
          interface Window {
            w: number;
          }
        }
        function Mixin<T extends new (...args: any[]) => object>(Ctor: T) {
          return class extends Ctor {};
        }
        class Base2 {}
        export class Derived extends Mixin(Base2) {}
        export {};
      `,
    });

    const { nodes: toolNodes, edges: toolEdges } = buildPerfectToolFromOracle(symbols, edges);
    const report = scoreD2(toolNodes, toolEdges, symbols, edges);

    expect(report.nodes.overall.fp).toBe(0);
    expect(report.edges.overall.fp).toBe(0);
    // Sanity: the fixture actually exercises the four constructs (a vacuous
    // fixture with nothing extracted would trivially pass with fp=0).
    expect(symbols.some((s) => s.kind === 'Module' && s.name === './x')).toBe(true);
    expect(symbols.some((s) => s.kind === 'Namespace' && s.name === 'global')).toBe(true);
    expect(symbols.some((s) => s.name === 'AmbientThing')).toBe(true);
    expect(edges.some((e) => e.type === 'EXT***REMOVED***S' && e.fromLocalId === 'Derived')).toBe(true);
  });
});

// ── 3. Granularity invariance ─────────────────────────────────────────────────

describe('3. Granularity invariance', () => {
  it('a tool modelling both File→File and File→Symbol IMPORTS scores no worse than one modelling only File→Symbol', () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 15,
        kind: 'Function',
        localId: 'helper',
        name: 'helper',
        parentLocalId: null,
        path: 'src/b.ts',
        startLine: 13,
      },
    ];
    const oracleImportEdges: OracleEdge[] = [
      {
        fromLocalId: 'src/a.ts',
        fromPath: 'src/a.ts',
        targetLocalId: 'helper',
        targetName: 'helper',
        targetPath: 'src/b.ts',
        targetStartLine: 13,
        type: 'IMPORTS',
      },
    ];
    const fileA = mkToolNode('t:fileA', 'a.ts', 'src/a.ts', null, 'File');
    const fileB = mkToolNode('t:fileB', 'b.ts', 'src/b.ts', null, 'File');
    const helperNode = mkToolNode('t:helper', 'helper', 'src/b.ts', 13, 'Function');

    const nodes = [fileA, fileB, helperNode];
    const symbolOnlyEdges = [mkToolEdge('t:fileA', 't:helper', 'IMPORTS')];
    const fileOnlyEdges = [mkToolEdge('t:fileA', 't:fileB', 'IMPORTS')];
    const bothEdges = [...symbolOnlyEdges, ...fileOnlyEdges];

    const symbolOnlyReport = scoreD2(nodes, symbolOnlyEdges, oracleSymbols, oracleImportEdges);
    const fileOnlyReport = scoreD2(nodes, fileOnlyEdges, oracleSymbols, oracleImportEdges);
    const bothReport = scoreD2(nodes, bothEdges, oracleSymbols, oracleImportEdges);

    // Symbol-level table is untouched by the extra File→File edge (F6) — a
    // tool modelling both is never worse than one modelling only File→Symbol.
    expect(bothReport.edges.byType.IMPORTS?.precision).toBeCloseTo(
      symbolOnlyReport.edges.byType.IMPORTS?.precision ?? -1,
      5
    );
    expect(bothReport.edges.byType.IMPORTS?.recall).toBeCloseTo(
      symbolOnlyReport.edges.byType.IMPORTS?.recall ?? -1,
      5
    );
    // Module-level table is derived from each edge's endpoint *paths*, not
    // its node *kind* — so a File→Symbol-only tool already gets full credit
    // for the file-level dependency too (the pair is the same either way).
    // "Both" must never score below "symbol-only" here; it does not, because
    // there is no lower score to fall to.
    expect(symbolOnlyReport.edges.importsModuleLevel.recall).toBe(1);
    expect(bothReport.edges.importsModuleLevel.recall).toBe(1);
    expect(bothReport.edges.importsModuleLevel.recall).toBeGreaterThanOrEqual(
      symbolOnlyReport.edges.importsModuleLevel.recall
    );
    // The genuinely worse-off tool is the FILE-ONLY one — it can never
    // compete at symbol granularity by construction (F6's routing excludes
    // it from that table entirely rather than charging it as FP/FN there).
    expect(fileOnlyReport.edges.byType.IMPORTS?.tp ?? 0).toBe(0);
    expect(fileOnlyReport.edges.byType.IMPORTS?.fp ?? 0).toBe(0);
    expect(bothReport.edges.byType.IMPORTS?.tp ?? 0).toBeGreaterThanOrEqual(
      fileOnlyReport.edges.byType.IMPORTS?.tp ?? 0
    );
  });
});

// ── 4. Denominator soundness — PerfectTool ────────────────────────────────────

describe('4. Denominator soundness — PerfectTool scores 100% on every metric', () => {
  const { symbols, edges } = runOracle({
    'greeter.ts': `
      export interface Greeter {
        greet(): void;
      }
    `,
    'payload.ts': `
      export class Payload {}
    `,
    'base.ts': `
      import { Greeter } from './greeter';
      export class Base implements Greeter {
        greet(): void {}
      }
    `,
    'derived.ts': `
      import { Base } from './base';
      import { Payload } from './payload';
      export class Derived extends Base {
        greet(): void {
          this.helper();
        }
        helper(): void {}
        process(p: Payload): void {}
      }
    `,
  });

  const { nodes: toolNodes, edges: toolEdges } = buildPerfectToolFromOracle(symbols, edges);
  const report = scoreD2(toolNodes, toolEdges, symbols, edges);

  it('scores node identity P=R=F1=1.0', () => {
    expect(report.nodes.overall.precision).toBe(1);
    expect(report.nodes.overall.recall).toBe(1);
    expect(report.nodes.overall.f1).toBe(1);
  });

  it('scores macro F1 = 1.0', () => {
    expect(report.nodes.macroF1).toBe(1);
  });

  it('scores comparable edges (CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS) P=R=F1=1.0', () => {
    expect(report.edges.overall.precision).toBe(1);
    expect(report.edges.overall.recall).toBe(1);
    expect(report.edges.overall.f1).toBe(1);
  });

  it('scores module-level IMPORTS P=R=1.0', () => {
    expect(report.edges.importsModuleLevel.precision).toBe(1);
    expect(report.edges.importsModuleLevel.recall).toBe(1);
  });

  it('scores member-level IMPLEMENTS P=R=F1=1.0', () => {
    expect(report.edges.implementsMemberLevel.precision).toBe(1);
    expect(report.edges.implementsMemberLevel.recall).toBe(1);
    expect(report.edges.implementsMemberLevel.f1).toBe(1);
  });

  it('scores METHOD_OVERRIDES P=R=F1=1.0', () => {
    const overrides = report.edges.extendedByType.METHOD_OVERRIDES;
    expect(overrides?.precision).toBe(1);
    expect(overrides?.recall).toBe(1);
    expect(overrides?.f1).toBe(1);
  });

  it('scores USES_TYPE (strict) P=R=F1=1.0', () => {
    const usesType = report.edges.extendedByType.USES_TYPE;
    expect(usesType?.precision).toBe(1);
    expect(usesType?.recall).toBe(1);
    expect(usesType?.f1).toBe(1);
  });

  it('scores METHOD_OVERRIDES from-agnostic P=R=F1=1.0', () => {
    const overrides = report.edges.methodOverridesFromAgnostic;
    expect(overrides.precision).toBe(1);
    expect(overrides.recall).toBe(1);
    expect(overrides.f1).toBe(1);
  });
});

// ── Phase 5, item 2 — METHOD_OVERRIDES from-side attribution mismatch ─────────

describe('Phase 5 — METHOD_OVERRIDES: Class-attributed tool vs Method-attributed oracle', () => {
  // Mirrors GitNexus's own convention verified against data/gitnexus/edges.jsonl:
  // fromId is the derived Class, not the overriding Method. The oracle
  // attributes fromLocalId to the overriding Method. Scored strictly
  // (extendedByType), this forces 0 TP by construction — the bug this test
  // guards against regressing.
  const { symbols, edges } = runOracle({
    'base.ts': `
      export class Base {
        greet(): void {}
      }
    `,
    'derived.ts': `
      import { Base } from './base';
      export class Derived extends Base {
        greet(): void {}
      }
    `,
  });

  const derivedClass = symbols.find((s) => s.name === 'Derived' && s.kind === 'Class');
  const derivedMethod = symbols.find((s) => s.localId === 'Derived.greet');
  const baseMethod = symbols.find((s) => s.localId === 'Base.greet');
  if (!(derivedClass && derivedMethod && baseMethod)) {
    throw new Error('fixture setup failed to locate expected oracle symbols');
  }

  const toolNodes: GraphNode[] = [
    mkToolNode('cls:Derived', 'Derived', derivedClass.path, derivedClass.startLine, 'Class'),
    mkToolNode('cls:Base', 'Base', baseMethod.path, 1, 'Class'),
    mkToolNode('m:Derived.greet', 'greet', derivedMethod.path, derivedMethod.startLine, 'Method'),
    mkToolNode('m:Base.greet', 'greet', baseMethod.path, baseMethod.startLine, 'Method'),
  ];
  // Class-attributed, like GitNexus: fromId is the Class, not the Method.
  const toolEdges: GraphEdge[] = [mkToolEdge('cls:Derived', 'm:Base.greet', 'METHOD_OVERRIDES')];

  const report = scoreD2(toolNodes, toolEdges, symbols, edges);

  it('strict extendedByType scores 0 TP by construction (the pre-fix symptom)', () => {
    const strict = report.edges.extendedByType.METHOD_OVERRIDES;
    expect(strict?.tp).toBe(0);
    expect(strict?.fp).toBe(1);
  });

  it('from-agnostic scoring confirms the same edge as a true positive', () => {
    const fromAgnostic = report.edges.methodOverridesFromAgnostic;
    expect(fromAgnostic.tp).toBe(1);
    expect(fromAgnostic.fp).toBe(0);
    expect(fromAgnostic.precision).toBe(1);
  });
});

// ── 5. Symmetry audit ──────────────────────────────────────────────────────────

describe('5. Symmetry audit', () => {
  it("scoreD2's output for a graph is unaffected by which tool name it is filed under", () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 10,
        kind: 'Class',
        localId: 'Foo',
        name: 'Foo',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
      {
        endLine: 8,
        kind: 'Method',
        localId: 'Foo.bar',
        name: 'bar',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 3,
      },
    ];
    const oracleEdges: OracleEdge[] = [];

    // graphX: perfect match. graphY: one FP, one FN.
    const graphX = {
      edges: [] as GraphEdge[],
      nodes: [
        mkToolNode('x:Foo', 'Foo', 'src/a.ts', 1, 'Class'),
        mkToolNode('x:bar', 'bar', 'src/a.ts', 3, 'Method'),
      ],
    };
    const graphY = {
      edges: [] as GraphEdge[],
      nodes: [
        mkToolNode('y:Foo', 'Foo', 'src/a.ts', 1, 'Class'),
        mkToolNode('y:Ghost', 'Ghost', 'src/a.ts', 99, 'Function'),
      ],
    };

    const scoreOf = (g: { edges: GraphEdge[]; nodes: GraphNode[] }) =>
      scoreD2(g.nodes, g.edges, oracleSymbols, oracleEdges);

    // Simulate runner.ts's `for (const [name, graph] of Object.entries(graphs))`
    // loop under two different name→graph labelings of the SAME two graphs.
    const labelingA: Record<string, typeof graphX> = { Alpha: graphX, Beta: graphY };
    const labelingB: Record<string, typeof graphX> = { Alpha: graphY, Beta: graphX };

    const resultsA = Object.fromEntries(Object.entries(labelingA).map(([n, g]) => [n, scoreOf(g)]));
    const resultsB = Object.fromEntries(Object.entries(labelingB).map(([n, g]) => [n, scoreOf(g)]));

    // graphX's score is identical whether it's called "Alpha" or "Beta" —
    // scoreD2 has no branch keyed on the tool-name string.
    expect(resultsA.Alpha.nodes.overall.f1).toBe(resultsB.Beta.nodes.overall.f1);
    expect(resultsA.Alpha.nodes.overall.tp).toBe(resultsB.Beta.nodes.overall.tp);
    expect(resultsA.Beta.nodes.overall.f1).toBe(resultsB.Alpha.nodes.overall.f1);
    expect(resultsA.Beta.nodes.overall.fp).toBe(resultsB.Alpha.nodes.overall.fp);
    // And the two graphs are NOT interchangeable (sanity: the test isn't
    // vacuously true because both graphs happen to score the same).
    expect(resultsA.Alpha.nodes.overall.f1).not.toBe(resultsA.Beta.nodes.overall.f1);
  });
});

// ── VSCODE_ORACLE_RESOLUTION_FIX_PLAN.md Phase B ──────────────────────────────

// ── F18 — unscoreable oracle rows neutralise a matching tool edge ────────────

describe('F18 — unscoreable oracle rows neutralise a matching tool edge, not fail it', () => {
  it('routes a tool edge that only matches a scoreable:false oracle row to unscoreableMatched, not FP', () => {
    const fileNode = mkToolNode('t:file', 'a.ts', 'src/a.ts', null, 'File');
    const targetNode = mkToolNode('t:uri', 'URI', 'src/uri.ts', 1, 'Class');
    const toolEdge = mkToolEdge('t:file', 't:uri', 'IMPORTS');

    const oracleEdge: OracleEdge = {
      fromLocalId: 'src/a.ts',
      fromPath: 'src/a.ts',
      scoreable: false,
      targetName: 'URI',
      type: 'IMPORTS',
    };

    const result = adjudicateEdges([toolEdge], [fileNode, targetNode], [oracleEdge], [], []);

    expect(result.falsePositives.length).toBe(0);
    expect(result.unscoreableMatched.length).toBe(1);
    expect(result.truePositives.length).toBe(0);
    expect(result.falseNegatives.length).toBe(0);
  });

  it('still charges FP when nothing in the unscoreable set matches by name (no over-triggering)', () => {
    const fileNode = mkToolNode('t:file', 'a.ts', 'src/a.ts', null, 'File');
    const bogusNode = mkToolNode('t:bogus', 'Bogus', 'src/bogus.ts', 1, 'Class');
    const toolEdge = mkToolEdge('t:file', 't:bogus', 'IMPORTS');

    // A genuinely scoreable oracle row with a DIFFERENT target — the tool
    // edge matches neither this row nor anything in the (empty) unscoreable
    // set, so it must still be a false positive.
    const oracleEdge: OracleEdge = {
      fromLocalId: 'src/a.ts',
      fromPath: 'src/a.ts',
      scoreable: true,
      targetLocalId: 'Real',
      targetName: 'Real',
      targetPath: 'src/real.ts',
      targetStartLine: 1,
      type: 'IMPORTS',
    };

    const result = adjudicateEdges([toolEdge], [fileNode, bogusNode], [oracleEdge], [], []);

    expect(result.unscoreableMatched.length).toBe(0);
    expect(result.falsePositives.length).toBe(1);
  });
});

// ── F21 — from-side-agnostic scorers match by identity OR by name ────────────

describe('F21 — from-side-agnostic scorers match by identity or by name', () => {
  it('USES_TYPE agnostic recovers a TP the strict table forces to 0 (misattributed container + unbound target)', () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 10,
        kind: 'Class',
        localId: 'Container',
        name: 'Container',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
      {
        endLine: 5,
        kind: 'Method',
        localId: 'Container.run',
        name: 'run',
        parentLocalId: 'Container',
        path: 'src/a.ts',
        startLine: 3,
      },
      {
        endLine: 3,
        kind: 'Class',
        localId: 'Widget',
        name: 'Widget',
        parentLocalId: null,
        path: 'src/b.ts',
        startLine: 1,
      },
    ];
    const oracleEdges: OracleEdge[] = [
      {
        fromLocalId: 'Container.run',
        fromPath: 'src/a.ts',
        targetLocalId: 'Widget',
        targetName: 'Widget',
        targetPath: 'src/b.ts',
        targetStartLine: 1,
        type: 'USES_TYPE',
      },
    ];

    // Tool attributes the reference to the CLASS (misattribution vs the
    // oracle's Method), and the referenced type resolves through a re-export
    // at a different path than the oracle's declaration site — so the
    // to-node never binds to the oracle's `Widget` symbol, even though its
    // raw name is identical.
    const containerNode = mkToolNode('t:Container', 'Container', 'src/a.ts', 1, 'Class');
    const widgetRefNode = mkToolNode('t:widgetRef', 'Widget', 'src/c.ts', 1, 'Class');
    const toolNodes = [containerNode, widgetRefNode];
    const toolEdges = [mkToolEdge('t:Container', 't:widgetRef', 'USES_TYPE')];

    const report = scoreD2(toolNodes, toolEdges, oracleSymbols, oracleEdges);

    const strict = report.edges.extendedByType.USES_TYPE;
    expect(strict?.tp).toBe(0); // ftKey mismatch: tool attributed to 'Container', oracle to 'Container.run'

    const agnostic = report.edges.usesTypeFromAgnostic;
    expect(agnostic.tp).toBe(1); // recovered by fromPath + target-name matching
    expect(agnostic.tp).toBeGreaterThanOrEqual(strict?.tp ?? 0);
  });

  it('METHOD_OVERRIDES agnostic recovers a TP the strict table forces to 0 (misattributed container + unbound target)', () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 10,
        kind: 'Class',
        localId: 'Derived',
        name: 'Derived',
        parentLocalId: null,
        path: 'src/derived.ts',
        startLine: 1,
      },
      {
        endLine: 5,
        kind: 'Method',
        localId: 'Derived.greet',
        name: 'greet',
        parentLocalId: 'Derived',
        path: 'src/derived.ts',
        startLine: 3,
      },
      {
        endLine: 5,
        kind: 'Method',
        localId: 'Base.greet',
        name: 'greet',
        parentLocalId: 'Base',
        path: 'src/base.ts',
        startLine: 3,
      },
    ];
    const oracleEdges: OracleEdge[] = [
      {
        fromLocalId: 'Derived.greet',
        fromPath: 'src/derived.ts',
        targetLocalId: 'Base.greet',
        targetName: 'greet',
        targetPath: 'src/base.ts',
        targetStartLine: 3,
        type: 'METHOD_OVERRIDES',
      },
    ];

    // GitNexus-style: attributes the override to the containing CLASS. The
    // base method reference resolves through a different path than the
    // oracle's declaration site, so it never binds — same shape as the
    // USES_TYPE case above.
    const derivedClassNode = mkToolNode('cls:Derived', 'Derived', 'src/derived.ts', 1, 'Class');
    const baseGreetRefNode = mkToolNode(
      't:baseGreetRef',
      'greet',
      'src/base-alias.ts',
      9,
      'Method'
    );
    const toolNodes = [derivedClassNode, baseGreetRefNode];
    const toolEdges = [mkToolEdge('cls:Derived', 't:baseGreetRef', 'METHOD_OVERRIDES')];

    const report = scoreD2(toolNodes, toolEdges, oracleSymbols, oracleEdges);

    const strict = report.edges.extendedByType.METHOD_OVERRIDES;
    expect(strict?.tp).toBe(0);

    const agnostic = report.edges.methodOverridesFromAgnostic;
    expect(agnostic.tp).toBe(1);
    expect(agnostic.tp).toBeGreaterThanOrEqual(strict?.tp ?? 0);
  });
});

// ── F22 — duplicate rows are collapsed before matching, not scored ───────────

describe('F22 — duplicate rows are collapsed before matching, not scored', () => {
  it("collapses a tool's exact-duplicate node row instead of charging it as FP", () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 5,
        kind: 'Class',
        localId: 'Foo',
        name: 'Foo',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
    ];
    const toolNodes = [
      mkToolNode('t1', 'Foo', 'src/a.ts', 1, 'Class'),
      mkToolNode('t2', 'Foo', 'src/a.ts', 1, 'Class'), // exact duplicate row
    ];

    const result = matchNodes(toolNodes, oracleSymbols);

    expect(result.duplicateToolNodesCollapsed).toBe(1);
    expect(result.matched.length).toBe(1);
    expect(result.toolUnmatched.length).toBe(0);
  });

  it("collapses duplicate oracle rows so a kind's tp+fn total is identical regardless of which tool is scored", () => {
    const dupOracleSymbols: OracleSymbol[] = [
      {
        endLine: 5,
        kind: 'Class',
        localId: 'Foo',
        name: 'Foo',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
      // Duplicate oracle row — same (path, localId), simulating a data glitch.
      {
        endLine: 5,
        kind: 'Class',
        localId: 'Foo',
        name: 'Foo',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
    ];
    const toolThatMatches = [mkToolNode('t1', 'Foo', 'src/a.ts', 1, 'Class')];
    const toolThatMisses: GraphNode[] = [];

    const resultMatch = matchNodes(toolThatMatches, dupOracleSymbols);
    const resultMiss = matchNodes(toolThatMisses, dupOracleSymbols);

    expect(resultMatch.oracleUnmatched.length).toBe(0);
    expect(resultMiss.oracleUnmatched.length).toBe(1); // deduped to one row, not two

    const tpPlusFn = (r: typeof resultMatch) => r.matched.length + r.oracleUnmatched.length;
    expect(tpPlusFn(resultMatch)).toBe(tpPlusFn(resultMiss));
  });
});

// ── F24 — D1 and D2 report identical numbers for the same edge type ──────────

describe('F24 — D1 and D2 partition edges identically for the same tool and type', () => {
  it('agree on IMPORTS TP/FP even when the tool also emits a File-granularity IMPORTS edge', () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 1,
        kind: 'Function',
        localId: 'Baz',
        name: 'Baz',
        parentLocalId: null,
        path: 'src/c.ts',
        startLine: 1,
      },
    ];
    const oracleEdges: OracleEdge[] = [
      {
        fromLocalId: 'src/a.ts',
        fromPath: 'src/a.ts',
        scoreable: true,
        targetLocalId: 'Baz',
        targetName: 'Baz',
        targetPath: 'src/c.ts',
        targetStartLine: 1,
        type: 'IMPORTS',
      },
    ];

    const toolNodes: GraphNode[] = [
      mkToolNode('fileA', 'src/a.ts', 'src/a.ts', null, 'File'),
      mkToolNode('fileC', 'src/c.ts', 'src/c.ts', null, 'File'),
      mkToolNode('nBaz', 'Baz', 'src/c.ts', 1, 'Function'),
    ];
    const toolEdges: GraphEdge[] = [
      mkToolEdge('fileA', 'nBaz', 'IMPORTS'), // symbol-level — a genuine TP
      mkToolEdge('fileA', 'fileC', 'IMPORTS'), // F6: File-granularity — must be excluded from BOTH scorers' main table, not charged FP here
    ];

    const d1 = scoreD1(toolNodes, toolEdges, oracleSymbols, oracleEdges);
    const d2 = scoreD2(toolNodes, toolEdges, oracleSymbols, oracleEdges);

    const d1Imports = d1.perType.find((m) => m.edgeType === 'IMPORTS');
    const d2Imports = d2.edges.byType.IMPORTS;

    expect(d1Imports?.tp).toBe(d2Imports?.tp);
    expect(d1Imports?.fp).toBe(d2Imports?.fp);
    expect(d1Imports?.fn).toBe(d2Imports?.fn);
    // The File-granularity pair must not be charged FP anywhere in this table —
    // it's scored separately at module level (F6).
    expect(d1Imports?.fp).toBe(0);
    expect(d1Imports?.tp).toBe(1);
  });

  it('agree on IMPLEMENTS TP/FP, excluding member-level satisfaction from the class-level table', () => {
    const oracleSymbols: OracleSymbol[] = [
      {
        endLine: 5,
        kind: 'Class',
        localId: 'Foo',
        name: 'Foo',
        parentLocalId: null,
        path: 'src/a.ts',
        startLine: 1,
      },
      {
        endLine: 5,
        kind: 'Interface',
        localId: 'IBar',
        name: 'IBar',
        parentLocalId: null,
        path: 'src/b.ts',
        startLine: 1,
      },
      {
        endLine: 3,
        kind: 'Method',
        localId: 'Foo.bar',
        name: 'bar',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 2,
      },
    ];
    const oracleEdges: OracleEdge[] = [
      {
        // class-level: Foo implements IBar
        fromLocalId: 'Foo',
        fromPath: 'src/a.ts',
        scoreable: true,
        targetLocalId: 'IBar',
        targetName: 'IBar',
        targetPath: 'src/b.ts',
        targetStartLine: 1,
        type: 'IMPLEMENTS',
      },
      {
        // member-level (F8): Foo.bar satisfies IBar.bar
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        scoreable: true,
        targetName: 'bar',
        type: 'IMPLEMENTS',
      },
    ];

    const toolNodes: GraphNode[] = [
      mkToolNode('nFoo', 'Foo', 'src/a.ts', 1, 'Class'),
      mkToolNode('nIBar', 'IBar', 'src/b.ts', 1, 'Interface'),
      mkToolNode('nFooBar', 'bar', 'src/a.ts', 2, 'Method'),
      mkToolNode('nIBarBar', 'bar', 'src/b.ts', 2, 'Method'),
    ];
    const toolEdges: GraphEdge[] = [
      mkToolEdge('nFoo', 'nIBar', 'IMPLEMENTS'), // class-level
      mkToolEdge('nFooBar', 'nIBarBar', 'IMPLEMENTS'), // member-level — must not land in the class-level table
    ];

    const d1 = scoreD1(toolNodes, toolEdges, oracleSymbols, oracleEdges);
    const d2 = scoreD2(toolNodes, toolEdges, oracleSymbols, oracleEdges);

    const d1Implements = d1.perType.find((m) => m.edgeType === 'IMPLEMENTS');
    const d2Implements = d2.edges.byType.IMPLEMENTS;

    expect(d1Implements?.tp).toBe(d2Implements?.tp);
    expect(d1Implements?.fp).toBe(d2Implements?.fp);
    expect(d1Implements?.fn).toBe(d2Implements?.fn);
    expect(d1Implements?.tp).toBe(1); // only the class-level pair
    expect(d1Implements?.fp).toBe(0);

    // The member-level pair is scored in its own table, and only there.
    expect(d2.edges.implementsMemberLevel.tp).toBe(1);
  });
});
