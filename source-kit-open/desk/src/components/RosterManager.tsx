/**
 * Trust Roster — creating and maintaining the signed device-key lists the
 * user chooses to trust.
 *
 * Key custody rules, enforced by design and stated in the UI:
 *  - The roster owner PRIVATE key is shown exactly once at creation and is
 *    never stored by this tool. Editing an existing roster requires pasting
 *    the key again; it lives in memory only for the duration of the edit.
 *  - Every edit (add / rotate / revoke) produces a freshly re-signed roster
 *    with a new issuedAt. The old signature never contaminates the new one.
 *  - Revocation is timestamped "as of now" — past captures signed while the
 *    member was active stay genuine (the departed-device case).
 */
import React, { useRef, useState } from 'react';
import {
  createRoster, resignRoster, rotateEntry, revokeEntry, isRoster,
  type Roster, type RosterEntry,
} from '@exhibit/lib/roster';
import { base64ToBytes } from '@exhibit/lib/bytes';
import { deskKeyFingerprint } from '@exhibit/lib/seal';
import { checkRoster } from '../core/deskCore';
import { downloadJson } from '../core/util';

const emptyEntry = (): RosterEntry => ({
  fingerprint: '',
  name: '',
  role: '',
  validFrom: new Date().toISOString(),
  validTo: null,
  revokedAt: null,
});

export function RosterManager(props: { onTrustRoster: (roster: Roster) => void }) {
  const [roster, setRoster] = useState<Roster | null>(null);
  /** Roster owner private key, in memory only. Never persisted, never uploaded. */
  const [ownerKey, setOwnerKey] = useState<string>('');
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [rosterName, setRosterName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [entry, setEntry] = useState<RosterEntry>(emptyEntry());
  const [messageState, setMessageState] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null);
  /** F31: notices carry a tone — successes and neutral facts are the neutral
      info style; amber is reserved for warnings and failures. */
  const setMessage = (text: string | null, tone: 'warn' | 'info' = 'warn') =>
    setMessageState(text === null ? null : { text, tone });
  const message = messageState;
  const [workspacePub, setWorkspacePub] = useState('');
  const loadRef = useRef<HTMLInputElement>(null);

  async function handleCreate() {
    if (!rosterName.trim() || !ownerName.trim()) {
      setMessage('Roster name and roster owner name are both required.');
      return;
    }
    const { roster: r, editorPrivateKeyHex } = await createRoster({ newsroom: rosterName.trim(), editorName: ownerName.trim() });
    setRoster(r);
    setFreshKey(editorPrivateKeyHex);
    setOwnerKey(editorPrivateKeyHex);
    setMessage(null);
  }

  async function handleLoad(files: FileList | null) {
    if (!files) return;
    try {
      const parsed = JSON.parse(await files[0].text());
      if (!isRoster(parsed)) {
        setMessage('That file is not a verify-roster/1 document.');
        return;
      }
      const check = checkRoster(parsed);
      if (!check.ok) {
        setMessage(`Roster refused: signature does not verify (${check.reason ?? 'unknown'}). A tampered roster is never loaded for editing.`);
        return;
      }
      setRoster(parsed);
      setFreshKey(null);
      setOwnerKey('');
      setMessage('Roster loaded and signature checked. Paste the roster owner private key to make edits.', 'info');
    } catch {
      setMessage('Could not read that file as JSON.');
    }
  }

  async function applyEdit(entries: RosterEntry[], what: string) {
    return applyRosterEdit(entries, undefined, what);
  }

  async function applyRosterEdit(
    entries: RosterEntry[],
    encryption: Roster['encryption'] | null | undefined,
    what: string
  ) {
    if (!roster) return;
    if (!/^[0-9a-fA-F]{64}$/.test(ownerKey.trim())) {
      setMessage('Paste the roster owner private key (64 hex characters — a P-256 key) to re-sign. It is used in memory only and never stored.');
      return;
    }
    try {
      const patch = encryption === undefined ? undefined : { encryption };
      const next = await resignRoster(roster, ownerKey.trim(), entries, patch);
      setRoster(next);
      setEntry(emptyEntry());
      setMessage(`${what} — roster re-signed at ${next.issuedAt}. Export and redistribute it; the previous version is superseded.`, 'info');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Re-sign failed.');
    }
  }

  async function attachWorkspaceKey() {
    if (!roster) return;
    let pub: Uint8Array;
    try {
      pub = base64ToBytes(workspacePub.trim());
      if (pub.length !== 32) throw new Error('bad length');
    } catch {
      setMessage('That is not an X25519 workspace public key (32 bytes, base64 — generated in Settings → Keys).');
      return;
    }
    await applyRosterEdit(roster.entries, {
      deskPublicKeyBase64: workspacePub.trim(),
      fingerprint: deskKeyFingerprint(pub),
      addedAt: new Date().toISOString(),
    }, 'Workspace encryption key attached');
    setWorkspacePub('');
  }

  async function removeWorkspaceKey() {
    if (!roster) return;
    await applyRosterEdit(roster.entries, null, 'Workspace encryption key removed');
  }

  const fpOk = /^[0-9a-fA-F]{64}$/.test(entry.fingerprint.trim());

  return (
    <div style={{ maxWidth: 720, padding: '24px 32px' }}>
      <div className="card">
        <h2>Trust Roster</h2>
        <p style={{ fontSize: 14, color: 'var(--text-dim)', margin: 0 }}>
          A roster is a signed list of device keys you choose to trust. Trusting is your call; Source Kit Desk checks the roster’s signature and staleness, never its politics.
        </p>
      </div>
      {!roster && (
        <>
          <div className="card">
            <h2>Create a roster</h2>
            <label>Roster name<input type="text" value={rosterName} onChange={(e) => setRosterName(e.target.value)} placeholder="Example roster" /></label>
            <label>Roster owner name<input type="text" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="Example owner" /></label>
            <div className="btn-row">
              <button className="btn" onClick={() => void handleCreate()}>Create roster &amp; owner key</button>
              <button className="btn secondary" onClick={() => loadRef.current?.click()}>Load existing roster…</button>
              <input ref={loadRef} type="file" accept=".json" style={{ display: 'none' }} onChange={(e) => { void handleLoad(e.target.files); e.target.value = ''; }} />
            </div>
            <p className="field-note">
              A fresh P-256 owner key is generated in this tab. The private key is shown ONCE — copy it somewhere safe (a password manager, an offline note). This tool never stores it; losing it means the roster can no longer be edited.
            </p>
          </div>
          {message && <div className={message.tone === 'info' ? 'info-box' : 'warn-box'} role="status">{message.text}</div>}
        </>
      )}

      {freshKey && (
        <div className="card" style={{ borderColor: 'var(--warn-line)', background: 'var(--warn-soft)' }}>
          <h2 style={{ color: 'var(--warn)' }}>Roster owner private key — shown once</h2>
          <code style={{ display: 'block', padding: 10, background: '#fff' }}>{freshKey}</code>
          <p style={{ fontSize: 13, color: 'var(--warn)', marginBottom: 0 }}>
            Copy it now. It will not be shown again, is never written to disk by this tool, and is never sent anywhere. Anyone holding it can sign rosters as “{roster?.newsroom}”.
          </p>
          <div className="btn-row">
            <button className="btn secondary" onClick={() => setFreshKey(null)}>I have saved it — hide it</button>
          </div>
        </div>
      )}

      {roster && (
        <>
          <div className="card">
            <h2>{roster.newsroom}</h2>
            <table className="kv">
              <tbody>
                <tr><td>Owner</td><td>{roster.editor.name}</td></tr>
                <tr><td>Owner fingerprint</td><td><code>{roster.editor.fingerprint}</code></td></tr>
                <tr><td>Issued</td><td>{roster.issuedAt}</td></tr>
                <tr><td>Members</td><td>{roster.entries.length} ({roster.entries.filter((e) => !e.revokedAt).length} standing)</td></tr>
              </tbody>
            </table>
            <div className="btn-row">
              <button className="btn" onClick={() => downloadJson(`${roster.newsroom.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-roster.json`, roster)}>Export roster JSON</button>
              <button className="btn primary" onClick={() => props.onTrustRoster(roster)}>Trust in this workspace</button>
              <button className="btn secondary" onClick={() => { setRoster(null); setOwnerKey(''); setMessage(null); }}>Close</button>
            </div>
          </div>

          <div className="card">
            <h2>Device keys</h2>
            {roster.entries.length === 0 && <p className="honest-note">No members yet. A member is a capture device’s signing-key fingerprint — it is read from the Source Kit app (Settings → keys) and given to you out of band.</p>}
            {roster.entries.map((e) => (
              <div key={e.fingerprint} className="roster-entry">
                <strong>{e.name}</strong> — {e.role}
                {e.revokedAt
                  ? <span className="dash-chip warn">revoked {e.revokedAt.slice(0, 10)}</span>
                  : <span className="dash-chip info">member</span>}
                <div className="fp mono">{e.fingerprint}</div>
                <div className="fp">valid {e.validFrom.slice(0, 10)} → {e.validTo ?? 'open-ended'}</div>
                {!e.revokedAt && (
                  <div className="btn-row" style={{ marginTop: 6 }}>
                    <button className="btn danger" onClick={() => void applyEdit(revokeEntry(roster.entries, e.fingerprint), `Revoked ${e.name} as of now`)}>Revoke</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="card">
            <h2>Add a member</h2>
            <label>Signing-key fingerprint (64 hex)<input type="text" value={entry.fingerprint} onChange={(e) => setEntry({ ...entry, fingerprint: e.target.value })} placeholder="from the device’s Source Kit app" /></label>
            {!fpOk && entry.fingerprint.length > 0 && <p className="field-note" style={{ color: 'var(--danger)' }}>A fingerprint is exactly 64 hex characters — never a prefix.</p>}
            <label>Name<input type="text" value={entry.name} onChange={(e) => setEntry({ ...entry, name: e.target.value })} /></label>
            <label>Role<input type="text" value={entry.role} onChange={(e) => setEntry({ ...entry, role: e.target.value })} placeholder="field camera" /></label>
            <label>Valid to (optional, ISO date)<input type="text" value={entry.validTo ?? ''} onChange={(e) => setEntry({ ...entry, validTo: e.target.value || null })} placeholder="leave empty for open-ended" /></label>
            <div className="btn-row">
              <button
                className="btn"
                disabled={!fpOk || !entry.name.trim() || !entry.role.trim()}
                onClick={() => void applyEdit([...roster.entries, { ...entry, fingerprint: entry.fingerprint.trim().toLowerCase() }], `Added ${entry.name}`)}
              >
                Add & re-sign
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Rotate a key</h2>
            <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
              Device replaced or key suspected compromised: add the new fingerprint as a member, then revoke the old one. Rotation keeps past captures genuine — each is judged at its own attested signing time. (Two explicit steps, so nothing happens silently.)
            </p>
          </div>

          <div className="card">
            <h2>Workspace encryption key (seal-to-workspace)</h2>
            {roster.encryption ? (
              <>
                <table className="kv">
                  <tbody>
                    <tr><td>Workspace key fingerprint</td><td><code>{roster.encryption.fingerprint}</code></td></tr>
                    <tr><td>Attached</td><td>{roster.encryption.addedAt}</td></tr>
                  </tbody>
                </table>
                <p style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                  Members’ apps can seal captures to this key — ciphertext only the workspace key’s share holders can open.
                  Removing it stops NEW sealed captures; captures already sealed stay openable by the same shares.
                </p>
                <div className="btn-row">
                  <button className="btn danger" onClick={() => void removeWorkspaceKey()}>Remove workspace key &amp; re-sign</button>
                </div>
              </>
            ) : (
              <>
                <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 0 }}>
                  Optional. With a workspace key attached, member devices can seal captures to this workspace — a seized
                  device holds ciphertext that cannot be opened without the key shares. Generate the key in <strong>Settings → Keys</strong>
                  {' '}first; its private half exists only as shares.
                </p>
                <label>Workspace public key (base64, from Settings → Keys)
                  <input type="text" value={workspacePub} onChange={(e) => setWorkspacePub(e.target.value)} placeholder="from Settings → Keys → Generate workspace key" />
                </label>
                <div className="btn-row">
                  <button className="btn" disabled={!workspacePub.trim()} onClick={() => void attachWorkspaceKey()}>Attach &amp; re-sign</button>
                </div>
              </>
            )}
          </div>

          <div className="card">
            <h2>Owner key for re-signing</h2>
            <label>Paste roster owner private key<input type="text" value={ownerKey} onChange={(e) => setOwnerKey(e.target.value)} placeholder="64 hex characters" /></label>
            <p className="field-note">Held in this tab’s memory only, cleared when you close the roster. Never stored, never transmitted.</p>
          </div>

          {message && <div className={message.tone === 'info' ? 'info-box' : 'warn-box'} role="status">{message.text}</div>}
        </>
      )}
    </div>
  );
}
