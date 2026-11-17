/**
 * The activity card as a browser sees it: the calendar is the default view,
 * both views cover the whole 30-day window (including days without usage), and
 * a day's tokens appear on mouseenter rather than through a delayed native
 * tooltip, so moving straight to the next day replaces the number at once.
 */

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';

import StatsPage from './StatsPage';

const originalFetch = globalThis.fetch;
const integer = new Intl.NumberFormat();
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSY = 400_000;
const QUIET = 100_000;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: {} } },
  interpolation: { escapeValue: false },
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

/** A UTC day offset from today, which is the window the page builds locally. */
const day = (offset: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - offset * DAY_MS)
    .toISOString()
    .slice(0, 10);
};

function overview() {
  return {
    generatedAt: new Date().toISOString(),
    root: '/tmp/gjc',
    scanned: { files: 3, bytes: 1024, truncated: false },
    totals: { sessions: 2, turns: 4, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: BUSY + QUIET, cost: 1.5 },
    models: [],
    projects: [],
    // Sparse on purpose: the API only reports days that saw traffic.
    daily: [
      { date: day(1), total: QUIET, cost: 0.5 },
      { date: day(0), total: BUSY, cost: 1 },
    ],
    firstActivityAt: `${day(1)}T10:00:00.000Z`,
    lastActivityAt: `${day(0)}T11:00:00.000Z`,
  };
}

function stubOverview() {
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: overview() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof globalThis.fetch;
}

async function mount() {
  stubOverview();
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <StatsPage />
      </MemoryRouter>
    </I18nextProvider>,
  );
  await screen.findByRole('button', { name: 'Bar view' });
}

const cells = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[data-date]')];
const cell = (view: 'grid' | 'bars', offset: number) =>
  document.querySelector<HTMLElement>(`[data-view="${view}"] [data-date="${day(offset)}"]`);

test('the calendar is the default view and both views cover all 30 days', async () => {
  await mount();

  assert.equal(screen.getByRole('button', { name: 'Calendar view' }).getAttribute('aria-pressed'), 'true');
  assert.equal(screen.getByRole('button', { name: 'Bar view' }).getAttribute('aria-pressed'), 'false');
  assert.ok(document.querySelector('[data-view="grid"]'), 'the calendar is shown first');
  assert.equal(document.querySelector('[data-view="bars"]'), null);
  assert.equal(cells().length, 30, 'inactive days are drawn, not skipped');

  fireEvent.click(screen.getByRole('button', { name: 'Bar view' }));
  assert.ok(document.querySelector('[data-view="bars"]'));
  assert.equal(document.querySelector('[data-view="grid"]'), null);
  assert.equal(screen.getByRole('button', { name: 'Bar view' }).getAttribute('aria-pressed'), 'true');
  assert.equal(cells().length, 30);

  fireEvent.click(screen.getByRole('button', { name: 'Calendar view' }));
  assert.ok(document.querySelector('[data-view="grid"]'));
});

test('square intensity follows the day total, from empty to full', async () => {
  await mount();

  const busiest = cell('grid', 0);
  const quarter = cell('grid', 1);
  const idle = cell('grid', 10);
  assert.ok(busiest && quarter && idle);

  assert.ok(busiest.className.split(' ').includes('bg-primary'), 'the busiest day is full colour');
  assert.ok(quarter.className.split(' ').includes('bg-primary/20'), 'a quarter of the busiest day is one step up');
  assert.ok(idle.className.split(' ').includes('bg-muted/60'), 'a day without usage stays empty');
});

test('hovering shows that day’s tokens at once, and the next day replaces them', async () => {
  await mount();

  fireEvent.mouseEnter(cell('grid', 0)!);
  assert.ok(screen.getByText(new RegExp(`${integer.format(BUSY)} tokens`)), 'the tooltip appears on enter, with no delay');

  fireEvent.mouseEnter(cell('grid', 1)!);
  assert.ok(screen.getByText(new RegExp(`${integer.format(QUIET)} tokens`)));
  assert.equal(
    screen.queryByText(new RegExp(`${integer.format(BUSY)} tokens`)),
    null,
    'the previous day is replaced, not queued behind a timer',
  );

  fireEvent.mouseLeave(document.querySelector('[data-view="grid"]')!);
  assert.equal(screen.queryByText(new RegExp(`${integer.format(QUIET)} tokens`)), null, 'leaving the chart clears it');

  fireEvent.click(screen.getByRole('button', { name: 'Bar view' }));
  fireEvent.mouseEnter(cell('bars', 0)!);
  assert.ok(screen.getByText(new RegExp(`${integer.format(BUSY)} tokens`)), 'the bar view shares the same hover readout');
});
