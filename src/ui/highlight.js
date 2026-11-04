// Syntax highlighting with highlight.js (common languages).

import hljs from 'highlight.js/lib/common';

// Highlighted HTML is one string; split it back into lines, closing and
// reopening spans at each line break.
export function splitHtmlLines(text) {
  const lines = [];
  const open = [];
  let cur = '';
  for (const part of text.split(/(<span[^>]*>|<\/span>|\n)/)) {
    if (part === '\n') { lines.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
    else if (part.startsWith('<span')) { open.push(part); cur += part; }
    else if (part === '</span>') { open.pop(); cur += part; }
    else cur += part;
  }
  lines.push(cur);
  return lines;
}

// Highlight each side of the file as one text, so multi-line strings and
// comments come out right. Returns Map(row -> html), or null when the
// language is unknown or the file is too big.
export function highlightFile(file) {
  const ext = file.path.split('/').pop().split('.').pop().toLowerCase();
  if (file.rows.length > 5000 || !hljs.getLanguage(ext)) return null;
  const sides = { o: [], n: [] };
  for (const r of file.rows) {
    if (r.t === '-') sides.o.push(r);
    else if (r.t === '+' || r.t === ' ') sides.n.push(r);
  }
  const out = new Map();
  for (const rows of Object.values(sides)) {
    if (!rows.length) continue;
    const lines = splitHtmlLines(hljs.highlight(rows.map((r) => r.s).join('\n'), { language: ext, ignoreIllegals: true }).value);
    rows.forEach((r, i) => out.set(r, lines[i]));
  }
  return out;
}
