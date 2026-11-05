'use strict';

// Module manifest (module-manifest schema_version and contract_version 1.1.0).
//
// The manifest is generated, not committed, because `module.revision` must name the commit it
// describes and a file inside that commit cannot contain it. `forge_adapter.js manifest` stamps the
// exact full Git HEAD of a clean checkout and refuses a working tree with uncommitted changes
// (Forge decision-log item 15). Callers cannot supply or override the revision. `--allow-dirty` is
// diagnostic only: its output carries the `uncommitted-changes` limitation, is not a contract
// manifest and is never installable or releasable.

const { execFileSync } = require('node:child_process');
const m = require('./module');
const { OPERATIONS } = require('./operations');

const OPERATION_DETAILS = {
  'create-flow-document': ['Create flow document', 'Validate a structured creation request and return a revision 1 flow document.'],
  'validate-flow-document': ['Validate flow document', 'Report structural errors and draft warnings for a flow document without changing it.'],
  'validate-flow-proposal': ['Validate flow proposal', 'Check a change proposal against a document revision and report whether it can be applied.'],
  'apply-flow-change': ['Apply flow change', 'Apply an accepted proposal that matches the current revision and return the next revision.'],
  'layout-flow-document': ['Lay out flow document', 'Return deterministic node positions and edge routes for a flow document.'],
  'export-flow-svg': ['Export flow as SVG', 'Draw a flow document as deterministic SVG without a browser.'],
  'export-flow-mermaid': ['Export flow as Mermaid', 'Write Mermaid flowchart source for a flow document.'],
};

// Dependency and module-file bytes of a development checkout, rounded up. The Node runtime comes
// from the Forge runtime store and is not counted. See the resource-estimates-provisional limitation.
const INSTALLED_BYTES = 3_600_000;
const DOWNLOAD_BYTES = 3_600_000;
const MEMORY_BYTES = 268_435_456;

const LIMITATIONS = [
  ['output-unverified', 'Direct output of this module is unverified evidence. Only a code-enforced Forge workflow may issue a Verification Manifest; this module never issues one and records no human approval.', 'verification_blocking'],
  ['lanes-not-drawn', 'Lanes are validated and preserved in the document but are not drawn in SVG or exported to Mermaid.', 'informational'],
  ['document-size-bounded', `Documents are limited to ${m.MAX_NODES} nodes, ${m.MAX_CONNECTIONS} connections and ${m.MAX_INPUT_BYTES} bytes of input.`, 'informational'],
  ['forge-admission-pending', 'The module is not admitted to the Forge catalog and has no signed bundle. Forge installs dependencies from package-lock.json with the Forge-managed Node runtime.', 'informational'],
  ['resource-estimates-provisional', 'Resource figures are estimates for a development checkout and exclude the Node runtime. Memory was observed on one macOS arm64 run and is not enforced by the module.', 'informational'],
  ['single-platform-exercised', 'The code is portable JavaScript, but only macOS arm64 with Node 24 has been exercised.', 'informational'],
];

function git(...args) {
  return execFileSync('git', args, { cwd: m.MODULE_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

class ManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function currentRevision() {
  let top;
  try {
    top = git('rev-parse', '--show-toplevel');
  } catch (error) {
    if (error.code === 'ENOENT') throw new ManifestError('git-unavailable', 'git is not available');
    throw new ManifestError('not-a-git-checkout', 'the module is not a Git checkout');
  }
  if (require('node:fs').realpathSync(top) !== require('node:fs').realpathSync(m.MODULE_ROOT)) throw new ManifestError('not-a-git-checkout', 'the module root is not the top level of a Git checkout');
  let revision;
  try {
    revision = git('rev-parse', '--verify', 'HEAD');
  } catch (_) {
    throw new ManifestError('no-commit', 'the module has no committed HEAD');
  }
  const dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
  return { revision, dirty };
}

function build(revision, { dirty = false } = {}) {
  const limitations = LIMITATIONS.map(([code, description, impact]) => ({ code, description, impact }));
  if (dirty) {
    limitations.push({
      code: 'uncommitted-changes',
      description: 'Diagnostic record from a working tree with uncommitted changes. It is not a contract manifest and is not installable or releasable.',
      impact: 'verification_blocking',
    });
  }
  return {
    schema_version: m.MANIFEST_VERSION,
    contract_version: m.MANIFEST_VERSION,
    module: {
      id: m.MODULE_ID,
      display_name: 'Flow Document',
      version: m.MODULE_VERSION,
      maturity: 'development',
      description: 'Validate, apply changes to, lay out and export flow documents as deterministic SVG and Mermaid.',
      repository: m.REPOSITORY,
      revision,
    },
    platforms: [{ os: 'macos', architecture: 'arm64', minimum_os_version: '14.0' }],
    media: { inputs: ['application/json'], outputs: ['application/json', 'image/svg+xml', 'text/plain'] },
    runtime: {
      strategy: 'forge_managed',
      interpreters: [{ id: 'node', kind: 'node', version_constraint: m.NODE_VERSION_CONSTRAINT, dependency_manifest: 'package.json', dependency_lock: 'package-lock.json' }],
      components: [{ id: 'node', version: m.NODE_VERSION_CONSTRAINT, source: 'forge_runtime_store' }],
      resources: { download_bytes: DOWNLOAD_BYTES, installed_bytes: INSTALLED_BYTES, memory_bytes: MEMORY_BYTES, gpu_required: false },
    },
    operations: Object.keys(OPERATIONS).map((id) => ({
      id,
      display_name: OPERATION_DETAILS[id][0],
      description: OPERATION_DETAILS[id][1],
      entrypoint: { interpreter: 'node', script: 'forge_adapter.js', arguments: ['run'], working_directory: '.' },
      input_contract: 'forge.operation-request@1.0.0',
      output_contract: 'forge.operation-result@1.0.0',
      timeout_seconds: 60,
      supports_cancellation: false,
      permissions: { network: 'none', read_scopes: ['declared_inputs', 'module_runtime'], write_scopes: ['declared_outputs'] },
    })),
    health: { entrypoint: { interpreter: 'node', script: 'forge_adapter.js', arguments: ['health'], working_directory: '.' }, timeout_seconds: 60 },
    connectors: { mcp: false, skill_guidance: false },
    limitations,
  };
}

module.exports = { build, currentRevision, ManifestError };
