import assert from 'node:assert/strict';
import test from 'node:test';

import { markdownToTelegramHtml } from './telegram-markdown.js';

test('inline markdown becomes Telegram tags', () => {
  assert.equal(markdownToTelegramHtml('**bold** and `code`'), '<b>bold</b> and <code>code</code>');
  assert.equal(markdownToTelegramHtml('*italic* and ~~gone~~'), '<i>italic</i> and <s>gone</s>');
  assert.equal(markdownToTelegramHtml('# Title'), '<b>Title</b>');
  assert.equal(markdownToTelegramHtml('- one\n- two'), '• one\n• two');
});

test('raw HTML is escaped rather than interpreted', () => {
  assert.equal(markdownToTelegramHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(markdownToTelegramHtml('a < b && c > d'), 'a &lt; b &amp;&amp; c &gt; d');
});

test('fenced code keeps its body literal and carries the language', () => {
  assert.equal(
    markdownToTelegramHtml('```js\nconst a = 1 < 2;\n```'),
    '<pre><code class="language-js">const a = 1 &lt; 2;</code></pre>',
  );
});

test('links stay links and unsafe schemes are left as text', () => {
  assert.equal(
    markdownToTelegramHtml('[docs](https://example.com/?a=1&b=2)'),
    '<a href="https://example.com/?a=1&amp;b=2">docs</a>',
  );
  assert.equal(markdownToTelegramHtml('[bad](javascript:alert)'), '[bad](javascript:alert)');
});

test('empty input renders nothing', () => {
  assert.equal(markdownToTelegramHtml(''), '');
});
