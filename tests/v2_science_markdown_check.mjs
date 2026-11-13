import assert from 'node:assert/strict';
import { renderMarkdown, parseCSV } from '../apps/v2/ui/markdown.js';

const html = (src, opts) => renderMarkdown(src, opts).html;
let n = 0;
const check = (name, fn) => { fn(); n++; };

check('a citation reaches the hook with its whole DOI', () => {
  const seen = [];
  html('See ([A & B 2023](https://doi.org/10.1016/s0749-5978(02)00001-1); [C 2024, preprint](https://doi.org/10.2/y)).', { link: (href) => { seen.push(href); return null; } });
  assert.deepEqual(seen, ['https://doi.org/10.1016/s0749-5978(02)00001-1', 'https://doi.org/10.2/y']);
});

check('the hook can replace a link, and its text keeps emphasis', () => {
  const out = html('**[Ju & Aral 2026](https://doi.org/10.1/x)**', { link: (href, inner) => `<a class="in-lib" href="/paper/p1">${inner}</a>` });
  assert.equal(out, '<p><strong><a class="in-lib" href="/paper/p1">Ju &amp; Aral 2026</a></strong></p>');
});

check('markup in the source is text, never markup', () => {
  const out = html('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](https://e.com/"onmouseover="alert(1))');
  assert.ok(!/<script|<img|javascript:|onmouseover="alert/i.test(out.replace(/&lt;|&quot;/g, '')), out);
  assert.ok(out.includes('&lt;script&gt;'));
});

check('a title or alt text cannot leave its attribute', () => {
  const out = html('[a](https://e.com "x\\" onclick=\\"1") ![al"t onerror=1](https://e.com/i.png)');

  assert.ok(!/<[^>]*\son\w+=/.test(out.replace(/"[^"]*"/g, '""')), out);
});

check('document text cannot forge a held piece', () => {
  const out = html('`<b>` \u00000\u0000 and \u00001\u0000');
  assert.equal((out.match(/<code>/g) || []).length, 1, out);
});

const noHandler = (out) => assert.ok(!/<[^>]*\son\w+=/.test(out.replace(/"[^"]*"/g, '""')) && !/<a [^>]*<a /.test(out), out);
check('a bare URL cannot swallow the link after it', () => {
  noHandler(html('Files: https://osf.io/[OSF](https://osf.io/x\\ style=animation-name:spin;\\ onanimationstart=alert(1)//)'));
  noHandler(html('https://a.com/[x](https://b/onmouseover=alert(1)//)'));
  noHandler(html('<https://a.com/[x](https://b/onmouseover=alert(1)//)>'));
});

check('a nested link cannot be pasted into its own href', () => {
  noHandler(html('[[a](https://b/x\\ style=animation-name:spin;\\ onanimationstart=alert(1)//`q`)](https://c)'));
});

check('code inside link text survives', () => {
  assert.equal(html('[`foo`](https://x.com)'), '<p><a href="https://x.com" target="_blank" rel="noopener"><code>foo</code></a></p>');
});

check('a backslash path is not a same-site link', () => {
  assert.ok(!html('[Open](/\\evil.example/login)').includes('<a '));
});

check('tabs nest, two spaces break a line, a year does not start a list', () => {
  assert.equal(html('- a\n\t- b').replace(/\n/g, ''), '<ul><li>a<ul><li>b</li></ul></li></ul>');
  assert.equal(html('one  \ntwo'), '<p>one<br>\ntwo</p>');
  assert.equal(html('The effect was large.\n2024. was a good year'), '<p>The effect was large.\n2024. was a good year</p>');
});

check('dollar amounts are not math and underscores in words are not emphasis', () => {
  assert.equal(html('Tier 1 is $28 and tier 2 is $18; see team_composition_genai_review.md.'), '<p>Tier 1 is $28 and tier 2 is $18; see team_composition_genai_review.md.</p>');
});

check('nested lists, with a paragraph inside an item', () => {
  const out = html('1. One\n   - a\n   - b\n\n   more\n2. Two\n\n- x\n  1. y');
  assert.equal(out.replace(/\n/g, ''), '<ol><li>One<ul><li>a</li><li>b</li></ul><p>more</p></li><li>Two</li></ol><ul><li>x<ol><li>y</li></ol></li></ul>');
});

check('a pipe table, with alignment and an escaped pipe', () => {
  const out = html('| a | b |\n|---|--:|\n| 1 | x \\| y |');
  assert.ok(out.includes('<th style="text-align:right">b</th>') && out.includes('<td style="text-align:right">x | y</td>'), out);
});

check('headings get unique ids and are reported for the outline', () => {
  const r = renderMarkdown('# T\n\n## Scope\n\n### Scope\n\n## Scope');
  assert.deepEqual(r.headings.map((h) => [h.level, h.id]), [[1, 't'], [2, 'scope'], [3, 'scope-2'], [2, 'scope-3']]);
});

check('fenced code is kept verbatim', () => {
  assert.equal(html('```python\nx = "<b>" # **no**\n```'), '<pre><code data-lang="python">x = &quot;&lt;b&gt;&quot; # **no**</code></pre>');
});

check('CSV with quotes, commas and CRLF', () => {
  assert.deepEqual(parseCSV('a,b\r\n"x, ""q""",2\n3,\n'), [['a', 'b'], ['x, "q"', '2'], ['3', '']]);
});

console.log(`v2 science markdown: ${n} checks passed`);
