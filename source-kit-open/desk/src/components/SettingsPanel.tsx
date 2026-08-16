/**
 * Settings — single column, five concerns (DESIGN §4.3):
 *  1. Trust & rosters (today's TrustConfig cards),
 *  2. Keys (the Workspace key — today's DeskKeyManager, moved here),
 *  3. External connectors (W3 — declared endpoints, always opt-in),
 *  4. Local data (kept-items storage usage + the exhibitC.* wipe + the
 *     "what left this browser" audit list, DESIGN §5.9),
 *  5. About this build (version, method versions, the audit disclaimer).
 * All mechanics live in the hosted components; this panel only composes
 * them and states what persists where.
 */
import React, { useState } from 'react';
import type { Roster } from '@exhibit/lib/roster';
import { DESK_VERSION } from '../core/deskCore';
import { fmtBytes } from '../core/deskItem';
import type { AuditEntry } from '../core/caseFile';
import type { ConnectorPrefs } from '../contracts-ext';
import { CONNECTORS } from '../core/connectors';
import { AI, SETTINGS_BOUNDARY_LOG, SETTINGS_CONNECTORS } from '../core/aiStrings';
import { TrustConfig } from './TrustConfig';
import { DeskKeyManager } from './DeskKeyManager';

/** Generic payload phrasing for the Settings card (no item in context). */
const PAYLOAD_KIND_LABEL: Record<string, string> = {
  hash: 'the file’s SHA-256 hash',
  bytes: 'the image bytes (exact size is shown before any send)',
  url: 'the image URL',
};

export function SettingsPanel(props: {
  trustedRosters: Roster[];
  onAddRoster: (roster: Roster) => 'added' | 'stale-rejected';
  onRemoveRoster: (ownerFingerprint: string) => void;
  onlineChecks: boolean;
  onOnlineChecks: (v: boolean) => void;
  likelyMax: number;
  possibleMax: number;
  onThresholds: (likely: number, possible: number) => void;
  /** Kept (pinned) items currently in this browser's storage. */
  keptCount: number;
  keptBytes: number | null;
  /** Wipes exactly the exhibitC.* localStorage keys, with a confirmation. */
  onClearLocalData: () => void;
  /** W3: declared connector endpoints; always opt-in, never automatic. */
  connectorPrefs: ConnectorPrefs;
  onConnectorEndpoint: (connectorId: string, endpoint: string | null) => void;
  /** W3: "what left this browser" — boundary entries from the audit trail. */
  boundaryLog: AuditEntry[];
}) {
  // E24: endpoint drafts + validation. An endpoint is a network destination,
  // so only an https URL with a real host is ever SAVED — anything else is
  // refused with a notice and the draft stays in the field, unsent.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [endpointNotice, setEndpointNotice] = useState<string | null>(null);

  function saveEndpoint(connectorId: string, raw: string) {
    setDrafts((d) => ({ ...d, [connectorId]: raw }));
    const t = raw.trim();
    if (t === '') {
      props.onConnectorEndpoint(connectorId, null);
      setEndpointNotice(null);
      return;
    }
    let u: URL | null = null;
    try {
      u = new URL(t);
    } catch {
      u = null;
    }
    if (u && u.protocol === 'https:' && u.host) {
      props.onConnectorEndpoint(connectorId, t);
      setEndpointNotice(null);
    } else {
      setEndpointNotice(
        `“${t}” was not saved — endpoints must be https URLs with a host. An http or malformed endpoint is refused, so nothing is ever sent somewhere you did not clearly name.`,
      );
    }
  }

  return (
    <div style={{ maxWidth: 720, padding: '24px 32px' }}>
      <TrustConfig
        trustedRosters={props.trustedRosters}
        onAddRoster={props.onAddRoster}
        onRemoveRoster={props.onRemoveRoster}
        onlineChecks={props.onlineChecks}
        onOnlineChecks={props.onOnlineChecks}
        likelyMax={props.likelyMax}
        possibleMax={props.possibleMax}
        onThresholds={props.onThresholds}
      />

      <DeskKeyManager />

      {/* Connectors card (§10.10 slot) — declared, always opt-in (L10). */}
      <div className="card">
        <h2>{SETTINGS_CONNECTORS.title}</h2>
        <p style={{ fontSize: 14, marginTop: 0, color: 'var(--text-dim)' }}>{SETTINGS_CONNECTORS.intro}</p>
        {endpointNotice && (
          <div className="warn-box" role="alert" style={{ marginBottom: 8 }}>{endpointNotice}</div>
        )}
        {CONNECTORS.map((c) => {
          const name = c.id === 'watermark-check' ? AI.connector.wm.name(c.provider) : c.name;
          const endpoint = props.connectorPrefs[c.id]?.endpoint ?? '';
          const shown = drafts[c.id] ?? endpoint;
          return (
            <div key={c.id} className="fx-connector">
              <div className="fx-connector-name">{name}</div>
              <div className="field-note" style={{ marginBottom: 4 }}>
                {SETTINGS_CONNECTORS.sendsLabel} {PAYLOAD_KIND_LABEL[c.payloadKind] ?? c.payloadKind}
                {' · '}
                {endpoint ? SETTINGS_CONNECTORS.configured : SETTINGS_CONNECTORS.notConfigured}
              </div>
              <label style={{ display: 'block', fontSize: 13, color: 'var(--text-dim)' }}>
                {SETTINGS_CONNECTORS.endpointField}
                <input
                  type="url"
                  value={shown}
                  placeholder={SETTINGS_CONNECTORS.endpointPlaceholder}
                  spellCheck={false}
                  style={{ display: 'block', width: '100%', marginTop: 4 }}
                  onChange={(e) => saveEndpoint(c.id, e.target.value)}
                />
              </label>
            </div>
          );
        })}
        <p className="honest-note" style={{ marginBottom: 0 }}>{SETTINGS_CONNECTORS.endpointNote}</p>
      </div>

      <div className="card">
        <h2>Local data</h2>
        <p style={{ fontSize: 14, marginTop: 0 }}>
          Kept items: {props.keptCount} ({props.keptBytes !== null ? fmtBytes(props.keptBytes) : '—'}) in this browser’s storage
        </p>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Trusted rosters, thresholds, and preferences persist in this browser’s local storage
          (keys prefixed <code>exhibitC.</code>) so Source Kit Desk remembers them between visits. On a shared machine,
          wipe them when you leave — the control below removes those keys <strong>and forgets the kept items</strong>,
          after a confirmation that says exactly what it removed. Kept items otherwise stay until you unpin them in the Library.
        </p>
        {/* "What left this browser" (DESIGN §5.9) — from the audit trail. */}
        <h3 style={{ fontSize: 14, margin: '14px 0 6px' }}>{SETTINGS_BOUNDARY_LOG.title}</h3>
        {props.boundaryLog.length === 0 ? (
          <p className="honest-note" style={{ margin: 0 }}>{SETTINGS_BOUNDARY_LOG.empty}</p>
        ) : (
          <table className="kv">
            <thead>
              <tr><th>{SETTINGS_BOUNDARY_LOG.colWhen}</th><th>{SETTINGS_BOUNDARY_LOG.colEntry}</th></tr>
            </thead>
            <tbody>
              {props.boundaryLog.map((e, i) => (
                <tr key={i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{e.ts}</td>
                  <td><strong>{e.action}</strong>{e.detail ? ` — ${e.detail}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn secondary" onClick={props.onClearLocalData}>Clear this browser’s local data</button>
        </div>
      </div>

      <div className="card">
        <h2>About this build</h2>
        <p style={{ fontSize: 14, marginTop: 0 }}>Source Kit Desk {DESK_VERSION}</p>
        <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
          Method versions — every analysis names the version that ran, so a report can be re-checked against the same code.
        </p>
        <p className="honest-note" style={{ marginBottom: 0 }}>
          Written with AI assistance, then verified by the test suites published
          with the source. Every check this tool reports can be reproduced from
          that source — see PROVENANCE.md.
        </p>
      </div>
    </div>
  );
}
