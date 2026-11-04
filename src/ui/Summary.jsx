// The agent's summary as a small, safe subset of markdown, rendered as React
// elements (never as HTML): paragraphs, "- " / "1. " lists, "#"-headings
// (all shown as small subheadings), `code` and **bold**. The first paragraph
// is the lead; the rest reads as normal text.

function inline(text) {
  const out = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0, m, k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(m[1] != null ? <code key={k++}>{m[1]}</code> : <strong key={k++}>{m[2]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function parseBlocks(text) {
  const blocks = [];
  let para = null, list = null;
  const end = () => { para = null; list = null; };
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { end(); continue; }
    const h = line.match(/^#{1,6}\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (h) { end(); blocks.push({ type: 'h', text: h[1] }); }
    else if (ul || ol) {
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) { para = null; list = { type: 'list', ordered, items: [] }; blocks.push(list); }
      list.items.push((ul || ol)[1]);
    } else if (list && /^\s{2,}\S/.test(raw)) {
      list.items[list.items.length - 1] += ' ' + line.trim(); // continuation of a list item
    } else {
      list = null;
      if (para) para.text += ' ' + line.trim();
      else { para = { type: 'p', text: line.trim() }; blocks.push(para); }
    }
  }
  return blocks;
}

export function Summary({ text }) {
  const blocks = parseBlocks(text);
  if (!blocks.length) return <p id="summary" className="summary-lead empty">The agent didn’t describe the change.</p>;
  let lead = false;
  return (
    <div id="summary" className="summary">
      {blocks.map((b, i) => {
        if (b.type === 'h') return <h3 key={i}>{inline(b.text)}</h3>;
        if (b.type === 'list') {
          const L = b.ordered ? 'ol' : 'ul';
          return <L key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</L>;
        }
        const cls = !lead && i === 0 ? 'summary-lead' : undefined;
        if (cls) lead = true;
        return <p key={i} className={cls}>{inline(b.text)}</p>;
      })}
    </div>
  );
}
