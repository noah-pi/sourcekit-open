// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Attestation orchestration: media file → signed media file + record.
 *
 * Photos (JPEG): a genuine C2PA manifest (Content Credentials) is embedded
 *                into the file itself as an APP11/JUMBF store — CBOR claim,
 *                c2pa.hash.data hard binding, COSE_Sign1 signature with the
 *                device certificate. The full Source Kit record rides inside as
 *                the com.verify.telemetry assertion. Recognized by any
 *                third-party C2PA verifier.
 * Video (MP4):   the same manifest embedded as a C2PA uuid box after ftyp,
 *                hard-bound by c2pa.hash.bmff.v2, with stco/co64 chunk
 *                offsets repaired so playback is untouched. Fragmented or
 *                otherwise out-of-scope containers degrade honestly to the
 *                sidecar attestation rather than failing the capture.
 */

import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { decode as jpegDecode } from 'jpeg-js';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import {
  buildRecord,
  CAPTURE_INTEGRITY_LABEL,
  CONTEXT_TREE_LABEL,
  POSE_TRACE_LABEL,
  STREAMED_CHUNKS_V2_LABEL,
  type AttestationRecord,
  type CaptureEvidencePaths,
  type CaptureIntegrityAssertion,
  type PoseTraceAssertion,
  type SensorContext,
  type StreamedChunksAssertionV2,
  type StreamedChunksTrackId,
  type TrackChunkMap,
} from './manifest';
import { sealCaptureDisclosure, type SealedCaptureDisclosure } from '../disclosure/captureCommit';
import type { ContextClaim } from '../disclosure/inventory';
import { buildPoseTraceAssertion } from './poseTrace';
import { buildStreamedChunksV2, buildStreamedChunksV2ForStill } from './trackChunks';
import { stripManifest, stripMetadata } from '../c2pa/jpegApp11';
import { buildC2paSegment, buildC2paStoreBmff, buildC2paStorePng, bmffHashAssertionCbor, bmffMandatoryExclusions, hashBmffV2, type C2paManifestParams, type TranscriptAssertion } from '../c2pa/c2pa';
import { C2PA_UUID_BYTES, embedUuidStore, stripC2paFromBmff } from '../c2pa/bmff';
import { embedCaBx, iendOffset, stripCaBx } from '../c2pa/png';
import { signRecord, sha256Hex } from '../lib/sign';
import { pqClaimSigner, pqPublicBlock, type PqCaptureKey } from '../lib/pq';
import { getDeviceCertChain, type DeviceSigner } from '../lib/deviceKey';
import { buildSelfSignedCert } from '../lib/cert';
import type { DeviceIntegritySignals } from '../lib/integrity';
import { fetchTimestampTokensBounded, estimatedTsaTokenSizes } from '../lib/timestamp';
import type { BeaconCommitment } from '../lib/beacon';
import { getAttestationAssertion } from '../lib/appAttest';
import { bytesToBase64, bytesToHex, base64ToBytes, concatBytes, utf8ToBytes } from '../lib/bytes';
import { readFileBytes } from '../lib/fileHash';
import { pHashFromGray32 } from '../lib/phash';
import { logDiagnostic } from '../lib/diagnosticsLog';
// Type-only: the native capture contract (D1 depth fields). Erased at
// runtime — this module never loads the camera module's expo glue.
import type { CaptureResult, DepthArtifactMetadata, EvidencePath as CameraEvidencePath } from '../lib/exhibitCamera';

/**
 * The standard-assertion set (C2–C5) one call site hands to the
 * embed layer. Everything here is FAIL-CLOSED PER ASSERTION: whichever
 * compute failed is simply absent (and logged), the seal continues.
 */
interface StandardAssertions {
  /** C5: claim thumbnail, ≤512px JPEG (photos + video). */
  thumbnailJpeg?: Uint8Array | null;
  /** C3: the capture-time pHash, 16 hex chars → c2pa.soft-binding (photos). */
  phashHex?: string | null;
  /** D1: GDepth depthmap assertion payload (photos, when depth recorded). */
  depthmap?: {
    data: Uint8Array;
    mime: 'image/jpeg' | 'image/png';
    format: 'RangeInverse' | 'RangeLinear';
    near: number;
    far: number;
    units?: 'm' | 'mm' | null;
    measureType?: 'OpticalAxis' | 'OpticRay' | null;
    confidence?: { data: Uint8Array; mime: string } | null;
    manufacturer?: string | null;
    model?: string | null;
    software?: string | null;
    imageWidth?: number | null;
    imageHeight?: number | null;
  } | null;
  /** D1: the sealed artifact set → c2pa.hash.collection.data (photos, when depth recorded). */
  collectionAssets?: { uri: string; bytes: Uint8Array; dcFormat?: string | null }[] | null;
  /** secondary viewpoint → c2pa.ingredient.v3 + ingredient thumbnail (photos, when a secondary frame exists). */
  secondaryView?: {
    thumbnailJpeg: Uint8Array;
    fullResSha256: string;
    width?: number | null;
    height?: number | null;
  } | null;
}

/**
 * The upstream-resolved depth artifact for THIS capture: the
 * CaptureResult's depth EvidencePath plus its committed sha256/metadata.
 * The bytes live on disk (like every stereo artifact) — attest reads them,
 * verifies the committed hash once (trust-but-verify: one sha256 call keeps
 * the committed hash honest), and seals the claims. An EvidencePath in
 * 'never-recorded' state is a SIGNED statement of absence, verbatim reason.
 */
export interface DepthCommitInput {
  artifact: CameraEvidencePath;
  /** ABSENT (undefined) on some native early-exit branches = "not
   * committed this capture" — the artifact is then not committed here
   * either (no fabrication). */
  sha256?: string | null;
  metadata?: DepthArtifactMetadata | null;
}

/**
 * Resolves the depth artifact to commit from a CaptureResult (D1): the
 * full-res path's PRIMARY map first, the degraded path's `depth` as
 * fallback. The secondary map is NOT committed this pass — one
 * c2pa.depthmap per claim, and the collection is {photo, primary depth}.
 * Returns null when no depth field exists at all (pre-D1 native build).
 */
export function resolveDepthSealInput(result: CaptureResult): DepthCommitInput | null {
  if (result.fullResStillDepth !== undefined) {
    return { artifact: result.fullResStillDepth, sha256: result.fullResStillDepthSha256 ?? null, metadata: result.fullResStillDepthMetadata ?? null };
  }
  if (result.depth !== undefined) {
    return { artifact: result.depth, sha256: result.depthSha256 ?? null, metadata: result.depthMetadata ?? null };
  }
  return null;
}

/**
 * The upstream-resolved secondary viewpoint for THIS capture: the
 * CaptureResult's full-res ultra-wide EvidencePath plus its committed sha256
 * and dimensions. Same discipline as depth — attest reads the bytes,
 * verifies the committed hash once (trust-but-verify), and seals BOTH a
 * 512px embedded thumbnail (a lead) and the full-res data hash (the
 * measurement) as a componentOf ingredient. A 'never-recorded'/'error'
 * state simply produces no ingredient: absence is neutral, and the
 * three-state reason already rides the stereo artifact claims.
 */
export interface SecondaryCommitInput {
  artifact: CameraEvidencePath;
  /** ABSENT (undefined) on some native early-exit branches = "not
   * committed this capture" — no ingredient is emitted (no fabrication). */
  sha256?: string | null;
  dimensions?: { width: number; height: number } | null;
}

/**
 * Resolves the secondary viewpoint to commit from a CaptureResult.
 * Returns null when no secondary field exists at all (pre-native
 * build, or a session with the secondary camera off).
 */
export function resolveSecondarySealInput(result: CaptureResult): SecondaryCommitInput | null {
  if (result.fullResSecondary !== undefined) {
    return {
      artifact: result.fullResSecondary,
      sha256: result.fullResSecondarySha256 ?? null,
      dimensions: result.fullResSecondaryDimensions ?? null,
    };
  }
  return null;
}

export interface AttestResult {
  /** Signed JPEG bytes (photo). */
  signedPhotoBytes?: Uint8Array;
  /** MP4/MOV bytes with the C2PA manifest embedded (video), when the container is in scope. */
  signedVideoBytes?: Uint8Array;
  /** M4A bytes with the C2PA manifest embedded, when the container is in scope. */
  signedAudioBytes?: Uint8Array;
  record: AttestationRecord;
  /**
   * WS2 Phase 2 (§4): the disclosure commitment state for the vault store
   * — Sealed-profile bundle + master seed. VAULT-ONLY: the seed never
   * rides in the manifest or any export. sealQueue persists it via
   * src/disclosure/burn.ts.
   */
  disclosure?: SealedCaptureDisclosure | null;
  /**
   * WS2 Phase 2 (§1): the per-track chunk maps behind the
   * com.verify.streamedChunks v2 assertion (video/audio) — the vault
   * record's copy, exported later as the proof-bundle sidecar.
   */
  chunkMaps?: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> | null;
}

function deviceModel(): string | null {
  return Device.modelName ?? Device.modelId ?? null;
}

// ---------------------------------------------------------------------------
// WS2 Phase 2: commit-at-capture + unified media assertions (SPEC-WS2-Phase2)
//
// THE PARITY PRINCIPLE: the SAME assertion set rides photo, video, and audio
// seals — com.verify.contextTree, com.verify.streamedChunks,
// com.verify.poseTrace (whenever an IMU trace exists), and
// com.verify.captureIntegrity. The ONLY divergences by media kind are the
// named exceptions (docs/MEDIA-PARITY.md — the canonical list): stills
// have no ENF trace and no streamed chunks
// beyond the zero-track structural assertion; audio has no ring-buffer
// frames and no A/V desync; photos have no A/V desync. The audio recorder
// now logs gyro during every take (modules/audio-capture IMU sink), so
// audio poseTrace is absent ONLY when the device could not provide motion
// data — stated three-state in the record's captureEvidence. Anything
// else is a bug.
// ---------------------------------------------------------------------------

/** The capture-evidence toggle snapshot, when a CaptureKit session ran (else null). */
export interface EvidenceEnabledSnapshot {
  ring: boolean;
  rawPcm: boolean;
  sensors: boolean;
}

/**
 * evidenceComplete, derived from the three-state evidence paths (E.04):
 * complete = no APPLICABLE sink is in the enabled-but-failed (null) state.
 * 'never-recorded' sinks (toggle off or structural) do not make a capture
 * incomplete. Applicability is the named exception set: the ring is a
 * stills sink, raw PCM applies to video sessions and audio takes,
 * the sensor log applies to every CaptureKit kind. null = no CaptureKit
 * session ran (fallback path).
 */
export function evidenceCompleteFor(
  kind: 'photo' | 'video' | 'audio',
  evidence: CaptureEvidencePaths | null | undefined
): boolean | null {
  if (!evidence) return null;
  const applicable =
    kind === 'photo'
      ? [evidence.ringBufferDir, evidence.sensorLogPath]
      : [evidence.rawPcmPath, evidence.sensorLogPath];
  return !applicable.some((p) => p === null);
}

/**
 * The disclosure commit (com.verify.contextTree): builds the context-claim
 * set from the record's own evidence and commits it under a fresh master
 * seed. The Sealed-profile bundle + seed come back for the vault store;
 * only the inventory assertion (root + states, no values) enters the
 * manifest.
 */
function commitContextTree(record: AttestationRecord, stereoClaims?: ContextClaim[] | null): SealedCaptureDisclosure {
  const loc = record.context.location;
  return sealCaptureDisclosure(randomBytes(32), {
    capturedAt: record.capturedAt,
    location: loc && typeof loc === 'object' ? { lat: loc.lat, lon: loc.lon } : loc === 'redacted' || loc === 'unavailable' ? loc : null,
    identity: record.identity,
    fingerprint: record.signer.fingerprint,
    // Stereo-capture artifact claims (Spec-Camera-Module-0.13): pre-built by
    // commitStereoArtifacts from the CaptureResult handoff — hash/error/
    // never-recorded states committed as context.stereo-* claim values.
    ...(stereoClaims?.length ? { stereoClaims } : {}),
    // The claim is documented as "whether a sensor log
    // was recorded" — it must reflect ACTUAL CaptureKit sensor-log presence
    // only. A motion verdict or poseTrace derived from other paths must not
    // inflate it into 'true'. The EvidencePath third state is the STRING
    // literal 'never-recorded' (no sink was opened), so the typeof-string
    // check alone would wrongly match it — exclude the sentinel explicitly.
    sensorLogRecorded:
      typeof record.context.captureEvidence?.sensorLogPath === 'string' &&
      record.context.captureEvidence.sensorLogPath !== 'never-recorded',
    motionVerdict: record.context.motion?.verdict ?? null,
  });
}

export interface Phase2AssertionSet {
  customAssertions: { label: string; data: unknown }[];
  disclosure: SealedCaptureDisclosure;
  /** The poseTrace assertion, when an IMU trace existed (honest absence otherwise). */
  poseTrace: PoseTraceAssertion | null;
  /** The v2 streamedChunks assertion (delivery-file binding), when built. */
  streamedChunksV2: StreamedChunksAssertionV2 | null;
  chunkMaps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> | null;
}

/**
 * Assemble the parity assertion set for a capture seal. `streamedV2` is
 * computed by the caller from the delivery bytes (media-specific: demux
 * for BMFF kinds, the zero-track structural assertion for stills).
 */
function phase2Assertions(params: {
  record: AttestationRecord;
  kind: 'photo' | 'video' | 'audio';
  streamedV2: StreamedChunksAssertionV2 | null;
  chunkMaps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> | null;
  /** Raw CaptureKit sensor JSONL, when the sink produced one. */
  sensorLogText?: string | null;
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
  /** Stereo-artifact context claims (commitStereoArtifacts) — when the stereo module ran. */
  stereoClaims?: ContextClaim[] | null;
}): Phase2AssertionSet {
  const { record, kind } = params;
  const disclosure = commitContextTree(record, params.stereoClaims);
  const poseTrace = params.sensorLogText ? buildPoseTraceAssertion(params.sensorLogText) : null;
  const captureIntegrity: CaptureIntegrityAssertion = {
    label: CAPTURE_INTEGRITY_LABEL,
    v: 1,
    evidenceEnabled: params.evidenceEnabled ?? null,
    evidenceComplete: evidenceCompleteFor(kind, record.context.captureEvidence),
    biometricGatePassed: record.captureIntegrity?.biometricGatePassed ?? null,
    captureToSignatureMs: record.captureIntegrity?.captureToSignatureMs ?? 0,
    note: 'self-reported',
  };
  const customAssertions: { label: string; data: unknown }[] = [
    { label: CONTEXT_TREE_LABEL, data: disclosure.inventoryAssertion },
    { label: CAPTURE_INTEGRITY_LABEL, data: captureIntegrity },
  ];
  if (params.streamedV2) {
    customAssertions.splice(1, 0, { label: STREAMED_CHUNKS_V2_LABEL, data: params.streamedV2 });
  }
  if (poseTrace) {
    customAssertions.splice(customAssertions.length - 1, 0, { label: POSE_TRACE_LABEL, data: poseTrace });
  }
  return {
    customAssertions,
    disclosure,
    poseTrace,
    streamedChunksV2: params.streamedV2,
    chunkMaps: params.chunkMaps,
  };
}

function appVersion(): string {
  return Constants.expoConfig?.version ?? '0.1.0';
}

/**
 * The ≤512px claim thumbnail. Same recipe the
 * vault grid uses — ImageManipulator from the still-on-disk draft, lossy
 * JPEG. A failure omits the assertion (logged) — never a failed seal.
 */
async function photoThumbnailJpeg(photoUri: string): Promise<Uint8Array | null> {
  try {
    const thumb = await ImageManipulator.manipulateAsync(photoUri, [{ resize: { width: 512 } }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!thumb.base64) throw new Error('thumbnail encode returned no data');
    return base64ToBytes(thumb.base64);
  } catch (e) {
    logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `c2pa.thumbnail.claim.jpeg omitted: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
}

/**
 * The capture-time pHash, computed PRE-SIGNING so
 * the c2pa.soft-binding lands under the COSE claim signature — the hoist
 * of what vaultFs used to compute only post-embed (its copy is now a
 * cross-check). 32×32 luma → pHashFromGray32, same recipe as the vault.
 */
async function photoPhashHex(photoUri: string): Promise<string | null> {
  try {
    const tiny = await ImageManipulator.manipulateAsync(photoUri, [{ resize: { width: 32, height: 32 } }], {
      compress: 0.9,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!tiny.base64) throw new Error('32×32 encode returned no data');
    // 32×32 RGBA is 4 KB of output — 1 MB of decode headroom is generous.
    // useTArray: jpeg-js otherwise allocates `data` via Buffer.alloc, which
    // does not exist under Hermes — this was the "Property 'Buffer' doesn't
    // exist" soft-binding omission on device.
    const decoded = jpegDecode(base64ToBytes(tiny.base64), { maxMemoryUsageInMB: 1, useTArray: true });
    if (decoded.width !== 32 || decoded.height !== 32) {
      throw new Error(`32×32 decode returned ${decoded.width}×${decoded.height}`);
    }
    const rgba = decoded.data;
    const gray = new Uint8Array(32 * 32);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      // ITU-R 601 luma — what the reference pHash implementations use.
      gray[i] = Math.round(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114);
    }
    return pHashFromGray32(gray);
  } catch (e) {
    logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `c2pa.soft-binding omitted: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
}

/**
 * a frame ~0.5 s in, resized to ≤512px JPEG — the
 * same source the vault grid thumbnail uses. Best-effort: the manifest
 * simply ships without a claim thumbnail when the frame can't be read.
 */
async function videoThumbnailJpeg(videoUri: string): Promise<Uint8Array | null> {
  let frameUri: string | null = null;
  try {
    const frame = await VideoThumbnails.getThumbnailAsync(videoUri, { time: 500 });
    frameUri = frame.uri;
    const thumb = await ImageManipulator.manipulateAsync(frame.uri, [{ resize: { width: 512 } }], {
      compress: 0.7,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!thumb.base64) throw new Error('thumbnail encode returned no data');
    return base64ToBytes(thumb.base64);
  } catch (e) {
    logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'failed', message: `c2pa.thumbnail.claim.jpeg omitted: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  } finally {
    if (frameUri) await FileSystem.deleteAsync(frameUri, { idempotent: true }).catch(() => {});
  }
}

export async function attestPhoto(params: {
  photoUri: string;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  capturedAt?: string;
  /** Assignment-mode label + cert chain — signs outside the device identity. */
  assignmentLabel?: string | null;
  certChainOverride?: Uint8Array[];
  /** Device integrity signals, signed as a self-reported assertion. */
  integritySignals?: DeviceIntegritySignals | null;
  /** Sanitized camera EXIF (src/lib/exif.ts) — signed as com.verify.exif. */
  exif?: Record<string, number | string> | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts) — signed time lower bound. */
  beacon?: BeaconCommitment | null;
  /** PQ dual-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /**
   * Face check outcome — the boolean result of the OS biometric
   * check run at capture start when the toggle is on; null/absent when the
   * toggle was off. The flag ONLY: no face geometry or template exists.
   */
  biometricGatePassed?: boolean | null;
  /** Raw CaptureKit sensor JSONL (WS2 Phase 2 §3) — committed as com.verify.poseTrace. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot (WS2 Phase 2 §2) — when CaptureKit ran. */
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
  /**
   * Capture-result context claims (Spec-Camera-Module-0.13 + W2.1/W2.4):
   * built by commitStereoArtifacts from the CaptureResult's three-state
   * artifact paths (context.stereo-*) plus sealQueue's full-res extras
   * (context.fullres-still / context.fullres-secondary /
   * context.capture-settings); committed into this capture's signed context
   * tree. captureCommit admits exactly those claim IDs — anything else
   * throws, fail-closed. Absent when no stereo module ran.
   */
  stereoClaims?: ContextClaim[] | null;
  /** D1: the resolved depth artifact — see DepthCommitInput. */
  depth?: DepthCommitInput | null;
  /** the resolved secondary viewpoint — see SecondaryCommitInput. */
  secondary?: SecondaryCommitInput | null;
}): Promise<AttestResult> {
  const cleanBytes = await readFileBytes(params.photoUri);
  // Defense in depth: a camera file should never carry a manifest, but if it
  // does (re-attesting a signed photo), we sign the clean bytes only.
  const stripped = stripManifest(cleanBytes);

  const record = buildRecord({
    assetSha256: sha256Hex(stripped),
    assetBytes: stripped.length,
    mime: 'image/jpeg',
    kind: 'photo',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: deviceModel(),
    platform: Platform.OS,
    identity: params.identity,
    context: params.context,
    publicKeyBase64: params.key.publicKeyBase64,
    fingerprint: params.key.fingerprint,
  });

  record.assignment = params.assignmentLabel ? { label: params.assignmentLabel } : null;
  record.deviceIntegrity = params.integritySignals ?? null;
  // Capture-integrity signals — self-reported, signed, bounded.
  record.captureIntegrity = {
    captureToSignatureMs: Math.max(0, Date.now() - Date.parse(record.capturedAt)),
    sensorTiming: params.context.sensorTiming ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    note: 'self-reported' as const,
  };
  // Time lower bound from the cached beacon — whatever tip is cached
  // right now, fresh or stale; never fetched here (that would couple a network
  // event to the shutter). Absent, not fabricated, when nothing is cached.
  record.beacon = params.beacon ?? null;
  // An assignment-signed capture carries no org credential — the org chain
  // belongs to the device key, and attaching it would re-link the assignment.
  record.orgCredential = params.certChainOverride ? null : await orgCredentialForRecord();
  if (params.key.biometricBound) record.biometricBound = true;
  // The PQ public key is committed INSIDE the signed payload —
  // the binding that makes the dual signature meaningful (src/lib/pq.ts).
  record.pqKey = params.pq ? pqPublicBlock(params.pq.publicKey, params.pq.enrolledAt) : null;
  // WS2 Phase 2: the parity assertion set. Stills commit the zero-track
  // streamedChunks assertion (structural — a JPEG has no elementary
  // streams; the hard binding covers the file byte-for-byte). This is the
  // named stills exception — docs/MEDIA-PARITY.md.
  const phase2 = phase2Assertions({
    record,
    kind: 'photo',
    streamedV2: buildStreamedChunksV2ForStill(),
    chunkMaps: null,
    sensorLogText: params.sensorLogText ?? null,
    evidenceEnabled: params.evidenceEnabled ?? null,
    stereoClaims: params.stereoClaims ?? null,
  });
  // D1: the depth artifact. 'never-recorded'/'error'
  // is a SIGNED statement of absence (verbatim reason — no fabrication);
  // 'path' reads the bytes from disk, verifies the committed sha256 once
  // (trust-but-verify), then commits c2pa.depthmap.GDepth (the map's
  // normalization window IS GDepth's required Near/Far) and seals set
  // membership (photo + depth map) via c2pa.hash.collection.data.
  // Fail-closed like C3/C5: any gap omits the assertions + logs — seal on.
  const depthStd: Pick<StandardAssertions, 'depthmap' | 'collectionAssets'> = { depthmap: null, collectionAssets: null };
  if (params.depth) {
    const ep = params.depth.artifact;
    if (ep.state === 'never-recorded') {
      record.context.depth = { recorded: false, reason: ep.reason };
    } else if (ep.state === 'error') {
      record.context.depth = { recorded: false, reason: `${ep.code}: ${ep.message}` };
    } else {
      try {
        const md = params.depth.metadata;
        const claimedSha = params.depth.sha256;
        if (!claimedSha) throw new Error('no committed sha256 on this branch — not committing');
        if (!md) throw new Error('no depth metadata committed');
        const uri = ep.path.startsWith('file://') ? ep.path : `file://${ep.path}`;
        const bytes = await readFileBytes(uri);
        // Cross-check the artifact's committed hash against the exact bytes
        // on disk — a mislabeled artifact is omitted, never trusted.
        const actualSha = sha256Hex(bytes);
        if (actualSha !== claimedSha.toLowerCase()) {
          throw new Error(`artifact sha256 mismatch (claimed ${claimedSha}, actual ${actualSha})`);
        }
        record.context.depth = {
          recorded: true,
          mime: md.mime,
          width: md.width,
          height: md.height,
          semantics: md.mapSemantics,
          sha256: actualSha,
          normalizationMin: md.normalizationMin,
          normalizationMax: md.normalizationMax,
          photoWidth: md.photoWidth,
          photoHeight: md.photoHeight,
        };
        depthStd.depthmap = {
          data: bytes,
          mime: md.mime,
          // disparity maps ARE inverse-depth encodings → RangeInverse.
          format: md.mapSemantics === 'disparity' ? 'RangeInverse' : 'RangeLinear',
          // The min/max normalization window is the encoding's value
          // bounds — exactly what GDepth's required Near/Far describe.
          // Units/MeasureType stay ABSENT: the capture side didn't state
          // them, and this layer never fabricates.
          near: md.normalizationMin,
          far: md.normalizationMax,
          manufacturer: Device.manufacturer,
          model: deviceModel(),
          software: `ExhibitA ${appVersion()}`,
          imageWidth: md.photoWidth,
          imageHeight: md.photoHeight,
        };
        depthStd.collectionAssets = [
          // The photo member hashes the CLEAN bytes: the signed file contains
          // this very manifest, so hashing it would be circular — verifiers
          // reconstruct clean bytes via the hash.data exclusion.
          { uri: 'photo.jpg', bytes: stripped, dcFormat: 'image/jpeg' },
          { uri: 'depth.png', bytes, dcFormat: md.mime },
        ];
      } catch (e) {
        logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `depth assertions omitted: ${e instanceof Error ? e.message : String(e)}` });
        delete record.context.depth; // the signed statement stands only when the artifact verified
        depthStd.depthmap = null;
        depthStd.collectionAssets = null;
      }
    }
  }
  // The secondary viewpoint as a componentOf ingredient. Same
  // discipline as depth: 'path' reads the bytes, verifies the committed
  // sha256 once (trust-but-verify), then commits BOTH the embedded 512px
  // thumbnail (a lead) and the full-res data hash (the measurement — those
  // bytes stay in the vault). 'never-recorded'/'error' produces NO
  // ingredient: absence is neutral, and the reason already rides the stereo
  // artifact claims. Fail-closed per assertion: any gap omits + logs, seal on.
  let secondaryStd: StandardAssertions['secondaryView'] = null;
  if (params.secondary && params.secondary.artifact.state === 'path') {
    try {
      const ep = params.secondary.artifact;
      const claimedSha = params.secondary.sha256;
      if (!claimedSha) throw new Error('no committed sha256 on this branch — not committing');
      const uri = ep.path.startsWith('file://') ? ep.path : `file://${ep.path}`;
      const bytes = await readFileBytes(uri);
      const actualSha = sha256Hex(bytes);
      if (actualSha !== claimedSha.toLowerCase()) {
        throw new Error(`secondary sha256 mismatch (claimed ${claimedSha}, actual ${actualSha})`);
      }
      const thumbnailJpeg = await photoThumbnailJpeg(uri);
      if (!thumbnailJpeg || thumbnailJpeg.length === 0) {
        throw new Error('secondary thumbnail encode failed');
      }
      secondaryStd = {
        thumbnailJpeg,
        fullResSha256: actualSha,
        width: params.secondary.dimensions?.width ?? null,
        height: params.secondary.dimensions?.height ?? null,
      };
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `secondary ingredient omitted: ${e instanceof Error ? e.message : String(e)}` });
      secondaryStd = null;
    }
  }
  const signedRecord = await signRecord(record, params.key.signDigest, params.key.signPayload, params.pq);
  // PHash + claim thumbnail, computed pre-signing so both
  // land under the COSE claim signature. Each is independently fail-closed.
  const standard: StandardAssertions = {
    thumbnailJpeg: await photoThumbnailJpeg(params.photoUri),
    phashHex: await photoPhashHex(params.photoUri),
    ...depthStd,
    secondaryView: secondaryStd,
  };
  const signedPhotoBytes = await embedC2paInJpeg(stripped, signedRecord, params.key, params.certChainOverride, params.exif, params.pq, phase2.customAssertions, standard);
  return { signedPhotoBytes, record: signedRecord, disclosure: phase2.disclosure, chunkMaps: null };
}

/**
 * Embeds a signed record into clean JPEG bytes as a genuine C2PA manifest:
 * the record travels as the com.verify.telemetry JSON assertion, hard-bound
 * to the media by c2pa.hash.data and the COSE signature — countersigned by
 * an RFC 3161 timestamp authority when the network allows. The x5chain is
 * the org credential chain when installed, else the self-signed device cert.
 */
/**
 * The org identity assertion is emitted exactly when an org credential rides the
 * COSE chain (length > 1) and the record carries the org block. deID copies
 * (ephemeral chain, orgCredential stripped) and personal/assignment captures
 * simply have no assertion — absence is neutral, never a strip.
 */
function identityAssertionFor(chain: Uint8Array[], record: AttestationRecord): { org: string; role: string } | null {
  if (chain.length < 2 || !record.orgCredential) return null;
  // Issuer ONLY — it is the top cert's subject name by construction, which is
  // exactly what verifyChain surfaces as topSubject. A subject fallback would
  // name the leaf and guarantee a false mismatch at verification.
  return { org: record.orgCredential.issuer ?? 'organization', role: 'organization' };
}

async function embedC2paInJpeg(stripped: Uint8Array, signedRecord: AttestationRecord, key: DeviceSigner, certChainOverride?: Uint8Array[], exif?: Record<string, number | string> | null, pq?: PqCaptureKey | null, customAssertions?: { label: string; data: unknown }[] | null, standard?: StandardAssertions | null): Promise<Uint8Array> {
  const chain = certChainOverride ?? (await getDeviceCertChain()).chain;
  const instanceId = 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const insertOffset = 2; // C2PA convention: APP11 immediately after SOI
  const segment = await buildC2paSegment(
    {
      appName: `Source Kit/${appVersion()} (com.verify.camera)`,
      mime: 'image/jpeg',
      title: `verify-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.jpg`,
      instanceId,
      telemetry: signedRecord as unknown as Record<string, unknown>,
      signDigest: key.signDigest,
      signPayload: key.signPayload,
      pq: pq ? pqClaimSigner(pq) : null,
      certChain: chain,
      cleanFileSha256: sha256(stripped),
      fetchTimestamp: fetchTimestampTokensBounded,
      probeTokenSizes: estimatedTsaTokenSizes,
      exif: exif ?? null,
      identity: identityAssertionFor(chain, signedRecord),
      // The embedded attestation is bound to exactly this signing key
      // (emulated key attestation) — attach it only when the active signer
      // is the key Apple's hardware certified.
      appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion() : null,
      customAssertions: customAssertions ?? null,
      // Data contract, on by default; whichever standard
      // assertion the caller couldn't build honestly is simply absent.
      thumbnailJpeg: standard?.thumbnailJpeg ?? null,
      assetTypes: ['image'],
      trainingMiningDenied: true,
      phashHex: standard?.phashHex ?? null,
      emitC2paMetadata: true,
      createdDeclaration: { when: signedRecord.capturedAt },
      // D1: depth assertions — both absent unless the capture side
      // produced a verified artifact (see attestPhoto's fail-closed block).
      depthmap: standard?.depthmap ?? null,
      collectionAssets: standard?.collectionAssets ?? null,
      // The secondary-viewpoint ingredient — absent unless the
      // capture side produced a verified secondary frame (same block).
      secondaryView: standard?.secondaryView ?? null,
    },
    insertOffset
  );
  return concatBytes(stripped.subarray(0, insertOffset), segment, stripped.subarray(insertOffset));
}

/**
 * Embeds a signed record into clean PNG bytes as a genuine C2PA manifest inside
 * a caBX chunk before IEND, hard-bound by a c2pa.hash.data exclusion that spans
 * the whole chunk. The exclusion start is the clean file's IEND offset — the
 * bytes before IEND are identical in clean and signed files, so that offset is
 * where the caBX chunk lands.
 */
async function embedC2paInPng(stripped: Uint8Array, signedRecord: AttestationRecord, key: DeviceSigner, certChainOverride?: Uint8Array[], pq?: PqCaptureKey | null): Promise<Uint8Array> {
  const chain = certChainOverride ?? (await getDeviceCertChain()).chain;
  const instanceId = 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const insertOffset = iendOffset(stripped);
  if (insertOffset === null) throw new Error('Not a well-formed PNG (no IEND)');
  const store = await buildC2paStorePng(
    {
      appName: `Source Kit/${appVersion()} (com.verify.camera)`,
      mime: 'image/png',
      title: `verify-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.png`,
      instanceId,
      telemetry: signedRecord as unknown as Record<string, unknown>,
      signDigest: key.signDigest,
      signPayload: key.signPayload,
      pq: pq ? pqClaimSigner(pq) : null,
      certChain: chain,
      cleanFileSha256: sha256(stripped),
      fetchTimestamp: fetchTimestampTokensBounded,
      probeTokenSizes: estimatedTsaTokenSizes,
      identity: identityAssertionFor(chain, signedRecord),
      appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion() : null,
      // Data contract. The PNG path receives pixels-only
      // bytes (no file URI), so the claim thumbnail and pHash have no
      // honest source here — absent, not fabricated. No EXIF, so no
      // c2pa.metadata either.
      assetTypes: ['image'],
      trainingMiningDenied: true,
      createdDeclaration: { when: signedRecord.capturedAt },
    },
    insertOffset
  );
  return embedCaBx(stripped, store);
}

/**
 * Signs a clean PNG (pixels-only — e.g. re-encoded from a JPEG, so EXIF is
 * already gone) with a fresh C2PA manifest. Used by the share flow to offer a
 * format change that keeps the cryptography: the PNG is fully verifiable, just
 * like the JPEG it came from. `capturedAt` lets the caller carry over the
 * original capture time rather than stamping "now".
 */
export async function attestPng(params: {
  pngBytes: Uint8Array;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  capturedAt?: string;
  certChainOverride?: Uint8Array[];
  /** PQ dual-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
}): Promise<{ signedPngBytes: Uint8Array; record: AttestationRecord }> {
  const stripped = stripCaBx(params.pngBytes); // re-attesting signs clean bytes only
  const record = buildRecord({
    assetSha256: sha256Hex(stripped),
    assetBytes: stripped.length,
    mime: 'image/png',
    kind: 'photo',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: deviceModel(),
    platform: Platform.OS,
    identity: params.identity,
    context: params.context,
    publicKeyBase64: params.key.publicKeyBase64,
    fingerprint: params.key.fingerprint,
  });
  record.orgCredential = params.certChainOverride ? null : await orgCredentialForRecord();
  if (params.key.biometricBound) record.biometricBound = true;
  record.pqKey = params.pq ? pqPublicBlock(params.pq.publicKey, params.pq.enrolledAt) : null;
  const signedRecord = await signRecord(record, params.key.signDigest, params.key.signPayload, params.pq);
  const signedPngBytes = await embedC2paInPng(stripped, signedRecord, params.key, params.certChainOverride, params.pq);
  return { signedPngBytes, record: signedRecord };
}

/**
 * De-identify & re-sign into PNG. The privacy-safe format-conversion option in
 * the share flow: strips byline/location/sensors/device-model exactly like
 * deidentifyPhoto, and the PNG re-encode has already dropped the JPEG's EXIF.
 * The record carries the `deidentified` marker so a verifier sees the redaction
 * was deliberate, not a silent absence.
 */
/**
 * De-identify re-key: the anonymised copy signs
 * with a fresh one-time key, so its fingerprint shares nothing with the
 * device's long-lived identity — the linkage between identified and
 * anonymised copies is broken by construction, not by promise. The honest
 * cost: no Enclave backing, no hardware attestation, no org credential on
 * the copy, and the record's `deidentified.rekeyed` marker says exactly that.
 *
 * The copy also carries NO PQ layer: the device's long-lived
 * ML-DSA key would re-link the anonymised copy exactly like its P-256 key
 * would. De-identified copies simply omit pqKey/pqSignature — a verifier
 * reads the absence through the `deidentified` marker, never as stripping.
 */
async function deidEphemeralKey(): Promise<{ key: DeviceSigner; chain: Uint8Array[] }> {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  const key: DeviceSigner = {
    backend: 'software',
    publicKeyBase64: bytesToBase64(pub),
    fingerprint: bytesToHex(sha256(pub)),
    privateKeyHex: null,
    signDigest: async (d) => p256.sign(d, priv, { lowS: true }).toDERRawBytes(),
    signPayload: async (p) => p256.sign(sha256(p), priv, { lowS: true }).toDERRawBytes(),
  };
  const cert = await buildSelfSignedCert(pub, key.signDigest);
  return { key, chain: [cert] };
}

/** Fields every de-identified copy strips, including org + key linkage and the Wi-Fi network claim. */
const DEID_FIELDS = ['identity', 'organization', 'location', 'wifi', 'heading', 'pressure', 'altitude', 'motion', 'device-model', 'signing-key-linkage'];

export async function deidentifyPhotoToPng(params: {
  pngBytes: Uint8Array;
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim stays literally true. */
  capturedAt?: string;
}): Promise<{ signedPngBytes: Uint8Array; record: AttestationRecord }> {
  const cleanBytes = stripCaBx(params.pngBytes);
  const fields = [...DEID_FIELDS, 'exif'];
  // Re-keyed: params.key is intentionally NOT used for signing.
  const { key, chain } = await deidEphemeralKey();

  const record = buildRecord({
    assetSha256: sha256Hex(cleanBytes),
    assetBytes: cleanBytes.length,
    mime: 'image/png',
    kind: 'photo',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: null,
    platform: Platform.OS,
    identity: 'redacted',
    context: {
      location: 'redacted',
      // Wi-Fi claim stripped with location — explicit, never absent.
      wifi: 'redacted',
      headingDeg: null,
      pressureHPa: null,
      altitudeM: null,
      motion: null,
    },
    publicKeyBase64: key.publicKeyBase64,
    fingerprint: key.fingerprint,
  });
  record.orgCredential = null; // an anonymised copy never carries the org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  const signedPngBytes = await embedC2paInPng(cleanBytes, signedRecord, key, chain);
  return { signedPngBytes, record: signedRecord };
}

/**
 * De-identify & re-sign for BMFF media (video and audio). The privacy-safe
 * share copy: strips byline/location/sensors/device-model — and, for audio,
 * the on-device transcript (the words spoken) — while re-signing the same media
 * bytes, so the copy still proves integrity and custody. The `deidentified`
 * marker makes the redaction explicit to any verifier. The original is untouched.
 */
export async function deidentifyBmff(params: {
  /** Clean or already-signed BMFF bytes; signed input is stripped first. */
  bytes: Uint8Array;
  mime: string; // video/mp4, video/quicktime, audio/mp4
  kind: 'video' | 'audio';
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim stays literally true. */
  capturedAt?: string;
}): Promise<{ signedBytes: Uint8Array; record: AttestationRecord }> {
  let stripped = params.bytes;
  try {
    stripped = stripC2paFromBmff(params.bytes);
  } catch { /* unparseable containers handled by the embed gate */ }

  const fields = [
    ...DEID_FIELDS,
    ...(params.kind === 'audio' ? ['transcript'] : []),
  ];
  // Re-keyed: params.key is intentionally NOT used for signing.
  const { key, chain } = await deidEphemeralKey();

  const record = buildRecord({
    assetSha256: sha256Hex(stripped),
    assetBytes: stripped.length,
    mime: params.mime,
    kind: params.kind,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: null,
    platform: Platform.OS,
    identity: 'redacted',
    context: {
      location: 'redacted',
      // Wi-Fi claim stripped with location — explicit, never absent.
      wifi: 'redacted',
      headingDeg: null,
      pressureHPa: null,
      altitudeM: null,
      motion: null,
    },
    publicKeyBase64: key.publicKeyBase64,
    fingerprint: key.fingerprint,
  });
  record.orgCredential = null; // an anonymised copy never carries the org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  // transcript: null — the words spoken never ride in a de-identified share copy.
  const signedBytes = await embedC2paInBmff(stripped, signedRecord, key, params.mime, null, chain);
  return { signedBytes, record: signedRecord };
}

/** The org credential fields mirrored into the signed record, if one is active. */
async function orgCredentialForRecord(): Promise<AttestationRecord['orgCredential']> {
  const { org } = await getDeviceCertChain();
  if (!org) return null;
  return {
    issuer: org.issuerOrg ?? org.issuerCN,
    subject: org.subjectOrg ?? org.subjectCN,
    serialHex: org.serialHex,
    notAfter: org.notAfter,
  };
}

/**
 * Embeds a signed record into clean BMFF bytes as a genuine C2PA manifest:
 * a uuid box right after ftyp, hard-bound by c2pa.hash.bmff.v2.
 *
 * The hash covers every other root box by its final absolute offset, so it
 * depends on the uuid box's size — which in turn depends on claim/signature/
 * timestamp sizes, but never on the hash VALUE (a fixed-size bstr). That
 * makes the fixpoint well-behaved: build with the current hash, embed,
 * recompute — the layout length is pinned (padding absorbs TSA variance)
 * and the loop converges in two rounds, three when a TSA surprises us.
 */
async function embedC2paInBmff(
  stripped: Uint8Array,
  signedRecord: AttestationRecord,
  key: DeviceSigner,
  mime: string,
  transcript: TranscriptAssertion | null = null,
  certChainOverride?: Uint8Array[],
  pq?: PqCaptureKey | null,
  /** TSA token source — defaults to the live network fetchers; overridable
      so the lab can pin a deterministic token layout (F3, docs/SECURITY.md). */
  fetchTimestamp: C2paManifestParams['fetchTimestamp'] = fetchTimestampTokensBounded,
  /** WS2 Phase 2 parity assertions (com.verify.* JUMBF boxes). */
  customAssertions?: { label: string; data: unknown }[] | null,
  /** standard assertions (C5 claim thumbnail for video). */
  standard?: StandardAssertions | null
): Promise<Uint8Array> {
  const chain = certChainOverride ?? (await getDeviceCertChain()).chain;
  const instanceId = 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const exclusions = bmffMandatoryExclusions(C2PA_UUID_BYTES);
  const ext = mime === 'video/quicktime' ? 'mov' : mime === 'audio/mp4' ? 'm4a' : 'mp4';
  const params: C2paManifestParams = {
    appName: `Source Kit/${appVersion()} (com.verify.camera)`,
    mime,
    title: `verify-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.${ext}`,
    instanceId,
    telemetry: signedRecord as unknown as Record<string, unknown>,
    signDigest: key.signDigest,
    signPayload: key.signPayload,
    pq: pq ? pqClaimSigner(pq) : null,
    certChain: chain,
    cleanFileSha256: sha256(stripped), // unused by the BMFF builder — the v2 hash replaces it
    fetchTimestamp,
    probeTokenSizes: estimatedTsaTokenSizes,
    appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion() : null,
    transcript,
    identity: identityAssertionFor(chain, signedRecord),
    customAssertions: customAssertions ?? null,
  };

  let fixed: number | null = null;
  let hash: Uint8Array = new Uint8Array(32); // placeholder — round 1 only sizes the store
  for (let round = 0; round < 8; round++) {
    const store = await buildC2paStoreBmff(params, bmffHashAssertionCbor(hash, exclusions), fixed);
    const embedded = embedUuidStore(stripped, store);
    const actual = hashBmffV2(embedded, exclusions);
    // Sizing rounds (fixed === null) carry a dummy signature
    // and must NEVER be returned — only a re-signed, on-target round is final.
    const lengthConverged = fixed !== null && store.length === fixed;
    if (lengthConverged && actual.every((v, i) => v === hash[i])) return embedded;
    hash = actual;
    fixed = store.length;
  }
  throw new Error('C2PA BMFF embed did not converge');
}

export async function attestVideo(params: {
  videoUri: string;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  capturedAt?: string;
  assignmentLabel?: string | null;
  certChainOverride?: Uint8Array[];
  integritySignals?: DeviceIntegritySignals | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts) — signed time lower bound. */
  beacon?: BeaconCommitment | null;
  /** PQ dual-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /** Face check outcome — boolean only, never biometrics; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
  /** TSA token source override (default: live network fetchers). Lab seam for deterministic manifests. */
  fetchTimestamp?: C2paManifestParams['fetchTimestamp'];
  /** Raw CaptureKit sensor JSONL (WS2 Phase 2 §3) — committed as com.verify.poseTrace. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot (WS2 Phase 2 §2) — when CaptureKit ran. */
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
  /** Video stereo-pair claims — the
      pairsCommitted/pairsMissed/hardwareCost counts + pairs-root, signed
      into the context tree. */
  stereoClaims?: ContextClaim[] | null;
}): Promise<AttestResult> {
  // Whole-file read matches the vault's own seal profile (2-minute cap).
  const rawBytes = await readFileBytes(params.videoUri);
  // Defense in depth: re-attesting an already-signed video signs clean bytes.
  let stripped = rawBytes;
  try {
    stripped = stripC2paFromBmff(rawBytes);
  } catch { /* unparseable containers are handled by the embed gate below */ }

  const mime = /\.mov($|\?)/i.test(params.videoUri) ? 'video/quicktime' : 'video/mp4';

  const record = buildRecord({
    assetSha256: sha256Hex(stripped),
    assetBytes: stripped.length,
    mime,
    kind: 'video',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: deviceModel(),
    platform: Platform.OS,
    identity: params.identity,
    context: params.context,
    publicKeyBase64: params.key.publicKeyBase64,
    fingerprint: params.key.fingerprint,
  });
  record.assignment = params.assignmentLabel ? { label: params.assignmentLabel } : null;
  record.deviceIntegrity = params.integritySignals ?? null;
  // Capture-integrity signals — self-reported, signed, bounded.
  record.captureIntegrity = {
    captureToSignatureMs: Math.max(0, Date.now() - Date.parse(record.capturedAt)),
    sensorTiming: params.context.sensorTiming ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    note: 'self-reported' as const,
  };
  record.beacon = params.beacon ?? null; // cached tip only; never fetched at seal
  record.orgCredential = params.certChainOverride ? null : await orgCredentialForRecord();
  if (params.key.biometricBound) record.biometricBound = true;
  record.pqKey = params.pq ? pqPublicBlock(params.pq.publicKey, params.pq.enrolledAt) : null;

  // The streaming commitment is v2-only: per-track Merkle roots derived by
  // demuxing the finalized delivery bytes at seal time — the bytes a
  // verifier actually holds. No capture-time cross-check is applied: the
  // 0.11.x native stream hasher never received video bytes (uncompressed
  // capture frames carry no CMBlockBuffer) and hashed pre-encode audio, so
  // its numbers cannot agree with a delivery-file demux by construction.
  const v2build = buildStreamedChunksV2(stripped);
  if (!v2build.ok) {
    console.warn('streamedChunks v2 not emitted (honest absence):', v2build.reason);
  }
  const phase2 = phase2Assertions({
    record,
    kind: 'video',
    streamedV2: v2build.ok ? v2build.build.assertion : null,
    chunkMaps: v2build.ok ? v2build.build.maps : null,
    sensorLogText: params.sensorLogText ?? null,
    evidenceEnabled: params.evidenceEnabled ?? null,
    stereoClaims: params.stereoClaims ?? null,
  });
  const signedRecord = await signRecord(record, params.key.signDigest, params.key.signPayload, params.pq);

  // Genuine C2PA embed; out-of-scope containers degrade to sidecar honestly.
  let signedVideoBytes: Uint8Array | undefined;
  try {
    signedVideoBytes = await embedC2paInBmff(stripped, signedRecord, params.key, mime, null, params.certChainOverride, params.pq, params.fetchTimestamp ?? fetchTimestampTokensBounded, phase2.customAssertions, { thumbnailJpeg: await videoThumbnailJpeg(params.videoUri) });
  } catch (e) {
    console.warn('C2PA video embed skipped (sidecar attestation still signed):', e instanceof Error ? e.message : e);
  }

  return { signedVideoBytes, record: signedRecord, disclosure: phase2.disclosure, chunkMaps: phase2.chunkMaps };
}

/**
 * Audio: the recorder writes a canonical monolithic m4a (BMFF), so the
 * exact same C2PA embed applies — claim, c2pa.hash.bmff.v2, witnesses — plus
 * the on-device transcript as a signed com.verify.transcript assertion.
 */
export async function attestAudio(params: {
  audioUri: string;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  transcript: TranscriptAssertion | null;
  capturedAt?: string;
  assignmentLabel?: string | null;
  certChainOverride?: Uint8Array[];
  integritySignals?: DeviceIntegritySignals | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts) — signed time lower bound. */
  beacon?: BeaconCommitment | null;
  /** PQ dual-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /** Face check outcome — boolean only, never biometrics; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
  /** Raw sensor JSONL (WS2 Phase 2 §3) — committed as com.verify.poseTrace when present. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot (WS2 Phase 2 §2) — when CaptureKit ran. */
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
}): Promise<AttestResult> {
  const rawBytes = await readFileBytes(params.audioUri);
  let stripped = rawBytes;
  try {
    stripped = stripC2paFromBmff(rawBytes);
  } catch { /* unparseable containers handled by the embed gate */ }

  const record = buildRecord({
    assetSha256: sha256Hex(stripped),
    assetBytes: stripped.length,
    mime: 'audio/mp4',
    kind: 'audio',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: deviceModel(),
    platform: Platform.OS,
    identity: params.identity,
    context: params.context,
    publicKeyBase64: params.key.publicKeyBase64,
    fingerprint: params.key.fingerprint,
  });
  record.assignment = params.assignmentLabel ? { label: params.assignmentLabel } : null;
  record.deviceIntegrity = params.integritySignals ?? null;
  // Capture-integrity signals — self-reported, signed, bounded.
  record.captureIntegrity = {
    captureToSignatureMs: Math.max(0, Date.now() - Date.parse(record.capturedAt)),
    sensorTiming: params.context.sensorTiming ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    note: 'self-reported' as const,
  };
  record.beacon = params.beacon ?? null; // cached tip only; never fetched at seal
  record.orgCredential = params.certChainOverride ? null : await orgCredentialForRecord();
  if (params.key.biometricBound) record.biometricBound = true;
  record.pqKey = params.pq ? pqPublicBlock(params.pq.publicKey, params.pq.enrolledAt) : null;

  // WS2 Phase 2 §1/§2: audio gets the IDENTICAL assertion set (parity) —
  // the m4a's single audio track demuxes to a one-track v2 commitment.
  // There is no native stream-hash commitment on the audio recorder path,
  // so there is no cross-check to run; the binding is delivery-file, as
  // the assertion itself declares. The recorder's IMU sink (modules/
  // audio-capture) supplies the gyro JSONL behind params.sensorLogText, so
  // the poseTrace below commits exactly like video; the named audio
  // exceptions (no ring frames, no A/V desync) are listed in
  // docs/MEDIA-PARITY.md.
  const v2build = buildStreamedChunksV2(stripped);
  if (!v2build.ok) {
    console.warn('streamedChunks v2 not emitted for audio:', v2build.reason);
  }
  const phase2 = phase2Assertions({
    record,
    kind: 'audio',
    streamedV2: v2build.ok ? v2build.build.assertion : null,
    chunkMaps: v2build.ok ? v2build.build.maps : null,
    sensorLogText: params.sensorLogText ?? null,
    evidenceEnabled: params.evidenceEnabled ?? null,
  });
  const signedRecord = await signRecord(record, params.key.signDigest, params.key.signPayload, params.pq);

  let signedAudioBytes: Uint8Array | undefined;
  try {
    signedAudioBytes = await embedC2paInBmff(stripped, signedRecord, params.key, 'audio/mp4', params.transcript, params.certChainOverride, params.pq, undefined, phase2.customAssertions);
  } catch (e) {
    console.warn('C2PA audio embed skipped (sidecar attestation still signed):', e instanceof Error ? e.message : e);
  }

  return { signedAudioBytes, record: signedRecord, disclosure: phase2.disclosure, chunkMaps: phase2.chunkMaps };
}

/**
 * De-identify & re-sign (photos).
 *
 * Produces a NEW signed JPEG whose attestation keeps the proof that matters
 * for integrity — same media hash, same capture-time claim, fresh RFC 3161
 * countersignature — under a fresh ONE-TIME signing key (re-keyed, * the long-lived device key is deliberately NOT used), while removing
 * everything identifying:
 * byline, location, heading, barometrics, motion signal, device model.
 *
 * The copy is honest about what it is: the record carries a `deidentified`
 * marker listing the removed field groups, so a verifier sees "the signer
 * redacted this before sharing" rather than a silent absence. The original
 * (vault copy) is untouched. The media bytes are bit-identical — a
 * de-identified copy still fails verification if a single pixel changes.
 */
export async function deidentifyPhoto(params: {
  photoUri: string;
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim stays literally true. */
  capturedAt?: string;
}): Promise<{ signedPhotoBytes: Uint8Array; record: AttestationRecord }> {
  // Strip the old manifest AND any EXIF/IPTC metadata — the redacted record is
  // only half the job if the pixel container still carries make/model/timestamps.
  // stripMetadata is lossless: pixels (and thus the integrity binding) are untouched.
  const cleanBytes = stripMetadata(stripManifest(await readFileBytes(params.photoUri)));
  const fields = [...DEID_FIELDS, 'exif'];
  // Re-keyed: params.key is intentionally NOT used for signing.
  const { key, chain } = await deidEphemeralKey();

  const record = buildRecord({
    assetSha256: sha256Hex(cleanBytes),
    assetBytes: cleanBytes.length,
    mime: 'image/jpeg',
    kind: 'photo',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: null,
    platform: Platform.OS,
    identity: 'redacted',
    context: {
      location: 'redacted',
      // Wi-Fi claim stripped with location — explicit, never absent.
      wifi: 'redacted',
      headingDeg: null,
      pressureHPa: null,
      altitudeM: null,
      motion: null,
    },
    publicKeyBase64: key.publicKeyBase64,
    fingerprint: key.fingerprint,
  });
  record.orgCredential = null; // an anonymised copy never carries the org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  const signedPhotoBytes = await embedC2paInJpeg(cleanBytes, signedRecord, key, chain);
  return { signedPhotoBytes, record: signedRecord };
}

/** Serializes a record for the video sidecar or the share-sheet export. */
export function recordToSidecarJson(record: AttestationRecord): string {
  return JSON.stringify(record, null, 2);
}

export function parseSidecarJson(json: string): AttestationRecord | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && parsed.format === 'verify-attestation' ? (parsed as AttestationRecord) : null;
  } catch {
    return null;
  }
}

export function recordToBase64(record: AttestationRecord): string {
  return bytesToBase64(utf8ToBytes(JSON.stringify(record)));
}

// recordFromManifestBytes lives in manifest.ts (pure module) so the
// verification chain never pulls this capture-side module's expo glue.
