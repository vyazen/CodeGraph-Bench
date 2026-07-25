/**
 * TS compiler oracle — adapted from parse-diagnostic's ts-compiler.oracle.ts.
 *
 * Parse-only (no type checker) for speed on 8k+ files. This matches the
 * existing parse-diagnostic oracle's design. The oracle is the neutral ground
 * truth: it extracts what the TS compiler's parser sees, independent of any
 * tool's graph.
 *
 * Extensions over parse-diagnostic:
 * - `implementsRels` (heritage `implements` clauses) — parse-diagnostic only
 *   had `extendsRels`.
 * - `callSites` (structural CallExpression extraction) — for D1 depth-moat
 *   adjudication. Caveat: this is a name-based oracle, not a type-checker
 *   oracle. A call `foo.bar()` emits targetName='bar'. This is disclosed
 *   in the scorecard as a methodology caveat.
 *
 * Divergence rules (§3.3) are NOT applied here — the oracle is neutral.
 * Adapters are responsible for filtering to comparable kinds.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cpus } from 'node:os';
import {
  type ClassElement,
  createSourceFile,
  type Expression,
  forEachChild,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isEnumDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isGetAccessor,
  isIdentifier,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignature,
  isModuleDeclaration,
  isNamespaceImport,
  isPrivateIdentifier,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isPropertySignature,
  isSetAccessor,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
  type Node,
  type NodeArray,
  NodeFlags,
  ScriptKind,
  ScriptTarget,
  type SourceFile,
  type StringLiteral,
  SyntaxKind,
  type TypeElement,
} from 'typescript';
import { BoundedQueue } from './bounded-queue';
import type { OracleFileResult, OracleSymbol, SymbolType } from '../types';

function resolveScriptKind(rel: string): ScriptKind {
  if (rel.endsWith('.tsx')) return ScriptKind.TSX;
  if (rel.endsWith('.jsx')) return ScriptKind.JSX;
  if (rel.endsWith('.js')) return ScriptKind.JS;
  return ScriptKind.TS;
}

function memberName(node: { name?: Node }): string {
  if (!node.name) return '[anonymous]';
  if (isIdentifier(node.name)) return (node.name as { text: string }).text;
  if (isStringLiteral(node.name)) return (node.name as StringLiteral).text;
  if (isPrivateIdentifier(node.name)) return (node.name as { text: string }).text;
  if (isComputedPropertyName(node.name)) {
    const expr = node.name.expression;
    if (isPropertyAccessExpression(expr) && isIdentifier(expr.expression)) {
      return `[${(expr.expression as { text: string }).text}.${(expr.name as { text: string }).text}]`;
    }
  }
  return '[computed]';
}

function isHocWrapped(expr: Expression, depth = 0): boolean {
  if (depth > 3) return false;
  if (!isCallExpression(expr)) return false;
  const callee = expr.expression;
  let calleeName = '';
  if (isIdentifier(callee)) {
    calleeName = (callee as { text: string }).text;
  } else if (isPropertyAccessExpression(callee)) {
    calleeName = (callee.name as { text: string }).text;
  }
  if (['memo', 'forwardRef', 'observer'].includes(calleeName)) return true;
  return expr.arguments.some((arg) => isHocWrapped(arg, depth + 1));
}

/** Extract the callee name from a CallExpression (last identifier in the chain). */
function calleeName(expr: Expression): string | null {
  if (isIdentifier(expr)) return (expr as { text: string }).text;
  if (isPropertyAccessExpression(expr)) {
    // foo.bar() → 'bar'; this.foo() → 'foo'; Foo.Bar.baz() → 'baz'
    return (expr.name as { text: string }).text;
  }
  return null;
}

export interface OracleCallSite {
  calleeName: string;
  containerLocalId: string;
}

export interface OracleFileResultWithCalls extends OracleFileResult {
  callSites: OracleCallSite[];
}

export class TsCompilerOracle {
  readonly supportedExtensions = ['.ts', '.tsx', '.js', '.jsx'];

  analyze(repoPath: string, files: string[]): Promise<OracleFileResultWithCalls[]> {
    const numCpus = Math.max(1, cpus().length - 2);
    const queue = new BoundedQueue(numCpus);
    return queue.runAll(
      files.map((rel) => () => Promise.resolve(this.analyzeFile(repoPath, rel))),
    );
  }

  private analyzeFile(repoPath: string, rel: string): OracleFileResultWithCalls {
    const abs = join(repoPath, rel);
    let src: string;
    try {
      src = readFileSync(abs, 'utf8');
    } catch {
      return { path: rel, symbols: [], imports: [], extendsRels: [], implementsRels: [], callSites: [] };
    }

    let sf: SourceFile;
    try {
      sf = createSourceFile(rel, src, ScriptTarget.Latest, true, resolveScriptKind(rel));
    } catch {
      return { path: rel, symbols: [], imports: [], extendsRels: [], implementsRels: [], callSites: [] };
    }

    const symbols: OracleSymbol[] = [];
    const imports: Array<{ fromModule: string | null; targetName: string }> = [];
    const extendsRels: Array<{ baseName: string; childLocalId: string }> = [];
    const implementsRels: Array<{ baseName: string; childLocalId: string }> = [];
    const callSites: OracleCallSite[] = [];
    const getLine = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
    
    try {

    const pushSym = (
      localId: string,
      name: string,
      kind: SymbolType,
      parentLocalId: string | null,
      node: Node,
    ) => {
      symbols.push({
        localId,
        name,
        kind,
        parentLocalId,
        path: rel,
        startLine: getLine(node.getStart(sf)),
        endLine: getLine(node.getEnd()),
      });
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: TS class member visitor handles many member kinds
    const visitMembers = (members: NodeArray<ClassElement | TypeElement>, parentId: string) => {
      for (const m of members) {
        if (isConstructorDeclaration(m)) {
          pushSym(`${parentId}.constructor`, 'constructor', 'Constructor', parentId, m);
          for (const param of m.parameters) {
            const isParamProp = param.modifiers?.some(
              (mod) =>
                mod.kind === SyntaxKind.PublicKeyword ||
                mod.kind === SyntaxKind.PrivateKeyword ||
                mod.kind === SyntaxKind.ProtectedKeyword ||
                mod.kind === SyntaxKind.ReadonlyKeyword,
            );
            if (isParamProp) {
              const pname = isIdentifier(param.name)
                ? (param.name as { text: string }).text
                : String(param.name);
              pushSym(`${parentId}.${pname}`, pname, 'Property', parentId, param);
            }
          }
        } else if (isMethodDeclaration(m) || isMethodSignature(m)) {
          if ('body' in m && (m as { body?: unknown }).body === undefined) continue;
          const mname = memberName(m as { name: Node });
          pushSym(`${parentId}.${mname}`, mname, 'Method', parentId, m);
        } else if (isGetAccessor(m)) {
          const aname = isIdentifier(m.name) ? (m.name as { text: string }).text : '[computed]';
          pushSym(`${parentId}.get:${aname}`, `get:${aname}`, 'Method', parentId, m);
        } else if (isSetAccessor(m)) {
          const aname = isIdentifier(m.name) ? (m.name as { text: string }).text : '[computed]';
          pushSym(`${parentId}.set:${aname}`, `set:${aname}`, 'Method', parentId, m);
        } else if (isPropertyDeclaration(m) || isPropertySignature(m)) {
          const pname = memberName(m as { name: Node });
          pushSym(`${parentId}.${pname}`, pname, 'Property', parentId, m);
        }
      }
    };

    /** Walk a node subtree, collecting call sites attributed to `containerLocalId`. */
    const visitCalls = (node: Node, containerLocalId: string) => {
      if (isCallExpression(node)) {
        const name = calleeName(node.expression);
        if (name) {
          callSites.push({ calleeName: name, containerLocalId });
        }
      }
      // Don't descend into nested function/class declarations — they rebind the container.
      if (isFunctionDeclaration(node) || isFunctionExpression(node) || isArrowFunction(node)) {
        if (node.parent && !isMethodDeclaration(node.parent)) {
          return;
        }
      }
      if (isClassDeclaration(node) || isInterfaceDeclaration(node)) {
        return;
      }
      forEachChild(node, (child) => visitCalls(child, containerLocalId));
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: top-level visitor dispatches on many declaration types
    const visitTopLevel = (node: Node) => {
      if (isClassDeclaration(node) && node.name) {
        const cname = (node.name as { text: string }).text;
        pushSym(cname, cname, 'Class', null, node);
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            const baseName = isIdentifier(type.expression)
              ? (type.expression as { text: string }).text
              : '[expr]';
            if (clause.token === SyntaxKind.ExtendsKeyword) {
              extendsRels.push({ childLocalId: cname, baseName });
            } else if (clause.token === SyntaxKind.ImplementsKeyword) {
              implementsRels.push({ childLocalId: cname, baseName });
            }
          }
        }
        visitMembers(node.members, cname);
        // Collect call sites inside each method
        for (const m of node.members) {
          if (isMethodDeclaration(m) || isConstructorDeclaration(m) || isGetAccessor(m) || isSetAccessor(m)) {
            const mname = memberName(m as { name: Node });
            const localId = isConstructorDeclaration(m)
              ? `${cname}.constructor`
              : `${cname}.${mname}`;
            visitCalls(m, localId);
          }
        }
      } else if (isInterfaceDeclaration(node)) {
        const iname = (node.name as { text: string }).text;
        pushSym(iname, iname, 'Interface', null, node);
        for (const m of node.members) {
          if (isMethodSignature(m)) {
            const mname = memberName(m as { name: Node });
            pushSym(`${iname}.${mname}`, mname, 'Method', iname, m);
          } else if (isPropertySignature(m)) {
            const pname = memberName(m as { name: Node });
            pushSym(`${iname}.${pname}`, pname, 'Property', iname, m);
          }
        }
        // Interfaces can extend other interfaces
        for (const clause of node.heritageClauses ?? []) {
          for (const type of clause.types) {
            const baseName = isIdentifier(type.expression)
              ? (type.expression as { text: string }).text
              : '[expr]';
            if (clause.token === SyntaxKind.ExtendsKeyword) {
              extendsRels.push({ childLocalId: iname, baseName });
            }
          }
        }
      } else if (isEnumDeclaration(node)) {
        const ename = (node.name as { text: string }).text;
        pushSym(ename, ename, 'Enum', null, node);
        for (const member of node.members) {
          const mname = memberName(member as { name: Node });
          pushSym(`${ename}.${mname}`, mname, 'Property', ename, member);
        }
      } else if (isTypeAliasDeclaration(node)) {
        pushSym(
          (node.name as { text: string }).text,
          (node.name as { text: string }).text,
          'Alias',
          null,
          node,
        );
      } else if (isFunctionDeclaration(node) && node.name) {
        const fname = (node.name as { text: string }).text;
        pushSym(fname, fname, 'Function', null, node);
        visitCalls(node, fname);
      } else if (isModuleDeclaration(node) && node.name) {
        const mname = (node.name as { text: string }).text;
        // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript NodeFlags requires bitwise check
        const isNamespace = (node.flags & NodeFlags.Namespace) !== 0;
        pushSym(mname, mname, isNamespace ? 'Namespace' : 'Module', null, node);
      } else if (isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!isIdentifier(decl.name)) continue;
          const vname = (decl.name as { text: string }).text;
          const isFn =
            decl.initializer &&
            (isArrowFunction(decl.initializer) ||
              isFunctionExpression(decl.initializer) ||
              isHocWrapped(decl.initializer));
          pushSym(vname, vname, isFn ? 'Function' : 'GlobalVariable', null, node);
          if (isFn && decl.initializer) {
            visitCalls(decl.initializer, vname);
          }
        }
      } else if (isExportAssignment(node)) {
        pushSym('default', 'default', 'GlobalVariable', null, node);
      } else if (isImportDeclaration(node)) {
        const mod = (node.moduleSpecifier as StringLiteral).text;
        const clause = node.importClause;
        if (clause) {
          if (clause.name) {
            imports.push({ targetName: (clause.name as { text: string }).text, fromModule: mod });
          }
          const nb = clause.namedBindings;
          if (nb) {
            if (isNamespaceImport(nb)) {
              imports.push({ targetName: (nb.name as { text: string }).text, fromModule: mod });
            } else {
              for (const el of nb.elements) {
                imports.push({ targetName: (el.name as { text: string }).text, fromModule: mod });
              }
            }
          }
        } else {
          imports.push({ targetName: mod, fromModule: mod });
        }
      }
    };

    forEachChild(sf, visitTopLevel);
    return { path: rel, symbols, imports, extendsRels, implementsRels, callSites };
    } catch (err) {
      // Don't let one pathological file crash the whole oracle run
      return { path: rel, symbols: [], imports: [], extendsRels: [], implementsRels: [], callSites: [], parseError: String(err) };
    }
  }
}

/** Walk a repo and return all TS/JS file paths (relative). */
export function listSourceFiles(repoPath: string): string[] {
  const targets: string[] = [];
  const walk = (dir: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(repoPath, full);
        if (
          rel.endsWith('.ts') ||
          rel.endsWith('.tsx') ||
          rel.endsWith('.js') ||
          rel.endsWith('.jsx')
        ) {
          targets.push(rel);
        }
      }
    }
  };
  walk(repoPath);
  return targets;
}
