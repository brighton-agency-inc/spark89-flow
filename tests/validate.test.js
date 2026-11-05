'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDocument, proposalErrors } = require('../src/validate');
const { clone, fixture } = require('./helpers');

const NAMES = ['campaign-approval.flow.json', 'campaign-approval.revision-2.flow.json', 'campaign-approval.archived.flow.json', 'campaign-approval.restored.flow.json'];
const errorsOf = (document) => validateDocument(document).errors;
const has = (errors, text) => errors.some((error) => error.includes(text));

test('the Forge reference documents are valid and the reference proposal applies to revision 1', () => {
  for (const name of NAMES) assert.deepEqual(errorsOf(fixture(name)), [], name);
  assert.deepEqual(proposalErrors(fixture('campaign-approval.proposal.json'), fixture('campaign-approval.flow.json')), []);
});

test('duplicate node, connection and lane IDs are rejected', () => {
  const document = fixture('campaign-approval.flow.json');
  document.nodes.push(clone(document.nodes[0]));
  document.connections.push(clone(document.connections[0]));
  document.lanes.push(clone(document.lanes[0]));
  const errors = errorsOf(document);
  assert.ok(has(errors, 'duplicate node'));
  assert.ok(has(errors, 'duplicate connection'));
  assert.ok(has(errors, 'duplicate lane'));
});

test('dangling connections and lanes are rejected', () => {
  const document = fixture('campaign-approval.flow.json');
  document.connections[0].to_node = 'missing';
  document.connections[1].from_node = 'gone';
  document.nodes[0].lane_id = 'missing';
  const errors = errorsOf(document);
  assert.ok(has(errors, 'missing target'));
  assert.ok(has(errors, 'missing source'));
  assert.ok(has(errors, 'missing lane'));
});

test('start, end and decision rules are enforced', () => {
  const document = fixture('campaign-approval.flow.json');
  document.connections.push({ connection_id: 'bad-start', from_node: 'draft', to_node: 'start' });
  document.connections.push({ connection_id: 'bad-end', from_node: 'end', to_node: 'draft' });
  document.connections = document.connections.filter((item) => item.connection_id !== 'review-revise');
  const errors = errorsOf(document);
  assert.ok(has(errors, 'start node'));
  assert.ok(has(errors, 'end node'));
  assert.ok(has(errors, 'two distinguishable'));
});

test('a decision whose branches share a label and condition is not distinguishable', () => {
  const document = fixture('campaign-approval.flow.json');
  for (const connection of document.connections) if (connection.from_node === 'review') connection.label = 'Same';
  assert.ok(has(errorsOf(document), 'two distinguishable'));
});

test('layout hints must cover every node, be integers and be non-negative', () => {
  const document = fixture('campaign-approval.flow.json');
  document.layout.nodes = [{ node_id: 'start', x: 0, y: 0 }];
  assert.ok(has(errorsOf(document), 'cover every node'), 'partial hints');
  document.layout.nodes[0].x = -1;
  assert.ok(errorsOf(document).length, 'negative coordinate');
  document.layout.nodes[0].x = 1.5;
  assert.ok(errorsOf(document).length, 'fractional coordinate');
  document.layout.nodes = document.nodes.map((node, index) => ({ node_id: node.node_id, x: index * 10, y: 0 }));
  assert.deepEqual(errorsOf(document), []);
  document.layout.nodes.push({ node_id: 'ghost', x: 0, y: 0 });
  assert.ok(has(errorsOf(document), 'ghost') || has(errorsOf(document), 'cover every node'));
});

test('credentials, conversation fields and destination fields are not part of a document', () => {
  for (const [place, field] of [
    ['provenance', 'api_token'],
    ['provenance', 'access_token'],
    ['provenance', 'chatgpt_conversation_id'],
    ['provenance', 'openai_api_key'],
    ['provenance', 'transcript'],
    ['root', 'figjam_url'],
    ['root', 'conversation'],
    ['root', 'provider_credentials'],
  ]) {
    const document = fixture('campaign-approval.flow.json');
    (place === 'root' ? document : document.provenance)[field] = 'value';
    assert.ok(errorsOf(document).length, `${place}.${field} must be refused`);
  }
});

test('provider names are allowed as provenance and nothing more', () => {
  const document = fixture('campaign-approval.flow.json');
  document.provenance = { operation: 'create-flow-document', producer: 'ember', provider: 'chatgpt', model: 'gpt-x' };
  assert.deepEqual(errorsOf(document), []);
});

test('archive state and timestamp must agree', () => {
  const document = fixture('campaign-approval.archived.flow.json');
  delete document.lifecycle.archived_at;
  assert.ok(errorsOf(document).length);
  const active = fixture('campaign-approval.flow.json');
  active.lifecycle.archived_at = '2026-11-04T14:00:00Z';
  assert.ok(errorsOf(active).length);
});

test('stale and wrong-document proposals are refused', () => {
  const proposal = fixture('campaign-approval.proposal.json');
  proposal.base_revision = 9;
  proposal.document_id = 'another-flow';
  const errors = proposalErrors(proposal, fixture('campaign-approval.flow.json'));
  assert.ok(has(errors, 'base_revision'));
  assert.ok(has(errors, 'document_id'));
});

test('an archived document accepts only a restore', () => {
  const archived = fixture('campaign-approval.archived.flow.json');
  const proposal = fixture('campaign-approval.proposal.json');
  proposal.base_revision = archived.revision;
  assert.ok(has(proposalErrors(proposal, archived), 'archived documents may only'));
  const restore = clone(proposal);
  restore.changes = [{ change_id: 'restore', type: 'update-lifecycle', lifecycle_state: 'active' }];
  assert.deepEqual(proposalErrors(restore, archived), []);
});

test('a proposal validation flag must agree with its errors, and update changes need a patch', () => {
  const proposal = fixture('campaign-approval.proposal.json');
  proposal.validation = { valid: true, errors: ['bad'], warnings: [] };
  assert.ok(has(proposalErrors(proposal), 'validation.valid'));
  const patchless = fixture('campaign-approval.proposal.json');
  patchless.changes = [{ change_id: 'rename', type: 'update-node', node_id: 'draft' }];
  assert.ok(proposalErrors(patchless).length);
});

test('warnings describe a draftable flow without refusing it', () => {
  const document = fixture('campaign-approval.flow.json');
  document.nodes = document.nodes.filter((node) => node.kind !== 'end');
  document.connections = document.connections.filter((item) => item.to_node !== 'end');
  delete document.connections.find((item) => item.connection_id === 'review-revise').label;
  const result = validateDocument(document);
  assert.equal(result.valid, false, 'the decision now has one labelled branch only');
  document.connections.push({ connection_id: 'review-more', from_node: 'review', to_node: 'draft', label: 'More' });
  const draft = validateDocument(document);
  assert.equal(draft.valid, true, draft.errors.join('; '));
  assert.ok(has(draft.warnings, 'no end node'));
  assert.ok(has(draft.warnings, 'unlabeled outgoing branch'));
});

test('a duplicated layout hint is reported once, matching the Forge validator', () => {
  const document = fixture('campaign-approval.flow.json');
  document.layout.nodes = [...document.nodes.map((node, index) => ({ node_id: node.node_id, x: index, y: 0 })), { node_id: 'start', x: 0, y: 0 }];
  assert.deepEqual(errorsOf(document), ["duplicate layout node id 'start'"]);
});
