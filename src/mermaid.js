'use strict';

const { mermaidId } = require('./ids');

// Mermaid reads these characters inside a quoted label as markup or entities. Entity codes keep the
// label text literal. Text that is plain words needs no quoting on an edge, which keeps simple
// output identical to the Forge reference export.
const ENTITIES = new Map([['"', '#quot;'], ['#', '#35;'], ['&', '#amp;'], ['<', '#lt;'], ['>', '#gt;'], ['`', '#96;']]);
const LINE_BREAKS = new RegExp('[\u0000-\u001f\u007f\u2028\u2029]+', 'g');
const PLAIN_EDGE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 ,.?!:;'()/_-]*$/;

function escapeLabel(text) {
  // Mermaid labels are one line; control characters and line breaks become spaces.
  const flat = text.replace(LINE_BREAKS, ' ').trim();
  return Array.from(flat, (character) => ENTITIES.get(character) ?? character).join('');
}

function edgeLabel(text) {
  const flat = text.replace(LINE_BREAKS, ' ').trim();
  return PLAIN_EDGE_LABEL.test(flat) && !flat.endsWith(' ') ? flat : `"${escapeLabel(flat)}"`;
}

/**
 * Mermaid flowchart source for a valid flow document. Node IDs are derived injectively from the
 * canonical IDs, so distinct canonical IDs never collide. Lanes are not exported. The second line
 * is a Mermaid comment naming the source document and revision.
 */
function toMermaid(document) {
  const direction = document.layout.direction === 'left-right' ? 'LR' : 'TD';
  const lines = [`flowchart ${direction}`, `  %% flow-document ${document.document_id} revision ${document.revision}`];
  for (const node of document.nodes) {
    const [open, close] = node.kind === 'decision' ? ['{', '}'] : ['[', ']'];
    lines.push(`  ${mermaidId(node.node_id)}${open}"${escapeLabel(node.label)}"${close}`);
  }
  for (const connection of document.connections) {
    const source = mermaidId(connection.from_node);
    const target = mermaidId(connection.to_node);
    const label = connection.label ?? connection.condition;
    lines.push(label === undefined ? `  ${source} --> ${target}` : `  ${source} -->|${edgeLabel(label)}| ${target}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { toMermaid };
