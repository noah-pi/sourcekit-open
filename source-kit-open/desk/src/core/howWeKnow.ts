/**
 * "How we know this" — a standalone HTML export of one dossier.
 *
 * The export is a verbatim statement of what the desk checked, what it did
 * NOT check, and the basis for every trust statement. It contains no
 * tracking, no external resources, and no claims beyond the report itself.
 * It is meant to be attached to the publication's methodology note or
 * archived alongside the evidence.
 */

import { DESK_VERSION, type ArtifactCheck, type DeskTrust, type RecoveryMatch } from './deskCore';
import type { DeskItem } from './deskItem';
import { downloadText } from './util';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/`/g, '&#96;');

/**
 * Numeric fields in the record arrive over JSON and are TYPED as numbers,
 * but a crafted manifest can put markup strings where numbers belong — and
 * this document is published verbatim. Coerce, and render '—'
 * when the value is not finite: fail closed, never interpolate raw.
 */
const num = (x: unknown): number | '—' => {
  const n = Number(x);
  return Number.isFinite(n) ? n : '—';
};

function list(items: string[], cls: string): string {
  if (items.length === 0) return '';
  return `<ul class="${cls}">${items.map((i) => `<li>${esc(String(i))}</li>`).join('')}</ul>`;
}

/* §3.1 tokens, verbatim — the export reads as the desk reads. */
const CSS = `
  body { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1D1D1F; background: #F6F6F8; line-height: 1.55; }
  h1 { font-size: 22px; } h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: #6E6E73; margin-top: 32px; border-bottom: 1px solid #E6E6EB; padding-bottom: 6px; }
  .verdict { font-size: 18px; font-weight: 600; padding: 12px 16px; border-radius: 10px; margin: 16px 0; background: #FFFFFF; }
  .v-intact { background: rgba(31,107,69,.10); color: #1F6B45; } .v-bad { background: rgba(192,53,39,.08); color: #C03527; } .v-neutral { background: #EEEEF2; color: #6E6E73; }
  .tier { font-weight: 600; } .basis { color: #6E6E73; }
  .warn { background: rgba(138,95,18,.10); border: 1px solid rgba(138,95,18,.30); padding: 10px 14px; border-radius: 8px; color: #8A5F12; }
  ul { padding-left: 20px; } li { margin: 4px 0; }
  .done li::marker { color: #1F6B45; } .notdone li { color: #6E6E73; }
  code { background: #EEEEF2; padding: 1px 5px; border-radius: 4px; font-size: 13px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; background: #FFFFFF; } td { padding: 6px 8px; border-bottom: 1px solid #E6E6EB; vertical-align: top; font-size: 14px; } td:first-child { color: #6E6E73; width: 220px; }
  .foot { margin-top: 40px; font-size: 13px; color: #78787D; border-top: 1px solid #E6E6EB; padding-top: 12px; }
`;

/**
 * Green is the L6 double lock ONLY — intact AND roster-trusted with no
 * warning — exactly like bannerFor(). Red is L5's two facts. Everything
 * else is neutral: unsigned is not a stain, unchecked is not a verdict.
 */
function verdictClass(v: string, trust: DeskTrust | null): string {
  if (v === 'CONTENT_MODIFIED' || v === 'SIGNATURE_INVALID') return 'v-bad';
  if (v === 'INTACT' && trust?.tier === 'roster' && !trust.warning) return 'v-intact';
  // INTACT-without-roster-trust and UNSUPPORTED land here: neutral.
  return 'v-neutral';
}

/** §10.4 deck strings — the export headline is the banner headline. */
function exportHeadline(report: NonNullable<DeskItem['report']>, trust: DeskTrust | null): string {
  switch (report.verdict) {
    case 'INTACT':
      return trust?.tier === 'roster' && !trust.warning
        ? 'Unchanged since signing — signer on your trusted roster'
        : 'Unchanged since signing — signer not on your trusted roster';
    case 'CONTENT_MODIFIED': return 'The bytes changed after signing';
    case 'SIGNATURE_INVALID': return 'The attestation does not check out';
    case 'NO_ATTESTATION': return 'No credentials found — this is normal';
    case 'UNSUPPORTED':
    case 'NOT_JPEG':
    case 'NOT_BMFF': return 'Found credentials this build cannot check';
    case 'UNREADABLE': return 'This file could not be read';
    default: return 'Not a checkable file';
  }
}

export function buildHowWeKnowHtml(args: {
  item: DeskItem;
  trust: DeskTrust | null;
  artifact: ArtifactCheck | null;
  matches: RecoveryMatch[];
  builtAt: Date;
}): string {
  const { item, trust, artifact, matches, builtAt } = args;
  const report = item.report ?? null;
  const record = report?.record ?? item.bundle?.record ?? null;

  const sections: string[] = [];
  sections.push(`<h1>How we know this — ${esc(String(item.name))}</h1>`);
  sections.push(`<p>Exported ${esc(builtAt.toISOString())} by Source Kit Desk. This document states what was checked and what was not. Nothing here is asserted beyond the checks listed.</p>`);

  if (report) {
    sections.push(`<div class="verdict ${verdictClass(report.verdict, trust)}">${esc(exportHeadline(report, trust))}</div>`);
  } else if (item.kind === 'hash-claim') {
    sections.push(`<div class="verdict v-neutral">Hash-only claim — no media, no signature. Exact-match recovery only.</div>`);
  } else if (item.kind === 'proof-bundle') {
    const ok = artifact && artifact.signatureValid && artifact.fingerprintMatches && artifact.payloadDigestMatches;
    sections.push(`<div class="verdict ${ok ? 'v-intact' : 'v-bad'}">Proof bundle ${ok ? 'internally consistent — signature, fingerprint, and payload digest all verify' : 'FAILED an internal consistency check'}</div>`);
  }

  if (trust) {
    sections.push('<h2>Who signed it</h2>');
    sections.push(`<p><span class="tier">${trust.tier === 'roster' ? 'On a trusted roster' : trust.tier === 'org' ? 'Organization credential' : 'Unknown signer'}</span><br><span class="basis">${esc(String(trust.basis))}</span></p>`);
    if (trust.warning) sections.push(`<p class="warn">${esc(String(trust.warning))}</p>`);
    if (record?.identity && record.identity !== 'redacted') {
      const who = [record.identity.author, record.identity.organization].filter(Boolean).join(', ');
      if (who) sections.push(`<p>Attribution — claimed at capture, not verified: <strong>${esc(String(who))}</strong> — <em>self-asserted by the signing software.</em></p>`);
    }
    if (record?.identity === 'redacted') sections.push('<p>Identity deliberately redacted by the signer before sharing.</p>');
  }

  if (record) {
    sections.push('<h2>Time — three separate claims, never merged</h2><table>');
    sections.push(`<tr><td>Device clock at capture</td><td>${esc(String(record.capturedAt))}<br><em>a claim by the device; not independently verified</em></td></tr>`);
    if (report?.c2pa?.timestamps) {
      const t = report.c2pa.timestamps;
      const present = Number(t.present);
      sections.push(`<tr><td>Authority time (RFC 3161 TSA)</td><td>${num(t.valid)} of ${num(t.present)} timestamp token${present === 1 ? '' : 's'} cryptographically valid${t.earliestValidUtc ? `; earliest valid countersigned time ${esc(String(t.earliestValidUtc))}` : ''}${Array.isArray(t.tsaNames) && t.tsaNames.length ? `<br>Authorities: ${esc(t.tsaNames.map((n) => String(n)).join(', '))}` : ''}</td></tr>`);
    }
    const ots = artifact?.ots ?? [];
    if (ots.length > 0) {
      const desc = ots.map((o) => {
        if (o.state === 'confirmed') return `${esc(String(o.calendar))} — confirmed in Bitcoin block ${num(o.blockHeight)}${o.binding === 'verified' ? ' (block binding checks out)' : o.binding === 'failed' ? ' (binding INCONSISTENT)' : ' (binding not checked)'}`;
        if (o.state === 'pending') return `${esc(String(o.calendar))} — submitted, awaiting Bitcoin confirmation`;
        return `${esc(String(o.calendar))} — unverifiable (${esc(String(o.reason ?? 'malformed'))})`;
      }).join('<br>');
      sections.push(`<tr><td>Ledger time (Bitcoin / OpenTimestamps)</td><td>${desc}</td></tr>`);
    } else {
      sections.push('<tr><td>Ledger time (Bitcoin / OpenTimestamps)</td><td>No ledger receipts attached.</td></tr>');
    }
    sections.push('</table>');

    if (record.captureIntegrity) {
      const ci = record.captureIntegrity;
      sections.push('<h2>Capture-integrity signals — self-reported, stated as such</h2><table>');
      const gapMs = Number(ci.captureToSignatureMs);
      // Not finite → take the CONSERVATIVE branch: the document must never
      // certify timing it could not measure.
      const gapWording = Number.isFinite(gapMs) && gapMs < 2000
        ? 'consistent with capture-then-sign'
        : 'long enough that bytes could have been altered between capture and seal';
      sections.push(`<tr><td>Shutter → signature gap</td><td>${num(ci.captureToSignatureMs)} ms — ${gapWording}</td></tr>`);
      if (ci.sensorTiming) sections.push(`<tr><td>Sensor-frame timing</td><td>${num(ci.sensorTiming.samples)} samples, interval CV ${num(ci.sensorTiming.intervalCv)} — regularity is consistent with live capture; it does not prove it</td></tr>`);
      sections.push('</table><p><em>All capture-integrity signals are self-reported by the device; a compromised device could fabricate them. Their value is commitment under signature, not detection.</em></p>');
    }

    sections.push('<h2>Hashes</h2><table>');
    sections.push(`<tr><td>Media SHA-256</td><td><code>${esc(String(record.asset.sha256))}</code></td></tr>`);
    if (artifact?.recomputedPayloadDigestHex) sections.push(`<tr><td>Payload digest</td><td><code>${esc(String(artifact.recomputedPayloadDigestHex))}</code></td></tr>`);
    sections.push(`<tr><td>Signer fingerprint</td><td><code>${esc(String(record.signer.fingerprint))}</code></td></tr>`);
    sections.push('</table>');
  }

  const performed = report?.checksPerformed ?? artifact?.performed ?? [];
  const notPerformed = report?.checksNotPerformed ?? artifact?.notPerformed ?? [];
  sections.push('<h2>Checks performed</h2>');
  sections.push(list(performed, 'done') || '<p>None.</p>');
  sections.push('<h2>Checks NOT performed — disclosed, not hidden</h2>');
  sections.push(list(notPerformed, 'notdone') || '<p>None.</p>');

  if (matches.length > 0) {
    sections.push('<h2>Proof↔media recovery matches</h2><ul>');
    for (const m of matches) {
      if (m.grade === 'exact') sections.push(`<li><strong>Exact match (certain):</strong> ${esc(String(m.mediaName))} — SHA-256 identical to the signed bytes.</li>`);
      else sections.push(`<li><strong>Visual lead (not a verdict):</strong> ${esc(String(m.mediaName))} — pHash distance ${num(m.distance)} from ${esc(String(m.viaMediaName ?? 'the matched original'))}. Confirm visually before use.</li>`);
    }
    sections.push('</ul>');
  }

  /* ------------------------------------------------------------ */
  /* Forensic evidence: byte reads (T0), signals (T1), fx (T2) —   */
  /* measurements and leads with their method versions, never      */
  /* verdicts, never fused.                                        */
  /* ------------------------------------------------------------ */

  const ir = item.intakeReport ?? null;
  if (ir) {
    sections.push('<h2>Byte reads — computed at intake, shown not re-run</h2><table>');
    const meta = ir.byteReads?.metadata ?? null;
    if (meta) {
      sections.push(
        meta.state === 'absent'
          ? `<tr><td>Embedded metadata</td><td>${esc(String(meta.reason))}</td></tr>`
          : `<tr><td>Embedded metadata</td><td>${num(meta.entries.length)} entries listed; GPS ${meta.gps.present ? 'present (declared)' : 'absent'}</td></tr>`,
      );
    }
    const str = ir.byteReads?.strings ?? null;
    if (str) {
      sections.push(
        str.state === 'absent'
          ? `<tr><td>Strings layer</td><td>${esc(String(str.reason))}</td></tr>`
          : `<tr><td>Strings layer</td><td>${num(str.totalCount)} readable runs of ≥4 characters</td></tr>`,
      );
    }
    const js = ir.jpegStructure ?? null;
    if (js && !('state' in js) && js.quantization) {
      const q = js.quantization;
      sections.push(
        `<tr><td>Quantization tables</td><td>${esc(String(q.class))}${q.closestQuality !== null ? ` — closest-quality estimate ≈${num(q.closestQuality)}` : ''} — the compression recipe the last JPEG saver used; a nearest-table resemblance is a hint about the saver, never proof of honesty or dishonesty</td></tr>`,
      );
    }
    const th = ir.thumbnail ?? null;
    if (th && 'byteLength' in th) {
      const d = th.diff ?? null;
      const dText =
        d && !('state' in d)
          ? d.differs
            ? `differs from the current image (mean difference ${num(d.meanAbsDiff)} of 255) — the preview can predate the last edit; a custody observation, not an accusation`
            : 'consistent with the current image within the comparison floor'
          : 'no comparison performed';
      sections.push(`<tr><td>Embedded thumbnail</td><td>${num(th.byteLength)} bytes — ${dText}</td></tr>`);
    }
    sections.push('</table>');
  }

  const t1 = item.tier1Signals ?? [];
  if (t1.length > 0) {
    sections.push('<h2>Signal analyzer results (Tier 1) — each stands alone, none fuses</h2><table>');
    for (const r of t1) {
      sections.push(
        `<tr><td>${esc(String(r.title))}<br><em>method ${esc(String(r.version))} · computed ${esc(String(r.computedAt))}</em></td>` +
        `<td>${esc(String(r.measurement))}${r.bound && r.bound !== '—' ? `<br><em>bounds: ${esc(String(r.bound))}</em>` : ''}</td></tr>`,
      );
    }
    sections.push('</table>');
  }

  const fx = item.tier2Fx ?? null;
  const rephoto = item.rephoto ?? null;
  if (fx || rephoto) {
    sections.push('<h2>Ad-hoc forensic results (Tier 2) — leads, never verdicts</h2><table>');
    const c = fx?.clone ?? null;
    if (c) {
      sections.push(
        c.state === 'measured'
          ? `<tr><td>Clone detection<br><em>method ${esc(String(c.methodVersion))} · computed ${esc(String(c.computedAt))}</em></td>` +
            `<td>${num(c.clusters.length)} shared-offset cluster(s) at block ${num(c.params.blockSize)} px, quant ${num(c.params.quantLevels)}, min detail ${num(c.params.minDetail)}, min distance ${num(c.params.minDistancePx)} px — a lead, not a verdict; settings and resizing hide things` +
            `${c.pairsTruncated > 0 ? `<br><em>matching was truncated — ${num(c.pairsTruncated)} candidate pairs skipped by the safety cap</em>` : ''}</td></tr>`
          : `<tr><td>Clone detection</td><td>abstained — ${esc(String(c.reason))}</td></tr>`,
      );
    }
    const nz = fx?.noise ?? null;
    if (nz) {
      sections.push(
        nz.state === 'measured'
          ? `<tr><td>Noise estimation<br><em>method ${esc(String(nz.methodVersion))} · computed ${esc(String(nz.computedAt))}</em></td>` +
            `<td>median-residual map, p95 ≈ ${num(Math.round(nz.p95AbsResidual * 100) / 100)} of 255 — oddly smooth or oddly noisy patches are leads for your eyes, never findings</td></tr>`
          : `<tr><td>Noise estimation</td><td>abstained — ${esc(String(nz.reason))}</td></tr>`,
      );
    }
    const ela = fx?.ela ?? null;
    if (ela) {
      sections.push(
        `<tr><td>Error-level analysis<br><em>method ${esc(String(ela.methodVersion))} · computed ${esc(String(ela.computedAt))}</em></td>` +
        `<td>re-save quality ${num(Math.round(ela.quality * 100) / 100)}, mean difference ${num(Math.round(ela.meanAbsDiff * 100) / 100)} of 255 — ELA responds to recompression history, not to honesty; a viewing aid, never evidence of manipulation</td></tr>`,
      );
    }
    const px = fx?.parallax ?? null;
    if (px) {
      sections.push(
        px.insufficient === false
          ? `<tr><td>Parallax flatness<br><em>method ${esc(String(px.methodVersion))} · computed ${esc(String(px.computedAt))}</em></td>` +
            `<td>${num(px.tracksUsed)} feature tracks, ${num(Math.round(px.inlierRatio * 100))}% consistent with one plane — the ring is an outside input you provided, and a genuinely flat scene fits a plane honestly</td></tr>`
          : `<tr><td>Parallax flatness</td><td>could not run on the provided ring — ${esc(String(px.insufficient))}</td></tr>`,
      );
    }
    if (rephoto) {
      sections.push(
        `<tr><td>Screen re-photography signals</td>` +
        `<td>banding ${num(Math.round(rephoto.banding.snrDb * 10) / 10)} dB, moiré ${num(Math.round(rephoto.moire.snrDb * 10) / 10)} dB, black lift ≈ ${num(Math.round(rephoto.blackFloor.liftEstimate * 10) / 10)}, ` +
        `hard-saturated ${num(Math.round(rephoto.gamut.hardSaturatedFraction * 1000) / 10)}% — statistical traces a photo-of-a-screen often leaves; a photo of a screen can be entirely legitimate</td></tr>`,
      );
    }
    sections.push('</table>');
  }

  sections.push(`<div class="foot">Generated by Source Kit Desk ${esc(String(DESK_VERSION))} — verification runs entirely in the browser that produced this file; no media or hashes were uploaded. Source Kit (the camera app) proves custody — that these bytes are what a device signed at a time — not that the scene depicted is real. "Custody, not reality."</div>`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>How we know this — ${esc(String(item.name))}</title><style>${CSS}</style></head><body>${sections.join('\n')}</body></html>`;
}

export function downloadHtml(filename: string, html: string): void {
  downloadText(filename, html, 'text/html');
}
