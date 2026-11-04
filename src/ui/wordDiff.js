// Word-level diff: inside a changed line, mark the words that changed.
//
// In a run of deleted lines followed by a run of added lines, each deleted
// line is paired with its most similar added line, keeping their order (a
// small alignment over the two runs). For each pair, an LCS over word tokens
// gives the changed character ranges on each side. markRanges() then wraps
// those ranges in <mark> inside the syntax-highlighted HTML.

const TOKEN = /\w+|\s+|[^\w\s]/g;
const MAX_CELLS = 40_000; // LCS table size limit; longer pairs aren't marked
const MAX_RUN = 60; // longer runs of changed lines are paired by position

function tokens(s) {
  return s.match(TOKEN) || [];
}

// Changed [start, end) character ranges of a and b, or null when the lines
// are too different (or too long) for word marks to help.
export function diffWords(a, b) {
  return compare(a, b)?.ranges ?? null;
}

// { ranges, score } where score is the number of shared words, or null.
function compare(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length || ta.length * tb.length > MAX_CELLS) return null;
  const n = ta.length, m = tb.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ta[i] === tb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const keepA = new Uint8Array(n), keepB = new Uint8Array(m);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ta[i] === tb[j]) { keepA[i++] = 1; keepB[j++] = 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  // Mostly rewritten lines read better without marks: at least half of the
  // shorter line's words must survive.
  const words = (toks) => toks.filter((t) => t.trim()).length;
  const kept = ta.filter((t, i) => keepA[i] && t.trim()).length;
  if (kept / Math.min(words(ta), words(tb)) < 0.5) return null;
  return { ranges: [ranges(ta, keepA), ranges(tb, keepB)], score: kept };
}

// Changed character ranges, merged across whitespace between changed words.
function ranges(toks, keep) {
  const out = [];
  let pos = 0;
  toks.forEach((t, i) => {
    const start = pos;
    pos += t.length;
    if (keep[i]) return;
    const last = out[out.length - 1];
    const gapIsSpace = last && /^\s*$/.test(toks.slice(last.tok + 1, i).join(''));
    if (last && (last.end === start || gapIsSpace)) { last.end = pos; last.tok = i; }
    else out.push({ start, end: pos, tok: i });
  });
  return out.filter((r) => toks.join('').slice(r.start, r.end).trim()).map(({ start, end }) => [start, end]);
}

// rows -> Map(row -> ranges) for paired -/+ lines.
export function wordMarks(rows) {
  const marks = new Map();
  for (let i = 0; i < rows.length;) {
    if (rows[i].t !== '-') { i++; continue; }
    const dels = [];
    while (i < rows.length && rows[i].t === '-') dels.push(rows[i++]);
    const adds = [];
    while (i < rows.length && rows[i].t === '+') adds.push(rows[i++]);
    for (const [d, a, r] of pairUp(dels, adds)) { marks.set(d, r[0]); marks.set(a, r[1]); }
  }
  return marks;
}

// Best order-keeping pairing of two runs by shared words: [del, add, ranges].
function pairUp(dels, adds) {
  if (dels.length > MAX_RUN || adds.length > MAX_RUN) {
    return dels.slice(0, adds.length).map((d, k) => [d, adds[k], diffWords(d.s, adds[k].s)]).filter((p) => p[2]);
  }
  const n = dels.length, m = adds.length;
  const sim = dels.map((d) => adds.map((a) => compare(d.s, a.s)));
  const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const here = sim[i][j] ? sim[i][j].score + best[i + 1][j + 1] : -1;
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], here);
    }
  }
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (sim[i][j] && best[i][j] === sim[i][j].score + best[i + 1][j + 1]) { pairs.push([dels[i], adds[j], sim[i][j].ranges]); i++; j++; }
    else if (best[i][j] === best[i + 1][j]) i++;
    else j++;
  }
  return pairs;
}

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// Wrap character ranges of the line's text in <mark class="wd">, given its
// HTML (escaped text plus <span> tags from the highlighter). Marks never
// straddle a tag: they close before it and reopen after.
export function markRanges(html, ranges) {
  if (!ranges?.length) return html;
  const parts = html.split(/(<[^>]+>)/);
  let pos = 0, r = 0, open = false, out = '';
  const inRange = (p) => {
    while (r < ranges.length && p >= ranges[r][1]) r++;
    return r < ranges.length && p >= ranges[r][0];
  };
  for (const part of parts) {
    if (part.startsWith('<')) {
      if (open) { out += '</mark>'; open = false; }
      out += part;
      continue;
    }
    // Text: walk characters, treating each entity as one character.
    for (const ch of part.match(/&[a-z#0-9]+;|[\s\S]/gi) || []) {
      const want = inRange(pos);
      if (want && !open) { out += '<mark class="wd">'; open = true; }
      if (!want && open) { out += '</mark>'; open = false; }
      out += ch;
      pos++;
    }
  }
  if (open) out += '</mark>';
  return out;
}
