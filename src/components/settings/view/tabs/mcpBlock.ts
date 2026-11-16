/**
 * The MCP configure form is one YAML block, not a field per key: the block is
 * the entry mcp.json holds, so a server copied from anywhere can be pasted in
 * as it is. This reads and writes just that one server's block.
 */
export type McpBlockTransport = 'stdio' | 'http' | 'sse';

export type McpBlockValue = {
  transport: McpBlockTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

export type McpBlockError = 'shape' | 'command' | 'url';

export type McpBlockResult =
  | { ok: true; value: McpBlockValue }
  | { ok: false; error: McpBlockError };

export type McpBlockSource = {
  name: string;
  transport: McpBlockTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};

const PLAIN = /^[A-Za-z0-9._/@:+-]+$/u;

// A leading `-` or `@` is a YAML indicator, not a scalar character, so those
// values are quoted even when the rest of them is plain.
const quote = (value: string): string => (
  PLAIN.test(value) && !value.startsWith('-') && !value.startsWith('@') ? value : JSON.stringify(value)
);

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * The block carries the stored values, so the form opens on what the server
 * actually runs instead of a column of blanks. A catalog variable the entry
 * does not set yet is emitted empty, and an empty value means "keep what is
 * stored", so leaving one alone never clears it.
 */
export function formatMcpBlock(server: McpBlockSource, knownEnv: string[] = []): string {
  const lines = [`${server.name}:`, `  type: ${server.transport}`];
  if (server.transport === 'stdio') {
    lines.push(`  command: ${quote(server.command ?? '')}`);
    const args = server.args ?? [];
    if (args.length) {
      lines.push('  args:');
      for (const arg of args) lines.push(`    - ${quote(arg)}`);
    } else {
      lines.push('  args: []');
    }
  } else if (server.url) {
    lines.push(`  url: ${quote(server.url)}`);
  }
  const env = server.env ?? {};
  const envKeys = [...new Set([...Object.keys(env), ...knownEnv])];
  if (envKeys.length) {
    lines.push('  env:');
    for (const key of envKeys) lines.push(`    ${key}: ${key in env ? quote(env[key] ?? '') : '""'}`);
  }
  if (server.transport !== 'stdio') {
    const headers = server.headers ?? {};
    const headerKeys = Object.keys(headers);
    if (headerKeys.length) {
      lines.push('  headers:');
      for (const key of headerKeys) lines.push(`    ${key}: ${quote(headers[key] ?? '')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

type Row =
  | { indent: number; item: string }
  | { indent: number; key: string; value: string | undefined };

export function parseMcpBlock(text: string): McpBlockResult {
  const rows: Row[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\s+$/u, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const item = /^-(?:\s(.*))?$/u.exec(content);
    if (item) {
      rows.push({ indent, item: unquote(item[1] ?? '') });
      continue;
    }
    const colon = content.indexOf(':');
    if (colon <= 0) return { ok: false, error: 'shape' };
    const key = content.slice(0, colon).trim();
    const rest = content.slice(colon + 1).trim();
    rows.push({ indent, key, value: rest ? unquote(rest) : undefined });
  }
  if (rows.length === 0) return { ok: false, error: 'shape' };

  const root = rows[0];
  if (!root || !('key' in root) || root.indent !== 0 || root.value !== undefined) return { ok: false, error: 'shape' };

  let transport: McpBlockTransport | null = null;
  let command: string | undefined;
  let url: string | undefined;
  let args: string[] | undefined;
  let env: Record<string, string> | undefined;
  let headers: Record<string, string> | undefined;

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || !('key' in row) || row.indent !== 2) continue;
    const nested: Row[] = [];
    let cursor = index + 1;
    while (cursor < rows.length) {
      const next = rows[cursor];
      if (!next || next.indent <= 2) break;
      nested.push(next);
      cursor += 1;
    }
    index = cursor - 1;

    switch (row.key.toLowerCase()) {
      case 'type':
      case 'transport': {
        const value = (row.value ?? '').toLowerCase();
        if (value === 'stdio' || value === 'http' || value === 'sse') transport = value;
        break;
      }
      case 'command':
        command = row.value ?? '';
        break;
      case 'url':
        url = row.value ?? '';
        break;
      case 'args': {
        if (row.value === '[]') {
          args = [];
          break;
        }
        args = nested.flatMap((entry) => ('item' in entry ? [entry.item] : []));
        break;
      }
      case 'env':
      case 'headers': {
        const pairs: Record<string, string> = {};
        for (const entry of nested) {
          if (!('key' in entry) || entry.value === undefined) continue;
          // An empty value is a request to keep the stored secret.
          if (!entry.value) continue;
          pairs[entry.key] = entry.value;
        }
        if (Object.keys(pairs).length) {
          if (row.key.toLowerCase() === 'env') env = pairs;
          else headers = pairs;
        }
        break;
      }
      default:
        break;
    }
  }

  const resolved = transport ?? (url ? 'http' : 'stdio');
  if (resolved === 'stdio' && !command) return { ok: false, error: 'command' };
  if (resolved !== 'stdio' && !url) return { ok: false, error: 'url' };
  return {
    ok: true,
    value: {
      transport: resolved,
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args }),
      ...(url === undefined ? {} : { url }),
      ...(env === undefined ? {} : { env }),
      ...(headers === undefined ? {} : { headers }),
    },
  };
}
