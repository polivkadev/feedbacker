// The committed bundle in src/dist must match what build.mjs produces from
// src/ui. Skipped when dev dependencies aren't installed.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hasDeps = fs.existsSync(path.join(root, 'node_modules', 'esbuild'));

test('committed bundle is up to date (run `pnpm build`)', { skip: !hasDeps && 'dev dependencies not installed' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'feedbacker-build-'));
  execFileSync(process.execPath, [path.join(root, 'build.mjs'), '--out', out]);
  const list = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort();
  assert.deepEqual(list(path.join(root, 'src', 'dist')), list(out), 'src/dist has missing or extra files');
  for (const f of list(out)) {
    assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(root, 'src', 'dist', f))), `src/dist/${f} is stale`);
  }
});
