# Roadmap

Feedbacker should stay small: one process, nothing to install or build to use it. Only the page has a build step (esbuild), and its output is committed. Each step below is meant to be useful on its own.

## Done: MVP (0.1)

- Review page in React 19 + JSX, bundled by esbuild into a committed `src/dist/` (a test checks it's current).
- Multi-repo review page: diffs of working tree vs a base per repo, untracked files included, syntax highlighting, light and dark themes.
- Line and range comments, answers to agent questions, general comment, Approve / Request changes. State survives a refresh.
- CLI (`feedbacker`, `feedbacker list`), MCP server (`request_review`), Claude Code plugin (MCP + skill), marketplace entry.
- Git worktrees: a worktree is reviewed like a repo; `--worktrees` / `worktrees: true` brings all worktrees of a repo into one review. Diffs against a branch start at the fork point.
- Tests: unit, HTTP, MCP over stdio, headless-browser end to end. Checked once against a real Claude Code session.

## Next: make it pleasant in daily use

1. **Try it on real multi-repo work** for a week and fix what annoys. That is the main input for everything below.
2. **Session baseline.** A `SessionStart` hook records each repo's `HEAD` (and `git stash create` for dirty trees). `request_review` then uses that as the default base, so committed work shows up without the agent having to find the right commit. Plugin hooks can ship this.
3. **Word-level diff** inside changed lines (pair `-`/`+` lines, mark the changed words).
4. **File tree and "viewed" checkboxes**; collapse files; expand context around hunks (`git show base:file` / read the working file).
5. **Split (side-by-side) view** as an option.
6. **Comment on a whole file**, not only lines.
7. **Publish to npm** so `npx feedbacker` works without a clone.

## Later: rounds

8. **Agent replies and resolving.** The next `request_review` call passes the previous review id; the page shows old comments with the agent's replies, and you resolve or reopen them.
9. **Interdiff.** Show only what changed since the last round, with a toggle back to the full diff.
10. **Re-anchoring** comments when the agent's changes move lines (match by the stored code snippet).

## Maybe

- **A `Stop` hook** that offers a review when repos changed and none was requested.
- **Two-step tool** (`request_review` returns an id, `await_review` long-polls) for MCP clients with short tool timeouts. Claude Code doesn't need it: it kept a call open for over 3 minutes in testing without progress notifications.
- **Structured output** (`structuredContent` with an output schema) alongside the markdown.
- **Contribute ideas upstream** to Plannotator where they fit.

## Known limits

- Very large diffs (over 2000 rows per file) and minified files (a line over 1000 characters) are collapsed behind a button; over 5000 rows aren't highlighted.
- Binary files are listed but not shown.
- The page is fetched once; if the agent changes files while you review, the diff doesn't refresh.
- Comments are anchored to the diff as it was when the review opened.
