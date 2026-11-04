import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Keep tests' review state files out of the real state directory.
process.env.FEEDBACKER_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'feedbacker-state-'));

export function sh(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// A repo with one commit containing `files` ({ name: content }).
export function makeRepo(files, name = 'repo') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feedbacker-')), name);
  fs.mkdirSync(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  write(dir, files);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function write(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

export function commit(dir, msg = 'change') {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', msg);
}
