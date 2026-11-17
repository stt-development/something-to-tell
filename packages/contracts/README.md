# Shared Contracts

Shared API, graph patch, and project format contracts for Something To Tell Engine.

Responsibilities:

- request and response schemas
- graph patch operation definitions
- project config and project format schemas
- generated client or type artifacts once tooling exists

Contracts should have one source of truth and be reused by both `apps/web` and
`services/runtime`.

## Project Manifest v2

`src/projectManifest.ts` is the documented TypeScript mirror consumed by the
frontend. Runtime validation and migration are owned by
`services/runtime/stt_runtime/project_format/manifest.py`. Their constants and
fields must remain synchronized until a later task replaces the mirror with
schema generation.

`src/projectDocument.ts` defines the complete storage-neutral snapshot records.
It is generic over Dialogue and Quest documents so the frontend reuses its
existing specialized contracts rather than creating parallel copies. Phase
3.10 introduced version 2 composition collections; Phase 3.11 advances the
document to version 3 with flow initial state, effect definitions, and stable
owner bindings. Runtime checkpoint migration validates legacy checksums before
adding empty collections; missing fixture collections never infer production
project state.

`src/projectSession.ts` defines Create/Open requests, lifecycle state, complete
session responses, and localization-ready errors. Lock files, database engines,
and migration internals are deliberately absent from frontend contracts.

`src/composableStoryFlow.ts` is the documented Phase 3.10 mirror for explicit
flow invocations, named exits, call-site return bindings, executable call-graph
validation, and deterministic ordering shared by transitions and calls. The
runtime Pydantic schema remains authoritative until schema generation exists.

`src/narrativeState.ts` mirrors the runtime-owned Phase 3.11 holder, initial
state, effect definition, stable owner, binding, and aggregate validation
contracts. It validates frontend projections without mutation, but runtime
Pydantic validation remains authoritative for every authored command.

`src/impactAnalysis.ts` mirrors the runtime-owned Phase 5 dependency, seed,
scenario, path, finding, limit, run, and response contracts. It reuses Canon
owner/evidence references. The runtime alone validates limits and derives
finding fingerprints; the frontend helper only orders validated findings for
presentation without mutating payloads.

`src/export.ts` mirrors the runtime-owned Phase 8 plan/write boundary and the
explicit `ExportProjectionV1` allowlist. Unknown portable metadata is retained
only under bounded `x-*` extension keys; project storage, providers, credentials,
machine paths, placements, history, analysis, and UI state are never projection
fields. Python remains the validation authority until schema generation exists.
The runtime projection service now materializes this contract and its inventory;
frontend types remain observational and contain no independent closure logic.
