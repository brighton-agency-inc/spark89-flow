# Test fixtures

`forge/` holds byte-identical copies of the Forge reference examples at Forge revision
`a701e8111f488299e1ab7a0c353ee6718be3a0a4` (`contracts/examples/campaign-approval.*`). They are
consumer fixtures: the module reads them and never edits them. The reference `.mmd` is the Forge
Mermaid export of the same document.

`expected/` holds golden SVG and Mermaid output produced by this module. Regenerate it with
`UPDATE_FIXTURES=1 npm test` and review the diff before committing. The Forge reference SVG is not a
golden file here because Forge's reference renderer draws a straight column without Dagre.
