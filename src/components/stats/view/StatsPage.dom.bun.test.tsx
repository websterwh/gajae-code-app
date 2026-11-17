/**
 * The activity card as a browser sees it: a six-month calendar that fills the
 * card and, under it, the last-30-days bars — both always visible, with no view
 * switch. A day's tokens appear on mouseenter rather than through a delayed
 * native tooltip, so moving straight to the next day replaces the number at once.
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
const CALENDAR_WEEKS = 26;

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

const utcToday = () => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
};

/** The calendar runs week-aligned from Sunday, so its day count depends on today. */
const calendarDays = () => (CALENDAR_WEEKS - 1) * 7 + new Date(utcToday()).getUTCDay() + 1;

/** A UTC day offset from today, which is the window the page builds locally. */
const day = (offset: number) => new Date(utcToday() - offset * DAY_MS).toISOString().slice(0, 10);

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
  const charts = await screen.findAllByRole('img', { name: 'Daily token usage' });
  assert.equal(charts.length, 2, 'the calendar and the bars are both on the page');
}

const cells = (view: 'grid' | 'bars') => [...document.querySelectorAll<HTMLElement>(`[data-view="${view}"] [data-date]`)];
const cell = (view: 'grid' | 'bars', offset: number) =>
  document.querySelector<HTMLElement>(`[data-view="${view}"] [data-date="${day(offset)}"]`);

test('both charts stay on the page, and the calendar spans far more than 30 days', async () => {
  await mount();

  assert.equal(document.querySelector('[data-view="grid"]') !== null, true);
  assert.equal(document.querySelector('[data-view="bars"]') !== null, true);
  assert.equal(screen.queryByRole('button', { name: 'Calendar view' }), null, 'no view toggle is offered');
  assert.equal(screen.queryByRole('button', { name: 'Bar view' }), null);

  assert.equal(cells('grid').length, calendarDays(), 'inactive days are drawn, not skipped');
  assert.ok(cells('grid').length > 170, 'the calendar covers about six months');
  assert.equal(cells('bars').length, 30, 'the bars keep the 30-day window');
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

  fireEvent.mouseEnter(cell('bars', 0)!);
  assert.ok(screen.getByText(new RegExp(`${integer.format(BUSY)} tokens`)), 'the bars share the same hover readout');
});
