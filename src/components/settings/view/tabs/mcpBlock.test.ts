import assert from 'node:assert/strict';
import test from 'node:test';

import { formatMcpBlock, parseMcpBlock } from './mcpBlock';

test('a stdio server is emitted as the block mcp.json would hold and reads back', () => {
  const block = formatMcpBlock({
    name: 'playwright',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
  });
  assert.match(block, /^playwright:\n {2}type: stdio\n {2}command: npx\n {2}args:\n {4}- "-y"\n {4}- "@playwright\/mcp@latest"\n {4}- "--headless"\n$/u);

  const parsed = parseMcpBlock(block);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : null, {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@latest', '--headless'],
  });
});

test('pasted env values are kept and an empty one is left out so the stored secret survives', () => {
  const parsed = parseMcpBlock([
    'github:',
    '  type: stdio',
    '  command: npx',
    '  args:',
    '    - "-y"',
    '    - "@modelcontextprotocol/server-github"',
    '  env:',
    '    GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_new"',
    '    OTHER: ""',
  ].join('\n'));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.env : null, { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_new' });
  assert.deepEqual(parsed.ok ? parsed.value.args : null, ['-y', '@modelcontextprotocol/server-github']);
});

test('a remote server reads its url and headers, and knows its transport', () => {
  const parsed = parseMcpBlock([
    'home-assistant:',
    '  type: http',
    '  url: http://192.168.1.9:9583/api/mcp',
    '  headers:',
    '    Authorization: "Bearer abc"',
  ].join('\n'));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value : null, {
    transport: 'http',
    url: 'http://192.168.1.9:9583/api/mcp',
    headers: { Authorization: 'Bearer abc' },
  });
});

test('a block with nothing to run is refused with the reason', () => {
  assert.deepEqual(parseMcpBlock('playwright:\n  type: stdio\n'), { ok: false, error: 'command' });
  assert.deepEqual(parseMcpBlock('remote:\n  type: http\n'), { ok: false, error: 'url' });
  assert.deepEqual(parseMcpBlock('not a block'), { ok: false, error: 'shape' });
});

test('a stored value is written into the block as it is, so the form is not blank', () => {
  const block = formatMcpBlock({
    name: 'canvas',
    transport: 'http',
    url: 'https://canvas.example/mcp',
    headers: { Authorization: 'Bearer abc' },
  }, ['CANVAS_URL', 'CANVAS_TOKEN']);
  assert.match(block, /^ {2}url: https:\/\/canvas\.example\/mcp$/mu);
  assert.match(block, /^ {4}Authorization: "Bearer abc"$/mu);
  // A catalog variable the entry does not set stays empty, which means "keep".
  assert.match(block, /^ {4}CANVAS_TOKEN: ""$/mu);

  const parsed = parseMcpBlock(block);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.headers : null, { Authorization: 'Bearer abc' });
});

test('an empty args list stays an empty list instead of becoming one argument', () => {
  const parsed = parseMcpBlock('mempalace:\n  type: stdio\n  command: /root/.gjc/app/bin/mempalace-mcp\n  args: []\n');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.value.args : null, []);
});
