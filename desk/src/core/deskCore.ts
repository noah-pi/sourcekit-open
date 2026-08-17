// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Desk core — intake classification, verification, trust resolution.
 * Everything runs in this browser tab; nothing is uploaded anywhere.
 */

import type { VerificationReport } from '@exhibit-archive/handrolled-verifier/verifyAsset';
import { readHandrolledPhotoAsset, readHandrolledVideoAsset } from '@exhibit/provenance/engine/handrolledEngine';
import { policyVerdict, type PolicyResult } from '@exhibit/provenance/engine/policyLayer';
import { matchDetachedManifest } from '@exhibit/provenance/detached';
import { parseManifestChain, verifyManifest } from '@exhibit-archive/handrolled-verifier/c2pa';
import { isProofBundle, isHashClaim, type ProofBundle, type HashClaim } from '@exhibit/lib/proofBundle';
import { isRoster, verifyRosterSignature, resolveInRoster, type Roster, type MembershipState } from '@exhibit/lib/roster';
import { verifyRecordSignature, payloadDigest } from '@exhibit/lib/sign';
import { parseOtsReceipt, verifyOtsReceipt } from '@exhibit/lib/ots';
import { fetchBlockHeader } from '@exhibit/lib/otsClient';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, base64ToBytes } from '@exhibit/lib/bytes';
import { hammingDistance, gradeMatch, pHashFromImage, type MatchGrade } from './phash';
import { analyzeRephoto, type RephotoReport } from './rephoto';
import { extractVideoMotion, type VideoMotionResult } from './videoMotion';
import { analyzeImuFlowConsistency, type ConsistencyReport } from '@exhibit/lib/imuflow';

/** The desk's current version — the single source of truth for UI and exports. */
export const DESK_VERSION = '0.18.4';

/** pHash for photos only; video frames are not hashed (stated, not hidden). */
async function tryPHash(bytes: Uint8Array, mime: string): Promise<string | null> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    const bmp = await createImageBitmap(blob);
    const h = await pHashFromImage(bmp, bmp.width, bmp.height);
    bmp.close();
    return h;
  } catch {
    return null;
  }
}

export type IntakeKind = 'media' | 'proof-bundle' | 'hash-claim' | 'roster' | 'unknown';

export interface IntakeItem {
  id: string;
  name: string;
  kind: IntakeKind;
  bytes?: Uint8Array;
  report?: VerificationReport;
  /**
   * The policy-layer composition behind report.verdict: engines return
   * facts, the policy layer is the ONLY verdict authority, and it asserts
   * parity with the archived verifier (a mismatch throws, never absorbs).
   * Verdict codes are unchanged.
   */
  policy?: PolicyResult;
  bundle?: ProofBundle;
  claim?: HashClaim;
  roster?: Roster;
  sha256Hex?: string;
  pHash?: string | null;
  /**
   * Screen re-photography signals — photos only; video frame analysis is
   * not implemented here. Measurements for a person to weigh, never a
   * verdict. Null when the image couldn't be rasterized.
   */
  rephoto?: RephotoReport | null;
  /**
   * IMU↔optical-flow cross-check — videos with a signed pose
   * trace only. Correlations between the signed gyro and motion observed in
   * the frames: evidence for a reviewer, never a verdict. Null when the
   * browser couldn't decode the video (stated in the dossier).
   */
  imuFlow?: ConsistencyReport | null;
  /** Sampled frames + flow series behind imuFlow — the flow-overlay data. */
  videoMotion?: VideoMotionResult | null;
  error?: string;
}

const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47];

/**
 * Compose the policy verdict with the parity assertion, converting a
 * divergence throw into a NAMED per-item finding: the parity throw is loud
 * by design, but an uncaught throw would abort the whole intake/batch —
 * the affected item is quarantined with an explicit "internal parity
 * failure" marker instead, and every other item keeps processing.
 */
async function composeOrQuarantine(
  normalized: Parameters<typeof policyVerdict>[0],
  report: VerificationReport,
): Promise<PolicyResult | Error> {
  try {
    return await policyVerdict(normalized, { handrolledReport: report });
  } catch (e) {
    return new Error(
      'internal parity failure — engine/policy divergence (a policy bug, disclosed not absorbed); ' +
      `this item is quarantined: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

/**
 * Rasterizer injection: the browser desk rasterizes with
 * canvas/<video>; the desk CLI feeds the SAME shared analyzers via ffmpeg.
 * Both paths converge on identical DSP — only the raster source differs,
 * and the dossier/report states which ran. Omitting an adapter falls back
 * to the browser implementations (web behavior unchanged).
 */
export interface DeskAdapters {
  pHash?: (bytes: Uint8Array, mime: string) => Promise<string | null>;
  rephoto?: (bytes: Uint8Array, mime: string) => Promise<RephotoReport | null>;
  videoMotion?: (bytes: Uint8Array, mime: string, epochMsAtStart: number) => Promise<VideoMotionResult | null>;
}

export async function classifyAndVerify(name: string, bytes: Uint8Array, adapters?: DeskAdapters): Promise<IntakeItem> {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // JSON artifacts first (proof bundle, hash claim, roster) — cheap probe,
  // capped at the first 64 MiB so a giant '{'-leading blob cannot force a
  // full-buffer decode/parse (a truncated probe simply fails to parse and
  // falls through to media sniffing — stated, never guessed).
  if (bytes[0] === 0x7b) {
    try {
      const probe = bytes.subarray(0, Math.min(bytes.length, 64 * 1024 * 1024));
      const parsed = JSON.parse(new TextDecoder().decode(probe));
      if (isProofBundle(parsed)) return { id, name, kind: 'proof-bundle', bundle: parsed };
      if (isHashClaim(parsed)) return { id, name, kind: 'hash-claim', claim: parsed };
      if (isRoster(parsed)) return { id, name, kind: 'roster', roster: parsed };
    } catch { /* not JSON — fall through to media */ }
  }

  if (startsWith(bytes, JPEG) || startsWith(bytes, PNG)) {
    // Verification runs through the engine layer: the hand-rolled
    // engine normalizes the archived verifier's facts, the policy layer
    // composes the verdict (parity with the archived verdict asserted).
    const { normalized, report } = await readHandrolledPhotoAsset(bytes);
    // A parity failure (engine/policy divergence) is a
    // NAMED, per-item quarantine — never an uncaught throw aborting intake.
    const policy = await composeOrQuarantine(normalized, report);
    if (policy instanceof Error) {
      return { id, name, kind: 'media', bytes, report, sha256Hex: bytesToHex(sha256(bytes)), error: policy.message };
    }
    const mime = bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
    const pHash = await (adapters?.pHash ?? tryPHash)(bytes, mime);
    const rephoto = await (adapters?.rephoto ?? analyzeRephoto)(bytes, mime);
    return { id, name, kind: 'media', bytes, report, policy, sha256Hex: bytesToHex(sha256(bytes)), pHash, rephoto };
  }
  // BMFF brands: 'ftyp' at offset 4.
  if (bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const { normalized, report } = await readHandrolledVideoAsset(bytes);
    const policy = await composeOrQuarantine(normalized, report);
    if (policy instanceof Error) {
      return { id, name, kind: 'media', bytes, report, sha256Hex: bytesToHex(sha256(bytes)), error: policy.message };
    }
    // Cross-check the signed pose trace against motion in the frames.
    // Only when the record carries a pose trace; absence is stated, not hidden.
    let imuFlow: ConsistencyReport | null = null;
    let videoMotion: VideoMotionResult | null = null;
    const rec = report.record;
    const capturedAtMs = rec ? Date.parse(rec.capturedAt) : NaN;
    if (rec?.context?.poseTrace && Number.isFinite(capturedAtMs)) {
      // 'qt  ' brand → quicktime; everything else mp4-compatible.
      const mime = bytes[8] === 0x71 && bytes[9] === 0x74 ? 'video/quicktime' : 'video/mp4';
      videoMotion = await (adapters?.videoMotion ?? extractVideoMotion)(bytes, mime, capturedAtMs);
      if (videoMotion) {
        imuFlow = analyzeImuFlowConsistency(rec.context.poseTrace, capturedAtMs, videoMotion.flow);
      }
    }
    return { id, name, kind: 'media', bytes, report, policy, sha256Hex: bytesToHex(sha256(bytes)), imuFlow, videoMotion };
  }
  return { id, name, kind: 'unknown', bytes, error: 'Not a JPEG/PNG/MP4/MOV or a Source Kit JSON artifact' };
}

// ---------------------------------------------------------------------------
// Trust resolution — same invariants as the app: membership at the VERIFIED
// signing time, tier + basis always surfaced, never green on doubt.
// ---------------------------------------------------------------------------

export type DeskTrustTier = 'roster' | 'org' | 'unknown';

export interface DeskTrust {
  tier: DeskTrustTier;
  /** Plain-language basis, always shown next to the tier. */
  basis: string;
  membershipState?: MembershipState;
  /** Red-flag states surface as warnings, never as neutral text. */
  warning?: string;
}

export function resolveDeskTrust(
  report: VerificationReport,
  trustedRosters: Roster[]
): DeskTrust | null {
  const fp = report.c2pa?.signerFingerprint ?? report.record?.signer?.fingerprint ?? null;
  const atMs = report.c2pa?.timestamps.earliestValidUtc
    ? Date.parse(report.c2pa.timestamps.earliestValidUtc)
    : null;
  const org = report.c2pa?.certChain && report.c2pa.certChain.length > 1
    ? { topSubject: report.c2pa.certChain.topSubject, linksValid: report.c2pa.certChain.linksValid }
    : null;
  return resolveSignerTrust(fp, atMs, trustedRosters, org);
}

/**
 * Signer-level trust resolution — shared by media reports AND proof-only
 * artifacts. For artifacts, atMs is null unless a VERIFIED time exists;
 * membership timing then resolves to 'unknown-time', stated not assumed.
 *
 * Returns null when the file carries NO signer fingerprint at all: an
 * unsigned file gets no signer story — no tier, no basis, no trust card.
 * Absence of a signer is not suspicion (L4); it is simply nothing to say.
 */
export function resolveSignerTrust(
  fp: string | null,
  atMs: number | null,
  trustedRosters: Roster[],
  org?: { topSubject: string | null; linksValid: boolean } | null
): DeskTrust | null {
  if (!fp) return null;

  for (const roster of trustedRosters) {
    const hit = resolveInRoster(roster, fp, atMs);
    if (!hit) continue;
    const who = `${hit.entry.name} (${hit.entry.role}) — roster "${hit.roster.newsroom}", owner ${hit.roster.editorName}`;
    switch (hit.state) {
      case 'active':
        return { tier: 'roster', basis: `Listed as ${who} at the countersigned signing time.`, membershipState: hit.state };
      case 'active-then-revoked':
        return {
          tier: 'roster',
          basis: `${who}. Membership ended after this capture's signing time — captures from before the key left the roster keep their custody (the departed-member case).`,
          membershipState: hit.state,
        };
      case 'revoked':
        return {
          tier: 'unknown',
          basis: `Listed in roster "${hit.roster.newsroom}" but REVOKED before the countersigned signing time.`,
          membershipState: hit.state,
          warning: 'This capture signed after the key was revoked — treat as a red flag.',
        };
      case 'not-yet-valid':
        return {
          tier: 'unknown',
          basis: `Listed in roster "${hit.roster.newsroom}" but membership had not begun at the countersigned signing time.`,
          membershipState: hit.state,
          warning: 'Signing time precedes membership start — red flag.',
        };
      case 'expired':
        return {
          tier: 'unknown',
          basis: `${who}. Membership had expired by the countersigned signing time.`,
          membershipState: hit.state,
        };
      case 'unknown-time':
        return {
          tier: 'roster',
          basis: `${who}. No verified timestamp, so membership at the signing time cannot be evaluated — stated, not assumed.`,
          membershipState: hit.state,
        };
    }
  }

  if (org) {
    if (org.linksValid) {
      return {
        tier: 'org',
        basis: `Signing key chains to "${org.topSubject ?? 'an organization credential'}". Chain links check out; whether you trust that organization is your call.`,
      };
    }
    return {
      tier: 'unknown',
      basis: 'Carries an organization chain whose links do NOT verify.',
      warning: 'Broken credential chain — signer identity claims are unverified.',
    };
  }

  return {
    tier: 'unknown',
    basis: 'Self-signed device certificate, not on any trusted roster. Integrity can be established; who the key belongs to cannot.',
  };
}

/** Verified roster signature is a precondition for trusting any roster. */
export function checkRoster(roster: Roster): { ok: boolean; reason: string | null; fingerprint: string | null } {
  const sig = verifyRosterSignature(roster);
  return {
    ok: sig.valid && sig.fingerprintMatches,
    reason: sig.reason,
    fingerprint: sig.fingerprintMatches ? roster.editor.fingerprint : null,
  };
}

// ---------------------------------------------------------------------------
// Artifact checks — proof bundles and hash claims that arrive WITHOUT media.
// Every check performed is listed; every check NOT performed is disclosed.
// ---------------------------------------------------------------------------

export interface OtsCheck {
  calendar: string;
  state: 'pending' | 'confirmed' | 'unverifiable';
  blockHeight: number | null;
  receiptValid: boolean;
  reason: string | null;
  /** 'unchecked' is an honest state — offline desks cannot fetch block headers. */
  binding: 'verified' | 'failed' | 'unchecked';
  bindingNote?: string;
}

export interface ArtifactCheck {
  signatureValid: boolean | null;
  fingerprintMatches: boolean | null;
  payloadDigestMatches: boolean | null;
  recomputedPayloadDigestHex: string | null;
  signerFingerprint: string | null;
  ots: OtsCheck[];
  performed: string[];
  notPerformed: string[];
}

/**
 * Verify a proof bundle's internal consistency: the record signature, the
 * payload digest the bundle claims, and every OTS receipt structurally.
 * Block binding is only checked when the desk has explicitly gone online.
 */
export async function checkProofBundle(
  bundle: ProofBundle,
  online: boolean,
  /**
   * Fired BEFORE every network fetch the check performs (block headers from
   * mempool.space), so the caller can write an audit entry before the
   * boundary is crossed — the log must never record a fetch after the fact.
   */
  onExternalCheck?: (blockHeight: number) => void
): Promise<ArtifactCheck> {
  const performed: string[] = [];
  const notPerformed: string[] = [];
  const record = bundle.record;

  const sig = verifyRecordSignature(record);
  performed.push('Record ECDSA signature checked against the embedded public key');
  performed.push('Signer fingerprint recomputed from the embedded public key');
  // PQ dual signature: software-key layer — custody always labeled.
  if (sig.pq) {
    if (sig.pq.present && sig.pq.signatureValid) {
      performed.push('Post-quantum layer on the record checks out (ML-DSA-65, SOFTWARE key — hedges a future P-256 break; NOT a hardware anchor)');
    } else if (sig.pq.present) {
      performed.push('Post-quantum layer on the record FAILED — the classical layer still stands; the PQ layer proves nothing here');
    } else {
      performed.push('Post-quantum layer STRIPPED from the record (a PQ key is committed inside the signed payload but the signature is missing) — the bundle was altered after signing');
    }
  }

  // Wi-Fi network claim: self-reported environment evidence,
  // surfaced so a desk can corroborate it — never an input to any verdict.
  const wifi = record.context?.wifi;
  if (wifi && typeof wifi === 'object') {
    performed.push(
      `Wi-Fi network claim (self-reported, spoofable — a lead, never proof of place): SSID "${wifi.ssid ?? '(none reported)'}"` +
      (wifi.bssid ? ` · BSSID ${wifi.bssid} — geo-lookup happens only in this workspace, and a BSSID match corroborates, never concludes` : ' · no BSSID reported')
    );
  } else if (wifi === 'unavailable') {
    performed.push('Wi-Fi network claim: unavailable at capture (no location permission, no Wi-Fi entitlement, or no Wi-Fi association)');
  } else if (wifi === 'redacted') {
    performed.push('Wi-Fi network claim: redacted by the signer (opt-in left off, or a de-identified copy)');
  }

  const digestHex = bytesToHex(payloadDigest(record));
  const payloadDigestMatches = digestHex === bundle.payloadDigestHex;
  performed.push('Payload digest recomputed and compared with the bundle claim');

  // The embedded C2PA manifest: its signature and assertion bindings
  // verify WITHOUT the media; the asset hash waits for media to arrive —
  // that is exactly what findManifestCustodyMatches runs.
  if (bundle.c2paManifestBase64) {
    try {
      const store = base64ToBytes(bundle.c2paManifestBase64);
      const chain = parseManifestChain(store);
      const active = chain?.manifests[chain.manifests.length - 1] ?? null;
      if (!chain || !active) {
        performed.push('C2PA manifest present but could not be parsed — treated as no manifest');
      } else {
        const v = verifyManifest(new Uint8Array(0), active);
        performed.push(`C2PA manifest signature ${v.signatureValid ? 'checks out' : 'INVALID'} against the embedded certificate (${active.manifestLabel})`);
        performed.push(`Claim ↔ assertion hashes ${v.claimAssertionsMatch ? 'bind the claim to the assertion boxes' : 'MISMATCH — the claim does not match its assertions'}`);
        if (v.pq) {
          if (v.pq.present && v.pq.signatureValid) {
            performed.push('Post-quantum layer on the COSE claim checks out (ML-DSA-65, SOFTWARE key — same commitment, second signature; not a hardware anchor)');
          } else if (v.pq.present) {
            performed.push('Post-quantum layer on the COSE claim FAILED (invalid or bound to no committed key) — the classical layer still stands');
          } else {
            performed.push('Post-quantum layer STRIPPED from the COSE claim (key committed in the signed record, verifyPq entry missing) — altered after signing');
          }
        }
        // Org identity assertion — binding ↔ claim and org ↔
        // x5chain-top cross-checks both run inside verifyManifest (the chain
        // top is read from the protected-header order; media is not needed).
        // Identity vouches for key custody, never for truth.
        if (v.identity?.present) {
          if (!v.identity.telemetryHashMatches) {
            performed.push('Org identity assertion FAILED — telemetry binding reference does not match the claim; the assertion proves nothing here');
          } else if (v.identity.orgMatchesChainTop === true) {
            performed.push(`Org identity assertion checks out: "${v.identity.org}" countersigned this claim and matches the chain top subject "${v.identity.chainTopName}" — proves WHICH org credential produced the file, never that its contents are true`);
          } else if (v.identity.orgMatchesChainTop === false) {
            performed.push(`Org identity assertion names "${v.identity.org}" but the chain top is "${v.identity.chainTopName}" — MISMATCH, treat the assertion as unproven`);
          } else {
            performed.push(`Org identity assertion bound to this claim's telemetry hash ("${v.identity.org}"), but the org name could not be cross-checked against the chain — treat as unproven`);
          }
        }
        if (chain.manifests.length > 1) {
          performed.push(`Store holds ${chain.manifests.length} manifests (an update chain) — the verdict rests on the active one, per C2PA`);
        }
        notPerformed.push('Manifest asset hash — needs the media; custody matching runs automatically when a media file arrives');
      }
    } catch {
      performed.push('C2PA manifest present but unreadable — treated as no manifest');
    }
  } else {
    notPerformed.push('No embedded C2PA manifest in this bundle — record-level checks only');
  }

  const ots = await checkOtsSet(record, digestHex, online, performed, notPerformed, onExternalCheck);

  return {
    signatureValid: sig.signatureValid,
    fingerprintMatches: sig.fingerprintMatches,
    payloadDigestMatches,
    recomputedPayloadDigestHex: digestHex,
    signerFingerprint: record.signer?.fingerprint ?? null,
    ots,
    performed,
    notPerformed,
  };
}

/**
 * A hash claim carries no record and no signature — by construction the
 * ONLY check possible is structural. The desk must say so, not approximate.
 */
export function checkHashClaim(claim: HashClaim): ArtifactCheck {
  return {
    signatureValid: null,
    fingerprintMatches: null,
    payloadDigestMatches: null,
    recomputedPayloadDigestHex: null,
    signerFingerprint: claim.signerFingerprint,
    ots: [],
    performed: [
      'Format gate passed (verify-hash-claim/1, 64-hex digests)',
    ],
    notPerformed: [
      'Signature verification — a hash-only claim carries no signature, by design (source protection)',
      'Payload digest recomputation — the record is not included',
      'Media binding — exact-match only, and only once media with this SHA-256 arrives',
    ],
  };
}

async function checkOtsSet(
  record: ProofBundle['record'],
  digestHex: string,
  online: boolean,
  performed: string[],
  notPerformed: string[],
  onExternalCheck?: (blockHeight: number) => void
): Promise<OtsCheck[]> {
  const subs = record.ots?.submissions ?? [];
  if (subs.length === 0) {
    notPerformed.push('OpenTimestamps ledger receipts — none attached to this record');
    return [];
  }
  const digest = hexToBytes(digestHex);
  const out: OtsCheck[] = [];
  for (const sub of subs) {
    let raw: Uint8Array;
    try {
      raw = base64ToBytes(sub.receipt);
    } catch {
      out.push({ calendar: sub.calendar, state: 'unverifiable', blockHeight: null, receiptValid: false, reason: 'receipt is not valid base64', binding: 'unchecked' });
      continue;
    }
    if (!online) {
      const v = verifyOtsReceipt(raw, digest, null);
      out.push({
        calendar: sub.calendar,
        state: v.state,
        blockHeight: v.blockHeight,
        receiptValid: v.receiptValid,
        reason: v.reason,
        binding: 'unchecked',
        bindingNote: v.state === 'confirmed' ? 'Bitcoin block binding not checked — this workspace is offline (enable online checks to check it)' : undefined,
      });
      continue;
    }
    // Online: structural check first, then block binding for confirmed receipts.
    const structural = verifyOtsReceipt(raw, digest, null);
    if (!structural.receiptValid || structural.state !== 'confirmed' || structural.blockHeight == null) {
      out.push({
        calendar: sub.calendar,
        state: structural.state,
        blockHeight: structural.blockHeight,
        receiptValid: structural.receiptValid,
        reason: structural.reason,
        binding: 'unchecked',
      });
      continue;
    }
    try {
      // Audit BEFORE the fetch — the boundary log must precede the crossing.
      onExternalCheck?.(structural.blockHeight);
      const header = await fetchBlockHeader(structural.blockHeight);
      const bound = verifyOtsReceipt(raw, digest, header);
      out.push({
        calendar: sub.calendar,
        state: bound.state,
        blockHeight: bound.blockHeight,
        receiptValid: bound.receiptValid,
        reason: bound.reason,
        binding: bound.blockBindingValid ? 'verified' : 'failed',
        bindingNote: bound.blockBindingValid ? undefined : 'Receipt does not bind to the fetched Bitcoin block header',
      });
    } catch (e) {
      out.push({
        calendar: sub.calendar,
        state: structural.state,
        blockHeight: structural.blockHeight,
        receiptValid: structural.receiptValid,
        reason: structural.reason,
        binding: 'unchecked',
        bindingNote: `Block header fetch failed (${e instanceof Error ? e.message : 'network error'}) — binding unverified, not failed`,
      });
    }
  }
  performed.push(`OpenTimestamps receipts parsed and checked against the payload digest (${subs.length} submission${subs.length === 1 ? '' : 's'})`);
  if (online) performed.push('Bitcoin block bindings checked against fetched block headers (mempool.space)');
  else notPerformed.push('Bitcoin block binding — requires fetching block headers; enable online checks to perform it');
  return out;
}

// ---------------------------------------------------------------------------
// Proof↔media recovery (docs/RECOVERY.md) — two grades, never merged.
// ---------------------------------------------------------------------------

export interface RecoveryMatch {
  proofItemId: string;
  proofName: string;
  mediaItemId: string;
  mediaName: string;
  grade: MatchGrade;
  /** Hamming distance for visual leads; null for exact. */
  distance: number | null;
  /** For visual leads: which exactly-matched media anchors the transitive link. */
  viaMediaName?: string;
}

/**
 * Match proofs to media across the whole intake.
 * - Exact: media SHA-256 equals the proof's mediaSha256. Certain.
 * - Visual: a media item's pHash is close to ANOTHER media item that has an
 *   exact proof match (re-encode lead). Transitive, stated as such.
 * Hash-only claims never produce visual leads — by construction (RECOVERY.md).
 */
export function findRecoveryMatches(items: IntakeItem[], likelyMax: number, possibleMax: number): RecoveryMatch[] {
  const media = items.filter((i) => i.kind === 'media' && i.sha256Hex);
  const proofs = items.filter((i) => i.kind === 'proof-bundle' || i.kind === 'hash-claim');
  const matches: RecoveryMatch[] = [];

  const proofSha = (p: IntakeItem): string | null =>
    p.kind === 'proof-bundle' ? p.bundle!.media.sha256 : p.claim!.mediaSha256;

  // Exact matches first — these anchor the visual leads.
  const exactByMedia = new Map<string, { proof: IntakeItem }[]>();
  for (const p of proofs) {
    const sha = proofSha(p);
    for (const m of media) {
      if (m.sha256Hex === sha) {
        matches.push({ proofItemId: p.id, proofName: p.name, mediaItemId: m.id, mediaName: m.name, grade: 'exact', distance: null });
        const list = exactByMedia.get(m.id) ?? [];
        list.push({ proof: p });
        exactByMedia.set(m.id, list);
      }
    }
  }

  // Visual leads: re-encoded media (no exact match of its own) that is
  // perceptually close to a media item WITH an exact proof match.
  for (const candidate of media) {
    if (exactByMedia.has(candidate.id)) continue;
    if (!candidate.pHash) continue;
    for (const [anchorId, proofList] of exactByMedia) {
      const anchor = media.find((m) => m.id === anchorId);
      if (!anchor?.pHash || anchor.id === candidate.id) continue;
      const d = hammingDistance(candidate.pHash, anchor.pHash);
      const grade = gradeMatch(false, d, likelyMax, possibleMax);
      if (grade === 'none') continue;
      for (const { proof } of proofList) {
        // Hash-only claims are exact-match only by construction — never a visual lead.
        if (proof.kind === 'hash-claim') continue;
        matches.push({
          proofItemId: proof.id,
          proofName: proof.name,
          mediaItemId: candidate.id,
          mediaName: candidate.name,
          grade,
          distance: d,
          viaMediaName: anchor.name,
        });
      }
    }
  }
  return matches;
}

/**
 * Detached-manifest custody matches — the third recovery grade.
 *
 * A platform stripped the credentials from a media file; a proof bundle in
 * the intake carries the detached manifest. The match is EXACT cryptography
 * (asset hash with the manifest's own bytes excluded — the construction
 * working as designed), reported as its own grade: stronger than a pHash
 * lead (which stays a lead), distinct from byte-identical (the file really
 * was altered — its metadata was removed).
 */
export interface ManifestCustodyMatch {
  mediaItemId: string;
  mediaName: string;
  bundleItemId: string;
  bundleName: string;
  /** Which exact reconstruction matched (detached.ts defines both). */
  how: 'stripped-container' | 'exclusion-ranges';
  manifestLabel: string;
}

export function findManifestCustodyMatches(items: IntakeItem[]): ManifestCustodyMatch[] {
  const media = items.filter((i) => i.kind === 'media' && i.bytes && i.bytes.length > 0);
  const bundles = items.filter((i) => i.kind === 'proof-bundle' && i.bundle?.c2paManifestBase64);
  const out: ManifestCustodyMatch[] = [];
  for (const m of media) {
    for (const b of bundles) {
      try {
        const store = base64ToBytes(b.bundle!.c2paManifestBase64!);
        const match = matchDetachedManifest(m.bytes!, store);
        if (match) {
          out.push({
            mediaItemId: m.id,
            mediaName: m.name,
            bundleItemId: b.id,
            bundleName: b.name,
            how: match.how,
            manifestLabel: match.manifestLabel,
          });
        }
      } catch {
        // A malformed bundle fails its own dossier check — never this loop.
      }
    }
  }
  return out;
}
