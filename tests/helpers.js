'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const m = require('../src/module');

const FIXTURES = path.join(__dirname, 'fixtures');

const clone = (value) => JSON.parse(JSON.stringify(value));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, 'forge', name), 'utf8'));
const fixtureText = (name) => fs.readFileSync(path.join(FIXTURES, 'forge', name), 'utf8');

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-document-')));
}

function digest(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** Writes `value` as an input file under `dir` and returns its operation-request artifact record. */
function inputArtifact(dir, role, value) {
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  const location = path.join(dir, `${role}.json`);
  fs.writeFileSync(location, bytes);
  return { artifact_id: role, role, media_type: 'application/json', location, sha256: digest(bytes), size_bytes: bytes.length };
}

/** A complete operation request. `inputs` maps role to a JSON value. */
function makeRequest(operation, { inputs = {}, parameters = {}, root = tmp(), overrides = {} } = {}) {
  const inputDir = path.join(root, 'in');
  fs.mkdirSync(inputDir, { recursive: true });
  const outputDir = path.join(root, 'out');
  const request = {
    schema_version: '1.0.0',
    contract_version: '1.0.0',
    request_id: 'request-test',
    module_id: m.MODULE_ID,
    module_version: m.MODULE_VERSION,
    operation_id: operation,
    created_at: '2026-11-05T12:00:00Z',
    inputs: Object.entries(inputs).map(([role, value]) => inputArtifact(inputDir, role, value)),
    parameters: { output_dir: outputDir, ...parameters },
    grants: { read_paths: [inputDir], write_paths: [root], network_hosts: [] },
    limits: { timeout_seconds: 60, max_output_bytes: 8 * 1024 * 1024 },
    ...overrides,
  };
  return { request, root, outputDir, inputDir };
}

/** A tiny XML check: tags balance, text has no stray markup and entities are known. */
function assertWellFormedXml(text, assert) {
  const stack = [];
  const token = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>|<[^>]*>|[^<]+/g;
  let match;
  while ((match = token.exec(text)) !== null) {
    const [whole, closing, name, , selfClosing] = match;
    if (whole.startsWith('<')) {
      assert.ok(name, `malformed tag: ${whole.slice(0, 60)}`);
      if (closing) assert.equal(stack.pop(), name, `unbalanced </${name}>`);
      else if (!selfClosing) stack.push(name);
    } else {
      assert.ok(!/&(?!(?:amp|lt|gt|quot|apos);)/.test(whole), `unknown entity in text: ${whole.slice(0, 60)}`);
    }
  }
  assert.deepEqual(stack, [], 'unclosed elements');
}

module.exports = { digest, clone, fixture, fixtureText, tmp, makeRequest, inputArtifact, assertWellFormedXml, FIXTURES };
