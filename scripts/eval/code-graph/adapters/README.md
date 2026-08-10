# Adapter contract

Each tool plugs into the benchmark via an adapter that normalizes its output into the common graph schema defined in [`../types.ts`](../types.ts).

## Contract

```ts
interface AdapterInput {
  outDir: string;   // where to write/read nodes.jsonl + edges.jsonl cache
  useCache: boolean; // reuse cached JSONL if present
}

interface ToolGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: ToolMeta;    // { name, version, nodeCount, edgeCount, commitSha? }
}
```

An adapter is an async function `run<YourTool>Adapter(input): Promise<ToolGraph>` that:

1. If `useCache` is true and `outDir/nodes.jsonl` + `outDir/edges.jsonl` exist, read and return them.
2. Otherwise, run the tool (or read its raw output), normalize nodes/edges into the common schema, write the JSONL cache, and return the `ToolGraph`.

## Shipped examples

| Adapter | Template notes |
|---------|----------------|
| [`gitnexus.adapter.ts`](gitnexus.adapter.ts) | Cleanest template — CLI-based, paginated Cypher export. |
| [`graphify.adapter.ts`](graphify.adapter.ts) | JSON graph file parse with structural kind reconstruction. |
| [`potpie.adapter.ts`](potpie.adapter.ts) | NDJSON parse with class-name-based Method/Function separation. |

## Node schema

```jsonl
{ "id": "string", "name": "string", "path": "string", "startLine": number|null, "endLine": number|null, "kind": "SymbolType", "parentId": "string|null" }
```

## Edge schema

```jsonl
{ "fromId": "string", "toId": "string", "type": "EdgeType", "resolved": boolean|null, "confidence": number|null }
```

## Ontology

- **`SymbolType`**: `Class`, `Interface`, `Enum`, `Alias`, `Function`, `Method`, `Constructor`, `Property`, `GlobalVariable`, `Module`, `Namespace`, `File`, `Directory`, `Unknown`
- **`EdgeType`**: `IMPORTS`, `CALLS`, `EXT***REMOVED***S`, `IMPLEMENTS` (comparable — head-to-head), `USES_TYPE`, `ACCESSES`, `METHOD_OVERRIDES` (extended — scored separately), `CONTAINS`, `UNKNOWN`
- **`resolved: true`** — only set if your tool verifies the target. Enables the resolved-edge slice and reference-tool cross-coverage.
- **`resolved: false`** on a self-loop (`fromId === toId`) — abstention, not a claim.

## BYOT guide

See the root [`README.md`](../../../README.md#using-your-own-tool-byot) for the full bring-your-own-tool guide, including the normalization checklist and node identity convention.
