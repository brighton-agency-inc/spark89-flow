# Flow Document

Flow Document is a Forge module that works on flow documents: portable records of a user flow or an
operating workflow. It validates a document, checks and applies reviewed change proposals, lays a
document out and exports it as SVG and Mermaid. It runs locally on Node 24, makes no network calls
and holds no provider credentials.

Status: development. The module is not admitted to the Forge catalog and has no signed bundle. All
output is unverified. It is not human approval and not a Forge verification claim.

Forge owns the shared contracts this module implements: `flow-document` 1.0.0,
`flow-change-proposal` 1.0.0, `operation-request` 1.0.0, `operation-result` 1.0.0, `health-result`
1.0.0 and `module-manifest` 1.1.0. The module uses copies of those schemas in `contracts/v1/` and
does not change them. `contracts/SOURCE.json` records the Forge revision they came from and a digest
for each file; a test and the health check compare the two.

## Runtime

- Forge-managed Node 24 (`>=24,<25`). `package.json` declares the engine and `package-lock.json`
  pins every package by version and integrity hash. Forge installs from the lock with
  `npm ci --omit=dev --ignore-scripts` into a directory outside the checkout and sets
  `FORGE_NODE_MODULES`. When that variable is set, dependencies resolve only from it.
- `@dagrejs/dagre` 3.1.3 lays out the graph (decision-log item 33).
- `ajv` 8.17.1 and `ajv-formats` 3.0.1 apply the Forge JSON Schemas, so the module checks the contract
  itself and keeps no second copy of its shapes in code. These two packages and their dependencies
  are an addition to the Dagre baseline in item 33 and are listed for owner review in `ROADMAP.md`.
- No Mermaid CLI, Puppeteer, Chrome or system browser. SVG is drawn by the module.

For a development checkout, put a Node 24 runtime on `PATH` and run `npm ci --ignore-scripts`. Forge
can acquire a hash-verified Node 24 with `python -m installer runtime acquire`.

## Commands

```bash
node forge_adapter.js health                       # exit 0 healthy, 10 degraded, 20 unhealthy, 30 incompatible
node forge_adapter.js manifest [--allow-dirty]     # generated from a clean checkout, never committed
node forge_adapter.js run [--request FILE]         # operation-request JSON on stdin by default
```

`manifest` stamps `module.revision` with the full Git `HEAD` of a clean checkout and refuses a dirty
tree. `--allow-dirty` prints a diagnostic record labelled `uncommitted-changes`; Forge rejects it for
admission and installation.

## Operations

Every operation reads its inputs from files named in the request, writes its outputs into
`parameters.output_dir` and returns an `operation-result`. Input paths must sit inside a read grant
and `output_dir` inside a write grant, after symlinks are resolved. Declared input size and SHA-256
must match the bytes read. An output file that already exists is never replaced.

| Operation | Inputs (by role) | Parameters | Outputs |
| --- | --- | --- | --- |
| `create-flow-document` | none | `document_id`, `title`, `nodes`, `description`, `direction`, `connections`, `lanes`, `producer`, `provider`, `model` | `flow-document.json` |
| `validate-flow-document` | `flow-document` | none | `validation-report.json` |
| `validate-flow-proposal` | `flow-document`, `flow-change-proposal` | none | `validation-report.json` |
| `apply-flow-change` | `flow-document`, `flow-change-proposal` | `producer`, `provider`, `model` | `flow-document.json` |
| `layout-flow-document` | `flow-document` | `hints` | `flow-layout.json` |
| `export-flow-svg` | `flow-document` | `hints` | `flow.svg` |
| `export-flow-mermaid` | `flow-document` | none | `flow.mmd` |

All parameters other than those listed are refused, and `output_dir` is always required.

- Document timestamps come from `request.created_at`. The operations read no clock for content, so the
  same request gives the same output bytes. Only the result's own `started_at`, `completed_at` and
  `run_id` vary.
- Results use `review_required` with a `verification_blocking` `output-unverified` omission and never
  `succeeded`. A refused request returns `failed` with a typed error and writes nothing.
- Validation reports mark an invalid document or proposal with `valid: false` and an `input-invalid`
  omission. The operation itself completed, so the status stays `review_required`.
- Error codes for refusals: `invalid-document`, `invalid-proposal`, `proposal-stale`,
  `document-mismatch`, `archived-document`, `proposal-not-accepted`, `document-too-large`,
  `path-outside-grant`, `path-traversal`, `input-digest-mismatch`, `output-exists` and
  `output-too-large`, among the request checks listed in `src/operations.js`.

### Validation

A document is valid when it matches the Forge schema and the invariants of the flow-document
specification: unique IDs, connections that reference existing nodes, no incoming connection on a
start node, no outgoing connection on an end node, at least two distinguishable branches on a decision,
lanes that exist and layout hints that cover every node or are omitted. Error text matches the Forge
reference validator (`contracts/validate_flow.py`). Warnings cover a draftable flow: no start or end
node, an unlabeled decision branch, a node with no way out and a node not reachable from a start
node. Nothing is repaired silently.

Coordinates are non-negative integers. A negative or fractional coordinate fails the schema. Hints
for some nodes only fail with `layout hints must cover every node or be omitted`.

### Applying a proposal

`apply-flow-change` applies a proposal only when all of these hold:

- the proposal names the document and its `base_revision` equals the document revision;
- an archived document receives only a restore (`update-lifecycle` to `active`);
- the proposal status is `accepted`, so the host has recorded the human decision first;
- the proposal's recorded validation has no errors;
- each change applies (adding an existing ID or changing a missing one is refused); and
- the resulting document is valid. Removing a node that still has connections is refused. A proposal
  removes the node's connections itself.

The result is the next revision with `updated_at` set to the request time and provenance
`apply-flow-change`. Canonical IDs are never rewritten. If the node set changes or a `relayout`
change is applied, stored layout hints are cleared and the result says so. `validate-flow-proposal`
runs the same checks without requiring `accepted` and reports the revision the proposal would produce.

### Layout and SVG

`layout-flow-document` places nodes with Dagre. The record holds node boxes, routed edges, canvas
size and `layout_hints`: integer top-left coordinates that are valid as `layout.nodes`. The operation
does not change the document. How a host adopts hints is the host's decision.

`parameters.hints` is explicit. `recompute` (default) ignores stored coordinates. `use-stored` places
nodes at the document's stored hints and draws straight connections between node outlines; a document
without hints falls back to Dagre and the record's `source` says `computed`.

The SVG uses no browser. Label text is wrapped with a fixed width estimate, cut with an ellipsis after
three lines for nodes and two for connections, and kept inside its shape. The full label stays in the
element's `<title>`. Arrows end on the drawn outline of the target node (rectangle, ellipse or
diamond). Connection labels are drawn on a backing box. Self loops and parallel connections are drawn.
The root element names the document ID and revision.

Lanes are validated and kept in the document, but they are not drawn in SVG or exported to
Mermaid. The SVG carries `data-lanes="not-drawn"` and the result carries a `lanes-not-drawn` omission.

### Mermaid

Mermaid node IDs are `n_` followed by the hex of the canonical ID's UTF-8 bytes. That mapping is
injective, so `a-b` and `a_b` never share an ID, and Mermaid keywords such as `end` cannot appear as
identifiers. Labels are quoted and entity-escaped. Edge labels are quoted when they hold more than
plain words. The second line is a comment naming the source document and revision.

## Bounds

Input files up to 4 MiB, 500 nodes and 1500 connections. `limits.timeout_seconds` and
`limits.max_memory_bytes` are enforced by Forge and not by this module.

## Tests

```bash
npm test                      # node --test "tests/**/*.test.js"
UPDATE_FIXTURES=1 npm test    # rewrite golden SVG and Mermaid files, then review the diff
```

`tests/fixtures/forge/` holds copies of the Forge reference examples. To check the generated records
against Forge's own validators from a Forge checkout:

```bash
node forge_adapter.js manifest > /tmp/manifest.json
node forge_adapter.js health   > /tmp/health.json
python contracts/validate_module.py --manifest /tmp/manifest.json --health /tmp/health.json \
  --module-root engine/flow-document --check-checkout
```

## Files

- `forge_adapter.js`: command line entry points.
- `src/`: validation, apply, layout, SVG, Mermaid, operations, manifest and health.
- `contracts/`: copies of the Forge schemas and their source record.
- `NOTICE.md`, `THIRD_PARTY_NOTICES.md`: license records. Regenerate the second with
  `node scripts/generate-notices.js`.
