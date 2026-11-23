const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

type KeyLike = {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
};

/**
 * Keystrokes an open popup has taken for its own search field. The popup
 * focuses that field on the keydown itself, and the character is inserted
 * afterwards by the browser; default-preventing the event would focus the
 * field but swallow the character, so the event is marked instead and this
 * handler leaves it alone.
 */
const popupOwnedKeystrokes = new WeakSet<Event>();

export function markPopupOwnedKeystroke(event: Event): void {
  popupOwnedKeystrokes.add(event);
}

const isEditable = (target: EventTarget | null): boolean => {
  if (!target || typeof target !== 'object') return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return EDITABLE_TAGS.has(element.tagName ?? '');
};

/** A modal owns the keyboard while it is open, so typing must not reach behind it. */
export function hasOpenDialog(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[aria-modal="true"], [role="dialog"][data-state="open"]') !== null;
}

/**
 * Hands the keyboard back to the conversation. A picker that closes should
 * leave typing going to the message box, not to a trigger button or nothing at
 * all. Returns whether a composer was there to take focus (surfaces without one
 * fall back to their own focus target).
 */
export function focusComposerTextarea(): boolean {
  if (typeof document === 'undefined') return false;
  const textarea = document.querySelector<HTMLTextAreaElement>('[data-composer-root] textarea');
  if (!textarea) return false;
  textarea.focus();
  return document.activeElement === textarea;
}

/**
 * A printable keystroke with nothing focused means the user is talking to the
 * conversation. The composer takes focus on that keydown, before the browser
 * performs the insert, so the character lands in the message box instead of a
 * sidebar filter the user never chose. Modifier shortcuts and anything typed
 * into a field are left alone.
 */
export function shouldFocusComposer(event: KeyLike, dialogOpen: boolean): boolean {
  if (event.defaultPrevented) return false;
  if (popupOwnedKeystrokes.has(event as unknown as Event)) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (dialogOpen) return false;
  return !isEditable(event.target ?? null);
}
