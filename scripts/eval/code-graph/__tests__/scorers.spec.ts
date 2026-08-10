import { describe, expect, it } from 'bun:test';
import { adjudicateEdges } from '../matching/edge-adjudicator';
import { scoreD1 } from '../scorers/d1-depth.scorer';
import { scoreD2 } from '../scorers/d2-fidelity.scorer';
import type { GraphEdge, GraphNode, OracleEdge, OracleSymbol } from '../types';

// Synthetic fixture: one file, one class with a method that calls another function
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
  {
    endLine: 15,
    kind: 'Function',
    localId: 'helper',
    name: 'helper',
    parentLocalId: null,
    path: 'src/a.ts',
    startLine: 13,
  },
];

const oracleEdges: OracleEdge[] = [
  { fromLocalId: 'Foo.bar', fromPath: 'src/a.ts', targetName: 'helper', type: 'CALLS' },
];

// Tool graph: matches the oracle perfectly
function mkToolNode(
  id: string,
  name: string,
  path: string,
  startLine: number,
  kind: GraphNode['kind']
): GraphNode {
  return { endLine: null, id, kind, name, parentId: null, path, startLine };
}
function mkToolEdge(
  fromId: string,
  toId: string,
  type: GraphEdge['type'],
  resolved = true
): GraphEdge {
  return { confidence: null, fromId, resolved, toId, type };
}

const perfectToolNodes: GraphNode[] = [
  mkToolNode('t:Foo', 'Foo', 'src/a.ts', 1, 'Class'),
  mkToolNode('t:Foo.bar', 'bar', 'src/a.ts', 3, 'Method'),
  mkToolNode('t:helper', 'helper', 'src/a.ts', 13, 'Function'),
];
const perfectToolEdges: GraphEdge[] = [mkToolEdge('t:Foo.bar', 't:helper', 'CALLS')];

describe('scoreD2 — perfect tool', () => {
  it('reports P=R=F1=1.0 for nodes and edges', () => {
    const report = scoreD2(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges);
    expect(report.nodes.overall.precision).toBe(1);
    expect(report.nodes.overall.recall).toBe(1);
    expect(report.nodes.overall.f1).toBe(1);
    expect(report.edges.overall.precision).toBe(1);
    expect(report.edges.overall.recall).toBe(1);
    expect(report.edges.overall.f1).toBe(1);
  });

  it('reports macroF1 = 1.0', () => {
    const report = scoreD2(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges);
    expect(report.nodes.macroF1).toBe(1);
  });
});

describe('scoreD2 — tool with extra + missing nodes', () => {
  it('penalizes FP and FN', () => {
    // Tool has an extra node (Ghost) and misses 'helper'
    const toolNodes: GraphNode[] = [
      mkToolNode('t:Foo', 'Foo', 'src/a.ts', 1, 'Class'),
      mkToolNode('t:Foo.bar', 'bar', 'src/a.ts', 3, 'Method'),
      mkToolNode('t:Ghost', 'Ghost', 'src/a.ts', 99, 'Function'),
    ];
    const report = scoreD2(toolNodes, [], oracleSymbols, oracleEdges);
    // 2 matched (Foo, Foo.bar), 1 FP (Ghost), 1 FN (helper)
    expect(report.nodes.overall.tp).toBe(2);
    expect(report.nodes.overall.fp).toBe(1);
    expect(report.nodes.overall.fn).toBe(1);
    expect(report.nodes.overall.precision).toBeCloseTo(2 / 3, 5);
    expect(report.nodes.overall.recall).toBeCloseTo(2 / 3, 5);
  });
});

describe('scoreD2 — edges', () => {
  it('counts edge FP when tool claims a call the oracle does not have', () => {
    const toolEdges: GraphEdge[] = [
      mkToolEdge('t:Foo.bar', 't:helper', 'CALLS'),
      mkToolEdge('t:Foo.bar', 't:Ghost', 'CALLS'), // FP — oracle has no call to Ghost
    ];
    const toolNodes: GraphNode[] = [
      ...perfectToolNodes,
      mkToolNode('t:Ghost', 'Ghost', 'src/a.ts', 99, 'Function'),
    ];
    const report = scoreD2(toolNodes, toolEdges, oracleSymbols, oracleEdges);
    expect(report.edges.byType.CALLS?.tp).toBe(1);
    expect(report.edges.byType.CALLS?.fp).toBe(1);
  });

  it('counts edge FN when tool misses an oracle edge', () => {
    const report = scoreD2(perfectToolNodes, [], oracleSymbols, oracleEdges);
    expect(report.edges.byType.CALLS?.fn).toBe(1);
    expect(report.edges.byType.CALLS?.tp).toBe(0);
  });
});

describe('scoreD1 — resolved-edge slicing', () => {
  it('reports resolvedConfirmed when includeResolvedSlice=true', () => {
    const report = scoreD1(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges, true);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.resolvedTotal).toBe(1);
    expect(calls?.resolvedConfirmed).toBe(1);
    expect(calls?.oracleConfirmed).toBe(1);
  });

  it('does not include resolved fields when includeResolvedSlice=false', () => {
    const report = scoreD1(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges, false);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.resolvedConfirmed).toBeUndefined();
  });

  it('a tool with resolved edges gets the slice when includeResolvedSlice is true', () => {
    const toolEdges: GraphEdge[] = [
      { confidence: null, fromId: 't:Foo.bar', resolved: true, toId: 't:helper', type: 'CALLS' },
      { confidence: null, fromId: 't:Foo.bar', resolved: false, toId: 't:Foo.bar', type: 'CALLS' },
    ];
    const report = scoreD1(perfectToolNodes, toolEdges, oracleSymbols, oracleEdges, true);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.resolvedTotal).toBe(1);
    expect(calls?.resolvedConfirmed).toBe(1);
  });

  it('a tool with no resolved edges gets no slice fields even with includeResolvedSlice=true', () => {
    const unresolvedEdges: GraphEdge[] = [
      { confidence: null, fromId: 't:Foo.bar', resolved: null, toId: 't:helper', type: 'CALLS' },
    ];
    const report = scoreD1(perfectToolNodes, unresolvedEdges, oracleSymbols, oracleEdges, true);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.resolvedTotal).toBe(0);
    expect(calls?.resolvedConfirmed).toBe(0);
  });
});

describe('scoreD2 — IMPORTS granularity routing (F6)', () => {
  it('scores a File→File IMPORTS edge only in the module-level table, never as a symbol-level FP', () => {
    const oracleImportEdges: OracleEdge[] = [
      {
        fromLocalId: 'src/a.ts',
        fromPath: 'src/a.ts',
        targetName: 'helper',
        targetPath: 'src/b.ts',
        type: 'IMPORTS',
      },
    ];
    const toolNodes: GraphNode[] = [
      mkToolNode('t:fileA', 'a.ts', 'src/a.ts', 1, 'File'),
      mkToolNode('t:fileB', 'b.ts', 'src/b.ts', 1, 'File'),
    ];
    const toolEdges: GraphEdge[] = [mkToolEdge('t:fileA', 't:fileB', 'IMPORTS')];
    const report = scoreD2(toolNodes, toolEdges, [], oracleImportEdges);
    // The File→File edge must never be charged as a symbol-level FP.
    expect(report.edges.byType.IMPORTS?.fp).toBe(0);
    // It's still scored (as a TP) at module-level, where the oracle's resolved
    // targetPath makes the same file-pair achievable.
    expect(report.edges.importsModuleLevel.tp).toBe(1);
  });

  it('a tool emitting both File→File and File→Symbol for the same import is not double-penalized', () => {
    const oracleSyms: OracleSymbol[] = [
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
        targetName: 'helper',
        targetPath: 'src/b.ts',
        type: 'IMPORTS',
      },
    ];
    const toolNodes: GraphNode[] = [
      mkToolNode('t:fileA', 'a.ts', 'src/a.ts', 1, 'File'),
      mkToolNode('t:fileB', 'b.ts', 'src/b.ts', 1, 'File'),
      mkToolNode('t:helper', 'helper', 'src/b.ts', 13, 'Function'),
    ];
    const toolEdges: GraphEdge[] = [
      mkToolEdge('t:fileA', 't:fileB', 'IMPORTS'), // module-level
      mkToolEdge('t:fileA', 't:helper', 'IMPORTS'), // symbol-level
    ];
    const report = scoreD2(toolNodes, toolEdges, oracleSyms, oracleImportEdges);
    expect(report.edges.byType.IMPORTS?.fp).toBe(0);
    expect(report.edges.byType.IMPORTS?.tp).toBe(1);
    expect(report.edges.importsModuleLevel.tp).toBe(1);
  });
});

describe('adjudicateEdges — path-qualified oracle keys (F11)', () => {
  it('a call in file A is not confirmed by an oracle edge from a same-named container in file B', () => {
    // Two files each declare `class Foo { bar() { baz() } }`. localId 'Foo.bar'
    // recurs in both — without path-qualification a tool edge emitted only in
    // file A could be "confirmed" twice or file B's row wrongly cleared.
    const oracleSymbolsAB: OracleSymbol[] = [
      {
        endLine: 5,
        kind: 'Method',
        localId: 'Foo.bar',
        name: 'bar',
        parentLocalId: 'Foo',
        path: 'src/a.ts',
        startLine: 1,
      },
      {
        endLine: 5,
        kind: 'Method',
        localId: 'Foo.bar',
        name: 'bar',
        parentLocalId: 'Foo',
        path: 'src/b.ts',
        startLine: 1,
      },
    ];
    const oracleEdgesAB: OracleEdge[] = [
      { fromLocalId: 'Foo.bar', fromPath: 'src/a.ts', targetName: 'baz', type: 'CALLS' },
      { fromLocalId: 'Foo.bar', fromPath: 'src/b.ts', targetName: 'baz', type: 'CALLS' },
    ];
    const toolNodes: GraphNode[] = [
      mkToolNode('t:a:Foo.bar', 'bar', 'src/a.ts', 1, 'Method'),
      mkToolNode('t:b:Foo.bar', 'bar', 'src/b.ts', 1, 'Method'),
      mkToolNode('t:a:baz', 'baz', 'src/a.ts', 20, 'Function'),
    ];
    // Tool emits the call ONLY in file A.
    const toolEdges: GraphEdge[] = [mkToolEdge('t:a:Foo.bar', 't:a:baz', 'CALLS')];

    const nodeMatches = [
      { oracle: oracleSymbolsAB[0], tool: toolNodes[0] },
      { oracle: oracleSymbolsAB[1], tool: toolNodes[1] },
    ];
    const adjudication = adjudicateEdges(
      toolEdges,
      toolNodes,
      oracleEdgesAB,
      nodeMatches,
      oracleSymbolsAB
    );
    expect(adjudication.truePositives).toHaveLength(1);
    expect(adjudication.falsePositives).toHaveLength(0);
    // File B's oracle edge is untouched by A's tool edge — it remains a FN.
    expect(adjudication.falseNegatives).toHaveLength(1);
    expect(adjudication.falseNegatives[0].fromPath).toBe('src/b.ts');
  });
});

describe('adjudicateEdges — CALLS denominator semantics (F9)', () => {
  it('collapses repeat call sites of the same pair into one row with siteCount, and excludes unscoreable rows from FN', () => {
    // 3 call sites of Foo.bar -> helper (same pair, repeated), plus 1 call to
    // an external/unresolvable target explicitly marked unscoreable.
    const oracleEdgesF9: OracleEdge[] = [
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'helper',
        targetLocalId: 'helper',
        targetPath: 'src/a.ts',
        targetStartLine: 13,
        type: 'CALLS',
      },
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'helper',
        targetLocalId: 'helper',
        targetPath: 'src/a.ts',
        targetStartLine: 13,
        type: 'CALLS',
      },
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'helper',
        targetLocalId: 'helper',
        targetPath: 'src/a.ts',
        targetStartLine: 13,
        type: 'CALLS',
      },
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'push',
        scoreable: false,
        type: 'CALLS',
      },
    ];
    const nodeMatches = [
      { oracle: oracleSymbols[1], tool: perfectToolNodes[1] }, // Foo.bar
      { oracle: oracleSymbols[2], tool: perfectToolNodes[2] }, // helper
    ];
    // Tool emits ONE deduped edge for the (Foo.bar, helper) pair — not one per site.
    const toolEdgesF9: GraphEdge[] = [mkToolEdge('t:Foo.bar', 't:helper', 'CALLS')];

    const adjudication = adjudicateEdges(
      toolEdgesF9,
      perfectToolNodes,
      oracleEdgesF9,
      nodeMatches,
      oracleSymbols
    );

    // Recall is 1/1 on the deduped relationship, not 1/3 on raw call sites.
    expect(adjudication.truePositives).toHaveLength(1);
    expect(adjudication.falseNegatives).toHaveLength(0);
    // The external/unresolvable row is set aside, never counted as FN.
    expect(adjudication.unscoreableOracleEdges).toHaveLength(1);
    expect(adjudication.unscoreableOracleEdges[0].targetName).toBe('push');
    // The 3 duplicate sites collapse into a single scoreable row, carrying the
    // original site count for informational "site coverage" reporting (see
    // the scoreD2 test below) — recall itself is computed on this one row.
    expect(adjudication.scoreableOracleEdges).toHaveLength(1);
    expect(adjudication.scoreableOracleEdges[0].siteCount).toBe(3);
  });
});

describe('scoreD2 — extended edge fairness columns (F9)', () => {
  it('surfaces unscoreableExcluded and siteCoverage on byType metrics', () => {
    const oracleEdgesF9: OracleEdge[] = [
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'helper',
        targetLocalId: 'helper',
        targetPath: 'src/a.ts',
        targetStartLine: 13,
        type: 'CALLS',
      },
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'helper',
        targetLocalId: 'helper',
        targetPath: 'src/a.ts',
        targetStartLine: 13,
        type: 'CALLS',
      },
      {
        fromLocalId: 'Foo.bar',
        fromPath: 'src/a.ts',
        targetName: 'push',
        scoreable: false,
        type: 'CALLS',
      },
    ];
    const report = scoreD2(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdgesF9);
    const calls = report.edges.byType.CALLS;
    expect(calls?.tp).toBe(1);
    expect(calls?.recall).toBe(1);
    expect(calls?.unscoreableExcluded).toBe(1);
    expect(calls?.siteCoverage).toBeCloseTo(1 / 2, 5);
  });
});

describe('scoreD1 — confusion matrix', () => {
  it('reports TP/FP/FN per edge type', () => {
    const report = scoreD1(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.tp).toBe(1);
    expect(calls?.fp).toBe(0);
    expect(calls?.fn).toBe(0);
    expect(calls?.toolPrecision).toBe(1);
    expect(calls?.oracleRecall).toBe(1);
  });
});
