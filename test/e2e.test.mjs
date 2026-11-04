// Drives the real review page in headless Chromium (over the DevTools
// protocol, no extra dependencies) against the CLI. Skipped without Chromium.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeRepo, write } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'feedbacker.mjs');

function findChromium() {
  if (process.env.CHROMIUM) return process.env.CHROMIUM;
  for (const c of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try { return execFileSync('which', [c], { encoding: 'utf8' }).trim(); } catch {}
  }
  return null;
}

const chromium = findChromium();

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'feedbacker-chrome-'));
  const proc = spawn(chromium, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((ok, no) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\S+)/);
      if (m) ok(m[1]);
    });
    proc.on('exit', () => no(new Error('chromium exited: ' + buf)));
  });
  const port = new URL(wsUrl).port;
  const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    waiting.get(msg.id)?.(msg);
  });
  const send = (method, params = {}) => new Promise((r) => {
    waiting.set(++id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.result.exceptionDetails) throw new Error(res.result.exceptionDetails.exception?.description || 'evaluate failed');
    return res.result.result.value;
  };
  const waitFor = async (expression, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timed out waiting for ' + expression);
  };
  // Focus an element and type into it like a keyboard would.
  const type = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await send('Input.insertText', { text });
  };
  return { send, evaluate, waitFor, type, close: () => { ws.close(); proc.kill(); } };
}

test('e2e: comment, answer and submit in the browser; CLI prints the feedback', { skip: !chromium && 'no Chromium found' }, async () => {
  const a = makeRepo({ 'app.js': 'function add(a, b) {\n  return a + b;\n}\n' }, 'web');
  const b = makeRepo({ 'README.md': '# Lib\n' }, 'lib');
  write(a, { 'app.js': 'function add(a, b) {\n  // sum\n  return a + b;\n}\n' });
  write(b, { 'notes.txt': 'one\ntwo\nthree\n' });

  const cli = spawn(process.execPath, [BIN, '--no-open', a, b, '-m', 'Added a comment', '-q', 'Keep the comment?']);
  let stdout = '';
  cli.stdout.on('data', (d) => (stdout += d));
  const url = await new Promise((ok) => cli.stderr.on('data', (d) => {
    const m = String(d).match(/(http:\/\/127\.0\.0\.1\S+)/);
    if (m) ok(m[1]);
  }));
  const exited = new Promise((r) => cli.on('exit', r));

  const page = await launch();
  try {
    await page.send('Page.navigate', { url });
    await page.waitFor(`document.querySelectorAll('.file').length === 2`);

    // Highlighted, both repos, questions and summary shown.
    assert.equal(await page.evaluate(`document.getElementById('summary').textContent`), 'Added a comment');
    assert.ok(await page.evaluate(`!!document.querySelector('.file td.code [class^=hljs-]')`), 'syntax highlighting applied');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.tree .repo')].map(e => e.querySelector('.label').textContent + ' ' + e.querySelector('.branch').textContent)`), ['web main', 'lib main']);
    assert.equal(await page.evaluate(`getComputedStyle(document.querySelector('td.code')).fontFamily.includes('JetBrains Mono')`), true, 'bundled code font');

    // The repo picker narrows the page and the file tree to one repo.
    const pick = async (v) => {
      await page.evaluate(`(() => {
        const sel = document.querySelector('.picker select');
        const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        set.call(sel, ${JSON.stringify(v)});
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
    };
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.picker option')].map(o => o.textContent)`),
      ['All 2 repos', 'web on main (1 file)', 'lib on main (1 file)']);
    await pick('1');
    await page.waitFor(`document.querySelectorAll('.file').length === 1 && !!document.getElementById('f1-0')`);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('.tree .repo .label')].map(e => e.textContent)`), ['lib']);
    await pick('all');
    await page.waitFor(`document.querySelectorAll('.file').length === 2`);

    // Comment on line 2 of app.js (the added line) via the new-side gutter.
    await page.evaluate(`(() => {
      const row = [...document.querySelectorAll('#f0-0 tr')].find(tr => tr.children[1]?.textContent === '2');
      row.children[1].click();
    })()`);
    await page.waitFor(`!!document.querySelector('tr.comment textarea')`);
    await page.type('tr.comment textarea', 'Drop this comment');
    await page.evaluate(`document.querySelector('tr.comment button.primary').click()`);
    await page.waitFor(`document.querySelector('tr.comment .cbody')?.textContent === 'Drop this comment'`);

    // Range comment on lines 1-3 of notes.txt with shift-click.
    await page.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#f1-0 tr')];
      const cell = (n) => rows.find(tr => tr.children[1]?.textContent === String(n)).children[1];
      cell(1).click();
      cell(3).dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    })()`);
    await page.waitFor(`!!document.querySelector('#f1-0 tr.comment textarea')`);
    await page.type('#f1-0 tr.comment textarea', 'Whole file is odd');
    await page.evaluate(`document.querySelector('#f1-0 tr.comment button.primary').click()`);
    await page.waitFor(`document.querySelectorAll('tr.comment .cbody').length === 2`);
    assert.equal(await page.evaluate(`document.querySelectorAll('.tree .count')[0].textContent`), '1');

    // Comments survive a reload.
    await page.send('Page.reload');
    await page.waitFor(`document.querySelectorAll('tr.comment .cbody').length === 2`);

    // Edit the first comment (replace its text) and save.
    await page.evaluate(`document.querySelector('#f0-0 tr.comment button.edit').click()`);
    await page.waitFor(`document.querySelector('#f0-0 tr.comment textarea')?.value === 'Drop this comment'`);
    await page.evaluate(`document.querySelector('#f0-0 tr.comment textarea').select()`);
    await page.send('Input.insertText', { text: 'Drop this comment, please' });
    await page.evaluate(`document.querySelector('#f0-0 tr.comment button.primary').click()`);
    await page.waitFor(`document.querySelector('#f0-0 .cbody')?.textContent === 'Drop this comment, please'`);
    assert.equal(await page.evaluate(`document.querySelectorAll('tr.comment .cbody').length`), 2);

    // Typing and submitting in the same tick must not lose the text.
    await page.type('.questions textarea', 'No');
    await page.type('#general', 'Almost there');
    await page.evaluate(`document.getElementById('changes').click()`);
    await page.waitFor(`document.querySelector('.done .stamp')?.textContent === 'Changes requested'`);
  } finally {
    page.close();
  }

  assert.equal(await exited, 0);
  assert.match(stdout, /Verdict: \*\*changes requested\*\*/);
  assert.match(stdout, /## General\n\nAlmost there/);
  assert.match(stdout, /\*\*Q: Keep the comment\?\*\*\n\nNo/);
  assert.match(stdout, /\*\*app\.js:2\*\* \(new side\)\n\n```diff\n\+  \/\/ sum\n```\n\nDrop this comment, please/);
  assert.match(stdout, /\*\*notes\.txt:1-3\*\* \(new side\)\n\n```diff\n\+one\n\+two\n\+three\n```\n\nWhole file is odd/);
  assert.ok(stdout.indexOf('/web') < stdout.indexOf('/lib'));
});
