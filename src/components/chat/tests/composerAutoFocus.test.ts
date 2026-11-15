import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldFocusComposer } from '../utils/composerAutoFocus';

const key = (overrides: Partial<Parameters<typeof shouldFocusComposer>[0]> = {}) => ({
  key: 'h',
  ...overrides,
});

test('a printable keystroke with nothing focused goes to the composer', () => {
  assert.equal(shouldFocusComposer(key(), false), true);
  assert.equal(shouldFocusComposer(key({ key: '/' }), false), true, 'a slash command starts in the composer too');
});

test('a focused field keeps its own keystrokes', () => {
  const input = { tagName: 'INPUT', isContentEditable: false } as unknown as EventTarget;
  const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as EventTarget;
  const editable = { tagName: 'DIV', isContentEditable: true } as unknown as EventTarget;
  assert.equal(shouldFocusComposer(key({ target: input }), false), false);
  assert.equal(shouldFocusComposer(key({ target: textarea }), false), false);
  assert.equal(shouldFocusComposer(key({ target: editable }), false), false);
});

test('an open dialog, a shortcut and a handled key keep the keyboard', () => {
  assert.equal(shouldFocusComposer(key(), true), false, 'the settings dialog owns the keyboard');
  assert.equal(shouldFocusComposer(key({ ctrlKey: true }), false), false);
  assert.equal(shouldFocusComposer(key({ metaKey: true }), false), false);
  assert.equal(shouldFocusComposer(key({ altKey: true }), false), false);
  assert.equal(shouldFocusComposer(key({ key: 'Enter' }), false), false);
  assert.equal(shouldFocusComposer(key({ key: 'Shift' }), false), false);
  assert.equal(shouldFocusComposer(key({ defaultPrevented: true }), false), false);
});
