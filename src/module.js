'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODULE_ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'package.json'), 'utf8'));

module.exports = {
  MODULE_ID: 'flow-document',
  MODULE_ROOT,
  MODULE_VERSION: pkg.version,
  REPOSITORY: 'https://github.com/brighton-agency-inc/spark89-flow',
  SCHEMA_VERSION: '1.0.0',
  CONTRACT_VERSION: '1.0.0',
  MANIFEST_VERSION: '1.1.0',
  NODE_MAJOR: 24,
  NODE_VERSION_CONSTRAINT: '>=24,<25',
  // Bounds that keep layout time and output size predictable. They are declared in the manifest.
  MAX_INPUT_BYTES: 4 * 1024 * 1024,
  MAX_NODES: 500,
  MAX_CONNECTIONS: 1500,
  DEPENDENCIES: pkg.dependencies,
};
