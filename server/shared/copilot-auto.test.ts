import assert from 'node:assert/strict';
import test from 'node:test';

import {
  copilotAutoModelApi,
  copilotAutoModelHeaders,
  resolveCopilotAutoSelection,
  withCopilotAutoSession,
} from './copilot-auto.js';

test('Copilot Auto sends the prompt and returns the selected model with its session token', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;

  const selection = await resolveCopilotAutoSelection({
    apiKey: JSON.stringify({ token: 'copilot-token', enterpriseUrl: 'example.test' }),
    prompt: 'Fix the failing test',
    hasImage: true,
    baseUrl: 'https://api.githubcopilot.com/',
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return new Response(JSON.stringify({
        session_token: 'session-token',
        selected_model: { id: 'gpt-5.6-luna', supported_endpoints: ['/chat/completions', '/responses'] },
        expires_at: 1_800_000_000,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(requestUrl, 'https://api.githubcopilot.com/auto');
  assert.equal(requestInit?.method, 'POST');
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer copilot-token');
  assert.equal(headers.get('copilot-integration-id'), 'code-oss');
  assert.equal(headers.get('x-github-api-version'), '2026-08-01');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    prompt: 'Fix the failing test',
    tier: 'balance',
    has_image: true,
  });
  assert.deepEqual(selection, {
    modelId: 'gpt-5.6-luna',
    sessionToken: 'session-token',
    expiresAt: 1_800_000_000,
    supportedEndpoints: ['/chat/completions', '/responses'],
  });
  assert.equal(copilotAutoModelApi(selection), 'openai-responses');
});

test('Copilot Auto applies its session token to the selected model without mutating the catalog entry', () => {
  const model = { id: 'gpt-5.6-luna', headers: { 'User-Agent': 'existing', 'X-Custom': 'kept' } };
  const selected = withCopilotAutoSession(model, {
    modelId: 'gpt-5.6-luna',
    sessionToken: 'session-token',
    expiresAt: null,
    supportedEndpoints: ['/chat/completions'],
  });
  assert.equal(copilotAutoModelApi({
    modelId: 'gpt-5.6-luna',
    sessionToken: 'session-token',
    expiresAt: null,
    supportedEndpoints: ['/chat/completions'],
  }), undefined);

  assert.deepEqual(selected.headers, {
    'User-Agent': 'GitHubCopilotChat/0.67.0',
    'X-Custom': 'kept',
    'Editor-Version': 'vscode/1.139.0',
    'Editor-Plugin-Version': 'copilot-chat/0.67.0',
    'Copilot-Integration-Id': 'code-oss',
    'X-GitHub-Api-Version': '2026-08-01',
    'Copilot-Session-Token': 'session-token',
  });
  assert.deepEqual(model.headers, { 'User-Agent': 'existing', 'X-Custom': 'kept' });
  assert.deepEqual(copilotAutoModelHeaders('session-token'), {
    'User-Agent': 'GitHubCopilotChat/0.67.0',
    'Editor-Version': 'vscode/1.139.0',
    'Editor-Plugin-Version': 'copilot-chat/0.67.0',
    'Copilot-Integration-Id': 'code-oss',
    'X-GitHub-Api-Version': '2026-08-01',
    'Copilot-Session-Token': 'session-token',
  });
});

test('Copilot Auto reports a failed route without leaking the response body', async () => {
  await assert.rejects(
    resolveCopilotAutoSelection({
      apiKey: 'copilot-token',
      prompt: 'hello',
      fetch: async () => new Response('sensitive body', { status: 403 }),
    }),
    /HTTP 403/,
  );
});

test('Copilot Auto rejects a response that has no selected model', async () => {
  await assert.rejects(
    resolveCopilotAutoSelection({
      apiKey: 'copilot-token',
      prompt: 'hello',
      fetch: async () => new Response(JSON.stringify({
        session_token: 'session-token',
        selected_model: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    /no selected model or session token/,
  );
});
