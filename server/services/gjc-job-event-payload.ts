/**
 * Keeps a projected job event inside the native jobs authority frame.
 *
 * `gajae-core jobs` speaks a strict 64 KiB NDJSON protocol and the server's
 * jobs client refuses an oversized frame before it reaches that process.
 * Worker output has no such ceiling: one `read` or `bash` result can be
 * megabytes, and when such a result was appended as a durable event the
 * rejection latched a persistence failure and failed an otherwise finished
 * turn. The authority stores a bounded preview instead - the same tradeoff the
 * chat transport already makes for tool output - while the provider transcript
 * remains the full record.
 */
const MARKER_RESERVE_BYTES = 64;
const MIN_PREVIEW_BYTES = 256;

/** 64 KiB frame minus room for the envelope: ids, lease, method, request id. */
export const JOB_EVENT_PAYLOAD_BUDGET_BYTES = 63 * 1024;

type StringHolder = {
  bytes: number;
  /** Replace the string with at most `maxBytes` of its own bytes; returns the new size. */
  replace: (maxBytes: number) => number;
};

function isUtf8ContinuationByte(value: number | undefined): boolean {
  return value !== undefined && (value & 0xc0) === 0x80;
}

function utf8SafeHeadEnd(source: Buffer, requestedEnd: number): number {
  let end = Math.min(Math.max(0, requestedEnd), source.length);
  while (end > 0 && end < source.length && isUtf8ContinuationByte(source[end])) end -= 1;
  return end;
}

function utf8SafeTailStart(source: Buffer, requestedStart: number): number {
  let start = Math.min(Math.max(0, requestedStart), source.length);
  while (start < source.length && isUtf8ContinuationByte(source[start])) start += 1;
  return start;
}

function omitted(bytes: number): string {
  return `… [${bytes} bytes omitted] …`;
}

function preview(value: string, maxBytes: number): string {
  const source = Buffer.from(value, 'utf8');
  if (source.length <= maxBytes) return value;
  if (maxBytes < MIN_PREVIEW_BYTES) return omitted(source.length);
  const headEnd = utf8SafeHeadEnd(source, Math.floor(maxBytes * 0.75));
  const tailStart = utf8SafeTailStart(source, source.length - (maxBytes - headEnd));
  if (tailStart <= headEnd) return omitted(source.length);
  return `${source.subarray(0, headEnd).toString('utf8')}\n\n${omitted(tailStart - headEnd)}\n\n${source.subarray(tailStart).toString('utf8')}`;
}

function holder(value: string, set: (next: string) => void): StringHolder {
  const bytes = Buffer.byteLength(value, 'utf8');
  return {
    bytes,
    replace: (maxBytes) => {
      const next = preview(value, maxBytes);
      const nextBytes = Buffer.byteLength(next, 'utf8');
      // Never grow a string that an earlier pass already trimmed.
      if (nextBytes >= bytes) return bytes;
      set(next);
      return nextBytes;
    },
  };
}

/** Strings carry the weight in projection events, so only they are rewritten. */
function collectStrings(root: object, out: StringHolder[]): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      node.forEach((entry, index) => {
        if (typeof entry === 'string') out.push(holder(entry, (next) => { node[index] = next; }));
        else if (entry !== null && typeof entry === 'object') stack.push(entry);
      });
    } else if (node !== null && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const entry = record[key];
        if (typeof entry === 'string') out.push(holder(entry, (next) => { record[key] = next; }));
        else if (entry !== null && typeof entry === 'object') stack.push(entry);
      }
    }
  }
}

/**
 * A payload whose bulk is not a string - a deeply nested array, thousands of
 * small records - cannot be trimmed field by field without inventing a shape
 * the consumer does not expect. Keep its `kind` and the size, drop the body.
 */
function omittedPayload(payload: unknown, bytes: number): Record<string, unknown> {
  const kind = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).kind
    : undefined;
  return {
    ...(typeof kind === 'string' ? { kind } : {}),
    truncated: true,
    bytes,
    note: omitted(bytes),
  };
}

export function boundJobEventPayload(
  payload: unknown,
  budgetBytes: number = JOB_EVENT_PAYLOAD_BUDGET_BYTES,
): unknown {
  const encoded = JSON.stringify(payload) ?? 'null';
  const size = Buffer.byteLength(encoded, 'utf8');
  if (size <= budgetBytes) return payload;

  let clone: unknown;
  try { clone = JSON.parse(encoded); } catch { return omittedPayload(payload, size); }
  if (clone === null || typeof clone !== 'object') return omittedPayload(payload, size);

  let current = encoded;
  // Trimming is proportional, so one pass usually lands inside the budget; the
  // extra passes absorb the difference between raw and JSON-escaped sizes
  // before the payload is given up entirely.
  for (let pass = 0; pass < 3; pass += 1) {
    const currentSize = Buffer.byteLength(current, 'utf8');
    if (currentSize <= budgetBytes) return clone;
    const strings: StringHolder[] = [];
    collectStrings(clone, strings);
    if (strings.length === 0) break;
    strings.sort((left, right) => right.bytes - left.bytes);
    let remaining = currentSize;
    let trimmed = false;
    for (const entry of strings) {
      if (remaining <= budgetBytes) break;
      const nextBytes = entry.replace(entry.bytes - (remaining - budgetBytes) - MARKER_RESERVE_BYTES);
      if (nextBytes < entry.bytes) {
        remaining += nextBytes - entry.bytes;
        trimmed = true;
      }
    }
    if (!trimmed) break;
    current = JSON.stringify(clone) ?? 'null';
  }
  return Buffer.byteLength(current, 'utf8') <= budgetBytes ? clone : omittedPayload(payload, size);
}
