/**
 * Markdown -> Telegram HTML for streamed agent output.
 *
 * Not a full parser: agent answers use a narrow markdown dialect (fenced code,
 * inline code, bold, italic, links, headings, lists). Converting exactly that
 * keeps escaping honest - Telegram's HTML mode only accepts its own tags, so
 * everything else has to be escaped, and an escape applied after formatting
 * would show `&lt;` to the reader.
 */

const FENCE = /```([\w-]*)\n([\s\S]*?)```/gu;

const escapeHtml = (text: string): string =>
  text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

const escapeAttribute = (text: string): string => escapeHtml(text).replace(/"/gu, '&quot;');

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  return /^(?:https?:\/\/|mailto:|tg:\/\/)/iu.test(trimmed) ? trimmed : null;
}

/** Inline formatting for one already-escaped line/block. */
function inlineHtml(text: string): string {
  return text
    .replace(/\*\*([^*\n]+)\*\*/gu, '<b>$1</b>')
    .replace(/__([^_\n]+)__/gu, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/gu, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_/gu, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/gu, '<s>$1</s>');
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  // Code is extracted before anything is escaped or formatted: its body is
  // literal, and the placeholders survive the inline pass untouched.
  const blocks: string[] = [];
  const placeholder = (index: number): string => `\u0000${index}\u0000`;

  let source = markdown.replace(FENCE, (_match, language: string, body: string) => {
    const lang = language ? ` class="language-${escapeAttribute(language)}"` : '';
    blocks.push(`<pre><code${lang}>${escapeHtml(body.replace(/\n$/u, ''))}</code></pre>`);
    return `\n${placeholder(blocks.length - 1)}\n`;
  });

  const inlineCode: string[] = [];
  source = source.replace(/`([^`\n]+)`/gu, (_match, body: string) => {
    inlineCode.push(`<code>${escapeHtml(body)}</code>`);
    return `\u0001${inlineCode.length - 1}\u0001`;
  });

  source = escapeHtml(source);

  // Links are matched after escaping; the label and href were escaped together,
  // so `&amp;` inside a URL stays valid in the attribute.
  source = source.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (match, label: string, url: string) => {
    const href = safeHref(url);
    return href ? `<a href="${href}">${label}</a>` : match;
  });

  const lines = source.split('\n').map((line) => {
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (heading) return `<b>${inlineHtml(heading[2])}</b>`;
    if (/^[-*+]\s+/u.test(line)) return line.replace(/^[-*+]\s+/u, '• ');
    if (/^>\s?/u.test(line)) return line.replace(/^>\s?/u, '▎ ');
    return inlineHtml(line);
  });

  return lines
    .join('\n')
    .replace(/`?([\u0000\u0001])(\w+)\1`?/gu, (_match, marker: string, value: string) => {
      // The regex captured the marker character, so look the placeholder up in
      // whichever table it belongs to.
      return marker === '\u0000'
        ? blocks[Number(value)] ?? ''
        : inlineCode[Number(value)] ?? '';
    })
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
