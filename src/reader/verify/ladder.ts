/**
 * Custody ladder for proof bundles — five rungs projecting checks the
 * verification core already performs. Nothing here computes new cryptography
 * or fuses rungs into a score. Not reachable from the app: nothing imports
 * this module, and the app's verdict surface is src/lib/trustLadder.ts.
 *
 * Rung 1 — Seal intact.        Record signature and payload digest, plus the
 *                              media re-hash comparison.
 * Rung 2 — Device credential.  The record's own custody commitments:
 *                              orgCredential, biometricBound, deviceIntegrity,
 *                              captureIntegrity. These are self-reported, not
 *                              hardware proof; the x5chain and App Attest
 *                              checks run in the verification report.
 * Rung 3 — Roster.             Roster signature, resolution and membership.
 *                              Proof artifacts carry no pinned-authority time,
 *                              so membership evaluates at atMs = null and
 *                              reports 'unknown-time'. Callers pass in the
 *                              rosters they hold (src/lib/rosterStore); there
 *                              is no fetch here.
 * Rung 4 — Countersigned time. OTS set check over the ots primitives, plus the
 *                              beacon lower bound from lib/beacon.ts.
 * Rung 5 — Notices.            Always 'not-run': no notices or corrections
 *                              feed exists. Roster revocations are rung 3.
 */

import { verifyRecordSignature, payloadDigest, sha256Hex } from '../../lib/sign';
import { isProofBundle, type ProofBundle } from '../../lib/proofBundle';
import {
  verifyRosterSignature, resolveInRoster, type Roster, type MembershipState,
} from '../../lib/roster';
import { parseOtsReceipt, verifyOtsReceipt } from '../../lib/ots';
import { isValidTip } from '../../lib/beacon';
import { base64ToBytes, bytesToHex } from '../../lib/bytes';
import type { CheckState, RungResult } from '../types';

export interface CustodyInput {
  /** The sealed exhibit's proof half — exhibit-proof-bundle/2 (app format). */
  bundle: unknown;
  /**
   * Signed newsroom rosters supplied by the caller; on device, the ones the
   * app holds in src/lib/rosterStore. The Reader holds no trust store of its
   * own, so with none supplied rung 3 reports not-run.
   */
  rosters?: Roster[];
  /** The media, when it has arrived; enables the byte-binding row. */
  mediaBytes?: Uint8Array | null;
  /**
   * Bitcoin block headers by height, when the caller has fetched them. Absent
   * (the offline default) the block binding is unchecked and the rung says so.
   */
  blockHeaders?: Record<number, Uint8Array>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const short = (hex: string): string => `${hex.slice(0, 12)}…${hex.slice(-8)}`;

function rung(rung: number, title: string, state: CheckState, detail: string,
  rows?: { label: string; value: string }[]): RungResult {
  return rows && rows.length > 0 ? { rung, title, state, detail, rows } : { rung, title, state, detail };
}

/** A bad input shape: a divergent first rung plus four stated non-runs. */
function malformedExhibit(reason: string): RungResult[] {
  return [
    rung(1, 'Seal intact', 'not-run', `the exhibit could not be read: ${reason}`),
    rung(2, 'Device credential', 'not-run', 'cannot be evaluated: the record carrying it could not be read'),
    rung(3, 'Roster', 'not-run', 'cannot be evaluated: the record carrying it could not be read'),
    rung(4, 'Countersigned time', 'not-run', 'cannot be evaluated: the record carrying it could not be read'),
    rung(5, 'Notices', 'not-run', 'cannot be evaluated: the record carrying it could not be read'),
  ];
}

// ---------------------------------------------------------------------------
// Rung 1 — Seal intact (lib/sign.ts + lib/proofBundle.ts)
// ---------------------------------------------------------------------------

function rungSeal(bundle: ProofBundle, input: CustodyInput): { result: RungResult; credentialsFailed: boolean } {
  const fail = (result: RungResult): { result: RungResult; credentialsFailed: boolean } =>
    ({ result, credentialsFailed: true });
  const record = bundle.record;
  const rec = verifyRecordSignature(record);
  const digestHex = bytesToHex(payloadDigest(record));
  const rows: { label: string; value: string }[] = [
    { label: 'signer fingerprint', value: short(record.signer.fingerprint) },
    { label: 'payload digest (signed)', value: short(bundle.payloadDigestHex) },
    { label: 'payload digest (recomputed)', value: short(digestHex) },
  ];

  // PQ dual layer, same rule as verifyAsset: a PQ failure never flips the
  // classical seal, but a stripped layer is tamper evidence, since the
  // committed key cannot leave the signed payload.
  const pq = rec.pq;
  if (pq && !pq.present && pq.keyCommitted) {
    rows.push({ label: 'post-quantum layer', value: 'STRIPPED · key committed in the signed payload, signature missing' });
    // pqSignature rides outside the signed payload (like ots), so the
    // classical seal is intact and the rungs above still evaluate.
    return { result: rung(1, 'Seal intact', 'diverges',
      'a post-quantum key is committed inside the signed payload but the PQ signature is missing. The commitment cannot be removed without breaking the classical signature, so this exhibit was altered after sealing',
      rows), credentialsFailed: false };
  }
  if (pq?.present) {
    rows.push({
      label: 'post-quantum layer',
      value: pq.signatureValid
        ? 'second signature present and consistent (ML-DSA-65, software key; custody labeled, never a hardware anchor)'
        : 'second signature FAILED · the classical layer still stands; the PQ layer measures nothing here',
    });
  }

  if (!rec.signatureValid) {
    return fail(rung(1, 'Seal intact', 'diverges',
      'the ES256 signature does not check out against the embedded public key; the sealed record was altered after signing (or was never sealed by this key)',
      rows));
  }
  if (!rec.fingerprintMatches) {
    return fail(rung(1, 'Seal intact', 'diverges',
      'the recomputed fingerprint of the embedded public key does not match the declared signer fingerprint; the identity field was altered after signing',
      rows));
  }
  if (digestHex !== bundle.payloadDigestHex) {
    return fail(rung(1, 'Seal intact', 'diverges',
      'the recomputed payload digest does not match the digest the bundle declares; the record and its envelope disagree',
      rows));
  }

  // Media byte-binding: runs only when the media has arrived. Proof-only
  // exhibits bind by hash and state the wait.
  if (input.mediaBytes) {
    const mediaHex = sha256Hex(input.mediaBytes);
    rows.push({ label: 'media sha-256 (recomputed)', value: short(mediaHex) });
    if (mediaHex !== bundle.media.sha256) {
      // Changed media leaves the credentials intact (same rule as
      // trustLadder), so the rungs above still evaluate.
      return { result: rung(1, 'Seal intact', 'diverges',
        'the credentials hold, but the media bytes no longer match what was sealed; the media changed after signing',
        rows), credentialsFailed: false };
    }
    return { result: rung(1, 'Seal intact', 'agrees',
      'signature valid over the canonical payload, declared digest bit-identical, and the media is byte-identical to what was sealed',
      rows), credentialsFailed: false };
  }
  rows.push({ label: 'media binding', value: 'not run: this is a proof-only exhibit; the media has not arrived' });
  return { result: rung(1, 'Seal intact', 'agrees',
    'signature valid over the canonical payload and the declared digest is bit-identical to the recomputed one; consistent with the sealed record being unaltered, the media binding waits for the media',
    rows), credentialsFailed: false };
}

// ---------------------------------------------------------------------------
// Rung 2 — Device credential (AttestationRecord custody signals only; the
// x5chain and App Attest checks live in the verification report)
// ---------------------------------------------------------------------------

function rungDeviceCredential(bundle: ProofBundle): RungResult {
  const record = bundle.record;
  const rows: { label: string; value: string }[] = [];

  if (record.deidentified?.rekeyed) {
    return rung(2, 'Device credential', 'not-applicable',
      'not applicable to de-identified copies: sealed with a fresh one-time key by design; the fingerprint difference from the device key is the feature, not an error',
      rows);
  }

  if (record.orgCredential) {
    rows.push({
      label: 'org credential (mirror)',
      value: `${record.orgCredential.subject ?? 'unnamed subject'} · issuer ${record.orgCredential.issuer ?? 'unnamed'} · the x5chain itself is not checked`,
    });
  }
  if (record.biometricBound) {
    rows.push({ label: 'biometric binding', value: 'record commits that each signature required Face ID/Touch ID: a commitment under signature, not hardware proof' });
  }
  if (record.deviceIntegrity) {
    const d = record.deviceIntegrity;
    rows.push({
      label: 'device integrity (self-reported)',
      value: `emulator suspected: ${d.emulatorSuspected ? 'YES' : 'no'} · jailbreak indicators: ${d.jailbreakIndicators.length} · the device said this about itself; a compromised device can lie`,
    });
  }
  if (record.captureIntegrity) {
    rows.push({
      label: 'seal latency (self-reported)',
      value: `${record.captureIntegrity.captureToSignatureMs} ms from shutter to signature; a long gap would leave room to alter bytes before sealing`,
    });
  }

  if (rows.length === 0) {
    return rung(2, 'Device credential', 'insufficient',
      'the record commits nothing about the key\'s custody beyond a bare self-signed key: anyone can mint a key in milliseconds; nothing here bounds whose hand held it',
      rows);
  }
  return rung(2, 'Device credential', 'agrees',
    'the record carries signed custody commitments (listed below). Each is a commitment the signer made about itself, consistent with careful capture; none is hardware proof, and the full credential chain check is not run here',
    rows);
}

// ---------------------------------------------------------------------------
// Rung 3 — Roster (lib/roster.ts; caller-supplied rosters only, the TLS
// well-known resolution and snapshot cache are web-side)
// ---------------------------------------------------------------------------

function rungRoster(bundle: ProofBundle, rosters: Roster[] | undefined): RungResult {
  const fp = bundle.record.signer.fingerprint;
  if (!rosters || rosters.length === 0) {
    return rung(3, 'Roster', 'not-run',
      'no roster is held on this device, so who vouches for this hand is UNRESOLVED, stated rather than assumed');
  }

  const rows: { label: string; value: string }[] = [];
  let sawInvalidRoster = false;
  for (const roster of rosters) {
    const sig = verifyRosterSignature(roster);
    if (!sig.valid || !sig.fingerprintMatches) {
      sawInvalidRoster = true;
      rows.push({ label: `roster "${roster.newsroom}"`, value: `editor signature ${sig.reason ?? 'invalid'}; a roster that fails this is not a roster` });
      continue;
    }
    // Artifacts carry no pinned-authority time, so membership evaluates at
    // atMs = null and resolves to 'unknown-time'.
    const hit = resolveInRoster(roster, fp, null);
    if (!hit) {
      rows.push({ label: `roster "${roster.newsroom}"`, value: 'editor signature valid · this hand is not listed' });
      continue;
    }
    rows.push({
      label: `roster "${hit.roster.newsroom}"`,
      value: `${hit.entry.name} (${hit.entry.role}) · vouched by editor ${hit.roster.editorName}`,
    });
    const state = hit.state;
    const at = (s: MembershipState): string =>
      s === 'unknown-time'
        ? 'no countersigned time on this exhibit, so membership at the signing moment cannot be evaluated; stated, not assumed'
        : `membership at signing: ${s}`;
    if (state === 'revoked' || state === 'not-yet-valid') {
      return rung(3, 'Roster', 'diverges',
        state === 'revoked'
          ? `listed on the roster of ${hit.roster.newsroom} but REVOKED before the signing time; signing after revocation is a red flag`
          : `listed on the roster of ${hit.roster.newsroom} but the signing time precedes the membership start; a red flag`,
        rows);
    }
    if (state === 'active' || state === 'active-then-revoked') {
      return rung(3, 'Roster', 'agrees',
        `hand found on the roster of ${hit.roster.newsroom} · ${at(state)}`,
        rows);
    }
    return rung(3, 'Roster', 'insufficient', `hand found on the roster of ${hit.roster.newsroom} · ${at(state)}`, rows);
  }

  if (sawInvalidRoster && rows.every((r) => r.value.includes('is not a roster'))) {
    return rung(3, 'Roster', 'diverges',
      'every supplied roster failed its editor signature; refused at the door like any other tamper', rows);
  }
  return rung(3, 'Roster', 'insufficient',
    'no supplied roster lists this hand; nothing outside the file vouches for it, and that is neutral, never a failure',
    rows);
}


// ---------------------------------------------------------------------------
// Rung 4 — Countersigned time (deskCore.checkOtsSet, plus the beacon lower
// bound from lib/beacon.ts)
// ---------------------------------------------------------------------------

function rungTime(bundle: ProofBundle, input: CustodyInput): RungResult {
  const record = bundle.record;
  const rows: { label: string; value: string }[] = [
    { label: 'device clock at capture (a claim)', value: record.capturedAt },
  ];

  // Signed time lower bound: the beacon block hash could not have been known
  // before that block was mined. Shape-checked only.
  let lowerBound: string | null = null;
  if (record.beacon) {
    if (isValidTip(record.beacon.blockHash, record.beacon.blockHeight)) {
      lowerBound = `Bitcoin block #${record.beacon.blockHeight}`;
      rows.push({
        label: 'beacon (signed lower bound)',
        value: `block #${record.beacon.blockHeight} (${record.beacon.blockHash.slice(0, 16)}…); this signature cannot predate that block`,
      });
    } else {
      rows.push({ label: 'beacon', value: 'malformed (not a plausible block hash/height); its lower-bound claim measures nothing' });
    }
  }

  const subs = record.ots?.submissions ?? [];
  if (subs.length === 0) {
    rows.push({ label: 'ledger receipts', value: 'none attached to this record' });
    if (lowerBound) {
      return rung(4, 'Countersigned time', 'insufficient',
        'a signed lower bound exists (beacon), but no ledger receipt bounds time from above; the signing moment is half-bracketed',
        rows);
    }
    return rung(4, 'Countersigned time', 'insufficient',
      'device clock only; no independent anchor bounds the signing moment from either side',
      rows);
  }

  const expected = hexDigestBytes(record.ots!.digestHex);

  let sawInvalid = false;
  let sawConfirmedUnchecked = false;
  let sawConfirmedBound = false;
  let sawPending = false;
  for (const sub of subs) {
    let raw: Uint8Array;
    try {
      raw = base64ToBytes(sub.receipt);
    } catch {
      sawInvalid = true;
      rows.push({ label: `receipt (${sub.calendar})`, value: 'not valid base64; cannot be evaluated' });
      continue;
    }
    const parsed = parseOtsReceipt(raw);
    const height = parsed?.attestations.find((a) => a.kind === 'bitcoin')?.blockHeight ?? null;
    const header = height !== null ? input.blockHeaders?.[height] ?? null : null;
    const v = verifyOtsReceipt(raw, expected, header);
    if (!v.receiptValid) {
      sawInvalid = true;
      rows.push({ label: `receipt (${sub.calendar})`, value: `failed: ${v.reason ?? 'invalid'}` });
      continue;
    }
    if (v.state === 'pending') {
      sawPending = true;
      rows.push({ label: `receipt (${sub.calendar})`, value: 'pending: submitted to the calendar, awaiting confirmation in a block' });
    } else if (v.blockBindingChecked && v.blockBindingValid) {
      sawConfirmedBound = true;
      rows.push({ label: `receipt (${sub.calendar})`, value: `confirmed in block #${v.blockHeight} · Merkle binding checked against the block header` });
    } else {
      sawConfirmedUnchecked = true;
      rows.push({ label: `receipt (${sub.calendar})`, value: `confirmed in block #${v.blockHeight} · block binding NOT checked here (offline)` });
    }
  }

  if (sawInvalid) {
    return rung(4, 'Countersigned time', 'diverges',
      'a ledger receipt failed structural verification; receipts commit to this payload\'s digest, so a broken one is inconsistent with an untampered timeline',
      rows);
  }
  if (sawConfirmedBound) {
    return rung(4, 'Countersigned time', 'agrees',
      lowerBound
        ? `bounded on both sides: ${lowerBound} below and a block-binding-checked ledger anchor above; consistent with the committed signing moment`
        : 'anchored from above in a Bitcoin block whose binding was checked; consistent with the payload existing no later than that block',
      rows);
  }
  if (sawConfirmedUnchecked) {
    return rung(4, 'Countersigned time', 'insufficient',
      'a ledger receipt is confirmed on-chain, but the block binding was not checked here. Supply block headers to close it; until then it half-anchors',
      rows);
  }
  if (sawPending) {
    return rung(4, 'Countersigned time', 'insufficient',
      lowerBound
        ? 'a signed lower bound exists (beacon) and the ledger receipt is still pending; the signing moment is half-bracketed from below, device clock for the rest, for now'
        : 'submitted to the Bitcoin calendars, awaiting confirmation. Device clock only for now',
      rows);
  }
  return rung(4, 'Countersigned time', 'insufficient', 'no usable ledger receipt · device clock only', rows);
}

function hexDigestBytes(hex: string): Uint8Array {
  if (!HEX64.test(hex)) return new Uint8Array(0);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Rung 5 — Notices (stub: no corrections feed exists on either surface)
// ---------------------------------------------------------------------------

/**
 * No notices/corrections feed exists, so the rung is always 'not-run' with
 * this reason. Roster revocations are rung 3, not a notice feed.
 */
const NOTICES_STUB_DETAIL =
  'no corrections/revocations feed exists for exhibits yet, so there is nothing to check against, and the rung says so instead of vanishing';

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

function blockedLadder(sealResult: RungResult): RungResult[] {
  const blocked = (n: number, title: string): RungResult =>
    rung(n, title, 'not-applicable',
      'cannot be evaluated: the credentials carrying it failed verification');
  return [
    sealResult,
    blocked(2, 'Device credential'),
    blocked(3, 'Roster'),
    blocked(4, 'Countersigned time'),
    blocked(5, 'Notices'),
  ];
}

export function runCustodyLadder(input: CustodyInput): RungResult[] {
  if (!isProofBundle(input.bundle)) {
    return malformedExhibit('not an exhibit-proof-bundle/2 artifact (format gate failed)');
  }
  const bundle = input.bundle;
  const seal = rungSeal(bundle, input);

  // Same rule as trustLadder: when the credentials fail, the key, roster
  // entry, and receipts all arrive through the same broken envelope, so every
  // rung above is not-applicable. Changed media does not trigger this.
  if (seal.credentialsFailed) {
    return blockedLadder(seal.result);
  }

  return [
    seal.result,
    rungDeviceCredential(bundle),
    rungRoster(bundle, input.rosters),
    rungTime(bundle, input),
    // Rung 5 is a stub: no corrections feed exists, so it renders not-run
    // with the reason.
    rung(5, 'Notices', 'not-run', NOTICES_STUB_DETAIL),
  ];
}
