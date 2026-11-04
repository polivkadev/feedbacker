// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0) with one tool,
// request_review, which blocks until the user submits the review page.

import readline from 'node:readline';
import { buildReview, hasChanges, startReview, toMarkdown } from './core.mjs';

const VERSION = '0.1.0';
const PROTOCOL = '2025-06-18';

const TOOL = {
  name: 'request_review',
  title: 'Request review from the user',
  description:
    'Open a merge-request-style review page in the user\'s browser with the diffs of the given git repos ' +
    '(working tree, including untracked files, against a base). The user comments on lines, answers your ' +
    'questions and submits. Blocks until they do, then returns their feedback as markdown: a verdict ' +
    '(approved / changes requested), a general comment, answers, and line comments with the code they refer to. ' +
    'Pass every repo and worktree you changed in this session, as absolute paths.',
  inputSchema: {
    type: 'object',
    properties: {
      repos: {
        type: 'array',
        minItems: 1,
        description: 'Repos to review.',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute path to the repo (or any folder inside it).' },
            base: { type: 'string', description: 'Commit, branch or tag to diff against. Default HEAD (uncommitted changes only). With a branch, the diff starts where HEAD forked from it, like a merge request.' },
            exact: { type: 'boolean', description: 'Diff against base itself, not the point where HEAD forked from it. Set by the session-baseline hook; rarely needed by hand.' },
            session: { type: 'boolean', description: 'Set by the session-baseline hook: base is where the repo stood when this session started.' },
            worktrees: { type: 'boolean', description: 'Also review every other git worktree of this repo (e.g. parallel agents\' work), each against the same base.' },
          },
          required: ['path'],
        },
      },
      summary: { type: 'string', description: 'Short summary of what you changed and why, shown at the top of the page.' },
      questions: { type: 'array', items: { type: 'string' }, description: 'Questions for the user to answer next to the diff.' },
    },
    required: ['repos'],
  },
};

const pending = new Map(); // request id -> close() of its review server

function send(msg) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
}

// To stderr and as an MCP log message, since not every client shows stderr.
function log(msg) {
  process.stderr.write(`feedbacker: ${msg}\n`);
  send({ method: 'notifications/message', params: { level: 'info', logger: 'feedbacker', data: msg } });
}

async function callTool(id, params) {
  if (params?.name !== TOOL.name) throw rpcError(-32602, `Unknown tool: ${params?.name}`);
  const args = params.arguments || {};
  if (!Array.isArray(args.repos) || !args.repos.length) {
    return toolError('`repos` must be a non-empty array of { path, base? }.');
  }
  const review = buildReview({
    repos: args.repos.map((r) => (typeof r === 'string' ? r : { path: r.path, base: r.base, worktrees: r.worktrees, exact: r.exact, session: r.session })),
    summary: args.summary || '',
    questions: Array.isArray(args.questions) ? args.questions.map(String) : [],
  });
  const errors = review.repos.filter((r) => r.error).map((r) => `${r.path}: ${r.error}`);
  if (!hasChanges(review) && !review.questions.length) {
    return toolError(['No changes to review.', ...errors].join('\n'));
  }

  const open = !process.env.FEEDBACKER_NO_OPEN;
  const { url, feedback, close } = await startReview(review, { open });
  log(`waiting for review at ${url}`);

  // Keep long waits alive for clients that reset their timeout on progress.
  const token = params._meta?.progressToken;
  let progress = 0;
  const timer = token !== undefined
    ? setInterval(() => send({ method: 'notifications/progress', params: { progressToken: token, progress: ++progress, message: 'Waiting for the user to submit the review' } }), 30_000)
    : null;

  try {
    const fb = await Promise.race([feedback, new Promise((_, no) => pending.set(id, () => { close(); no(new Error('cancelled')); }))]);
    let text = toMarkdown(review, fb);
    if (errors.length) text += `\nRepos that could not be read:\n${errors.map((e) => `- ${e}`).join('\n')}\n`;
    return { content: [{ type: 'text', text }] };
  } finally {
    clearInterval(timer);
    pending.delete(id);
  }
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: {}, logging: {} },
      serverInfo: { name: 'feedbacker', version: VERSION },
    };
  }
  if (method === 'ping' || method === 'logging/setLevel') return {};
  if (method === 'tools/list') return { tools: [TOOL] };
  if (method === 'tools/call') return callTool(id, params);
  throw rpcError(-32601, `Method not found: ${method}`);
}

export function runMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (msg.id === undefined) {
      // Notifications: only cancellation matters to us.
      if (msg.method === 'notifications/cancelled') pending.get(msg.params?.requestId)?.();
      return;
    }
    try {
      send({ id: msg.id, result: await handle(msg) });
    } catch (e) {
      if (e.message === 'cancelled') return;
      send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
    }
  });
  rl.on('close', () => process.exit(0));
}
