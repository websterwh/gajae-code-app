import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';

import { SessionStatusProvider, usePublishSessionStatus } from '../../../contexts/SessionStatusContext';
import { EMPTY_SESSION_STATUS, type SessionStatusSnapshot } from '../../../contexts/sessionStatusSnapshot';

import AgentSidebarStats from './AgentSidebarStats';

const originalFetch = globalThis.fetch;
let requests: string[] = [];

/** The shape `GET /api/stats/overview` answers with, narrowed to `projects`. */
function overview(projects: unknown[] = []) {
  return { success: true, data: { projects } };
}

function answer(body: unknown) {
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

function Publisher({ snapshot }: { snapshot: SessionStatusSnapshot }) {
  usePublishSessionStatus(snapshot);
  return null;
}

function stats(projectId: string | undefined = 'project-alpha', projectPath: string | undefined = '/work/alpha') {
  return createElement(AgentSidebarStats, { projectId, projectPath });
}

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test('the chat reports its context window, percentage and token split', async () => {
  answer(overview());
  const snapshot: SessionStatusSnapshot = {
    ...EMPTY_SESSION_STATUS,
    sessionId: 'session-1',
    contextTokens: 53_760,
    contextWindow: 128_000,
    contextPercent: 42,
    tokens: { used: 53_760, input: 40_000, output: 3_760, cache: 10_000 },
  };

  render(createElement(SessionStatusProvider, null,
    createElement(Publisher, { snapshot }),
    stats()));

  const gauge = await screen.findByRole('progressbar', { name: 'agentSidebar.stats.context' });
  assert.equal(gauge.getAttribute('aria-valuenow'), '42');
  assert.match(screen.getByText('agentSidebar.stats.context').parentElement?.textContent ?? '', /42%/);
  assert.match(screen.getByText('agentSidebar.stats.context').parentElement?.parentElement?.textContent ?? '', /54K \/ 128K/);

  // The breakdown is the runtime's own input/output/cache report.
  assert.equal(within(screen.getByText('agentSidebar.stats.input').parentElement!).getByText('40K').textContent, '40K');
  assert.equal(within(screen.getByText('agentSidebar.stats.output').parentElement!).getByText('3.8K').textContent, '3.8K');
  assert.equal(within(screen.getByText('agentSidebar.stats.cache').parentElement!).getByText('10K').textContent, '10K');
  assert.ok(screen.getByText('agentSidebar.stats.thisChat'));
  // No transcripts yet: the project half stays out rather than claiming zeroes.
  assert.equal(screen.queryByText('agentSidebar.stats.project'), null);
});

test('the project half sums this working tree and its worktrees, not other projects', async () => {
  answer(overview([
    { name: 'alpha', path: '/work/alpha', total: 1_000, turns: 2, sessions: 1, cost: 0.25 },
    { name: 'job-one', path: '/work/alpha/.gjc-worktrees/job-one', total: 500, turns: 1, sessions: 1, cost: 0.05 },
    { name: 'beta', path: '/work/beta', total: 9_999, turns: 99, sessions: 9, cost: 9 },
  ]));

  render(stats());

  await screen.findByText('agentSidebar.stats.project');
  const tokens = screen.getByText('agentSidebar.stats.tokens').parentElement!;
  assert.equal(within(tokens).getByText('1.5K').textContent, '1.5K');
  const turns = screen.getByText('agentSidebar.stats.turns').parentElement!;
  assert.equal(within(turns).getByText('3').textContent, '3');
  assert.match(screen.getByText('agentSidebar.stats.cost').parentElement?.textContent ?? '', /0\.30/);

  // Only the overview is read, and only once per mount.
  assert.deepEqual(requests, ['/api/stats/overview']);
});

test('a session that has reported nothing and a project with no history render nothing', async () => {
  answer(overview());

  const { container } = render(createElement(SessionStatusProvider, null, stats()));

  await waitFor(() => assert.equal(requests.length, 1));
  await waitFor(() => assert.equal(container.querySelector('section'), null));
});

test('a project with no cost reported shows a dash rather than zero dollars', async () => {
  answer(overview([
    { name: 'alpha', path: '/work/alpha', total: 12, turns: 1, sessions: 1, cost: 0 },
  ]));

  render(stats());

  await screen.findByText('agentSidebar.stats.project');
  assert.equal(within(screen.getByText('agentSidebar.stats.cost').parentElement!).getByText('—').textContent, '—');
});
