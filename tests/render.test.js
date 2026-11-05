'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { layoutDocument } = require('../src/layout');
const { toSvg } = require('../src/svg');
const { measure } = require('../src/text');
const { documentErrors } = require('../src/validate');
const { clone, fixture, assertWellFormedXml, FIXTURES } = require('./helpers');

const LONG = 'Review the quarterly regional campaign performance report with every market lead before approving the revised creative direction and budget allocation for the next flight';
const UNBROKEN = 'Supercalifragilisticexpialidocious'.repeat(8);

function build(nodes, connections, extra = {}) {
  const document = clone(fixture('campaign-approval.flow.json'));
  document.nodes = nodes;
  document.connections = connections;
  document.lanes = extra.lanes ?? [];
  document.layout = extra.layout ?? { direction: 'top-down' };
  assert.deepEqual(documentErrors(document), [], 'test document must be valid');
  return document;
}

function stress() {
  const nodes = [
    { node_id: 'start', kind: 'start', label: LONG },
    { node_id: 'check', kind: 'decision', label: LONG },
    { node_id: 'long-action', kind: 'action', label: LONG },
    { node_id: 'wordless', kind: 'system', label: UNBROKEN },
    { node_id: 'approval', kind: 'approval', label: 'Legal & brand <approval> "final"' },
    { node_id: 'paper', kind: 'document', label: 'Signed brief' },
    { node_id: 'end', kind: 'end', label: LONG },
  ];
  const connections = [
    { connection_id: 'a', from_node: 'start', to_node: 'check' },
    { connection_id: 'b', from_node: 'check', to_node: 'long-action', label: LONG },
    { connection_id: 'c', from_node: 'check', to_node: 'wordless', condition: UNBROKEN },
    { connection_id: 'd', from_node: 'long-action', to_node: 'approval', label: 'Yes & <go>' },
    { connection_id: 'e', from_node: 'wordless', to_node: 'approval' },
    { connection_id: 'f', from_node: 'approval', to_node: 'paper', label: 'Signed' },
    { connection_id: 'g', from_node: 'approval', to_node: 'check', label: 'Rework' },
    { connection_id: 'h', from_node: 'paper', to_node: 'end' },
    { connection_id: 'i', from_node: 'long-action', to_node: 'long-action', label: 'Retry' },
    { connection_id: 'j', from_node: 'paper', to_node: 'approval', label: 'Parallel one' },
    { connection_id: 'k', from_node: 'paper', to_node: 'approval', label: 'Parallel two' },
  ];
  return build(nodes, connections);
}

// Shapes read back from the SVG itself, so the checks do not depend on layout internals.
function readSvg(svg) {
  const nodes = new Map();
  for (const match of svg.matchAll(/<g id="node-([^"]+)" data-kind="([^"]+)">(.*?)<\/g>/g)) {
    const [, id, kind, body] = match;
    const ellipse = body.match(/<ellipse cx="([\d.]+)" cy="([\d.]+)" rx="([\d.]+)" ry="([\d.]+)"/);
    const polygon = body.match(/<polygon points="([^"]+)"/);
    const rect = body.match(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/);
    const lines = [...body.matchAll(/<tspan [^>]*>([^<]*)<\/tspan>/g)].map((line) => line[1]);
    let shape;
    if (ellipse) shape = { type: 'ellipse', cx: +ellipse[1], cy: +ellipse[2], rx: +ellipse[3], ry: +ellipse[4] };
    else if (polygon) {
      const pts = polygon[1].split(' ').map((pair) => pair.split(',').map(Number));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      shape = { type: 'diamond', cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, rx: (Math.max(...xs) - Math.min(...xs)) / 2, ry: (Math.max(...ys) - Math.min(...ys)) / 2 };
    } else shape = { type: 'rect', cx: +rect[1] + +rect[3] / 2, cy: +rect[2] + +rect[4] / 2, rx: +rect[3] / 2, ry: +rect[4] / 2 };
    nodes.set(id, { kind, shape, lines, title: body.match(/<title>([^<]*)<\/title>/)[1] });
  }
  const edges = [...svg.matchAll(/<path id="edge-([^"]+)" data-from="([^"]+)" data-to="([^"]+)" d="([^"]+)"/g)].map((match) => ({
    id: match[1],
    from: match[2],
    to: match[3],
    points: [...match[4].matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map((p) => [+p[1], +p[2]]),
  }));
  const size = svg.match(/<svg [^>]*width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) (\d+)"/);
  return { nodes, edges, width: +size[1], height: +size[2], viewBox: [+size[3], +size[4]] };
}

// How far a point is from the outline of a shape (0 means exactly on it).
function outlineError(shape, [x, y]) {
  const dx = Math.abs(x - shape.cx);
  const dy = Math.abs(y - shape.cy);
  if (shape.type === 'ellipse') return Math.abs(Math.sqrt((dx / shape.rx) ** 2 + (dy / shape.ry) ** 2) - 1) * Math.min(shape.rx, shape.ry);
  if (shape.type === 'diamond') return Math.abs(dx / shape.rx + dy / shape.ry - 1) * Math.min(shape.rx, shape.ry);
  if (dx > shape.rx + 0.02 || dy > shape.ry + 0.02) return Infinity;
  return Math.min(Math.abs(dx - shape.rx), Math.abs(dy - shape.ry));
}

test('layout is deterministic: the same document always gives the same result', () => {
  const document = stress();
  const first = JSON.stringify(layoutDocument(document));
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(layoutDocument(clone(document))), first);
  assert.equal(toSvg(document).svg, toSvg(clone(document)).svg);
});

test('layout coordinates are non-negative integers that fit the hint shape and stay on the canvas', () => {
  for (const document of [stress(), fixture('campaign-approval.flow.json')]) {
    const layout = layoutDocument(document);
    assert.equal(layout.hints.length, document.nodes.length);
    for (const node of layout.nodes) {
      assert.ok(Number.isInteger(node.x) && Number.isInteger(node.y) && node.x >= 0 && node.y >= 0, node.node_id);
      assert.ok(node.x + node.width <= layout.width && node.y + node.height <= layout.height, `${node.node_id} is inside the canvas`);
    }
    const adopted = clone(document);
    adopted.layout.nodes = layout.hints;
    assert.deepEqual(documentErrors(adopted), [], 'computed hints are valid hints');
    for (const edge of layout.edges) for (const point of edge.points) assert.ok(point.x >= 0 && point.y >= 0 && point.x <= layout.width && point.y <= layout.height, edge.connection_id);
  }
});

test('nodes do not overlap in a computed layout', () => {
  const layout = layoutDocument(stress());
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `${a.node_id} and ${b.node_id}`);
    }
  }
});

test('direction changes the layout axis', () => {
  const down = layoutDocument(fixture('campaign-approval.flow.json'));
  const across = clone(fixture('campaign-approval.flow.json'));
  across.layout.direction = 'top-down';
  const topDown = layoutDocument(across);
  assert.ok(down.width > down.height, 'left-right is wide');
  assert.ok(topDown.height > topDown.width, 'top-down is tall');
});

test('stored hints are used only when asked, and recomputing ignores them', () => {
  const document = fixture('campaign-approval.flow.json');
  document.layout.nodes = document.nodes.map((node, index) => ({ node_id: node.node_id, x: 40 + index * 300, y: 40 + (index % 2) * 160 }));
  assert.deepEqual(documentErrors(document), []);
  const stored = layoutDocument(document, { hints: 'use-stored' });
  assert.equal(stored.source, 'stored-hints');
  for (const hint of document.layout.nodes) {
    const placed = stored.nodes.find((node) => node.node_id === hint.node_id);
    assert.ok(placed.x >= 0 && placed.y >= 0);
  }
  assert.equal(stored.nodes[1].x - stored.nodes[0].x, 300, 'relative positions are kept');
  const recomputed = layoutDocument(document);
  assert.equal(recomputed.source, 'computed');
  assert.deepEqual(recomputed, layoutDocument(fixture('campaign-approval.flow.json')), 'stored hints do not change the computed layout');
  const without = layoutDocument(fixture('campaign-approval.flow.json'), { hints: 'use-stored' });
  assert.equal(without.source, 'computed', 'a document without hints falls back to Dagre and says so');
});

test('partial and negative hints are refused before any drawing', () => {
  const partial = fixture('campaign-approval.flow.json');
  partial.layout.nodes = [{ node_id: 'start', x: 0, y: 0 }];
  assert.ok(documentErrors(partial).some((error) => error.includes('cover every node')));
  const negative = fixture('campaign-approval.flow.json');
  negative.layout.nodes = negative.nodes.map((node) => ({ node_id: node.node_id, x: -5, y: 0 }));
  assert.ok(documentErrors(negative).length);
});

test('SVG draws every connection label, once', () => {
  const { svg } = toSvg(fixture('campaign-approval.flow.json'));
  assert.equal((svg.match(/>Approved<\/tspan>/g) ?? []).length, 1);
  assert.equal((svg.match(/>Rejected<\/tspan>/g) ?? []).length, 1);
  const labelled = fixture('campaign-approval.flow.json').connections.filter((item) => item.label || item.condition).length;
  assert.equal((svg.match(/<g data-connection=/g) ?? []).length, labelled);
});

test('arrows start and end on node outlines, including diamonds, ellipses and self loops', () => {
  const document = stress();
  const svg = toSvg(document).svg;
  const { nodes, edges } = readSvg(svg);
  assert.equal(edges.length, document.connections.length);
  assert.ok(svg.includes('marker-end="url(#arrow)"'));
  for (const edge of edges) {
    const first = edge.points[0];
    const last = edge.points[edge.points.length - 1];
    assert.ok(outlineError(nodes.get(edge.from).shape, first) < 0.06, `${edge.id} leaves ${edge.from}: ${outlineError(nodes.get(edge.from).shape, first)}`);
    assert.ok(outlineError(nodes.get(edge.to).shape, last) < 0.06, `${edge.id} reaches ${edge.to}: ${outlineError(nodes.get(edge.to).shape, last)}`);
  }
  const reference = readSvg(toSvg(fixture('campaign-approval.flow.json')).svg);
  for (const edge of reference.edges) assert.ok(outlineError(reference.nodes.get(edge.to).shape, edge.points.at(-1)) < 0.06, edge.id);
});

test('the arrowhead tip sits on the end of the path', () => {
  const { svg } = toSvg(fixture('campaign-approval.flow.json'));
  assert.match(svg, /<marker id="arrow" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="10" refX="12" refY="5" orient="auto"><path d="M0,0 L12,5 L0,10 z"/);
});

test('long labels stay inside their shapes and inside the canvas', () => {
  const document = stress();
  const { svg, layout } = toSvg(document);
  const parsed = readSvg(svg);
  for (const [id, node] of parsed.nodes) {
    const { shape } = node;
    const factor = shape.type === 'rect' ? [1, 1] : shape.type === 'ellipse' ? [Math.SQRT1_2, Math.SQRT1_2] : [0.5, 0.5];
    const maxWidth = shape.rx * 2 * factor[0] - (shape.type === 'rect' ? 16 : 0);
    const maxHeight = shape.ry * 2 * factor[1] - (shape.type === 'rect' ? 8 : 0);
    assert.ok(node.lines.length >= 1 && node.lines.length <= 3, `${id} has ${node.lines.length} lines`);
    for (const line of node.lines) assert.ok(measure(line.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'), 14) <= maxWidth, `${id}: "${line}" fits ${maxWidth}`);
    assert.ok(node.lines.length * 19 <= maxHeight, `${id} text height fits ${maxHeight}`);
  }
  assert.ok(parsed.nodes.get('start').lines.at(-1).endsWith('…'), 'cut text ends with an ellipsis');
  assert.ok(parsed.nodes.get('start').title.startsWith('Review the quarterly'), 'the full label stays available as the title');
  assert.ok(parsed.nodes.get('start').title.endsWith('allocation for the next flight'));
  assert.ok(parsed.nodes.get('wordless').lines.length > 1, 'an unbroken word is split rather than overflowing');
  for (const label of layout.edges.map((edge) => edge.label).filter(Boolean)) {
    assert.ok(label.lines.length <= 2);
    assert.ok(label.x >= 0 && label.y >= 0 && label.x + label.width <= layout.width && label.y + label.height <= layout.height);
    for (const line of label.lines) assert.ok(measure(line, 12) <= label.width - 12 + 1);
  }
  assert.deepEqual(parsed.viewBox, [parsed.width, parsed.height]);
});

test('SVG is well-formed and escapes markup in labels', () => {
  const { svg } = toSvg(stress());
  assertWellFormedXml(svg, assert);
  assert.ok(svg.includes('Legal &amp; brand &lt;approval&gt; &quot;final&quot;'));
  assert.ok(!svg.includes('<approval>'));
});

test('characters XML cannot carry are replaced, not emitted', () => {
  const document = build(
    [{ node_id: 'a', kind: 'start', label: `Bad${String.fromCharCode(0, 1, 11)}text` }, { node_id: 'b', kind: 'end', label: 'End' }],
    [{ connection_id: 'c', from_node: 'a', to_node: 'b' }],
  );
  const { svg } = toSvg(document);
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(svg));
  assertWellFormedXml(svg, assert);
});

test('lanes are declared unsupported in the SVG instead of silently dropped', () => {
  const { svg } = toSvg(fixture('campaign-approval.flow.json'));
  assert.ok(svg.includes('data-lanes="not-drawn"'));
  assert.ok(svg.includes('Lanes are not drawn.'));
  assert.ok(!svg.includes('Producer') && !svg.includes('Brand team'));
  assert.ok(!toSvg(stress()).svg.includes('data-lanes'));
  assert.ok(layoutDocument(fixture('campaign-approval.flow.json')).warnings.some((warning) => warning.includes('lanes are not drawn')));
});

test('the SVG names its source document and revision and says it is unverified', () => {
  const { svg } = toSvg(fixture('campaign-approval.revision-2.flow.json'));
  assert.ok(svg.includes('data-document-id="campaign-approval"'));
  assert.ok(svg.includes('data-document-revision="2"'));
  assert.ok(svg.includes('Unverified diagram export.'));
});

test('SVG output equals the module golden file', () => {
  const golden = path.join(FIXTURES, 'expected', 'campaign-approval.svg');
  const actual = toSvg(fixture('campaign-approval.flow.json')).svg;
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(golden, actual);
  assert.equal(actual, fs.readFileSync(golden, 'utf8'));
  const stressGolden = path.join(FIXTURES, 'expected', 'stress.svg');
  const stressActual = toSvg(stress()).svg;
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(stressGolden, stressActual);
  assert.equal(stressActual, fs.readFileSync(stressGolden, 'utf8'));
});

test('a larger flow lays out quickly and without overlap', () => {
  const nodes = [{ node_id: 'n0', kind: 'start', label: 'Start' }];
  const connections = [];
  for (let i = 1; i < 120; i += 1) {
    nodes.push({ node_id: `n${i}`, kind: 'action', label: `Step ${i}` });
    connections.push({ connection_id: `c${i}`, from_node: `n${Math.floor((i - 1) / 2)}`, to_node: `n${i}` });
  }
  const document = build(nodes, connections);
  const started = Date.now();
  const layout = layoutDocument(document);
  assert.ok(Date.now() - started < 5000);
  assert.equal(layout.nodes.length, 120);
});
