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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import type { EdgeType, OracleEdge, OracleSymbol, SymbolType } from '../types';

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

/** Get the relative path of a source file, or null if it's outside the repo. */
function getRelPath(repoPath: string, fileName: string): string | null {
  const rel = relative(repoPath, fileName);
  if (rel.startsWith('..') || rel.includes('node_modules')) return null;
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
  repoPath: string,
): { localId: string; path: string; startLine: number } | null {
  // Follow alias symbols (e.g. re-exports) to the real declaration
  let resolved = symbol;
  let depth = 0;
  while ((resolved.flags & ts.SymbolFlags.Alias) && depth < 5) {
    try {
      resolved = checker.getAliasedSymbol(resolved);
    } catch {
      break;
    }
    depth++;
  }

  const decl = resolved.valueDeclaration ?? resolved.declarations?.[0];
  if (!decl) return null;

  const sourceFile = decl.getSourceFile();
  const relPath = getRelPath(repoPath, sourceFile.fileName);
  if (!relPath) return null; // External (node_modules or .d.ts)

  const startLine = getStartLine(decl, sourceFile);
  const name = resolved.getName();
  const localId = getLocalId(decl, sourceFile, name);

  return { localId, path: relPath, startLine };
}

/** Extract the callee symbol from a CallExpression. */
function getCalleeSymbol(
  checker: ts.TypeChecker,
  callExpr: ts.CallExpression,
): ts.Symbol | null {
  // For `foo()`: symbol of `foo`
  // For `obj.bar()`: symbol of the property access `obj.bar`
  // For `Class.method()`: symbol of the property access
  const expr = callExpr.expression;
  const symbol = checker.getSymbolAtLocation(expr);
  if (symbol) return symbol;

  // For parenthesized expressions, try the inner expression
  if (ts.isParenthesizedExpression(expr)) {
    return getCalleeSymbol(checker, ts.factory.createCallExpression(expr.expression, undefined, callExpr.arguments));
  }

  // For `new ClassName()`: the constructor
  if (ts.isNewExpression(callExpr)) {
    const classSymbol = checker.getSymbolAtLocation(callExpr.expression);
    if (classSymbol) {
      // Get the constructor declaration
      const classType = checker.getTypeOfSymbolAtLocation(classSymbol, callExpr);
      const constructSignatures = classType.getConstructSignatures();
      if (constructSignatures.length > 0) {
        return constructSignatures[0].declaration
          ? checker.getSymbolAtLocation(callExpr.expression)
          : null;
      }
    }
  }

  return null;
}

export class TsTypeCheckerOracle {
  analyze(repoPath: string): TypeCheckerOracleResult {
    // 1. Find and parse tsconfig.json
    const configPath = ts.findConfigFile(repoPath, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) {
      throw new Error('No tsconfig.json found');
    }
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(`tsconfig parse error: ${configFile.error.messageText}`);
    }
    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      repoPath,
    );

    console.log(`[typechecker-oracle] Creating TS Program with ${parsedConfig.fileNames.length} files...`);

    // 2. Create Program (with skipLibCheck for speed, noEmit since we only read)
    const program = ts.createProgram({
      rootNames: parsedConfig.fileNames,
      options: {
        ...parsedConfig.options,
        noEmit: true,
        skipLibCheck: true,
        declaration: false,
        sourceMap: false,
      },
    });

    console.log(`[typechecker-oracle] Program created. Getting type checker...`);
    const checker = program.getTypeChecker();

    // 3. Walk each source file
    const symbols: OracleSymbol[] = [];
    const edges: OracleEdge[] = [];
    let resolvedCount = 0;

    const sourceFiles = program.getSourceFiles().filter(
      (sf) => !sf.isDeclarationFile && getRelPath(repoPath, sf.fileName) !== null,
    );
    console.log(`[typechecker-oracle] Analyzing ${sourceFiles.length} source files...`);

    let fileNum = 0;
    for (const sourceFile of sourceFiles) {
      const relPath = getRelPath(repoPath, sourceFile.fileName)!;
      fileNum++;
      if (fileNum % 500 === 0) {
        console.log(`[typechecker-oracle]   ${fileNum}/${sourceFiles.length} files...`);
      }

      const result = this.analyzeFile(sourceFile, checker, repoPath, relPath);
      symbols.push(...result.symbols);
      edges.push(...result.edges);
      resolvedCount += result.resolvedCount;
    }

    console.log(`[typechecker-oracle] Done: ${symbols.length} symbols, ${edges.length} edges (${resolvedCount} resolved)`);

    return { edges, resolvedCount, symbols, totalEdges: edges.length };
  }

  private analyzeFile(
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    repoPath: string,
    relPath: string,
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
      node: ts.Node,
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
    const pushEdge = (
      fromLocalId: string,
      targetName: string,
      type: EdgeType,
      targetSymbol: ts.Symbol | null,
    ) => {
      const edge: OracleEdge = { fromLocalId, targetName, type };

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
    };

    // Track the current container (for call site attribution)
    let currentContainer: string | null = null;

    const visit = (node: ts.Node) => {
      // ── Class declarations ──────────────────────────────────────────────
      if (ts.isClassDeclaration(node) && node.name) {
        const cname = node.name.text;
        currentContainer = cname;
        pushSym(cname, cname, 'Class', null, node);

        // Heritage clauses (extends + implements)
        for (const clause of node.heritageClauses ?? []) {
          for (const typeRef of clause.types) {
            const baseName = ts.isIdentifier(typeRef.expression)
              ? typeRef.expression.text
              : '[expr]';
            const baseSymbol = checker.getSymbolAtLocation(typeRef.expression);
            const edgeType: EdgeType = clause.token === ts.SyntaxKind.ExtendsKeyword ? 'EXT***REMOVED***S' : 'IMPLEMENTS';
            pushEdge(cname, baseName, edgeType, baseSymbol);
          }
        }

        // Class members
        for (const member of node.members) {
          if (ts.isConstructorDeclaration(member)) {
            pushSym(`${cname}.constructor`, 'constructor', 'Constructor', cname, member);
            currentContainer = `${cname}.constructor`;
            this.visitCallSites(member, checker, `${cname}.constructor`, pushEdge);
            ts.forEachChild(member, visit);
            currentContainer = cname;
          } else if (ts.isMethodDeclaration(member) && member.name) {
            const mname = member.name.getText(sourceFile);
            pushSym(`${cname}.${mname}`, mname, 'Method', cname, member);
            currentContainer = `${cname}.${mname}`;
            this.visitCallSites(member, checker, `${cname}.${mname}`, pushEdge);
            this.visitPropertyAccesses(member, checker, `${cname}.${mname}`, pushEdge);
            ts.forEachChild(member, visit);
            currentContainer = cname;
          } else if (ts.isGetAccessor(member)) {
            const aname = member.name.getText(sourceFile);
            pushSym(`${cname}.get:${aname}`, `get:${aname}`, 'Method', cname, member);
          } else if (ts.isSetAccessor(member)) {
            const aname = member.name.getText(sourceFile);
            pushSym(`${cname}.set:${aname}`, `set:${aname}`, 'Method', cname, member);
          } else if (ts.isPropertyDeclaration(member) && member.name) {
            const pname = member.name.getText(sourceFile);
            pushSym(`${cname}.${pname}`, pname, 'Property', cname, member);
            // USES_TYPE: if the property has a type annotation
            if (member.type) {
              this.extractTypeUsage(member.type, checker, `${cname}.${pname}`, pushEdge);
            }
          }
        }
      }
      // ── Interface declarations ──────────────────────────────────────────
      else if (ts.isInterfaceDeclaration(node) && node.name) {
        const iname = node.name.text;
        pushSym(iname, iname, 'Interface', null, node);

        // Interfaces can extend other interfaces
        for (const clause of node.heritageClauses ?? []) {
          for (const typeRef of clause.types) {
            const baseName = ts.isIdentifier(typeRef.expression)
              ? typeRef.expression.text
              : '[expr]';
            const baseSymbol = checker.getSymbolAtLocation(typeRef.expression);
            pushEdge(iname, baseName, 'EXT***REMOVED***S', baseSymbol);
          }
        }

        for (const member of node.members) {
          if (ts.isMethodSignature(member) && member.name) {
            const mname = member.name.getText(sourceFile);
            pushSym(`${iname}.${mname}`, mname, 'Method', iname, member);
          } else if (ts.isPropertySignature(member) && member.name) {
            const pname = member.name.getText(sourceFile);
            pushSym(`${iname}.${pname}`, pname, 'Property', iname, member);
            if (member.type) {
              this.extractTypeUsage(member.type, checker, `${iname}.${pname}`, pushEdge);
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
      }
      // ── Function declarations ────────────────────────────────────────────
      else if (ts.isFunctionDeclaration(node) && node.name) {
        const fname = node.name.text;
        pushSym(fname, fname, 'Function', null, node);
        currentContainer = fname;
        this.visitCallSites(node, checker, fname, pushEdge);
        this.visitPropertyAccesses(node, checker, fname, pushEdge);
        ts.forEachChild(node, visit);
        currentContainer = null;
      }
      // ── Variable statements (including arrow functions) ─────────────────
      else if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const vname = decl.name.text;
          const isFn = decl.initializer && (
            ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer)
          );
          pushSym(vname, vname, isFn ? 'Function' : 'GlobalVariable', null, node);
          if (isFn && decl.initializer) {
            currentContainer = vname;
            this.visitCallSites(decl.initializer, checker, vname, pushEdge);
            this.visitPropertyAccesses(decl.initializer, checker, vname, pushEdge);
            ts.forEachChild(decl.initializer, visit);
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
            const symbol = checker.getSymbolAtLocation(clause.name);
            pushEdge(relPath, importName, 'IMPORTS', symbol);
          }
          if (clause.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) {
              const nsName = clause.namedBindings.name.text;
              const symbol = checker.getSymbolAtLocation(clause.namedBindings.name);
              pushEdge(relPath, nsName, 'IMPORTS', symbol);
            } else {
              for (const el of clause.namedBindings.elements) {
                const elName = el.name.text;
                // Resolve the imported NAME, not the ImportSpecifier node —
                // getSymbolAtLocation(el) yields nothing, so named imports were
                // never target-resolved (only 1.4% of all imports resolved).
                // getSymbolAtLocation(el.name) returns the local alias symbol,
                // which resolveSymbolLocation then follows to the real declaration.
                const symbol = checker.getSymbolAtLocation(el.name);
                pushEdge(relPath, elName, 'IMPORTS', symbol);
              }
            }
          }
        } else {
          // Side-effect import: import './foo'
          pushEdge(relPath, moduleSpecifier, 'IMPORTS', null);
        }
      }

    // NOTE: Do NOT recurse into function/method bodies here — that would
    // extract local variables as GlobalVariables. Call site extraction is
    // handled separately by visitCallSites/visitPropertyAccesses.
    // Only recurse into namespaces/modules (which contain top-level decls).
    if (ts.isModuleDeclaration(node)) {
      ts.forEachChild(node, visit);
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
   * function/method, which is exactly how both Vyazen and GitNexus attribute them.
   */
  private isNameBound(fn: ts.Node): boolean {
    const p = fn.parent;
    if (!p) return false;
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
   * their own containers (or deliberately skipped, for accessors/fields).
   */
  private visitCallSites(
    node: ts.Node,
    checker: ts.TypeChecker,
    containerLocalId: string,
    pushEdge: (from: string, name: string, type: EdgeType, sym: ts.Symbol | null) => void,
  ): void {
    const visit = (n: ts.Node) => {
      if (n !== node) {
        // Nested named function declarations rebind the container.
        if (ts.isFunctionDeclaration(n)) return;
        // Name-bound arrows/func-expressions are separate containers (or skipped
        // fields/accessors). Anonymous inline callbacks fall through and recurse.
        if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && this.isNameBound(n)) return;
        // Accessors and property/field initializers: tools disagree — skip.
        if (ts.isGetAccessor(n) || ts.isSetAccessor(n) || ts.isPropertyDeclaration(n)) return;
        if (ts.isClassDeclaration(n) || ts.isInterfaceDeclaration(n)) return;
      }

      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const calleeName = this.getCalleeName(n);
        if (calleeName) {
          const symbol = this.getCalleeSymbolSafe(checker, n);
          pushEdge(containerLocalId, calleeName, 'CALLS', symbol);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /**
   * Extract module-scope call sites (top-level code outside any function/method)
   * and attribute them to the File. Both Vyazen and GitNexus attribute
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
    pushEdge: (from: string, name: string, type: EdgeType, sym: ts.Symbol | null) => void,
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
    pushEdge: (from: string, name: string, type: EdgeType, sym: ts.Symbol | null) => void,
  ) {
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
        if (n !== node) return;
      }

      if (ts.isPropertyAccessExpression(n) && !ts.isCallExpression(n.parent)) {
        const propName = n.name.text;
        const symbol = checker.getSymbolAtLocation(n);
        pushEdge(containerLocalId, propName, 'ACCESSES', symbol);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }

  /** Extract type usage from a TypeNode (USES_TYPE edges). */
  private extractTypeUsage(
    typeNode: ts.TypeNode,
    checker: ts.TypeChecker,
    fromLocalId: string,
    pushEdge: (from: string, name: string, type: EdgeType, sym: ts.Symbol | null) => void,
  ) {
    const visit = (n: ts.Node) => {
      if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
        const typeName = n.typeName.text;
        const symbol = checker.getSymbolAtLocation(n.typeName);
        pushEdge(fromLocalId, typeName, 'USES_TYPE', symbol);
      }
      ts.forEachChild(n, visit);
    };
    visit(typeNode);
  }

  /** Get the callee name from a CallExpression (for name-based matching fallback). */
  private getCalleeName(node: ts.CallExpression | ts.NewExpression): string | null {
    const expr = node.expression;
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return null;
  }

  /** Safe wrapper around getCalleeSymbol that catches errors. */
  private getCalleeSymbolSafe(checker: ts.TypeChecker, node: ts.CallExpression | ts.NewExpression): ts.Symbol | null {
    try {
      if (ts.isNewExpression(node)) {
        return checker.getSymbolAtLocation(node.expression);
      }
      return checker.getSymbolAtLocation(node.expression);
    } catch {
      return null;
    }
  }
}

/** Run the type-checker oracle, with caching. */
export async function runTypeCheckerOracle(opts: TypeCheckerOracleOptions): Promise<TypeCheckerOracleResult> {
  mkdirSync(opts.outDir, { recursive: true });
  const symbolsPath = join(opts.outDir, 'oracle-symbols.jsonl');
  const edgesPath = join(opts.outDir, 'oracle-edges.jsonl');

  if (opts.useCache && existsSync(symbolsPath) && existsSync(edgesPath)) {
    const symbols = readFileSync(symbolsPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as OracleSymbol);
    const edges = readFileSync(edgesPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as OracleEdge);
    const resolvedCount = edges.filter((e) => e.targetLocalId).length;
    console.log(`[typechecker-oracle] Cached: ${symbols.length} symbols, ${edges.length} edges (${resolvedCount} resolved)`);
    return { edges, resolvedCount, symbols, totalEdges: edges.length };
  }

  const oracle = new TsTypeCheckerOracle();
  const result = oracle.analyze(opts.repoPath);

  writeFileSync(symbolsPath, result.symbols.map((s) => JSON.stringify(s)).join('\n') + '\n');
  writeFileSync(edgesPath, result.edges.map((e) => JSON.stringify(e)).join('\n') + '\n');
  console.log(`[typechecker-oracle] Wrote to ${opts.outDir}`);

  return result;
}
