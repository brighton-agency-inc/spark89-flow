'use strict';

const fs = require('node:fs');
const path = require('node:path');
const m = require('./module');
const { resolveDependency } = require('./dependencies');
const manifest = require('./manifest');

const EXIT_CODES = { healthy: 0, degraded: 10, unhealthy: 20, incompatible: 30 };

const SAMPLE = {
  schema_version: '1.0.0',
  contract_version: '1.0.0',
  document_id: 'health-sample',
  revision: 1,
  title: 'Health sample',
  lifecycle: { state: 'active' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  provenance: { operation: 'create-flow-document', producer: 'flow-document' },
  nodes: [
    { node_id: 'begin', kind: 'start', label: 'Begin' },
    { node_id: 'check', kind: 'decision', label: 'Ready?' },
    { node_id: 'done', kind: 'end', label: 'Done' },
    { node_id: 'again', kind: 'action', label: 'Try again' },
  ],
  connections: [
    { connection_id: 'begin-check', from_node: 'begin', to_node: 'check' },
    { connection_id: 'check-done', from_node: 'check', to_node: 'done', label: 'Yes' },
    { connection_id: 'check-again', from_node: 'check', to_node: 'again', label: 'No' },
    { connection_id: 'again-check', from_node: 'again', to_node: 'check' },
  ],
  lanes: [],
  layout: { direction: 'top-down' },
};

function timed(checkId, body) {
  const started = process.hrtime.bigint();
  let outcome;
  try {
    outcome = body();
  } catch (error) {
    outcome = { status: 'failed', message: error && error.message ? error.message : String(error) };
  }
  return { check_id: checkId, ...outcome, duration_ms: Number((process.hrtime.bigint() - started) / 1_000_000n) };
}

function installedVersion(name) {
  const main = resolveDependency(name);
  let dir = path.dirname(main);
  for (let depth = 0; depth < 6; depth += 1) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.name === name) return data.version;
    }
    dir = path.dirname(dir);
  }
  throw new Error(`cannot find the package record for ${name}`);
}

/** Builds a health result. Nothing here touches the network or reads credentials. */
function build() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push(timed('node-runtime', () => (nodeMajor === m.NODE_MAJOR
    ? { status: 'passed', message: `Node ${process.versions.node} satisfies ${m.NODE_VERSION_CONSTRAINT}` }
    : { status: 'failed', message: `Node ${process.versions.node} does not satisfy ${m.NODE_VERSION_CONSTRAINT}` })));

  checks.push(timed('locked-dependencies', () => {
    const problems = [];
    for (const [name, wanted] of Object.entries(m.DEPENDENCIES)) {
      try {
        const found = installedVersion(name);
        if (found !== wanted) problems.push(`${name} ${found} is installed; package.json pins ${wanted}`);
      } catch (error) {
        problems.push(`${name} is not available: ${error.message}`);
      }
    }
    return problems.length
      ? { status: 'failed', message: problems.join('; ') }
      : { status: 'passed', message: `${Object.keys(m.DEPENDENCIES).length} direct dependencies match their pinned versions` };
  }));

  checks.push(timed('forge-contracts', () => {
    const { verifyVendoredContracts, schemaErrors } = require('./contracts');
    const { problems, source } = verifyVendoredContracts();
    if (problems.length) return { status: 'failed', message: problems.join('; ') };
    const sample = schemaErrors('flow-document', SAMPLE);
    if (sample.length) return { status: 'failed', message: `the sample document does not match the contract: ${sample.join('; ')}` };
    return { status: 'passed', message: `vendored contracts match Forge revision ${source.forge_contract_revision}` };
  }));

  checks.push(timed('layout-and-export', () => {
    const { layoutDocument } = require('./layout');
    const { toSvg } = require('./svg');
    const { toMermaid } = require('./mermaid');
    const first = toSvg(SAMPLE).svg;
    const second = toSvg(JSON.parse(JSON.stringify(SAMPLE))).svg;
    const layout = layoutDocument(SAMPLE);
    const negative = layout.nodes.some((node) => node.x < 0 || node.y < 0);
    if (first !== second) return { status: 'failed', message: 'SVG output is not deterministic' };
    if (negative) return { status: 'failed', message: 'layout produced a negative coordinate' };
    if (toMermaid(SAMPLE) !== toMermaid(JSON.parse(JSON.stringify(SAMPLE)))) return { status: 'failed', message: 'Mermaid output is not deterministic' };
    return { status: 'passed', message: `layout and export are deterministic with @dagrejs/dagre ${layout.engine.version}` };
  }));

  checks.push(timed('module-revision', () => {
    try {
      const { revision, dirty } = manifest.currentRevision();
      return dirty
        ? { status: 'warned', message: `module revision ${revision} has uncommitted changes` }
        : { status: 'passed', message: `module revision ${revision}` };
    } catch (error) {
      return { status: 'warned', message: `module revision is unavailable: ${error.message}` };
    }
  }));

  const failed = checks.filter((check) => check.status === 'failed');
  let status = 'healthy';
  if (failed.some((check) => check.check_id === 'node-runtime')) status = 'incompatible';
  else if (failed.length) status = 'unhealthy';
  return {
    schema_version: m.SCHEMA_VERSION,
    contract_version: m.CONTRACT_VERSION,
    module_id: m.MODULE_ID,
    module_version: m.MODULE_VERSION,
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    status,
    checks,
    errors: failed.map((check) => ({ code: `${check.check_id}-failed`, message: check.message, retryable: false, stage: 'health' })),
  };
}

module.exports = { build, EXIT_CODES, SAMPLE };
