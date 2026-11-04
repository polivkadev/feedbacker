import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWords, escapeHtml, markRanges, wordMarks } from '../src/ui/wordDiff.js';

const cut = (s, ranges) => ranges.map(([a, b]) => s.slice(a, b));

test('diffWords: marks only the changed words', () => {
  const a = 'server.listen(port);';
  const b = 'server.listen(port, "127.0.0.1");';
  const [ra, rb] = diffWords(a, b);
  assert.deepEqual(cut(a, ra), []);
  assert.deepEqual(cut(b, rb), [', "127.0.0.1"']);

  const c = 'const timeout = 30;', d = 'const deadline = 60;';
  const [rc, rd] = diffWords(c, d);
  assert.deepEqual(cut(c, rc), ['timeout', '30']);
  assert.deepEqual(cut(d, rd), ['deadline', '60']);
});

test('diffWords: no marks for rewritten, empty or huge lines', () => {
  assert.equal(diffWords('return a + b;', 'throw new Error("nope")'), null);
  assert.equal(diffWords('', 'x'), null);
  const long = Array.from({ length: 400 }, (_, i) => 'w' + i).join(' ');
  assert.equal(diffWords(long, long + ' x'), null);
});

test('wordMarks: pairs runs of deleted and added lines in order', () => {
  const rows = [
    { t: ' ', s: 'a' },
    { t: '-', s: 'let x = 1;' }, { t: '-', s: 'let y = 2;' },
    { t: '+', s: 'let x = 10;' }, { t: '+', s: 'let y = 20;' }, { t: '+', s: 'let z = 3;' },
  ];
  const m = wordMarks(rows);
  assert.deepEqual(cut(rows[3].s, m.get(rows[3])), ['10']);
  assert.deepEqual(cut(rows[4].s, m.get(rows[4])), ['20']);
  assert.equal(m.has(rows[5]), false, 'unpaired added line');
  assert.equal(m.has(rows[0]), false);
});

test('wordMarks: pairs each deleted line with its most similar added line', () => {
  const rows = [
    { t: '-', s: '// TODO: bind host' }, { t: '-', s: 'server.listen(port);' },
    { t: '+', s: 'server.listen(config.port, config.host);' }, { t: '+', s: 'console.log(`listening on ${config.port}`);' },
  ];
  const m = wordMarks(rows);
  assert.equal(m.has(rows[0]), false, 'the TODO has no similar line');
  assert.deepEqual(cut(rows[2].s, m.get(rows[2])), ['config.', ', config.host']);
  assert.equal(m.has(rows[3]), false, 'not paired with server.listen');
});

test('markRanges: works inside highlighted HTML and with entities', () => {
  const html = '<span class="hljs-keyword">const</span> a = <span class="hljs-string">&quot;x&lt;y&quot;</span>;';
  // Text is: const a = "x<y";  mark "a" (6-7) and the string (10-15)
  const out = markRanges(html, [[6, 7], [10, 15]]);
  assert.equal(out, '<span class="hljs-keyword">const</span> <mark class="wd">a</mark> = <span class="hljs-string"><mark class="wd">&quot;x&lt;y&quot;</mark></span>;');
  // A range across a tag closes and reopens the mark.
  assert.equal(markRanges('<b>ab</b>cd', [[1, 3]]), '<b>a<mark class="wd">b</mark></b><mark class="wd">c</mark>d');
  assert.equal(markRanges(escapeHtml('a<b'), [[1, 2]]), 'a<mark class="wd">&lt;</mark>b');
  assert.equal(markRanges('abc', []), 'abc');
});
