// Session baseline: where each repo stood when a Claude Code session first
// touched it, so a review shows only what changed in that session, even after
// the agent committed. Recorded and applied by the plugin's hooks
// (`feedbacker hook`, see hooks/hooks.json).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hasChanges, buildReview, stateDir } from './core.mjs';

const TOOL = 'mcp__plugin_feedbacker_feedbacker__request_review';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const KEEP_DAYS = 30;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function sessionFile(id) {
  return path.join(stateDir(), 'sessions', `${String(id).replace(/[^\w-]/g, '')}.json`);
}

export function loadSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return { repos: {} }; }
}

function saveSession(id, session) {
  const file = sessionFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(session, null, 2), { mode: 0o600 });
  // Forget sessions nobody has touched for a month.
  const cutoff = Date.now() - KEEP_DAYS * 86_400_000;
  for (const name of fs.readdirSync(path.dirname(file))) {
    const f = path.join(path.dirname(file), name);
    try { if (fs.statSync(f).mtimeMs < cutoff) fs.rmSync(f); } catch {}
  }
}

// Record the repo containing `dir` unless this session already has it.
// The baseline is HEAD, or a snapshot commit of uncommitted work
// (`git stash create`: nothing in the working tree or stash list changes).
export function record(id, dir) {
  let top;
  try {
    let d = path.resolve(dir);
    while (!fs.existsSync(d)) d = path.dirname(d); // a file that's about to be created
    if (!fs.statSync(d).isDirectory()) d = path.dirname(d);
    top = git(d, ['rev-parse', '--show-toplevel']);
  } catch {
    return null; // not in a git repo
  }
  const session = loadSession(id);
  if (session.repos[top]) return session.repos[top];
  const head = git(top, ['rev-parse', 'HEAD']);
  let snapshot = '';
  try { snapshot = git(top, ['stash', 'create']); } catch {}
  session.started ||= new Date().toISOString();
  session.repos[top] = { base: snapshot || head, head, recorded: new Date().toISOString() };
  saveSession(id, session);
  return session.repos[top];
}

// Fill in the session baseline for repos passed without a base, and add
// recorded repos that have changes but weren't passed. Returns the new input,
// or null when nothing changes.
export function applyBaseline(id, input) {
  const session = loadSession(id);
  const known = Object.keys(session.repos);
  if (!known.length || !Array.isArray(input?.repos)) return null;
  let changed = false;
  const topOf = (p) => { try { return git(path.resolve(p), ['rev-parse', '--show-toplevel']); } catch { return null; } };
  const repos = input.repos.map((r) => {
    const spec = typeof r === 'string' ? { path: r } : { ...r };
    const top = topOf(spec.path);
    if (!spec.base && top && session.repos[top]) {
      spec.base = session.repos[top].base;
      spec.exact = true;
      spec.session = true;
      changed = true;
    }
    return spec;
  });
  const passed = new Set(repos.map((r) => topOf(r.path)).filter(Boolean));
  for (const top of known) {
    if (passed.has(top) || !fs.existsSync(top)) continue;
    const spec = { path: top, base: session.repos[top].base, exact: true, session: true };
    if (hasChanges(buildReview({ repos: [spec] }))) { repos.push(spec); changed = true; }
  }
  return changed ? { ...input, repos } : null;
}

// Entry point for `feedbacker hook`: reads the hook event JSON on stdin.
// Never fails the tool call: any error just means no baseline.
export async function runHook() {
  let event;
  try {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    event = JSON.parse(text);
  } catch {
    return;
  }
  const id = event.session_id;
  if (!id) return;
  try {
    if (event.hook_event_name === 'SessionStart' && event.cwd) {
      record(id, event.cwd);
    } else if (event.hook_event_name === 'PreToolUse') {
      if (EDIT_TOOLS.has(event.tool_name)) {
        const file = event.tool_input?.file_path || event.tool_input?.notebook_path;
        if (file) record(id, path.resolve(event.cwd || '.', file));
      } else if (event.tool_name === TOOL) {
        const updated = applyBaseline(id, event.tool_input);
        if (updated) {
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated },
          }));
        }
      }
    }
  } catch {}
}
