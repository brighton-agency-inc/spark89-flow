'use strict';

// Resolves npm dependencies.
//
// When FORGE_NODE_MODULES is set, dependencies resolve only from that directory. A Forge-managed
// environment installs node_modules outside the checkout, and a checkout-local node_modules must
// not stand in for it. A dependency that is absent there is an error, not a fallback.
//
// When FORGE_NODE_MODULES is unset, resolution is the standard Node lookup from the checkout,
// which is the developer-checkout behavior.

const path = require('node:path');

function resolveDependency(name, env = process.env, resolveFn = require.resolve) {
  const managed = env.FORGE_NODE_MODULES;
  if (!managed) return resolveFn(name);
  const root = path.resolve(managed);
  let resolved;
  try {
    resolved = resolveFn(name, { paths: [root] });
  } catch (_) {
    resolved = null;
  }
  if (!resolved || !resolved.startsWith(root + path.sep)) {
    const err = new Error(`${name} is not installed in FORGE_NODE_MODULES (${root})`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return resolved;
}

function requireDependency(name, env = process.env) {
  return require(resolveDependency(name, env));
}

module.exports = { resolveDependency, requireDependency };
