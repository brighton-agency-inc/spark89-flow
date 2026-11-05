'use strict';

// Forge operation adapter. One operation request (operation-request 1.0.0) in, one operation result
// (operation-result 1.0.0) out. Requests are checked before anything is read or written:
//
// - the request validates against the vendored Forge schema and names this module, its version, a
//   known operation and contract 1.0;
// - no network host is granted (the module declares network: none and makes no network calls);
// - every path is absolute, has no '..' segment and is compared after resolving symlinks: inputs
//   must sit inside a read grant and output_dir inside a write grant;
// - declared input size and SHA-256 equal the bytes that are parsed.
//
// Results never report `succeeded`. A completed operation returns `review_required` with a
// verification-blocking `output-unverified` omission, which the Forge schema makes incompatible
// with `succeeded`. This module issues no verification claim and records no human approval.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { schemaErrors } = require('./contracts');
const { evaluateProposal } = require('./apply');
const { validateDocument, documentErrors, proposalErrors } = require('./validate');
const { layoutDocument } = require('./layout');
const { toSvg } = require('./svg');
const { toMermaid } = require('./mermaid');
const { IDENTIFIER } = require('./ids');
const m = require('./module');

const OPERATIONS = {
  'create-flow-document': { inputs: [], params: ['output_dir', 'document_id', 'title', 'description', 'direction', 'nodes', 'connections', 'lanes', 'producer', 'provider', 'model'] },
  'validate-flow-document': { inputs: ['flow-document'], params: ['output_dir'] },
  'validate-flow-proposal': { inputs: ['flow-document', 'flow-change-proposal'], params: ['output_dir'] },
  'apply-flow-change': { inputs: ['flow-document', 'flow-change-proposal'], params: ['output_dir', 'producer', 'provider', 'model'] },
  'layout-flow-document': { inputs: ['flow-document'], params: ['output_dir', 'hints'] },
  'export-flow-svg': { inputs: ['flow-document'], params: ['output_dir', 'hints'] },
  'export-flow-mermaid': { inputs: ['flow-document'], params: ['output_dir'] },
};

const UNVERIFIED = {
  code: 'output-unverified',
  description: 'Direct module output is unverified. It is not human approval and not a Forge verification claim; only a code-enforced Forge workflow may issue a Verification Manifest.',
  impact: 'verification_blocking',
};
const LANES_NOT_DRAWN = {
  code: 'lanes-not-drawn',
  description: 'The flow has lanes. The first release does not draw or export them; lane assignments stay in the document.',
  impact: 'informational',
};
const LIMITS_NOT_ENFORCED = {
  code: 'limits-not-enforced',
  description: 'limits.timeout_seconds and limits.max_memory_bytes are enforced by Forge, not by this module. Input and output size are bounded by the module.',
  impact: 'informational',
};

class Rejected extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const sha256 = (bytes) => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function absolutePath(raw, label) {
  if (typeof raw !== 'string' || !raw) throw new Rejected('invalid-request', `${label} must be a non-empty path string`);
  if (raw.split(/[\\/]/).includes('..')) throw new Rejected('path-traversal', `${label} contains a '..' segment`);
  if (!path.isAbsolute(raw)) throw new Rejected('invalid-request', `${label} must be an absolute path`);
  return raw;
}

const within = (target, roots) => roots.some((root) => target === root || target.startsWith(root + path.sep));

function resolveGrants(list, label, directoriesOnly) {
  return list.map((raw, index) => {
    const full = absolutePath(raw, `grants.${label}[${index}]`);
    let resolved;
    try {
      resolved = fs.realpathSync(full);
    } catch (_) {
      throw new Rejected('grant-not-found', `grants.${label}[${index}] does not exist`);
    }
    if (directoriesOnly && !fs.statSync(resolved).isDirectory()) throw new Rejected('invalid-request', `grants.${label}[${index}] is not a directory`);
    return resolved;
  });
}

function readInput(artifact, readRoots) {
  const full = absolutePath(artifact.location, `input '${artifact.artifact_id}' location`);
  let resolved;
  try {
    resolved = fs.realpathSync(full);
  } catch (_) {
    throw new Rejected('input-not-found', `input '${artifact.artifact_id}' does not exist`);
  }
  if (!within(resolved, readRoots)) throw new Rejected('path-outside-grant', `input '${artifact.artifact_id}' is outside the read grants`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Rejected('invalid-request', `input '${artifact.artifact_id}' is not a file`);
  if (stat.size > m.MAX_INPUT_BYTES) throw new Rejected('input-too-large', `input '${artifact.artifact_id}' exceeds ${m.MAX_INPUT_BYTES} bytes`);
  const bytes = fs.readFileSync(resolved);
  if (bytes.length !== artifact.size_bytes || sha256(bytes) !== artifact.sha256) {
    throw new Rejected('input-digest-mismatch', `input '${artifact.artifact_id}' does not match its declared size and sha256`);
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Rejected('invalid-input', `input '${artifact.artifact_id}' is not UTF-8 JSON: ${error.message}`);
  }
  return value;
}

function outputDirectory(raw, writeRoots) {
  const full = absolutePath(raw, 'parameters.output_dir');
  // Resolve through the nearest existing ancestor so a symlink cannot lead out of the grant.
  const missing = [];
  let current = full;
  while (!fs.existsSync(current)) {
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Rejected('path-outside-grant', 'output_dir passes through a dangling symlink');
    missing.push(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolved = path.join(fs.realpathSync(current), ...missing.reverse());
  if (!within(resolved, writeRoots)) throw new Rejected('path-outside-grant', 'output_dir is outside the write grants');
  return resolved;
}

function describeFiles(files) {
  return files.map((file) => {
    const bytes = Buffer.from(file.content, 'utf8');
    return { ...file, bytes, sha256: sha256(bytes) };
  });
}

// Writes each file without replacing an existing one: a temporary file is linked into place, and
// linking fails if the name is taken.
function writeFiles(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  for (const file of files) {
    if (fs.existsSync(path.join(directory, file.name))) throw new Rejected('output-exists', `'${file.name}' already exists in output_dir`);
  }
  const written = [];
  try {
    for (const file of files) {
      const target = path.join(directory, file.name);
      const temporary = path.join(directory, `.${file.name}.${process.pid}.tmp`);
      fs.writeFileSync(temporary, file.bytes, { flag: 'wx' });
      try {
        fs.linkSync(temporary, target);
        written.push(target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
  } catch (error) {
    for (const target of written) fs.rmSync(target, { force: true });
    if (error instanceof Rejected) throw error;
    throw new Rejected('output-write-failed', `cannot write output: ${error.message}`);
  }
}

const pretty = (value) => `${JSON.stringify(value, null, 2)}\n`;

function checkSize(document) {
  if (document.nodes.length > m.MAX_NODES || document.connections.length > m.MAX_CONNECTIONS) {
    throw new Rejected('document-too-large', `the module handles at most ${m.MAX_NODES} nodes and ${m.MAX_CONNECTIONS} connections`);
  }
}

function requireValidDocument(document) {
  const errors = documentErrors(document);
  if (errors.length) throw new Rejected('invalid-document', 'the flow document is invalid', { errors });
  checkSize(document);
}

const REFUSAL_CODES = [
  ['base_revision', 'proposal-stale'],
  ['document_id does not match', 'document-mismatch'],
  ['archived documents may only', 'archived-document'],
  ['only an accepted proposal', 'proposal-not-accepted'],
  ['records validation errors', 'invalid-proposal'],
  ['validation.valid must equal', 'invalid-proposal'],
  ['base document is invalid', 'invalid-document'],
];

function refusalCode(errors) {
  for (const [needle, code] of REFUSAL_CODES) if (errors.some((error) => error.includes(needle))) return code;
  return errors.some((error) => error.startsWith('/')) ? 'invalid-proposal' : 'proposal-refused';
}

function validationReport({ subject, document, valid, errors, warnings, extra }) {
  return {
    record: 'flow-validation-report',
    version: '1.0.0',
    verification_state: 'unverified',
    subject,
    document_id: document?.document_id ?? null,
    document_revision: document?.revision ?? null,
    valid,
    errors,
    warnings,
    ...extra,
  };
}

function textParameter(parameters, name, pattern) {
  const value = parameters[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || (pattern && !pattern.test(value))) throw new Rejected('invalid-request', `parameters.${name} is not valid`);
  return value;
}

function hintsParameter(parameters) {
  const value = parameters.hints ?? 'recompute';
  if (value !== 'recompute' && value !== 'use-stored') throw new Rejected('invalid-request', "parameters.hints must be 'recompute' or 'use-stored'");
  return value;
}

function provenanceParameters(parameters) {
  return {
    producer: textParameter(parameters, 'producer', IDENTIFIER),
    provider: textParameter(parameters, 'provider', IDENTIFIER),
    model: textParameter(parameters, 'model'),
  };
}

// Each handler returns { status?, files, omissions, errors, metrics }. `files` are written only when
// the handler finishes, so a refused request leaves output_dir untouched.
const HANDLERS = {
  'create-flow-document'({ parameters, request }) {
    const { producer = 'ember', provider, model } = provenanceParameters(parameters);
    const document = {
      schema_version: m.SCHEMA_VERSION,
      contract_version: m.CONTRACT_VERSION,
      document_id: parameters.document_id,
      revision: 1,
      title: parameters.title,
      ...(parameters.description === undefined ? {} : { description: parameters.description }),
      lifecycle: { state: 'active' },
      created_at: request.created_at,
      updated_at: request.created_at,
      provenance: { operation: 'create-flow-document', producer, ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) },
      nodes: parameters.nodes,
      connections: parameters.connections ?? [],
      lanes: parameters.lanes ?? [],
      layout: { direction: parameters.direction ?? 'top-down' },
    };
    const result = validateDocument(document);
    if (!result.valid) throw new Rejected('invalid-document', 'the creation request does not make a valid flow document', { errors: result.errors });
    checkSize(document);
    return {
      files: [{ artifact_id: 'flow-document', role: 'flow-document', name: 'flow-document.json', media_type: 'application/json', content: pretty(document) }],
      omissions: result.warnings.length ? [{ code: 'draft-warnings', description: result.warnings.join('; '), impact: 'review_required' }] : [],
      metrics: { nodes: document.nodes.length, connections: document.connections.length, revision: 1 },
    };
  },

  'validate-flow-document'({ documents }) {
    const document = documents['flow-document'];
    const result = validateDocument(document);
    const files = [{ artifact_id: 'validation-report', role: 'validation-report', name: 'validation-report.json', media_type: 'application/json', content: pretty(validationReport({ subject: 'flow-document', document: result.errors.length ? safeIdentity(document) : document, ...result, extra: {} })) }];
    return { files, omissions: result.valid ? [] : [invalidInput('the flow document has validation errors')], metrics: { errors: result.errors.length, warnings: result.warnings.length } };
  },

  'validate-flow-proposal'({ documents, now }) {
    const document = documents['flow-document'];
    const proposal = documents['flow-change-proposal'];
    const named = proposal !== null && typeof proposal === 'object' ? proposal : {};
    const outcome = evaluateProposal(document, proposal, { now, requireAccepted: false });
    const errors = outcome.errors;
    const report = validationReport({
      subject: 'flow-change-proposal',
      document: safeIdentity(document),
      valid: outcome.ok,
      errors,
      warnings: outcome.warnings,
      extra: { proposal_id: named.proposal_id ?? null, proposal_status: named.status ?? null, base_revision: named.base_revision ?? null, resulting_revision: outcome.ok ? outcome.document.revision : null },
    });
    return {
      files: [{ artifact_id: 'validation-report', role: 'validation-report', name: 'validation-report.json', media_type: 'application/json', content: pretty(report) }],
      omissions: outcome.ok ? [] : [invalidInput('the proposal cannot be applied to the document as given')],
      metrics: { errors: errors.length, warnings: outcome.warnings.length },
    };
  },

  'apply-flow-change'({ documents, parameters, now }) {
    const document = documents['flow-document'];
    const proposal = documents['flow-change-proposal'];
    const outcome = evaluateProposal(document, proposal, { now, requireAccepted: true, provenance: provenanceParameters(parameters) });
    if (!outcome.ok) throw new Rejected(refusalCode(outcome.errors), 'the proposal was refused and the document was not changed', { errors: outcome.errors });
    checkSize(outcome.document);
    return {
      files: [{ artifact_id: 'flow-document', role: 'flow-document', name: 'flow-document.json', media_type: 'application/json', content: pretty(outcome.document) }],
      omissions: outcome.warnings.length ? [{ code: 'apply-notes', description: outcome.warnings.join('; '), impact: 'review_required' }] : [],
      metrics: { nodes: outcome.document.nodes.length, connections: outcome.document.connections.length, revision: outcome.document.revision },
    };
  },

  'layout-flow-document'({ documents, parameters }) {
    const document = documents['flow-document'];
    requireValidDocument(document);
    const layout = layoutDocument(document, { hints: hintsParameter(parameters) });
    const record = {
      record: 'flow-layout',
      version: '1.0.0',
      verification_state: 'unverified',
      document_id: document.document_id,
      document_revision: document.revision,
      source: layout.source,
      direction: layout.direction,
      engine: layout.engine,
      width: layout.width,
      height: layout.height,
      layout_hints: layout.hints,
      nodes: layout.nodes.map(({ node_id, shape, x, y, width, height }) => ({ node_id, shape, x, y, width, height })),
      edges: layout.edges.map((edge) => ({ connection_id: edge.connection_id, points: edge.points.map((p) => [p.x, p.y]), label: edge.label ? { x: edge.label.x, y: edge.label.y, width: edge.label.width, height: edge.label.height } : null })),
      warnings: layout.warnings,
    };
    return {
      files: [{ artifact_id: 'layout', role: 'flow-layout', name: 'flow-layout.json', media_type: 'application/json', content: pretty(record) }],
      omissions: document.lanes.length ? [LANES_NOT_DRAWN] : [],
      metrics: { nodes: layout.nodes.length, width: layout.width, height: layout.height },
    };
  },

  'export-flow-svg'({ documents, parameters }) {
    const document = documents['flow-document'];
    requireValidDocument(document);
    const { svg, layout } = toSvg(document, { hints: hintsParameter(parameters) });
    return {
      files: [{ artifact_id: 'svg', role: 'flow-svg', name: 'flow.svg', media_type: 'image/svg+xml', content: svg, width: layout.width, height: layout.height }],
      omissions: document.lanes.length ? [LANES_NOT_DRAWN] : [],
      metrics: { nodes: layout.nodes.length, width: layout.width, height: layout.height },
    };
  },

  'export-flow-mermaid'({ documents }) {
    const document = documents['flow-document'];
    requireValidDocument(document);
    return {
      files: [{ artifact_id: 'mermaid', role: 'flow-mermaid', name: 'flow.mmd', media_type: 'text/plain', content: toMermaid(document) }],
      omissions: document.lanes.length ? [LANES_NOT_DRAWN] : [],
      metrics: { nodes: document.nodes.length, connections: document.connections.length },
    };
  },
};

function invalidInput(description) {
  return { code: 'input-invalid', description, impact: 'review_required' };
}

// Identity of a document that may have failed validation, without trusting its shape.
function safeIdentity(document) {
  const id = document && typeof document === 'object' ? document.document_id : undefined;
  const revision = document && typeof document === 'object' ? document.revision : undefined;
  return { document_id: typeof id === 'string' ? id : null, revision: Number.isInteger(revision) ? revision : null };
}

function result(request, { status, startedAt, completedAt, outputs = [], omissions = [], errors = [], metrics }) {
  return {
    schema_version: m.SCHEMA_VERSION,
    contract_version: m.CONTRACT_VERSION,
    request_id: typeof request?.request_id === 'string' && IDENTIFIER.test(request.request_id) ? request.request_id : 'unknown-request',
    run_id: `run-${crypto.randomBytes(6).toString('hex')}`,
    module_id: m.MODULE_ID,
    module_version: m.MODULE_VERSION,
    operation_id: typeof request?.operation_id === 'string' && IDENTIFIER.test(request.operation_id) ? request.operation_id : 'unknown-operation',
    status,
    started_at: startedAt,
    completed_at: completedAt,
    outputs,
    evidence: [],
    omissions,
    errors,
    ...(metrics ? { metrics } : {}),
  };
}

function failure(request, code, message, startedAt, clock, details, status = 'failed') {
  return result(request, {
    status,
    startedAt,
    completedAt: clock(),
    omissions: [UNVERIFIED],
    errors: [{ code, message, retryable: false, stage: 'operation', ...(details ? { details } : {}) }],
  });
}

/**
 * Runs one operation request. Returns { result, exitCode }. `clock` supplies timestamps for the
 * result only; documents take their timestamps from `request.created_at`.
 */
function run(request, { clock = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') } = {}) {
  const startedAt = clock();
  const fail = (code, message, details) => ({ result: failure(request, code, message, startedAt, clock, details), exitCode: 3 });
  try {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Rejected('invalid-request', 'the request is not a JSON object');
    const problems = schemaErrors('operation-request', request);
    if (problems.length) throw new Rejected('invalid-request', 'the request does not match operation-request 1.0.0', { errors: problems });
    if (request.module_id !== m.MODULE_ID) throw new Rejected('wrong-module', `module_id must be '${m.MODULE_ID}'`);
    if (request.module_version !== m.MODULE_VERSION) throw new Rejected('wrong-module-version', `module_version must be '${m.MODULE_VERSION}'`);
    const [major, minor] = request.contract_version.split('.');
    if (major !== '1' || minor !== '0') throw new Rejected('unsupported-contract', 'contract_version must be 1.0.x');
    const spec = OPERATIONS[request.operation_id];
    if (!spec) throw new Rejected('unknown-operation', `operation '${request.operation_id}' is not provided by this module`);
    if (request.grants.network_hosts.length) throw new Rejected('network-not-supported', 'this module declares network: none and cannot be granted network hosts');

    const parameters = request.parameters ?? {};
    for (const name of Object.keys(parameters)) if (!spec.params.includes(name)) throw new Rejected('invalid-request', `parameter '${name}' is not accepted by ${request.operation_id}`);
    const roles = request.inputs.map((input) => input.role);
    if (roles.length !== spec.inputs.length || spec.inputs.some((role) => !roles.includes(role)) || new Set(roles).size !== roles.length) {
      throw new Rejected('invalid-request', `${request.operation_id} takes exactly these inputs by role: ${spec.inputs.join(', ') || 'none'}`);
    }

    const readRoots = resolveGrants(request.grants.read_paths, 'read_paths', false);
    const writeRoots = resolveGrants(request.grants.write_paths, 'write_paths', true);
    const documents = {};
    for (const input of request.inputs) documents[input.role] = readInput(input, readRoots);
    const directory = outputDirectory(parameters.output_dir, writeRoots);

    const outcome = HANDLERS[request.operation_id]({ request, parameters, documents, now: request.created_at });
    const files = describeFiles(outcome.files);
    const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (total > request.limits.max_output_bytes) throw new Rejected('output-too-large', `output is ${total} bytes and limits.max_output_bytes is ${request.limits.max_output_bytes}`);
    writeFiles(directory, files);

    const outputs = files.map((file) => ({
      artifact_id: file.artifact_id,
      role: file.role,
      media_type: file.media_type,
      location: path.join(directory, file.name),
      sha256: file.sha256,
      size_bytes: file.bytes.length,
      ...(file.width === undefined ? {} : { width: file.width, height: file.height }),
    }));
    const record = result(request, {
      status: 'review_required',
      startedAt,
      completedAt: clock(),
      outputs,
      omissions: [UNVERIFIED, ...outcome.omissions, LIMITS_NOT_ENFORCED],
      metrics: outcome.metrics,
    });
    const final = schemaErrors('operation-result', record);
    if (final.length) throw new Rejected('internal-error', `the module produced an invalid result: ${final.join('; ')}`);
    return { result: record, exitCode: 0 };
  } catch (error) {
    if (error instanceof Rejected) return fail(error.code, error.message, error.details);
    return fail('internal-error', `unexpected failure: ${error && error.message ? error.message : String(error)}`);
  }
}

module.exports = { run, OPERATIONS };
