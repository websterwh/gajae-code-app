import assert from 'node:assert/strict';
import test from 'node:test';

import type { Project } from '../../../types/app';

import { sortProjects } from './utils';

const project = (projectId: string, fields: Partial<Project> = {}): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/workspace/${projectId}`,
  ...fields,
});

test('a workspace without sessions sorts by when it was added, not always last', () => {
  const oldWithHistory = project('old-with-history', {
    sessions: [{ id: 's1', createdAt: '2026-01-01T00:00:00.000Z', lastActivity: '2026-01-01T00:00:00.000Z' }],
  });
  const brandNew = project('brand-new', { createdAt: '2026-11-25T00:00:00.000Z' });
  const olderEmpty = project('older-empty', { createdAt: '2026-11-20T00:00:00.000Z' });

  assert.deepEqual(
    sortProjects([oldWithHistory, brandNew, olderEmpty], 'date').map((entry) => entry.projectId),
    ['brand-new', 'older-empty', 'old-with-history'],
  );
});

test('a workspace with history keeps sorting by its activity, not by when it was added', () => {
  const active = project('active', {
    createdAt: '2020-01-01T00:00:00.000Z',
    sessions: [{ id: 's1', lastActivity: '2026-11-24T00:00:00.000Z' }],
  });
  const recentEmpty = project('recent-empty', { createdAt: '2026-11-25T00:00:00.000Z' });

  assert.deepEqual(
    sortProjects([active, recentEmpty], 'date').map((entry) => entry.projectId),
    ['recent-empty', 'active'],
  );
});

test('starred workspaces stay above the date order', () => {
  const starredOld = project('starred-old', { isStarred: true, createdAt: '2020-01-01T00:00:00.000Z' });
  const recent = project('recent', { createdAt: '2026-11-25T00:00:00.000Z' });

  assert.deepEqual(
    sortProjects([recent, starredOld], 'date').map((entry) => entry.projectId),
    ['starred-old', 'recent'],
  );
});
