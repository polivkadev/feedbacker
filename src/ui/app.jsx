// The review page. Bundled by build.mjs into src/dist/app.js, which is
// committed, so users need no build step.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { highlightFile } from './highlight.js';

const token = new URLSearchParams(location.search).get('t');
const storeKey = 'feedbacker:' + token;
const STATUS = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' };
const EMPTY = [];

// Saved so a refresh doesn't lose work. comments: id -> comment.
function loadState() {
  const empty = { comments: {}, answers: {}, general: '', nextId: 1 };
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

function branchLabel(repo) {
  return repo.branch && repo.branch !== 'HEAD' ? ' [' + repo.branch + ']' : '';
}

function Code({ row, hl }) {
  const h = hl?.get(row);
  return (
    <td className="code">
      <span className="mark">{row.t === ' ' ? '' : row.t}</span>
      {h != null ? <span className="hljs" dangerouslySetInnerHTML={{ __html: h }} /> : <span>{row.s}</span>}
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
      <textarea ref={ta} autoFocus defaultValue={initial} placeholder={'Comment on ' + label}
        onInput={(e) => (draftRef.current = e.target.value)} onKeyDown={keys} />
      <div className="actions">
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={save}>{editing ? 'Save' : 'Comment'}</button>
      </div>
    </td></tr>
  );
}

function CommentRow({ id, c, onEdit, onDelete }) {
  return (
    <tr className="comment"><td colSpan={3}>
      <p className="cbody">{c.body}</p>
      <div className="cmeta">
        {lineLabel(c)}
        <button className="link" onClick={() => onEdit(id)}>Edit</button>
        <button className="link" onClick={() => onDelete(id)}>Delete</button>
      </div>
    </td></tr>
  );
}

const FileDiff = memo(function FileDiff({ fk, domId, file, comments, sel, draftRef, label, onSelect, onSave, onCancel, onEdit, onDelete }) {
  // Large and minified files start collapsed.
  const minified = useMemo(() => file.rows.some((r) => r.s.length > 1000), [file]);
  const [shown, setShown] = useState(file.rows.length <= 2000 && !minified);
  const hl = useMemo(() => (shown ? highlightFile(file) : null), [file, shown]);

  const rows = [];
  if (shown) {
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
    <div className="file" id={domId}>
      <div className="head">
        <span className={'st ' + file.status}>{STATUS[file.status]}</span>
        <span>{file.status === 'renamed' ? file.oldPath + ' → ' + file.path : file.path}</span>
      </div>
      {file.binary && <div className="note">Binary file</div>}
      {!file.binary && !file.rows.length && <div className="note">No content changes</div>}
      {!shown && (
        <div className="note">
          <button onClick={() => setShown(true)}>{minified ? 'Show minified file' : `Show large diff (${file.rows.length} lines)`}</button>
        </div>
      )}
      <div className="scroll"><table><tbody>{rows}</tbody></table></div>
    </div>
  );
});

function Nav({ review, byFile }) {
  return (
    <nav id="nav">
      {review.repos.map((repo, ri) => (
        <div key={ri}>
          <div className="repo">{repo.label}{branchLabel(repo)}</div>
          {repo.files.map((file, fi) => {
            const n = byFile[ri + ':' + fi]?.length || 0;
            return (
              <a key={fi} href={'#f' + ri + '-' + fi}>
                <span className={'st ' + file.status}>{STATUS[file.status]}</span>
                <span>{file.path}</span>
                <span className="count">{n ? '💬' + n : ''}</span>
              </a>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function Questions({ questions, answers, onAnswer }) {
  if (!questions.length) return null;
  return (
    <section className="questions">
      <h2>Questions from the agent</h2>
      {questions.map((q, i) => (
        <div className="q" key={i}>
          <p>{q}</p>
          <textarea placeholder="Your answer" defaultValue={answers[i] || ''} onInput={(e) => onAnswer(i, e.target.value)} />
        </div>
      ))}
    </section>
  );
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

  if (done) {
    return (
      <div className="done">
        <h1>{done.verdict === 'approve' ? 'Approved' : 'Changes requested'}</h1>
        <p>Sent to the agent with {done.n} comment{done.n === 1 ? '' : 's'}. You can close this tab.</p>
      </div>
    );
  }
  if (error) return <div className="done"><h1>Review unavailable</h1><p>{error}</p></div>;
  if (!review) return <div className="done"><p className="hint">Loading…</p></div>;

  return (
    <>
      <header>
        <h1>Review</h1>
        <p id="summary">{review.summary}</p>
        <p className="hint">Click a line number to comment on it; shift-click another to comment on a range.</p>
      </header>
      <div id="layout">
        <Nav review={review} byFile={byFile} />
        <main id="main">
          <Questions questions={review.questions} answers={state.answers} onAnswer={onAnswer} />
          {review.repos.map((repo, ri) => (
            <div key={ri}>
              <h2 className="repo">
                {repo.label}{branchLabel(repo)}{' '}
                <small>{repo.path}{repo.base !== 'HEAD' ? ' vs ' + repo.base : ''}</small>
              </h2>
              {repo.error && <p className="error">{repo.error}</p>}
              {!repo.error && !repo.files.length && <p className="hint">No changes.</p>}
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
            </div>
          ))}
        </main>
      </div>
      <footer>
        <textarea id="general" placeholder="General comment (optional)" defaultValue={state.general}
          onInput={(e) => { const v = e.target.value; update((st) => ({ ...st, general: v })); }} />
        <div className="buttons">
          <button id="changes" className="danger" onClick={() => submit('request_changes')}>Request changes</button>
          <button id="approve" className="primary" onClick={() => submit('approve')}>Approve</button>
        </div>
      </footer>
    </>
  );
}

createRoot(document.getElementById('root')).render(<App />);
