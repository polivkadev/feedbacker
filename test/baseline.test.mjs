import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyBaseline, loadSession, record } from '../src/baseline.mjs';
import { buildReview } from '../src/core.mjs';
import { commit, makeRepo, sh, write } from './helpers.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'feedbacker.mjs');
const hook = (event) => execFileSync(process.execPath, [BIN, 'hook'], { input: JSON.stringify(event), encoding: 'utf8' });
let n = 0;
const sid = () => `test-${process.pid}-${n++}`;

test('record: snapshot of uncommitted work, once per repo; nothing for non-repos', () => {
  const dir = makeRepo({ 'a.txt': '1\n' });
  write(dir, { 'a.txt': '1\npre-existing\n' });
  const id = sid();
  const first = record(id, path.join(dir, 'new', 'file.txt')); // not created yet
  assert.notEqual(first.base, first.head, 'dirty tree: base is a snapshot commit');
  assert.equal(sh(dir, 'status', '--porcelain').trim(), 'M a.txt', 'working tree untouched');
  assert.equal(sh(dir, 'stash', 'list').trim(), '', 'stash list untouched');
  write(dir, { 'a.txt': 'changed again\n' });
  assert.deepEqual(record(id, dir), first, 'second record keeps the first baseline');
  assert.equal(record(id, path.dirname(dir)), null);

  const clean = makeRepo({ 'b': '1\n' });
  const r = record(sid(), clean);
  assert.equal(r.base, r.head);
});

test('applyBaseline: session-only diff even after commits; adds forgotten repos', () => {
  const a = makeRepo({ 'a.txt': '1\n' }, 'a');
  const b = makeRepo({ 'b.txt': '1\n' }, 'b');
  const c = makeRepo({ 'c.txt': '1\n' }, 'c');
  write(a, { 'a.txt': '1\npre-existing\n' });
  const id = sid();
  for (const d of [a, b, c]) record(id, d);
  // The agent edits a and commits (including the pre-existing change), edits b, leaves c.
  write(a, { 'a.txt': '1\npre-existing\nagent\n' });
  commit(a, 'agent');
  write(b, { 'b.txt': '2\n' });

  const input = applyBaseline(id, { repos: [{ path: a }], summary: 's' });
  assert.equal(input.summary, 's');
  const real = (p) => fs.realpathSync(p);
  assert.deepEqual(input.repos.map((r) => real(r.path)), [real(a), real(b)], 'b added (has changes), c not (clean)');
  assert.ok(input.repos.every((r) => r.exact && r.session));

  const review = buildReview(input);
  const added = review.repos[0].files[0].rows.filter((r) => r.t === '+').map((r) => r.s);
  assert.deepEqual(added, ['agent'], 'only the session change, despite the commit');

  // An explicit base is left alone; no session means no change.
  assert.equal(applyBaseline(id, { repos: [{ path: a, base: 'HEAD' }, { path: b, base: 'HEAD' }] }), null);
  assert.equal(applyBaseline(sid(), { repos: [{ path: a }] }), null);
});

test('hook: SessionStart and edits record; request_review gets updatedInput; bad input is ignored', () => {
  const dir = makeRepo({ 'a.txt': '1\n' });
  const other = makeRepo({ 'o.txt': '1\n' });
  const id = sid();
  assert.equal(hook({ session_id: id, hook_event_name: 'SessionStart', cwd: dir }), '');
  hook({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dir, tool_input: { file_path: path.join(other, 'o.txt') } });
  assert.equal(Object.keys(loadSession(id).repos).length, 2);

  write(dir, { 'a.txt': '2\n' });
  const out = JSON.parse(hook({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'mcp__plugin_feedbacker_feedbacker__request_review', cwd: dir, tool_input: { repos: [{ path: dir }] } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.updatedInput.repos[0].session, true);
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'never auto-approves the tool');

  assert.equal(hook({ hook_event_name: 'SessionStart' }), '');
  assert.equal(execFileSync(process.execPath, [BIN, 'hook'], { input: 'not json', encoding: 'utf8' }), '');
});
