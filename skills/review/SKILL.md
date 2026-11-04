---
name: review
description: Ask the user to review your changes in a local merge-request-style page and get their line comments, answers and verdict back. Use when the user asks for a review ("let me review", "show me the diff", "feedbacker"), or after finishing a non-trivial change, especially one that spans several git repos, before you commit, push or call the work done.
---

# Review with Feedbacker

Feedbacker opens a review page in the user's browser with the diffs of the repos you pass. The user comments on lines, answers your questions and clicks **Approve** or **Request changes**. You get their feedback back as markdown.

## How

1. List **every git repo you changed in this session**, as absolute paths. Include repos outside the current directory.
2. Pick a base per repo:
   - Uncommitted changes only: leave `base` out (it defaults to `HEAD`).
   - You committed during the session: use the commit the session started from (`git log` to find it) or the branch you forked from, e.g. `main`.
3. Call the `request_review` tool of the `feedbacker` MCP server with:
   - `repos`: `[{ "path": "/abs/path", "base": "main" }, ...]`
   - `summary`: two to five sentences on what you changed and why.
   - `questions`: only real decisions you want the user to make (optional).
4. Before the call, tell the user a review page is opening in their browser. If it doesn't appear, they can run `node "${CLAUDE_PLUGIN_ROOT}/bin/feedbacker.mjs" list` to get its URL. The tool returns once they submit, however long that takes.

If the MCP tool isn't available, run the CLI in the background instead, so the shell timeout doesn't kill it, and read its output when it exits:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/feedbacker.mjs" /abs/repo-a /abs/repo-b@main \
  -m "What changed" -q "A question?"
```

## After the review

- **Changes requested:** address every comment. Each one names the repo, file, line range and the code it refers to. Answer comments you disagree with instead of silently skipping them. Then offer another review round.
- **Approved:** carry on (commit, push, or whatever was next), taking any comments and answers into account.
- Use the answers to your questions as decisions; don't ask them again.
