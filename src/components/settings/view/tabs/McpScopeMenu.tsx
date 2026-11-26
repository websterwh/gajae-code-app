import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, FolderGit2, Globe } from 'lucide-react';

/**
 * Where one MCP server is configured, as the multi-select row control.
 *
 * A native `<select>` can only name one destination, so using a server in the
 * global config and two projects meant adding it three times. This is a
 * checkbox menu instead: every tick is a config the server should exist in, and
 * the tick set is what the server writes.
 */
export type McpScopeTarget = { scope: 'global' } | { scope: 'project'; projectPath: string };

type ProjectSummary = { projectId: string; path: string; displayName: string };

type McpScopeMenuProps = {
  name: string;
  ariaLabel: string;
  selected: McpScopeTarget[];
  projects: ProjectSummary[];
  globalLabel: string;
  projectLabel: string;
  disabled?: boolean;
  onChange: (targets: McpScopeTarget[]) => void;
};

const keyOf = (target: McpScopeTarget): string => (
  target.scope === 'global' ? 'global' : `project:${target.projectPath}`
);

const triggerClass = 'inline-flex max-w-56 touch-manipulation items-center gap-1.5 rounded-lg border border-input bg-card px-2 py-1 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50';

export default function McpScopeMenu({
  name,
  ariaLabel,
  selected,
  projects,
  globalLabel,
  projectLabel,
  disabled,
  onChange,
}: McpScopeMenuProps) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popupId = useId();
  const checked = new Set(selected.map(keyOf));

  useEffect(() => {
    if (!open) return undefined;
    const closeForPointer = (event: MouseEvent) => {
      if (container.current && !container.current.contains(event.target as Node)) setOpen(false);
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', closeForPointer);
    document.addEventListener('keydown', closeForEscape);
    return () => {
      document.removeEventListener('mousedown', closeForPointer);
      document.removeEventListener('keydown', closeForEscape);
    };
  }, [open]);

  const labelFor = (target: McpScopeTarget): string => (
    target.scope === 'global'
      ? globalLabel
      : projects.find((project) => project.path === target.projectPath)?.displayName
        ?? target.projectPath.split('/').filter(Boolean).at(-1)
        ?? projectLabel
  );
  // The summary names the destinations rather than counting them: "Global,
  // shipping" says where the server is, which is the question this control
  // answers.
  const summary = selected.length > 0 ? selected.map(labelFor).join(', ') : projectLabel;

  const toggle = (target: McpScopeTarget) => {
    const key = keyOf(target);
    // The last tick stays: a server with no scope has nowhere to live, and
    // removing it is the row's Remove button, not an empty menu.
    if (checked.has(key) && checked.size === 1) return;
    const next = checked.has(key)
      ? selected.filter((current) => keyOf(current) !== key)
      : [...selected.filter((current) => keyOf(current) !== key), target];
    onChange(next);
  };

  const option = (target: McpScopeTarget, label: string, Icon: typeof Globe) => {
    const isChecked = checked.has(keyOf(target));
    return (
      <button
        key={keyOf(target)}
        type="button"
        role="menuitemcheckbox"
        aria-checked={isChecked}
        onClick={() => toggle(target)}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent focus:bg-accent focus:outline-hidden"
      >
        <span className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${isChecked ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>
          {isChecked && <Check className="h-3 w-3" aria-hidden />}
        </span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  };

  return (
    <div ref={container} className="relative inline-flex">
      <button
        ref={trigger}
        type="button"
        aria-label={`${ariaLabel} ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className={triggerClass}
        title={summary}
      >
        <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div
          id={popupId}
          role="menu"
          className="absolute top-full left-0 z-50 mt-1 max-h-64 min-w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          {option({ scope: 'global' }, globalLabel, Globe)}
          {projects.map((project) => option(
            { scope: 'project', projectPath: project.path },
            project.displayName,
            FolderGit2,
          ))}
        </div>
      )}
    </div>
  );
}
