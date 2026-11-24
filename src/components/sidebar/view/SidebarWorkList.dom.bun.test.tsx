import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { makeSidebarT as makeT, sidebarContentPropsFixture } from './SidebarContent.testFixture';
import SidebarWorkList from './SidebarWorkList';

afterEach(cleanup);

test('Active pulls every remaining page of its projects and offers no Show more control', async () => {
  const t = await makeT();
  const base = sidebarContentPropsFixture(t).projectListProps;
  const requested: string[] = [];
  // Both workspaces have sessions past the loaded page.
  const paged = base.projects.map((project) => ({ ...project, sessionMeta: { total: 30, hasMore: true } }));

  const view = render(createElement(
    MemoryRouter,
    null,
    createElement(SidebarWorkList, {
      projectListProps: {
        ...base,
        projects: paged,
        filteredProjects: paged,
        onLoadMoreSessions: (projectId: string) => { requested.push(projectId); },
        getSessionStatus: (sessionId: string) => sessionId === 'session-running' ? 'running' : 'idle',
      },
    }),
  ));

  assert.deepEqual(requested.sort(), ['project-alpha', 'project-beta'], 'every project with history left is asked for its next page');
  assert.doesNotMatch(view.container.textContent ?? '', /showMore/);
});
