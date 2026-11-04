import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildReview, hasChanges, listReviews, loadRepo, normalizeFeedback, parseDiff, startReview, toMarkdown } from '../src/core.mjs';
import { commit, makeRepo, sh, write } from './helpers.mjs';

test('parseDiff: line numbers, hunks, statuses', () => {
  const files = parseDiff([
    'diff --git a/a.js b/a.js',
    'index 1..2 100644',
    '--- a/a.js',
    '+++ b/a.js',
    '@@ -1,3 +1,3 @@ fn',
    ' one',
    '-two',
    '+TWO',
    ' three',
    '@@ -10,1 +10,2 @@',
    ' ten',
    '+eleven',
    '\\ No newline at end of file',
    'diff --git a/gone.txt b/gone.txt',
    'deleted file mode 100644',
    '--- a/gone.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ',
    '',
  ].join('\n'));
  assert.equal(files.length, 3);
  const [a, gone, img] = files;
  assert.equal(a.path, 'a.js');
  assert.deepEqual(a.rows.map((r) => [r.t, r.o, r.n]), [
    ['h', undefined, undefined], [' ', 1, 1], ['-', 2, undefined], ['+', undefined, 2], [' ', 3, 3],
    ['h', undefined, undefined], [' ', 10, 10], ['+', undefined, 11],
  ]);
  assert.equal(gone.status, 'deleted');
  assert.equal(gone.path, 'gone.txt');
  assert.equal(img.binary, true);
});

test('loadRepo: staged, unstaged, untracked, deleted and renamed files', () => {
  const dir = makeRepo({ 'a.txt': 'a\nb\nc\n', 'old.txt': 'x\ny\nz\nw\n', 'del.txt': 'gone\n', 'staged.txt': '1\n' });
  write(dir, { 'a.txt': 'a\nB\nc\n', 'new file.txt': 'hello\n', 'staged.txt': '1\n2\n' });
  sh(dir, 'add', 'staged.txt');
  fs.unlinkSync(path.join(dir, 'del.txt'));
  sh(dir, 'mv', 'old.txt', 'renamed.txt');

  const repo = loadRepo(dir);
  assert.equal(repo.error, null);
  const byPath = Object.fromEntries(repo.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['a.txt', 'del.txt', 'new file.txt', 'renamed.txt', 'staged.txt']);
  assert.equal(byPath['a.txt'].status, 'modified');
  assert.equal(byPath['del.txt'].status, 'deleted');
  assert.equal(byPath['new file.txt'].status, 'added');
  assert.deepEqual(byPath['new file.txt'].rows.filter((r) => r.t === '+').map((r) => [r.n, r.s]), [[1, 'hello']]);
  assert.equal(byPath['renamed.txt'].status, 'renamed');
  assert.equal(byPath['renamed.txt'].oldPath, 'old.txt');
  assert.ok(byPath['staged.txt'].rows.some((r) => r.t === '+' && r.s === '2'));
});

test('loadRepo: base commit includes committed changes; subfolder resolves to repo root', () => {
  const dir = makeRepo({ 'src/x.js': 'let x = 1;\n' });
  write(dir, { 'src/x.js': 'let x = 2;\n' });
  commit(dir);
  assert.equal(loadRepo(dir).files.length, 0); // nothing uncommitted
  const repo = loadRepo(path.join(dir, 'src') + '@HEAD~1');
  assert.equal(repo.path, fs.realpathSync(dir));
  assert.equal(repo.base, 'HEAD~1');
  assert.equal(repo.files[0].path, 'src/x.js');
  assert.deepEqual(loadRepo({ path: dir, base: 'main~1' }).files.map((f) => f.path), ['src/x.js']);
});

test('loadRepo: errors for non-repos and bad bases', () => {
  const dir = makeRepo({ 'a': '1\n' });
  assert.match(loadRepo(path.dirname(dir)).error, /not a git repository/i);
  assert.ok(loadRepo(dir + '@nope').error);
});

test('buildReview: several repos, labels disambiguated', () => {
  const a = makeRepo({ 'a': '1\n' }, 'app');
  const b = makeRepo({ 'b': '1\n' }, 'app');
  const c = makeRepo({ 'c': '1\n' }, 'lib');
  write(a, { 'a': '2\n' });
  const review = buildReview({ repos: [a, b, c], summary: 's', questions: ['q?'] });
  assert.equal(review.repos.length, 3);
  assert.notEqual(review.repos[0].label, review.repos[1].label);
  assert.equal(review.repos[2].label, 'lib');
  assert.equal(hasChanges(review), true);
  assert.equal(hasChanges(buildReview({ repos: [b, c] })), false);
});

test('toMarkdown: verdict, general, answers, comments grouped by repo', () => {
  const review = { questions: ['Configurable?'], repos: [{ path: '/r/one' }, { path: '/r/two' }] };
  const fb = normalizeFeedback(review, {
    verdict: 'request_changes',
    general: 'Nice overall.',
    answers: [{ answer: 'Yes, via env.' }],
    comments: [
      { repo: '/r/two', file: 'b.ts', side: 'new', startLine: 3, endLine: 5, code: '+x', body: 'Rename x' },
      { repo: '/r/one', file: 'a.ts', side: 'old', startLine: 7, endLine: 7, code: '-y', body: 'Why removed?' },
    ],
  });
  const md = toMarkdown(review, fb);
  assert.match(md, /Verdict: \*\*changes requested\*\*/);
  assert.match(md, /## General\n\nNice overall\./);
  assert.match(md, /\*\*Q: Configurable\?\*\*\n\nYes, via env\./);
  assert.ok(md.indexOf('### /r/one') < md.indexOf('### /r/two'));
  assert.match(md, /\*\*b\.ts:3-5\*\* \(new side\)\n\n```diff\n\+x\n```\n\nRename x/);
  assert.match(md, /\*\*a\.ts:7\*\* \(old side\)/);
  assert.match(toMarkdown({ questions: [], repos: [] }, normalizeFeedback({ questions: [] }, { verdict: 'approve' })), /approved[\s\S]*_No comments\._/);
});

test('normalizeFeedback: drops unknown fields and coerces types', () => {
  const fb = normalizeFeedback({ questions: ['a', 'b'] }, { verdict: 'whatever', answers: [{ answer: 5 }], comments: [{ body: 'x', startLine: '3', evil: 1 }] });
  assert.equal(fb.verdict, 'request_changes');
  assert.deepEqual(fb.answers, [{ question: 'a', answer: '' }, { question: 'b', answer: '' }]);
  assert.deepEqual(Object.keys(fb.comments[0]).sort(), ['body', 'code', 'endLine', 'file', 'repo', 'side', 'startLine']);
  assert.equal(fb.comments[0].startLine, 3);
});

test('startReview: token required, serves page, review and vendor files, resolves on submit', async () => {
  const dir = makeRepo({ 'a.js': 'const a = 1;\n' });
  write(dir, { 'a.js': 'const a = 2;\n' });
  const review = buildReview({ repos: [dir], questions: ['Ok?'] });
  const { url, feedback } = await startReview(review, { open: false });
  const u = new URL(url);
  assert.equal(u.hostname, '127.0.0.1');
  const t = u.searchParams.get('t');
  assert.deepEqual(listReviews().map((r) => r.url), [url]);

  assert.equal((await fetch(u.origin + '/')).status, 403);
  assert.equal((await fetch(u.origin + '/api/review?t=wrong')).status, 403);
  assert.match(await (await fetch(url)).text(), /<title>Feedbacker review<\/title>/);
  assert.equal((await fetch(u.origin + '/vendor/highlight.min.js')).status, 200);
  assert.equal((await fetch(u.origin + '/vendor/../core.mjs')).status, 403);
  const data = await (await fetch(`${u.origin}/api/review?t=${t}`)).json();
  assert.equal(data.repos[0].files[0].path, 'a.js');
  assert.equal((await fetch(`${u.origin}/api/submit?t=${t}`, { method: 'POST', body: '{' })).status, 400);

  const res = await fetch(`${u.origin}/api/submit?t=${t}`, {
    method: 'POST',
    body: JSON.stringify({ verdict: 'approve', general: 'lgtm', answers: [{ answer: 'yes' }], comments: [] }),
  });
  assert.equal(res.status, 200);
  const fb = await feedback;
  assert.equal(fb.verdict, 'approve');
  assert.equal(fb.answers[0].answer, 'yes');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(listReviews(), []);
  await assert.rejects(fetch(url), 'server closed after submit');
});

test('listReviews: prunes files left by dead processes', () => {
  const dir = process.env.FEEDBACKER_STATE_DIR;
  fs.writeFileSync(path.join(dir, 'dead.json'), JSON.stringify({ url: 'x', pid: 2 ** 22 + 1, started: '' }));
  assert.deepEqual(listReviews(), []);
  assert.equal(fs.existsSync(path.join(dir, 'dead.json')), false);
});

test('worktrees: a worktree path is its own repo; --worktrees expands and dedupes', () => {
  const main = makeRepo({ 'a.txt': 'base\n' }, 'proj');
  const wt1 = path.join(path.dirname(main), 'proj-agent1');
  const wt2 = path.join(path.dirname(main), 'proj-agent2');
  sh(main, 'worktree', 'add', '-q', '-b', 'agent1', wt1);
  sh(main, 'worktree', 'add', '-q', '-b', 'agent2', wt2);
  write(wt1, { 'a.txt': 'agent one\n' });
  write(wt2, { 'b.txt': 'agent two\n' });
  commit(wt2, 'agent two work');

  const one = loadRepo(wt1);
  assert.equal(one.path, fs.realpathSync(wt1));
  assert.equal(one.branch, 'agent1');
  assert.deepEqual(one.files.map((f) => f.path), ['a.txt']);

  // From any worktree, against main: all three, each with its own changes,
  // committed work included; passing a worktree twice doesn't duplicate it.
  const review = buildReview({ repos: [wt1 + '@main', wt2 + '@main'], worktrees: true });
  assert.deepEqual(review.repos.map((r) => r.branch), ['main', 'agent1', 'agent2']);
  assert.deepEqual(review.repos.map((r) => r.files.map((f) => f.path)), [[], ['a.txt'], ['b.txt']]);
  assert.deepEqual(review.repos.map((r) => r.label), ['proj', 'proj-agent1', 'proj-agent2']);

  // Per-repo flag (as the MCP tool passes it) does the same.
  assert.equal(buildReview({ repos: [{ path: main, base: 'main', worktrees: true }] }).repos.length, 3);

  // A removed worktree folder is skipped.
  fs.rmSync(wt1, { recursive: true });
  assert.equal(buildReview({ repos: [main], worktrees: true }).repos.length, 2);
});

test('base branch: diff starts at the fork point, so later commits on base are not shown reversed', () => {
  const dir = makeRepo({ 'shared.txt': '1\n' });
  sh(dir, 'checkout', '-q', '-b', 'feature');
  write(dir, { 'feature.txt': 'mine\n' });
  commit(dir, 'feature');
  sh(dir, 'checkout', '-q', 'main');
  write(dir, { 'shared.txt': '2\n' });
  commit(dir, 'main moved on');
  sh(dir, 'checkout', '-q', 'feature');
  assert.deepEqual(loadRepo(dir + '@main').files.map((f) => f.path), ['feature.txt']);
});
