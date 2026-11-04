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
const VENDOR = {
  'highlight.min.js': 'text/javascript',
  'github.min.css': 'text/css',
  'github-dark.min.css': 'text/css',
};
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

// Accepts a path string ("repo" or "repo@base") or { path, base }.
// The diff is the working tree (staged, unstaged and untracked) against base.
export function loadRepo(spec) {
  let p, base;
  if (typeof spec === 'string') {
    [p, base] = [spec, undefined];
    const at = spec.lastIndexOf('@');
    if (at > 0 && !fs.existsSync(spec)) [p, base] = [spec.slice(0, at), spec.slice(at + 1)];
  } else {
    ({ path: p, base } = spec);
  }
  base ||= 'HEAD';
  const repo = { path: path.resolve(p), base, files: [], error: null };
  try {
    repo.path = git(repo.path, ['rev-parse', '--show-toplevel']).trim();
    let text = git(repo.path, ['diff', ...DIFF_FLAGS, base, '--']);
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

export function buildReview({ repos = ['.'], summary = '', questions = [] }) {
  const loaded = repos.map(loadRepo);
  const name = (r) => path.basename(r.path);
  for (const r of loaded) {
    // Short label for the UI; add the parent folder when two repos share a name.
    r.label = loaded.filter((x) => name(x) === name(r)).length > 1
      ? path.join(path.basename(path.dirname(r.path)), name(r))
      : name(r);
  }
  return { summary, questions, repos: loaded };
}

export function hasChanges(review) {
  return review.repos.some((r) => r.files.length);
}

export function toMarkdown(review, fb) {
  const out = ['# Review feedback', '', `Verdict: **${fb.verdict === 'approve' ? 'approved' : 'changes requested'}**`, ''];
  if (fb.general.trim()) out.push('## General', '', fb.general.trim(), '');
  if (fb.answers.length) {
    out.push('## Answers', '');
    for (const a of fb.answers) out.push(`**Q: ${a.question}**`, '', a.answer.trim() || '_(no answer)_', '');
  }
  if (fb.comments.length) {
    out.push('## Comments', '');
    for (const repo of review.repos) {
      const cs = fb.comments.filter((c) => c.repo === repo.path);
      if (!cs.length) continue;
      out.push(`### ${repo.path}`, '');
      for (const c of cs) {
        const lines = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        out.push(`**${c.file}:${lines}** (${c.side} side)`, '', '```diff', c.code, '```', '', c.body.trim(), '');
      }
    }
  }
  if (!fb.comments.length && !fb.general.trim() && !fb.answers.some((a) => a.answer.trim())) {
    out.push('_No comments._', '');
  }
  return out.join('\n');
}

// Keep only the fields we expect from the browser, with safe defaults.
export function normalizeFeedback(review, fb) {
  const str = (v) => (typeof v === 'string' ? v : '');
  const answers = review.questions.map((question, i) => ({ question, answer: str(fb.answers?.[i]?.answer) }));
  const comments = (Array.isArray(fb.comments) ? fb.comments : []).map((c) => ({
    repo: str(c.repo), file: str(c.file), side: c.side === 'old' ? 'old' : 'new',
    startLine: Number(c.startLine) || 0, endLine: Number(c.endLine) || 0, code: str(c.code), body: str(c.body),
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
    // Vendored libraries are public; everything else needs the token.
    const asset = VENDOR[url.pathname.replace(/^\/vendor\//, '')];
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/') && asset) {
      res.writeHead(200, { 'content-type': asset, 'cache-control': 'max-age=86400' })
        .end(fs.readFileSync(path.join(DIR, 'vendor', url.pathname.slice(8))));
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
