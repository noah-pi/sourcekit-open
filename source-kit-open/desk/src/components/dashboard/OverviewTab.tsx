// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * OverviewTab — the Overview surface of the asset dashboard (DESIGN §4.2).
 * Every capability the stopgap DossierView carried lands here, re-laid as
 * dashboard cards with signal rows (§5.3): preview, who-signed, attribution,
 * time (three separate claims), capture-integrity, proof↔media recovery,
 * provenance chain (§5.7), hashes, declared C2PA actions (+ the fixed L8
 * line), the Tier-0 byte-reads section (metadata / strings / JPEG structure
 * / embedded thumbnail — computed at intake, SHOWN not run), a cross-link
 * to the rephoto signals (re-homed to the Forensics tab in W4), pose-trace
 * ↔motion, App Attest, checks performed/not-performed
 * (L12), publishing guidance, and the "how we know this" export.
 *
 * Copy: DESIGN §10.4/§10.5 string-for-string. Where the old DossierView
 * wording conflicted with the copy deck, the deck won.
 *
 * Object URLs follow the LibraryPanel Thumb pattern exactly ({url, owned}
 * + revoke on unmount/change) — the DossierView blob-URL leak is closed.
 */
import React, { useEffect, useMemo } from 'react';
import type { GlobalMotion } from '@exhibit/lib/opticalflow';
import type { AssetDashboardProps } from '../../contracts';
import type { C2paSummary, SignalStatus, ThumbnailDiff } from '../../contracts-ext';
import type { ArtifactCheck, DeskTrust } from '../../core/deskCore';
import type { DeskItem } from '../../core/deskItem';
import type { SampledFrame } from '../../core/videoMotion';
import { buildHowWeKnowHtml, downloadHtml } from '../../core/howWeKnow';
import { INFO_COLOR } from '../../core/uiTokens';
import { ProvenanceChain } from './ProvenanceChain';
import { SignalRow, TOOLTIPS } from './dashUi';

/* ------------------------------------------------------------------ */
/* Preview — the owned object-URL pattern (r5 §8 leak, closed)         */
/* ------------------------------------------------------------------ */

function usePreviewUrl(item: DeskItem): { url: string; mime: string } | null {
  const made = useMemo(() => {
    if (item.kind !== 'media') return null;
    // Large videos carry a lazy, session-owned object URL instead of bytes.
    if (item.objectUrl) return { url: item.objectUrl, mime: item.objectMime ?? 'video/mp4', owned: false };
    if (!item.bytes) return null;
    const v = item.report?.verdict;
    if (v === 'NOT_JPEG' || v === 'NOT_BMFF') return null;
    const mime = item.bytes[0] === 0xff ? 'image/jpeg'
      : item.bytes[0] === 0x89 ? 'image/png'
      : 'video/mp4';
    return { url: URL.createObjectURL(new Blob([item.bytes.slice().buffer as ArrayBuffer], { type: mime })), mime, owned: true };
  }, [item]);

  useEffect(() => {
    return () => {
      // Owned URLs are revoked on unmount and on item change — never leaked.
      if (made?.owned) URL.revokeObjectURL(made.url);
    };
  }, [made]);

  return made;
}

function PreviewCard({ item }: { item: DeskItem }) {
  const preview = usePreviewUrl(item);
  if (!preview) return null;
  return (
    <div className="card">
      <h2>Preview — rendered locally</h2>
      <div className="dash-preview">
        {preview.mime.startsWith('image')
          ? <img src={preview.url} alt={item.name} />
          : <video src={preview.url} controls muted />}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Who signed it (§10.5 ov.trust.*)                                     */
/* ------------------------------------------------------------------ */

function TrustCard({ trust }: { trust: DeskTrust }) {
  const label = trust.tier === 'roster' ? 'On your trusted roster'
    : trust.tier === 'org' ? 'Organization credential (your call)'
    : 'Signer not recognized';
  return (
    <div className="card" id="dash-card-trust">
      <h2>Who signed it</h2>
      <p style={{ margin: '0 0 4px' }}>
        <strong>{label}</strong>
      </p>
      <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 14 }}>{trust.basis}</p>
      {trust.warning && <div className="warn-box">{trust.warning}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Attribution — claimed, not verified (§10.5 ov.attribution.*)         */
/* ------------------------------------------------------------------ */

function AttributionCard({ item }: { item: DeskItem }) {
  const identity = item.report?.record?.identity;
  if (!identity) return null;
  if (identity === 'redacted') {
    return (
      <div className="card">
        <h2>Attribution</h2>
        <p style={{ margin: 0, fontSize: 14 }}>Deliberately redacted by the signer before sharing.</p>
      </div>
    );
  }
  if (!identity.author && !identity.organization) return null;
  return (
    <div className="card">
      <h2>Attribution — claimed, not verified</h2>
      <p style={{ margin: 0, fontSize: 14 }}>
        {[identity.author, identity.organization].filter(Boolean).join(' · ')}
      </p>
      <p className="honest-note" style={{ marginBottom: 0 }}>
        Self-asserted by the signing software. The roster entry above is the identity check; this text is not.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Time — three separate claims (§10.5 ov.time.*)                       */
/* ------------------------------------------------------------------ */

function TimeCard({ item, artifact }: { item: DeskItem; artifact: ArtifactCheck | null }) {
  const record = item.report?.record ?? item.bundle?.record ?? null;
  const ts = item.report?.c2pa?.timestamps;
  if (!record) return null;
  return (
    <div className="card" id="dash-card-time">
      <h2>Time — three separate claims</h2>
      <table className="kv">
        <tbody>
          <tr>
            <td>Device clock at capture</td>
            <td>{record.capturedAt} <span className="honest-note">— a claim by the device; not independently verified</span></td>
          </tr>
          {ts && (
            <tr>
              <td>Authority time (RFC 3161)</td>
              <td>
                {ts.valid} of {ts.present} token{ts.present === 1 ? '' : 's'} cryptographically valid
                {ts.earliestValidUtc && <>; earliest valid countersigned time <strong>{ts.earliestValidUtc}</strong></>}
                {ts.tsaNames.length > 0 && <div className="honest-note">Authorities: {ts.tsaNames.join(', ')}</div>}
                {ts.failures.length > 0 && <div className="honest-note">Failed: {ts.failures.join('; ')}</div>}
              </td>
            </tr>
          )}
          <tr>
            <td>Ledger time (Bitcoin)</td>
            <td>
              {(artifact?.ots ?? []).length === 0 && <span className="honest-note">No ledger receipts attached.</span>}
              {(artifact?.ots ?? []).map((o, i) => (
                <div key={i} style={{ marginBottom: 4 }}>
                  {o.state === 'confirmed' && <>Confirmed in block <strong>#{o.blockHeight}</strong> via {o.calendar}</>}
                  {o.state === 'pending' && <>Submitted to {o.calendar} — awaiting Bitcoin confirmation</>}
                  {o.state === 'unverifiable' && <span style={{ color: 'var(--warn)' }}>{o.calendar}: could not be checked ({o.reason})</span>}
                  {/* Deck decision (a): `verified` renders as "checks out" — an
                      info dash-chip, never a green pill (green is L6-locked). */}
                  {o.binding === 'verified' && <span className="dash-chip info">block binding checks out</span>}
                  {o.binding === 'failed' && <span className="dash-chip danger">binding inconsistent</span>}
                  {o.binding === 'unchecked' && o.state === 'confirmed' && <span className="dash-chip neutral">binding not checked</span>}
                  {o.bindingNote && <div className="honest-note">{o.bindingNote}</div>}
                </div>
              ))}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Capture-integrity signals (§10.5 ov.ci.*)                            */
/* ------------------------------------------------------------------ */

function CaptureIntegrityCard({ item }: { item: DeskItem }) {
  const ci = item.report?.record?.captureIntegrity ?? item.bundle?.record?.captureIntegrity ?? null;
  if (!ci) return null;
  return (
    <div className="card" id="dash-card-capture-integrity">
      <h2>Capture-integrity signals</h2>
      <SignalRow label="Shutter → signature gap" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.captureIntegrity}>
        {ci.captureToSignatureMs >= 1000 ? `${(ci.captureToSignatureMs / 1000).toFixed(1)} s` : `${ci.captureToSignatureMs} ms`}
        <div className="honest-note">
          {ci.captureToSignatureMs < 2000
            ? 'Consistent with capture-then-sign.'
            : 'Long enough that the bytes could have been altered between capture and seal.'}
        </div>
      </SignalRow>
      <SignalRow
        label="Sensor-frame timing"
        chip={ci.sensorTiming ? { tone: 'info', text: 'Observed' } : { tone: 'neutral', text: 'Insufficient signal' }}
        tip={TOOLTIPS.captureIntegrity}
      >
        {ci.sensorTiming
          ? <>{ci.sensorTiming.samples} samples, interval CV {ci.sensorTiming.intervalCv}</>
          : 'Not enough motion samples — no signal, stated rather than guessed'}
        {ci.sensorTiming && <div className="honest-note">Regularity is consistent with live capture; it does not prove it.</div>}
      </SignalRow>
      <p className="honest-note" style={{ marginBottom: 0 }}>
        Self-reported by the device: a compromised device could fabricate these signals. Their value is commitment under signature, not detection.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Proof ↔ media recovery (§10.5 ov.recovery.*)                         */
/* ------------------------------------------------------------------ */

function RecoveryCard(props: AssetDashboardProps) {
  const { matches, custodyMatches, item } = props;
  const mine = matches.filter((m) => m.proofItemId === item.id || m.mediaItemId === item.id);
  const custody = custodyMatches.filter((m) => m.mediaItemId === item.id || m.bundleItemId === item.id);
  if (mine.length === 0 && custody.length === 0) return null;
  return (
    <div className="card" id="dash-card-recovery">
      <h2>Proof ↔ media recovery</h2>
      {custody.map((m, i) => (
        <div key={`c${i}`} style={{ marginBottom: 8, fontSize: 14 }}>
          ✓ <strong>Exact match (certain):</strong>{' '}
          {m.mediaItemId === item.id ? (
            <>the detached manifest in <strong>{m.bundleName}</strong> ({m.manifestLabel}) commits to this file’s exact bytes — its signature verifies, and its asset hash matches with the manifest’s own bytes excluded, exactly as the construction intends. A platform stripped the credentials in transit; the custody chain is intact.</>
          ) : (
            <>this bundle’s manifest ({m.manifestLabel}) commits to <strong>{m.mediaName}</strong>’s exact bytes — credentials were stripped in transit; custody is intact.</>
          )}
        </div>
      ))}
      {mine.map((m, i) => (
        <div key={i} style={{ marginBottom: 8, fontSize: 14 }}>
          {m.grade === 'exact' ? (
            <>✓ <strong>Exact match (certain):</strong> {m.proofItemId === item.id ? m.mediaName : m.proofName} — SHA-256 identical to the signed bytes.</>
          ) : (
            <>
              <span style={{ color: 'var(--warn)' }}>◐ <strong>Visual lead — not a verdict:</strong></span>{' '}
              {m.proofItemId === item.id ? m.mediaName : m.proofName} (pHash distance {m.distance}
              {m.viaMediaName ? ` from ${m.viaMediaName}` : ''}). <strong>Confirm visually before use.</strong>
            </>
          )}
        </div>
      ))}
      <p className="honest-note" style={{ marginBottom: 0 }}>
        Exact matches are cryptographic — byte-identical, or exact-after-strip with the manifest’s own bytes
        excluded. Visual leads mean the file was likely re-encoded in transit; the hash binding is broken by
        design and only a person can bridge it.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hashes (§10.5 ov.hashes.*) — mono values, tooltipped (§10.13)        */
/* ------------------------------------------------------------------ */

function HashesCard({ item }: { item: DeskItem }) {
  const report = item.report ?? null;
  return (
    <div className="card" id="dash-card-hashes">
      <h2>Hashes</h2>
      {item.sha256Hex && (
        <SignalRow label="File SHA-256 (recomputed)" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.hashMatch}>
          <span className="dash-hash">{item.sha256Hex}</span>
        </SignalRow>
      )}
      {report?.checks.recomputedSha256 && report.checks.recomputedSha256 !== item.sha256Hex && (
        <SignalRow label="Signed-region SHA-256" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.hashMatch}>
          <span className="dash-hash">{report.checks.recomputedSha256}</span>
        </SignalRow>
      )}
      {report?.c2pa?.signerFingerprint && (
        <SignalRow label="Signer fingerprint" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.signatureValidity}>
          <span className="dash-hash">{report.c2pa.signerFingerprint}</span>
        </SignalRow>
      )}
      {item.pHash && (
        <SignalRow label="Perceptual hash (pHash)" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.phashLead}>
          <span className="dash-hash">{item.pHash}</span>{' '}
          <span className="honest-note">— a perceptual fingerprint; a similarity signal, never a verdict</span>
        </SignalRow>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Declared C2PA actions (+ the fixed L8 line, §10.5 ov.c2pa.*)         */
/* ------------------------------------------------------------------ */

function DeclaredActionsCard({ summary }: { summary: C2paSummary | SignalStatus | null }) {
  if (!summary || 'state' in summary) return null;
  const declaredBy = summary.claimGenerator ?? 'the sealing software';
  return (
    <div className="card" id="dash-card-c2pa-actions">
      <h2>Declared actions</h2>
      {summary.actions && summary.actions.length > 0 ? (
        <>
          {summary.actions.map((a, i) => (
            <SignalRow key={i} label={a.action} chip={{ tone: 'info', text: 'Declared' }} tip={TOOLTIPS.c2paActions}>
              {a.description ?? a.action}
              {a.softwareAgent ? ` — ${a.softwareAgent}` : ''}
              {a.when ? ` · ${a.when}` : ''}
              <div className="honest-note">
                declared by {a.softwareAgent ?? declaredBy}
                {!a.referenced && ' — this actions box is not referenced by the signed claim; it was attached after signing and proves nothing'}
              </div>
            </SignalRow>
          ))}
          {/* The fixed L8 line — non-removable, exact (§10.5 ov.c2pa.actions.fixed). */}
          <p className="honest-note" style={{ marginBottom: 0 }}>
            Actions above were declared by the sealing software. A valid seal cannot show that nothing else happened.
          </p>
        </>
      ) : (
        <p className="dash-absence" style={{ margin: 0 }}>
          No edit-history actions were declared by {declaredBy}. Absence of a declaration says nothing —
          most seals today declare none.
        </p>
      )}
      {summary.ingredients.length > 0 && (
        <SignalRow label="Declared ingredients" chip={{ tone: 'info', text: 'Declared' }} tip={TOOLTIPS.c2paActions}>
          {summary.ingredients.map((ing, i) => (
            <div key={i}>
              {ing.title ?? 'untitled'}
              {ing.format ? ` (${ing.format})` : ''}
              {ing.relationship ? ` — ${ing.relationship}` : ''}
              {!ing.referenced && <span className="honest-note"> — declared, not covered by the signed claim</span>}
            </div>
          ))}
        </SignalRow>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tier-0 byte-reads section — computed at intake, SHOWN not run        */
/* (metadata / strings / JPEG structure / embedded thumbnail, with     */
/* N/A-with-reason states and §10.13 tooltips)                          */
/* ------------------------------------------------------------------ */

function statusChipFor(s: SignalStatus): { tone: 'neutral' | 'warn'; text: string } {
  return s.state === 'error'
    ? { tone: 'warn', text: 'Could not be read' }
    : s.state === 'not-run'
      ? { tone: 'neutral', text: 'Not run' }
      : { tone: 'neutral', text: 'Not applicable' };
}

function JpegStructureCard({ report }: { report: NonNullable<DeskItem['intakeReport']> }) {
  const s = report.jpegStructure;
  if (s === null) {
    return (
      <div className="card" id="dash-card-jpeg-structure">
        <h2>JPEG structure &amp; quantization tables</h2>
        <p className="dash-absence">Not applicable — this item carries no media bytes to analyze.</p>
      </div>
    );
  }
  if ('state' in s) {
    if (s.state === 'observed') return null; // unreachable — JpegStructure carries no 'state'
    return (
      <div className="card" id="dash-card-jpeg-structure">
        <h2>JPEG structure &amp; quantization tables</h2>
        <SignalRow label="Structure" chip={statusChipFor(s)} tip={TOOLTIPS.quantClass}>
          {s.reason}
        </SignalRow>
      </div>
    );
  }
  const q = s.quantization;
  return (
    <div className="card" id="dash-card-jpeg-structure">
      <h2>JPEG structure &amp; quantization tables</h2>
      {/* Deck decision (f): the quantization tables gloss on first use. */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        The quantization tables are the compression recipe the last JPEG saver used.
      </p>
      {s.dimensions && (
        <SignalRow label="Image" chip={{ tone: 'info', text: 'Observed' }}>
          {s.dimensions.width}×{s.dimensions.height}
          {s.encoding ? ` · ${s.encoding === 'baseline' ? 'baseline' : s.encoding === 'progressive' ? 'progressive' : 'other'} encoding` : ''}
        </SignalRow>
      )}
      <SignalRow label="Marker sequence" chip={{ tone: 'info', text: 'Observed' }}>
        <div className="fx-marker-seq">{s.markers.map((m) => m.name).join(' → ')}</div>
      </SignalRow>
      {s.comments.length > 0 && (
        <SignalRow label="COM comments" chip={{ tone: 'info', text: 'Observed' }}>
          {s.comments.map((cmt, i) => (
            <div key={i} className="dash-hash" style={{ display: 'block', marginBottom: 4 }}>{cmt}</div>
          ))}
        </SignalRow>
      )}
      {q ? (
        <SignalRow label="Quantization tables" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.quantClass}>
          <div>
            Quantization tables: {q.class === 'standard' ? 'Standard' : q.class === 'adobe-style' ? 'Adobe-style' : 'Non-standard'}
            {q.closestQuality !== null ? ` — closest quality estimate ≈${q.closestQuality}` : ''} ({q.tableCount} table{q.tableCount === 1 ? '' : 's'})
          </div>
          {/* fx.jpeg.qt.note — the honest caveat rides with the estimate. */}
          <div className="honest-note">{q.note}</div>
        </SignalRow>
      ) : (
        <SignalRow label="Quantization tables" chip={{ tone: 'neutral', text: 'Not applicable' }} tip={TOOLTIPS.quantClass}>
          No quantization tables in the header — unusual but not damning; stated, not guessed.
        </SignalRow>
      )}
    </div>
  );
}

function MetadataCard({ report }: { report: NonNullable<DeskItem['intakeReport']> }) {
  const layer = report.byteReads;
  return (
    <div className="card">
      <h2>Embedded metadata</h2>
      {!layer ? (
        <p className="dash-absence">Not applicable — this item carries no media bytes to analyze.</p>
      ) : layer.metadata.state === 'absent' ? (
        <div className="dash-absence">
          {/* fx.meta.stripped — absence is normal (L4). */}
          {layer.metadata.reason}
          <div className="dash-absence-scope">
            This tool can only report what is embedded; it cannot tell you what this file is.
          </div>
        </div>
      ) : (
        <>
          {layer.metadata.entries.map((e, i) => (
            <SignalRow key={i} label={e.label} chip={{ tone: 'info', text: 'Declared' }}>
              {e.value}
            </SignalRow>
          ))}
          {layer.metadata.gps.present && layer.metadata.gps.text && (
            <SignalRow label="GPS (declared)" chip={{ tone: 'info', text: 'Declared' }}>
              {layer.metadata.gps.text}
            </SignalRow>
          )}
          {layer.metadata.truncated && (
            <p className="honest-note">Only the first {layer.metadata.entries.length} entries are listed — stated, not hidden.</p>
          )}
          {layer.metadataProblem && (
            <p className="honest-note">The metadata stream broke partway ({layer.metadataProblem}) — what is shown is what was readable before the break.</p>
          )}
        </>
      )}
    </div>
  );
}

function StringsCard({ report }: { report: NonNullable<DeskItem['intakeReport']> }) {
  const layer = report.byteReads;
  return (
    <div className="card">
      <h2>Strings layer</h2>
      {/* fx.strings.note */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Readable text embedded in the bytes — edit histories, encoder marks. Presence and absence are both normal.
      </p>
      {!layer ? (
        <p className="dash-absence">Not applicable — this item carries no media bytes to analyze.</p>
      ) : layer.strings.state === 'absent' ? (
        <p className="dash-absence">{layer.strings.reason} — absence here is normal and says nothing about the file.</p>
      ) : (
        <>
          <SignalRow label="Readable runs" chip={{ tone: 'info', text: 'Observed' }}>
            {layer.strings.totalCount} run{layer.strings.totalCount === 1 ? '' : 's'} of ≥4 characters
            {layer.strings.truncated ? ` (first ${layer.strings.runs.length} listed)` : ''}
          </SignalRow>
          <div className="fx-strings-list">
            {layer.strings.runs.map((r, i) => (
              <div key={i}>{r}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** Embedded thumbnail — preview URL owned here and revoked on change/unmount. */
function ThumbnailCard({ report }: { report: NonNullable<DeskItem['intakeReport']> }) {
  const t = report.thumbnail;
  const observed = t && 'byteLength' in t ? t : null;

  const made = useMemo(() => {
    if (!observed) return null;
    return {
      url: URL.createObjectURL(new Blob([observed.bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' })),
      owned: true,
    };
  }, [observed]);
  useEffect(() => {
    return () => {
      if (made?.owned) URL.revokeObjectURL(made.url);
    };
  }, [made]);

  if (!t) {
    return (
      <div className="card">
        <h2>Embedded thumbnail</h2>
        <p className="dash-absence">Not applicable — this item carries no media bytes to analyze.</p>
      </div>
    );
  }
  if ('state' in t && t.state !== 'observed') {
    return (
      <div className="card" id="dash-card-thumbnail">
        <h2>Embedded thumbnail</h2>
        <SignalRow label="Embedded preview" chip={statusChipFor(t)} tip={TOOLTIPS.thumbnailDiff}>
          {t.reason}
        </SignalRow>
      </div>
    );
  }
  if (!observed) return null;
  const diff: ThumbnailDiff | SignalStatus | null = observed.diff;
  return (
    <div className="card" id="dash-card-thumbnail">
      <h2>Embedded thumbnail</h2>
      <SignalRow label="Embedded preview" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.thumbnailDiff}>
        {observed.byteLength} bytes
        {observed.width && observed.height ? ` · ${observed.width}×${observed.height}` : ''}
      </SignalRow>
      {made && (
        <div className="fx-thumb-preview" style={{ margin: '8px 0' }}>
          <img src={made.url} alt="Embedded preview extracted from the file's metadata" />
        </div>
      )}
      {diff && !('state' in diff) && (
        <SignalRow label="Difference vs main image" chip={{ tone: diff.differs ? 'warn' : 'info', text: diff.differs ? 'Differs' : 'Consistent' }} tip={TOOLTIPS.thumbnailDiff}>
          mean per-channel difference {diff.meanAbsDiff} of 255 ({(diff.fraction * 100).toFixed(1)}%) on a {diff.comparedAt}px comparison raster
          {diff.differs
            ? ' — the preview differs from the current image beyond the comparison floor'
            : ' — within the comparison floor'}
          {/* fx.thumb.diff.note */}
          <div className="honest-note">The preview can predate the last edit. A difference is a custody observation, not an accusation.</div>
        </SignalRow>
      )}
      {diff && 'state' in diff && diff.state !== 'observed' && (
        <SignalRow label="Difference vs main image" chip={statusChipFor(diff)} tip={TOOLTIPS.thumbnailDiff}>
          {diff.reason}
        </SignalRow>
      )}
    </div>
  );
}

/** The Tier-0 byte-reads section, or one honest line when it never ran. */
function ByteReadsSection({ item }: { item: DeskItem }) {
  const report = item.intakeReport ?? null;
  if (!report) {
    return (
      <div className="dash-coming">
        <span className="dash-coming-title">Byte reads not computed for this item.</span>{' '}
        This item entered before the intake pipeline computed byte reads, or its bytes are not held in
        this tab. Re-drop the original file to compute them — stated, not hidden.
      </div>
    );
  }
  return (
    <>
      <MetadataCard report={report} />
      <StringsCard report={report} />
      <JpegStructureCard report={report} />
      <ThumbnailCard report={report} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Screen re-photography cross-link — the signals themselves moved to  */
/* the Forensics tab in W4 (ARCHITECTURE §5.3); a pointer stays so     */
/* their home is stated, never hidden.                                  */
/* ------------------------------------------------------------------ */

function RephotoCrossLink({ item }: { item: DeskItem }) {
  if (!item.rephoto) return null;
  return (
    <div className="card">
      <h2>Screen re-photography signals</h2>
      <p style={{ margin: 0, fontSize: 14, color: 'var(--text-dim)' }}>
        Measured when this file was taken in — the four measurements (banding, moiré, black floor,
        display gamut) render on the <strong>Forensics</strong> tab. Stated here so their home is
        not hidden.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Pose trace ↔ video motion (+ the flow-field overlay, ungraded)       */
/* ------------------------------------------------------------------ */

function FlowOverlay({ frame, motion }: { frame: SampledFrame; motion: GlobalMotion }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(frame.width, frame.height);
    for (let i = 0; i < frame.gray.length; i++) {
      const v = Math.max(0, Math.min(255, Math.round(frame.gray[i])));
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    ctx.strokeStyle = INFO_COLOR; // slate — informational, never a signal color
    ctx.fillStyle = INFO_COLOR;
    ctx.lineWidth = 1;
    for (const v of motion.vectors) {
      ctx.beginPath();
      ctx.moveTo(v.ax, v.ay);
      ctx.lineTo(v.bx, v.by);
      ctx.stroke();
      ctx.fillRect(v.bx - 1, v.by - 1, 3, 3);
    }
  }, [frame, motion]);
  return <canvas ref={ref} style={{ width: '100%', imageRendering: 'pixelated', borderRadius: 8, display: 'block' }} />;
}

function PoseTraceCard({ item }: { item: DeskItem }) {
  const report = item.report ?? null;
  if (!item.imuFlow && !(item.videoMotion === null && report?.record?.context?.poseTrace)) return null;
  return (
    <div className="card">
      <h2>Pose trace ↔ video motion</h2>
      <p className="honest-note" style={{ marginTop: 0 }}>
        The signed gyro trace claims how the camera moved; the frames show how the scene
        actually moved. Cross-checking them is the hardest signal to forge — and still only
        evidence: big moving subjects, low texture, or timestamp skew weaken it on perfectly
        genuine footage. It informs your judgment; it gates nothing.
      </p>
      {item.imuFlow ? (
        <>
          <SignalRow label="Frame pairs cross-checked" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.poseMotion}>
            {item.imuFlow.samples} (mean block-match coverage {(item.imuFlow.coverageMean * 100).toFixed(0)}%)
          </SignalRow>
          <SignalRow label="Roll: gyro vs observed rotation" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.poseMotion}>
            {item.imuFlow.rollCorrelation !== null
              ? <>correlation {item.imuFlow.rollCorrelation.toFixed(2)}
                  {item.imuFlow.rollSignAgreement !== null && <> · direction agreement {(item.imuFlow.rollSignAgreement * 100).toFixed(0)}%</>}
                </>
              : 'not computable (too little roll motion)'}
          </SignalRow>
          <SignalRow label="Yaw vs horizontal pan" chip={{ tone: 'info', text: 'Observed' }}>
            {item.imuFlow.panXCorrelation !== null ? `correlation ${item.imuFlow.panXCorrelation.toFixed(2)}` : 'not computable'}
          </SignalRow>
          <SignalRow label="Pitch vs vertical pan" chip={{ tone: 'info', text: 'Observed' }}>
            {item.imuFlow.panYCorrelation !== null ? `correlation ${item.imuFlow.panYCorrelation.toFixed(2)}` : 'not computable'}
          </SignalRow>
          <SignalRow
            label="Overall"
            chip={item.imuFlow.strength === 'insufficient-data' ? { tone: 'neutral', text: 'Insufficient signal' } : { tone: 'info', text: 'Observed' }}
          >
            {item.imuFlow.strength === 'insufficient-data' ? 'insufficient data for a cross-check' : `${item.imuFlow.strength} consistency (descriptive band — corpus calibration pending)`}
          </SignalRow>
          <p className="honest-note">{item.imuFlow.note}</p>
          {(() => {
            const best = item.videoMotion?.flow
              .filter((f) => f.frameBIndex !== undefined && f.motion.vectors.length > 0)
              .sort((a, b) => b.motion.matches - a.motion.matches)[0];
            const frame = best?.frameBIndex !== undefined ? item.videoMotion?.frames[best.frameBIndex - 1] : undefined;
            if (!best || !frame) return null;
            return (
              <>
                <FlowOverlay frame={frame} motion={best.motion} />
                <p className="honest-note" style={{ marginBottom: 0 }}>
                  The block-match vectors behind the numbers (best-covered pair, frame at {frame.tSec.toFixed(1)}s).
                  Uniform arrows = clean global motion; a chaotic field means the numbers above
                  rest on shaky matches — your eyes, not a grade.
                </p>
              </>
            );
          })()}
        </>
      ) : (
        <p className="dash-absence" style={{ margin: 0 }}>
          This capture signs a pose trace, but the video frames could not be decoded in
          this browser — the cross-check was not performed. Stated, not hidden.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App Attest (statement of a check, never a verdict)                   */
/* ------------------------------------------------------------------ */

function AppAttestCard({ item }: { item: DeskItem }) {
  const aa = item.report?.c2pa?.appAttest;
  if (!aa?.present) return null;
  return (
    <div className="card">
      <h2>App Attest</h2>
      <p style={{ margin: 0, fontSize: 14 }}>
        {aa.valid
          ? 'The attestation checks out: the signing environment attested as a genuine Apple device running this app.'
          : `Present but does not check out — ${aa.reason ?? 'check failed'}. Stated plainly: do not rely on it.`}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bytes not held (§10.5 ov.bytes.*)                                    */
/* ------------------------------------------------------------------ */

function BytesNotHeldCard({ item }: { item: DeskItem }) {
  if (item.bytes) return null;
  return (
    <div className="card">
      <h2>Bytes not held in this tab</h2>
      <p style={{ margin: 0, fontSize: 14 }}>
        {item.objectUrl
          ? 'This video was checked, then its bytes left memory (the large-file path — the tab stays responsive). Preview plays from a local object URL. Exact-after-strip custody matching needs bytes in memory, so it was not run for this item — stated, not hidden.'
          : 'This item is a reference (restored from a case file, or ingested hash-only): its bytes are not in this tab. The SHA-256 above is the durable identity; re-drop the original file to re-check, preview, or custody-match it.'}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Checks — performed / not performed (L12, §10.5 ov.checks.*)          */
/* ------------------------------------------------------------------ */

function ChecksCard({ performed, notPerformed }: { performed: string[]; notPerformed: string[] }) {
  return (
    <div className="card" id="dash-card-checks">
      <h2>Checks</h2>
      <h3>Performed</h3>
      <ul className="checks done">
        {performed.map((c, i) => <li key={i}>{c}</li>)}
        {performed.length === 0 && <li>None</li>}
      </ul>
      <h3>Not performed — disclosed, not hidden</h3>
      <ul className="checks notdone">
        {notPerformed.map((c, i) => <li key={i}>{c}</li>)}
        {notPerformed.length === 0 && <li>None</li>}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Publishing guidance (§10.5 ov.publishing.*) — INTACT media only      */
/* ------------------------------------------------------------------ */

function PublishingCard() {
  return (
    <div className="card">
      <h2>Publishing — keeping the proof intact</h2>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
        <li><strong>Serve the original file.</strong> CMS image pipelines (WordPress, most DAMs) re-compress and strip metadata on upload — that breaks the hash binding. Attach the original at full size, or publish the proof bundle alongside and say the media was re-compressed.</li>
        <li><strong>WordPress:</strong> uploaded images are resized and re-encoded by default. Use “Full Size”, and consider hosting originals outside <code>wp-content/uploads</code> processing. Link the “how we know this” export from the publication’s methodology note.</li>
        <li><strong>Social platforms strip everything.</strong> Never treat a platform copy as evidence — recover against the original via exact hash or a visual lead.</li>
        <li><strong>Say what it proves:</strong> “cryptographically unchanged since capture by a device on our roster” — custody, not reality.</li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* "How we know this" export (dash.export) — via core/util downloads    */
/* ------------------------------------------------------------------ */

function ExportRow(props: AssetDashboardProps) {
  const { item, trust, artifact, matches } = props;
  return (
    <div className="btn-row">
      <button
        className="btn"
        onClick={() => downloadHtml(
          `how-we-know-this-${item.name.replace(/[^a-z0-9.-]+/gi, '_')}.html`,
          buildHowWeKnowHtml({
            item,
            trust,
            artifact,
            matches: matches.filter((m) => m.proofItemId === item.id || m.mediaItemId === item.id),
            builtAt: new Date(),
          }),
        )}
      >
        Export “how we know this” (HTML)
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The Overview tab, per kind (ARCHITECTURE §4 per-kind variants)       */
/* ------------------------------------------------------------------ */

export function OverviewTab(props: AssetDashboardProps) {
  const { item, trust, artifact } = props;

  /* Unknown / roster file: Overview only — hash card + absence states. */
  if (item.kind === 'unknown' || item.kind === 'roster') {
    return (
      <div>
        {item.sha256Hex && <HashesCard item={item} />}
        {!item.sha256Hex && (
          <div className="card">
            <h2>Hashes</h2>
            <p className="dash-absence" style={{ margin: 0 }}>
              No digest was computed for this item — the reason is in the banner above.
            </p>
          </div>
        )}
        <ProvenanceChain item={item} custodyMatches={props.custodyMatches} trust={trust} />
        <ChecksCard
          performed={item.report?.checksPerformed ?? artifact?.performed ?? []}
          notPerformed={item.report?.checksNotPerformed ?? artifact?.notPerformed ?? []}
        />
      </div>
    );
  }

  /* Hash claim: the claim card, who-signed, recovery, chain, checks. */
  if (item.kind === 'hash-claim') {
    const claim = item.claim!;
    return (
      <div>
        <div className="card" id="dash-card-claim">
          <h2>The claim</h2>
          <table className="kv">
            <tbody>
              <tr><td>Media SHA-256</td><td><code>{claim.mediaSha256}</code></td></tr>
              <tr><td>Payload digest</td><td><code>{claim.payloadDigestHex}</code></td></tr>
              <tr><td>Capture time (device claim)</td><td>{claim.capturedAt}</td></tr>
              <tr><td>Signer fingerprint</td><td><code>{claim.signerFingerprint}</code></td></tr>
              {claim.ots && (
                <tr><td>Ledger state at share time</td><td>{claim.ots.states.join(', ')}{claim.ots.blockHeights.length ? ` — blocks ${claim.ots.blockHeights.join(', ')}` : ''}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {trust && <TrustCard trust={trust} />}
        <RecoveryCard {...props} />
        <ProvenanceChain item={item} custodyMatches={props.custodyMatches} trust={trust} />
        <ChecksCard performed={artifact?.performed ?? []} notPerformed={artifact?.notPerformed ?? []} />
        <ExportRow {...props} />
      </div>
    );
  }

  /* Proof bundle: who-signed, time, capture-integrity, recovery, chain, checks. */
  if (item.kind === 'proof-bundle') {
    return (
      <div>
        {trust && <TrustCard trust={trust} />}
        <TimeCard item={item} artifact={artifact} />
        <CaptureIntegrityCard item={item} />
        <RecoveryCard {...props} />
        <ProvenanceChain item={item} custodyMatches={props.custodyMatches} trust={trust} />
        <ChecksCard performed={artifact?.performed ?? []} notPerformed={artifact?.notPerformed ?? []} />
        <ExportRow {...props} />
      </div>
    );
  }

  /* Media: the full dashboard. */
  const report = item.report!;
  return (
    <div>
      <PreviewCard item={item} />
      {trust && <TrustCard trust={trust} />}
      <AttributionCard item={item} />
      <TimeCard item={item} artifact={artifact} />
      <CaptureIntegrityCard item={item} />
      <RecoveryCard {...props} />
      <ProvenanceChain item={item} custodyMatches={props.custodyMatches} trust={trust} />
      <HashesCard item={item} />
      <DeclaredActionsCard summary={item.intakeReport?.c2paSummary ?? null} />
      <ByteReadsSection item={item} />
      <RephotoCrossLink item={item} />
      <PoseTraceCard item={item} />
      <AppAttestCard item={item} />
      <BytesNotHeldCard item={item} />
      <ChecksCard performed={report.checksPerformed} notPerformed={report.checksNotPerformed} />
      {report.verdict === 'INTACT' && <PublishingCard />}
      <ExportRow {...props} />
    </div>
  );
}
