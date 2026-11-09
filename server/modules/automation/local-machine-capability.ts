/**
 * Trusted server-side policy for the companion's opt-in `local_*` tools.
 *
 * These tools execute on the machine that runs the companion, and only exist
 * there when that companion was started with `--shell` - the launch flag
 * is the user's consent, mirrored in the companion's own allowlist
 * (`companion-rs/src/local.rs`). The server still validates every call here so
 * a buggy or compromised companion can not be talked into a shape this policy
 * does not document, and so a companion that was restarted without the flag
 * stops serving these tools on the very next call.
 *
 * There is deliberately no application identity or per-application grant for a
 * shell command: it is not scoped to a window, and the companion's opt-in plus
 * Settings' computer-use switch are the two gates.
 */

import { AgentDesktopPolicyError, guardAgentDesktopCall } from './agent-desktop-capability.js';
import { isAgentDesktopSafeTool, type AgentDesktopSafeTool } from './agent-desktop-client.js';

export const LOCAL_MACHINE_TOOLS = [
  'local_exec',
  'local_list_files',
  'local_read_file',
  'local_search',
  'local_write_file',
] as const;

export type LocalMachineTool = (typeof LOCAL_MACHINE_TOOLS)[number];
export type ComputerTool = AgentDesktopSafeTool | LocalMachineTool;

export class LocalMachinePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalMachinePolicyError';
  }
}

function deny(reason: string): never {
  throw new LocalMachinePolicyError(`local_machine_policy_denied: ${reason}`);
}

type FieldType = 'string' | 'integer' | 'boolean';

type LocalMachineToolPolicy = {
  fields: Readonly<Record<string, FieldType>>;
  required: readonly string[];
  /** Per-field hard caps, in UTF-8 bytes for strings and in value bounds for integers. */
  stringBytes?: Readonly<Record<string, number>>;
  integerRange?: Readonly<Record<string, readonly [number, number]>>;
};

const MAX_PATH_BYTES = 4096;
const MAX_COMMAND_BYTES = 32 * 1024;
const MAX_PATTERN_BYTES = 1024;
const MAX_WRITE_BYTES = 1024 * 1024;

const LOCAL_MACHINE_TOOL_POLICIES: Readonly<Record<LocalMachineTool, LocalMachineToolPolicy>> = {
  local_exec: {
    fields: { command: 'string', cwd: 'string', timeout_ms: 'integer' },
    required: ['command'],
    stringBytes: { command: MAX_COMMAND_BYTES, cwd: MAX_PATH_BYTES },
    integerRange: { timeout_ms: [1_000, 600_000] },
  },
  local_read_file: {
    fields: { path: 'string', offset: 'integer', limit: 'integer' },
    required: ['path'],
    stringBytes: { path: MAX_PATH_BYTES },
    integerRange: { offset: [1, 10_000_000], limit: [1, 5_000] },
  },
  local_write_file: {
    fields: { path: 'string', content: 'string', create_dirs: 'boolean' },
    required: ['path', 'content'],
    stringBytes: { path: MAX_PATH_BYTES, content: MAX_WRITE_BYTES },
  },
  local_list_files: {
    fields: { path: 'string', pattern: 'string', max_results: 'integer' },
    required: ['path'],
    stringBytes: { path: MAX_PATH_BYTES, pattern: MAX_PATTERN_BYTES },
    integerRange: { max_results: [1, 1_000] },
  },
  local_search: {
    fields: { path: 'string', pattern: 'string', case_sensitive: 'boolean', max_results: 'integer' },
    required: ['path', 'pattern'],
    stringBytes: { path: MAX_PATH_BYTES, pattern: MAX_PATTERN_BYTES },
    integerRange: { max_results: [1, 1_000] },
  },
};

export function isLocalMachineTool(value: unknown): value is LocalMachineTool {
  return typeof value === 'string' && (LOCAL_MACHINE_TOOLS as readonly string[]).includes(value);
}

function matchesType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
  }
}

/**
 * Rejects unknown fields, wrong types, out-of-range values, missing required
 * fields, NUL bytes, and oversized payloads. Returns the canonicalized record
 * the companion is allowed to receive.
 */
export function guardLocalMachineCall(
  tool: LocalMachineTool,
  args: Record<string, unknown>,
): { tool: LocalMachineTool; arguments: Record<string, unknown> } {
  const policy = LOCAL_MACHINE_TOOL_POLICIES[tool];
  const accepted = Object.keys(policy.fields);
  const guarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const type = policy.fields[key];
    if (!type) {
      deny(`${tool} does not document an argument named "${key}". Accepted arguments: ${accepted.join(', ')}.`);
    }
    if (!matchesType(value, type)) deny(`${tool} argument "${key}" does not match its documented type (${type}).`);
    if (typeof value === 'string') {
      if (value.includes('\u0000')) deny(`${tool} argument "${key}" contains a NUL byte.`);
      const limit = policy.stringBytes?.[key];
      if (limit !== undefined && Buffer.byteLength(value, 'utf8') > limit) {
        deny(`${tool} argument "${key}" exceeds ${limit} UTF-8 bytes.`);
      }
    }
    if (typeof value === 'number') {
      const range = policy.integerRange?.[key];
      if (range && (value < range[0] || value > range[1])) {
        deny(`${tool} argument "${key}" must be between ${range[0]} and ${range[1]}.`);
      }
    }
    guarded[key] = value;
  }
  for (const required of policy.required) {
    if (guarded[required] === undefined) {
      deny(`${tool} requires "${required}". Accepted arguments: ${accepted.join(', ')}.`);
    }
  }
  return { tool, arguments: guarded };
}

/** One policy entry point for every computer tool, desktop or local. */
export function guardComputerCall(
  tool: string,
  args: Record<string, unknown>,
): { tool: string; arguments: Record<string, unknown> } {
  if (isLocalMachineTool(tool)) return guardLocalMachineCall(tool, args);
  if (!isAgentDesktopSafeTool(tool)) throw new AgentDesktopPolicyError(`agent_desktop_policy_denied: unknown tool "${tool}".`);
  return guardAgentDesktopCall(tool, args);
}

/**
 * Whether a companion advertised this local tool in its readiness report, which
 * it only does while running with `--shell`.
 */
export function companionOffersLocalTool(
  readiness: { safeTools?: readonly string[] } | undefined,
  tool: LocalMachineTool,
): boolean {
  return Array.isArray(readiness?.safeTools) && readiness.safeTools.includes(tool);
}
