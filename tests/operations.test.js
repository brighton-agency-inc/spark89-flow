'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, OPERATIONS } = require('../src/operations');
const { schemaErrors } = require('../src/contracts');
const { validateDocument } = require('../src/validate');
const { digest, clone, fixture, fixtureText, makeRequest, tmp, assertWellFormedXml } = require('./helpers');

const accepted = () => ({ ...fixture('campaign-approval.proposal.json'), status: 'accepted' });
const doc = () => fixture('campaign-approval.flow.json');

function execute(operation, options) {
  const made = makeRequest(operation, options);
  const { result, exitCode } = run(made.request);
  assert.deepEqual(schemaErrors('operation-result', result), [], 'every result matches operation-result 1.0.0');
  return { ...made, result, exitCode };
}

const codes = (result) => result.errors.map((error) => error.code);
const omissionCodes = (result) => result.omissions.map((omission) => omission.code);

test('every operation returns a schema-valid review_required result, never succeeded', () => {
  const cases = {
    'create-flow-document': { parameters: { document_id: 'new-flow', title: 'New flow', nodes: [{ node_id: 'a', kind: 'start', label: 'A' }, { node_id: 'b', kind: 'end', label: 'B' }], connections: [{ connection_id: 'ab', from_node: 'a', to_node: 'b' }] } },
    'validate-flow-document': { inputs: { 'flow-document': doc() } },
    'validate-flow-proposal': { inputs: { 'flow-document': doc(), 'flow-change-proposal': fixture('campaign-approval.proposal.json') } },
    'apply-flow-change': { inputs: { 'flow-document': doc(), 'flow-change-proposal': accepted() } },
    'layout-flow-document': { inputs: { 'flow-document': doc() } },
    'export-flow-svg': { inputs: { 'flow-document': doc() } },
    'export-flow-mermaid': { inputs: { 'flow-document': doc() } },
  };
  assert.deepEqual(Object.keys(cases).sort(), Object.keys(OPERATIONS).sort());
  for (const [operation, options] of Object.entries(cases)) {
    const { result, exitCode } = execute(operation, options);
    assert.equal(result.status, 'review_required', `${operation}: ${JSON.stringify(result.errors)}`);
    assert.equal(exitCode, 0);
    assert.ok(result.outputs.length >= 1);
    assert.ok(omissionCodes(result).includes('output-unverified'), operation);
    assert.equal(result.omissions.find((item) => item.code === 'output-unverified').impact, 'verification_blocking');
    assert.deepEqual(result.evidence, []);
    for (const output of result.outputs) {
      const bytes = fs.readFileSync(output.location);
      assert.equal(output.sha256, digest(bytes), `${operation} output digest`);
      assert.equal(output.size_bytes, bytes.length);
    }
  }
});

test('results carry no verification claim and no approval record', () => {
  const { result } = execute('export-flow-svg', { inputs: { 'flow-document': doc() } });
  const text = JSON.stringify(result);
  assert.ok(!/"verification_manifest"|"human_approval"|"approved"|"verified"/i.test(text));
});

test('create makes a revision 1 document with caller-supplied IDs and request time', () => {
  const { result, outputDir } = execute('create-flow-document', {
    parameters: { document_id: 'new-flow', title: 'New flow', description: 'A test', direction: 'left-right', producer: 'ember', provider: 'chatgpt', model: 'gpt-x', nodes: [{ node_id: 'a-b', kind: 'start', label: 'A' }, { node_id: 'a_b', kind: 'end', label: 'B' }], connections: [{ connection_id: 'ab', from_node: 'a-b', to_node: 'a_b' }] },
  });
  const created = JSON.parse(fs.readFileSync(path.join(outputDir, 'flow-document.json'), 'utf8'));
  assert.equal(result.status, 'review_required');
  assert.equal(created.revision, 1);
  assert.equal(created.created_at, '2026-11-05T12:00:00Z');
  assert.deepEqual(created.provenance, { operation: 'create-flow-document', producer: 'ember', provider: 'chatgpt', model: 'gpt-x' });
  assert.deepEqual(created.nodes.map((node) => node.node_id), ['a-b', 'a_b']);
  assert.deepEqual(validateDocument(created).errors, []);
});

test('create refuses an invalid draft and writes nothing', () => {
  const { result, outputDir, exitCode } = execute('create-flow-document', {
    parameters: { document_id: 'new-flow', title: 'New flow', nodes: [{ node_id: 'a', kind: 'decision', label: 'A?' }], connections: [] },
  });
  assert.equal(result.status, 'failed');
  assert.equal(exitCode, 3);
  assert.deepEqual(codes(result), ['invalid-document']);
  assert.ok(result.errors[0].details.errors.some((error) => error.includes('two distinguishable')));
  assert.ok(!fs.existsSync(outputDir));
});

test('create is deterministic for the same request', () => {
  const parameters = { document_id: 'new-flow', title: 'New flow', nodes: [{ node_id: 'a', kind: 'start', label: 'A' }, { node_id: 'b', kind: 'end', label: 'B' }], connections: [{ connection_id: 'ab', from_node: 'a', to_node: 'b' }] };
  const first = execute('create-flow-document', { parameters });
  const second = execute('create-flow-document', { parameters });
  assert.equal(first.result.outputs[0].sha256, second.result.outputs[0].sha256);
});

test('validate reports errors and warnings in a report, and never rewrites the input', () => {
  const bad = doc();
  bad.connections[0].to_node = 'missing';
  const before = JSON.stringify(bad);
  const { result, outputDir, inputDir } = execute('validate-flow-document', { inputs: { 'flow-document': bad } });
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'validation-report.json'), 'utf8'));
  assert.equal(result.status, 'review_required');
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => error.includes('missing target')));
  assert.equal(report.verification_state, 'unverified');
  assert.equal(report.document_id, 'campaign-approval');
  assert.ok(omissionCodes(result).includes('input-invalid'));
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(inputDir, 'flow-document.json'), 'utf8'))), JSON.stringify(JSON.parse(before)));
});

test('validate accepts a document that is not even an object and reports it', () => {
  const { result, outputDir } = execute('validate-flow-document', { inputs: { 'flow-document': [] } });
  const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'validation-report.json'), 'utf8'));
  assert.equal(result.status, 'review_required');
  assert.equal(report.valid, false);
  assert.equal(report.document_id, null);
});

test('proposal validation reports stale, wrong-document and archived cases', () => {
  const cases = [
    ['stale', doc(), { ...fixture('campaign-approval.proposal.json'), base_revision: 5 }, 'stale'],
    ['wrong document', doc(), { ...fixture('campaign-approval.proposal.json'), document_id: 'other' }, 'document_id'],
    ['archived', fixture('campaign-approval.archived.flow.json'), { ...fixture('campaign-approval.proposal.json'), base_revision: 3 }, 'archived documents may only'],
  ];
  for (const [name, document, proposal, text] of cases) {
    const { result, outputDir } = execute('validate-flow-proposal', { inputs: { 'flow-document': document, 'flow-change-proposal': proposal } });
    const report = JSON.parse(fs.readFileSync(path.join(outputDir, 'validation-report.json'), 'utf8'));
    assert.equal(report.valid, false, name);
    assert.ok(report.errors.some((error) => error.includes(text)), `${name}: ${report.errors}`);
    assert.equal(result.status, 'review_required');
  }
  const { outputDir } = execute('validate-flow-proposal', { inputs: { 'flow-document': doc(), 'flow-change-proposal': fixture('campaign-approval.proposal.json') } });
  const ok = JSON.parse(fs.readFileSync(path.join(outputDir, 'validation-report.json'), 'utf8'));
  assert.equal(ok.valid, true);
  assert.equal(ok.resulting_revision, 2);
});

test('apply writes the next revision and refuses stale, wrong-document, archived and unaccepted proposals with no output', () => {
  const good = execute('apply-flow-change', { inputs: { 'flow-document': doc(), 'flow-change-proposal': accepted() }, parameters: { producer: 'ember', provider: 'chatgpt' } });
  const next = JSON.parse(fs.readFileSync(path.join(good.outputDir, 'flow-document.json'), 'utf8'));
  assert.equal(next.revision, 2);
  assert.equal(next.updated_at, '2026-11-05T12:00:00Z');
  assert.deepEqual(next.provenance, { operation: 'apply-flow-change', producer: 'ember', provider: 'chatgpt' });
  assert.deepEqual(validateDocument(next).errors, []);

  const refusals = [
    ['proposal-stale', doc(), { ...accepted(), base_revision: 2 }],
    ['document-mismatch', doc(), { ...accepted(), document_id: 'other' }],
    ['archived-document', fixture('campaign-approval.archived.flow.json'), { ...accepted(), base_revision: 3 }],
    ['proposal-not-accepted', doc(), fixture('campaign-approval.proposal.json')],
    ['proposal-not-accepted', doc(), { ...accepted(), status: 'rejected' }],
  ];
  for (const [code, document, proposal] of refusals) {
    const refused = execute('apply-flow-change', { inputs: { 'flow-document': document, 'flow-change-proposal': proposal } });
    assert.equal(refused.result.status, 'failed', code);
    assert.deepEqual(codes(refused.result), [code]);
    assert.equal(refused.exitCode, 3);
    assert.equal(refused.result.outputs.length, 0);
    assert.ok(!fs.existsSync(refused.outputDir), `${code} writes nothing`);
  }
});

test('apply restores an archived document with a restore-only proposal', () => {
  const archived = fixture('campaign-approval.archived.flow.json');
  const restore = { ...accepted(), base_revision: archived.revision, changes: [{ change_id: 'restore', type: 'update-lifecycle', lifecycle_state: 'active' }] };
  const { result, outputDir } = execute('apply-flow-change', { inputs: { 'flow-document': archived, 'flow-change-proposal': restore } });
  assert.equal(result.status, 'review_required');
  const next = JSON.parse(fs.readFileSync(path.join(outputDir, 'flow-document.json'), 'utf8'));
  assert.deepEqual(next.lifecycle, { state: 'active' });
});

test('layout, SVG and Mermaid outputs are deterministic and name the source revision', () => {
  const lay = execute('layout-flow-document', { inputs: { 'flow-document': doc() } });
  const record = JSON.parse(fs.readFileSync(path.join(lay.outputDir, 'flow-layout.json'), 'utf8'));
  assert.equal(record.document_id, 'campaign-approval');
  assert.equal(record.document_revision, 1);
  assert.equal(record.verification_state, 'unverified');
  assert.equal(record.engine.name, '@dagrejs/dagre');
  assert.ok(record.layout_hints.every((hint) => hint.x >= 0 && hint.y >= 0 && Number.isInteger(hint.x)));
  assert.deepEqual(omissionCodes(lay.result).filter((code) => code === 'lanes-not-drawn'), ['lanes-not-drawn']);

  const again = execute('layout-flow-document', { inputs: { 'flow-document': doc() } });
  assert.equal(lay.result.outputs[0].sha256, again.result.outputs[0].sha256);

  const svg = execute('export-flow-svg', { inputs: { 'flow-document': doc() } });
  const text = fs.readFileSync(svg.result.outputs[0].location, 'utf8');
  assertWellFormedXml(text, assert);
  assert.equal(svg.result.outputs[0].media_type, 'image/svg+xml');
  assert.ok(svg.result.outputs[0].width > 0 && svg.result.outputs[0].height > 0);
  assert.ok(text.includes('data-document-revision="1"'));

  const mermaid = execute('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  assert.ok(fs.readFileSync(mermaid.result.outputs[0].location, 'utf8').includes('%% flow-document campaign-approval revision 1'));
  assert.equal(mermaid.result.outputs[0].sha256, execute('export-flow-mermaid', { inputs: { 'flow-document': doc() } }).result.outputs[0].sha256);
});

test('exports and layout refuse an invalid document', () => {
  const partial = doc();
  partial.layout.nodes = [{ node_id: 'start', x: 0, y: 0 }];
  for (const operation of ['layout-flow-document', 'export-flow-svg', 'export-flow-mermaid']) {
    const { result, outputDir } = execute(operation, { inputs: { 'flow-document': partial } });
    assert.equal(result.status, 'failed', operation);
    assert.deepEqual(codes(result), ['invalid-document']);
    assert.ok(result.errors[0].details.errors.some((error) => error.includes('cover every node')));
    assert.ok(!fs.existsSync(outputDir));
  }
});

test('hints parameter is explicit and validated', () => {
  const withHints = doc();
  withHints.layout.nodes = withHints.nodes.map((node, index) => ({ node_id: node.node_id, x: index * 220, y: 10 }));
  const stored = execute('layout-flow-document', { inputs: { 'flow-document': withHints }, parameters: { hints: 'use-stored' } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(stored.outputDir, 'flow-layout.json'), 'utf8')).source, 'stored-hints');
  const computed = execute('layout-flow-document', { inputs: { 'flow-document': withHints } });
  assert.equal(JSON.parse(fs.readFileSync(path.join(computed.outputDir, 'flow-layout.json'), 'utf8')).source, 'computed');
  const bad = execute('layout-flow-document', { inputs: { 'flow-document': doc() }, parameters: { hints: 'maybe' } });
  assert.deepEqual(codes(bad.result), ['invalid-request']);
});

test('request checks: module, version, operation, contract, parameters, inputs and network', () => {
  const base = { inputs: { 'flow-document': doc() } };
  const cases = [
    ['wrong-module', (r) => { r.module_id = 'other-module'; }],
    ['wrong-module-version', (r) => { r.module_version = '9.9.9'; }],
    ['unknown-operation', (r) => { r.operation_id = 'send-flow'; }],
    ['unsupported-contract', (r) => { r.contract_version = '1.1.0'; }],
    ['network-not-supported', (r) => { r.grants.network_hosts = ['example.com']; }],
    ['invalid-request', (r) => { r.parameters.surprise = 1; }],
    ['invalid-request', (r) => { r.inputs = []; }],
    ['invalid-request', (r) => { delete r.limits; }],
  ];
  for (const [code, mutate] of cases) {
    const made = makeRequest('export-flow-mermaid', base);
    mutate(made.request);
    const { result } = run(made.request);
    assert.equal(result.status, 'failed', code);
    assert.equal(codes(result)[0], code);
    assert.ok(!fs.existsSync(made.outputDir));
    assert.deepEqual(schemaErrors('operation-result', result), []);
  }
  assert.equal(codes(run('not an object').result)[0], 'invalid-request');
  assert.equal(codes(run(null).result)[0], 'invalid-request');
});

test('grants: inputs must be inside a read grant and outputs inside a write grant', () => {
  const root = tmp();
  const outside = tmp();
  const made = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() }, root });
  made.request.grants.read_paths = [outside];
  assert.deepEqual(codes(run(made.request).result), ['path-outside-grant']);

  const out = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  out.request.parameters.output_dir = path.join(outside, 'out');
  assert.deepEqual(codes(run(out.request).result), ['path-outside-grant']);
  assert.ok(!fs.existsSync(path.join(outside, 'out')));

  const traversal = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  traversal.request.parameters.output_dir = `${traversal.root}/out/../../escape`;
  assert.deepEqual(codes(run(traversal.request).result), ['path-traversal']);

  const relative = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  relative.request.parameters.output_dir = 'out';
  assert.deepEqual(codes(run(relative.request).result), ['invalid-request']);
});

test('a symlink cannot lead an output or an input out of its grant', () => {
  const root = tmp();
  const outside = tmp();
  const made = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() }, root });
  fs.symlinkSync(outside, path.join(root, 'link'));
  made.request.parameters.output_dir = path.join(root, 'link', 'out');
  assert.deepEqual(codes(run(made.request).result), ['path-outside-grant']);
  assert.ok(!fs.existsSync(path.join(outside, 'out')));

  const secret = path.join(outside, 'secret.json');
  fs.writeFileSync(secret, fixtureText('campaign-approval.flow.json'));
  const input = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() }, root: tmp() });
  const link = path.join(input.inputDir, 'linked.json');
  fs.symlinkSync(secret, link);
  input.request.inputs[0].location = link;
  assert.deepEqual(codes(run(input.request).result), ['path-outside-grant']);
});

test('input integrity: size and sha256 must match the bytes parsed', () => {
  const made = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  made.request.inputs[0].sha256 = `sha256:${'0'.repeat(64)}`;
  assert.deepEqual(codes(run(made.request).result), ['input-digest-mismatch']);
  const sized = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  sized.request.inputs[0].size_bytes += 1;
  assert.deepEqual(codes(run(sized.request).result), ['input-digest-mismatch']);
  const notJson = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': 'not json' } });
  assert.deepEqual(codes(run(notJson.request).result), ['invalid-input']);
});

test('output limits and existing files are respected', () => {
  const tight = makeRequest('export-flow-svg', { inputs: { 'flow-document': doc() } });
  tight.request.limits.max_output_bytes = 10;
  assert.deepEqual(codes(run(tight.request).result), ['output-too-large']);
  assert.ok(!fs.existsSync(tight.outputDir));

  const first = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  assert.equal(run(first.request).result.status, 'review_required');
  const before = fs.readFileSync(path.join(first.outputDir, 'flow.mmd'), 'utf8');
  fs.writeFileSync(path.join(first.outputDir, 'flow.mmd'), 'keep me');
  assert.deepEqual(codes(run(first.request).result), ['output-exists']);
  assert.equal(fs.readFileSync(path.join(first.outputDir, 'flow.mmd'), 'utf8'), 'keep me');
  assert.ok(before.startsWith('flowchart'));
});

test('oversized documents are refused with a stated bound', () => {
  const document = doc();
  const nodes = [{ node_id: 'n0', kind: 'start', label: 'Start' }];
  const connections = [];
  for (let i = 1; i <= 501; i += 1) {
    nodes.push({ node_id: `n${i}`, kind: 'action', label: `S${i}` });
    connections.push({ connection_id: `c${i}`, from_node: 'n0', to_node: `n${i}` });
  }
  Object.assign(document, { nodes, connections, lanes: [] });
  for (const node of document.nodes) delete node.lane_id;
  const { result } = execute('export-flow-svg', { inputs: { 'flow-document': document } });
  assert.deepEqual(codes(result), ['document-too-large']);
});

test('no operation reads the clock for document content', () => {
  const a = execute('apply-flow-change', { inputs: { 'flow-document': doc(), 'flow-change-proposal': accepted() } });
  const b = execute('apply-flow-change', { inputs: { 'flow-document': doc(), 'flow-change-proposal': accepted() } });
  assert.equal(a.result.outputs[0].sha256, b.result.outputs[0].sha256);
});

test('inputs given to apply are not modified on disk', () => {
  const made = makeRequest('apply-flow-change', { inputs: { 'flow-document': doc(), 'flow-change-proposal': accepted() } });
  const before = made.request.inputs.map((input) => digest(fs.readFileSync(input.location)));
  run(made.request);
  const after = made.request.inputs.map((input) => digest(fs.readFileSync(input.location)));
  assert.deepEqual(after, before);
});

test('a clone of the request object is not required to be frozen or sealed', () => {
  const made = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': doc() } });
  const frozen = Object.freeze(clone(made.request));
  assert.equal(run(frozen).result.status, 'review_required');
});
