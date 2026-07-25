/**
 * Oracle runner — runs the TS compiler oracle on a repo and produces
 * ground-truth symbols + edges for D1/D2 adjudication.
 *
 * Output:
 *   oracle-symbols.jsonl — one OracleSymbol per line
 *   oracle-edges.jsonl   — one OracleEdge per line
 *
 * The oracle is parse-only (no type checker) — see the methodology caveat
 * in ts-compiler.oracle.ts. It is the neutral ground truth.
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TsCompilerOracle, listSourceFiles, type OracleFileResultWithCalls } from './ts-compiler.oracle';
import type { OracleEdge, OracleSymbol } from '../types';

export interface OracleRunOptions {
  useCache?: boolean;
  outDir: string;
  repoPath: string;
}

export interface OracleData {
  edges: OracleEdge[];
  symbols: OracleSymbol[];
}

export async function runOracle(opts: OracleRunOptions): Promise<OracleData> {
  mkdirSync(opts.outDir, { recursive: true });
  const symbolsPath = join(opts.outDir, 'oracle-symbols.jsonl');
  const edgesPath = join(opts.outDir, 'oracle-edges.jsonl');

  if (opts.useCache && existsSync(symbolsPath) && existsSync(edgesPath)) {
    const symbols = readFileSync(symbolsPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as OracleSymbol);
    const edges = readFileSync(edgesPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as OracleEdge);
    console.log(`[oracle] Cached: ${symbols.length} symbols, ${edges.length} edges`);
    return { edges, symbols };
  }

  console.log('[oracle] Listing source files...');
  const files = listSourceFiles(opts.repoPath);
  console.log(`[oracle] ${files.length} TS/JS files to analyze`);

  console.log('[oracle] Running TS compiler oracle (parse-only)...');
  const oracle = new TsCompilerOracle();
  const results: OracleFileResultWithCalls[] = await oracle.analyze(opts.repoPath, files);

  // Flatten symbols
  const symbols: OracleSymbol[] = [];
  for (const r of results) {
    for (const s of r.symbols) {
      symbols.push(s);
    }
  }
  console.log(`[oracle] ${symbols.length} symbols extracted`);

  // Build edges
  const edges: OracleEdge[] = [];
  for (const r of results) {
    // IMPORTS — fromLocalId is the file path (file-level imports)
    for (const imp of r.imports) {
      edges.push({
        fromLocalId: r.path,
        targetName: imp.targetName,
        type: 'IMPORTS',
      });
    }
    // EXT***REMOVED***S
    for (const ext of r.extendsRels) {
      edges.push({
        fromLocalId: ext.childLocalId,
        targetName: ext.baseName,
        type: 'EXT***REMOVED***S',
      });
    }
    // IMPLEMENTS
    for (const imp of r.implementsRels) {
      edges.push({
        fromLocalId: imp.childLocalId,
        targetName: imp.baseName,
        type: 'IMPLEMENTS',
      });
    }
    // CALLS — structural, name-based
    for (const call of r.callSites) {
      edges.push({
        fromLocalId: call.containerLocalId,
        targetName: call.calleeName,
        type: 'CALLS',
      });
    }
  }
  console.log(`[oracle] ${edges.length} edges extracted (IMPORTS + EXT***REMOVED***S + IMPLEMENTS + CALLS)`);

  // Write cache
  writeFileSync(
    symbolsPath,
    symbols.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  writeFileSync(
    edgesPath,
    edges.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  console.log(`[oracle] Wrote to ${opts.outDir}`);

  return { edges, symbols };
}
