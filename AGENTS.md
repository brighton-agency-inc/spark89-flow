# Flow Document Repository Instructions

These instructions apply to work in the Flow Document module repository.

## Required reading

Before changing operations, record shapes, health behavior, runtime requirements or packaging, read:

1. `VISION.md`
2. `ROADMAP.md`
3. `README.md`

When this repository is checked out under Forge, also read Forge `specs/02-flow-document.md`, the
decision log items 31 to 33 and `contracts/README.md`. Record the reviewed Forge revision and date in
the alignment record in `ROADMAP.md`. If the parent changes are uncommitted, state that.

## Authority boundary

- This repository owns the module implementation, tests, runtime behavior, health behavior and
  module evidence.
- Forge owns shared contracts, admission, maturity, the catalog, the installer and portfolio status.
- Do not edit the schemas in `contracts/v1/`. Report contract issues to Forge and copy the accepted
  revision, then update `contracts/SOURCE.json`.
- Module output is unverified. This module does not issue Forge Verification Manifests or record
  human approval.
- Ember is a host. Do not add Ember code, storage or provider integration here.

## Rules

- No network calls, provider integration, credentials or conversation storage.
- No browser, Mermaid CLI or Puppeteer dependency. Any new dependency needs an owner decision and an
  updated lock file and `THIRD_PARTY_NOTICES.md`.
- Operations read no clock for document content. Output must stay byte-identical for the same request.
- Keep Forge contract text and error wording aligned with `contracts/validate_flow.py`.
- Do not commit a generated manifest. Generate it from a clean checkout.
- Use explicit staging and conventional commits. Do not mention agents or add co-author trailers.

## Verification

```bash
npm ci --ignore-scripts
npm test
node forge_adapter.js health
git diff --check
```

Run the tests with Node 24. Report skipped or environment-dependent checks explicitly.
