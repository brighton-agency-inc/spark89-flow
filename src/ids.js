'use strict';

// Canonical identifiers follow the Forge common contract. The pattern is repeated here only for
// checks that run before a schema is applied; the schema remains the authority.
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/**
 * The Mermaid identifier for a canonical ID. Hex of the UTF-8 bytes is injective, so two distinct
 * canonical IDs (for example `a-b` and `a_b`) never share a Mermaid ID, and the `n_` prefix keeps
 * the result away from Mermaid keywords such as `end`. The canonical ID is never rewritten.
 */
function mermaidId(canonicalId) {
  return `n_${Buffer.from(canonicalId, 'utf8').toString('hex')}`;
}

module.exports = { IDENTIFIER, mermaidId };
