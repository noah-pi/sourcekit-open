// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Workspace key custody — the receiving side of seal-to-workspace.
 *
 * Custody rules, enforced by design and stated in the UI:
 *  - The workspace private key is shown exactly ONCE, as Shamir shares —
 *    never whole. This tool never stores it; reconstruction needs K shares
 *    pasted by K people and lives in this tab's memory only.
 *  - One stolen laptop holds one share and decrypts NOTHING. That is the
 *    entire point of the split; the UI says it plainly.
 *  - While K shares are combined here, THIS machine holds the whole key in
 *    memory. Decrypt on a machine you trust, and close the tab when done.
 *    Stated, not hidden.
 *  - A swapped workspace key in a roster is a forged roster — devices
 *    reject it.
 */
import React, { useRef, useState } from 'react';
import {
  generateDeskKeyPair, deskKeyFingerprint, deskKeyPairFromPrivateHex,
  parseSealedHeader, unsealWithDeskKey,
} from '@exhibit/lib/seal';
import { splitSecret, combineShares, shareToText, shareFromText, type ShamirShare } from '@exhibit/lib/shamir';
import { bytesToHex, bytesToBase64 } from '@exhibit/lib/bytes';
import { isProofBundle } from '@exhibit/lib/proofBundle';
import { downloadText, downloadBytes } from '../core/util';

export function DeskKeyManager() {
  // ---- generate & split ----
  const [threshold, setThreshold] = useState(2);
  const [count, setCount] = useState(2);
  const [fresh, setFresh] = useState<{ publicKeyBase64: string; fingerprint: string; shares: string[] } | null>(null);
  // ---- reconstruct ----
  const [shareInputs, setShareInputs] = useState<string[]>(['', '']);
  const [deskKey, setDeskKey] = useState<{ privateKey: Uint8Array; fingerprint: string } | null>(null);
  // ---- decrypt ----
  const [sealedFile, setSealedFile] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [messageState, setMessageState] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null);
  /** F31: notices carry a tone — successes and neutral facts are the neutral
      info style; amber is reserved for warnings and failures. */
  const setMessage = (text: string | null, tone: 'warn' | 'info' = 'warn') =>
    setMessageState(text === null ? null : { text, tone });
  const message = messageState;
  const [decrypted, setDecrypted] = useState<{ mediaName: string; media: Uint8Array; proofJson: string | null } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleGenerate() {
    const pair = generateDeskKeyPair();
    const shares = splitSecret(pair.privateKey, threshold, count).map(shareToText);
    setFresh({
      publicKeyBase64: bytesToBase64(pair.publicKey),
      fingerprint: deskKeyFingerprint(pair.publicKey),
      shares,
    });
    setMessage(null);
    // The whole private key existed in this tab's memory for the split only.
  }

  function handleReconstruct() {
    setMessage(null);
    try {
      const shares: ShamirShare[] = shareInputs.filter((s) => s.trim()).map(shareFromText);
      const privateKey = combineShares(shares);
      const pair = deskKeyPairFromPrivateHex(bytesToHex(privateKey));
      setDeskKey({ privateKey: pair.privateKey, fingerprint: deskKeyFingerprint(pair.publicKey) });
      setDecrypted(null);
      setMessage('Workspace key reconstructed — held in this tab’s memory only. Confirm the fingerprint matches your roster before decrypting anything.', 'info');
    } catch (e) {
      setDeskKey(null);
      setMessage(e instanceof Error ? e.message : 'Reconstruction failed.');
    }
  }

  function handleForget() {
    setDeskKey(null);
    setDecrypted(null);
    setSealedFile(null);
    setShareInputs(['', '']);
    setMessage('Key dropped from memory. This tab no longer holds anything that can decrypt captures.', 'info');
  }

  async function handleSealedFile(files: FileList | null) {
    if (!files) return;
    const f = files[0];
    const bytes = new Uint8Array(await f.arrayBuffer());
    try {
      const header = parseSealedHeader(bytes);
      setSealedFile({ name: f.name, bytes });
      setDecrypted(null);
      setMessage(
        deskKey && header.deskKeyFingerprint !== deskKey.fingerprint
          ? `This artifact is sealed to workspace key ${header.deskKeyFingerprint.slice(0, 16)}… — which does NOT match the key in memory (${deskKey.fingerprint.slice(0, 16)}…). Check you have the right shares.`
          : `Sealed artifact recognized — sealed to workspace key ${header.deskKeyFingerprint.slice(0, 16)}…`,
        deskKey && header.deskKeyFingerprint !== deskKey.fingerprint ? 'warn' : 'info'
      );
    } catch (e) {
      setSealedFile(null);
      setMessage(e instanceof Error ? e.message : 'Not a sealed capture.');
    }
  }

  function handleDecrypt() {
    if (!deskKey || !sealedFile) return;
    try {
      const opened = unsealWithDeskKey(sealedFile.bytes, deskKey.privateKey);
      let mediaName = sealedFile.name.replace(/\.vseal$/i, '') || 'capture.bin';
      const proofJson = opened.proofJson;
      if (proofJson) {
        try {
          const parsed = JSON.parse(proofJson);
          if (isProofBundle(parsed) && parsed.media?.mime) {
            const ext = parsed.media.mime.includes('jpeg') ? '.jpg' : parsed.media.mime.includes('png') ? '.png'
              : parsed.media.mime.includes('mp4') ? '.mp4' : parsed.media.mime.includes('m4a') || parsed.media.mime.includes('aac') ? '.m4a' : '.bin';
            if (!mediaName.endsWith(ext)) mediaName += ext;
          }
        } catch { /* proof JSON stays available as raw text */ }
      }
      setDecrypted({ mediaName, media: opened.media, proofJson });
      setMessage('Opened. The media below is exactly what was sealed — GCM authenticated, so tampering could not have produced this. Open it from the Library like any other file.', 'info');
    } catch (e) {
      setDecrypted(null);
      setMessage(e instanceof Error ? e.message : 'Decryption failed.');
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Workspace key</h2>
        <p style={{ fontSize: 14, marginTop: 0 }}>
          An X25519 key for this browser, used to open sealed captures (.vseal). Generate it here, split it K-of-N if
          you share custody; the private key never leaves memory.
        </p>
        <p style={{ fontSize: 14, marginBottom: 0, color: 'var(--text-dim)' }}>
          When your roster carries a workspace encryption key, capture devices can seal captures <strong>to this workspace</strong>:
          the file that leaves the device is ciphertext that only the holders of this key’s shares can open — not the
          device, not anyone who seizes it. The private key exists <strong>only as shares</strong>: one
          stolen laptop decrypts nothing; {threshold} of {count} shares together reconstruct the key, in memory, on
          a machine you trust.
        </p>
      </div>

      <div className="card">
        <h2>1 · Generate workspace key</h2>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <label>Shares needed to open (K)
            <input type="number" min={2} max={count} value={threshold} onChange={(e) => setThreshold(Math.max(2, Math.min(count, Number(e.target.value) || 2)))} style={{ width: 64 }} />
          </label>
          <label>Shares handed out (N)
            <input type="number" min={threshold} max={8} value={count} onChange={(e) => setCount(Math.max(threshold, Math.min(8, Number(e.target.value) || threshold)))} style={{ width: 64 }} />
          </label>
          <button className="btn primary" onClick={handleGenerate}>Generate workspace key</button>
        </div>
        <p className="field-note">
          Recommended: 2-of-2 across two key holders, or 2-of-3 with a sealed envelope in a safe.
          K shares reconstruct; K−1 reveal nothing.
        </p>
      </div>

      {fresh && (
        <div className="card" style={{ borderColor: 'var(--warn-line)', background: 'var(--warn-soft)' }}>
          <h2 style={{ color: 'var(--warn)' }}>Workspace key — shares shown once</h2>
          <table className="kv">
            <tbody>
              <tr><td>Workspace public key</td><td><code style={{ wordBreak: 'break-all' }}>{fresh.publicKeyBase64}</code></td></tr>
              <tr><td>Fingerprint</td><td><code>{fresh.fingerprint}</code></td></tr>
            </tbody>
          </table>
          <p style={{ fontSize: 13 }}>
            Attach the PUBLIC key to your roster (Trust Roster → workspace encryption key). Then give each share to its
            holder — in person or over a channel you already trust. This tool shows them once and never stores them.
          </p>
          {fresh.shares.map((s, i) => (
            <div key={i} style={{ marginBottom: 10 }}>
              <strong>Share {i + 1} of {fresh.shares.length}</strong>
              <code style={{ display: 'block', padding: 8, background: '#fff', wordBreak: 'break-all', fontSize: 12 }}>{s}</code>
              <div className="btn-row" style={{ marginTop: 4 }}>
                <button className="btn secondary" onClick={() => void navigator.clipboard.writeText(s)}>Copy share {i + 1}</button>
                <button className="btn secondary" onClick={() => downloadText(`workspace-key-share-${i + 1}-of-${fresh.shares.length}.txt`, s)}>Download share {i + 1}</button>
              </div>
            </div>
          ))}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <button className="btn secondary" onClick={() => void navigator.clipboard.writeText(fresh.publicKeyBase64)}>Copy public key</button>
            <button className="btn" onClick={() => setFresh(null)}>Shares are distributed — hide them</button>
          </div>
        </div>
      )}

      <div className="card">
        <h2>2 · Reconstruct from shares</h2>
        {!deskKey ? (
          <>
            {shareInputs.map((v, i) => (
              <label key={i}>Share {i + 1}
                <input
                  type="text"
                  value={v}
                  onChange={(e) => setShareInputs((prev) => prev.map((p, j) => (j === i ? e.target.value : p)))}
                  placeholder="verify-share-v1:…"
                />
              </label>
            ))}
            <div className="btn-row">
              <button className="btn secondary" onClick={() => setShareInputs((prev) => [...prev, ''])}>Add another share field</button>
              <button className="btn" disabled={shareInputs.filter((s) => s.trim()).length < 2} onClick={handleReconstruct}>
                Reconstruct in memory
              </button>
            </div>
            <p className="field-note">
              Paste at least K shares. Wrong or mismatched shares fail loudly — this tool never silently produces a
              wrong key. The key lives in this tab’s memory only, until you drop it or close the tab.
            </p>
          </>
        ) : (
          <>
            <table className="kv">
              <tbody>
                <tr><td>Workspace key in memory</td><td><code>{deskKey.fingerprint}</code></td></tr>
              </tbody>
            </table>
            <p style={{ fontSize: 13, color: 'var(--warn)' }}>
              This machine currently holds the whole workspace key in memory. Decrypt what you need, then drop the key.
            </p>
            <div className="btn-row">
              <button className="btn danger" onClick={handleForget}>Drop the key from memory</button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>3 · Open a sealed capture</h2>
        <div className="btn-row">
          <button className="btn secondary" onClick={() => fileRef.current?.click()}>Choose a .vseal file…</button>
          <input ref={fileRef} type="file" accept=".vseal,*/*" style={{ display: 'none' }} onChange={(e) => { void handleSealedFile(e.target.files); e.target.value = ''; }} />
          <button className="btn" disabled={!deskKey || !sealedFile} onClick={handleDecrypt}>Open with the key in memory</button>
        </div>
        {sealedFile && <p className="field-note" style={{ marginBottom: 0 }}>Loaded: {sealedFile.name}</p>}
        {!deskKey && <p className="field-note" style={{ marginBottom: 0 }}>Reconstruct the workspace key (step 2) first — sealed captures are ciphertext without it.</p>}
      </div>

      {decrypted && (
        <div className="card">
          <h2>Opened: {decrypted.mediaName}</h2>
          <div className="btn-row">
            <button className="btn" onClick={() => downloadBytes(decrypted.mediaName, decrypted.media, 'application/octet-stream')}>Download media</button>
            {decrypted.proofJson && (
              <button className="btn secondary" onClick={() => downloadText(decrypted.mediaName + '.proof.json', decrypted.proofJson!, 'application/json')}>Download proof bundle</button>
            )}
          </div>
          <p className="field-note" style={{ marginBottom: 0 }}>
            Next: drop the downloaded media into the Library — the signed file checks there like any capture.
          </p>
        </div>
      )}

      {message && <div className={message.tone === 'info' ? 'info-box' : 'warn-box'} role="status">{message.text}</div>}
    </div>
  );
}
