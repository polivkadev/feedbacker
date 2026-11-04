// Core of Feedbacker: read diffs from git repos, serve the review page,
// and resolve with the user's feedback once they submit it.

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(DIR, 'page.html');
// The page's bundle (src/dist, built by build.mjs). These files hold no
// secrets, so they are served without the token. URL path -> file.
const TYPES = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const ASSETS = Object.fromEntries(
  fs.readdirSync(path.join(DIR, 'dist'), { recursive: true })
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => TYPES[path.extname(f)])
    .map((f) => ['/dist/' + f, path.join(DIR, 'dist', f)]),
);
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '-M', '--src-prefix=a/', '--dst-prefix=b/'];

function git(cwd, args, okCodes = [0]) {
  try {
    return execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (okCodes.includes(e.status)) return e.stdout;
    throw new Error((e.stderr || e.message).trim());
  }
}

// Parse `git diff` output into files with flat rows: hunk headers ('h'),
// context (' '), deletions ('-') and additions ('+'), with old/new line numbers.
export function parseDiff(text) {
  const files = [];
  let f = null, inHunk = false, o = 0, n = 0;
  const strip = (s) => s.replace(/\t$/, '');
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      f = { path: m ? m[2] : line, oldPath: m ? m[1] : '', status: 'modified', binary: false, rows: [] };
      files.push(f);
      inHunk = false;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) continue;
      o = Number(m[1]); n = Number(m[2]);
      f.rows.push({ t: 'h', s: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith('new file')) f.status = 'added';
      else if (line.startsWith('deleted file')) f.status = 'deleted';
      else if (line.startsWith('rename from ')) { f.oldPath = line.slice(12); f.status = 'renamed'; }
      else if (line.startsWith('rename to ')) f.path = line.slice(10);
      else if (line.startsWith('Binary files') || line === 'GIT binary patch') f.binary = true;
      else if (line.startsWith('--- a/')) f.oldPath = strip(line.slice(6));
      else if (line.startsWith('+++ b/')) f.path = strip(line.slice(6));
      continue;
    }
    const c = line[0], s = line.slice(1);
    if (c === ' ') f.rows.push({ t: ' ', o: o++, n: n++, s });
    else if (c === '-') f.rows.push({ t: '-', o: o++, s });
    else if (c === '+') f.rows.push({ t: '+', n: n++, s });
  }
  for (const file of files) if (file.status === 'deleted') file.path = file.oldPath;
  return files;
}

// "repo", "repo@base" or { path, base, worktrees, exact }. `exact` diffs
// against base itself instead of the fork point (session baselines, which can
// be snapshot commits that HEAD never contains).
export function parseSpec(spec) {
  if (typeof spec !== 'string') return { path: spec.path, base: spec.base || 'HEAD', worktrees: !!spec.worktrees, exact: !!spec.exact, session: !!spec.session };
  const at = spec.lastIndexOf('@');
  if (at > 0 && !fs.existsSync(spec)) return { path: spec.slice(0, at), base: spec.slice(at + 1) || 'HEAD', worktrees: false };
  return { path: spec, base: 'HEAD', worktrees: false };
}

// Paths of all worktrees (main and linked) of the repo containing `dir`,
// skipping bare repos and worktrees whose folder is gone.
export function listWorktrees(dir) {
  const out = git(path.resolve(dir), ['worktree', 'list', '--porcelain']);
  return out.split('\n\n').map((block) => {
    const lines = block.split('\n');
    const p = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!p || lines.includes('bare') || lines.some((l) => l.startsWith('prunable')) || !fs.existsSync(p)) return null;
    return p;
  }).filter(Boolean);
}

// The diff is the working tree (staged, unstaged and untracked) against the
// point where HEAD forked from base (like a merge request), or base itself
// when they share no history.
export function loadRepo(spec) {
  const { path: p, base, exact, session } = parseSpec(spec);
  const repo = { path: path.resolve(p), base, session, branch: '', files: [], error: null };
  try {
    repo.path = git(repo.path, ['rev-parse', '--show-toplevel']).trim();
    repo.branch = git(repo.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    let from = git(repo.path, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
    if (!exact) try { from = git(repo.path, ['merge-base', from, 'HEAD']).trim(); } catch {}
    let text = git(repo.path, ['diff', ...DIFF_FLAGS, from, '--']);
    const untracked = git(repo.path, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
    for (const f of untracked) {
      text += git(repo.path, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', f], [0, 1]);
    }
    repo.files = parseDiff(text);
  } catch (e) {
    repo.error = e.message;
  }
  return repo;
}

// `worktrees` (globally or per repo) expands each repo into all its worktrees,
// e.g. to review parallel agents' work together. Duplicates are dropped.
// What kind of file a path is, for the page's quick filters. Works on paths
// only, for any language: tests by folder or file-name convention, docs and
// agent instructions (CLAUDE.md, AGENTS.md), config, and generated files
// (lock files, build output, minified, snapshots, binaries).
const TEST_DIRS = /(^|\/)(tests?|__tests__|__mocks__|specs?|testdata|test-data|fixtures|e2e|testing)\//i;
const TEST_FILES = [
  /\.(test|spec|e2e|cy|stories|story)\.[^/]+$/i,      // app.test.ts, app.spec.js, x.e2e.ts, x.cy.ts, x.stories.tsx
  /(^|\/)test_[^/]+\.py$/i, /_test\.(py|go|rb|exs?|dart|cpp|cc|c|rs)$/i, // test_x.py, x_test.go
  /(Tests?|Spec|IT)\.(java|kt|kts|scala|groovy|cs|fs|vb|swift|php)$/,       // FooTest.java, FooTests.cs
  /_spec\.rb$/i, /\.t$/,                               // foo_spec.rb, Perl foo.t
];
const GENERATED = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|mix\.lock|flake\.lock|Podfile\.lock|packages\.lock\.json)$/,
  /\.min\.(js|css)$/i, /\.map$/i, /\.snap$/i, /\.lock$/i,
  /(^|\/)(dist|build|out|vendor|node_modules|generated|__generated__|\.next|target)\//,
  /\.(pb\.go|g\.dart|generated\.\w+|designer\.cs)$/i, /_pb2\.py$/,
];
const DOCS = [
  /\.(md|mdx|markdown|rst|adoc|txt|org)$/i,
  /(^|\/)(docs?|documentation)\//i,
  /(^|\/)(LICEN[CS]E|COPYING|NOTICE|AUTHORS|CHANGELOG|CHANGES|CODEOWNERS)(\.\w+)?$/i,
];
const CONFIG = [
  /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|properties|env|editorconfig|xml|plist)$/i,
  /(^|\/)\.[^/]+$/,                                     // dotfiles: .gitignore, .npmrc, .eslintrc
  /(^|\/)\.(github|gitlab|circleci|vscode|idea|devcontainer|husky)\//,
  /(^|\/)(Dockerfile|Containerfile|docker-compose[^/]*|Makefile|Justfile|Procfile|Brewfile)$/i,
];

export function classifyFile(file) {
  const p = file.path || '';
  if (file.binary) return 'generated';
  if (GENERATED.some((re) => re.test(p))) return 'generated';
  if (TEST_DIRS.test(p) || TEST_FILES.some((re) => re.test(p))) return 'test';
  if (DOCS.some((re) => re.test(p))) return 'docs';
  if (CONFIG.some((re) => re.test(p))) return 'config';
  return 'code';
}

// The agent's pointers to what matters: [{ path, repo?, startLine?, endLine?,
// note }]. `path` is relative to its repo or absolute. Each match is attached
// to its file; review.focus keeps them in the agent's order for the page.
function attachFocus(repos, focus) {
  const out = [];
  for (const raw of Array.isArray(focus) ? focus : []) {
    const item = typeof raw === 'string' ? { path: raw } : raw || {};
    const note = typeof item.note === 'string' ? item.note : '';
    const want = String(item.path || '').replace(/^\.\//, '');
    if (!want) continue;
    const startLine = Number(item.startLine) || 0;
    const endLine = Number(item.endLine) || startLine;
    let hit = null;
    repos.forEach((repo, ri) => {
      if (hit || (item.repo && path.resolve(item.repo) !== repo.path && path.basename(repo.path) !== item.repo)) return;
      const rel = path.isAbsolute(want) ? path.relative(repo.path, want) : want;
      const fi = repo.files.findIndex((f) => f.path === rel || f.oldPath === rel);
      if (fi >= 0) hit = { ri, fi };
    });
    // Matched entries show the repo-relative path, however the agent wrote it.
    const shown = hit ? repos[hit.ri].files[hit.fi].path : want;
    const entry = { path: shown, note, startLine, endLine, ...(hit || { ri: -1, fi: -1 }) };
    if (hit) (repos[hit.ri].files[hit.fi].focus ||= []).push({ note, startLine, endLine });
    out.push(entry);
  }
  return out;
}

export function buildReview({ repos = ['.'], summary = '', questions = [], focus = [], worktrees = false }) {
  const specs = [];
  for (const raw of repos) {
    const spec = parseSpec(raw);
    let paths = [spec.path];
    if (spec.worktrees || worktrees) {
      try { paths = listWorktrees(spec.path); } catch {} // not a repo: loadRepo reports it
    }
    for (const p of paths) specs.push({ path: p, base: spec.base, exact: spec.exact, session: spec.session });
  }
  const seen = new Set();
  const loaded = specs.map(loadRepo).filter((r) => !seen.has(r.path) && seen.add(r.path));
  const name = (r) => path.basename(r.path);
  for (const r of loaded) {
    // Short label for the UI; add the parent folder when two repos share a name.
    r.label = loaded.filter((x) => name(x) === name(r)).length > 1
      ? path.join(path.basename(path.dirname(r.path)), name(r))
      : name(r);
  }
  for (const r of loaded) for (const f of r.files) f.kind = classifyFile(f);
  return { summary, questions, repos: loaded, focus: attachFocus(loaded, focus) };
}

export function hasChanges(review) {
  return review.repos.some((r) => r.files.length);
}

export function toMarkdown(review, fb) {
  const out = ['# Review feedback', '', `Verdict: **${fb.verdict === 'approve' ? 'approved' : 'changes requested'}**`, ''];
  // What the user actually saw, so the agent knows what the verdict covers
  // (a hook may have filled in bases or added repos).
  out.push('Reviewed:', '');
  for (const r of review.repos) {
    const names = r.files.slice(0, 10).map((f) => f.path).filter(Boolean).join(', ') + (r.files.length > 10 ? ', …' : '');
    const what = r.error ? `could not be read (${r.error})`
      : `${r.files.length} file${r.files.length === 1 ? '' : 's'} changed${names ? ` (${names})` : ''}`;
    out.push(`- ${r.path}${r.branch && r.branch !== 'HEAD' ? ` (${r.branch})` : ''}: ${what}, ${describeBase(r)}`);
  }
  out.push('');
  if (fb.general.trim()) out.push('## General', '', fb.general.trim(), '');
  const questions = fb.comments.filter((c) => c.kind === 'question');
  const comments = fb.comments.filter((c) => c.kind !== 'question');
  const byRepo = (list) => {
    for (const repo of review.repos) {
      const cs = list.filter((c) => c.repo === repo.path);
      if (!cs.length) continue;
      out.push(`### ${repo.path}`, '');
      for (const c of cs) {
        const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        out.push(`**${c.file}:${lines}** (${c.side} side)`, '', '```diff', c.code, '```', '', c.body.trim(), '');
      }
    }
  };
  if (questions.length) {
    out.push('## Questions from the reviewer', '',
      'The reviewer asks about this code. Answer each one in your reply. Change code only where a question shows something is wrong, and say so.', '');
    byRepo(questions);
  }
  if (comments.length) {
    out.push('## Comments', '');
    byRepo(comments);
  }
  if (fb.answers.length) {
    out.push('## Answers to your questions', '');
    for (const a of fb.answers) out.push(`**Q: ${a.question}**`, '', a.answer.trim() || '_(no answer)_', '');
  }
  if (!fb.comments.length && !fb.general.trim() && !fb.answers.some((a) => a.answer.trim())) {
    out.push('_No comments._', '');
  }
  return out.join('\n');
}

export function describeBase(r) {
  if (r.session) return 'changes since the session started';
  if (r.base === 'HEAD') return 'uncommitted changes';
  return `compared with ${/^[0-9a-f]{40}$/.test(r.base) ? r.base.slice(0, 10) : r.base}`;
}

// Keep only the fields we expect from the browser, with safe defaults.
export function normalizeFeedback(review, fb) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const answers = review.questions.map((question, i) => ({ question, answer: str(fb.answers?.[i]?.answer) }));
  const comments = (Array.isArray(fb.comments) ? fb.comments : []).map((c) => ({
    repo: str(c.repo), file: str(c.file), side: c.side === 'old' ? 'old' : 'new',
    startLine: Number(c.startLine) || 0, endLine: Number(c.endLine) || 0, code: str(c.code), body: str(c.body),
    kind: c.kind === 'question' ? 'question' : 'comment',
  }));
  return { verdict: fb.verdict === 'approve' ? 'approve' : 'request_changes', general: str(fb.general), answers, comments };
}

export function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {}
}

// Each open review leaves a small file here, so `feedbacker list` can show its
// URL when the browser didn't open (MCP clients often hide the server's stderr).
export function stateDir() {
  return process.env.FEEDBACKER_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'feedbacker');
}

export function listReviews() {
  let names = [];
  try { names = fs.readdirSync(stateDir()).filter((n) => n.endsWith('.json')); } catch {}
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  return names.flatMap((n) => {
    const file = path.join(stateDir(), n);
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (alive(r.pid)) return [r];
      fs.rmSync(file, { force: true }); // left behind by a killed process
    } catch {}
    return [];
  }).sort((a, b) => a.started.localeCompare(b.started));
}

// Serve the review on 127.0.0.1 and resolve `feedback` when the user submits.
// Returns { url, feedback, close }.
export function startReview(review, { port = 0, open = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const page = fs.readFileSync(PAGE);
  const stateFile = path.join(stateDir(), `${process.pid}-${token.slice(0, 8)}.json`);
  const cleanup = () => fs.rmSync(stateFile, { force: true });
  let resolve;
  const feedback = new Promise((r) => (resolve = r));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // Static assets are public; everything else needs the token.
    const asset = req.method === 'GET' && Object.hasOwn(ASSETS, url.pathname) && ASSETS[url.pathname];
    if (asset) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(asset)], 'cache-control': 'no-cache' }).end(fs.readFileSync(asset));
      return;
    }
    if (url.searchParams.get('t') !== token) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    } else if (req.method === 'GET' && url.pathname === '/api/review') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(review));
    } else if (req.method === 'POST' && url.pathname === '/api/submit') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let fb;
        try {
          fb = normalizeFeedback(review, JSON.parse(body));
        } catch {
          res.writeHead(400).end('Bad JSON');
          return;
        }
        res.on('finish', close);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        resolve(fb);
      });
    } else {
      res.writeHead(404).end('Not found');
    }
  });

  function close() {
    server.close();
    server.closeAllConnections?.();
    cleanup();
    process.off('exit', cleanup);
  }

  return new Promise((ok, fail) => {
    server.on('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      try {
        fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
        const repos = review.repos.map((r) => r.path);
        fs.writeFileSync(stateFile, JSON.stringify({ url, pid: process.pid, started: new Date().toISOString(), summary: review.summary, repos }), { mode: 0o600 });
        process.on('exit', cleanup);
      } catch {}
      if (open) openBrowser(url);
      ok({ url, feedback, close });
    });
  });
}
