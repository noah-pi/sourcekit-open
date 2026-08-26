// Source Kit 0.1.0 — Stereo-capture artifact ingestion
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Stereo-capture artifact ingestion (Spec-Camera-Module-0.13 §5 → seal).
 *
 * The native stereo module emits, per capture, five optional artifacts
 * alongside the primary delivery file — each a THREE-STATE evidence path
 * (src/provenance/manifest.ts EvidencePath semantics, E.04):
 *
 *   string (a path)   — recorded; the bytes are read, hashed, and committed
 *   null              — the sink was ENABLED but failed; the native error
 *                       string is committed, verbatim. A failure, stated.
 *   'never-recorded'  — the sink never ran (stereo unsupported, raw not
 *                       requested, …) — an unreached state, never suspicion,
 *                       never red. The declaration is committed with its
 *                       reason at seal time.
 *
 * NO SILENT ABSENCE: every artifact of every stereo capture lands in exactly
 * one of those states, and the state itself is committed two ways:
 *
 *   1. a `context.stereo-*` claim in the capture's disclosure context tree
 *      (disclosure/captureCommit.ts). The claim VALUE states the outcome —
 *      'sha256:<hex>' when recorded, 'error:<string>' when the sink failed,
 *      'never-recorded[:<reason>]' when unreached — and the inventory
 *      meta-leaf at tree index 0 (disclosure/inventory.ts, audit A-01)
 *      binds the full entries list into the signed root. The declaration is
 *      made AT COMMIT TIME and is immutable after — the same binding the
 *      fixed-ladder never-recorded states get. (The context family is
 *      free-form: these five claims are committed leaves rather than
 *      never-recorded STATES, which the fixed schema reserves for ladder
 *      rungs; the committed-value form is strictly stronger — the state is
 *      a signed value, not just an entry flag.)
 *
 *   2. a `stereo` section in the proof bundle (lib/proofBundle.ts,
 *      format 'exhibit-proof-bundle/2') carrying per-artifact state, hash,
 *      byte count, and — for every artifact except the multi-megabyte DNG —
 *      the bytes themselves, inline as base64. The desk needs the PIXELS:
 *      the stereo verifier never accepts a hash-only secondary frame
 *      (desk/stereo/types.ts). The raw DNG rides hash-only; its bytes stay
 *      in the vault (stated in the entry, never implied).
 *
 * This module also builds the StereoCommitment the desk feeds to
 * verifyStereoCommitment. desk/stereo/types.ts is the CANONICAL contract;
 * the interfaces here mirror it structurally (this file must stay importable
 * from the app tree, which does not carry desk/). The desk command
 * (desk/cli/stereoVerify.ts) assigns the result to the canonical type, so
 * drift fails the desk's own typecheck — and the bundle suite
 * (tests/test-stereo-bundle.mts) runs the result through the real verifier.
 *
 * HONESTY RULES (standing): absence is never suspicion; a hash mismatch
 * between the bundle's embedded bytes and the committed hash is PROVEN
 * TAMPER — a red-class failure, distinct from absence and from a stated
 * record error; nothing here says "passed" or "authentic". This module
 * commits inputs; it never concludes.
 */

import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64, bytesToHex, bytesToUtf8, utf8ToBytes } from '../lib/bytes';
import type { EvidencePath } from './manifest';
import type { ContextClaim } from '../disclosure/inventory';

// ---------------------------------------------------------------------------
// The artifact set (Spec-Camera-Module-0.13 §5 "The COMMITMENT CONTRACT").
// ---------------------------------------------------------------------------

export type StereoArtifactId = 'secondaryFrame' | 'calibration' | 'timestamps' | 'metadata' | 'rawDng';

export const STEREO_ARTIFACT_IDS: readonly StereoArtifactId[] = [
  'secondaryFrame', 'calibration', 'timestamps', 'metadata', 'rawDng',
];

/** The context-tree claimId each artifact's state commits under. */
export const STEREO_CLAIM_IDS: Record<StereoArtifactId, string> = {
  secondaryFrame: 'context.stereo-secondary-frame',
  calibration: 'context.stereo-calibration',
  timestamps: 'context.stereo-timestamps',
  metadata: 'context.stereo-metadata',
  rawDng: 'context.stereo-raw-dng',
};

const ARTIFACT_MIME: Record<StereoArtifactId, string> = {
  secondaryFrame: 'image/jpeg',
  calibration: 'application/json',
  timestamps: 'application/json',
  metadata: 'application/json',
  rawDng: 'image/x-adobe-dng',
};

/**
 * Artifacts whose bytes ride the proof bundle inline. The secondary frame
 * (~200 KB) and the three small JSON blocks are geometry INPUTS — the desk
 * recomputes from them, so they must travel with the proof. The raw DNG
 * (tens of MB) is hash-only: committed, vault-held, stated as such.
 */
const INLINE_IN_BUNDLE: Record<StereoArtifactId, boolean> = {
  secondaryFrame: true,
  calibration: true,
  timestamps: true,
  metadata: true,
  rawDng: false,
};

// ---------------------------------------------------------------------------
// Input — the CaptureResult handoff. The wiring layer (capture screen →
// seal queue) maps the native module's per-capture payload onto this shape:
// each artifact's three-state path exactly as reported, the bytes read from
// the path when recorded, the native error string when the sink failed, and
// the stated reason when never recorded.
// ---------------------------------------------------------------------------

export interface StereoArtifactInput {
  /** The native module's three-state path for this artifact (E.04). */
  path: EvidencePath;
  /** The artifact bytes, read from `path`. REQUIRED when path is a real path. */
  bytes?: Uint8Array | null;
  /** The native error string — REQUIRED when path === null (enabled-but-failed). */
  error?: string | null;
  /** The stated reason (e.g. 'stereo-unsupported', 'raw-unsupported') when 'never-recorded'. */
  reason?: string | null;
}

export type StereoCaptureArtifacts = Record<StereoArtifactId, StereoArtifactInput>;

// ---------------------------------------------------------------------------
// Output (a): the proof-bundle section.
// ---------------------------------------------------------------------------

export interface StereoArtifactBundleEntry {
  state: 'recorded' | 'error' | 'never-recorded';
  /** SHA-256 (hex) of the artifact bytes — present iff state === 'recorded'. */
  sha256?: string;
  /** Artifact byte count — present iff state === 'recorded'. */
  bytes?: number;
  mime?: string;
  /**
   * The artifact bytes, base64 — present when recorded AND the artifact is
   * small enough to ride the bundle (everything except rawDng). ABSENT for
   * rawDng is a stated hash-only commitment, never a silent omission.
   */
  dataBase64?: string;
  /** The committed native error string — present iff state === 'error'. */
  error?: string;
  /** The stated reason — present when state === 'never-recorded' and the module gave one. */
  reason?: string;
}

export interface StereoBundleSection {
  /** SHA-256 (hex) of the primary delivery file — the record's asset hash. */
  primaryFrameSha256: string;
  artifacts: Record<StereoArtifactId, StereoArtifactBundleEntry>;
  /** The context-tree claimIds whose committed VALUES restate these states (binding 1, header). */
  contextClaimIds: string[];
  note: string;
}

export const STEREO_BUNDLE_NOTE =
  'Stereo-capture artifacts (Spec-Camera-Module-0.13): the desk-side planarity signal recomputes ' +
  'geometry from these committed INPUTS — never from a device-computed verdict. Three states per ' +
  'artifact: recorded (hash + inline bytes; rawDng is hash-only, vault-held), error (the committed ' +
  'native failure string), never-recorded (an unreached state). The ' +
  'same states are committed as context.stereo-* claim values in the capture\'s context tree ' +
  '(com.verify.contextTree), so the signed root binds them.';

/** Cap on committed error strings — committed verbatim, but bounded. */
const MAX_ERROR_CHARS = 500;

function claimValueFor(id: StereoArtifactId, input: StereoArtifactInput, sha256Hex?: string): string {
  if (typeof input.path === 'string' && input.path !== 'never-recorded') return `sha256:${sha256Hex}`;
  if (input.path === null) return `error:${input.error!.slice(0, MAX_ERROR_CHARS)}`;
  return input.reason ? `never-recorded:${input.reason}` : 'never-recorded';
}

/**
 * Commit one capture's stereo artifacts: hash what was recorded, carry the
 * error strings verbatim, declare the never-recorded states — and produce
 * both commitment surfaces (bundle section + context-tree claims).
 *
 * Throws on any violation of the three-state contract: a recorded path
 * without bytes, a null path without its error string, an unknown path
 * value. A capture that cannot say which state an artifact is in must not
 * commit — the same rule the disclosure inventory enforces for claims.
 */
export function commitStereoArtifacts(
  artifacts: StereoCaptureArtifacts,
  primaryFrameSha256: string,
): { section: StereoBundleSection; contextClaims: ContextClaim[] } {
  if (!/^[0-9a-f]{64}$/.test(primaryFrameSha256)) {
    throw new Error('stereoArtifacts: primaryFrameSha256 must be the delivery file\'s SHA-256 (hex)');
  }
  const entries = {} as Record<StereoArtifactId, StereoArtifactBundleEntry>;
  const contextClaims: ContextClaim[] = [];

  for (const id of STEREO_ARTIFACT_IDS) {
    const input = artifacts[id];
    if (!input || typeof input !== 'object') {
      throw new Error(`stereoArtifacts: artifact '${id}' is missing from the capture payload — every artifact reports a state, always`);
    }
    const { path } = input;
    if (typeof path === 'string' && path !== 'never-recorded') {
      if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
        throw new Error(`stereoArtifacts: artifact '${id}' reports a recorded path but carries no bytes — no silent absence`);
      }
      const digest = bytesToHex(sha256(input.bytes));
      entries[id] = {
        state: 'recorded',
        sha256: digest,
        bytes: input.bytes.length,
        mime: ARTIFACT_MIME[id],
        ...(INLINE_IN_BUNDLE[id] ? { dataBase64: bytesToBase64(input.bytes) } : {}),
      };
      contextClaims.push({ claimId: STEREO_CLAIM_IDS[id], family: 'context', rung: 0, value: claimValueFor(id, input, digest) });
    } else if (path === null) {
      if (typeof input.error !== 'string' || input.error.length === 0) {
        throw new Error(`stereoArtifacts: artifact '${id}' is null (enabled-but-failed) but carries no error string — the failure must be stated`);
      }
      entries[id] = { state: 'error', error: input.error.slice(0, MAX_ERROR_CHARS), mime: ARTIFACT_MIME[id] };
      contextClaims.push({ claimId: STEREO_CLAIM_IDS[id], family: 'context', rung: 0, value: claimValueFor(id, input) });
    } else if (path === 'never-recorded') {
      entries[id] = {
        state: 'never-recorded',
        ...(input.reason ? { reason: input.reason } : {}),
      };
      contextClaims.push({ claimId: STEREO_CLAIM_IDS[id], family: 'context', rung: 0, value: claimValueFor(id, input) });
    } else {
      throw new Error(`stereoArtifacts: artifact '${id}' path is '${String(path)}' — not a three-state EvidencePath`);
    }
  }

  return {
    section: {
      primaryFrameSha256,
      artifacts: entries,
      contextClaimIds: STEREO_ARTIFACT_IDS.map((id) => STEREO_CLAIM_IDS[id]),
      note: STEREO_BUNDLE_NOTE,
    },
    contextClaims,
  };
}

// ---------------------------------------------------------------------------
// Output (b): the StereoCommitment. MIRRORED types — canonical contract is
// desk/stereo/types.ts; keep field-for-field identical (the desk command
// assigns through the canonical type, and the bundle suite exercises the
// real verifier on this output).
// ---------------------------------------------------------------------------

export interface CameraIntrinsicsShape {
  fx: number; fy: number; cx: number; cy: number; width: number; height: number;
}

export interface CameraExtrinsicsShape {
  /** Row-major 3×3; P_secondary = R · P_primary + t. */
  rotation: number[];
  translationM: [number, number, number];
}

export interface DistortionLutShape {
  width: number;
  height: number;
  domainRadius: number;
  values: ArrayLike<number>;
}

export interface StereoMetadataBlockShape {
  focusDistanceM?: number;
  focalLengthMm: number;
  aperture: number;
  exposureS: number;
  iso: number;
  devicePosition: string;
  antiBandingState: string;
}

export interface StereoCommitmentShape {
  primaryFrameHash: string;
  secondaryFrame: { path: string } | { bytes: Uint8Array };
  calibration: {
    intrinsicsWide: CameraIntrinsicsShape;
    intrinsicsUltraWide: CameraIntrinsicsShape;
    extrinsics: CameraExtrinsicsShape;
    distortionLut?: DistortionLutShape;
  };
  syncTimestampDeltaMs: number;
  /** Photo commitments carry the per-capture metadata block; VIDEO pair
      commitments carry none (the module commits no per-pair block), so the
      distance gate weighs the disparity cue alone. Optional since 0.13.0 —
      the desk's use was already optional-chained. */
  metadataBlock?: StereoMetadataBlockShape;
}

// ---- calibration JSON (the native serializer's committed shape) -----------

/**
 * The committed calibration JSON (Spec §4.2 point 3, JSON-serialized for the
 * seal path): both devices' intrinsics in pixels, the rig extrinsics with
 * the baseline in meters, the ultra-wide forward distortion LUT in the
 * desk-normalized {width,height,domainRadius,values} form, and a
 * `calibrationSource` label stating WHERE the numbers came from (e.g.
 * 'avcamera-calibration-data' — OS frame attachments; a future static
 * fallback must say so). The label rides along; the desk never upgrades a
 * number because of it.
 */
export interface StereoCalibrationJson {
  calibrationSource: string;
  intrinsicsWide: CameraIntrinsicsShape;
  intrinsicsUltraWide: CameraIntrinsicsShape;
  extrinsics: {
    rotation: number[];
    translationM: [number, number, number];
    /** |translationM| as committed by the device — cross-checked, not trusted. */
    baselineMeters?: number;
  };
  /** Forward LUT (undistorted → distorted), desk-normalized — the UW lens. */
  distortionLut?: DistortionLutShape;
}

function finiteNumbers(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function parseIntrinsics(x: unknown, label: string): CameraIntrinsicsShape {
  const o = x as Record<string, unknown>;
  const keys = ['fx', 'fy', 'cx', 'cy', 'width', 'height'] as const;
  if (!o || !keys.every((k) => typeof o[k] === 'number' && Number.isFinite(o[k] as number))) {
    throw new Error(`stereo calibration: ${label} must carry finite fx/fy/cx/cy/width/height`);
  }
  return { fx: o.fx as number, fy: o.fy as number, cx: o.cx as number, cy: o.cy as number, width: o.width as number, height: o.height as number };
}

export function parseStereoCalibration(jsonText: string): StereoCalibrationJson {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`stereo calibration: unparseable JSON — ${(e as Error).message}`);
  }
  if (typeof o.calibrationSource !== 'string' || o.calibrationSource.length === 0) {
    throw new Error('stereo calibration: calibrationSource label is required — where the numbers came from is part of the commitment');
  }
  const ext = o.extrinsics as Record<string, unknown>;
  if (!ext || !finiteNumbers(ext.rotation, 9) || !finiteNumbers(ext.translationM, 3)) {
    throw new Error('stereo calibration: extrinsics must carry rotation (9 finite) and translationM (3 finite, meters)');
  }
  const baseline = Math.hypot(...(ext.translationM as [number, number, number]));
  if (typeof ext.baselineMeters === 'number') {
    if (!Number.isFinite(ext.baselineMeters) || Math.abs(ext.baselineMeters - baseline) > Math.max(1e-6, baseline * 0.01)) {
      throw new Error(
        `stereo calibration: committed baselineMeters ${String(ext.baselineMeters)} disagrees with |translationM| ${baseline} — a commitment that contradicts itself is malformed, not evidence`
      );
    }
  }
  let lut: DistortionLutShape | undefined;
  if (o.distortionLut !== undefined && o.distortionLut !== null) {
    const l = o.distortionLut as Record<string, unknown>;
    if (
      !l || !Number.isInteger(l.width) || !Number.isInteger(l.height) ||
      (l.width as number) < 2 || (l.height as number) < 2 ||
      typeof l.domainRadius !== 'number' || !Number.isFinite(l.domainRadius) || (l.domainRadius as number) <= 0 ||
      !Array.isArray(l.values) || l.values.length < (l.width as number) * (l.height as number) * 2 ||
      !l.values.every((x) => typeof x === 'number' && Number.isFinite(x))
    ) {
      throw new Error('stereo calibration: distortionLut is malformed (need width/height ≥ 2, finite domainRadius > 0, width×height×2 finite values)');
    }
    lut = { width: l.width as number, height: l.height as number, domainRadius: l.domainRadius as number, values: l.values as number[] };
  }
  return {
    calibrationSource: o.calibrationSource,
    intrinsicsWide: parseIntrinsics(o.intrinsicsWide, 'intrinsicsWide'),
    intrinsicsUltraWide: parseIntrinsics(o.intrinsicsUltraWide, 'intrinsicsUltraWide'),
    extrinsics: {
      rotation: [...(ext.rotation as number[])],
      translationM: [...(ext.translationM as number[])] as [number, number, number],
      ...(typeof ext.baselineMeters === 'number' ? { baselineMeters: ext.baselineMeters } : {}),
    },
    ...(lut ? { distortionLut: lut } : {}),
  };
}

// ---- timestamps JSON ------------------------------------------------------

/**
 * The committed sync timestamps (Spec §4.2 point 4): each frame's PTS in
 * host-clock seconds, the wall-clock anchor, and the inter-frame delta in
 * milliseconds — the sync CLAIM, committed uninterpreted (what it means is
 * the desk's problem).
 */
export interface StereoTimestampsJson {
  primaryPtsSeconds: number;
  secondaryPtsSeconds: number;
  wallClockAnchorIso?: string;
  synchronizedDeltaMs: number;
}

export function parseStereoTimestamps(jsonText: string): StereoTimestampsJson {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`stereo timestamps: unparseable JSON — ${(e as Error).message}`);
  }
  if (typeof o.synchronizedDeltaMs !== 'number' || !Number.isFinite(o.synchronizedDeltaMs)) {
    throw new Error('stereo timestamps: synchronizedDeltaMs (finite ms) is required — the sync claim itself');
  }
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`stereo timestamps: ${k} must be a finite number`);
    return v;
  };
  return {
    primaryPtsSeconds: num('primaryPtsSeconds'),
    secondaryPtsSeconds: num('secondaryPtsSeconds'),
    ...(typeof o.wallClockAnchorIso === 'string' ? { wallClockAnchorIso: o.wallClockAnchorIso } : {}),
    synchronizedDeltaMs: o.synchronizedDeltaMs,
  };
}

// ---- metadata JSON (CameraMetadataBlock, Spec §5) → StereoMetadataBlock ---

/**
 * The committed camera metadata block (Spec §5 + 0.13 §5 additions). Every
 * field is literally true or explicit null; `focusDistanceMeters` is null BY
 * CONSTRUCTION (iOS exposes no focus-distance API — stated, never fabricated
 * from lensPosition), so the desk's distance gate weighs only the geometry
 * it recomputes. `controlsReportedBy: 'device'` labels every control value
 * as a device read-back.
 */
export interface CameraMetadataBlock {
  controlsReportedBy: 'device';
  /** Always null on this platform (Spec §5) — the honesty rule, committed. */
  focusDistanceMeters: number | null;
  /** Millimeter focal length (EXIF FocalLength read-back). */
  focalLengthMm: number;
  apertureFNumber: number;
  exposureDurationSec: number;
  iso: number;
  /** Which physical device fired as primary (e.g. 'wide'). */
  physicalDevice: string;
  /** Mains-frequency hint, labeled 'region-derived' (Spec §5 — no flicker API). */
  antiBanding: string;
  /** Remaining committed fields ride through untyped — the desk reads what it needs. */
  [k: string]: unknown;
}

export function stereoMetadataFromBlock(block: CameraMetadataBlock): StereoMetadataBlockShape {
  if (block.controlsReportedBy !== 'device') {
    throw new Error(`stereo metadata: controlsReportedBy must be 'device' (got '${String(block.controlsReportedBy)}') — control values are device read-backs, labeled`);
  }
  if (block.focusDistanceMeters !== null && (typeof block.focusDistanceMeters !== 'number' || !Number.isFinite(block.focusDistanceMeters))) {
    throw new Error('stereo metadata: focusDistanceMeters must be null or a finite number');
  }
  const num = (v: unknown, label: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`stereo metadata: ${label} must be a finite number (or the field stays null upstream)`);
    return v;
  };
  return {
    // null-by-construction → the field is simply absent from the block the
    // desk weighs; the gate's geometry cue (triangulation) stands alone.
    ...(typeof block.focusDistanceMeters === 'number' ? { focusDistanceM: block.focusDistanceMeters } : {}),
    focalLengthMm: num(block.focalLengthMm, 'focalLengthMm'),
    aperture: num(block.apertureFNumber, 'apertureFNumber'),
    exposureS: num(block.exposureDurationSec, 'exposureDurationSec'),
    iso: num(block.iso, 'iso'),
    devicePosition: typeof block.physicalDevice === 'string' && block.physicalDevice.length > 0 ? block.physicalDevice : 'wide',
    antiBandingState: typeof block.antiBanding === 'string' ? block.antiBanding : 'not reported',
  };
}

// ---------------------------------------------------------------------------
// Bundle section → StereoCommitment (the desk's path, shared with the test).
// ---------------------------------------------------------------------------

/** Read the inline bytes of a recorded artifact entry, or throw naming why not. */
export function stereoEntryBytes(entry: StereoArtifactBundleEntry, id: StereoArtifactId): Uint8Array {
  if (entry.state !== 'recorded' || !entry.dataBase64) {
    throw new Error(`stereo artifact '${id}' is ${entry.state === 'recorded' ? 'hash-only (bytes stay in the vault)' : entry.state} — no inline bytes`);
  }
  return base64ToBytes(entry.dataBase64);
}

/**
 * Build the StereoCommitment (desk/stereo/types.ts shape) from a bundle
 * section. Requires recorded+intact secondaryFrame, calibration, timestamps,
 * and metadata — anything less and the caller reports the per-artifact
 * states instead of fabricating geometry inputs. Hash integrity is checked
 * FIRST: a tampered section throws rather than reaching the verifier.
 */
export function buildStereoCommitment(section: StereoBundleSection): StereoCommitmentShape {
  for (const id of ['secondaryFrame', 'calibration', 'timestamps', 'metadata'] as const) {
    const state = section.artifacts[id]?.state;
    if (state !== 'recorded') {
      throw new Error(`stereo commitment cannot be built: artifact '${id}' is ${state ?? 'absent'}`);
    }
  }
  const integrity = checkStereoSectionIntegrity(section);
  const tampered = STEREO_ARTIFACT_IDS.filter((id) => integrity[id].integrity === 'PROVEN-TAMPER');
  if (tampered.length > 0) {
    throw new Error(`stereo commitment refused: PROVEN TAMPER on ${tampered.join(', ')} — embedded bytes do not match the committed hash`);
  }
  const calibration = parseStereoCalibration(bytesToUtf8(stereoEntryBytes(section.artifacts.calibration, 'calibration')));
  const timestamps = parseStereoTimestamps(bytesToUtf8(stereoEntryBytes(section.artifacts.timestamps, 'timestamps')));
  const metadataBlock = stereoMetadataFromBlock(JSON.parse(bytesToUtf8(stereoEntryBytes(section.artifacts.metadata, 'metadata'))));
  return {
    primaryFrameHash: `sha256:${section.primaryFrameSha256}`,
    secondaryFrame: { bytes: stereoEntryBytes(section.artifacts.secondaryFrame, 'secondaryFrame') },
    calibration: {
      intrinsicsWide: calibration.intrinsicsWide,
      intrinsicsUltraWide: calibration.intrinsicsUltraWide,
      extrinsics: {
        rotation: calibration.extrinsics.rotation,
        translationM: calibration.extrinsics.translationM,
      },
      ...(calibration.distortionLut ? { distortionLut: calibration.distortionLut } : {}),
    },
    syncTimestampDeltaMs: timestamps.synchronizedDeltaMs,
    metadataBlock,
  };
}

// ---------------------------------------------------------------------------
// Integrity: committed hash vs embedded bytes. A mismatch is PROVEN TAMPER —
// the bundle's own commitment is violated; red-class, fail-closed, and
// DISTINCT from absence (never-recorded / error are gray/amber statements,
// never suspicion).
// ---------------------------------------------------------------------------

export type StereoArtifactIntegrity =
  /** Embedded bytes hash to the committed value. */
  | 'hash-match'
  /** Embedded bytes do NOT hash to the committed value — proven tamper. */
  | 'PROVEN-TAMPER'
  /** Recorded but hash-only (rawDng): the bytes are not inline; stated. */
  | 'hash-only'
  /** Declared unreached at commit time — never suspicion. */
  | 'never-recorded'
  /** The sink failed; the committed error string stands. */
  | 'record-error';

export interface StereoIntegrityResult {
  integrity: StereoArtifactIntegrity;
  detail: string;
}

/** Per-entry integrity: committed hash vs embedded bytes. Shared by the
    photo section and the per-pair video entries. */
function stereoEntryIntegrity(id: string, e: StereoArtifactBundleEntry): StereoIntegrityResult {
  if (e.state === 'never-recorded') {
    return { integrity: 'never-recorded', detail: `never-recorded${e.reason ? ` (${e.reason})` : ''} — an unreached state, not suspicion` };
  }
  if (e.state === 'error') {
    return { integrity: 'record-error', detail: `record error, committed verbatim: ${e.error}` };
  }
  if (!e.dataBase64) {
    return { integrity: 'hash-only', detail: `recorded (${e.bytes} bytes), committed sha256:${e.sha256} — bytes stay in the vault (hash-only commitment, stated)` };
  }
  const actual = bytesToHex(sha256(base64ToBytes(e.dataBase64)));
  return actual === e.sha256
    ? { integrity: 'hash-match', detail: `embedded bytes hash to the committed sha256:${e.sha256}` }
    : {
        integrity: 'PROVEN-TAMPER',
        detail:
          `PROVEN TAMPER — the embedded bytes hash to sha256:${actual} but the committed value is sha256:${e.sha256}. ` +
          'The bundle\'s own commitment is violated: bytes or hash were altered after commitment. ' +
          'This is a proven mismatch (red-class), distinct from absence.',
      };
}

export function checkStereoSectionIntegrity(section: StereoBundleSection): Record<StereoArtifactId, StereoIntegrityResult> {
  const out = {} as Record<StereoArtifactId, StereoIntegrityResult>;
  for (const id of STEREO_ARTIFACT_IDS) {
    const e = section.artifacts[id];
    if (!e) {
      // A missing entry in a /2 bundle section is a MALFORMED bundle, not an
      // absence state — the commit path never produces it.
      out[id] = { integrity: 'PROVEN-TAMPER', detail: `entry for '${id}' is missing from the stereo section — the commit path accounts for every artifact; this section was altered` };
      continue;
    }
    out[id] = stereoEntryIntegrity(id, e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Guards (bundle format gate support).
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;

export function isStereoArtifactBundleEntry(x: unknown): x is StereoArtifactBundleEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  if (e.state === 'recorded') {
    return (
      typeof e.sha256 === 'string' && HEX64.test(e.sha256) &&
      typeof e.bytes === 'number' && Number.isInteger(e.bytes) && e.bytes > 0 &&
      (e.dataBase64 === undefined || typeof e.dataBase64 === 'string')
    );
  }
  if (e.state === 'error') return typeof e.error === 'string' && e.error.length > 0;
  if (e.state === 'never-recorded') return e.reason === undefined || typeof e.reason === 'string';
  return false;
}

export function isStereoBundleSection(x: unknown): x is StereoBundleSection {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  if (typeof s.primaryFrameSha256 !== 'string' || !HEX64.test(s.primaryFrameSha256)) return false;
  const a = s.artifacts as Record<string, unknown> | undefined;
  if (!a || typeof a !== 'object') return false;
  return STEREO_ARTIFACT_IDS.every((id) => isStereoArtifactBundleEntry(a[id]));
}

/** Convenience for the wiring layer: hash a primary delivery file's bytes. */
export function hashArtifactBytes(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

/** Re-exports used by the wiring layer so it never re-derives encodings. */
export { utf8ToBytes, bytesToUtf8 };

// ---------------------------------------------------------------------------
// VIDEO stereo pairs (Spec-Camera-Module-0.13 §8): the periodic pairs the
// module dumps during video recording (pair cadence, never continuous, for
// thermal headroom). What the module actually writes per pair:
//   pairs/pair-%04d-secondary.jpg     (downsampled ~640×480 ultra-wide JPEG)
//   pairs/pair-%04d-calibration.json  (the native calibration shape)
// The per-pair PTS anchors do NOT land in a file — they ride the
// onStereoPairCaptured event ({index, primaryHostSeconds,
// synchronizedDeltaMs}), so they are committed as entry FIELDS, verbatim,
// with nulls stated (a null anchor is what the module reported, never a gap
// the glue invented). Missed pairs carry no index natively (the module
// counts them without consuming a pairIndex) — a missed pair is therefore
// declared by the committed pairsMissed COUNT, printed verbatim desk-side:
// a stated fact, never suspicion, never silently absent.
// ---------------------------------------------------------------------------

export type StereoVideoArtifactId = 'secondaryFrame' | 'calibration';
export const STEREO_VIDEO_ARTIFACT_IDS: readonly StereoVideoArtifactId[] = ['secondaryFrame', 'calibration'];

/** The signed context.stereo-video-* claim ids (binding: the counts AND a
    root over every pair entry's committed states/hashes, so one signed
    claim binds the whole list without 2N claims). */
export const STEREO_VIDEO_CLAIM_IDS = {
  pairsCommitted: 'context.stereo-video-pairs-committed',
  pairsMissed: 'context.stereo-video-pairs-missed',
  hardwareCost: 'context.stereo-video-hardware-cost',
  pairsRoot: 'context.stereo-video-pairs-root',
} as const;

/** PTS anchors from the native onStereoPairCaptured event — verbatim; null
    is the module's own report (non-finite PTS / no delta), stated. */
export interface StereoVideoPairAnchors {
  primaryHostSeconds: number | null;
  synchronizedDeltaMs: number | null;
}

/** One pair at commit time: the event's anchors + the two on-disk artifacts
    in the same three-state input contract as the photo path. */
export interface StereoVideoPairInput {
  pairIndex: number;
  anchors: StereoVideoPairAnchors;
  artifacts: Record<StereoVideoArtifactId, StereoArtifactInput>;
}

/** The committed pair entry in the bundle section. */
export interface StereoVideoPairEntry {
  pairIndex: number;
  anchors: StereoVideoPairAnchors;
  artifacts: Record<StereoVideoArtifactId, StereoArtifactBundleEntry>;
}

export interface VideoStereoBundleSection {
  /** SHA-256 (hex) of the stripped delivery VIDEO file (record.asset.sha256). */
  primaryVideoSha256: string;
  /** Counts committed VERBATIM from the native stop result — never recomputed. */
  pairsCommitted: number;
  pairsMissed: number;
  hardwareCost: number | null;
  /** Ordered committed pair entries (ascending pairIndex, as reported). */
  pairs: StereoVideoPairEntry[];
  /** The context-tree claimIds whose committed VALUES restate the counts + root. */
  contextClaimIds: string[];
  note: string;
}

export const STEREO_VIDEO_BUNDLE_NOTE =
  'Video stereo pairs (Spec-Camera-Module-0.13 §8): periodic synchronized pairs committed during ' +
  'recording. Each pair carries the two artifacts the module writes (secondary frame + calibration) ' +
  'in the same three-state contract as the photo path, plus the PTS anchors from the pair event, ' +
  'verbatim. pairsCommitted / pairsMissed / hardwareCost are the native stop result, restated as ' +
  'signed context.stereo-video-* claims; a missed pair is a declared count. ' +
  'The pairs-root claim binds every entry\'s committed states and hashes.';

function isFiniteOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v));
}

/** Canonical form of the committed pair entries for the pairs-root claim:
    every committed field EXCEPT the inline bytes (the hashes already bind
    them), keys in construction order, pairs in ascending pairIndex. */
export function canonicalVideoPairs(pairs: StereoVideoPairEntry[]): string {
  return JSON.stringify(
    pairs.map((p) => ({
      pairIndex: p.pairIndex,
      anchors: { primaryHostSeconds: p.anchors.primaryHostSeconds, synchronizedDeltaMs: p.anchors.synchronizedDeltaMs },
      artifacts: Object.fromEntries(
        STEREO_VIDEO_ARTIFACT_IDS.map((id) => {
          const e = p.artifacts[id];
          return [
            id,
            e.state === 'recorded'
              ? { state: e.state, sha256: e.sha256, bytes: e.bytes, mime: e.mime }
              : e.state === 'error'
                ? { state: e.state, error: e.error, mime: e.mime }
                : { state: e.state, ...(e.reason ? { reason: e.reason } : {}) },
          ];
        }),
      ),
    })),
  );
}

/**
 * Commit one video capture's periodic stereo pairs. Same fail-closed rule
 * as the photo path: a recorded path without bytes, a null path without its
 * error string, an unknown path value, or a malformed anchor throws — a
 * capture that cannot state a pair must not commit.
 *
 * `counts` is the native stop result (pairsCommitted / pairsMissed /
 * hardwareCost), committed VERBATIM — never recomputed from the pair list
 * (a dropped event stream is itself visible: pairs.length vs pairsCommitted
 * are both committed, and the desk prints both).
 */
export function commitStereoVideoArtifacts(
  pairs: StereoVideoPairInput[],
  counts: { pairsCommitted: number; pairsMissed: number; hardwareCost: number | null },
  primaryVideoSha256: string,
): { section: VideoStereoBundleSection; contextClaims: ContextClaim[] } {
  if (!/^[0-9a-f]{64}$/.test(primaryVideoSha256)) {
    throw new Error('stereoArtifacts: primaryVideoSha256 must be the delivery file\'s SHA-256 (hex)');
  }
  for (const [label, v] of [['pairsCommitted', counts.pairsCommitted], ['pairsMissed', counts.pairsMissed]] as const) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new Error(`stereoArtifacts: ${label} must be a non-negative integer — the native stop result, verbatim`);
    }
  }
  if (!isFiniteOrNull(counts.hardwareCost)) {
    throw new Error('stereoArtifacts: hardwareCost must be a finite number or null — the native stop result, verbatim');
  }

  const sorted = [...pairs].sort((a, b) => a.pairIndex - b.pairIndex);
  const entries: StereoVideoPairEntry[] = sorted.map((p) => {
    if (!Number.isInteger(p.pairIndex) || p.pairIndex < 0) {
      throw new Error(`stereoArtifacts: pairIndex '${String(p.pairIndex)}' is not a non-negative integer`);
    }
    if (!isFiniteOrNull(p.anchors?.primaryHostSeconds) || !isFiniteOrNull(p.anchors?.synchronizedDeltaMs)) {
      throw new Error(`stereoArtifacts: pair ${p.pairIndex} anchors must be finite numbers or null — the event values, verbatim`);
    }
    const artifacts = {} as Record<StereoVideoArtifactId, StereoArtifactBundleEntry>;
    for (const id of STEREO_VIDEO_ARTIFACT_IDS) {
      const input = p.artifacts?.[id];
      if (!input || typeof input !== 'object') {
        throw new Error(`stereoArtifacts: pair ${p.pairIndex} artifact '${id}' is missing — every artifact reports a state, always`);
      }
      if (typeof input.path === 'string' && input.path !== 'never-recorded') {
        if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
          throw new Error(`stereoArtifacts: pair ${p.pairIndex} artifact '${id}' reports a recorded path but carries no bytes — no silent absence`);
        }
        artifacts[id] = {
          state: 'recorded',
          sha256: bytesToHex(sha256(input.bytes)),
          bytes: input.bytes.length,
          mime: ARTIFACT_MIME[id],
          // Pair secondaries (~200 KB) and calibrations are small: inline.
          dataBase64: bytesToBase64(input.bytes),
        };
      } else if (input.path === null) {
        if (typeof input.error !== 'string' || input.error.length === 0) {
          throw new Error(`stereoArtifacts: pair ${p.pairIndex} artifact '${id}' is null (enabled-but-failed) but carries no error string — the failure must be stated`);
        }
        artifacts[id] = { state: 'error', error: input.error.slice(0, MAX_ERROR_CHARS), mime: ARTIFACT_MIME[id] };
      } else if (input.path === 'never-recorded') {
        artifacts[id] = { state: 'never-recorded', ...(input.reason ? { reason: input.reason } : {}) };
      } else {
        throw new Error(`stereoArtifacts: pair ${p.pairIndex} artifact '${id}' path is '${String(input.path)}' — not a three-state EvidencePath`);
      }
    }
    return { pairIndex: p.pairIndex, anchors: { ...p.anchors }, artifacts };
  });

  const pairsRoot = bytesToHex(sha256(utf8ToBytes(canonicalVideoPairs(entries))));
  const contextClaims: ContextClaim[] = [
    { claimId: STEREO_VIDEO_CLAIM_IDS.pairsCommitted, family: 'context', rung: 0, value: String(counts.pairsCommitted) },
    { claimId: STEREO_VIDEO_CLAIM_IDS.pairsMissed, family: 'context', rung: 0, value: String(counts.pairsMissed) },
    {
      claimId: STEREO_VIDEO_CLAIM_IDS.hardwareCost,
      family: 'context',
      rung: 0,
      value: counts.hardwareCost === null ? 'not-reported' : String(counts.hardwareCost),
    },
    { claimId: STEREO_VIDEO_CLAIM_IDS.pairsRoot, family: 'context', rung: 0, value: `sha256:${pairsRoot}` },
  ];

  return {
    section: {
      primaryVideoSha256,
      pairsCommitted: counts.pairsCommitted,
      pairsMissed: counts.pairsMissed,
      hardwareCost: counts.hardwareCost,
      pairs: entries,
      contextClaimIds: Object.values(STEREO_VIDEO_CLAIM_IDS),
      note: STEREO_VIDEO_BUNDLE_NOTE,
    },
    contextClaims,
  };
}

/** Per-pair integrity — the same committed-hash-vs-embedded-bytes rule as
    the photo section, keyed by pairIndex so a tamper NAMES its pair. */
export function checkVideoStereoSectionIntegrity(
  section: VideoStereoBundleSection,
): Array<{ pairIndex: number; results: Record<StereoVideoArtifactId, StereoIntegrityResult> }> {
  return section.pairs.map((p) => {
    const results = {} as Record<StereoVideoArtifactId, StereoIntegrityResult>;
    for (const id of STEREO_VIDEO_ARTIFACT_IDS) {
      const e = p.artifacts[id];
      results[id] = !e
        ? { integrity: 'PROVEN-TAMPER', detail: `pair ${p.pairIndex} entry for '${id}' is missing — the commit path accounts for every artifact; this section was altered` }
        : stereoEntryIntegrity(id, e);
    }
    return { pairIndex: p.pairIndex, results };
  });
}

/**
 * The StereoCommitment for ONE video pair — the desk's planarity signal runs
 * per pair. Same mirrored shape as the photo commitment EXCEPT metadataBlock
 * is absent: the module commits no per-pair metadata block, so the distance
 * gate weighs the disparity cue alone (stated in the signal text).
 * Throws — stated, never patched over — when the pair's secondary or
 * calibration is not recorded, when integrity fails, or when the sync delta
 * anchor is null (the pair's own report).
 */
export function buildStereoVideoPairCommitment(
  section: VideoStereoBundleSection,
  pairIndex: number,
): StereoCommitmentShape {
  const pair = section.pairs.find((p) => p.pairIndex === pairIndex);
  if (!pair) {
    throw new Error(`video pair ${pairIndex} is not in the section — the committed pairs are ${section.pairs.map((p) => p.pairIndex).join(', ') || '(none)'}`);
  }
  for (const id of STEREO_VIDEO_ARTIFACT_IDS) {
    const state = pair.artifacts[id]?.state;
    if (state !== 'recorded') {
      throw new Error(`stereo commitment cannot be built for pair ${pairIndex}: artifact '${id}' is ${state ?? 'absent'}`);
    }
  }
  const integrity = checkVideoStereoSectionIntegrity(section).find((r) => r.pairIndex === pairIndex)!;
  const tampered = STEREO_VIDEO_ARTIFACT_IDS.filter((id) => integrity.results[id].integrity === 'PROVEN-TAMPER');
  if (tampered.length > 0) {
    throw new Error(`stereo commitment refused for pair ${pairIndex}: PROVEN TAMPER on ${tampered.join(', ')} — embedded bytes do not match the committed hash`);
  }
  if (pair.anchors.synchronizedDeltaMs === null) {
    throw new Error(`stereo commitment cannot be built for pair ${pairIndex}: the pair event reported no sync delta — a stated gap, never a number to invent`);
  }
  const calibration = parseStereoCalibration(bytesToUtf8(stereoEntryBytes(pair.artifacts.calibration, 'calibration')));
  return {
    primaryFrameHash: `sha256:${section.primaryVideoSha256}`,
    secondaryFrame: { bytes: stereoEntryBytes(pair.artifacts.secondaryFrame, 'secondaryFrame') },
    calibration: {
      intrinsicsWide: calibration.intrinsicsWide,
      intrinsicsUltraWide: calibration.intrinsicsUltraWide,
      extrinsics: {
        rotation: calibration.extrinsics.rotation,
        translationM: calibration.extrinsics.translationM,
      },
      ...(calibration.distortionLut ? { distortionLut: calibration.distortionLut } : {}),
    },
    syncTimestampDeltaMs: pair.anchors.synchronizedDeltaMs,
    // No per-pair metadata block exists — the module commits none for pairs.
  };
}

export function isVideoStereoBundleSection(x: unknown): x is VideoStereoBundleSection {
  if (typeof x !== 'object' || x === null) return false;
  const s = x as Record<string, unknown>;
  if (typeof s.primaryVideoSha256 !== 'string' || !HEX64.test(s.primaryVideoSha256)) return false;
  if (typeof s.pairsCommitted !== 'number' || !Number.isInteger(s.pairsCommitted) || s.pairsCommitted < 0) return false;
  if (typeof s.pairsMissed !== 'number' || !Number.isInteger(s.pairsMissed) || s.pairsMissed < 0) return false;
  if (!isFiniteOrNull(s.hardwareCost)) return false;
  if (!Array.isArray(s.pairs)) return false;
  return s.pairs.every((p) => {
    if (typeof p !== 'object' || p === null) return false;
    const e = p as Record<string, unknown>;
    if (!Number.isInteger(e.pairIndex) || (e.pairIndex as number) < 0) return false;
    const a = e.anchors as Record<string, unknown> | undefined;
    if (!a || !isFiniteOrNull(a.primaryHostSeconds) || !isFiniteOrNull(a.synchronizedDeltaMs)) return false;
    const arts = e.artifacts as Record<string, unknown> | undefined;
    if (!arts || typeof arts !== 'object') return false;
    return STEREO_VIDEO_ARTIFACT_IDS.every((id) => isStereoArtifactBundleEntry(arts[id]));
  });
}
