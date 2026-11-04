import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, write } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'feedbacker.mjs');

// Spawn `feedbacker mcp`, send JSON-RPC lines, collect responses and the
// review URLs it logs to stderr.
function startServer() {
  const proc = spawn(process.execPath, [BIN, 'mcp'], { env: { ...process.env, FEEDBACKER_NO_OPEN: '1' } });
  const waiting = new Map();
  const urls = [];
  let urlWaiter = null;
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  readline.createInterface({ input: proc.stderr }).on('line', (line) => {
    const m = line.match(/(http:\/\/127\.0\.0\.1\S+)/);
    if (m) { urls.push(m[1]); urlWaiter?.(); }
  });
  let nextId = 1;
  return {
    proc,
    request(method, params) {
      const id = nextId++;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((r) => waiting.set(id, r));
    },
    notify(method, params) {
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
    async nextUrl() {
      while (!urls.length) await new Promise((r) => (urlWaiter = r));
      return urls.shift();
    },
  };
}

test('mcp: initialize, list tools, review round trip', { timeout: 30_000 }, async () => {
  const a = makeRepo({ 'a.py': 'x = 1\n' }, 'alpha');
  const b = makeRepo({ 'b.go': 'package b\n' }, 'beta');
  write(a, { 'a.py': 'x = 2\n' });
  write(b, { 'c.go': 'package c\n' });

  const s = startServer();
  try {
    const init = await s.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'feedbacker');
    assert.ok(init.result.capabilities.tools);
    s.notify('notifications/initialized');

    const list = await s.request('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), ['request_review']);

    const call = s.request('tools/call', {
      name: 'request_review',
      arguments: { repos: [{ path: a }, { path: b }], summary: 'Two repos', questions: ['Ship it?'] },
    });
    const url = new URL(await s.nextUrl());
    const t = url.searchParams.get('t');
    const review = await (await fetch(`${url.origin}/api/review?t=${t}`)).json();
    assert.deepEqual(review.repos.map((r) => r.label), ['alpha', 'beta']);
    assert.deepEqual(review.repos.map((r) => r.files.map((f) => f.path)), [['a.py'], ['c.go']]);

    await fetch(`${url.origin}/api/submit?t=${t}`, {
      method: 'POST',
      body: JSON.stringify({
        verdict: 'request_changes',
        answers: [{ answer: 'Not yet' }],
        comments: [{ repo: review.repos[1].path, file: 'c.go', side: 'new', startLine: 1, endLine: 1, code: '+package c', body: 'Wrong package' }],
      }),
    });
    const res = await call;
    assert.equal(res.result.isError, undefined);
    const text = res.result.content[0].text;
    assert.match(text, /changes requested/);
    assert.match(text, /Not yet/);
    assert.match(text, /c\.go:1\*\* \(new side\)/);
    assert.match(text, /Wrong package/);
  } finally {
    s.proc.kill();
  }
});

test('mcp: errors for bad input, unknown tools and methods; cancellation', { timeout: 30_000 }, async () => {
  const clean = makeRepo({ 'a': '1\n' });
  const dirty = makeRepo({ 'a': '1\n' });
  write(dirty, { 'a': '2\n' });
  const s = startServer();
  try {
    assert.equal((await s.request('tools/call', { name: 'request_review', arguments: { repos: [] } })).result.isError, true);
    const none = await s.request('tools/call', { name: 'request_review', arguments: { repos: [{ path: clean }] } });
    assert.match(none.result.content[0].text, /No changes/);
    assert.equal((await s.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
    assert.equal((await s.request('bogus', {})).error.code, -32601);
    assert.deepEqual((await s.request('ping')).result, {});

    // A cancelled review closes its server and sends no response.
    const id = 99;
    s.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'request_review', arguments: { repos: [{ path: dirty }] } } }) + '\n');
    const url = new URL(await s.nextUrl());
    s.notify('notifications/cancelled', { requestId: id });
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(fetch(url));

    // The CLI's `list` shows a review the MCP server has open.
    const call = s.request('tools/call', { name: 'request_review', arguments: { repos: [{ path: dirty }], summary: 'Listed' } });
    const open = await s.nextUrl();
    const listed = execFileSync(process.execPath, [BIN, 'list'], { encoding: 'utf8' });
    assert.ok(listed.includes(open) && listed.includes('Listed'), listed);
    const u = new URL(open);
    await fetch(`${u.origin}/api/submit?${u.searchParams}`, { method: 'POST', body: '{"verdict":"approve"}' });
    assert.match((await call).result.content[0].text, /approved/);
    assert.match(execFileSync(process.execPath, [BIN, 'list'], { encoding: 'utf8' }), /No reviews waiting/);
  } finally {
    s.proc.kill();
  }
});
