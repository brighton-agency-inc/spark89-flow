'use strict';

const { requireDependency } = require('./dependencies');
const { FONT_SIZE_NODE, FONT_SIZE_EDGE, LINE_HEIGHT_RATIO, wrap } = require('./text');

const MARGIN = 24;
const NODE_LINE_HEIGHT = Math.ceil(FONT_SIZE_NODE * LINE_HEIGHT_RATIO);
const EDGE_LINE_HEIGHT = Math.ceil(FONT_SIZE_EDGE * LINE_HEIGHT_RATIO);
const SELF_LOOP_REACH = 32;

function shapeOf(kind) {
  if (kind === 'start' || kind === 'end') return 'ellipse';
  if (kind === 'decision') return 'diamond';
  return 'rect';
}

const even = (value) => Math.ceil(value / 2) * 2;
const round2 = (value) => Math.round(value * 100) / 100;

/** Size of a node box from its wrapped label. Text always fits inside the drawn shape. */
function sizeNode(node) {
  const shape = shapeOf(node.kind);
  const maxWidth = shape === 'diamond' ? 128 : 176;
  const text = wrap(node.label, { maxWidth, maxLines: 3, fontSize: FONT_SIZE_NODE });
  const textWidth = Math.max(text.width, 32);
  const textHeight = text.lines.length * NODE_LINE_HEIGHT;
  let width;
  let height;
  if (shape === 'diamond') {
    width = Math.max(152, 2 * textWidth + 28);
    height = Math.max(84, 2 * textHeight + 24);
  } else if (shape === 'ellipse') {
    width = Math.max(128, Math.ceil(textWidth * Math.SQRT2) + 24);
    height = Math.max(52, Math.ceil(textHeight * Math.SQRT2) + 20);
  } else {
    width = Math.max(128, textWidth + 36);
    height = Math.max(52, textHeight + 24);
  }
  return { shape, width: even(width), height: even(height), lines: text.lines, truncated: text.truncated, lineHeight: NODE_LINE_HEIGHT };
}

function sizeEdgeLabel(connection) {
  const raw = connection.label ?? connection.condition;
  if (raw === undefined) return null;
  const text = wrap(raw, { maxWidth: 150, maxLines: 2, fontSize: FONT_SIZE_EDGE });
  return {
    lines: text.lines,
    truncated: text.truncated,
    width: even(text.width + 12),
    height: even(text.lines.length * EDGE_LINE_HEIGHT + 6),
    lineHeight: EDGE_LINE_HEIGHT,
    full: raw,
  };
}

/**
 * The point where the ray from the center of `box` toward `target` leaves the node shape. Arrow
 * ends use this so a line meets the drawn outline, not the bounding box.
 */
function boundaryPoint(box, target) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  let dx = target.x - cx;
  let dy = target.y - cy;
  if (dx === 0 && dy === 0) {
    dx = 1;
    dy = 0;
  }
  const a = box.width / 2;
  const b = box.height / 2;
  let scale;
  if (box.shape === 'diamond') scale = 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  else if (box.shape === 'ellipse') scale = 1 / Math.sqrt((dx * dx) / (a * a) + (dy * dy) / (b * b));
  else scale = 1 / Math.max(Math.abs(dx) / a, Math.abs(dy) / b);
  return { x: round2(cx + dx * scale), y: round2(cy + dy * scale) };
}

const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });

function selfLoop(box, horizontal) {
  const c = centerOf(box);
  // Flow runs along x when top-down loops leave the right side; for left-right flow they leave the top.
  const out = horizontal ? { x: 0, y: -1 } : { x: 1, y: 0 };
  const along = horizontal ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const half = horizontal ? box.height / 2 : box.width / 2;
  const quarter = (horizontal ? box.width : box.height) / 4;
  const at = (reach, side) => ({ x: c.x + out.x * reach + along.x * side * quarter, y: c.y + out.y * reach + along.y * side * quarter });
  const first = boundaryPoint(box, at(half * 2, -1));
  const last = boundaryPoint(box, at(half * 2, 1));
  return {
    points: [first, at(half + SELF_LOOP_REACH, -1), at(half + SELF_LOOP_REACH, 1), last],
    labelCenter: at(half + SELF_LOOP_REACH, 0),
    outward: out,
  };
}

/** Unfinished route for a connection placed without Dagre: straight, with parallel edges fanned apart. */
function fannedInterior(connection, boxes, groups) {
  const key = [connection.from_node, connection.to_node].sort().join('\u0000');
  const group = groups.get(key);
  if (group.length < 2) return [];
  const [low, high] = [connection.from_node, connection.to_node].sort();
  const a = centerOf(boxes.get(low));
  const b = centerOf(boxes.get(high));
  const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const normal = { x: -(b.y - a.y) / length, y: (b.x - a.x) / length };
  const offset = (group.indexOf(connection.connection_id) - (group.length - 1) / 2) * 36;
  return [{ x: round2((a.x + b.x) / 2 + normal.x * offset), y: round2((a.y + b.y) / 2 + normal.y * offset) }];
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Deterministic layout for a valid flow document.
 *
 * `hints: 'recompute'` (default) places nodes with Dagre and ignores stored coordinates.
 * `hints: 'use-stored'` places nodes at the document's stored layout hints, which a valid document
 * either provides for every node or omits; a document without hints is laid out with Dagre and the
 * result says so in `source`. Connections between stored positions are drawn as straight lines
 * between node outlines.
 *
 * Returns the placed nodes, routed edges, canvas size and hint coordinates. Every coordinate is
 * non-negative. Node coordinates are integers (top-left corners) so they fit the layout hint shape
 * of the flow-document contract.
 */
function layoutDocument(document, { hints = 'recompute' } = {}) {
  const horizontal = document.layout.direction === 'left-right';
  const sizes = new Map(document.nodes.map((node) => [node.node_id, sizeNode(node)]));
  const labels = new Map(document.connections.map((connection) => [connection.connection_id, sizeEdgeLabel(connection)]));
  const stored = document.layout.nodes;
  const useStored = hints === 'use-stored' && stored !== undefined && stored.length > 0;
  const warnings = [];

  const boxes = new Map();
  const interior = new Map();
  const labelAt = new Map();
  const dagre = requireDependency('@dagrejs/dagre');

  if (useStored) {
    for (const hint of stored) {
      const size = sizes.get(hint.node_id);
      boxes.set(hint.node_id, { x: hint.x, y: hint.y, width: size.width, height: size.height, shape: size.shape });
    }
  } else {
    const graph = new dagre.graphlib.Graph({ multigraph: true });
    graph.setGraph({ rankdir: horizontal ? 'LR' : 'TB', nodesep: 48, ranksep: 72, edgesep: 28, marginx: 0, marginy: 0 });
    graph.setDefaultEdgeLabel(() => ({}));
    for (const node of document.nodes) {
      const size = sizes.get(node.node_id);
      graph.setNode(node.node_id, { width: size.width, height: size.height });
    }
    for (const connection of document.connections) {
      if (connection.from_node === connection.to_node) continue;
      const label = labels.get(connection.connection_id);
      graph.setEdge(
        connection.from_node,
        connection.to_node,
        label ? { width: label.width, height: label.height, labelpos: 'c' } : {},
        connection.connection_id,
      );
    }
    dagre.layout(graph);
    for (const node of document.nodes) {
      const placed = graph.node(node.node_id);
      const size = sizes.get(node.node_id);
      boxes.set(node.node_id, { x: placed.x - size.width / 2, y: placed.y - size.height / 2, width: size.width, height: size.height, shape: size.shape });
    }
    for (const connection of document.connections) {
      if (connection.from_node === connection.to_node) continue;
      const edge = graph.edge(connection.from_node, connection.to_node, connection.connection_id);
      interior.set(connection.connection_id, edge.points.slice(1, -1).map((p) => ({ x: p.x, y: p.y })));
      if (labels.get(connection.connection_id)) labelAt.set(connection.connection_id, { x: edge.x, y: edge.y });
    }
  }

  // Extent of everything drawn, used to move the picture to non-negative coordinates.
  const extent = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const grow = (x, y, halfW = 0, halfH = 0) => {
    extent.minX = Math.min(extent.minX, x - halfW);
    extent.minY = Math.min(extent.minY, y - halfH);
    extent.maxX = Math.max(extent.maxX, x + halfW);
    extent.maxY = Math.max(extent.maxY, y + halfH);
  };

  const groups = new Map();
  if (useStored) {
    for (const connection of document.connections) {
      if (connection.from_node === connection.to_node) continue;
      const key = [connection.from_node, connection.to_node].sort().join('\u0000');
      groups.set(key, [...(groups.get(key) ?? []), connection.connection_id]);
    }
  }

  const routed = new Map();
  for (const connection of document.connections) {
    const id = connection.connection_id;
    const from = boxes.get(connection.from_node);
    const to = boxes.get(connection.to_node);
    const label = labels.get(id);
    if (connection.from_node === connection.to_node) {
      const loop = selfLoop(from, horizontal);
      const labelCenter = label
        ? { x: loop.labelCenter.x + loop.outward.x * (label.width / 2 + 4) * (loop.outward.x ? 1 : 0), y: loop.labelCenter.y + loop.outward.y * (label.height / 2 + 4) }
        : null;
      routed.set(id, { points: loop.points, labelCenter });
    } else {
      const middle = useStored ? fannedInterior(connection, boxes, groups) : interior.get(id);
      const towardStart = middle.length ? middle[0] : centerOf(to);
      const towardEnd = middle.length ? middle[middle.length - 1] : centerOf(from);
      const points = [boundaryPoint(from, towardStart), ...middle.map((p) => ({ x: round2(p.x), y: round2(p.y) })), boundaryPoint(to, towardEnd)];
      let labelCenter = labelAt.get(id) ?? null;
      if (label && !labelCenter) {
        const mid = points[Math.floor((points.length - 1) / 2)];
        const next = points[Math.floor((points.length - 1) / 2) + 1];
        labelCenter = { x: (mid.x + next.x) / 2, y: (mid.y + next.y) / 2 };
      }
      routed.set(id, { points, labelCenter: label ? labelCenter : null });
    }
    for (const point of routed.get(id).points) grow(point.x, point.y);
    const placedLabel = routed.get(id).labelCenter;
    if (label && placedLabel) grow(placedLabel.x, placedLabel.y, label.width / 2, label.height / 2);
  }
  for (const box of boxes.values()) {
    grow(box.x, box.y);
    grow(box.x + box.width, box.y + box.height);
  }

  // Integer node corners keep the hints valid under the contract (non-negative integers). The same
  // integer shift applies to everything, so routes and labels stay aligned with their nodes.
  const shiftX = Math.ceil(MARGIN - extent.minX);
  const shiftY = Math.ceil(MARGIN - extent.minY);
  const move = (point) => ({ x: round2(point.x + shiftX), y: round2(point.y + shiftY) });

  const nodes = document.nodes.map((node) => {
    const box = boxes.get(node.node_id);
    const size = sizes.get(node.node_id);
    return {
      node_id: node.node_id,
      kind: node.kind,
      shape: size.shape,
      x: Math.round(box.x + shiftX),
      y: Math.round(box.y + shiftY),
      width: size.width,
      height: size.height,
      lines: size.lines,
      truncated: size.truncated,
      lineHeight: size.lineHeight,
    };
  });
  const placedBoxes = new Map(nodes.map((node) => [node.node_id, node]));

  // The layout moved by whole pixels, but Dagre centers can sit on half pixels. Re-clip every end
  // against the final integer boxes so each arrow meets its node outline exactly.
  const edges = document.connections.map((connection) => {
    const id = connection.connection_id;
    const route = routed.get(id);
    const label = labels.get(id);
    let points = route.points.map(move);
    if (connection.from_node !== connection.to_node) {
      const from = placedBoxes.get(connection.from_node);
      const to = placedBoxes.get(connection.to_node);
      const middle = points.slice(1, -1);
      points = [boundaryPoint(from, middle.length ? middle[0] : centerOf(to)), ...middle, boundaryPoint(to, middle.length ? middle[middle.length - 1] : centerOf(from))];
    }
    const center = route.labelCenter ? move(route.labelCenter) : null;
    return {
      connection_id: id,
      from_node: connection.from_node,
      to_node: connection.to_node,
      points,
      label: label && center ? { x: round2(center.x - label.width / 2), y: round2(center.y - label.height / 2), width: label.width, height: label.height, lines: label.lines, truncated: label.truncated, lineHeight: label.lineHeight, full: label.full } : null,
    };
  });

  const width = Math.ceil(extent.maxX + shiftX + MARGIN);
  const height = Math.ceil(extent.maxY + shiftY + MARGIN);

  if (useStored) {
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        if (overlaps(nodes[i], nodes[j])) warnings.push(`stored layout places nodes '${nodes[i].node_id}' and '${nodes[j].node_id}' on top of each other`);
      }
    }
  }
  if (document.lanes.length) warnings.push('lanes are not drawn; node lane assignments stay in the document');

  return {
    source: useStored ? 'stored-hints' : 'computed',
    direction: document.layout.direction,
    width,
    height,
    nodes,
    edges,
    hints: nodes.map((node) => ({ node_id: node.node_id, x: node.x, y: node.y })),
    warnings,
    engine: { name: '@dagrejs/dagre', version: dagre.version },
  };
}

module.exports = { layoutDocument, boundaryPoint, MARGIN };
