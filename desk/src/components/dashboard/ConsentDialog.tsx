// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * ConsentDialog — the boundary consent modal (DESIGN §5.8, `.fx-consent`).
 * Mandatory before any Tier-3 connector action; driven entirely by the
 * ConnectorConsentFlow state machine (core/connectors/connector.ts), so a
 * refusal can never reach `run` — the dialog only renders what the flow
 * state already guarantees.
 *
 * Contents, in the deck's order: what will be sent (exact payload) · where
 * it goes (provider + host) · what comes back · the fixed boundary line.
 * Buttons: gradient primary "Send and check", secondary "Cancel". No
 * "don't ask again" — consent is per action (L10).
 */
import React, { useEffect, useRef } from 'react';
import type { ConsentState } from '../../core/connectors';
import { AI } from '../../core/aiStrings';

export function ConsentDialog(props: {
  state: ConsentState;
  onConfirm: () => void;
  onRefuse: () => void;
  onAbort: () => void;
  onDismiss: () => void;
}) {
  const { state } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);
  const open = state.phase !== 'idle';

  // Focus management (§7): while the dialog is open it OWNS focus — it is
  // autofocused, Tab cycles inside it, and the element that had focus
  // before it opened gets focus back when it closes.
  useEffect(() => {
    if (!open) return;
    restoreRef.current ??= document.activeElement;
    return () => {
      const prev = restoreRef.current as HTMLElement | null;
      restoreRef.current = null;
      if (prev && document.contains(prev)) prev.focus();
    };
  }, [open]);

  // Autofocus the first actionable control (or the dialog shell) per phase.
  useEffect(() => {
    if (!open) return;
    const el = dialogRef.current;
    if (!el) return;
    (el.querySelector<HTMLElement>('button:not([disabled])') ?? el).focus();
  }, [open, state.phase]);

  function onKeyDown(e: React.KeyboardEvent) {
    // Escape always means "do not send": refuse at the preview, abort a
    // send in flight, dismiss a terminal state.
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (state.phase === 'previewing') props.onRefuse();
      else if (state.phase === 'sending') props.onAbort();
      else props.onDismiss();
      return;
    }
    // The tab trap: focus never leaves the dialog while it is open.
    if (e.key === 'Tab') {
      const el = dialogRef.current;
      if (!el) return;
      const focusables = Array.from(
        el.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) {
        e.preventDefault();
        el.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || !el.contains(active) || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!active || !el.contains(active) || active === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  if (state.phase === 'idle') return null;

  const headingId = 'fx-consent-heading';

  return (
    <div className="fx-consent-backdrop" role="presentation">
      <div
        className="fx-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {state.phase === 'previewing' && (
          <>
            <h2 id={headingId}>{state.connector.name}</h2>
            {/* §5.8 order: what is sent · where it goes · what comes back · the fixed line. */}
            <p className="fx-consent-line"><strong>{AI.connector.sends(state.payload)}</strong></p>
            <p className="fx-consent-line">{AI.connector.where(state.connector.provider, state.host)}</p>
            <p className="fx-consent-line">{AI.connector.returns}</p>
            <p className="fx-consent-fixed">{AI.connector.fixed}</p>
            <div className="btn-row">
              <button className="btn primary" onClick={props.onConfirm}>{AI.connector.confirm}</button>
              <button className="btn secondary" onClick={props.onRefuse}>{AI.connector.cancel}</button>
            </div>
          </>
        )}

        {state.phase === 'sending' && (
          <>
            <h2 id={headingId}>{state.connector.name}</h2>
            <p className="fx-consent-line" role="status">
              {AI.connector.sending(state.host)}
            </p>
            <p className="fx-consent-fixed">{AI.connector.fixed}</p>
            <div className="btn-row">
              <button className="btn secondary" onClick={props.onAbort}>{AI.connector.cancel}</button>
            </div>
          </>
        )}

        {state.phase === 'done' && (
          <>
            <h2 id={headingId}>{state.connector.name}</h2>
            {/* ai.connector.result — their statement, shown as received (L9). */}
            <p className="fx-consent-line">
              {AI.connector.result(state.connector.provider, state.result.summary)}
            </p>
            {state.result.raw !== undefined && (
              <details>
                <summary className="field-note" style={{ cursor: 'pointer' }}>{AI.connector.rawLabel}</summary>
                <pre className="fx-consent-raw">{JSON.stringify(state.result.raw, null, 2)}</pre>
              </details>
            )}
            <div className="btn-row">
              <button className="btn secondary" onClick={props.onDismiss}>Close</button>
            </div>
          </>
        )}

        {state.phase === 'error' && (
          <>
            <h2 id={headingId}>{state.connector.name}</h2>
            {/* ai.connector.error semantics — nothing was computed from the attempt. */}
            <p className="fx-consent-line">{AI.connector.error(state.connector.provider)}</p>
            {state.result.error && <p className="honest-note">{state.result.error}</p>}
            <div className="btn-row">
              <button className="btn secondary" onClick={props.onDismiss}>Close</button>
            </div>
          </>
        )}

        {state.phase === 'refused' && (
          <>
            <h2 id={headingId}>{state.connector.name}</h2>
            <p className="fx-consent-line">
              Refused — nothing was sent, and the connector never ran. The refusal itself is recorded
              in the audit trail, because a record of “no” is honesty evidence too.
            </p>
            <div className="btn-row">
              <button className="btn secondary" onClick={props.onDismiss}>Close</button>
            </div>
          </>
        )}

        {state.phase === 'aborted' && (
          <>
            <h2 id={headingId}>{state.connector.name}</h2>
            <p className="fx-consent-line">
              Cancelled before completion — recorded in the audit trail. Nothing was computed from
              the attempt; the rest of your evidence is untouched.
            </p>
            <div className="btn-row">
              <button className="btn secondary" onClick={props.onDismiss}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
