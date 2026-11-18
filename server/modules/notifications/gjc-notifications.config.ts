/**
 * The app and the CLI share `config.yml`, and the CLI owns its schema. Importing
 * the SDK here is not an option: its `exports` map points at TypeScript sources
 * under `node_modules`, and Node refuses to strip types there, which takes the
 * whole server down at import time. So this module edits the one block the app
 * is responsible for, textually, and refuses the write unless the result reads
 * back as exactly the tree that was intended. Everything outside the
 * `notifications` block keeps its original bytes, comments included.
 */

export type YamlNode = string | number | boolean | null | YamlNode[] | { [key: string]: YamlNode };
export type YamlMap = { [key: string]: YamlNode };

const SOUNDS = ['all', 'important', 'none'] as const;
const VERBOSITIES = ['lean', 'verbose'] as const;
const SCOPES = ['all', 'primary'] as const;

export type GjcNotificationView = {
  enabled: boolean;
  telegram: {
    enabled: boolean;
    hasBotToken: boolean;
    chatId: string;
    sound: (typeof SOUNDS)[number];
    rich: boolean;
    richDraft: boolean;
    streaming: boolean;
    toolActivity: boolean;
  };
  redact: boolean;
  verbosity: (typeof VERBOSITIES)[number];
  sessionScope: (typeof SCOPES)[number];
};

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const PLAIN_STRING = /^[A-Za-z_][A-Za-z0-9_./-]*$/;

const isIgnorable = (line: string): boolean => {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

const splitLines = (text: string): string[] => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
};

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
};

const parseScalar = (raw: string): YamlNode => {
  const value = raw.trim();
  if (value === '' || value === '~' || value.toLowerCase() === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '{}') return {};
  if (value === '[]') return [];
  if (/^-?\d+$/.test(value)) return Number(value);
  return unquote(value);
};

type Parsed = { node: YamlNode; next: number };

const parseSequence = (lines: string[], start: number, end: number, indent: number): Parsed => {
  const items: YamlNode[] = [];
  let index = start;
  while (index < end) {
    const line = lines[index];
    if (isIgnorable(line)) {
      index += 1;
      continue;
    }
    if (indentOf(line) !== indent || !line.trimStart().startsWith('- ')) break;
    const item = line.trimStart().slice(2).trim();
    // Sequences of maps are outside what this writer can reproduce, so they are
    // marked rather than flattened: a later write then fails the round-trip check
    // instead of silently turning a mapping into a string.
    items.push(/:(\s|$)/.test(item) || item.startsWith('- ') ? { unrepresentable: item } : parseScalar(item));
    index += 1;
  }
  return { node: items, next: index };
};

const parseMap = (lines: string[], start: number, end: number, indent: number): YamlMap => {
  const map: YamlMap = {};
  let index = start;
  while (index < end) {
    const line = lines[index];
    if (isIgnorable(line)) {
      index += 1;
      continue;
    }
    if (indentOf(line) < indent) break;
    if (indentOf(line) > indent) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();
    const colon = trimmed.indexOf(':');
    if (colon <= 0) {
      index += 1;
      continue;
    }
    const key = unquote(trimmed.slice(0, colon));
    const rest = trimmed.slice(colon + 1).trim();
    if (rest !== '') {
      map[key] = parseScalar(rest);
      index += 1;
      continue;
    }
    const parsed = parseChild(lines, index + 1, end, indent);
    map[key] = parsed.node;
    index = parsed.next;
  }
  return map;
};

const parseChild = (lines: string[], start: number, end: number, parentIndent: number): Parsed => {
  let index = start;
  while (index < end && isIgnorable(lines[index])) index += 1;
  if (index >= end || indentOf(lines[index]) <= parentIndent) return { node: null, next: index };

  const childIndent = indentOf(lines[index]);
  if (lines[index].trimStart().startsWith('- ')) return parseSequence(lines, index, end, childIndent);

  let stop = index;
  while (stop < end) {
    if (isIgnorable(lines[stop])) {
      stop += 1;
      continue;
    }
    if (indentOf(lines[stop]) <= parentIndent) break;
    stop += 1;
  }
  return { node: parseMap(lines, index, stop, childIndent), next: stop };
};

const quoteKey = (key: string): string => (PLAIN_KEY.test(key) ? key : `"${key.replace(/"/g, '\\"')}"`);

const formatScalar = (value: YamlNode): string => {
  if (value === null) return '';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return '[]';
  if (typeof value === 'object') return '{}';
  return PLAIN_STRING.test(value) && value !== 'true' && value !== 'false' ? value : `'${value.replace(/'/g, "''")}'`;
};

const emitMap = (map: YamlMap, indent: number): string[] => {
  const lines: string[] = [];
  const pad = ' '.repeat(indent);
  for (const [key, value] of Object.entries(map)) {
    if (value === null) {
      lines.push(`${pad}${quoteKey(key)}:`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${pad}${quoteKey(key)}: []`);
        continue;
      }
      lines.push(`${pad}${quoteKey(key)}:`);
      for (const item of value) lines.push(`${' '.repeat(indent + 2)}- ${formatScalar(item)}`);
      continue;
    }
    if (typeof value === 'object') {
      if (Object.keys(value).length === 0) {
        lines.push(`${pad}${quoteKey(key)}: {}`);
        continue;
      }
      lines.push(`${pad}${quoteKey(key)}:`);
      lines.push(...emitMap(value, indent + 2));
      continue;
    }
    lines.push(`${pad}${quoteKey(key)}: ${formatScalar(value)}`);
  }
  return lines;
};

const findNotificationsBlock = (lines: string[]): { start: number; end: number } | null => {
  const start = lines.findIndex((line) => /^notifications:\s*(?:#.*)?$/.test(line));
  if (start === -1) return null;

  let last = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isIgnorable(lines[index])) continue;
    if (indentOf(lines[index]) === 0) break;
    last = index;
  }
  return { start, end: last + 1 };
};

export function readNotificationsFromYaml(text: string): YamlMap {
  const lines = splitLines(text);
  const block = findNotificationsBlock(lines);
  if (!block) return {};

  const body = lines.slice(block.start + 1, block.end);
  const first = body.find((line) => !isIgnorable(line));
  if (first === undefined) return {};
  return parseMap(body, 0, body.length, indentOf(first));
}

export function writeNotificationsToYaml(text: string, notifications: YamlMap): string {
  const lines = splitLines(text);
  const block = findNotificationsBlock(lines);
  const emitted = emitMap({ notifications }, 0);
  const next = block
    ? [...lines.slice(0, block.start), ...emitted, ...lines.slice(block.end)]
    : [...lines, ...emitted];
  const candidate = `${next.join('\n').trimEnd()}\n`;

  // A rewrite is only safe if it reads back as the tree that was intended; an
  // unexpected shape (a sequence of maps, say) leaves config.yml untouched.
  if (JSON.stringify(readNotificationsFromYaml(candidate)) !== JSON.stringify(notifications)) {
    throw new Error('config.yml notifications block would not survive a rewrite');
  }
  return candidate;
}

const asMap = (value: YamlNode | undefined): YamlMap =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

const asBoolean = (value: YamlNode | undefined, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

const asText = (value: YamlNode | undefined, fallback = ''): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return fallback;
};

const asChoice = <T extends string>(value: YamlNode | undefined, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;

export function notificationView(notifications: YamlMap): GjcNotificationView {
  const telegram = asMap(notifications.telegram);
  return {
    enabled: asBoolean(notifications.enabled, false),
    telegram: {
      enabled: asBoolean(telegram.enabled, false),
      hasBotToken: asText(telegram.botToken).trim().length > 0,
      chatId: asText(telegram.chatId),
      sound: asChoice(telegram.sound, SOUNDS, 'all'),
      rich: asBoolean(asMap(telegram.rich).enabled, true),
      richDraft: asBoolean(asMap(telegram.richDraft).enabled, false),
      streaming: asBoolean(asMap(telegram.streaming).enabled, true),
      toolActivity: asBoolean(asMap(telegram.toolActivity).enabled, false),
    },
    redact: asBoolean(notifications.redact, false),
    verbosity: asChoice(notifications.verbosity, VERBOSITIES, 'lean'),
    sessionScope: asChoice(notifications.sessionScope, SCOPES, 'all'),
  };
}

/** The stored credentials, for the one caller that has to make a request. */
export function telegramCredentials(notifications: YamlMap): { botToken: string; chatId: string } {
  const telegram = asMap(notifications.telegram);
  return { botToken: asText(telegram.botToken).trim(), chatId: asText(telegram.chatId).trim() };
}

export function applyNotificationPatch(notifications: YamlMap, input: unknown): YamlMap {
  const next: YamlMap = structuredClone(notifications);
  const patch = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};

  const setPath = (keys: string[], value: YamlNode): void => {
    let node = next;
    for (const key of keys.slice(0, -1)) {
      const child = asMap(node[key]);
      node[key] = child;
      node = child;
    }
    node[keys[keys.length - 1]] = value;
  };

  if (typeof patch.enabled === 'boolean') setPath(['enabled'], patch.enabled);
  if (typeof patch.redact === 'boolean') setPath(['redact'], patch.redact);
  if (typeof patch.verbosity === 'string' && (VERBOSITIES as readonly string[]).includes(patch.verbosity)) {
    setPath(['verbosity'], patch.verbosity);
  }
  if (typeof patch.sessionScope === 'string' && (SCOPES as readonly string[]).includes(patch.sessionScope)) {
    setPath(['sessionScope'], patch.sessionScope);
  }

  const channel = patch.telegram;
  if (channel === null || typeof channel !== 'object' || Array.isArray(channel)) return next;
  const telegram = channel as Record<string, unknown>;

  if (typeof telegram.enabled === 'boolean') setPath(['telegram', 'enabled'], telegram.enabled);
  if (typeof telegram.chatId === 'string') setPath(['telegram', 'chatId'], telegram.chatId.trim());
  // A blank token means "keep the stored one", so the masked field the browser
  // rendered as empty never erases a saved secret.
  if (typeof telegram.botToken === 'string' && telegram.botToken.trim().length > 0) {
    setPath(['telegram', 'botToken'], telegram.botToken.trim());
  }
  if (typeof telegram.sound === 'string' && (SOUNDS as readonly string[]).includes(telegram.sound)) {
    setPath(['telegram', 'sound'], telegram.sound);
  }
  for (const key of ['rich', 'richDraft', 'streaming', 'toolActivity'] as const) {
    const value = telegram[key];
    if (typeof value === 'boolean') setPath(['telegram', key, 'enabled'], value);
  }
  return next;
}
