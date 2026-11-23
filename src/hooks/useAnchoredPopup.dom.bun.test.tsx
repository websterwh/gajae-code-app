import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useEscapeToAbort } from '../components/chat/hooks/useEscapeToAbort';
import { shouldFocusComposer } from '../components/chat/utils/composerAutoFocus';

import { useAnchoredPopup } from './useAnchoredPopup';

function Harness({ canAbort, onAbort }: { canAbort: boolean; onAbort: () => void }) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPopup({ open, onClose: () => setOpen(false), anchorRef, popupRef, width: 200 });
  useEscapeToAbort(canAbort, onAbort);
  return (
    <>
      <div ref={anchorRef}>
        <button type="button" onClick={() => setOpen((current) => !current)} aria-expanded={open}>Mode</button>
      </div>
      <button type="button">Elsewhere</button>
      {open && createPortal(
        <div ref={popupRef} role="listbox" aria-label="Modes" style={position}>
          <button type="button" role="option" aria-selected>Ask</button>
          <button type="button" role="option" aria-selected={false} disabled>Unavailable</button>
          <button type="button" role="option" aria-selected={false}>Bypass</button>
        </div>,
        document.body,
      )}
    </>
  );
}

function FilterHarness() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const anchorRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPopup({ open, onClose: () => setOpen(false), anchorRef, popupRef, width: 200 });
  return (
    <>
      <div ref={anchorRef}>
        <button type="button" onClick={() => setOpen((current) => !current)}>Models</button>
      </div>
      {open && createPortal(
        <div ref={popupRef} role="listbox" aria-label="Models" style={position}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter models"
          />
          <button type="button" role="option" aria-selected={false}>ChatGPT</button>
        </div>,
        document.body,
      )}
    </>
  );
}

function mount(canAbort = false) {
  let aborts = 0;
  render(<Harness canAbort={canAbort} onAbort={() => { aborts += 1; }} />);
  const trigger = screen.getByRole('button', { name: 'Mode' });
  return { trigger, aborts: () => aborts };
}

afterEach(cleanup);

test('Escape closes the popup and hands focus back to the trigger', () => {
  const view = mount();
  fireEvent.click(view.trigger);
  act(() => screen.getByRole('option', { name: 'Ask' }).focus());

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(screen.queryByRole('listbox'), null);
  assert.equal(document.activeElement, view.trigger);
});

test('while a run can be stopped, Stop keeps owning Escape and the popup stays', () => {
  const view = mount(true);
  fireEvent.click(view.trigger);

  fireEvent.keyDown(document, { key: 'Escape' });
  assert.equal(view.aborts(), 1);
  assert.ok(screen.getByRole('listbox'), 'an Escape the run consumed is not a second dismissal');
});

test('arrow keys walk the enabled options and wrap', () => {
  const view = mount();
  fireEvent.click(view.trigger);
  act(() => view.trigger.focus());

  fireEvent.keyDown(document, { key: 'ArrowDown' });
  assert.equal(document.activeElement?.textContent, 'Ask');
  fireEvent.keyDown(document, { key: 'ArrowDown' });
  assert.equal(document.activeElement?.textContent, 'Bypass', 'a disabled option is skipped');
  fireEvent.keyDown(document, { key: 'ArrowDown' });
  assert.equal(document.activeElement?.textContent, 'Ask');
  fireEvent.keyDown(document, { key: 'ArrowUp' });
  assert.equal(document.activeElement?.textContent, 'Bypass');
});

test('typing with an option focused filters the popup instead of the composer behind it', () => {
  render(<div data-composer-root=""><textarea aria-label="Composer" /></div>);
  render(<FilterHarness />);
  // What the composer's type-anywhere handler does while a picker is open.
  const composerTyping = (event: KeyboardEvent) => {
    if (shouldFocusComposer(event, false)) screen.getByLabelText<HTMLTextAreaElement>('Composer').focus();
  };
  document.addEventListener('keydown', composerTyping);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Models' }));
    const option = screen.getByRole('option', { name: 'ChatGPT' });
    act(() => option.focus());

    fireEvent.keyDown(option, { key: 'g' });

    assert.equal(document.activeElement, screen.getByRole('textbox', { name: 'Filter models' }));
  } finally {
    document.removeEventListener('keydown', composerTyping);
  }
});

test('a press outside the trigger and the popup closes it; a press inside does not', () => {
  const view = mount();
  fireEvent.click(view.trigger);
  fireEvent.mouseDown(screen.getByRole('option', { name: 'Bypass' }));
  assert.ok(screen.getByRole('listbox'));

  fireEvent.mouseDown(screen.getByRole('button', { name: 'Elsewhere' }));
  assert.equal(screen.queryByRole('listbox'), null);
});
