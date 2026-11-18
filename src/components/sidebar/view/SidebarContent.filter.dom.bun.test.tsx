import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import SidebarContent from './SidebarContent';
import { makeSidebarT, sidebarContentPropsFixture, sidebarProjectsFixture } from './SidebarContent.testFixture';
import type { SidebarProjectListProps } from './SidebarProjectList';

/** The body search streams over SSE; the test environment has none, and the title filter must still work. */
class UnavailableEventSource {
  constructor() { throw new Error('EventSource is not available here'); }
}
const originalEventSource = globalThis.EventSource;
globalThis.EventSource = UnavailableEventSource as unknown as typeof EventSource;

afterEach(() => {
  cleanup();
});

process.on('exit', () => { globalThis.EventSource = originalEventSource; });

const tick = (ms: number) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

async function mountSidebar(overrides: Partial<SidebarProjectListProps> = {}) {
  const t = await makeSidebarT();
  const props = sidebarContentPropsFixture(t);
  render(
    <MemoryRouter>
      <SidebarContent {...props} projectListProps={{ ...props.projectListProps, ...overrides }} />
    </MemoryRouter>,
  );
  return screen.getByLabelText('Filter conversations') as HTMLInputElement;
}

test('typing narrows the tree after the debounce and Escape clears it', async () => {
  const input = await mountSidebar();

  fireEvent.change(input, { target: { value: 'pending' } });
  assert.ok(screen.queryAllByText('Implement navigation cleanup').length > 0, 'nothing changes before the debounce');
  await tick(200);

  assert.equal(screen.queryAllByText('Implement navigation cleanup').length, 0);
  assert.ok(screen.queryAllByText('Review pending decision').length > 0);
  assert.ok(screen.queryAllByText('Beta Workspace').length > 0);
  assert.equal(screen.queryAllByText('Alpha Workspace').length, 0, 'a project with no hits is hidden');
  assert.ok(screen.getByLabelText('Clear filter'));

  fireEvent.keyDown(input, { key: 'Escape' });
  assert.equal(input.value, '');
  await tick(10);
  assert.ok(screen.queryAllByText('Implement navigation cleanup').length > 0, 'clearing restores the tree at once');
});

test('a query with no hits says so instead of pretending there are no conversations', async () => {
  const input = await mountSidebar();
  fireEvent.change(input, { target: { value: 'zzz-nothing' } });
  await tick(200);

  assert.equal(screen.getByTestId('sidebar-filter-empty').textContent, 'No conversations match “zzz-nothing”');
  assert.equal(screen.queryAllByText('No conversations yet').length, 0);
});

test('an active query shows hits inside a collapsed project and hands the state back afterwards', async () => {
  // The Work section lists the same session on its own; only the project tree is under test.
  const input = await mountSidebar({ expandedProjects: new Set() });
  const projects = () => within(document.getElementById('sidebar-projects-content')!);
  assert.equal(projects().queryAllByText('Review pending decision').length, 0, 'collapsed to begin with');

  fireEvent.change(input, { target: { value: 'pending' } });
  await tick(200);
  assert.ok(projects().queryAllByText('Review pending decision').length > 0, 'the hit is visible while filtering');

  fireEvent.click(screen.getByLabelText('Clear filter'));
  await tick(10);
  assert.equal(projects().queryAllByText('Review pending decision').length, 0, 'collapsed again once the query is gone');
});

test('with no conversation open a keystroke starts the conversation search', async () => {
  const input = await mountSidebar();

  // Nothing selected, nothing focused: the keystroke has no other home, so it
  // becomes the first character of the filter.
  const typed = new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(typed); });

  assert.equal(document.activeElement, input, 'the filter takes focus');
  assert.equal(input.value, 'p');
  assert.equal(typed.defaultPrevented, true, 'and the keystroke is not lost to the page');
});

test('an open conversation and a focused field keep their keys', async () => {
  const session = sidebarProjectsFixture[0]?.sessions?.[0];
  assert.ok(session);
  const input = await mountSidebar({ selectedSession: { ...session, __provider: 'gjc' } });

  const other = document.createElement('textarea');
  document.body.append(other);
  other.focus();
  fireEvent.keyDown(other, { key: '/' });
  assert.equal(input.value, '', 'typing a slash into the composer is left alone');

  other.blur();
  // With a conversation selected the composer owns unclaimed keystrokes: the
  // old document-wide shortcut sent what was meant for the message into the
  // filter instead.
  const slash = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
  act(() => { document.body.dispatchEvent(slash); });
  assert.notEqual(document.activeElement, input);
  assert.equal(slash.defaultPrevented, false, 'and is left for the composer');
  assert.equal(input.value, '');
  other.remove();
});
