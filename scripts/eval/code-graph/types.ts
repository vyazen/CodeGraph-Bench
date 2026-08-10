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
  edgeCount: number;
  name: string;
  nodeCount: number;
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
  /**
   * File the from-side symbol is declared in. Required to disambiguate
   * `fromLocalId`s that recur across files (e.g. `_Registered`, `useStyles`) —
   * see F11 in CODE_GRAPH_EVAL_FAIRNESS_PLAN.md. For IMPORTS this equals
   * `fromLocalId` (both are the importing file's path).
   */
  fromPath: string;
  /** Which resolution tier confirmed the target (F10) — for reporting oracle-certain vs best-effort ground truth. */
  resolutionTier?: 'symbol' | 'signature' | 'property' | 'optional-chain-stripped' | 'unresolved';
  /**
   * False when the target is knowably outside the repo (external package,
   * builtin, or — post name-resolution-fallback — still unresolved after every
   * tier tried). Excluded from the scoreable recall denominator (F9). Absent
   * (undefined) is treated as scoreable=true for edges minted before this field
   * existed.
   */
  scoreable?: boolean;
  /**
   * How many source call/reference sites collapsed into this one deduplicated
   * oracle edge (F9). A tool that emits one edge per unique (from, target) pair
   * — rather than one per call site — is not penalized for site-count.
   */
  siteCount?: number;
  /** Type-checker-resolved target (if the oracle could resolve it). Enables target-accuracy scoring. */
  targetLocalId?: string;
  /** For CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS: the target name (callee, imported symbol, base class/interface). */
  targetName: string;
  targetPath?: string;
  targetStartLine?: number;
  type: EdgeType;
}

export interface OracleFileResult {
  extendsRels: Array<{ childLocalId: string; baseName: string }>;
  implementsRels: Array<{ childLocalId: string; baseName: string }>;
  imports: Array<{ fromModule: string | null; targetName: string }>;
  path: string;
  symbols: OracleSymbol[];
}

// ── Ontology mappings per tool ────────────────────────────────────────────────

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
    // No equivalent — excluded
    STEP_IN_PROCESS: 'UNKNOWN',
    HANDLES_ROUTE: 'UNKNOWN',
  };
  return map[raw] ?? 'UNKNOWN';
}

/**
 * Graphify `link.relation` → EdgeType. Observed via `graphify update` on
 * BabylonJS (v0.9.27): imports/imports_from/calls/indirect_call/inherits/
 * implements/contains/method/defines/extends/re_exports/references/
 * rationale_for/cites.
 *
 * Two deliberate divergences from the obvious name-based mapping:
 * - `inherits` (not `extends`!) is Graphify's class/interface heritage
 *   relation — confirmed by sampling: `extends` only ever appears on
 *   package.json-style config nodes (e.g. eslint `extends`), never on a
 *   `.ts`/`.tsx` class or interface. Mapping `extends` → EXT***REMOVED***S would
 *   silently pollute the class-inheritance edge count with config noise.
 * - `references` (23,410 edges — generic identifier/property references) has
 *   no equivalent in our ontology (it isn't CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS,
 *   and mapping it to USES_TYPE would misrepresent it as type-usage
 *   tracking). Left UNKNOWN/excluded, unlike GitNexus's ACCESSES.
 *
 * `re_exports`, `rationale_for`, `cites` are also excluded: re-export
 * semantics weren't verified against the oracle's IMPORTS convention closely
 * enough to score with confidence, and rationale_for/cites are
 * documentation-citation edges, not code edges.
 */
export function normalizeGraphifyEdgeType(relation: string): EdgeType {
  const map: Record<string, EdgeType> = {
    calls: 'CALLS',
    indirect_call: 'CALLS',
    imports: 'IMPORTS',
    imports_from: 'IMPORTS',
    inherits: 'EXT***REMOVED***S',
    implements: 'IMPLEMENTS',
    contains: 'CONTAINS',
    method: 'CONTAINS',
    defines: 'CONTAINS',
    // Config-level (package.json), not code inheritance — see doc comment above.
    extends: 'UNKNOWN',
    re_exports: 'UNKNOWN',
    references: 'UNKNOWN',
    rationale_for: 'UNKNOWN',
    cites: 'UNKNOWN',
  };
  return map[relation] ?? 'UNKNOWN';
}

/**
 * Potpie `node_type` (+ `class_name`/`name`) → SymbolType.
 *
 * Per POTPIE_EVAL_PLAN.md §4: the payload's `class_name` field (present only on
 * FUNCTION nodes that belong to a class) makes Method/Function/Constructor
 * separation exact, unlike Graphify's structural guessing. No `Unknown` bucket
 * is needed — every Potpie node is classifiable; what's missing (Property,
 * GlobalVariable, Enum, Alias, Namespace, Module — §3 fact 5) is simply absent
 * from the payload, and shows up as recall, not as a kind to normalize away.
 */
export function normalizePotpieKind(
  nodeType: string,
  className: string | null | undefined,
  name: string
): SymbolType {
  switch (nodeType) {
    case 'FILE':
      return 'File';
    case 'CLASS':
      return 'Class';
    case 'INTERFACE':
      return 'Interface';
    case 'FUNCTION':
      if (className) {
        return name === 'constructor' ? 'Constructor' : 'Method';
      }
      return 'Function';
    default:
      return 'Unknown';
  }
}

/**
 * Potpie `relationship_type` → EdgeType.
 *
 * `CONTAINS` is emitted for diagnostics (parentId derivation) but sits outside
 * the head-to-head (not in COMPARABLE_EDGE_TYPES/EXT***REMOVED***ED_EDGE_TYPES).
 * `REFERENCES` → `USES_TYPE`, scored in the extended-edge table — per
 * POTPIE_EVAL_PLAN.md §4, this is a measurement of what the relation is built
 * from (type annotations + `new` expressions), not a charitable mapping to
 * CALLS. Potpie emits no CALLS/IMPORTS/EXT***REMOVED***S/IMPLEMENTS for TS by
 * construction (§3 fact 1-3) — there is no raw relation to map to them.
 */
export function normalizePotpieEdgeType(relationshipType: string): EdgeType {
  const map: Record<string, EdgeType> = {
    CONTAINS: 'CONTAINS',
    REFERENCES: 'USES_TYPE',
  };
  return map[relationshipType] ?? 'UNKNOWN';
}
