---
name: review
description: Ask the user to review your changes in a local merge-request-style page and get their line comments, answers and verdict back. Use when the user asks for a review ("let me review", "show me the diff", "feedbacker"), or after finishing a non-trivial change, especially one that spans several git repos, before you commit, push or call the work done.
---

# Review with Feedbacker

Feedbacker opens a review page in the user's browser with the diffs of the repos you pass. The user comments on lines, asks you questions about the code, and clicks **Approve** or **Request changes**. You get their feedback back as markdown.

## How

1. List **every git repo and worktree you changed in this session**, as absolute paths. Include repos outside the current directory. If the work is spread over several worktrees of one repo (e.g. parallel agents), pass one of them with `"worktrees": true` instead of listing each.
2. Pick a base per repo, usually by leaving it out: the plugin's hooks recorded where each repo stood when this session first touched it, and fill that in, so the review shows exactly what you changed in this session, commits included. Only pass `base` for something else, e.g. a whole branch against `main`. The result starts with a "Reviewed" list showing what the user saw.
3. Call the `request_review` tool of the `feedbacker` MCP server with:
   - `repos`: `[{ "path": "/abs/path", "base": "main", "worktrees": false }, ...]`
   - `summary`: markdown. One or two sentences on what changed and why, then a short `- ` list of the notable parts. Use `### ` subheadings only if the change has distinct parts. No walls of text.
   - `focus`: two to six places the user should look first, each `{ "path": "src/x.ts", "startLine": 40, "endLine": 80, "note": "why it matters" }`. Pick the main logic and anything risky or non-obvious, not tests, docs or config (the page collapses those anyway).
   - `questions`: leave this out. Only add one if you are blocked on a decision you truly cannot make; the user asks *you* questions on the page instead.
4. Before the call, tell the user a review page is opening in their browser. If it doesn't appear, they can run `node "${CLAUDE_PLUGIN_ROOT}/bin/feedbacker.mjs" list` to get its URL. The tool returns once they submit, however long that takes.

If the MCP tool isn't available, run the CLI in the background instead, so the shell timeout doesn't kill it, and read its output when it exits:

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/feedbacker.mjs" /abs/repo-a /abs/repo-b@main \
  -m "What changed" -q "A question?"
```

## After the review

- **Questions from the reviewer:** answer every one in your reply, quoting the file and line. Change code only if a question shows something is wrong, and say that you did.
- **Changes requested:** address every comment. Each one names the repo, file, line range and the code it refers to. Answer comments you disagree with instead of silently skipping them. Then offer another review round.
- **Approved:** carry on (commit, push, or whatever was next), taking any comments and answers into account.
- Use the answers to your questions as decisions; don't ask them again.
