#!/usr/bin/env node
// Feedbacker CLI: `feedbacker [repos...]` opens a review page and prints the
// feedback when the user submits; `feedbacker mcp` runs the MCP server.

import { buildReview, hasChanges, listReviews, startReview, toMarkdown } from '../src/core.mjs';
import { runMcp } from '../src/mcp.mjs';

const USAGE = `Usage: feedbacker [options] [repo[@base] ...]
       feedbacker list
       feedbacker mcp

Opens a review page for the changes in each repo (default: current directory)
and prints the feedback to stdout when the user submits.

  repo[@base]        Repo path; diff the working tree (including untracked
                     files) against base. Default base: HEAD.
  -m, --summary TXT  What the agent changed, shown at the top.
  -q, --question TXT A question for the user (repeatable).
  --json             Print JSON instead of markdown.
  --port N           Port to listen on (default: random).
  --no-open          Don't open the browser; only print the URL to stderr.
  -h, --help         Show this help.

  list               Show the URLs of reviews that are waiting for you.
  mcp                Run as an MCP server on stdio (tool: request_review).`;

function fail(msg) {
  console.error(`feedbacker: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { repos: [], questions: [], summary: '', json: false, port: 0, open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a === '-m' || a === '--summary') opts.summary = next();
    else if (a === '-q' || a === '--question') opts.questions.push(next());
    else if (a === '--json') opts.json = true;
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--no-open') opts.open = false;
    else if (a.startsWith('-')) fail(`unknown option ${a}\n\n${USAGE}`);
    else opts.repos.push(a);
  }
  if (!opts.repos.length) opts.repos.push('.');
  return opts;
}

// Exit cleanly on signals so open reviews remove their state files.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(130));

const argv = process.argv.slice(2);
if (argv[0] === 'mcp') {
  runMcp();
} else if (argv[0] === 'list') {
  const reviews = listReviews();
  if (!reviews.length) console.log('No reviews waiting.');
  for (const r of reviews) console.log(`${r.url}\n  ${r.started}  ${r.repos.join(', ')}${r.summary ? `\n  ${r.summary}` : ''}`);
} else {
  const opts = parseArgs(argv);
  const review = buildReview(opts);
  for (const r of review.repos) if (r.error) console.error(`feedbacker: ${r.path}: ${r.error}`);
  if (!hasChanges(review) && !review.questions.length) {
    console.error('feedbacker: no changes to review');
    process.exit(2);
  }
  const { url, feedback } = await startReview(review, { port: opts.port, open: opts.open });
  console.error(`feedbacker: waiting for review at ${url}`);
  const fb = await feedback;
  process.stdout.write(opts.json ? JSON.stringify(fb, null, 2) + '\n' : toMarkdown(review, fb));
}
