/**
 * Time coherence (M2) — do the committed time claims agree with each other?
 *
 * Every input here is a field the SIGNER committed under the record
 * signature (verify-core/provenance/manifest.ts): the device clock at
 * capture, the beacon's self-reported observation time, the OTS submission
 * times, and the self-reported shutter→signature latency. This card family
 * cross-checks them against each other. Each comparison is its own gap with
 * its own tolerance — never merged into one time score.
 *
 * Cushion rule (standing): comparisons involving an exact cryptographic
 * timestamp against a device/EXIF-style clock carry a ±5 minute cushion —
 * the cryptographic timestamp is exact; the cushion covers the camera's own
 * clock, which is not. Where BOTH sides are the same device clock, the
 * tolerance is stated per-comparison instead.
 *
 * The repo's own anchors used here:
 *   - beacon staleness: verify-core/lib/beacon.ts BEACON_STALE_MS (1 h);
 *   - OTS queue delay: OtsSubmission.queueDelayMs — a recorded delay is
 *     evidence, not an anomaly (manifest.ts).
 */

import type { AttestationRecord } from '../../provenance/manifest';
import { BEACON_STALE_MS } from '../../lib/beacon';
import { makeCard, makeNotRun, makeInsufficient } from '../interpret/cards';
import type { EvidenceCard } from '../types';

/** ±5 minutes, per the standing cushion rule. */
export const CLOCK_CUSHION_MS = 5 * 60 * 1000;

const CUSHION_NOTE =
  'the cryptographic timestamp is exact; the cushion covers the camera’s own clock, which is not';

/** Reader-stated analysis tolerance for shutter→signature latency. */
export const SEAL_LATENCY_TOLERANCE_MS = 10_000;

const ms = (iso: string): number => Date.parse(iso);
const fmtGap = (gapMs: number): string =>
  `${gapMs < 0 ? '−' : '+'}${(Math.abs(gapMs) / 1000).toFixed(1)} s`;

/** Card 1 — shutter → signature latency (single device clock, self-reported). */
export function captureToSealCard(record: AttestationRecord): EvidenceCard {
  if (!record.captureIntegrity) {
    return makeNotRun(
      'time.capture-to-seal', 'Shutter → seal latency',
      'the record carries no capture-integrity commitment, so the camera never stated when it sealed relative to the shutter',
      { audit: 'Audit ▸ AttestationRecord.captureIntegrity (0.9.3+); absent on older records' },
    );
  }
  const latency = record.captureIntegrity.captureToSignatureMs;
  const prediction =
    'the seal should follow the shutter promptly: a long gap leaves room for bytes to be altered between capture and signature';
  const measurement = `committed latency ${latency} ms (self-reported ◌)`;
  const method =
    `Read ▸ AttestationRecord.captureIntegrity.captureToSignatureMs against the Reader’s stated ${SEAL_LATENCY_TOLERANCE_MS / 1000} s tolerance; ` +
    'single device clock · no cushion applies';
  if (latency < 0) {
    return makeCard({
      id: 'time.capture-to-seal', title: 'Shutter → seal latency', state: 'diverges',
      prediction, measurement, method,
      gap: `negative latency (${latency} ms): the signature claims to predate the shutter`,
      interpretation: 'inconsistent with an honest capture pipeline; consistent with a fabricated or corrupted commitment',
    });
  }
  if (latency <= SEAL_LATENCY_TOLERANCE_MS) {
    return makeCard({
      id: 'time.capture-to-seal', title: 'Shutter → seal latency', state: 'agrees',
      prediction, measurement, method,
      gap: `${latency} ms inside the ${SEAL_LATENCY_TOLERANCE_MS / 1000} s tolerance`,
      interpretation: 'consistent with the bytes being sealed as captured; the commitment, not the tolerance, is the evidence',
      gauge: { value: latency / 1000, band: [0, SEAL_LATENCY_TOLERANCE_MS / 1000], units: 's shutter → seal' },
    });
  }
  return makeCard({
    id: 'time.capture-to-seal', title: 'Shutter → seal latency', state: 'diverges',
    prediction, measurement, method,
    gap: `${(latency / 1000).toFixed(1)} s exceeds the ${SEAL_LATENCY_TOLERANCE_MS / 1000} s tolerance by ${((latency - SEAL_LATENCY_TOLERANCE_MS) / 1000).toFixed(1)} s`,
    interpretation: 'a long shutter→seal gap leaves room for the bytes to have been altered before signing. The signer committed to this gap; the data does not say why it exists',
  });
}

/** Card 2 — beacon observation vs the seal (signed time lower bound). */
export function beaconOrderCard(record: AttestationRecord): EvidenceCard {
  const beacon = record.beacon;
  if (!beacon) {
    return makeNotRun(
      'time.beacon-lower-bound', 'Beacon lower bound',
      'the record carries no Bitcoin beacon, so no signed time lower bound was committed (absent when no tip was cached)',
      { audit: 'Audit ▸ AttestationRecord.beacon (0.10.0, W1.4)' },
    );
  }
  const capturedMs = ms(record.capturedAt);
  const observedMs = ms(beacon.observedAt);
  const prediction =
    `the beacon tip (block #${beacon.blockHeight}) must have been observed BEFORE the seal: a lower bound observed after signing is no bound at all`;
  const method =
    `Read ▸ beacon.observedAt (self-reported ◌) against capturedAt + the committed seal latency; both sides are the device’s own clock, so the ±5 min cushion covers clock drift. ${CUSHION_NOTE}`;
  if (!Number.isFinite(capturedMs) || !Number.isFinite(observedMs)) {
    return makeInsufficient(
      'time.beacon-lower-bound', 'Beacon lower bound', prediction,
      `capturedAt "${record.capturedAt}" · observedAt "${beacon.observedAt}"`,
      'one of the committed timestamps does not parse, so no gap can be computed',
    );
  }
  const latency = record.captureIntegrity?.captureToSignatureMs ?? 0;
  const gapMs = capturedMs + latency - observedMs; // seal minus observation; expect ≥ −cushion
  const measurement =
    `observed ${fmtGap(-gapMs)} relative to the seal (observedAt ${beacon.observedAt}, self-reported ◌ · source ${beacon.source} ◌)`;
  if (gapMs < -CLOCK_CUSHION_MS) {
    return makeCard({
      id: 'time.beacon-lower-bound', title: 'Beacon lower bound', state: 'diverges',
      prediction, measurement, method,
      gap: `the tip claims observation ${fmtGap(-gapMs)} AFTER the seal, beyond the ±5 min cushion`,
      interpretation: 'inconsistent with a genuine lower bound: a block hash cannot be committed before it was known; consistent with a fabricated beacon or a badly wrong device clock',
    });
  }
  const stale = gapMs > BEACON_STALE_MS;
  return makeCard({
    id: 'time.beacon-lower-bound', title: 'Beacon lower bound', state: 'agrees',
    prediction, measurement, method,
    gap: stale
      ? `observed ${fmtGap(-gapMs)} before the seal: ordered correctly, but older than the ${BEACON_STALE_MS / 3_600_000} h freshness the camera aims for, so the bound is loose`
      : `observed ${fmtGap(-gapMs)} before the seal: inside the ±5 min cushion on the near side, well inside freshness`,
    interpretation: stale
      ? 'consistent with a genuine but stale lower bound: the signature cannot predate the block, yet the bound sits far below the signing moment'
      : 'consistent with a genuine time lower bound: the signature cannot predate the observed block; pair with a ledger anchor above to bracket the moment',
    gauge: { value: Math.round(gapMs / 1000), band: [-CLOCK_CUSHION_MS / 1000, BEACON_STALE_MS / 1000], units: 's observation → seal' },
  });
}

/** Card 3 — OTS submission vs the seal (ledger side, structural). */
export function otsSubmissionCard(record: AttestationRecord): EvidenceCard {
  const subs = record.ots?.submissions ?? [];
  if (subs.length === 0) {
    return makeNotRun(
      'time.ots-submission', 'Ledger submission timing',
      'no OpenTimestamps submissions are attached to this record, so there is no ledger-side timing to cross-check',
      { audit: 'Audit ▸ AttestationRecord.ots (excluded from the signed payload; receipts commit to the payload digest)' },
    );
  }
  const capturedMs = ms(record.capturedAt);
  const latency = record.captureIntegrity?.captureToSignatureMs ?? null;
  if (!Number.isFinite(capturedMs) || latency === null) {
    return makeInsufficient(
      'time.ots-submission', 'Ledger submission timing',
      'submission should follow the seal (the digest cannot exist before the payload does)',
      `submissions: ${subs.map((s) => s.submittedAt).join(', ')}`,
      latency === null
        ? 'no committed seal latency, so the expected sealing moment cannot be placed'
        : 'the committed capture time does not parse',
    );
  }
  const sealMs = capturedMs + latency;
  const gaps = subs.map((s) => ({ sub: s, gap: ms(s.submittedAt) - sealMs }));
  const unparseable = gaps.filter((g) => !Number.isFinite(g.gap));
  if (unparseable.length > 0) {
    return makeInsufficient(
      'time.ots-submission', 'Ledger submission timing',
      'submission should follow the seal',
      `submissions: ${subs.map((s) => s.submittedAt).join(', ')}`,
      'a committed submission time does not parse, so no gap can be computed for it',
    );
  }
  const prediction =
    'every submission should FOLLOW the seal: the digest the calendar witnessed cannot exist before the signed payload does';
  const method =
    `Read ▸ ots.submissions[].submittedAt (self-reported ◌) against capturedAt + committed seal latency; ±5 min cushion applied. ${CUSHION_NOTE}`;
  const measurement = gaps
    .map((g) => `${g.gap < 0 ? '−' : '+'}${(Math.abs(g.gap) / 1000).toFixed(1)} s after the seal (${new URL(g.sub.calendar).host}${g.sub.queueDelayMs ? `, queue delay committed: ${(g.sub.queueDelayMs / 1000).toFixed(0)} s` : ''})`)
    .join(' · ');

  const worst = Math.min(...gaps.map((g) => g.gap));
  if (worst < -CLOCK_CUSHION_MS) {
    return makeCard({
      id: 'time.ots-submission', title: 'Ledger submission timing', state: 'diverges',
      prediction, measurement, method,
      gap: `a submission claims ${fmtGap(worst)} relative to the seal: BEFORE the payload existed, beyond the ±5 min cushion`,
      interpretation: 'inconsistent with an honest ledger submission: the calendar cannot have witnessed a digest before its payload; consistent with a fabricated submission record or a badly wrong device clock',
    });
  }
  const anyQueue = gaps.some((g) => g.sub.queueDelayMs);
  return makeCard({
    id: 'time.ots-submission', title: 'Ledger submission timing', state: 'agrees',
    prediction, measurement, method,
    gap: `all ${gaps.length} submission(s) follow the seal within the expected order${anyQueue ? '; a committed queue delay explains the wait (offline at signing, stated by the signer)' : ''}`,
    interpretation: 'consistent with the payload existing before the calendars witnessed it; the receipts themselves are checked on custody rung 4. This card only checks their ORDER',
  });
}

/** All time-coherence cards for one record. */
export function timeClaimCards(record: AttestationRecord): EvidenceCard[] {
  return [captureToSealCard(record), beaconOrderCard(record), otsSubmissionCard(record)];
}
