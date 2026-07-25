import { describe, expect, it } from 'bun:test';
import { matchNodes, normalizePath } from '../matching/node-identity.matcher';
import type { GraphNode, OracleSymbol } from '../types';

function mkOracle(p: Partial<OracleSymbol> & Pick<OracleSymbol, 'name' | 'path' | 'startLine'>): OracleSymbol {
  return {
    endLine: p.startLine + 5,
    kind: 'Method',
    localId: p.localId ?? `${p.path}:${p.name}`,
    name: p.name,
    parentLocalId: null,
    path: p.path,
    startLine: p.startLine,
  };
}

function mkTool(p: Partial<GraphNode> & Pick<GraphNode, 'name' | 'path'>): GraphNode {
  return {
    endLine: null,
    id: p.id ?? `${p.path}:${p.name}`,
    kind: 'Method',
    name: p.name,
    parentId: null,
    path: p.path,
    startLine: p.startLine ?? null,
  };
}

describe('normalizePath', () => {
  it('strips leading ./', () => {
    expect(normalizePath('./src/foo.ts')).toBe('src/foo.ts');
  });
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('src\\foo.ts')).toBe('src/foo.ts');
  });
});

describe('matchNodes', () => {
  it('matches a tool node to an oracle node with the same path+name+exact line', () => {
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.toolUnmatched).toHaveLength(0);
    expect(res.oracleUnmatched).toHaveLength(0);
    expect(res.toolMatchRate).toBe(1);
    expect(res.oracleMatchRate).toBe(1);
  });

  it('matches within ±2 line tolerance', () => {
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'foo', path: 'src/a.ts', startLine: 12 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
  });

  it('does NOT match when line delta > 2', () => {
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'foo', path: 'src/a.ts', startLine: 15 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(0);
    expect(res.toolUnmatched).toHaveLength(1);
    expect(res.oracleUnmatched).toHaveLength(1);
  });

  it('resolves overloads by nearest startLine', () => {
    const oracle = [
      mkOracle({ name: 'bar', path: 'src/a.ts', startLine: 10, localId: 'a.ts:bar#1' }),
      mkOracle({ name: 'bar', path: 'src/a.ts', startLine: 20, localId: 'a.ts:bar#2' }),
    ];
    const tool = [mkTool({ name: 'bar', path: 'src/a.ts', startLine: 21 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.matched[0].oracle.localId).toBe('a.ts:bar#2');
  });

  it('each oracle node is matched at most once', () => {
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [
      mkTool({ name: 'foo', path: 'src/a.ts', startLine: 10 }),
      mkTool({ name: 'foo', path: 'src/a.ts', startLine: 11 }),
    ];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.toolUnmatched).toHaveLength(1);
  });

  it('skips anonymous/computed names', () => {
    const oracle = [mkOracle({ name: '[computed]', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: '[computed]', path: 'src/a.ts', startLine: 10 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(0);
  });

  it('matches by name only when tool has no startLine (single candidate)', () => {
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'foo', path: 'src/a.ts', startLine: null })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
  });

  it('does not match across different paths', () => {
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'foo', path: 'src/b.ts', startLine: 10 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(0);
    expect(res.toolUnmatched).toHaveLength(1);
    expect(res.oracleUnmatched).toHaveLength(1);
  });
});
