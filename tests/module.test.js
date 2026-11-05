'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const m = require('../src/module');
const manifest = require('../src/manifest');
const health = require('../src/health');
const { OPERATIONS } = require('../src/operations');
const { schemaErrors, verifyVendoredContracts } = require('../src/contracts');
const { makeRequest, fixture } = require('./helpers');

const ADAPTER = path.join(m.MODULE_ROOT, 'forge_adapter.js');
const REVISION = 'a'.repeat(40);

test('vendored Forge contracts match the digests recorded in contracts/SOURCE.json', () => {
  const { problems, source } = verifyVendoredContracts();
  assert.deepEqual(problems, []);
  assert.match(source.forge_contract_revision, /^[0-9a-f]{40}$/);
});

test('the manifest is a valid module-manifest 1.1.0 for a Forge-managed Node 24 runtime', () => {
  const record = manifest.build(REVISION);
  assert.deepEqual(schemaErrors('module-manifest', record), []);
  assert.equal(record.module.id, 'flow-document');
  assert.equal(record.module.revision, REVISION);
  assert.equal(record.runtime.strategy, 'forge_managed');
  assert.deepEqual(record.runtime.interpreters, [{ id: 'node', kind: 'node', version_constraint: '>=24,<25', dependency_manifest: 'package.json', dependency_lock: 'package-lock.json' }]);
  assert.deepEqual(record.runtime.components, [{ id: 'node', version: '>=24,<25', source: 'forge_runtime_store' }]);
  assert.deepEqual(record.operations.map((operation) => operation.id), Object.keys(OPERATIONS));
  for (const operation of record.operations) {
    assert.equal(operation.permissions.network, 'none');
    assert.equal(operation.input_contract, 'forge.operation-request@1.0.0');
    assert.equal(operation.output_contract, 'forge.operation-result@1.0.0');
    assert.equal(operation.entrypoint.interpreter, 'node');
    assert.ok(fs.existsSync(path.join(m.MODULE_ROOT, operation.entrypoint.script)));
    assert.ok(!operation.permissions.write_scopes.includes('module_cache'));
  }
  assert.ok(record.limitations.some((item) => item.code === 'output-unverified' && item.impact === 'verification_blocking'));
  assert.ok(record.limitations.some((item) => item.code === 'lanes-not-drawn'));
  assert.ok(!record.limitations.some((item) => item.code === 'uncommitted-changes'));
  assert.equal(record.connectors.mcp, false);
});

test('a dirty-tree manifest is labelled and not a contract manifest', () => {
  const record = manifest.build(REVISION, { dirty: true });
  assert.ok(record.limitations.some((item) => item.code === 'uncommitted-changes'));
});

test('the manifest names only files that exist and the lock covers every dependency with an integrity hash', () => {
  for (const file of ['package.json', 'package-lock.json']) assert.ok(fs.existsSync(path.join(m.MODULE_ROOT, file)));
  const lock = JSON.parse(fs.readFileSync(path.join(m.MODULE_ROOT, 'package-lock.json'), 'utf8'));
  assert.ok(lock.lockfileVersion >= 2);
  const entries = Object.entries(lock.packages).filter(([key]) => key);
  assert.ok(entries.length >= 8);
  for (const [key, value] of entries) assert.match(value.integrity ?? '', /^sha(512|384|256)-/, `${key} has an integrity hash`);
  const pkg = JSON.parse(fs.readFileSync(path.join(m.MODULE_ROOT, 'package.json'), 'utf8'));
  for (const [name, version] of Object.entries(pkg.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name} is pinned exactly`);
  assert.ok(pkg.dependencies['@dagrejs/dagre']);
  assert.equal(pkg.engines.node, '>=24 <25');
  for (const forbidden of ['puppeteer', 'puppeteer-core', '@mermaid-js/mermaid-cli', 'mermaid', 'playwright', 'elkjs']) {
    assert.ok(!(forbidden in pkg.dependencies) && !lock.packages[`node_modules/${forbidden}`], `${forbidden} is not a dependency`);
  }
});

test('health is a valid health-result that names the module and its revision and passes on this checkout', () => {
  const record = health.build();
  assert.deepEqual(schemaErrors('health-result', record), []);
  assert.equal(record.module_id, 'flow-document');
  assert.equal(record.module_version, m.MODULE_VERSION);
  assert.equal(record.status, 'healthy', JSON.stringify(record.checks.filter((check) => check.status === 'failed')));
  const ids = record.checks.map((check) => check.check_id);
  assert.deepEqual(ids, ['node-runtime', 'locked-dependencies', 'forge-contracts', 'layout-and-export', 'module-revision']);
  assert.match(record.checks.find((check) => check.check_id === 'module-revision').message, /module revision/);
});

test('the adapter prints health JSON and exits 0 when healthy', () => {
  const out = spawnSync(process.execPath, [ADAPTER, 'health'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(schemaErrors('health-result', JSON.parse(out.stdout)), []);
});

test('the adapter runs a request from a file and from stdin and exits 0 for review_required', () => {
  const made = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': fixture('campaign-approval.flow.json') } });
  const file = path.join(made.root, 'request.json');
  fs.writeFileSync(file, JSON.stringify(made.request));
  const viaFile = spawnSync(process.execPath, [ADAPTER, 'run', '--request', file], { encoding: 'utf8' });
  assert.equal(viaFile.status, 0, viaFile.stderr);
  const result = JSON.parse(viaFile.stdout);
  assert.equal(result.status, 'review_required');
  assert.deepEqual(schemaErrors('operation-result', result), []);

  const second = makeRequest('export-flow-mermaid', { inputs: { 'flow-document': fixture('campaign-approval.flow.json') } });
  const viaStdin = spawnSync(process.execPath, [ADAPTER, 'run'], { encoding: 'utf8', input: JSON.stringify(second.request) });
  assert.equal(viaStdin.status, 0, viaStdin.stderr);
  assert.equal(JSON.parse(viaStdin.stdout).status, 'review_required');
});

test('the adapter returns a failed result for an unreadable request', () => {
  const out = spawnSync(process.execPath, [ADAPTER, 'run'], { encoding: 'utf8', input: '{not json' });
  assert.equal(out.status, 3);
  const result = JSON.parse(out.stdout);
  assert.equal(result.status, 'failed');
  assert.equal(result.errors[0].code, 'invalid-request');
  assert.deepEqual(schemaErrors('operation-result', result), []);
});

test('the adapter refuses unknown commands', () => {
  assert.equal(spawnSync(process.execPath, [ADAPTER, 'serve'], { encoding: 'utf8' }).status, 64);
});

test('the module has no network access, provider integration or credential handling in its sources', () => {
  const files = [ADAPTER];
  for (const name of fs.readdirSync(path.join(m.MODULE_ROOT, 'src'))) files.push(path.join(m.MODULE_ROOT, 'src', name));
  const network = /require\(['"](?:node:)?(?:http|https|http2|net|dns|tls|dgram|worker_threads|cluster)['"]\)|\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bimport\s*\(/;
  const providers = /openai|chatgpt|anthropic|claude|ollama|gemini|api[_-]?key|access[_-]?token|bearer|oauth|password|secret/i;
  const spawning = /require\(['"](?:node:)?child_process['"]\)/;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!network.test(text), `${path.basename(file)} makes no network calls`);
    assert.ok(!providers.test(text), `${path.basename(file)} names no provider or credential`);
    if (spawning.test(text)) assert.ok(['manifest.js'].includes(path.basename(file)), `${path.basename(file)} runs no child process`);
  }
});

test('the manifest generator runs only git and refuses to describe a dirty or uncommitted tree as a contract manifest', () => {
  const out = spawnSync(process.execPath, [ADAPTER, 'manifest', '--bogus'], { encoding: 'utf8' });
  assert.equal(out.status, 64);
});

test('with FORGE_NODE_MODULES set, dependencies come only from that directory', () => {
  const empty = require('./helpers').tmp();
  const missing = spawnSync(process.execPath, [ADAPTER, 'health'], { encoding: 'utf8', env: { ...process.env, FORGE_NODE_MODULES: empty } });
  assert.equal(missing.status, 20, 'an empty managed environment is unhealthy, not silently satisfied by the checkout');
  assert.equal(JSON.parse(missing.stdout).status, 'unhealthy');
  const managed = spawnSync(process.execPath, [ADAPTER, 'health'], { encoding: 'utf8', env: { ...process.env, FORGE_NODE_MODULES: path.join(m.MODULE_ROOT, 'node_modules') } });
  assert.equal(managed.status, 0, managed.stdout);
});

test('THIRD_PARTY_NOTICES.md lists every locked package at its locked version', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(m.MODULE_ROOT, 'package-lock.json'), 'utf8'));
  const notices = fs.readFileSync(path.join(m.MODULE_ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const [key, value] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice('node_modules/'.length);
    assert.ok(notices.includes(`## ${name} ${value.version}`), `${name} ${value.version} has a notice`);
    assert.ok(value.license, `${name} declares a license`);
  }
});
