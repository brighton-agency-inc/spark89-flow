# Flow Document Vision

Flow Document turns one canonical flow document into the diagrams people need, without a browser or an
account. A host such as Ember owns conversation and storage. This module owns what a valid document
is, how a reviewed change becomes the next revision and how a document becomes SVG and Mermaid.

## Principles

- The semantic graph is authoritative. Coordinates are layout state and never change meaning.
- A change is a proposal first. Applying one is a compare-and-swap on the document revision.
- Structural problems are refused and reported. The module does not repair them silently.
- The same document always gives the same bytes. Exports name their source document and revision.
- Output is unverified. The module records no human approval and issues no Forge verification claim.
- The module calls no model provider, stores no credential and makes no network call.

## Parent sources

- Forge `VISION.md` and `ROADMAP.md` L7.
- Forge `specs/02-flow-document.md`.
- Forge decision-log items 31, 32 and 33.
- Forge `planning/work-packages/L7-FLOW-MODULE-BOOTSTRAP.md`.
