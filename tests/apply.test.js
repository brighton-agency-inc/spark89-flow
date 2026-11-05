'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateProposal } = require('../src/apply');
const { documentErrors } = require('../src/validate');
const { clone, fixture } = require('./helpers');

const NOW = '2026-11-05T12:00:00Z';
const accepted = () => ({ ...fixture('campaign-approval.proposal.json'), status: 'accepted' });
const apply = (document, proposal, options = {}) => evaluateProposal(document, proposal, { now: NOW, requireAccepted: true, ...options });
const has = (errors, text) => errors.some((error) => error.includes(text));
const change = (proposal, changes) => ({ ...proposal, changes });

test('an accepted, current proposal gives the next revision with the same canonical IDs', () => {
  const base = fixture('campaign-approval.flow.json');
  const before = clone(base);
  const outcome = apply(base, accepted(), { provenance: { producer: 'ember', provider: 'chatgpt' } });
  assert.equal(outcome.ok, true, outcome.errors.join('; '));
  const next = outcome.document;
  assert.deepEqual(base, before, 'the input document is not modified');
  assert.equal(next.revision, 2);
  assert.equal(next.updated_at, NOW);
  assert.equal(next.created_at, base.created_at);
  assert.equal(next.document_id, base.document_id);
  assert.deepEqual(next.provenance, { operation: 'apply-flow-change', producer: 'ember', provider: 'chatgpt' });
  for (const node of base.nodes) assert.ok(next.nodes.some((item) => item.node_id === node.node_id), node.node_id);
  assert.deepEqual(documentErrors(next), []);
});

test('the reference proposal adds exactly the declared node and connections', () => {
  const base = fixture('campaign-approval.flow.json');
  const proposal = accepted();
  const next = apply(base, proposal).document;
  assert.deepEqual(next.nodes, [...base.nodes, proposal.changes[0].node]);
  assert.deepEqual(
    next.connections,
    [...base.connections.filter((item) => item.connection_id !== 'review-end'), proposal.changes[2].connection, proposal.changes[3].connection],
  );
  assert.deepEqual(next.lanes, base.lanes);
  assert.deepEqual(next.layout, base.layout);
});

test('the same input gives the same document', () => {
  const first = apply(fixture('campaign-approval.flow.json'), accepted());
  const second = apply(fixture('campaign-approval.flow.json'), accepted());
  assert.equal(JSON.stringify(first.document), JSON.stringify(second.document));
});

test('a proposal that is not accepted is refused', () => {
  for (const status of ['proposed', 'rejected']) {
    const outcome = apply(fixture('campaign-approval.flow.json'), { ...accepted(), status });
    assert.equal(outcome.ok, false);
    assert.ok(has(outcome.errors, 'only an accepted proposal'), status);
  }
});

test('preview mode accepts a proposed proposal and returns the resulting revision', () => {
  const outcome = evaluateProposal(fixture('campaign-approval.flow.json'), fixture('campaign-approval.proposal.json'), { now: NOW, requireAccepted: false });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.document.revision, 2);
});

test('a stale proposal is refused', () => {
  const proposal = accepted();
  proposal.base_revision = 2;
  const outcome = apply(fixture('campaign-approval.flow.json'), proposal);
  assert.equal(outcome.ok, false);
  assert.ok(has(outcome.errors, 'stale'));
});

test('a proposal for another document is refused', () => {
  const proposal = accepted();
  proposal.document_id = 'another-flow';
  const outcome = apply(fixture('campaign-approval.flow.json'), proposal);
  assert.equal(outcome.ok, false);
  assert.ok(has(outcome.errors, 'document_id'));
});

test('an archived document refuses everything except a restore', () => {
  const archived = fixture('campaign-approval.archived.flow.json');
  const proposal = { ...accepted(), base_revision: archived.revision };
  const refused = apply(archived, proposal);
  assert.equal(refused.ok, false);
  assert.ok(has(refused.errors, 'archived documents may only'));

  const restore = change({ ...proposal }, [{ change_id: 'restore', type: 'update-lifecycle', lifecycle_state: 'active' }]);
  const outcome = apply(archived, restore);
  assert.equal(outcome.ok, true, outcome.errors.join('; '));
  assert.deepEqual(outcome.document.lifecycle, { state: 'active' });
  assert.equal(outcome.document.revision, archived.revision + 1);
  assert.deepEqual(outcome.document.nodes, archived.nodes);
});

test('archiving records the archive time, and nothing may follow an archive in the same proposal', () => {
  const base = fixture('campaign-approval.flow.json');
  const archive = change(accepted(), [{ change_id: 'archive', type: 'update-lifecycle', lifecycle_state: 'archived' }]);
  const outcome = apply(base, archive);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.document.lifecycle, { state: 'archived', archived_at: NOW });

  const mixed = change(accepted(), [
    { change_id: 'archive', type: 'update-lifecycle', lifecycle_state: 'archived' },
    { change_id: 'rename', type: 'update-document', document: { title: 'New title' } },
  ]);
  assert.equal(apply(base, mixed).ok, false);
});

test('removing a node that still has connections is refused, not repaired', () => {
  const proposal = change(accepted(), [{ change_id: 'drop', type: 'remove-node', node_id: 'revise' }]);
  const outcome = apply(fixture('campaign-approval.flow.json'), proposal);
  assert.equal(outcome.ok, false);
  assert.ok(has(outcome.errors, 'missing'), outcome.errors.join('; '));
});

test('a proposal may remove a node together with its connections', () => {
  const proposal = change(accepted(), [
    { change_id: 'drop-in', type: 'remove-connection', connection_id: 'review-revise' },
    { change_id: 'drop-out', type: 'remove-connection', connection_id: 'revise-review' },
    { change_id: 'drop', type: 'remove-node', node_id: 'revise' },
    { change_id: 'add-branch', type: 'add-connection', connection: { connection_id: 'review-start', from_node: 'review', to_node: 'draft', label: 'Rework' } },
  ]);
  const outcome = apply(fixture('campaign-approval.flow.json'), proposal);
  assert.equal(outcome.ok, true, outcome.errors.join('; '));
  assert.ok(!outcome.document.nodes.some((node) => node.node_id === 'revise'));
});

test('a result that breaks an invariant is refused in full', () => {
  const base = fixture('campaign-approval.flow.json');
  const cases = {
    'decision left with one branch': [{ change_id: 'a', type: 'remove-connection', connection_id: 'review-revise' }],
    'connection into a start node': [{ change_id: 'a', type: 'add-connection', connection: { connection_id: 'bad', from_node: 'draft', to_node: 'start' } }],
    'missing lane': [{ change_id: 'a', type: 'update-node', node_id: 'draft', node_patch: { lane_id: 'nowhere' } }],
  };
  for (const [name, changes] of Object.entries(cases)) {
    const outcome = apply(base, change(accepted(), changes));
    assert.equal(outcome.ok, false, name);
    assert.equal(outcome.document, undefined, name);
  }
});

test('changes that name things that do not exist or already exist are refused', () => {
  const base = fixture('campaign-approval.flow.json');
  const cases = [
    { change_id: 'a', type: 'add-node', node: { node_id: 'draft', kind: 'action', label: 'Again' } },
    { change_id: 'a', type: 'update-node', node_id: 'missing', node_patch: { label: 'x' } },
    { change_id: 'a', type: 'remove-node', node_id: 'missing' },
    { change_id: 'a', type: 'add-connection', connection: { connection_id: 'start-draft', from_node: 'start', to_node: 'draft' } },
    { change_id: 'a', type: 'update-connection', connection_id: 'missing', connection_patch: { label: 'x' } },
    { change_id: 'a', type: 'remove-connection', connection_id: 'missing' },
    { change_id: 'a', type: 'update-lifecycle', lifecycle_state: 'active' },
  ];
  for (const item of cases) assert.equal(apply(base, change(accepted(), [item])).ok, false, item.type);
});

test('layout hints are cleared, with a note, when the node set changes or a relayout is requested', () => {
  const base = fixture('campaign-approval.flow.json');
  base.layout.nodes = base.nodes.map((node, index) => ({ node_id: node.node_id, x: index * 200, y: 0 }));
  assert.deepEqual(documentErrors(base), []);
  const added = apply(base, accepted());
  assert.equal(added.ok, true);
  assert.equal(added.document.layout.nodes, undefined);
  assert.ok(has(added.warnings, 'layout hints were cleared'));

  const relayout = apply(base, change(accepted(), [{ change_id: 'r', type: 'relayout', layout_direction: 'top-down' }]));
  assert.equal(relayout.document.layout.direction, 'top-down');
  assert.equal(relayout.document.layout.nodes, undefined);

  const rename = apply(base, change(accepted(), [{ change_id: 'n', type: 'update-document', document: { title: 'Renamed' } }]));
  assert.deepEqual(rename.document.layout.nodes, base.layout.nodes, 'hints survive a change that does not move nodes');
});

test('a proposal that records its own validation errors is refused', () => {
  const proposal = accepted();
  proposal.validation = { valid: false, errors: ['draft is incomplete'], warnings: [] };
  const outcome = apply(fixture('campaign-approval.flow.json'), proposal);
  assert.equal(outcome.ok, false);
  assert.ok(has(outcome.errors, 'records validation errors'));
});
