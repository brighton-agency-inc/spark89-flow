'use strict';

const { documentErrors, documentWarnings, proposalErrors } = require('./validate');

const MODULE_PRODUCER = 'flow-document';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Applies the ordered changes of a proposal to a copy of `document`. Inputs are never modified.
 *
 * The proposal must name the document, carry the exact current revision and respect the archive
 * rule (archived documents accept only a restore). Each change is checked as it is applied and the
 * resulting document is validated as a whole, so a proposal that would leave a dangling connection,
 * a decision with fewer than two branches or any other invalid structure is refused in full.
 * Nothing is repaired silently: IDs the proposal does not touch are preserved exactly.
 *
 * `requireAccepted` is true for `apply-flow-change` and false when previewing a proposal.
 * Returns { ok, errors, warnings, document }. `document` is present only when `ok`.
 */
function evaluateProposal(document, proposal, { now, requireAccepted, provenance } = {}) {
  const errors = proposalErrors(proposal, document);
  const warnings = [];
  if (errors.length) return { ok: false, errors, warnings };
  if (proposal.validation.valid === false) {
    return { ok: false, errors: ['the proposal records validation errors and cannot be applied'], warnings };
  }
  if (requireAccepted && proposal.status !== 'accepted') {
    return { ok: false, errors: [`proposal status is '${proposal.status}'; only an accepted proposal can be applied`], warnings };
  }

  const next = clone(document);
  const state = { nodeSetChanged: false, relayout: false };
  for (const change of proposal.changes) {
    const problem = applyChange(next, change, now, state);
    if (problem) errors.push(`change '${change.change_id}': ${problem}`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  if ((state.nodeSetChanged || state.relayout) && next.layout.nodes) {
    delete next.layout.nodes;
    warnings.push(
      state.relayout
        ? 'stored layout hints were cleared because the proposal requests a relayout'
        : 'stored layout hints were cleared because the set of nodes changed',
    );
  }

  next.revision = document.revision + 1;
  next.updated_at = now;
  next.provenance = {
    operation: 'apply-flow-change',
    producer: provenance?.producer ?? MODULE_PRODUCER,
    ...(provenance?.provider === undefined ? {} : { provider: provenance.provider }),
    ...(provenance?.model === undefined ? {} : { model: provenance.model }),
  };

  const resulting = documentErrors(next);
  if (resulting.length) {
    return { ok: false, errors: ['the resulting document would be invalid', ...resulting], warnings };
  }
  warnings.push(...documentWarnings(next));
  return { ok: true, errors: [], warnings, document: next };
}

function applyChange(document, change, now, state) {
  const nodes = document.nodes;
  const connections = document.connections;
  const archived = document.lifecycle.state === 'archived';
  if (archived && change.type !== 'update-lifecycle') {
    return 'the document is archived and only a restore can follow an archive in the same proposal';
  }
  switch (change.type) {
    case 'add-node': {
      if (nodes.some((node) => node.node_id === change.node.node_id)) return `node '${change.node.node_id}' already exists`;
      nodes.push(clone(change.node));
      state.nodeSetChanged = true;
      return null;
    }
    case 'update-node': {
      const node = nodes.find((item) => item.node_id === change.node_id);
      if (!node) return `node '${change.node_id}' does not exist`;
      Object.assign(node, clone(change.node_patch));
      return null;
    }
    case 'remove-node': {
      const index = nodes.findIndex((item) => item.node_id === change.node_id);
      if (index < 0) return `node '${change.node_id}' does not exist`;
      nodes.splice(index, 1);
      state.nodeSetChanged = true;
      return null;
    }
    case 'add-connection': {
      if (connections.some((item) => item.connection_id === change.connection.connection_id)) {
        return `connection '${change.connection.connection_id}' already exists`;
      }
      connections.push(clone(change.connection));
      return null;
    }
    case 'update-connection': {
      const connection = connections.find((item) => item.connection_id === change.connection_id);
      if (!connection) return `connection '${change.connection_id}' does not exist`;
      Object.assign(connection, clone(change.connection_patch));
      return null;
    }
    case 'remove-connection': {
      const index = connections.findIndex((item) => item.connection_id === change.connection_id);
      if (index < 0) return `connection '${change.connection_id}' does not exist`;
      connections.splice(index, 1);
      return null;
    }
    case 'update-document':
      Object.assign(document, clone(change.document));
      return null;
    case 'update-lifecycle':
      if (change.lifecycle_state === document.lifecycle.state) return `the document is already ${change.lifecycle_state}`;
      document.lifecycle = change.lifecycle_state === 'archived' ? { state: 'archived', archived_at: now } : { state: 'active' };
      return null;
    case 'relayout':
      document.layout.direction = change.layout_direction;
      state.relayout = true;
      return null;
    default:
      return `unsupported change type '${change.type}'`;
  }
}

module.exports = { evaluateProposal, MODULE_PRODUCER };
