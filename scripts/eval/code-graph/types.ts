/**
 * Code-Graph Eval — common JSONL schema + ontology mappings.
 *
 * Per CODE_GRAPH_EVAL_PLAN.md §5, each tool adapter emits nodes.jsonl / edges.jsonl
 * in a common format so they can be compared against the TS compiler oracle.
 *
 * `kind` normalizes into the SymbolType union from parse-diagnostic;
 * `type` normalizes into EdgeType. Tools that don't have an equivalent emit
 * `kind: 'Unknown'` / `type: 'UNKNOWN'` and are excluded from head-to-head.
 */

// ── Symbol kinds (mirrors parse-diagnostic SymbolType) ────────────────────────
export type SymbolType =
  | 'Class'
  | 'Interface'
  | 'Struct'
  | 'Record'
  | 'Enum'
  | 'Alias'
  | 'Function'
  | 'Method'
  | 'Constructor'
  | 'Property'
  | 'GlobalVariable'
  | 'Module'
  | 'Namespace'
  | 'File'
  | 'Directory'
  | 'Unknown';

/** Symbol kinds that participate in the head-to-head fidelity comparison. */
export const COMPARABLE_SYMBOL_TYPES: ReadonlySet<SymbolType> = new Set([
  'Class',
  'Interface',
  'Enum',
  'Alias',
  'Function',
  'Method',
  'Constructor',
  'Property',
  'GlobalVariable',
  'Module',
  'Namespace',
]);

// ── Edge types (mirrors parse-diagnostic EdgeType + extensions) ───────────────
export type EdgeType =
  | 'IMPORTS'
  | 'CALLS'
  | 'USES_TYPE'
  | 'EXT***REMOVED***S'
  | 'IMPLEMENTS'
  | 'ACCESSES'
  | 'METHOD_OVERRIDES'
  | 'CONTAINS'
  | 'UNKNOWN';

/** Edge types that participate in the head-to-head fidelity comparison (§5 exclusions applied). */
export const COMPARABLE_EDGE_TYPES: ReadonlySet<EdgeType> = new Set([
  'IMPORTS',
  'CALLS',
  'EXT***REMOVED***S',
  'IMPLEMENTS',
]);

/** Extended edge types — scored separately (each tool on what it produces). */
export const EXT***REMOVED***ED_EDGE_TYPES: ReadonlySet<EdgeType> = new Set([
  'USES_TYPE',
  'ACCESSES',
  'METHOD_OVERRIDES',
]);

// ── JSONL record shapes ───────────────────────────────────────────────────────
export interface GraphNode {
  endLine: number | null;
  /** Stable id minted by the tool (already normalized to a string). */
  id: string;
  kind: SymbolType;
  name: string;
  /** Original tool label, kept for diagnostics. */
  originalKind?: string;
  parentId: string | null;
  path: string;
  startLine: number | null;
  /** Original tool ID before normalization, for traceability. */
  toolId?: string;
}

export interface GraphEdge {
  confidence: number | null;
  /** Edge "kind" the tool reported, before normalization. */
  edgeKind?: string;
  fromId: string;
  resolved: boolean | null;
  toId: string;
  type: EdgeType;
}

export interface ToolGraph {
  edges: GraphEdge[];
  /** Tool name + version, for the scorecard. */
  meta: ToolMeta;
  nodes: GraphNode[];
}

export interface ToolMeta {
  commitSha?: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  version: string;
}

// ── Oracle ground-truth shapes ───────────────────────────────────────────────
export interface OracleSymbol {
  endLine: number;
  kind: SymbolType;
  localId: string;
  name: string;
  parentLocalId: string | null;
  path: string;
  startLine: number;
}

export interface OracleEdge {
  /** For CALLS: caller localId; for IMPORTS: file path; for EXT***REMOVED***S/IMPLEMENTS: child localId. */
  fromLocalId: string;
  /** For CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS: the target name (callee, imported symbol, base class/interface). */
  targetName: string;
  type: EdgeType;
  /** Type-checker-resolved target (if the oracle could resolve it). Enables target-accuracy scoring. */
  targetLocalId?: string;
  targetPath?: string;
  targetStartLine?: number;
}

export interface OracleFileResult {
  implementsRels: Array<{ childLocalId: string; baseName: string }>;
  imports: Array<{ fromModule: string | null; targetName: string }>;
  path: string;
  symbols: OracleSymbol[];
  extendsRels: Array<{ childLocalId: string; baseName: string }>;
}

// ── Ontology mappings per tool ────────────────────────────────────────────────

/** Vyazen node label → SymbolType. */
export function normalizeVyazenKind(label: string): SymbolType {
  const map: Record<string, SymbolType> = {
    Class: 'Class',
    Interface: 'Interface',
    Enum: 'Enum',
    Alias: 'Alias',
    Function: 'Function',
    Method: 'Method',
    Constructor: 'Constructor',
    Property: 'Property',
    GlobalVariable: 'GlobalVariable',
    Module: 'Module',
    Namespace: 'Namespace',
    File: 'File',
    Directory: 'Directory',
    CodeChunk: 'Unknown',
    Project: 'Unknown',
    Repo: 'Unknown',
  };
  return map[label] ?? 'Unknown';
}

/** GitNexus node label → SymbolType. */
export function normalizeGitNexusKind(label: string): SymbolType {
  const map: Record<string, SymbolType> = {
    Class: 'Class',
    Interface: 'Interface',
    Enum: 'Enum',
    TypeAlias: 'Alias',
    Function: 'Function',
    Method: 'Method',
    Constructor: 'Constructor',
    Property: 'Property',
    Variable: 'GlobalVariable',
    Const: 'GlobalVariable',
    Static: 'GlobalVariable',
    Module: 'Module',
    Namespace: 'Namespace',
    Struct: 'Struct',
    Record: 'Record',
    File: 'File',
    Folder: 'Directory',
    // GitNexus-specific — excluded from head-to-head
    Section: 'Unknown',
    Process: 'Unknown',
    Community: 'Unknown',
    Route: 'Unknown',
    CodeElement: 'Unknown',
    CodeEmbedding: 'Unknown',
    BasicBlock: 'Unknown',
    Tool: 'Unknown',
    Macro: 'Unknown',
    Delegate: 'Unknown',
    Template: 'Unknown',
    Annotation: 'Unknown',
    Union: 'Unknown',
    Typedef: 'Unknown',
    Trait: 'Unknown',
    Impl: 'Unknown',
  };
  return map[label] ?? 'Unknown';
}

/** GitNexus CodeRelation.type → EdgeType. */
export function normalizeGitNexusEdgeType(raw: string): EdgeType {
  const map: Record<string, EdgeType> = {
    CALLS: 'CALLS',
    IMPORTS: 'IMPORTS',
    EXT***REMOVED***S: 'EXT***REMOVED***S',
    IMPLEMENTS: 'IMPLEMENTS',
    METHOD_IMPLEMENTS: 'IMPLEMENTS',
    CONTAINS: 'CONTAINS',
    HAS_METHOD: 'CONTAINS',
    HAS_PROPERTY: 'CONTAINS',
    DEFINES: 'CONTAINS',
    MEMBER_OF: 'CONTAINS',
    // Extended edge types — scored separately
    ACCESSES: 'ACCESSES',
    METHOD_OVERRIDES: 'METHOD_OVERRIDES',
    // No Vyazen equivalent — excluded
    STEP_IN_PROCESS: 'UNKNOWN',
    HANDLES_ROUTE: 'UNKNOWN',
  };
  return map[raw] ?? 'UNKNOWN';
}

/** Vyazen edge type → EdgeType (identity, but filters unknowns). */
export function normalizeVyazenEdgeType(raw: string): EdgeType {
  const map: Record<string, EdgeType> = {
    CALLS: 'CALLS',
    IMPORTS: 'IMPORTS',
    EXT***REMOVED***S: 'EXT***REMOVED***S',
    IMPLEMENTS: 'IMPLEMENTS',
    USES_TYPE: 'USES_TYPE',
    CONTAINS: 'CONTAINS',
    HAS_CHUNK: 'UNKNOWN',
  };
  return map[raw] ?? 'UNKNOWN';
}
