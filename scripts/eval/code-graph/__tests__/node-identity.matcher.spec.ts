import { describe, expect, it } from 'bun:test';
import { canonicalName, matchNodes, normalizePath } from '../matching/node-identity.matcher';
import type { GraphNode, OracleSymbol } from '../types';

function mkOracle(
  p: Partial<OracleSymbol> & Pick<OracleSymbol, 'name' | 'path' | 'startLine'>
): OracleSymbol {
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

  it('matches a unique (path,name) even when line delta > 2 (doc-comment/decorator convention)', () => {
    // A tool that records a symbol's start at its leading JSDoc block is off by
    // several lines from the TS compiler's `class`/`function` line. With a single
    // candidate, that must NOT be scored as both an FP and an FN — it's the same
    // symbol, correctly extracted, at a different line convention.
    const oracle = [mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'foo', path: 'src/a.ts', startLine: 15 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.toolUnmatched).toHaveLength(0);
    expect(res.oracleUnmatched).toHaveLength(0);
  });

  it('still disambiguates overloads by nearest line even when both are far off', () => {
    // Line is a tie-breaker among same-(path,name) candidates: pick nearest.
    const oracle = [
      mkOracle({ name: 'bar', path: 'src/a.ts', startLine: 10, localId: 'a.ts:bar#1' }),
      mkOracle({ name: 'bar', path: 'src/a.ts', startLine: 40, localId: 'a.ts:bar#2' }),
    ];
    const tool = [mkTool({ name: 'bar', path: 'src/a.ts', startLine: 34 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.matched[0].oracle.localId).toBe('a.ts:bar#2');
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

describe('canonicalName (F1 accessor convention)', () => {
  it('strips a get: prefix', () => {
    expect(canonicalName('get:min')).toBe('min');
  });
  it('strips a set: prefix', () => {
    expect(canonicalName('set:min')).toBe('min');
  });
  it('strips a "get "-space prefix', () => {
    expect(canonicalName('get min')).toBe('min');
  });
  it('strips a getter: prefix', () => {
    expect(canonicalName('getter:min')).toBe('min');
  });
  it('strips a [get] bracket prefix', () => {
    expect(canonicalName('[get]min')).toBe('min');
  });
  it('leaves a plain name untouched', () => {
    expect(canonicalName('min')).toBe('min');
  });
  it('does not strip from an unrelated name literally starting with getX', () => {
    expect(canonicalName('getX')).toBe('getX');
  });
});

describe('matchNodes — accessor naming convention (F1)', () => {
  it('matches oracle get:min to tool min (convention-agnostic)', () => {
    const oracle = [mkOracle({ name: 'get:min', path: 'src/a.ts', startLine: 10, kind: 'Method' })];
    const tool = [mkTool({ name: 'min', path: 'src/a.ts', startLine: 10, kind: 'Method' })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.toolUnmatched).toHaveLength(0);
    expect(res.oracleUnmatched).toHaveLength(0);
  });

  it('matches oracle min to tool get:min (reverse direction)', () => {
    const oracle = [mkOracle({ name: 'min', path: 'src/a.ts', startLine: 10, kind: 'Method' })];
    const tool = [mkTool({ name: 'get:min', path: 'src/a.ts', startLine: 10, kind: 'Method' })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
  });

  it('a getter+setter pair matched by one plain-named tool node scores one match, one FN, zero FP', () => {
    const oracle = [
      mkOracle({ name: 'get:min', path: 'src/a.ts', startLine: 10, localId: 'C.get:min' }),
      mkOracle({ name: 'set:min', path: 'src/a.ts', startLine: 10, localId: 'C.set:min' }),
    ];
    const tool = [mkTool({ name: 'min', path: 'src/a.ts', startLine: 10 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
    expect(res.toolUnmatched).toHaveLength(0);
    expect(res.oracleUnmatched).toHaveLength(1);
  });

  it('get:x does not match an unrelated method literally named getX', () => {
    const oracle = [mkOracle({ name: 'get:x', path: 'src/a.ts', startLine: 10 })];
    const tool = [mkTool({ name: 'getX', path: 'src/a.ts', startLine: 10 })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(0);
  });

  it('a class with foo (method) and get:foo (accessor) matches both with no crossover', () => {
    const oracle = [
      mkOracle({ name: 'foo', path: 'src/a.ts', startLine: 5, localId: 'C.foo' }),
      mkOracle({ name: 'get:foo', path: 'src/a.ts', startLine: 20, localId: 'C.get:foo' }),
    ];
    const tool = [
      mkTool({ name: 'foo', path: 'src/a.ts', startLine: 5, id: 't:foo' }),
      mkTool({ name: 'foo', path: 'src/a.ts', startLine: 20, id: 't:get:foo' }),
    ];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(2);
    expect(res.toolUnmatched).toHaveLength(0);
    const byToolId = new Map(res.matched.map((m) => [m.tool.id, m.oracle.localId]));
    expect(byToolId.get('t:foo')).toBe('C.foo');
    expect(byToolId.get('t:get:foo')).toBe('C.get:foo');
  });

  it('treats Method/Property as interchangeable when an accessor is involved', () => {
    const oracle = [mkOracle({ name: 'get:min', path: 'src/a.ts', startLine: 10, kind: 'Method' })];
    const tool = [mkTool({ name: 'min', path: 'src/a.ts', startLine: 10, kind: 'Property' })];
    const res = matchNodes(tool, oracle);
    expect(res.matched).toHaveLength(1);
  });
});
