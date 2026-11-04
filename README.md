# Feedbacker

A local, merge-request-style review page for coding agents. The agent passes the git repos it changed, a summary and optionally some questions. You see the diffs of **all of them on one page**, comment on lines, answer the questions, and click **Approve** or **Request changes**. The agent gets your feedback back as markdown it can act on.

- **Multi-repo and worktrees**: any repos anywhere on disk, each with its own base; `--worktrees` pulls in every git worktree of a repo, so parallel agents' work is reviewed together.
- **Simple**: one Node process with no runtime dependencies; nothing to install or build to use it. The page is a small React 19 app whose bundle (with highlight.js) is committed in `src/dist/`.
- **Local**: binds to `127.0.0.1` with a random token in the URL. Nothing leaves your machine, and git is only read.
- **Three ways in**: a Claude Code plugin (MCP tool + skill), a plain MCP server for other agents, and a CLI for anything with a shell.

![Review page](docs/screenshot.png)

## Install

### Claude Code plugin

```bash
claude plugin marketplace add PavlikPolivka/feedbacker
claude plugin install feedbacker@feedbacker
```

This gives Claude:

- the MCP tool `request_review` (it shows up as `mcp__plugin_feedbacker_feedbacker__request_review`)
- the skill `/feedbacker:review`, which tells Claude when and how to ask for a review
- hooks for the **session baseline**: each repo's state is recorded when the session first touches it (at session start for the current repo, and before the first edit in any other repo). When Claude asks for a review without a base, the review shows exactly what changed in this session, even if Claude committed along the way, and repos Claude changed but forgot to pass are added. Uncommitted work from before the session is left out, because the baseline is a snapshot of it (`git stash create`, which changes neither your working tree nor your stash list). New untracked files from before the session still show up.

Then just say "let me review it" or run `/feedbacker:review`. To try it from a checkout without installing: `claude --plugin-dir /path/to/feedbacker`.

### Any MCP client

```json
{
  "mcpServers": {
    "feedbacker": { "command": "npx", "args": ["-y", "agent-feedbacker", "mcp"] }
  }
}
```

### CLI

```bash
npm install -g agent-feedbacker      # or run it once with: npx agent-feedbacker
```

The npm package is `agent-feedbacker`; the command is `feedbacker`. Node 22 or newer; git on `PATH`. From a checkout, `node bin/feedbacker.mjs` works too.

## Use

```bash
feedbacker ~/Projects/api ~/Projects/web@main \
  -m "Bind the API to localhost; document the port" \
  -q "Should the port also be a CLI flag?"
```

- `repo` diffs the working tree (staged, unstaged and untracked files) against `HEAD`.
- `repo@base` diffs against any commit, branch or tag, so work the agent already committed is included. With a branch, the diff starts where `HEAD` forked from it (like a merge request), so newer commits on that branch don't show up reversed.
- A worktree path works like any repo. `-w` / `--worktrees` adds every worktree of each repo (main and linked, each labelled with its branch), all against the same base:

  ```bash
  feedbacker ~/Projects/api@main --worktrees   # main checkout + every agent's worktree
  ```
- The command blocks until you submit, then prints the feedback (`--json` for JSON) and exits 0. Exit 2 means there was nothing to review.
- `feedbacker list` prints the URLs of reviews waiting for you, for when the browser didn't open (MCP clients usually hide a server's output).
- `--no-open` only prints the URL; `--port` fixes the port.

In the browser:

- In changed lines, the changed words are marked.
- Tick **Viewed** on a file when you're done with it: it collapses, dims in the file tree, and the top bar counts how many you've viewed.
- Click a line number to comment on that line (a highlighter "+" shows where); shift-click a second one to comment on a range. Ctrl+Enter saves, Esc cancels.
- With several repos, the picker in the top bar switches between all of them and a single one (the summary, questions and your comments in other repos stay). The top bar also shows the size of the change and keeps **Approve** and **Request changes** in reach; files can be collapsed, and the file tree shows where your comments are.
- Comments, answers and the general comment are kept in the browser's local storage until you submit, so a refresh loses nothing.
- **Approve** or **Request changes** sends everything to the agent and closes the server.

## MCP tool

`request_review`:

| Argument | Type | |
|---|---|---|
| `repos` | `[{ path, base?, worktrees? }]` | Required. Absolute paths; `base` defaults to `HEAD` (or, with the plugin's hooks, where the repo stood when the session started); `worktrees: true` adds all worktrees of that repo. (`exact` and `session` are set by the hook.) |
| `summary` | string | Shown at the top of the page. |
| `questions` | string[] | Shown with an answer box each. |

It blocks until the user submits (Claude Code keeps long MCP calls open; it sends progress notifications every 30 s for clients that need them) and returns markdown like:

````markdown
# Review feedback

Verdict: **changes requested**

Reviewed:

- /home/me/Projects/api (feature/config): 2 files changed (src/server.ts, src/config.ts), changes since the session started

## General

Almost there.

## Answers

**Q: Should the port also be a CLI flag?**

No, env is enough.

## Comments

### /home/me/Projects/api

**src/server.ts:6** (new side)

```diff
+  server.listen(port, "127.0.0.1");
```

Make the host configurable too.
````

The result starts with what was reviewed (each repo, its files and base), so the agent knows what the verdict covers. Each comment carries the code it refers to, so line numbers drifting doesn't lose the context. Cancelling the tool call closes the review page.

## How it works

```
agent ──request_review / CLI──▶ feedbacker ──git diff per repo──▶ review in memory
feedbacker ──opens──▶ http://127.0.0.1:PORT/?t=TOKEN ──you submit──▶ feedbacker
feedbacker ──markdown (tool result / stdout)──▶ agent
```

| File | |
|---|---|
| `src/core.mjs` | Reads diffs (`git diff <base>` plus untracked files), parses them, serves the page, formats feedback. |
| `src/page.html` | Page shell: styles, and the bundle from `src/dist/`. |
| `src/ui/` | The review page in React 19 (JSX): diff table, inline comments, questions, submit; highlight.js for syntax, `styles.css` for the look (light and dark, colour tokens at the top). |
| `src/dist/` | The committed bundle (JS, CSS and fonts), built from `src/ui/` by `build.mjs` (esbuild). |
| `src/mcp.mjs` | Minimal MCP server over stdio (JSON-RPC), one tool. |
| `src/baseline.mjs`, `hooks/hooks.json` | Session baseline: `feedbacker hook` records repos (SessionStart, PreToolUse on edits) and fills in bases for `request_review` (PreToolUse, via `updatedInput`). Stored in `$XDG_STATE_HOME/feedbacker/sessions/`, forgotten after 30 days. |
| `bin/feedbacker.mjs` | CLI: review, `list`, `mcp`, `hook`. |
| `skills/review/SKILL.md`, `.mcp.json`, `.claude-plugin/` | The Claude Code plugin and its marketplace entry. |

Open reviews write a small file (URL, repos, pid) to `$XDG_STATE_HOME/feedbacker/` (default `~/.local/state/feedbacker/`, mode 0600) and remove it when they finish; `list` reads them.

## Development

```bash
pnpm install     # dev dependencies only: React, highlight.js, fonts, esbuild
pnpm build       # after changing src/ui: rebuilds src/dist (commit it)
pnpm test
```

Using Feedbacker needs none of this; only working on the page does. A test fails when `src/dist` doesn't match `src/ui`.

The tests use real temporary git repos. They cover diff parsing, the HTTP server, the MCP protocol over stdio, and an end-to-end run that drives the page in headless Chromium (skipped when no Chromium is found; set `CHROMIUM=/path` to pick one).

CI runs the tests on Node 22 and 24 for every push and pull request (`.github/workflows/ci.yml`).

### Releasing

Publishing to npm is done by GitHub Actions (`.github/workflows/publish.yml`) with npm trusted publishing, so no npm token is stored anywhere and each version gets a provenance statement.

1. Bump `version` in `package.json` and `.claude-plugin/plugin.json` (the MCP server reads it from `package.json`), commit, push.
2. Create a GitHub release with the tag `vX.Y.Z` matching that version: `gh release create v0.2.0 --generate-notes`.
3. The workflow checks the tag, runs the tests and publishes.

One-time setup: on npmjs.com, add a trusted publisher for the package (GitHub Actions, repository `PavlikPolivka/feedbacker`, workflow `publish.yml`). npm only offers that once the package exists, so the very first version is published by hand with `npm publish --access public`.

Plans: [ROADMAP.md](ROADMAP.md).

## Licence

MIT. The bundle in `src/dist/` includes React, ReactDOM and scheduler (MIT), highlight.js (BSD-3-Clause), and the Atkinson Hyperlegible Next and JetBrains Mono fonts (OFL-1.1); their licences are in `src/dist/THIRD_PARTY_LICENSES.txt`. The fonts are served locally, so the page never loads anything from the internet.
