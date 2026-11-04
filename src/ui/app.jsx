// The review page. Bundled by build.mjs into src/dist/app.js, which is
// committed, so users need no build step.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { highlightFile } from './highlight.js';
import './styles.css';

const token = new URLSearchParams(location.search).get('t');
const storeKey = 'feedbacker:' + token;
const STATUS = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
const EMPTY = [];

// Saved so a refresh doesn't lose work. comments: id -> comment.
function loadState() {
  const empty = { comments: {}, answers: {}, general: '', nextId: 1, view: 'all' };
  try { return { ...empty, ...JSON.parse(localStorage.getItem(storeKey)) }; } catch { return empty; }
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

function fileStats(file) {
  let add = 0, del = 0;
  for (const r of file.rows) { if (r.t === '+') add++; else if (r.t === '-') del++; }
  return { add, del };
}

function Counts({ add, del }) {
  return (
    <>
      {add > 0 && <span className="plus">+{add}</span>}
      {del > 0 && <span className="minus">−{del}</span>}
    </>
  );
}

function Code({ row, hl }) {
  const h = hl?.get(row);
  return (
    <td className="code">
      <span className="sign">{row.t === ' ' ? '' : row.t}</span>
      {h != null ? <span dangerouslySetInnerHTML={{ __html: h }} /> : <span>{row.s}</span>}
    </td>
  );
}

// Uncontrolled, so typing doesn't re-render the diff.
function CommentForm({ label, initial, editing, draftRef, onSave, onCancel }) {
  const ta = useRef(null);
  const save = () => ta.current.value.trim() && onSave(ta.current.value);
  const keys = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
    if (e.key === 'Escape') onCancel();
  };
  return (
    <tr className="comment"><td colSpan={3}>
      <div className="form">
        <textarea ref={ta} autoFocus defaultValue={initial} placeholder={'Comment on ' + label}
          onInput={(e) => (draftRef.current = e.target.value)} onKeyDown={keys} />
        <div className="row">
          <span className="hint">Ctrl+Enter to save, Esc to cancel</span>
          <button className="btn quiet small" onClick={onCancel}>Cancel</button>
          <button className="btn primary small" onClick={save}>{editing ? 'Save' : 'Comment'}</button>
        </div>
      </div>
    </td></tr>
  );
}

function CommentRow({ id, c, onEdit, onDelete }) {
  return (
    <tr className="comment"><td colSpan={3}>
      <div className="note-card">
        <div className="meta">
          <span className="where">{lineLabel(c)}</span>
          <span className="actions">
            <button className="btn quiet small edit" onClick={() => onEdit(id)}>Edit</button>
            <button className="btn quiet small" onClick={() => onDelete(id)}>Delete</button>
          </span>
        </div>
        <p className="cbody">{c.body}</p>
      </div>
    </td></tr>
  );
}

const FileDiff = memo(function FileDiff({ fk, domId, file, comments, sel, draftRef, label, onSelect, onSave, onCancel, onEdit, onDelete }) {
  // Large and minified files start collapsed.
  const minified = useMemo(() => file.rows.some((r) => r.s.length > 1000), [file]);
  const [shown, setShown] = useState(file.rows.length <= 2000 && !minified);
  const [open, setOpen] = useState(true);
  const hl = useMemo(() => (shown ? highlightFile(file) : null), [file, shown]);
  const stats = useMemo(() => fileStats(file), [file]);

  const rows = [];
  if (shown && open) {
    file.rows.forEach((row, i) => {
      if (row.t === 'h') {
        rows.push(<tr key={'h' + i} className="hunk"><td className="ln" /><td className="ln" /><td className="code">{row.s}</td></tr>);
        return;
      }
      const cls = [row.t === '+' ? 'add' : row.t === '-' ? 'del' : '', sel && i >= sel.a && i <= sel.b ? 'sel' : ''].join(' ').trim();
      const click = (e) => onSelect(fk, i, e.shiftKey);
      rows.push(
        <tr key={'r' + i} className={cls}>
          <td className="ln" onClick={click}>{row.o ?? ''}</td>
          <td className="ln" onClick={click}>{row.n ?? ''}</td>
          <Code row={row} hl={hl} />
        </tr>,
      );
      for (const [id, c] of comments) {
        if (c.b === i && sel?.editing !== id) rows.push(<CommentRow key={id} id={id} c={c} onEdit={onEdit} onDelete={onDelete} />);
      }
      if (sel && sel.b === i) {
        rows.push(<CommentForm key="form" label={label} initial={draftRef.current} editing={!!sel.editing}
          draftRef={draftRef} onSave={onSave} onCancel={onCancel} />);
      }
    });
  }

  return (
    <div className={'file' + (open ? '' : ' collapsed')} id={domId}>
      <div className="fhead">
        <button className="fold" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={(open ? 'Collapse ' : 'Expand ') + file.path}>
          {open ? '▾' : '▸'}
        </button>
        <span className={'st ' + file.status}>{STATUS[file.status]}</span>
        <span className="name">
          {file.status === 'renamed' && <span className="old">{file.oldPath} → </span>}
          {file.path}
        </span>
        <Counts {...stats} />
        {comments.length > 0 && <span className="marks">{comments.length}</span>}
      </div>
      {open && file.binary && <div className="fnote">Binary file, not shown.</div>}
      {open && !file.binary && !file.rows.length && <div className="fnote">Only the file mode or name changed.</div>}
      {open && !shown && (
        <div className="fnote">
          {minified ? 'Looks minified, so it starts hidden. ' : `${file.rows.length} lines, so it starts hidden. `}
          <button className="btn small" onClick={() => setShown(true)}>Show diff</button>
        </div>
      )}
      {open && shown && rows.length > 0 && <div className="scroll"><table><tbody>{rows}</tbody></table></div>}
    </div>
  );
});

function Tree({ review, visible, byFile }) {
  return (
    <nav className="tree" aria-label="Changed files">
      {review.repos.map((repo, ri) => visible(ri) && (
        <div key={ri}>
          <div className="repo">
            <span className="label">{repo.label}</span>
            {hasBranch(repo) && <span className="branch">{repo.branch}</span>}
          </div>
          {repo.files.map((file, fi) => {
            const n = byFile[ri + ':' + fi]?.length || 0;
            return (
              <a key={fi} href={'#f' + ri + '-' + fi} title={file.path}>
                <span className={'st ' + file.status}>{STATUS[file.status]}</span>
                <span className="path"><bdi>{file.path}</bdi></span>
                <span className="count">{n > 0 && <span className="marks">{n}</span>}</span>
              </a>
            );
          })}
          {!repo.files.length && <div className="empty-note" style={{ paddingLeft: 6 }}>{repo.error ? 'Could not be read' : 'No changes'}</div>}
        </div>
      ))}
    </nav>
  );
}

// "All repos" or a single one. Only shown when there is more than one repo.
function RepoPicker({ review, view, byFile, onChange }) {
  if (review.repos.length < 2) return null;
  const comments = (ri) => review.repos[ri].files.reduce((n, _, fi) => n + (byFile[ri + ':' + fi]?.length || 0), 0);
  return (
    <span className="picker">
      <select aria-label="Show repos" value={view} onChange={(e) => onChange(e.target.value)}>
        <option value="all">All {review.repos.length} repos</option>
        {review.repos.map((repo, ri) => {
          const n = comments(ri);
          return (
            <option key={ri} value={String(ri)}>
              {repo.label}{hasBranch(repo) ? ' on ' + repo.branch : ''} ({repo.files.length ? plural(repo.files.length, 'file') : 'no changes'}{n ? ', ' + plural(n, 'comment') : ''})
            </option>
          );
        })}
      </select>
    </span>
  );
}

function hasBranch(repo) {
  return repo.branch && repo.branch !== 'HEAD';
}

function Questions({ questions, answers, onAnswer }) {
  if (!questions.length) return null;
  return (
    <div className="questions">
      {questions.map((q, i) => (
        <div className={'question' + ((answers[i] || '').trim() ? ' answered' : '')} key={i}>
          <p>{q}</p>
          <textarea placeholder="Your answer" defaultValue={answers[i] || ''} onInput={(e) => onAnswer(i, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

function plural(n, word) {
  return n + ' ' + word + (n === 1 ? '' : 's');
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

  // Functional update: a shift-click right after a click must see the first
  // selection even before React has re-rendered. (Clearing the draft in the
  // updater is idempotent, so a double invoke is harmless.)
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
  }, [review, update]);
  const onEdit = useCallback((id) => {
    const c = stateRef.current.comments[id];
    draftRef.current = c.body;
    setSel({ fk: c.fk, start: c.a, a: c.a, b: c.b, editing: id });
  }, []);
  const onDelete = useCallback((id) => update((st) => {
    const { [id]: _, ...rest } = st.comments;
    return { ...st, comments: rest };
  }), [update]);
  const onAnswer = useCallback((i, v) => update((st) => ({ ...st, answers: { ...st.answers, [i]: v } })), [update]);

  async function submit(verdict) {
    const st = stateRef.current;
    if (selRef.current && draftRef.current.trim() && !confirm('You have an unsaved comment. Submit without it?')) return;
    const body = {
      verdict,
      general: st.general,
      answers: review.questions.map((question, i) => ({ question, answer: st.answers[i] || '' })),
      comments: Object.values(st.comments).map(({ fk, a, b, ...c }) => c),
    };
    const res = await fetch('/api/submit?t=' + token, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .catch(() => null);
    if (!res?.ok) { alert('Sending failed' + (res ? ': ' + res.status : '') + '. Is the agent still waiting?'); return; }
    try { localStorage.removeItem(storeKey); } catch {}
    setDone({ verdict, n: body.comments.length });
  }

  // A saved view can point at a repo that isn't in this review any more.
  const view = review && state.view !== 'all' && review.repos[Number(state.view)] ? state.view : 'all';
  const visible = useCallback((ri) => view === 'all' || String(ri) === view, [view]);
  const onView = useCallback((v) => { update((st) => ({ ...st, view: v })); window.scrollTo(0, 0); }, [update]);
  const totals = useMemo(() => {
    if (!review) return null;
    let files = 0, add = 0, del = 0;
    review.repos.forEach((repo, ri) => {
      if (!visible(ri)) return;
      for (const f of repo.files) { files++; const st = fileStats(f); add += st.add; del += st.del; }
    });
    return { files, add, del };
  }, [review, visible]);
  const nComments = Object.keys(state.comments).length;

  if (done) {
    return (
      <div className="status done">
        <span className={'stamp ' + done.verdict}>{done.verdict === 'approve' ? 'Approved' : 'Changes requested'}</span>
        <h1>Sent to the agent</h1>
        <p>{plural(done.n, 'comment')} went back with your verdict. You can close this tab.</p>
      </div>
    );
  }
  if (error) return <div className="status"><h1>This review isn't available</h1><p>{error}</p></div>;
  if (!review) return <div className="status"><p>Loading the changes…</p></div>;

  return (
    <>
      <header className="bar">
        <span className="title">Review</span>
        <RepoPicker review={review} view={view} byFile={byFile} onChange={onView} />
        <span className="stats">
          <span>{view === 'all' ? plural(totals.files, 'file') + ' in ' + plural(review.repos.length, 'repo') : plural(totals.files, 'file')}</span>
          <Counts add={totals.add} del={totals.del} />
        </span>
        {nComments > 0 && <span className="marks">{plural(nComments, 'comment')}</span>}
        <span className="spacer" />
        <button id="changes" className="btn reject" onClick={() => submit('request_changes')}>Request changes</button>
        <button id="approve" className="btn approve" onClick={() => submit('approve')}>Approve</button>
      </header>
      <div className="layout">
        <Tree review={review} visible={visible} byFile={byFile} />
        <main className="review">
          <section className="handoff">
            <p id="summary" className={'summary' + (review.summary ? '' : ' empty')}>{review.summary || 'The agent didn’t describe the change.'}</p>
            <Questions questions={review.questions} answers={state.answers} onAnswer={onAnswer} />
          </section>
          <p className="empty-note">Click a line number to comment on it. Shift-click a second one to cover a range.</p>
          {review.repos.map((repo, ri) => visible(ri) && (
            <section key={ri}>
              <div className="repo-head">
                <h2>{repo.label}</h2>
                {hasBranch(repo) && <span className="branch">{repo.branch}</span>}
                <span className="where">{repo.path}{repo.base !== 'HEAD' ? ' compared with ' + repo.base : ''}</span>
              </div>
              {repo.error && <p className="error">{repo.error}</p>}
              {!repo.error && !repo.files.length && <p className="empty-note">No changes in this repo.</p>}
              {repo.files.map((file, fi) => {
                const fk = ri + ':' + fi;
                const fileSel = sel?.fk === fk ? sel : null;
                return (
                  <FileDiff key={fk} fk={fk} domId={'f' + ri + '-' + fi} file={file}
                    comments={byFile[fk] || EMPTY} sel={fileSel} draftRef={draftRef}
                    label={fileSel ? lineLabel(anchor(review, fk, fileSel.a, fileSel.b)) : ''}
                    onSelect={onSelect} onSave={onSave} onCancel={onCancel} onEdit={onEdit} onDelete={onDelete} />
                );
              })}
            </section>
          ))}
          <section className="finish">
            <h2>Your review</h2>
            <p>Anything for the agent that isn’t about a specific line.</p>
            <textarea id="general" placeholder="General comment (optional)" defaultValue={state.general}
              onInput={(e) => { const v = e.target.value; update((st) => ({ ...st, general: v })); }} />
            <div className="row">
              <button className="btn approve" onClick={() => submit('approve')}>Approve</button>
              <button className="btn reject" onClick={() => submit('request_changes')}>Request changes</button>
            </div>
          </section>
        </main>
      </div>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
