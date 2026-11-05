# Flow Document Roadmap

## Alignment record

| Item | Value |
| --- | --- |
| Forge revision reviewed | `dfc8ac26072ddd571a41f5f33221f72bb7dd7026` (2026-11-05) |
| Forge worktree at review | three unrelated uncommitted documentation files; contracts unchanged |
| Forge contract revision copied | `a701e8111f488299e1ab7a0c353ee6718be3a0a4` (`contracts/SOURCE.json`) |
| Runtime source | Forge `node-24.22.0-macos-arm64`, signature-verified acquisition |

## Delivered in the bootstrap

- Seven operations: create, validate document, validate proposal, apply change, layout, SVG export and
  Mermaid export.
- Manifest generated from a clean checkout, health command, operation request and result records.
- Dagre layout, browser-free SVG, textual Mermaid export.
- Tests and fixtures, including copies of the Forge reference examples.
- License and notice records.

## Open items for the owner

1. License for the module's own code (`NOTICE.md`).
2. `ajv` and `ajv-formats` as direct dependencies beside Dagre. They keep the Forge schemas as the only
   definition of the document shapes. The alternative is hand-written checks in JavaScript, which would
   repeat the shapes in code.
3. How a host adopts computed layout hints. The contract has no change type that sets them; `relayout`
   clears them.
4. Ember storage compatibility review (named in the work package).
5. Lane drawing and export, if lanes should appear in diagrams.

## Not started

- Forge admission, a pinned Forge submodule revision, signed bundles and catalog entry.
- PNG, PDF, Excalidraw and draw.io exporters.
- Resource figures measured on a built bundle.
