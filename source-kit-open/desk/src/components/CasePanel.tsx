/**
 * Case panel — the .exhibitcase affordances (save / open) and the case
 * notes. A case file is the session made durable: item references by path +
 * SHA-256, verdict snapshots, the trust configuration, notes, and a
 * hash-chained audit trail. The chain is tamper-EVIDENCE, not honesty —
 * the panel says so itself, next to the controls.
 *
 * Saving moves bytes only because the user explicitly asked; nothing leaves
 * this tab otherwise. Opening a case re-proves what it carries (rosters are
 * re-verified, the audit chain is validated by parseCase, and a broken chain
 * is refused with the parser's own words).
 */
import React, { useRef, useState } from 'react';
import type { CaseNote } from '../core/caseFile';

export function CasePanel(props: {
  auditEntries: number;
  notes: CaseNote[];
  onAddNote: (text: string) => void;
  onSaveCase: () => void;
  onOpenCase: (file: File) => void;
}) {
  const openRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState('');

  function submitNote() {
    const text = draft.trim();
    if (!text) return;
    props.onAddNote(text);
    setDraft('');
  }

  return (
    <div className="card" style={{ padding: '14px 14px', marginTop: 14, marginBottom: 0 }}>
      <h2>Case file</h2>
      <p className="honest-note" style={{ marginTop: 0 }}>
        The audit trail is hash-chained — tamper-evidence, not proof the recorded actions were honestly chosen.
        Bytes are never stored in a case file: items are references (path + SHA-256 + Source Kit Desk's snapshot).
      </p>
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn secondary" onClick={props.onSaveCase}>Save case (.exhibitcase)</button>
        <button className="btn secondary" onClick={() => openRef.current?.click()}>Open case…</button>
        <input
          ref={openRef}
          type="file"
          accept=".exhibitcase,application/json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) props.onOpenCase(f);
            e.target.value = '';
          }}
        />
      </div>
      <p className="field-note" style={{ marginTop: 6 }}>
        Audit trail: {props.auditEntries} {props.auditEntries === 1 ? 'entry' : 'entries'}, hash-chained — appended on items, checks, roster decisions, notes, and case open/save.
      </p>

      <h3 style={{ marginTop: 12 }}>Notes</h3>
      {props.notes.length === 0 && <p className="honest-note" style={{ margin: '4px 0' }}>No notes yet. Notes are saved into the case file.</p>}
      {props.notes.map((n, i) => (
        <div key={i} style={{ fontSize: 13, borderTop: '1px solid var(--border)', padding: '5px 0' }}>
          <span className="field-note">{new Date(n.ts).toLocaleString()} — </span>
          {n.text}
        </div>
      ))}
      <textarea
        rows={2}
        placeholder="Add a note to the case…"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitNote(); }}
      />
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn secondary" disabled={!draft.trim()} onClick={submitNote}>Add note</button>
      </div>
    </div>
  );
}
