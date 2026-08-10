/**
 * Type-checker-backed oracle — the REAL ground truth.
 *
 * Unlike the parse-only oracle (ts-compiler.oracle.ts), this one creates a full
 * TS Program with TypeChecker. It can resolve:
 * - CALLS: which specific method/function is being called (not just the name)
 * - EXT***REMOVED***S/IMPLEMENTS: which specific class/interface is the base
 * - IMPORTS: which specific declaration each import binds to
 * - USES_TYPE: which specific type a type annotation references
 * - ACCESSES: which specific property is being accessed
 * - METHOD_OVERRIDES: which parent method a method overrides
 *
 * This is neutral — the type checker IS the language's semantics. It doesn't
 * favor any tool. If a heuristic tool's edge happens to match the type checker's
 * resolution, it's a TP.
 *
 * Performance: type-checking 8k files takes ~2-5 minutes (one-time, cached).
 * The type checker loads the entire program into memory (~2-4 GB RSS).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import ts from 'typescript';
import type { EdgeType, OracleEdge, OracleSymbol, SymbolType } from '../types';
import {
  assignFileOwnership,
  discoverProjects,
  type OracleProject,
  walkRepoFiles,
} from './project-discovery';

export interface TypeCheckerOracleResult {
  edges: OracleEdge[];
  /** How many edges had a resolved target (vs. name-only). */
  resolvedCount: number;
  symbols: OracleSymbol[];
  totalEdges: number;
}

export interface TypeCheckerOracleOptions {
  outDir: string;
  repoPath: string;
  useCache?: boolean;
}

type PushEdgeFn = (
  from: string,
  name: string,
  type: EdgeType,
  sym: ts.Symbol | null,
  tier?: OracleEdge['resolutionTier']
) => OracleEdge;

/** Get the relative path of a source file, or null if it's outside the repo. */
function getRelPath(repoPath: string, fileName: string): string | null {
  const rel = relative(repoPath, fileName);
  if (rel.startsWith('..') || rel.includes('node_modules')) {
    return null;
  }
  return rel.replace(/\\/g, '/');
}

/** Get the start line of a declaration node. */
function getStartLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** Get the localId for a declaration (mimics the parse-only oracle's naming). */
function getLocalId(node: ts.Node, sourceFile: ts.SourceFile, name: string): string {
  // For top-level declarations, localId = name
  // For class members, localId = ClassName.memberName
  let parent = node.parent;
  while (parent) {
    if (ts.isClassDeclaration(parent) && parent.name) {
      return `${parent.name.text}.${name}`;
    }
    if (ts.isInterfaceDeclaration(parent) && parent.name) {
      return `${parent.name.text}.${name}`;
    }
    if (ts.isEnumDeclaration(parent) && parent.name) {
      return `${parent.name.text}.${name}`;
    }
    parent = parent.parent;
  }
  return name;
}

/**
 * Resolve a symbol to its declaration's location.
 * Returns { localId, path, startLine } or null if unresolvable.
 */
function resolveSymbolLocation(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  repoPath: string
): { localId: string; path: string; startLine: number } | null {
  // Follow alias symbols (e.g. re-exports) to the real declaration
  let resolved = symbol;
  let depth = 0;
  while (resolved.flags & ts.SymbolFlags.Alias && depth < 5) {
    try {
      resolved = checker.getAliasedSymbol(resolved);
    } catch {
      break;
    }
    depth++;
  }

  const decl = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!decl) {
    return null;
  }

  const sourceFile = decl.getSourceFile();
  const relPath = getRelPath(repoPath, sourceFile.fileName);
  if (!relPath) {
    return null; // External (node_modules) or outside the repo
  }

  const startLine = getStartLine(decl, sourceFile);
  const name = resolved.getName();
  const localId = getLocalId(decl, sourceFile, name);

  return { localId, path: relPath, startLine };
}

/**
 * Resolve a `ts.Declaration` back to its own symbol. Used by the F10
 * call-resolution cascade for declarations returned by
 * `getResolvedSignature()` that don't come with a symbol attached directly
 * (e.g. constructors have no `.name`, so `getSymbolAtLocation` needs a named
 * node — fall back to the declaration's bound `.symbol`).
 */
function symbolFromDeclaration(checker: ts.TypeChecker, decl: ts.Declaration): ts.Symbol | null {
  const named = decl as unknown as { name?: ts.Node };
  if (named.name) {
    try {
      const sym = checker.getSymbolAtLocation(named.name);
      if (sym) {
        return sym;
      }
    } catch {
      // fall through to the raw-symbol fallback below
    }
  }
  const withSymbol = decl as unknown as { symbol?: ts.Symbol };
  return withSymbol.symbol ?? null;
}

/**
 * Resolve a heritage clause's base-type symbol (F12). `getSymbolAtLocation`
 * only works for identifier expressions (`extends Base`); mixin-call heritage
 * (`extends Mixin(Base)`) has no symbol at the call-expression location, so
 * fall back to the *type* of the expression, which the checker can still
 * compute even though there's no declaration symbol to point at directly.
 */
function resolveHeritageBaseSymbol(
  checker: ts.TypeChecker,
  typeRef: ts.ExpressionWithTypeArguments
): ts.Symbol | null {
  const direct = checker.getSymbolAtLocation(typeRef.expression);
  if (direct) {
    return direct;
  }
  try {
    const type = checker.getTypeAtLocation(typeRef.expression);
    return type.getSymbol() ?? type.aliasSymbol ?? null;
  } catch {
    return null;
  }
}

/** Strip non-null assertions / redundant parens around a callee expression, for retrying resolution (F10 tier 4). */
function stripCalleeWrapping(expr: ts.Expression): ts.Expression | null {
  let e: ts.Expression = expr;
  let changed = false;
  for (;;) {
    if (ts.isNonNullExpression(e)) {
      e = e.expression;
      changed = true;
      continue;
    }
    if (ts.isParenthesizedExpression(e)) {
      e = e.expression;
      changed = true;
      continue;
    }
    break;
  }
  return changed ? e : null;
}

/**
 * True when `expr` is a property access whose receiver is a union type with
 * more than one constituent declaring the property — e.g. `pet.speak()` for
 * `pet: Cat | Dog` where both declare `speak`. Both `getSymbolAtLocation` and
 * `getResolvedSignature` collapse this to a single (arbitrarily-picked)
 * constituent's declaration; tier 3 is the only tier that reports one edge
 * per distinct in-repo declaration, so tiers 1-2 must defer to it here.
 */
function isMultiTargetUnionPropertyAccess(
  checker: ts.TypeChecker,
  expr: ts.Expression
): expr is ts.PropertyAccessExpression {
  if (!ts.isPropertyAccessExpression(expr)) {
    return false;
  }
  try {
    const receiverType = checker.getTypeAtLocation(expr.expression);
    if (!receiverType.isUnion()) {
      return false;
    }
    let count = 0;
    for (const t of receiverType.types) {
      if (t.getProperty(expr.name.text)) {
        count++;
      }
    }
    return count > 1;
  } catch {
    return false;
  }
}

/**
 * F10 — cascade of call-resolution strategies, first hit wins. Each tier
 * handles receivers the previous one gives up on: plain identifiers and most
 * property accesses resolve at tier 1; overloaded/generic-instantiated calls
 * need the resolved *signature* (tier 2); union-typed receivers need the
 * type of the receiver expression, not the call (tier 3, one symbol per
 * distinct in-repo declaration); everything else gets one retry after
 * stripping non-null/paren wrapping (tier 4).
 */
function resolveCalleeSymbols(
  checker: ts.TypeChecker,
  node: ts.CallExpression | ts.NewExpression
): { symbols: ts.Symbol[]; tier: NonNullable<OracleEdge['resolutionTier']> } {
  const expr = node.expression;
  const deferToUnionTier = isMultiTargetUnionPropertyAccess(checker, expr);

  if (!deferToUnionTier) {
    try {
      const sym = checker.getSymbolAtLocation(expr);
      if (sym) {
        return { symbols: [sym], tier: 'symbol' };
      }
    } catch {
      // fall through
    }

    try {
      const sig = checker.getResolvedSignature(node);
      const decl = sig?.declaration;
      if (decl) {
        const sym = symbolFromDeclaration(checker, decl);
        if (sym) {
          return { symbols: [sym], tier: 'signature' };
        }
      }
    } catch {
      // fall through
    }
  }

  if (ts.isPropertyAccessExpression(expr)) {
    try {
      const receiverType = checker.getTypeAtLocation(expr.expression);
      const constituents = receiverType.isUnion() ? receiverType.types : [receiverType];
      const symbols: ts.Symbol[] = [];
      const seen = new Set<ts.Symbol>();
      for (const t of constituents) {
        const prop = t.getProperty(expr.name.text);
        if (prop && !seen.has(prop)) {
          seen.add(prop);
          symbols.push(prop);
        }
      }
      if (symbols.length > 0) {
        return { symbols, tier: 'property' };
      }
    } catch {
      // fall through
    }
  }

  const stripped = stripCalleeWrapping(expr);
  if (stripped) {
    try {
      const sym = checker.getSymbolAtLocation(stripped);
      if (sym) {
        return { symbols: [sym], tier: 'optional-chain-stripped' };
      }
    } catch {
      // fall through
    }
  }

  return { symbols: [], tier: 'unresolved' };
}

/** Extensions the compiler can actually parse as a root file (matches `allowJs` fallback options). */
const SOURCE_EXT_RE = /\.(tsx?|jsx?|mts|cts|mjs|cjs)$/;

/**
 * Fails loudly if the same file is walked by more than one project — the
 * failure mode the ownership rule (§1.2) exists to prevent, since a
 * double-walked file would emit its symbols/edges twice and corrupt every
 * downstream ratio. Deliberately file-scoped, not `(path, localId)`-scoped:
 * a single file can legitimately emit the same localId more than once (e.g.
 * overload signatures all named `combine`), which is pre-existing, unrelated
 * behavior this refactor must not start rejecting.
 */
function assertFilesOwnedOnce(ownedFiles: readonly string[], seenFiles: Set<string>): void {
  for (const f of ownedFiles) {
    if (seenFiles.has(f)) {
      throw new Error(`[typechecker-oracle] file walked by more than one project: ${f}`);
    }
    seenFiles.add(f);
  }
}

/**
 * Mirrors `the type-checker oracle`'s `loadCompilerOptions`
 * exactly, including all three fallback paths (VSCODE_CODE_GRAPH_EVAL_PLAN.md
 * §1.2): no tsconfig, tsconfig read/parse error, and tsconfig OK but with an
 * empty `fileNames` list. A project with no tsconfig is still analyzed — never
 * skipped — using its own owned files as the root file list.
 */
function loadCompilerOptionsForProject(
  repoPath: string,
  tsconfigPath: string | null,
  ownedFilePaths: readonly string[]
): { options: ts.CompilerOptions; rootNames: string[] } {
  const absoluteFilePaths = ownedFilePaths
    .filter((f) => SOURCE_EXT_RE.test(f))
    .map((f) => join(repoPath, f));

  const fallbackOptions: ts.CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ESNext,
    noEmit: true,
    skipLibCheck: true,
  };

  if (!tsconfigPath) {
    return { options: fallbackOptions, rootNames: absoluteFilePaths };
  }

  const absoluteTsconfigPath = join(repoPath, tsconfigPath);

  try {
    const readResult = ts.readConfigFile(absoluteTsconfigPath, ts.sys.readFile);
    if (readResult.error) {
      console.warn(
        `[typechecker-oracle] tsconfig error in ${tsconfigPath} — falling back to inferred config`
      );
      return { options: fallbackOptions, rootNames: absoluteFilePaths };
    }

    const configDir = dirname(absoluteTsconfigPath);
    const parsedConfig = ts.parseJsonConfigFileContent(
      readResult.config,
      ts.sys,
      configDir,
      undefined,
      absoluteTsconfigPath
    );

    const rootNames =
      parsedConfig.fileNames.length > 0 ? parsedConfig.fileNames : absoluteFilePaths;

    return {
      options: { ...parsedConfig.options, noEmit: true, skipLibCheck: true },
      rootNames,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[typechecker-oracle] failed to load tsconfig ${tsconfigPath} — ${message}. Falling back to inferred config.`
    );
    return { options: fallbackOptions, rootNames: absoluteFilePaths };
  }
}

export interface ProjectAnalysisResult {
  edges: OracleEdge[];
  ownedFiles: string[];
  project: OracleProject;
  resolvedCount: number;
  symbols: OracleSymbol[];
}

export class TsTypeCheckerOracle {
  /**
   * Discovers project boundaries, assigns each file to exactly one owning
   * project (§1.2), and analyzes each project's own `ts.Program` in turn.
   * Sequential by design (§1.4): each program/checker goes out of scope
   * before the next is built, so peak RSS doesn't multiply across projects.
   */
  analyzeByProject(repoPath: string): ProjectAnalysisResult[] {
    const files = walkRepoFiles(repoPath);
    const projects = discoverProjects(files);
    const ownership = assignFileOwnership(projects, files);

    console.log(`[typechecker-oracle] Discovered ${projects.length} project(s)`);

    const seen = new Set<string>();
    const results: ProjectAnalysisResult[] = [];
    let projectNum = 0;

    for (const project of projects) {
      projectNum++;
      const ownedFiles = files.filter((f) => ownership.get(f) === project);
      if (ownedFiles.length === 0) {
        continue;
      }

      assertFilesOwnedOnce(ownedFiles, seen);
      const start = Date.now();
      const { edges, resolvedCount, symbols } = this.analyzeProject(repoPath, project, ownedFiles);

      console.log(
        `[typechecker-oracle] Project ${projectNum}/${projects.length} (${project.rootPath}): ` +
          `${ownedFiles.length} files, ${symbols.length} symbols, ${edges.length} edges, ${Date.now() - start}ms`
      );

      results.push({ edges, ownedFiles, project, resolvedCount, symbols });
    }

    return results;
  }

  /** Convenience wrapper over `analyzeByProject` for callers that just want the combined result. */
  analyze(repoPath: string): TypeCheckerOracleResult {
    const perProject = this.analyzeByProject(repoPath);
    const symbols = perProject.flatMap((r) => r.symbols);
    const edges = perProject.flatMap((r) => r.edges);
    const resolvedCount = perProject.reduce((sum, r) => sum + r.resolvedCount, 0);

    console.log(
      `[typechecker-oracle] Done: ${symbols.length} symbols, ${edges.length} edges (${resolvedCount} resolved)`
    );

    return { edges, resolvedCount, symbols, totalEdges: edges.length };
  }

  /** Builds one project's `ts.Program` and walks only the files it owns. */
  analyzeProject(
    repoPath: string,
    project: OracleProject,
    ownedFiles: readonly string[]
  ): { edges: OracleEdge[]; resolvedCount: number; symbols: OracleSymbol[] } {
    const { options, rootNames } = loadCompilerOptionsForProject(
      repoPath,
      project.tsconfigPath,
      ownedFiles
    );

    const program = ts.createProgram({ rootNames, options });
    const checker = program.getTypeChecker();

    const symbols: OracleSymbol[] = [];
    const edges: OracleEdge[] = [];
    let resolvedCount = 0;

    // F3: `.d.ts` files are indexed too (policy (a) — the alternative is
    // excluding them from every tool's node set as well, which would throw
    // away real symbols tools do extract).
    for (const ownedPath of ownedFiles) {
      const sourceFile = program.getSourceFile(join(repoPath, ownedPath));
      if (!sourceFile) {
        continue; // not a file the compiler parses as source (e.g. .json, .md)
      }

      const result = this.analyzeFile(sourceFile, checker, repoPath, ownedPath);
      symbols.push(...result.symbols);
      edges.push(...result.edges);
      resolvedCount += result.resolvedCount;
    }

    return { edges, resolvedCount, symbols };
  }

  private analyzeFile(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    repoPath: string,
    relPath: string
  ): { edges: OracleEdge[]; resolvedCount: number; symbols: OracleSymbol[] } {
    const symbols: OracleSymbol[] = [];
    const edges: OracleEdge[] = [];
    let resolvedCount = 0;

    const getLine = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

    // ── Symbol extraction (same as parse-only oracle) ────────────────────────
    const pushSym = (
      localId: string,
      name: string,
      kind: SymbolType,
      parentLocalId: string | null,
      node: ts.Node
    ) => {
      symbols.push({
        endLine: getLine(node.getEnd()),
        kind,
        localId,
        name,
        parentLocalId,
        path: relPath,
        startLine: getLine(node.getStart(sourceFile)),
      });
    };

    // ── Edge extraction with type-checker resolution ─────────────────────────
    const pushEdge: PushEdgeFn = (fromLocalId, targetName, type, targetSymbol, tier) => {
      const edge: OracleEdge = { fromLocalId, fromPath: relPath, targetName, type };
      if (tier) {
        edge.resolutionTier = tier;
      }

      if (targetSymbol) {
        const loc = resolveSymbolLocation(checker, targetSymbol, repoPath);
        if (loc) {
          edge.targetLocalId = loc.localId;
          edge.targetPath = loc.path;
          edge.targetStartLine = loc.startLine;
          resolvedCount++;
        }
      }

      edges.push(edge);
      return edge;
    };

    // Track the current container (for call site attribution)
    let currentContainer: string | null = null;

    const visit = (node: ts.Node) => {
      // ── Class declarations ──────────────────────────────────────────────
      if (ts.isClassDeclaration(node) && node.name) {
        const cname = node.name.text;
        currentContainer = cname;
        pushSym(cname, cname, 'Class', null, node);
        this.extractTypeParameterUsage(node.typeParameters, checker, cname, pushEdge);

        // Heritage clauses (extends + implements). Track the immediate base
        // class's type (F7 — nearest-ancestor override resolution) and the
        // implemented interfaces' types (F8 — member-level IMPLEMENTS) for
        // the member loop below.
        let baseClassType: ts.Type | null = null;
        const implementedTypes: ts.Type[] = [];
        for (const clause of node.heritageClauses ?? []) {
          for (const typeRef of clause.types) {
            const baseName = ts.isIdentifier(typeRef.expression)
              ? typeRef.expression.text
              : '[expr]';
            const baseSymbol = resolveHeritageBaseSymbol(checker, typeRef);
            const edgeType: EdgeType =
              clause.token === ts.SyntaxKind.ExtendsKeyword ? 'EXT***REMOVED***S' : 'IMPLEMENTS';
            const edge = pushEdge(cname, baseName, edgeType, baseSymbol);
            if (!edge.targetLocalId && baseName === '[expr]') {
              // F12: still unresolvable after the type-based fallback — don't
              // let it sit silently in a recall denominator no tool can hit.
              edge.scoreable = false;
            }

            // F4: heritage type arguments (`extends Base<Foo>`) are type usage.
            for (const ta of typeRef.typeArguments ?? []) {
              this.extractTypeUsage(ta, checker, cname, pushEdge);
            }

            try {
              const t = checker.getTypeAtLocation(typeRef);
              if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                baseClassType = t;
              } else {
                implementedTypes.push(t);
              }
            } catch {
              // leave unresolved — override/implements-member checks below no-op
            }
          }
        }

        // Class members
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member)) {
            const localId = `${cname}.constructor`;
            pushSym(localId, 'constructor', 'Constructor', cname, member);
            this.extractSignatureTypeUsage(member, checker, localId, pushEdge);
            currentContainer = localId;
            this.visitCallSites(member, checker, localId, pushEdge);
            this.visitTypeCasts(member, checker, localId, pushEdge);
            ts.forEachChild(member, visit);
            currentContainer = cname;
          } else if (ts.isMethodDeclaration(member) && member.name) {
            const mname = member.name.getText(sourceFile);
            const localId = `${cname}.${mname}`;
            pushSym(localId, mname, 'Method', cname, member);
            this.extractSignatureTypeUsage(member, checker, localId, pushEdge);

            // F7: does this method override an ancestor's method of the same name?
            if (baseClassType) {
              this.emitOverrideIfAny(baseClassType, mname, localId, repoPath, checker, pushEdge);
            }
            // F8: does this method satisfy a member of an implemented interface?
            for (const it of implementedTypes) {
              this.emitMemberImplementsIfAny(it, mname, localId, checker, pushEdge);
            }

            currentContainer = localId;
            this.visitCallSites(member, checker, localId, pushEdge);
            this.visitPropertyAccesses(member, checker, localId, pushEdge);
            this.visitTypeCasts(member, checker, localId, pushEdge);
            ts.forEachChild(member, visit);
            currentContainer = cname;
          } else if (ts.isGetAccessor(member)) {
            const aname = member.name.getText(sourceFile);
            const localId = `${cname}.get:${aname}`;
            pushSym(localId, `get:${aname}`, 'Method', cname, member);
            this.extractSignatureTypeUsage(member, checker, localId, pushEdge);
            // F5: accessor bodies are call/property-access/cast sites too.
            if (member.body) {
              this.visitCallSites(member.body, checker, localId, pushEdge);
              this.visitPropertyAccesses(member.body, checker, localId, pushEdge);
              this.visitTypeCasts(member.body, checker, localId, pushEdge);
            }
          } else if (ts.isSetAccessor(member)) {
            const aname = member.name.getText(sourceFile);
            const localId = `${cname}.set:${aname}`;
            pushSym(localId, `set:${aname}`, 'Method', cname, member);
            this.extractSignatureTypeUsage(member, checker, localId, pushEdge);
            if (member.body) {
              this.visitCallSites(member.body, checker, localId, pushEdge);
              this.visitPropertyAccesses(member.body, checker, localId, pushEdge);
              this.visitTypeCasts(member.body, checker, localId, pushEdge);
            }
          } else if (ts.isPropertyDeclaration(member) && member.name) {
            const pname = member.name.getText(sourceFile);
            const localId = `${cname}.${pname}`;
            pushSym(localId, pname, 'Property', cname, member);
            // USES_TYPE: if the property has a type annotation
            if (member.type) {
              this.extractTypeUsage(member.type, checker, localId, pushEdge);
            }
            // F5: property initialisers are call/property-access/cast sites too.
            if (member.initializer) {
              this.visitCallSites(member.initializer, checker, localId, pushEdge);
              this.visitPropertyAccesses(member.initializer, checker, localId, pushEdge);
              this.visitTypeCasts(member.initializer, checker, localId, pushEdge);
            }
          }
        }
      }
      // ── Interface declarations ──────────────────────────────────────────
      else if (ts.isInterfaceDeclaration(node) && node.name) {
        const iname = node.name.text;
        pushSym(iname, iname, 'Interface', null, node);
        this.extractTypeParameterUsage(node.typeParameters, checker, iname, pushEdge);

        // Interfaces can extend other interfaces
        for (const clause of node.heritageClauses ?? []) {
          for (const typeRef of clause.types) {
            const baseName = ts.isIdentifier(typeRef.expression)
              ? typeRef.expression.text
              : '[expr]';
            const baseSymbol = resolveHeritageBaseSymbol(checker, typeRef);
            const edge = pushEdge(iname, baseName, 'EXT***REMOVED***S', baseSymbol);
            if (!edge.targetLocalId && baseName === '[expr]') {
              edge.scoreable = false; // F12
            }
            for (const ta of typeRef.typeArguments ?? []) {
              this.extractTypeUsage(ta, checker, iname, pushEdge); // F4
            }
          }
        }

        for (const member of node.members) {
          if (ts.isMethodSignature(member) && member.name) {
            const mname = member.name.getText(sourceFile);
            const localId = `${iname}.${mname}`;
            pushSym(localId, mname, 'Method', iname, member);
            this.extractSignatureTypeUsage(member, checker, localId, pushEdge);
          } else if (ts.isPropertySignature(member) && member.name) {
            const pname = member.name.getText(sourceFile);
            const localId = `${iname}.${pname}`;
            pushSym(localId, pname, 'Property', iname, member);
            if (member.type) {
              this.extractTypeUsage(member.type, checker, localId, pushEdge);
            }
          }
        }
      }
      // ── Enum declarations ───────────────────────────────────────────────
      else if (ts.isEnumDeclaration(node) && node.name) {
        const ename = node.name.text;
        pushSym(ename, ename, 'Enum', null, node);
        for (const member of node.members) {
          const mname = member.name.getText(sourceFile);
          pushSym(`${ename}.${mname}`, mname, 'Property', ename, member);
        }
      }
      // ── Type aliases ─────────────────────────────────────────────────────
      else if (ts.isTypeAliasDeclaration(node) && node.name) {
        const tname = node.name.text;
        pushSym(tname, tname, 'Alias', null, node);
        this.extractTypeParameterUsage(node.typeParameters, checker, tname, pushEdge);
        this.extractTypeUsage(node.type, checker, tname, pushEdge); // F4: alias body
      }
      // ── Function declarations ────────────────────────────────────────────
      else if (ts.isFunctionDeclaration(node) && node.name) {
        const fname = node.name.text;
        pushSym(fname, fname, 'Function', null, node);
        this.extractSignatureTypeUsage(node, checker, fname, pushEdge);
        currentContainer = fname;
        this.visitCallSites(node, checker, fname, pushEdge);
        this.visitPropertyAccesses(node, checker, fname, pushEdge);
        this.visitTypeCasts(node, checker, fname, pushEdge);
        ts.forEachChild(node, visit);
        currentContainer = null;
      }
      // ── Variable statements (including arrow functions) ─────────────────
      else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) {
            continue;
          }
          const vname = decl.name.text;
          const isFn =
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
          pushSym(vname, vname, isFn ? 'Function' : 'GlobalVariable', null, node);
          if (isFn && decl.initializer) {
            const fnNode = decl.initializer as ts.ArrowFunction | ts.FunctionExpression;
            this.extractSignatureTypeUsage(fnNode, checker, vname, pushEdge);
            currentContainer = vname;
            this.visitCallSites(fnNode, checker, vname, pushEdge);
            this.visitPropertyAccesses(fnNode, checker, vname, pushEdge);
            this.visitTypeCasts(fnNode, checker, vname, pushEdge);
            ts.forEachChild(fnNode, visit);
            currentContainer = null;
          }
          // USES_TYPE: variable type annotations
          if (decl.type) {
            this.extractTypeUsage(decl.type, checker, vname, pushEdge);
          }
        }
      }
      // ── Import declarations ──────────────────────────────────────────────
      else if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = (node.moduleSpecifier as ts.StringLiteral).text;
        const clause = node.importClause;
        if (clause) {
          if (clause.name) {
            // Default import
            const importName = clause.name.text;
            const symbol = checker.getSymbolAtLocation(clause.name) ?? null;
            pushEdge(relPath, importName, 'IMPORTS', symbol);
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              const nsName = clause.namedBindings.name.text;
              const symbol = checker.getSymbolAtLocation(clause.namedBindings.name) ?? null;
              pushEdge(relPath, nsName, 'IMPORTS', symbol);
            } else {
              for (const el of clause.namedBindings.elements) {
                const elName = el.name.text;
                // Resolve the imported NAME, not the ImportSpecifier node —
                // getSymbolAtLocation(el) yields nothing, so named imports were
                // never target-resolved (only 1.4% of all imports resolved).
                // getSymbolAtLocation(el.name) returns the local alias symbol,
                // which resolveSymbolLocation then follows to the real declaration.
                const symbol = checker.getSymbolAtLocation(el.name) ?? null;
                pushEdge(relPath, elName, 'IMPORTS', symbol);
              }
            }
          }
        } else {
          // Side-effect import: import './foo'
          pushEdge(relPath, moduleSpecifier, 'IMPORTS', null);
        }
      }
      // ── Module / namespace / global-augmentation declarations ───────────
      // F3: `ts.forEachChild` on a ModuleDeclaration yields the ModuleBlock,
      // which the old code never descended into — nothing declared inside
      // `declare module "…" { … }` or `declare global { … }` was ever
      // emitted. Emit a symbol for the module/namespace itself, then recurse
      // into its body's statements directly. Declaration merging (the same
      // interface name augmented from multiple files) falls out for free:
      // each occurrence is its own `visit` call, pushed with its own `path`.
      else if (ts.isModuleDeclaration(node)) {
        // `.text` (not `.getText()`) so a string-literal specifier comes
        // through as `./x`, not the quoted source text `"./x"`.
        const mname = node.name.text;
        const kind: SymbolType = ts.isStringLiteral(node.name) ? 'Module' : 'Namespace';
        pushSym(mname, mname, kind, null, node);
        const prevContainer = currentContainer;
        currentContainer = mname;
        if (node.body) {
          if (ts.isModuleBlock(node.body)) {
            for (const stmt of node.body.statements) {
              visit(stmt);
            }
          } else if (ts.isModuleDeclaration(node.body)) {
            // Dotted namespace (`namespace A.B.C {}`) parses as nested
            // ModuleDeclarations — recurse directly into the next one.
            visit(node.body);
          }
        }
        currentContainer = prevContainer;
      }
    };

    ts.forEachChild(sourceFile, visit);

    // Module-scope calls (top-level code) → attributed to the File.
    this.visitModuleScopeCalls(sourceFile, checker, relPath, pushEdge);

    return { edges, resolvedCount, symbols };
  }

  /**
   * True if an arrow/function-expression is bound to a name (a variable, a class
   * field, or an object/assignment property). Name-bound functions are their own
   * container and are captured separately — so call extraction must STOP at them.
   * Anonymous inline callbacks (passed as arguments, IIFEs, array elements, …)
   * are NOT name-bound: their calls belong to the nearest named enclosing
   * function/method, which is exactly how both the resolved-edge and
   * GitNexus adapters attribute them.
   */
  private isNameBound(fn: ts.Node): boolean {
    const p = fn.parent;
    if (!p) {
      return false;
    }
    return (
      ts.isVariableDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isBinaryExpression(p) // x.y = () => {…}
    );
  }

  /**
   * Walk a container body and extract CallExpression sites.
   *
   * Recurses THROUGH anonymous callbacks (arrow/function expressions passed
   * inline) so their calls are attributed to `containerLocalId` — matching how
   * both tools attribute callback calls. Stops at nested named functions, class
   * fields/accessors, and class/interface declarations, which are captured as
   * their own containers (F5: or, for accessors/fields, called directly on
   * their own body/initializer by the caller — see the class-member loop above).
   */
  private visitCallSites(
    node: ts.Node,
    checker: ts.TypeChecker,
    containerLocalId: string,
    pushEdge: PushEdgeFn
  ): void {
    const visit = (n: ts.Node) => {
      if (n !== node) {
        // Nested named function declarations rebind the container.
        if (ts.isFunctionDeclaration(n)) {
          return;
        }
        // Name-bound arrows/func-expressions are separate containers (or skipped
        // fields/accessors). Anonymous inline callbacks fall through and recurse.
        if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && this.isNameBound(n)) {
          return;
        }
        // Nested accessors/property initialisers are their own containers,
        // visited directly by the caller (F5) — don't double-attribute here.
        if (ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isPropertyDeclaration(n)) {
          return;
        }
        if (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) {
          return;
        }
      }

      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const calleeName = this.getCalleeName(n);
        if (calleeName) {
          // F10: cascade of resolution strategies; union-typed receivers can
          // resolve to more than one in-repo declaration.
          const { symbols, tier } = resolveCalleeSymbols(checker, n);
          if (symbols.length > 0) {
            for (const sym of symbols) {
              pushEdge(containerLocalId, calleeName, 'CALLS', sym, tier);
            }
          } else {
            pushEdge(containerLocalId, calleeName, 'CALLS', null, tier);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /**
   * Extract module-scope call sites (top-level code outside any function/method)
   * and attribute them to the File. Both the resolved-edge and GitNexus
   * adapters attribute
   * module-scope calls to the File node, so this is a fair, agreed convention.
   *
   * Container declarations (functions, classes, interfaces, enums, imports,
   * type aliases, namespaces) are captured elsewhere and skipped here.
   * visitCallSites stops at name-bound functions, so function-valued top-level
   * variables are not double-counted.
   */
  private visitModuleScopeCalls(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    relPath: string,
    pushEdge: PushEdgeFn
  ): void {
    for (const st of sourceFile.statements) {
      if (
        ts.isFunctionDeclaration(st) ||
        ts.isClassDeclaration(st) ||
        ts.isInterfaceDeclaration(st) ||
        ts.isEnumDeclaration(st) ||
        ts.isModuleDeclaration(st) ||
        ts.isImportDeclaration(st) ||
        ts.isExportDeclaration(st) ||
        ts.isTypeAliasDeclaration(st)
      ) {
        continue;
      }
      this.visitCallSites(st, checker, relPath, pushEdge);
    }
  }

  /** Walk a function/method body and extract PropertyAccessExpression sites (ACCESSES). */
  private visitPropertyAccesses(
    node: ts.Node,
    checker: ts.TypeChecker,
    containerLocalId: string,
    pushEdge: PushEdgeFn
  ) {
    const visit = (n: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
        n !== node
      ) {
        return;
      }

      if (ts.isPropertyAccessExpression(n) && !ts.isCallExpression(n.parent)) {
        const propName = n.name.text;
        const symbol = checker.getSymbolAtLocation(n) ?? null;
        pushEdge(containerLocalId, propName, 'ACCESSES', symbol);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /**
   * F4: walk a container body and extract `as`/`satisfies` casts as USES_TYPE
   * edges — a cast is a type reference just as much as an annotation is.
   */
  private visitTypeCasts(
    node: ts.Node,
    checker: ts.TypeChecker,
    containerLocalId: string,
    pushEdge: PushEdgeFn
  ): void {
    const visit = (n: ts.Node) => {
      if (
        (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) &&
        n !== node
      ) {
        return;
      }
      if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) {
        this.extractTypeUsage(n.type, checker, containerLocalId, pushEdge);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /**
   * F4: USES_TYPE for a signature's parameters, return type, and type-parameter
   * constraints/defaults. Shared by class methods/constructors/accessors,
   * interface method signatures, function declarations and function
   * expressions/arrows — anything shaped like `ts.SignatureDeclarationBase`.
   */
  private extractSignatureTypeUsage(
    sig: ts.SignatureDeclarationBase,
    checker: ts.TypeChecker,
    containerLocalId: string,
    pushEdge: PushEdgeFn
  ): void {
    for (const param of sig.parameters) {
      if (param.type) {
        this.extractTypeUsage(param.type, checker, containerLocalId, pushEdge);
      }
    }
    if (sig.type) {
      this.extractTypeUsage(sig.type, checker, containerLocalId, pushEdge);
    }
    this.extractTypeParameterUsage(sig.typeParameters, checker, containerLocalId, pushEdge);
  }

  /** F4: USES_TYPE for generic constraints/defaults (`class Foo<T extends Bar>`). */
  private extractTypeParameterUsage(
    typeParams: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
    checker: ts.TypeChecker,
    containerLocalId: string,
    pushEdge: PushEdgeFn
  ): void {
    for (const tp of typeParams ?? []) {
      if (tp.constraint) {
        this.extractTypeUsage(tp.constraint, checker, containerLocalId, pushEdge);
      }
      if (tp.default) {
        this.extractTypeUsage(tp.default, checker, containerLocalId, pushEdge);
      }
    }
  }

  /** Extract type usage from a TypeNode (USES_TYPE edges). */
  private extractTypeUsage(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    fromLocalId: string,
    pushEdge: PushEdgeFn
  ) {
    const visit = (n: ts.Node) => {
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
        const typeName = n.typeName.text;
        const symbol = checker.getSymbolAtLocation(n.typeName) ?? null;
        pushEdge(fromLocalId, typeName, 'USES_TYPE', symbol);
      }
      ts.forEachChild(n, visit);
    };
    visit(typeNode);
  }

  /**
   * F7: does `methodName` override a method of the same name declared on an
   * ancestor? `baseType.getProperty(name)` already resolves through the full
   * inheritance chain — if the immediate base doesn't declare `name` itself,
   * it returns the symbol from whichever ancestor actually does, which is
   * exactly "nearest ancestor declaring the same name".
   */
  private emitOverrideIfAny(
    baseType: ts.Type,
    methodName: string,
    fromLocalId: string,
    repoPath: string,
    checker: ts.TypeChecker,
    pushEdge: PushEdgeFn
  ): void {
    let baseProp: ts.Symbol | undefined;
    try {
      baseProp = baseType.getProperty(methodName);
    } catch {
      return;
    }
    if (!baseProp) {
      return;
    }
    const loc = resolveSymbolLocation(checker, baseProp, repoPath);
    if (loc && loc.localId === fromLocalId) {
      return; // resolved back to itself — not a real override
    }
    pushEdge(fromLocalId, methodName, 'METHOD_OVERRIDES', baseProp);
  }

  /**
   * F8: does `methodName` satisfy a member of an implemented interface? This
   * is the member-level companion to the oracle's existing class-level
   * IMPLEMENTS edge (heritage clause only) — scored in a separate table by
   * `d2-fidelity.scorer.ts` so tools aren't penalised for not modelling it.
   */
  private emitMemberImplementsIfAny(
    interfaceType: ts.Type,
    methodName: string,
    fromLocalId: string,
    checker: ts.TypeChecker,
    pushEdge: PushEdgeFn
  ): void {
    let prop: ts.Symbol | undefined;
    try {
      prop = interfaceType.getProperty(methodName);
    } catch {
      return;
    }
    if (!prop) {
      return;
    }
    pushEdge(fromLocalId, methodName, 'IMPLEMENTS', prop);
  }

  /** Get the callee name from a CallExpression (for name-based matching fallback). */
  private getCalleeName(node: ts.CallExpression | ts.NewExpression): string | null {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) {
      return expr.text;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      return expr.name.text;
    }
    return null;
  }
}

/**
 * F9 — normalize `scoreable` for edge types where "no resolved target" means
 * something definite: after F10's exhaustive call-resolution cascade and
 * F12's heritage fallback, a CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS edge still
 * lacking a `targetLocalId` is either pointing outside the repo (external
 * package, builtin) or is genuinely unresolvable even to the type checker —
 * either way, no tool built from this repo's source can ever win it, so it
 * must not sit in a recall denominator (see F9 in
 * CODE_GRAPH_EVAL_FAIRNESS_PLAN.md). Left as a post-processing pass (not
 * baked into every `pushEdge` call site) so it applies uniformly to both a
 * fresh analysis and a cached JSONL from before this field existed, without
 * requiring the expensive type-check to re-run. Doesn't touch edges that
 * already carry an explicit `scoreable` (e.g. F12's `[expr]` heritage case),
 * and doesn't touch edge types (USES_TYPE, ACCESSES, METHOD_OVERRIDES) whose
 * unresolved-target population wasn't part of this fix.
 */
const SCOREABLE_DERIVATION_TYPES: ReadonlySet<EdgeType> = new Set([
  'CALLS',
  'IMPORTS',
  'EXT***REMOVED***S',
  'IMPLEMENTS',
]);

export function deriveScoreable(edges: OracleEdge[]): OracleEdge[] {
  for (const e of edges) {
    if (e.scoreable === undefined && SCOREABLE_DERIVATION_TYPES.has(e.type)) {
      e.scoreable = !!e.targetLocalId;
    }
  }
  return edges;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

function writeJsonl(path: string, items: readonly unknown[]): void {
  writeFileSync(path, items.map((i) => JSON.stringify(i)).join('\n') + '\n');
}

/** Filesystem-safe label for a project's JSONL pair — '.' (root) becomes 'root'. */
function projectFileSlug(project: OracleProject): string {
  const slug = project.id.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'root';
}

/**
 * Run the type-checker oracle, with per-project caching (§1.4). Each
 * project's symbols/edges persist to their own JSONL pair under
 * `outDir/projects/` as soon as that project finishes, so an interrupted
 * multi-hour run resumes from "N done" under `--use-cache` instead of
 * restarting from project 1. The combined `oracle-symbols.jsonl` /
 * `oracle-edges.jsonl` at `outDir` are still written at the end, unchanged,
 * for existing consumers (runner.ts, scorers).
 */
export async function runTypeCheckerOracle(
  opts: TypeCheckerOracleOptions
): Promise<TypeCheckerOracleResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const projectsDir = join(opts.outDir, 'projects');
  mkdirSync(projectsDir, { recursive: true });

  const files = walkRepoFiles(opts.repoPath);
  const projects = discoverProjects(files);
  const ownership = assignFileOwnership(projects, files);
  console.log(`[typechecker-oracle] Discovered ${projects.length} project(s)`);

  const oracle = new TsTypeCheckerOracle();
  const seen = new Set<string>();
  const allSymbols: OracleSymbol[] = [];
  const allEdges: OracleEdge[] = [];

  let projectNum = 0;
  for (const project of projects) {
    projectNum++;
    const ownedFiles = files.filter((f) => ownership.get(f) === project);
    if (ownedFiles.length === 0) {
      continue;
    }
    assertFilesOwnedOnce(ownedFiles, seen);

    const slug = projectFileSlug(project);
    const symbolsPath = join(projectsDir, `${slug}.symbols.jsonl`);
    const edgesPath = join(projectsDir, `${slug}.edges.jsonl`);

    let symbols: OracleSymbol[];
    let edges: OracleEdge[];

    if (opts.useCache && existsSync(symbolsPath) && existsSync(edgesPath)) {
      symbols = readJsonl<OracleSymbol>(symbolsPath);
      edges = deriveScoreable(readJsonl<OracleEdge>(edgesPath));
      console.log(
        `[typechecker-oracle] Project ${projectNum}/${projects.length} (${project.rootPath}): ` +
          `cached (${symbols.length} symbols, ${edges.length} edges)`
      );
    } else {
      const start = Date.now();
      const result = oracle.analyzeProject(opts.repoPath, project, ownedFiles);
      symbols = result.symbols;
      edges = deriveScoreable(result.edges);
      writeJsonl(symbolsPath, symbols);
      writeJsonl(edgesPath, edges);
      console.log(
        `[typechecker-oracle] Project ${projectNum}/${projects.length} (${project.rootPath}): ` +
          `${ownedFiles.length} files, ${symbols.length} symbols, ${edges.length} edges, ${Date.now() - start}ms`
      );
    }

    // Not `push(...symbols)` — spreading tens/hundreds of thousands of elements
    // as call arguments blows the engine's argument-count limit (hit at vscode's
    // root project: 122,594 symbols / 728,994 edges in one project).
    for (const s of symbols) {
      allSymbols.push(s);
    }
    for (const e of edges) {
      allEdges.push(e);
    }
  }

  const resolvedCount = allEdges.filter((e) => e.targetLocalId).length;

  writeJsonl(join(opts.outDir, 'oracle-symbols.jsonl'), allSymbols);
  writeJsonl(join(opts.outDir, 'oracle-edges.jsonl'), allEdges);
  console.log(
    `[typechecker-oracle] Done: ${allSymbols.length} symbols, ${allEdges.length} edges (${resolvedCount} resolved). Wrote to ${opts.outDir}`
  );

  return { edges: allEdges, resolvedCount, symbols: allSymbols, totalEdges: allEdges.length };
}
