const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

type KeyLike = {
  key: string;
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
};

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
 * A printable keystroke with nothing focused means the user is talking to the
 * conversation. The composer takes focus on that keydown, before the browser
 * performs the insert, so the character lands in the message box instead of a
 * sidebar filter the user never chose. Modifier shortcuts and anything typed
 * into a field are left alone.
 */
export function shouldFocusComposer(event: KeyLike, dialogOpen: boolean): boolean {
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  if (event.key.length !== 1) return false;
  if (dialogOpen) return false;
  return !isEditable(event.target ?? null);
}
