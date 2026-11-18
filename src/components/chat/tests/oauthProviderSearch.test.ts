/**
 * The sign-in provider list is long enough to scroll, so its search has to
 * match the way people type: abbreviations ("ghcp", "cop") and provider ids,
 * not only a prefix of the display name.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { filterOAuthProviders } from '../OAuthLoginDialog';
import type { OAuthProvider } from '../hooks/useOAuthLogin';

const provider = (id: string, name: string): OAuthProvider => ({
  id,
  name,
  available: true,
  authenticated: false,
});

const providers = [
  provider('anthropic', 'Claude'),
  provider('openai-codex', 'Codex'),
  provider('github-copilot', 'GitHub Copilot'),
  provider('google', 'Gemini'),
  provider('cursor', 'Cursor'),
];

test('an empty query keeps the whole list in its given order', () => {
  assert.deepEqual(filterOAuthProviders(providers, '   ').map((entry) => entry.id), providers.map((entry) => entry.id));
});

test('a subsequence finds the provider without typing every letter', () => {
  assert.deepEqual(filterOAuthProviders(providers, 'ghcp').map((entry) => entry.id), ['github-copilot']);
});

test('a substring match leads the list even when a looser match also fits', () => {
  // "cop" is also a subsequence of "Claude anthropic"; the provider whose
  // name actually contains it has to come first, not merely be present.
  assert.equal(filterOAuthProviders(providers, 'cop')[0]?.id, 'github-copilot');
});

test('the closest name sorts first', () => {
  const matching = filterOAuthProviders(
    [provider('x-code', 'Zed'), provider('code', 'Code'), provider('encode', 'Encode')],
    'code',
  );
  assert.deepEqual(matching.map((entry) => entry.id), ['code', 'encode', 'x-code']);
});

test('a term may match the provider id when the name differs', () => {
  assert.deepEqual(filterOAuthProviders(providers, 'anthropic').map((entry) => entry.id), ['anthropic']);
});

test('a query with no match returns nothing rather than everything', () => {
  assert.deepEqual(filterOAuthProviders(providers, 'zzzz'), []);
});
