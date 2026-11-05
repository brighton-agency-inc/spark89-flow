'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { requireDependency } = require('./dependencies');

const MODULE_ROOT = path.resolve(__dirname, '..');
const CONTRACT_DIR = path.join(MODULE_ROOT, 'contracts', 'v1');
const SOURCE_FILE = path.join(MODULE_ROOT, 'contracts', 'SOURCE.json');

let cache = null;

function build() {
  const Ajv2020 = requireDependency('ajv/dist/2020');
  const addFormats = requireDependency('ajv-formats');
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, strictRequired: false });
  addFormats(ajv);
  const names = fs.readdirSync(CONTRACT_DIR).filter((name) => name.endsWith('.schema.json')).sort();
  for (const name of names) ajv.addSchema(JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, name), 'utf8')));
  return ajv;
}

function validator(schemaName) {
  if (!cache) cache = build();
  const validate = cache.getSchema(`https://forge.spark89.local/contracts/v1/${schemaName}.schema.json`);
  if (!validate) throw new Error(`unknown contract ${schemaName}`);
  return validate;
}

function describe(error) {
  const where = error.instancePath || '/';
  const extra = error.keyword === 'additionalProperties' ? ` (${error.params.additionalProperty})` : '';
  return `${where}: ${error.message}${extra}`;
}

/** Schema errors for `instance` against the vendored Forge contract `schemaName`, in a stable order. */
function schemaErrors(schemaName, instance) {
  const validate = validator(schemaName);
  if (validate(instance)) return [];
  return [...new Set(validate.errors.map(describe))].sort();
}

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

/** Compares the vendored schemas with the digests recorded in contracts/SOURCE.json. */
function verifyVendoredContracts() {
  const problems = [];
  let source;
  try {
    source = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
  } catch (error) {
    return { source: null, problems: [`contracts/SOURCE.json cannot be read: ${error.message}`] };
  }
  const recorded = source.files || {};
  for (const [name, digest] of Object.entries(recorded)) {
    let actual;
    try {
      actual = sha256(fs.readFileSync(path.join(CONTRACT_DIR, name)));
    } catch (error) {
      problems.push(`${name} cannot be read: ${error.message}`);
      continue;
    }
    if (actual !== digest) problems.push(`${name} differs from the recorded Forge contract (${actual})`);
  }
  for (const name of fs.readdirSync(CONTRACT_DIR)) {
    if (name.endsWith('.json') && !(name in recorded)) problems.push(`${name} is not recorded in contracts/SOURCE.json`);
  }
  return { source, problems };
}

module.exports = { MODULE_ROOT, schemaErrors, verifyVendoredContracts };
