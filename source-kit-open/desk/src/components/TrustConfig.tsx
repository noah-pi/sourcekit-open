/**
 * Trust & rosters — what THIS workspace trusts. Three knobs, all honest:
 *  1. Trusted rosters (only signature-checked rosters may enter).
 *  2. Online checks (the ONLY network call this tool can make — stated).
 *  3. pHash lead thresholds (tuning parameters, not science).
 *
 * Rendered as a fragment of cards; SettingsPanel (0.15.1) is the host.
 */
import React, { useRef, useState } from 'react';
import type { Roster } from '@exhibit/lib/roster';
import { checkRoster } from '../core/deskCore';
import { ageLine } from '../core/util';

export function TrustConfig(props: {
  trustedRosters: Roster[];
  /** Returns the outcome — a checked-but-stale roster is rejected, and the UI says so. */
  onAddRoster: (roster: Roster) => 'added' | 'stale-rejected';
  onRemoveRoster: (ownerFingerprint: string) => void;
  onlineChecks: boolean;
  onOnlineChecks: (v: boolean) => void;
  likelyMax: number;
  possibleMax: number;
  onThresholds: (likely: number, possible: number) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function importRoster(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files)) {
      try {
        const parsed = JSON.parse(await f.text());
        const check = checkRoster(parsed);
        if (!check.ok) {
          setMessage(`Roster “${parsed?.newsroom ?? f.name}” refused — signature does not check out (${check.reason ?? 'unknown reason'}). An unsigned or tampered roster is never trusted.`);
          continue;
        }
        if (props.onAddRoster(parsed) === 'stale-rejected') {
          setMessage(`Roster “${parsed.newsroom}” refused — this roster is older than the one already trusted. Stale rosters never replace fresh ones.`);
        } else {
          setMessage(`Roster “${parsed.newsroom}” signature checked and added to your trusted rosters — ${ageLine(parsed.issuedAt)} (owner ${check.fingerprint!.slice(0, 16)}…).`);
        }
      } catch {
        setMessage(`“${f.name}” is not a readable roster file.`);
      }
    }
  }

  return (
    <>
      <div className="card">
        <h2>Trusted rosters ({props.trustedRosters.length})</h2>
        <p style={{ fontSize: 14, color: 'var(--text-dim)', marginTop: 0 }}>
          A roster enters this list only if its signature checks out. Membership is then evaluated at each capture’s attested signing time — never at “now”.
        </p>
        {props.trustedRosters.length === 0 && (
          <p className="honest-note">No trusted rosters yet. Files signed by anyone will read “signer not on your trusted roster” — which is a fact, not a warning.</p>
        )}
        {props.trustedRosters.map((r) => (
          <div key={r.editor.fingerprint} className="roster-entry">
            <strong>{r.newsroom}</strong> — owner {r.editor.name}, {r.entries.length} member{r.entries.length === 1 ? '' : 's'}
            <div className="fp mono">owner {r.editor.fingerprint}</div>
            <div className="field-note">{ageLine(r.issuedAt)} — persisted only in this browser’s local storage (<code>exhibitC.*</code>), stated not hidden.</div>
            <div style={{ marginTop: 4 }}>
              <button className="btn secondary" onClick={() => props.onRemoveRoster(r.editor.fingerprint)}>Remove</button>
            </div>
          </div>
        ))}
        <div className="btn-row">
          <button className="btn" onClick={() => fileRef.current?.click()}>Import roster file…</button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { void importRoster(e.target.files); e.target.value = ''; }}
          />
        </div>
        {message && <div className="warn-box" role="status">{message}</div>}
      </div>

      <div className="card">
        <h2>Bitcoin block-header checks</h2>
        <div className="toggle-row">
          <input
            id="online"
            type="checkbox"
            checked={props.onlineChecks}
            onChange={(e) => props.onOnlineChecks(e.target.checked)}
          />
          <label htmlFor="online" style={{ margin: 0, color: 'var(--text)' }}>
            Check ledger receipts against block headers online
          </label>
        </div>
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)', marginBottom: 0 }}>
          Off by default. When on, ledger receipts are checked against block headers from <code>mempool.space</code> — the only network call Source Kit Desk can make on its own. Your media is never part of it.
        </p>
      </div>

      <div className="card">
        <h2>Visual-lead thresholds (pHash)</h2>
        <p style={{ fontSize: 14, color: 'var(--text-dim)', marginTop: 0 }}>
          How close a perceptual fingerprint must be before it surfaces as a lead. Leads are for your eyes to confirm; they gate nothing.
        </p>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <label>
              Likely match ≤
              <input
                type="number"
                min={1}
                max={props.possibleMax}
                value={props.likelyMax}
                onChange={(e) => props.onThresholds(Math.max(1, Number(e.target.value) || 6), props.possibleMax)}
              />
            </label>
          </div>
          <div style={{ flex: 1 }}>
            <label>
              Possible match ≤
              <input
                type="number"
                min={props.likelyMax}
                max={32}
                value={props.possibleMax}
                onChange={(e) => props.onThresholds(props.likelyMax, Math.max(props.likelyMax, Number(e.target.value) || 10))}
              />
            </label>
          </div>
        </div>
        <p className="field-note">Defaults 6 / 10, from common practice — tuning parameters, not science. Exact SHA-256 matches are unaffected by these — exact is certain.</p>
      </div>
    </>
  );
}
