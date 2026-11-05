'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { toMermaid } = require('../src/mermaid');
const { mermaidId } = require('../src/ids');
const { documentErrors } = require('../src/validate');
const { clone, fixture, fixtureText, FIXTURES } = require('./helpers');

function small(nodes, connections) {
  const document = clone(fixture('campaign-approval.flow.json'));
  document.nodes = nodes;
  document.connections = connections;
  document.lanes = [];
  assert.deepEqual(documentErrors(document), []);
  return document;
}

test('Mermaid output matches the Forge reference apart from the source comment', () => {
  const lines = toMermaid(fixture('campaign-approval.flow.json')).split('\n');
  assert.match(lines[1], /^ {2}%% flow-document campaign-approval revision 1$/);
  lines.splice(1, 1);
  assert.equal(lines.join('\n'), fixtureText('campaign-approval.mmd'));
});

test('Mermaid output equals the module golden file', () => {
  const golden = path.join(FIXTURES, 'expected', 'campaign-approval.mmd');
  const actual = toMermaid(fixture('campaign-approval.flow.json'));
  if (process.env.UPDATE_FIXTURES) fs.writeFileSync(golden, actual);
  assert.equal(actual, fs.readFileSync(golden, 'utf8'));
});

test('distinct canonical IDs never share a Mermaid ID', () => {
  const document = small(
    [{ node_id: 'a-b', kind: 'start', label: 'Hyphen' }, { node_id: 'a_b', kind: 'end', label: 'Underscore' }, { node_id: 'a.b', kind: 'action', label: 'Dot' }],
    [{ connection_id: 'edge', from_node: 'a-b', to_node: 'a_b' }, { connection_id: 'edge-two', from_node: 'a-b', to_node: 'a.b' }],
  );
  const output = toMermaid(document);
  const ids = new Set(document.nodes.map((node) => mermaidId(node.node_id)));
  assert.equal(ids.size, 3);
  for (const id of ids) assert.ok(output.includes(id));
  assert.ok(output.includes('n_612d62') && output.includes('n_615f62') && output.includes('n_612e62'));
});

test('the canonical ID "end" and other Mermaid words cannot reach the output as identifiers', () => {
  const document = small(
    [{ node_id: 'end', kind: 'end', label: 'Finish' }, { node_id: 'graph', kind: 'start', label: 'Begin' }],
    [{ connection_id: 'go', from_node: 'graph', to_node: 'end' }],
  );
  const output = toMermaid(document);
  assert.ok(!/^\s+end\b/m.test(output) && !/^\s+graph\b/m.test(output));
  assert.ok(output.includes('n_656e64'));
});

test('labels cannot break out of the Mermaid syntax', () => {
  const nasty = 'He said "go" #1 & <b>stop</b> | `tick`\nnext line';
  const document = small(
    [{ node_id: 'a', kind: 'start', label: nasty }, { node_id: 'b', kind: 'end', label: 'End' }],
    [{ connection_id: 'c', from_node: 'a', to_node: 'b', label: nasty }],
  );
  const output = toMermaid(document);
  const nodeLine = output.split('\n').find((line) => line.includes(mermaidId('a')) && line.includes('['));
  assert.equal(nodeLine, `  ${mermaidId('a')}["He said #quot;go#quot; #35;1 #amp; #lt;b#gt;stop#lt;/b#gt; | #96;tick#96; next line"]`);
  const edgeLine = output.split('\n').find((line) => line.includes('-->'));
  assert.equal(edgeLine, `  ${mermaidId('a')} -->|"He said #quot;go#quot; #35;1 #amp; #lt;b#gt;stop#lt;/b#gt; | #96;tick#96; next line"| ${mermaidId('b')}`);
  assert.equal(output.split('\n').length, 6, 'one line per record: header, comment, two nodes, one edge, trailing newline');
});

test('an edge condition is used when there is no label', () => {
  const document = small(
    [{ node_id: 'a', kind: 'start', label: 'A' }, { node_id: 'b', kind: 'end', label: 'B' }],
    [{ connection_id: 'c', from_node: 'a', to_node: 'b', condition: 'score > 3' }],
  );
  assert.ok(toMermaid(document).includes(`-->|"score #gt; 3"|`));
});

test('direction follows the layout direction', () => {
  const document = fixture('campaign-approval.flow.json');
  document.layout.direction = 'top-down';
  assert.ok(toMermaid(document).startsWith('flowchart TD\n'));
});
