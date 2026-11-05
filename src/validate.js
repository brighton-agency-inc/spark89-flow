'use strict';

const { schemaErrors } = require('./contracts');

function duplicates(values, kind) {
  const seen = new Set();
  const repeated = [];
  for (const value of values) {
    if (seen.has(value) && !repeated.includes(value)) repeated.push(value);
    seen.add(value);
  }
  return repeated.map((value) => `duplicate ${kind} id '${value}'`);
}

function branchKey(connection) {
  return JSON.stringify([connection.label ?? null, connection.condition ?? null]);
}

/**
 * Structural errors for a flow document: the Forge schema plus the semantic invariants of the
 * flow-document specification. Error text matches the Forge reference validator
 * (contracts/validate_flow.py) so the two can be compared on the same input.
 */
function documentErrors(document) {
  const errors = schemaErrors('flow-document', document);
  if (errors.length) return errors;
  const nodeIds = document.nodes.map((node) => node.node_id);
  const connectionIds = document.connections.map((item) => item.connection_id);
  const laneIds = document.lanes.map((item) => item.lane_id);
  errors.push(...duplicates(nodeIds, 'node'), ...duplicates(connectionIds, 'connection'), ...duplicates(laneIds, 'lane'));
  const knownNodes = new Set(nodeIds);
  const knownLanes = new Set(laneIds);
  const incoming = new Map(nodeIds.map((id) => [id, 0]));
  const outgoing = new Map(nodeIds.map((id) => [id, []]));
  for (const connection of document.connections) {
    const { from_node: source, to_node: target } = connection;
    if (!knownNodes.has(source)) errors.push(`connection '${connection.connection_id}' references missing source node '${source}'`);
    else outgoing.get(source).push(connection);
    if (!knownNodes.has(target)) errors.push(`connection '${connection.connection_id}' references missing target node '${target}'`);
    else incoming.set(target, incoming.get(target) + 1);
  }
  for (const node of document.nodes) {
    const id = node.node_id;
    if (node.lane_id !== undefined && !knownLanes.has(node.lane_id)) errors.push(`node '${id}' references missing lane '${node.lane_id}'`);
    if (node.kind === 'start' && incoming.get(id)) errors.push(`start node '${id}' has an incoming connection`);
    if (node.kind === 'end' && outgoing.get(id).length) errors.push(`end node '${id}' has an outgoing connection`);
    if (node.kind === 'decision') {
      const branches = new Set(outgoing.get(id).map(branchKey));
      if (outgoing.get(id).length < 2 || branches.size < 2) {
        errors.push(`decision node '${id}' needs at least two distinguishable outgoing branches`);
      }
    }
  }
  const hints = document.layout.nodes ?? [];
  const hintIds = hints.map((item) => item.node_id);
  errors.push(...duplicates(hintIds, 'layout node'));
  const hinted = new Set(hintIds);
  if (hintIds.length && !(hinted.size === knownNodes.size && [...hinted].every((id) => knownNodes.has(id)))) {
    errors.push('layout hints must cover every node or be omitted');
  }
  for (const id of hintIds) if (!knownNodes.has(id)) errors.push(`layout references missing node '${id}'`);
  return errors;
}

/** Warnings for a draftable flow. Call only for a document without errors. */
function documentWarnings(document) {
  const warnings = [];
  const nodes = document.nodes;
  const starts = nodes.filter((node) => node.kind === 'start');
  if (!starts.length) warnings.push('the flow has no start node');
  if (!nodes.some((node) => node.kind === 'end')) warnings.push('the flow has no end node');
  const outgoing = new Map(nodes.map((node) => [node.node_id, []]));
  for (const connection of document.connections) outgoing.get(connection.from_node).push(connection);
  for (const node of nodes) {
    if (node.kind === 'decision') {
      for (const branch of outgoing.get(node.node_id)) {
        if (branch.label === undefined && branch.condition === undefined) {
          warnings.push(`decision node '${node.node_id}' has an unlabeled outgoing branch '${branch.connection_id}'`);
        }
      }
    }
    if (node.kind !== 'end' && !outgoing.get(node.node_id).length) {
      warnings.push(`node '${node.node_id}' has no outgoing connection and is not an end node`);
    }
  }
  if (starts.length) {
    const reached = new Set(starts.map((node) => node.node_id));
    const queue = [...reached];
    while (queue.length) {
      for (const connection of outgoing.get(queue.shift())) {
        if (!reached.has(connection.to_node)) {
          reached.add(connection.to_node);
          queue.push(connection.to_node);
        }
      }
    }
    for (const node of nodes) if (!reached.has(node.node_id)) warnings.push(`node '${node.node_id}' is not reachable from a start node`);
  }
  return warnings;
}

function validateDocument(document) {
  const errors = documentErrors(document);
  return { valid: errors.length === 0, errors, warnings: errors.length ? [] : documentWarnings(document) };
}

/**
 * Checks a proposal on its own and, when `document` is given, against that document: the document
 * ID must match, the base revision must equal the document revision (compare-and-swap), and an
 * archived document accepts only a restore. Error text matches contracts/validate_flow.py.
 */
function proposalErrors(proposal, document) {
  const errors = schemaErrors('flow-change-proposal', proposal);
  if (errors.length) return errors;
  errors.push(...duplicates(proposal.changes.map((item) => item.change_id), 'change'));
  if (proposal.validation.valid !== (proposal.validation.errors.length === 0)) {
    errors.push('validation.valid must equal whether validation.errors is empty');
  }
  if (document !== undefined) {
    const baseErrors = documentErrors(document);
    if (baseErrors.length) return ['base document is invalid', ...baseErrors];
    if (proposal.document_id !== document.document_id) errors.push('proposal document_id does not match the base document');
    if (proposal.base_revision !== document.revision) errors.push('proposal base_revision is stale or does not match the base document');
    if (document.lifecycle.state === 'archived') {
      const restoreOnly = proposal.changes.every((item) => item.type === 'update-lifecycle' && item.lifecycle_state === 'active');
      if (!restoreOnly) errors.push('archived documents may only receive a restore lifecycle change');
    }
  }
  return errors;
}

module.exports = { documentErrors, documentWarnings, validateDocument, proposalErrors };
