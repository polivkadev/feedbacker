// The review page as a React app. React, ReactDOM, htm and highlight.js are
// vendored globals (see page.html), so there is no build step: htm gives
// JSX-like templates in plain JS.

const { useState, useEffect, useMemo, useRef, useCallback, memo } = React;
const html = htm.bind(React.createElement);

const token = new URLSearchParams(location.search).get('t');
const storeKey = 'feedbacker:' + token;
const STATUS = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };

// Saved so a refresh doesn't lose work. comments: id -> comment.
function loadState() {
  const empty = { comments: {}, answers: {}, general: '', nextId: 1 };
  try { return { ...empty, ...JSON.parse(localStorage.getItem(storeKey)) }; } catch { return empty; }
}

// Syntax highlighting: highlight each side of the file as one text (so
// multi-line strings and comments come out right), then split the HTML back
// into lines, closing and reopening spans at each line break.
function splitHtmlLines(text) {
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

function highlightFile(file) {
  const ext = file.path.split('/').pop().split('.').pop().toLowerCase();
  if (!window.hljs || file.rows.length > 5000 || !hljs.getLanguage(ext)) return null;
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

function anchor(review, fk, a, b) {
  const [ri, fi] = fk.split(':').map(Number);
  const repo = review.repos[ri], file = repo.files[fi];
  const rows = file.rows.slice(a, b + 1).filter((r) => r.t !== 'h');
  const news = rows.filter((r) => r.n != null).map((r) => r.n);
  const olds = rows.filter((r) => r.o != null).map((r) => r.o);
  const nums = news.length ? news : olds;
  return {
    fk, a, b, repo: repo.path, file: file.path, side: news.length ? 'new' : 'old',
    startLine: Math.min(...nums), endLine: Math.max(...nums),
    code: rows.map((r) => r.t + r.s).join('\n'),
  };
}

function lineLabel(c) {
  return c.file + ':' + (c.startLine === c.endLine ? c.startLine : c.startLine + '-' + c.endLine);
}

function Code({ row, hl }) {
  const h = hl?.get(row);
  return html`<td className="code">
    <span className="mark">${row.t === ' ' ? '' : row.t}</span>
    ${h != null
      ? html`<span className="hljs" dangerouslySetInnerHTML=${{ __html: h }} />`
      : html`<span>${row.s}</span>`}
  </td>`;
}

function CommentForm({ label, initial, editing, draftRef, onSave, onCancel }) {
  const ta = useRef(null);
  const save = () => ta.current.value.trim() && onSave(ta.current.value);
  const keys = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
    if (e.key === 'Escape') onCancel();
  };
  // Uncontrolled, so typing doesn't re-render the diff.
  return html`<tr className="comment"><td colSpan="3">
    <textarea ref=${ta} autoFocus defaultValue=${initial} placeholder=${'Comment on ' + label}
      onInput=${(e) => (draftRef.current = e.target.value)} onKeyDown=${keys} />
    <div className="actions">
      <button onClick=${onCancel}>Cancel</button>
      <button className="primary" onClick=${save}>${editing ? 'Save' : 'Comment'}</button>
    </div>
  </td></tr>`;
}

function CommentRow({ id, c, onEdit, onDelete }) {
  return html`<tr className="comment"><td colSpan="3">
    <p className="cbody">${c.body}</p>
    <div className="cmeta">
      ${lineLabel(c)}
      <button className="link" onClick=${() => onEdit(id)}>Edit</button>
      <button className="link" onClick=${() => onDelete(id)}>Delete</button>
    </div>
  </td></tr>`;
}

const FileDiff = memo(function FileDiff({ fk, domId, file, comments, sel, draftRef, onSelect, onSave, onCancel, onEdit, onDelete, label }) {
  // Large and minified files start collapsed.
  const minified = useMemo(() => file.rows.some((r) => r.s.length > 1000), [file]);
  const [shown, setShown] = useState(file.rows.length <= 2000 && !minified);
  const hl = useMemo(() => (shown ? highlightFile(file) : null), [file, shown]);
  const rows = [];
  if (shown) {
    file.rows.forEach((row, i) => {
      if (row.t === 'h') {
        rows.push(html`<tr key=${'h' + i} className="hunk"><td className="ln" /><td className="ln" /><td className="code">${row.s}</td></tr>`);
        return;
      }
      const cls = [row.t === '+' ? 'add' : row.t === '-' ? 'del' : '', sel && i >= sel.a && i <= sel.b ? 'sel' : ''].join(' ').trim();
      const click = (e) => onSelect(fk, i, e.shiftKey);
      rows.push(html`<tr key=${'r' + i} className=${cls}>
        <td className="ln" onClick=${click}>${row.o ?? ''}</td>
        <td className="ln" onClick=${click}>${row.n ?? ''}</td>
        <${Code} row=${row} hl=${hl} />
      </tr>`);
      for (const [id, c] of comments) {
        if (c.b === i && sel?.editing !== id) rows.push(html`<${CommentRow} key=${id} id=${id} c=${c} onEdit=${onEdit} onDelete=${onDelete} />`);
      }
      if (sel && sel.b === i) {
        rows.push(html`<${CommentForm} key="form" label=${label} initial=${draftRef.current} editing=${!!sel.editing}
          draftRef=${draftRef} onSave=${onSave} onCancel=${onCancel} />`);
      }
    });
  }
  return html`<div className="file" id=${domId}>
    <div className="head">
      <span className=${'st ' + file.status}>${STATUS[file.status]}</span>
      <span>${file.status === 'renamed' ? file.oldPath + ' → ' + file.path : file.path}</span>
    </div>
    ${file.binary && html`<div className="note">Binary file</div>`}
    ${!file.binary && !file.rows.length && html`<div className="note">No content changes</div>`}
    ${!shown && html`<div className="note"><button onClick=${() => setShown(true)}>
      ${minified ? 'Show minified file' : `Show large diff (${file.rows.length} lines)`}
    </button></div>`}
    <div className="scroll"><table><tbody>${rows}</tbody></table></div>
  </div>`;
});

function Nav({ review, byFile }) {
  return html`<nav id="nav">
    ${review.repos.map((repo, ri) => html`<div key=${ri}>
      <div className="repo">${repo.label}${branchLabel(repo)}</div>
      ${repo.files.map((file, fi) => {
        const n = byFile[ri + ':' + fi]?.length || 0;
        return html`<a key=${fi} href=${'#f' + ri + '-' + fi}>
          <span className=${'st ' + file.status}>${STATUS[file.status]}</span>
          <span>${file.path}</span>
          <span className="count">${n ? '💬' + n : ''}</span>
        </a>`;
      })}
    </div>`)}
  </nav>`;
}

function branchLabel(repo) {
  return repo.branch && repo.branch !== 'HEAD' ? ' [' + repo.branch + ']' : '';
}

function Questions({ questions, answers, onAnswer }) {
  if (!questions.length) return null;
  return html`<section className="questions">
    <h2>Questions from the agent</h2>
    ${questions.map((q, i) => html`<div className="q" key=${i}>
      <p>${q}</p>
      <textarea placeholder="Your answer" defaultValue=${answers[i] || ''} onInput=${(e) => onAnswer(i, e.target.value)} />
    </div>`)}
  </section>`;
}

function App() {
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [state, setState] = useState(loadState);
  const [sel, setSel] = useState(null); // { fk, start, a, b, editing }
  const [done, setDone] = useState(null);
  const draftRef = useRef('');
  const selRef = useRef(sel);
  selRef.current = sel;
  // Always the latest state, even before React re-renders, so a submit right
  // after typing doesn't send stale values. All changes go through update().
  const stateRef = useRef(state);
  const update = useCallback((fn) => setState((stateRef.current = fn(stateRef.current))), []);

  useEffect(() => {
    fetch('/api/review?t=' + token)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 403 ? 'Invalid or expired review link.' : 'HTTP ' + r.status))))
      .then((r) => {
        setReview(r);
        document.title = 'Review: ' + r.repos.map((x) => x.label).join(', ');
      })
      .catch((e) => setError(e.message === 'Failed to fetch' ? 'This review is closed.' : e.message));
  }, []);
  useEffect(() => { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch {} }, [state]);

  const byFile = useMemo(() => {
    const out = {};
    for (const entry of Object.entries(state.comments)) (out[entry[1].fk] ||= []).push(entry);
    return out;
  }, [state.comments]);

  const onSelect = useCallback((fk, i, extend) => {
    setSel((prev) => {
      if (extend && prev && prev.fk === fk && !prev.editing) return { ...prev, a: Math.min(prev.start, i), b: Math.max(prev.start, i) };
      draftRef.current = '';
      return { fk, start: i, a: i, b: i, editing: null };
    });
  }, []);
  const onCancel = useCallback(() => setSel(null), []);
  const onSave = useCallback((body) => {
    const s = selRef.current;
    update((st) => {
      const id = s.editing || 'c' + st.nextId;
      return {
        ...st,
        comments: { ...st.comments, [id]: { ...anchor(review, s.fk, s.a, s.b), body } },
        nextId: s.editing ? st.nextId : st.nextId + 1,
      };
    });
    draftRef.current = '';
    setSel(null);
  }, [review]);
  const onEdit = useCallback((id) => {
    const c = stateRef.current.comments[id];
    draftRef.current = c.body;
    setSel({ fk: c.fk, start: c.a, a: c.a, b: c.b, editing: id });
  }, []);
  const onDelete = useCallback((id) => update((st) => {
    const { [id]: _, ...rest } = st.comments;
    return { ...st, comments: rest };
  }), []);
  const onAnswer = useCallback((i, v) => update((st) => ({ ...st, answers: { ...st.answers, [i]: v } })), []);

  async function submit(verdict) {
    const state = stateRef.current;
    if (selRef.current && draftRef.current.trim() && !confirm('You have an unsaved comment. Submit without it?')) return;
    const body = {
      verdict,
      general: state.general,
      answers: review.questions.map((question, i) => ({ question, answer: state.answers[i] || '' })),
      comments: Object.values(state.comments).map(({ fk, a, b, ...c }) => c),
    };
    const res = await fetch('/api/submit?t=' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .catch(() => null);
    if (!res?.ok) { alert('Sending failed' + (res ? ': ' + res.status : '') + '. Is the agent still waiting?'); return; }
    try { localStorage.removeItem(storeKey); } catch {}
    setDone({ verdict, n: body.comments.length });
  }

  if (done) {
    return html`<div className="done">
      <h1>${done.verdict === 'approve' ? 'Approved' : 'Changes requested'}</h1>
      <p>Sent to the agent with ${done.n} comment${done.n === 1 ? '' : 's'}. You can close this tab.</p>
    </div>`;
  }
  if (error) return html`<div className="done"><h1>Review unavailable</h1><p>${error}</p></div>`;
  if (!review) return html`<div className="done"><p className="hint">Loading…</p></div>`;

  return html`<${React.Fragment}>
    <header>
      <h1>Review</h1>
      <p id="summary">${review.summary}</p>
      <p className="hint">Click a line number to comment on it; shift-click another to comment on a range.</p>
    </header>
    <div id="layout">
      <${Nav} review=${review} byFile=${byFile} />
      <main id="main">
        <${Questions} questions=${review.questions} answers=${state.answers} onAnswer=${onAnswer} />
        ${review.repos.map((repo, ri) => html`<div key=${ri}>
          <h2 className="repo">
            ${repo.label}${branchLabel(repo)}${' '}
            <small>${repo.path}${repo.base !== 'HEAD' ? ' vs ' + repo.base : ''}</small>
          </h2>
          ${repo.error && html`<p className="error">${repo.error}</p>`}
          ${!repo.error && !repo.files.length && html`<p className="hint">No changes.</p>`}
          ${repo.files.map((file, fi) => {
            const fk = ri + ':' + fi;
            const fileSel = sel?.fk === fk ? sel : null;
            return html`<${FileDiff} key=${fk} fk=${fk} domId=${'f' + ri + '-' + fi} file=${file}
              comments=${byFile[fk] || EMPTY} sel=${fileSel} draftRef=${draftRef}
              label=${fileSel ? lineLabel(anchor(review, fk, fileSel.a, fileSel.b)) : ''}
              onSelect=${onSelect} onSave=${onSave} onCancel=${onCancel} onEdit=${onEdit} onDelete=${onDelete} />`;
          })}
        </div>`)}
      </main>
    </div>
    <footer>
      <textarea id="general" placeholder="General comment (optional)" defaultValue=${state.general}
        onInput=${(e) => { const v = e.target.value; update((st) => ({ ...st, general: v })); }} />
      <div className="buttons">
        <button id="changes" className="danger" onClick=${() => submit('request_changes')}>Request changes</button>
        <button id="approve" className="primary" onClick=${() => submit('approve')}>Approve</button>
      </div>
    </footer>
  </${React.Fragment}>`;
}

const EMPTY = [];

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
