#!/usr/bin/env node
'use strict';

// Forge v1 entry points for the flow-document module.
//
//   node forge_adapter.js manifest [--allow-dirty]
//   node forge_adapter.js health
//   node forge_adapter.js run [--request FILE]      (request JSON on stdin by default)
//
// Each command prints one JSON record to stdout.
//
// manifest   stamps module.revision with the exact full Git HEAD of a clean checkout. The revision
//            cannot be supplied or overridden. --allow-dirty prints a diagnostic record labelled
//            `uncommitted-changes`; it is not a contract manifest and is never installable.
// health     exit 0 healthy, 10 degraded, 20 unhealthy, 30 incompatible.
// run        exit 0 for a review_required result, 3 for any other result. An unreadable or
//            non-JSON request yields a failed result with code invalid-request.
//
// manifest exits 0 when written, 2 when it cannot be generated truthfully (for example a dirty
// working tree) and 4 when git is unavailable or the module is not a Git checkout.
//
// Direct output is unverified. See src/operations.js.

const fs = require('node:fs');

const EXIT_NOT_GENERATED = 2;
const EXIT_GIT_UNAVAILABLE = 4;

function print(record) {
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function usage() {
  process.stderr.write('usage: forge_adapter.js manifest [--allow-dirty] | health | run [--request FILE]\n');
  return 64;
}

function cmdManifest(args) {
  const { build, currentRevision, ManifestError } = require('./src/manifest');
  const { schemaErrors } = require('./src/contracts');
  const allowDirty = args.includes('--allow-dirty');
  if (args.some((arg) => arg !== '--allow-dirty')) return usage();
  let state;
  try {
    state = currentRevision();
  } catch (error) {
    if (error instanceof ManifestError && (error.code === 'git-unavailable' || error.code === 'not-a-git-checkout')) {
      process.stderr.write(`Error [${error.code}]: ${error.message}\n`);
      return EXIT_GIT_UNAVAILABLE;
    }
    process.stderr.write(`Error: ${error.message}\n`);
    return EXIT_NOT_GENERATED;
  }
  if (!/^[0-9a-f]{40}$/.test(state.revision)) {
    process.stderr.write('Error: git HEAD is not a full 40-character lowercase commit SHA\n');
    return EXIT_NOT_GENERATED;
  }
  if (state.dirty && !allowDirty) {
    process.stderr.write('Error: the working tree has uncommitted changes, so the revision would not describe it. Commit first. --allow-dirty produces diagnostic output labelled uncommitted-changes, which is not a contract manifest.\n');
    return EXIT_NOT_GENERATED;
  }
  const record = build(state.revision, { dirty: state.dirty });
  const problems = schemaErrors('module-manifest', record);
  if (problems.length) {
    process.stderr.write(`Error: generated manifest is invalid: ${problems.join('; ')}\n`);
    return EXIT_NOT_GENERATED;
  }
  print(record);
  return 0;
}

function cmdHealth(args) {
  if (args.length) return usage();
  const health = require('./src/health');
  const record = health.build();
  print(record);
  return health.EXIT_CODES[record.status];
}

function cmdRun(args) {
  let file;
  if (args.length === 2 && args[0] === '--request') file = args[1];
  else if (args.length) return usage();
  const { run } = require('./src/operations');
  let request;
  try {
    const raw = file ? fs.readFileSync(file) : fs.readFileSync(0);
    request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch (error) {
    request = null;
    const { result } = run(null);
    result.errors[0].message = `the request cannot be read as UTF-8 JSON: ${error.message}`;
    print(result);
    return 3;
  }
  const { result, exitCode } = run(request);
  print(result);
  return exitCode;
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'manifest') return cmdManifest(rest);
  if (command === 'health') return cmdHealth(rest);
  if (command === 'run') return cmdRun(rest);
  return usage();
}

process.exitCode = main(process.argv.slice(2));
