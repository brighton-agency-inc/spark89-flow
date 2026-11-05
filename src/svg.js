'use strict';

const { layoutDocument } = require('./layout');
const { FONT_SIZE_NODE, FONT_SIZE_EDGE } = require('./text');

const INK = '#342b27';
const EDGE = '#5b514b';
const ACCENT = '#c84f1d';
const FILL = {
  start: '#f4ede6',
  end: '#f4ede6',
  action: '#ffffff',
  decision: '#fff1d6',
  approval: '#e6f2e4',
  document: '#e5eef8',
  system: '#ece9f4',
};

// Characters that XML 1.0 cannot carry are replaced rather than emitted.
function xml(text) {
  return Array.from(String(text), (character) => {
    const code = character.codePointAt(0);
    if (code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000) {
      if (character === '&') return '&amp;';
      if (character === '<') return '&lt;';
      if (character === '>') return '&gt;';
      if (character === '"') return '&quot;';
      if (character === "'") return '&apos;';
      return character;
    }
    return '�';
  }).join('');
}

const fmt = (value) => String(Number(value.toFixed(2)));

function textBlock(lines, centerX, centerY, lineHeight, fontSize, className) {
  const first = centerY - ((lines.length - 1) * lineHeight) / 2;
  const spans = lines.map((line, index) => `<tspan x="${fmt(centerX)}" y="${fmt(first + index * lineHeight)}">${xml(line)}</tspan>`);
  return `<text class="${className}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}">${spans.join('')}</text>`;
}

function shapeMarkup(node) {
  const common = `fill="${FILL[node.kind]}" stroke="${ACCENT}" stroke-width="2"`;
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  if (node.shape === 'ellipse') return `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${node.width / 2}" ry="${node.height / 2}" ${common}/>`;
  if (node.shape === 'diamond') {
    const points = [[cx, node.y], [node.x + node.width, cy], [cx, node.y + node.height], [node.x, cy]].map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
    return `<polygon points="${points}" ${common}/>`;
  }
  const rect = `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="8" ${common}/>`;
  if (node.kind === 'approval') {
    return `${rect}<rect x="${node.x + 4}" y="${node.y + 4}" width="${node.width - 8}" height="${node.height - 8}" rx="5" fill="none" stroke="${ACCENT}" stroke-width="1"/>`;
  }
  if (node.kind === 'document') return `${rect}<line x1="${node.x + 10}" y1="${node.y + node.height - 8}" x2="${node.x + node.width - 10}" y2="${node.y + node.height - 8}" stroke="${ACCENT}" stroke-width="1"/>`;
  if (node.kind === 'system') return `${rect}<line x1="${node.x + 8}" y1="${node.y + 6}" x2="${node.x + 8}" y2="${node.y + node.height - 6}" stroke="${ACCENT}" stroke-width="2"/>`;
  return rect;
}

/**
 * Deterministic SVG for a valid flow document, drawn without a browser. Positions come from
 * `layoutDocument`; the same document and options always give the same bytes. Connection labels are
 * drawn, arrows end on node outlines and label text is wrapped to stay inside its shape. Lanes are
 * not drawn.
 */
function toSvg(document, { hints = 'recompute' } = {}) {
  const layout = layoutDocument(document, { hints });
  const { width, height } = layout;
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="flow-title flow-desc" data-document-id="${xml(document.document_id)}" data-document-revision="${document.revision}" data-layout-source="${layout.source}"${document.lanes.length ? ' data-lanes="not-drawn"' : ''}>`,
  );
  out.push(`  <title id="flow-title">${xml(document.title)}</title>`);
  out.push(
    `  <desc id="flow-desc">Flow document ${xml(document.document_id)}, revision ${document.revision}. Unverified diagram export.${document.lanes.length ? ' Lanes are not drawn.' : ''}</desc>`,
  );
  out.push('  <defs>');
  out.push(`    <marker id="arrow" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="12" refY="5" orient="auto"><path d="M0,0 L12,5 L0,10 z" fill="${EDGE}"/></marker>`);
  out.push('  </defs>');
  out.push('  <style>text{font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.node-label{fill:' + INK + '}.edge-label{fill:' + INK + '}</style>');
  out.push('  <rect width="100%" height="100%" fill="#fffaf5"/>');

  out.push('  <g class="edges" fill="none" stroke-linejoin="round" stroke-linecap="round">');
  for (const edge of layout.edges) {
    const d = edge.points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${fmt(point.x)} ${fmt(point.y)}`).join(' ');
    out.push(`    <path id="edge-${xml(edge.connection_id)}" data-from="${xml(edge.from_node)}" data-to="${xml(edge.to_node)}" d="${d}" stroke="${EDGE}" stroke-width="2" marker-end="url(#arrow)"/>`);
  }
  out.push('  </g>');

  out.push('  <g class="edge-labels">');
  for (const edge of layout.edges) {
    if (!edge.label) continue;
    const { label } = edge;
    const cx = label.x + label.width / 2;
    const cy = label.y + label.height / 2;
    out.push(`    <g data-connection="${xml(edge.connection_id)}"><title>${xml(label.full)}</title><rect x="${fmt(label.x)}" y="${fmt(label.y)}" width="${label.width}" height="${label.height}" rx="4" fill="#fffaf5" fill-opacity="0.92"/>${textBlock(label.lines, cx, cy, label.lineHeight, FONT_SIZE_EDGE, 'edge-label')}</g>`);
  }
  out.push('  </g>');

  out.push('  <g class="nodes">');
  const byId = new Map(document.nodes.map((node) => [node.node_id, node]));
  for (const node of layout.nodes) {
    const source = byId.get(node.node_id);
    const cx = node.x + node.width / 2;
    const cy = node.y + node.height / 2;
    out.push(`    <g id="node-${xml(node.node_id)}" data-kind="${node.kind}"><title>${xml(source.label)}</title>${shapeMarkup(node)}${textBlock(node.lines, cx, cy, node.lineHeight, FONT_SIZE_NODE, 'node-label')}</g>`);
  }
  out.push('  </g>');
  out.push('</svg>');
  return { svg: `${out.join('\n')}\n`, layout };
}

module.exports = { toSvg };
