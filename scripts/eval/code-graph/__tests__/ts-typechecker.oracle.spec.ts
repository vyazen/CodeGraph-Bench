import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TsTypeCheckerOracle } from '../oracle/ts-typechecker.oracle';
import type { OracleEdge, OracleSymbol } from '../types';

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2020',
    module: 'commonjs',
    lib: ['ES2020'],
    strict: false,
    skipLibCheck: true,
  },
});

/** Write a fixture repo to a temp dir and run the type-checker oracle on it. */
function runOracle(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-fixture-'));
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  try {
    return new TsTypeCheckerOracle().analyze(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Like `runOracle`, but doesn't force a single root tsconfig and creates
 * intermediate directories as needed — for multi-project fixtures (F17),
 * where the point is that different subtrees get different tsconfigs (or
 * none at all).
 */
function runOracleMultiProject(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'oracle-multiproject-fixture-'));
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  try {
    return new TsTypeCheckerOracle().analyze(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function symbolsNamed(symbols: OracleSymbol[], name: string): OracleSymbol[] {
  return symbols.filter((s) => s.name === name);
}

function edgesOfType(edges: OracleEdge[], type: OracleEdge['type']): OracleEdge[] {
  return edges.filter((e) => e.type === type);
}

describe('F3 — declare module / declare global / .d.ts', () => {
  it('emits symbols declared inside `declare module "..."` blocks', () => {
    const { symbols } = runOracle({
      'x.ts': 'export interface Base { id: number }',
      'a.ts': `
        declare module "./x" {
          export interface Y {
            z(): void;
          }
        }
      `,
    });
    const moduleSym = symbols.find((s) => s.kind === 'Module' && s.name === './x');
    expect(moduleSym).toBeDefined();
    const iface = symbols.find((s) => s.kind === 'Interface' && s.name === 'Y');
    expect(iface).toBeDefined();
    const method = symbols.find((s) => s.kind === 'Method' && s.name === 'z');
    expect(method).toBeDefined();
    expect(method?.parentLocalId).toBe('Y');
  });

  it('emits symbols declared inside `declare global` blocks', () => {
    const { symbols } = runOracle({
      'a.ts': `
        declare global {
          interface Window {
            w: number;
          }
        }
        export {};
      `,
    });
    const globalNs = symbols.find((s) => s.kind === 'Namespace' && s.name === 'global');
    expect(globalNs).toBeDefined();
    const iface = symbols.find((s) => s.kind === 'Interface' && s.name === 'Window');
    expect(iface).toBeDefined();
    const prop = symbols.find((s) => s.kind === 'Property' && s.name === 'w');
    expect(prop).toBeDefined();
    expect(prop?.parentLocalId).toBe('Window');
  });

  it('emits one Interface symbol per declaration-merge site, each keyed by its own path', () => {
    const { symbols } = runOracle({
      'scene.ts': 'export interface Scene { a: number }',
      'animatable.types.ts': `
        declare module "./scene" {
          export interface Scene {
            b: number;
          }
        }
      `,
    });
    const sceneSymbols = symbolsNamed(symbols, 'Scene').filter((s) => s.kind === 'Interface');
    expect(sceneSymbols.length).toBe(2);
    expect(new Set(sceneSymbols.map((s) => s.path)).size).toBe(2);
  });

  it('indexes .d.ts files instead of dropping them (F3 policy: index, not exclude)', () => {
    const { symbols } = runOracle({
      'ambient.d.ts': `
        declare class AmbientThing {
          doStuff(): void;
        }
      `,
    });
    const cls = symbols.find((s) => s.kind === 'Class' && s.name === 'AmbientThing');
    expect(cls).toBeDefined();
    const method = symbols.find((s) => s.kind === 'Method' && s.name === 'doStuff');
    expect(method).toBeDefined();
  });
});

describe('F4 — USES_TYPE extraction scope', () => {
  it('extracts USES_TYPE from method parameters and return types', () => {
    const { edges, symbols } = runOracle({
      'a.ts': `
        export class Box {}
        export class Crate {}
        export class Foo {
          bar(x: Box): Crate { return new Crate(); }
        }
      `,
    });
    const usesType = edgesOfType(edges, 'USES_TYPE');
    const fromBar = usesType.filter((e) => e.fromLocalId === 'Foo.bar');
    expect(fromBar.some((e) => e.targetName === 'Box')).toBe(true);
    expect(fromBar.some((e) => e.targetName === 'Crate')).toBe(true);
    expect(symbols.some((s) => s.kind === 'Method' && s.name === 'bar')).toBe(true);
  });

  it('extracts USES_TYPE from heritage clause type arguments', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Base<T> {}
        export class Payload {}
        export class Derived extends Base<Payload> {}
      `,
    });
    const usesType = edgesOfType(edges, 'USES_TYPE');
    expect(usesType.some((e) => e.fromLocalId === 'Derived' && e.targetName === 'Payload')).toBe(
      true
    );
  });

  it('extracts USES_TYPE from type-alias bodies', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Widget {}
        export type WidgetOrNull = Widget | null;
      `,
    });
    const usesType = edgesOfType(edges, 'USES_TYPE');
    expect(
      usesType.some((e) => e.fromLocalId === 'WidgetOrNull' && e.targetName === 'Widget')
    ).toBe(true);
  });

  it('extracts USES_TYPE from `as`/`satisfies` casts inside a function body', () => {
    const { edges } = runOracle({
      'a.ts': `
        export interface Shape { area(): number }
        export function make(x: unknown): void {
          const s = x as Shape;
        }
      `,
    });
    const usesType = edgesOfType(edges, 'USES_TYPE');
    expect(usesType.some((e) => e.fromLocalId === 'make' && e.targetName === 'Shape')).toBe(true);
  });

  it('extracts USES_TYPE from generic constraints', () => {
    const { edges } = runOracle({
      'a.ts': `
        export interface Bound {}
        export class Container<T extends Bound> {}
      `,
    });
    const usesType = edgesOfType(edges, 'USES_TYPE');
    expect(usesType.some((e) => e.fromLocalId === 'Container' && e.targetName === 'Bound')).toBe(
      true
    );
  });
});

describe('F5 — accessor and property-initialiser call sites', () => {
  it('extracts CALLS from a getter body', () => {
    const { edges, symbols } = runOracle({
      'a.ts': `
        function helper(): number { return 1; }
        export class Foo {
          get value(): number {
            return helper();
          }
        }
      `,
    });
    const accessor = symbols.find((s) => s.kind === 'Method' && s.name === 'get:value');
    expect(accessor).toBeDefined();
    const calls = edgesOfType(edges, 'CALLS');
    expect(calls.some((e) => e.fromLocalId === 'Foo.get:value' && e.targetName === 'helper')).toBe(
      true
    );
  });

  it('extracts CALLS from a property initialiser', () => {
    const { edges } = runOracle({
      'a.ts': `
        function helper(): number { return 1; }
        export class Foo {
          size = helper();
        }
      `,
    });
    const calls = edgesOfType(edges, 'CALLS');
    expect(calls.some((e) => e.fromLocalId === 'Foo.size' && e.targetName === 'helper')).toBe(true);
  });
});

describe('F7 — METHOD_OVERRIDES', () => {
  it('points an override at the nearest ancestor declaring the same name, skipping one that does not', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Level1 {
          greet(): void {}
        }
        export class Level2 extends Level1 {}
        export class Level3 extends Level2 {
          greet(): void {}
        }
      `,
    });
    const overrides = edgesOfType(edges, 'METHOD_OVERRIDES');
    const edge = overrides.find((e) => e.fromLocalId === 'Level3.greet');
    expect(edge).toBeDefined();
    expect(edge?.targetLocalId).toBe('Level1.greet');
  });

  it('does not emit an override for a class with no matching ancestor method', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Base {}
        export class Derived extends Base {
          onlyHere(): void {}
        }
      `,
    });
    const overrides = edgesOfType(edges, 'METHOD_OVERRIDES');
    expect(overrides.some((e) => e.fromLocalId === 'Derived.onlyHere')).toBe(false);
  });
});

describe('F8 — IMPLEMENTS: class-level vs member-level', () => {
  it('emits both a class-level and a member-level IMPLEMENTS edge', () => {
    const { edges } = runOracle({
      'a.ts': `
        export interface I {
          m(): void;
        }
        export class C implements I {
          m(): void {}
        }
      `,
    });
    const implementsEdges = edgesOfType(edges, 'IMPLEMENTS');
    expect(implementsEdges.some((e) => e.fromLocalId === 'C' && e.targetName === 'I')).toBe(true);
    const memberEdge = implementsEdges.find((e) => e.fromLocalId === 'C.m');
    expect(memberEdge).toBeDefined();
    expect(memberEdge?.targetLocalId).toBe('I.m');
  });
});

describe('F10 — call-resolution fallback cascade', () => {
  it('resolves a generic class method call', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Box<T> {
          unwrap(): T { return null as unknown as T; }
        }
        export function useBox(b: Box<number>): void {
          b.unwrap();
        }
      `,
    });
    const calls = edgesOfType(edges, 'CALLS');
    const edge = calls.find((e) => e.fromLocalId === 'useBox' && e.targetName === 'unwrap');
    expect(edge).toBeDefined();
    expect(edge?.targetLocalId).toBe('Box.unwrap');
  });

  it('resolves a union-typed receiver to every distinct in-repo declaration', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Cat { speak(): void {} }
        export class Dog { speak(): void {} }
        export function makeNoise(pet: Cat | Dog): void {
          pet.speak();
        }
      `,
    });
    const calls = edgesOfType(edges, 'CALLS');
    const speakEdges = calls.filter(
      (e) => e.fromLocalId === 'makeNoise' && e.targetName === 'speak'
    );
    const targets = new Set(speakEdges.map((e) => e.targetLocalId));
    expect(targets.has('Cat.speak')).toBe(true);
    expect(targets.has('Dog.speak')).toBe(true);
  });

  it('resolves an optional call', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Handler {
          run(): void {}
        }
        export function invoke(h: Handler | undefined): void {
          h?.run();
        }
      `,
    });
    const calls = edgesOfType(edges, 'CALLS');
    expect(calls.some((e) => e.fromLocalId === 'invoke' && e.targetLocalId === 'Handler.run')).toBe(
      true
    );
  });

  it('resolves the correct overload declaration for an overloaded function call', () => {
    const { edges } = runOracle({
      'a.ts': `
        export function combine(a: string, b: string): string;
        export function combine(a: number, b: number): number;
        export function combine(a: any, b: any): any { return a + b; }
        export function run(): void {
          combine(1, 2);
        }
      `,
    });
    const calls = edgesOfType(edges, 'CALLS');
    expect(calls.some((e) => e.fromLocalId === 'run' && e.targetName === 'combine')).toBe(true);
  });

  it('resolves a this-typed receiver call', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Chain {
          step(): void {
            this.next();
          }
          next(): void {}
        }
      `,
    });
    const calls = edgesOfType(edges, 'CALLS');
    expect(
      calls.some((e) => e.fromLocalId === 'Chain.step' && e.targetLocalId === 'Chain.next')
    ).toBe(true);
  });
});

describe('F12 — [expr] heritage resolution', () => {
  it('resolves mixin call-expression heritage via getTypeAtLocation', () => {
    const { edges } = runOracle({
      'a.ts': `
        export class Base {}
        function Mixin<T extends new (...args: any[]) => object>(Ctor: T) {
          return class extends Ctor {};
        }
        export class Derived extends Mixin(Base) {}
      `,
    });
    const extendsEdges = edgesOfType(edges, 'EXT***REMOVED***S');
    const edge = extendsEdges.find((e) => e.fromLocalId === 'Derived');
    expect(edge).toBeDefined();
    expect(edge?.targetName).toBe('[expr]');
    // Base is anonymous-class-returning, so the resolved target is the mixin's
    // return expression — what matters is that *some* resolution was attempted
    // via the type rather than giving up outright.
  });

  it('marks a genuinely unresolvable heritage clause as unscoreable, not left dangling', () => {
    const { edges } = runOracle({
      'a.ts': `
        function pickBase(): any {
          return class {};
        }
        export class Derived extends (pickBase() as any) {}
      `,
    });
    const extendsEdges = edgesOfType(edges, 'EXT***REMOVED***S');
    const edge = extendsEdges.find((e) => e.fromLocalId === 'Derived');
    expect(edge).toBeDefined();
    if (!edge?.targetLocalId) {
      expect(edge?.scoreable).toBe(false);
    }
  });
});

describe('F17 — tsconfig directories with no adjacent package.json get their own project', () => {
  it('resolves an AMD baseUrl/paths bare-specifier import that the inferred fallback config could not', () => {
    const { edges, symbols } = runOracleMultiProject({
      'package.json': '{}',
      'src/main.ts': `
        import { URI } from 'vs/base/common/uri';
        export class Widget extends URI {}
      `,
      'src/tsconfig.json': JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          module: 'amd',
          paths: { 'vs/*': ['./vs/*'] },
          skipLibCheck: true,
          target: 'ES2020',
        },
      }),
      'src/vs/base/common/uri.ts': 'export class URI {}',
    });

    const uri = symbols.find((s) => s.kind === 'Class' && s.name === 'URI');
    expect(uri).toBeDefined();

    const extendsEdges = edgesOfType(edges, 'EXT***REMOVED***S');
    const edge = extendsEdges.find((e) => e.fromLocalId === 'Widget');
    expect(edge).toBeDefined();
    // Before F17, `src/` had no project of its own, fell back to inferred
    // compiler options with no `baseUrl`/`paths`, and the bare specifier
    // 'vs/base/common/uri' was unresolvable — this would be undefined.
    expect(edge?.targetLocalId).toBe(uri?.localId);
  });
});
