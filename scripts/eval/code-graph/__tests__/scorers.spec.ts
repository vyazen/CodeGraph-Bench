import { describe, expect, it } from 'bun:test';
import { scoreD1 } from '../scorers/d1-depth.scorer';
import { scoreD2 } from '../scorers/d2-fidelity.scorer';
import type { GraphEdge, GraphNode, OracleEdge, OracleSymbol } from '../types';

// Synthetic fixture: one file, one class with a method that calls another function
const oracleSymbols: OracleSymbol[] = [
  { endLine: 10, kind: 'Class', localId: 'Foo', name: 'Foo', parentLocalId: null, path: 'src/a.ts', startLine: 1 },
  { endLine: 8, kind: 'Method', localId: 'Foo.bar', name: 'bar', parentLocalId: 'Foo', path: 'src/a.ts', startLine: 3 },
  { endLine: 15, kind: 'Function', localId: 'helper', name: 'helper', parentLocalId: null, path: 'src/a.ts', startLine: 13 },
];

const oracleEdges: OracleEdge[] = [
  { fromLocalId: 'Foo.bar', targetName: 'helper', type: 'CALLS' },
];

// Tool graph: matches the oracle perfectly
function mkToolNode(id: string, name: string, path: string, startLine: number, kind: GraphNode['kind']): GraphNode {
  return { endLine: null, id, kind, name, parentId: null, path, startLine };
}
function mkToolEdge(fromId: string, toId: string, type: GraphEdge['type'], resolved = true): GraphEdge {
  return { confidence: null, fromId, resolved, toId, type };
}

const perfectToolNodes: GraphNode[] = [
  mkToolNode('t:Foo', 'Foo', 'src/a.ts', 1, 'Class'),
  mkToolNode('t:Foo.bar', 'bar', 'src/a.ts', 3, 'Method'),
  mkToolNode('t:helper', 'helper', 'src/a.ts', 13, 'Function'),
];
const perfectToolEdges: GraphEdge[] = [
  mkToolEdge('t:Foo.bar', 't:helper', 'CALLS'),
];

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

describe('scoreD1 — Vyazen resolved slicing', () => {
  it('reports vyazenResolvedConfirmed when isVyazen=true', () => {
    const report = scoreD1(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges, true);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.vyazenResolvedTotal).toBe(1);
    expect(calls?.vyazenResolvedConfirmed).toBe(1);
    expect(calls?.oracleConfirmed).toBe(1);
  });

  it('does not include vyazenResolved fields when isVyazen=false', () => {
    const report = scoreD1(perfectToolNodes, perfectToolEdges, oracleSymbols, oracleEdges, false);
    const calls = report.perType.find((m) => m.edgeType === 'CALLS');
    expect(calls?.vyazenResolvedConfirmed).toBeUndefined();
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
