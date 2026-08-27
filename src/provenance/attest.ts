// Source Kit 0.1.0 — attestation orchestration: media file → signed media file
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
import { stripManifest, stripMetadata } from '../../archive/handrolled-verifier/jpegApp11';
import { buildC2paSegment, buildC2paStoreBmff, buildC2paStorePng, bmffHashAssertionCbor, bmffMandatoryExclusions, hashBmffV2, extractC2paStore, parseManifest, type C2paManifestParams, type TranscriptAssertion } from '../../archive/handrolled-verifier/c2pa';
import { C2PA_UUID_BYTES, embedUuidStore, stripC2paFromBmff, extractC2paStoreBmff } from '../../archive/handrolled-verifier/bmff';
import { embedCaBx, iendOffset, stripCaBx } from '../../archive/handrolled-verifier/png';
import { signRecord, sha256Hex, payloadBytes } from '../lib/sign';
import { enclaveSealBioHold, enclaveSealBioRelease } from '../lib/enclave';
import { pqClaimSigner, pqPublicBlock, type PqCaptureKey } from '../lib/pq';
import { getDeviceCertChain, type DeviceSigner } from '../lib/deviceKey';
import { buildSelfSignedCert } from '../lib/cert';
import type { DeviceIntegritySignals } from '../lib/integrity';
import { fetchTimestampTokensBounded, estimatedTsaTokenSizes, configuredTsaUrls } from '../lib/timestamp';
import { UPSTREAM_SIGNING_EXPERIMENT, signSourceKitAssetSecureEnclave } from './engine/upstreamEngineIos';
import { sdkSigningExperimentActive } from '../lib/sdkSigningGate';
import { verifyPhotoBytes, verifyVideoBytes } from '../../archive/handrolled-verifier/verifyAsset';
import type { BeaconCommitment } from '../lib/beacon';
import { getAttestationAssertion } from '../lib/appAttest';
import { bytesToBase64, bytesToHex, base64ToBytes, concatBytes, utf8ToBytes, equalBytes } from '../lib/bytes';
import { readFileBytes } from '../lib/fileHash';
import { pHashFromGray32 } from '../lib/phash';
import { logDiagnostic } from '../lib/diagnosticsLog';
// Type-only: the native capture contract (D1 depth fields). Erased at
// runtime — this module never loads the camera module's expo glue.
import type { CaptureResult, DepthArtifactMetadata, EvidencePath as CameraEvidencePath } from '../lib/exhibitCamera';

/**
 * The 0.16.0 standard-assertion set (C2–C5) one call site hands to the
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
  /** 0.16.1: secondary viewpoint → c2pa.ingredient.v3 + ingredient thumbnail (photos, when a secondary frame exists). */
  secondaryView?: {
    thumbnailJpeg: Uint8Array;
    fullResSha256: string;
    width?: number | null;
    height?: number | null;
  } | null;
  /** 0.18.5 post-field: periodic video pair stills → one componentOf
      ingredient each (videos, when the recording committed pairs). */
  videoStills?: {
    thumbnailJpeg: Uint8Array;
    fullResSha256: string;
    pairIndex: number;
    hostSeconds: number | null;
  }[] | null;
}

/**
 * The GDepth assertion payload as a JSON-ready map for the SDK path
 * (0.19.0): exactly the keys/values the hand-rolled builder CBOR-encodes
 * (see archive c2pa.ts, LABEL_DEPTHMAP_GDEPTH) — the SDK serializes it to
 * CBOR itself, and the verifier reads both content-box types.
 */
function gdepthSpecFromDepthmap(d: NonNullable<StandardAssertions['depthmap']>): Record<string, unknown> {
  const g: Record<string, unknown> = {
    'GDepth:Format': d.format,
    'GDepth:Near': d.near,
    'GDepth:Far': d.far,
    'GDepth:Mime': d.mime,
    'GDepth:Data': bytesToBase64(d.data),
  };
  if (d.units) g['GDepth:Units'] = d.units;
  if (d.measureType) g['GDepth:MeasureType'] = d.measureType;
  if (d.confidence && d.confidence.data.length > 0) {
    g['GDepth:ConfidenceMime'] = d.confidence.mime;
    g['GDepth:Confidence'] = bytesToBase64(d.confidence.data);
  }
  if (d.manufacturer) g['GDepth:Manufacturer'] = d.manufacturer;
  if (d.model) g['GDepth:Model'] = d.model;
  if (d.software) g['GDepth:Software'] = d.software;
  if (typeof d.imageWidth === 'number') g['GDepth:ImageWidth'] = d.imageWidth;
  if (typeof d.imageHeight === 'number') g['GDepth:ImageHeight'] = d.imageHeight;
  return g;
}

/**
 * The upstream-resolved depth artifact for THIS capture (0.16.0, D1): the
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
 * The upstream-resolved secondary viewpoint for THIS capture (0.16.1): the
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
 * Resolves the secondary viewpoint to commit from a CaptureResult (0.16.1).
 * Returns null when no secondary field exists at all (pre-0.16.1 native
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
// named exceptions: stills
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
 * stills sink, raw PCM applies to video sessions and (0.18.3+) audio takes,
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
 * 0.16.0 C5 (photo path): the ≤512px claim thumbnail. Same recipe the
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
 * 0.16.0 C3 (photo path): the capture-time pHash, computed PRE-SIGNING so
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
 * 0.16.0 C5 (video path): a frame ~0.5 s in, resized to ≤512px JPEG — the
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

/**
 * 0.20.2 forensic quarantine (field, 0.20.1 (54): the SDK arm signed but the
 * self-check returned UNSUPPORTED, and the rejected bytes were DISCARDED by
 * the fallback — leaving a verifier-coverage gap against the on-device SDK
 * output undiagnosable from the log alone). On an SDK self-check failure the
 * rejected SDK-sealed bytes are written to documentDirectory/sdk-quarantine/
 * — forensics ONLY: never sealed as a capture, never in Exhibits, never
 * uploaded; Noah exports them by hand if he wants the gap chased. Fail-closed:
 * a write error must not delay or break the hand-rolled fallback.
 */
async function quarantineSdkOutput(bytes: Uint8Array, ext: 'jpg' | 'png' | 'mp4'): Promise<string | null> {
  try {
    const dir = `${FileSystem.documentDirectory ?? ''}sdk-quarantine/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    const name = `sdk-rejected-${Date.now()}.${ext}`;
    await FileSystem.writeAsStringAsync(dir + name, bytesToBase64(bytes));
    return `sdk-quarantine/${name}`;
  } catch {
    return null;
  }
}

export async function attestPhoto(params: {  photoUri: string;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  capturedAt?: string;
  /** Assignment-mode label + cert chain (0.9.0) — signs outside the device identity. */
  assignmentLabel?: string | null;
  certChainOverride?: Uint8Array[];
  /** Device integrity signals, signed as a self-reported assertion (0.9.0). */
  integritySignals?: DeviceIntegritySignals | null;
  /** Sanitized camera EXIF (src/lib/exif.ts) — signed as com.verify.exif (0.10.0). */
  exif?: Record<string, number | string> | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts) — signed time lower bound (0.10.0). */
  beacon?: BeaconCommitment | null;
  /** PQ record-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /**
   * Face check outcome (0.11.1) — the boolean result of the OS biometric
   * check run at capture start when the toggle was on; null/absent when no
   * check was requested. 0.22.0: the capture-time check was REMOVED (its
   * LA prompt killed dual camera in the field), so null is now the only
   * value written at capture. The flag ONLY: no face geometry or template
   * exists.
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
  /** D1 (0.16.0): the resolved depth artifact — see DepthCommitInput. */
  depth?: DepthCommitInput | null;
  /** 0.16.1: the resolved secondary viewpoint — see SecondaryCommitInput. */
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
  // Capture-integrity signals (0.9.3) — self-reported, signed, bounded.
  record.captureIntegrity = {
    captureToSignatureMs: Math.max(0, Date.now() - Date.parse(record.capturedAt)),
    sensorTiming: params.context.sensorTiming ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    note: 'self-reported' as const,
  };
  // Time lower bound from the cached beacon (0.10.0) — whatever tip is cached
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
  // 0.19.0: record-only PQ by design — the COSE claim carries no verifyPq
  // entry; this declaration (inside the signed payload) tells the verifier.
  record.pqScope = 'record';
  // WS2 Phase 2: the parity assertion set. Stills commit the zero-track
  // streamedChunks assertion (structural — a JPEG has no elementary
  // streams; the hard binding covers the file byte-for-byte). This is the
  // named stills exception.
  const phase2 = phase2Assertions({
    record,
    kind: 'photo',
    streamedV2: buildStreamedChunksV2ForStill(),
    chunkMaps: null,
    sensorLogText: params.sensorLogText ?? null,
    evidenceEnabled: params.evidenceEnabled ?? null,
    stereoClaims: params.stereoClaims ?? null,
  });
  // D1 (0.16.0, commit half): the depth artifact. 'never-recorded'/'error'
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
  // 0.16.1: the secondary viewpoint as a componentOf ingredient. Same
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
  // 0.16.0 C3/C5: pHash + claim thumbnail, computed pre-signing so both
  // land under the COSE claim signature. Each is independently fail-closed.
  // (0.19.0: hoisted above the SDK gate — the flagged path carries the same
  // payloads, as resources/standard labels, so both builders see identical
  // inputs.)
  const standard: StandardAssertions = {
    thumbnailJpeg: await photoThumbnailJpeg(params.photoUri),
    phashHex: await photoPhashHex(params.photoUri),
    ...depthStd,
    secondaryView: secondaryStd,
  };
  // 0.19.0 c2pa-swift migration slice (compile-time gated — see
  // engine/upstreamEngineIos.ts UPSTREAM_SIGNING_EXPERIMENT): sign via the
  // SDK, then SELF-VERIFY the result through the same verifier any recipient
  // runs. Any failure — engine throw, or a self-check that isn't INTACT with
  // a matching asset digest — falls back to the validated hand-rolled path
  // with a diagnostic. Flagged captures carry the SAME payloads as the
  // hand-rolled path (thumbnails as resources, depth as c2pa.depthmap.GDepth,
  // pHash as com.verify.phash, secondary still as a v3 ingredient) and the
  // configured TSA endpoint countersigns when the network allows.
  // 0.20.5 (c): biometric-bound keys no longer skip this arm — the
  // sealBioHold ceremony (SealContextVault, native) evaluates Face ID ONCE
  // and both signatures ride it: the record's below (vault-aware sealBio)
  // and the SDK claim's (the vendored signer's held-context keychain
  // query). The hold precedes signRecord; every arm exit releases it. When
  // the hold can't run (old native build), the arm stays off for bio keys
  // and the hand-rolled path prompts as before — stated in the log.
  const sdkArmWanted = UPSTREAM_SIGNING_EXPERIMENT && Platform.OS === 'ios' && sdkSigningExperimentActive();
  let bioHoldActive = false;
  if (sdkArmWanted && params.key.biometricBound) {
    bioHoldActive = await enclaveSealBioHold('Authorize signing this capture');
    if (!bioHoldActive) {
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'info', message: 'SDK signing skipped — biometric key, but the held-context ceremony is unavailable on this native build; hand-rolled path used (its own prompt)' });
    }
  }
  // When the hold is live, guard the record signature: the payload the
  // enclave signs must be EXACTLY this record's canonical bytes — a runtime
  // hook swapping payloads between the scan and the sign would otherwise
  // mint a signature over something the one scan never covered.
  const recordSignPayload = bioHoldActive && params.key.signPayload
    ? (() => {
        const expected = payloadBytes(record);
        const signPayload = params.key.signPayload!;
        return async (payload: Uint8Array) => {
          if (!equalBytes(payload, expected)) {
            throw new Error('held-bio payload mismatch — refusing to sign a payload the scan did not cover');
          }
          return signPayload(payload);
        };
      })()
    : params.key.signPayload;
  let signedRecord: AttestationRecord;
  try {
    signedRecord = await signRecord(record, params.key.signDigest, recordSignPayload, params.pq);
  } catch (e) {
    // The guard refused (or the enclave threw) before the arm ran — the
    // vaulted scan still gets released, never left to the TTL.
    if (bioHoldActive) enclaveSealBioRelease();
    throw e;
  }
  if (sdkArmWanted && (!params.key.biometricBound || bioHoldActive)) {
    try {
      const sdkChain = params.certChainOverride ?? (await getDeviceCertChain()).chain;
      const cleanSha = sha256(stripped);
      const aaBytes = params.key.backend === 'secure-enclave-attested' ? await getAttestationAssertion(cleanSha) : null;
      const sdk = await signSourceKitAssetSecureEnclave(stripped, 'image/jpeg', {
        appName: `Source Kit/${appVersion()} (com.verify.camera)`,
        title: `verify-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.jpg`,
        telemetry: signedRecord as unknown as Record<string, unknown>,
        // The assertion is a JSON document; the helper returns it as bytes.
        appAttest: aaBytes ? (JSON.parse(new TextDecoder().decode(aaBytes)) as Record<string, unknown>) : null,
        exif: params.exif ?? null,
        // 0.20.4: NO org identity on the SDK path. The standard writer wraps
        // identity in the com.verify.identity/1 envelope whose
        // referenced_assertions hash commits the telemetry box as EMITTED —
        // c2pa-rs emits the boxes internally, so the SDK path cannot
        // compute that binding pre-signing. The bare {org, role} this arm
        // used to send parsed to nothing downstream: an assertion that
        // does nothing, now removed rather than decorative.
        customAssertions: phase2.customAssertions,
        thumbnailJpeg: standard.thumbnailJpeg ?? null,
        phashHex: standard.phashHex ?? null,
        depthGdepth: standard.depthmap ? gdepthSpecFromDepthmap(standard.depthmap) : null,
        secondaryView: standard.secondaryView
          ? {
              thumbnailJpeg: standard.secondaryView.thumbnailJpeg,
              fullResSha256: standard.secondaryView.fullResSha256,
              title: `verify-secondary-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.jpg`,
            }
          : null,
        certChainDer: sdkChain,
        enclaveKeyTag: params.key.enclaveKeyTag ?? null,
        tsaUrls: configuredTsaUrls(), // the witness pool in fallback order — one TLS-unreachable witness must not cost the countersignature (0.20.6)
        heldBioContext: params.key.biometricBound, // 0.20.5: ride the vaulted scan (hold taken above)
      });
      const selfCheck = await verifyPhotoBytes(sdk.signedBytes);
      if (selfCheck.verdict === 'INTACT' && selfCheck.c2pa?.assetHashFailure === null) {
        logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'info', message: `upstream SDK signing path used, self-verified INTACT (migration experiment${sdk.untimedTsaRetry ? `; TSA fetch failed (${sdk.tsaError ?? 'reason not surfaced'}) — sealed untimed, no RFC 3161 countersignature on this claim` : sdk.tsaWitness ? `; RFC 3161 countersigned by ${sdk.tsaWitness} (0.20.8 witness named — the pool's iteration shows in the log on success too)` : ''})` });
        return { signedPhotoBytes: sdk.signedBytes, record: signedRecord, disclosure: phase2.disclosure, chunkMaps: null };
      }
      const quarantined = await quarantineSdkOutput(sdk.signedBytes, 'jpg');
      // 0.20.4: name the failing axis in the log — "verdict SIGNATURE_INVALID"
      // alone never says whether the COSE signature, the claim-assertion
      // binding, or the inner record failed, and the quarantined bytes are
      // not always reachable for forensics.
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `upstream SDK signing self-check failed (verdict ${selfCheck.verdict}; assertion binding ${selfCheck.c2pa ? (selfCheck.c2pa.claimAssertionsMatch ? 'matches' : 'MISMATCH') : 'n/a'}; asset hash ${selfCheck.c2pa?.assetHashFailure ?? 'intact'}${selfCheck.checksNotPerformed.length > 0 ? `; first unchecked: ${selfCheck.checksNotPerformed[0]}` : ''}) — hand-rolled path used${quarantined ? `; rejected SDK bytes kept at ${quarantined} (forensics only, never sealed)` : ''}` });
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `upstream SDK signing threw (${e instanceof Error ? e.message : String(e)}) — hand-rolled path used` });
    } finally {
      // 0.20.5: EVERY arm exit releases the vaulted scan (invalidated
      // natively) — success, self-check failure, and throw alike.
      if (bioHoldActive) enclaveSealBioRelease();
    }
  }
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
  // One hash of the clean bytes: the hard binding and the per-capture
  // App Attest assertion both commit to exactly these.
  const cleanSha = sha256(stripped);
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
      cleanFileSha256: cleanSha,
      fetchTimestamp: fetchTimestampTokensBounded,
      probeTokenSizes: estimatedTsaTokenSizes,
      exif: exif ?? null,
      identity: identityAssertionFor(chain, signedRecord),
      // The embedded attestation is bound to exactly this signing key
      // (emulated key attestation) — attach it only when the active signer
      // is the key Apple's hardware certified.
      appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion(cleanSha) : null,
      customAssertions: customAssertions ?? null,
      // 0.16.0 data contract (C2–C5), ON by default; whichever standard
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
      // 0.16.1: the secondary-viewpoint ingredient — absent unless the
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
  // One hash of the clean bytes: the hard binding and the per-capture
  // App Attest assertion both commit to exactly these.
  const cleanSha = sha256(stripped);
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
      cleanFileSha256: cleanSha,
      fetchTimestamp: fetchTimestampTokensBounded,
      probeTokenSizes: estimatedTsaTokenSizes,
      identity: identityAssertionFor(chain, signedRecord),
      appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion(cleanSha) : null,
      // 0.16.0 data contract (C2/C5). The PNG path receives pixels-only
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
  /** PQ record-signature layer — software key; hedges P-256 cryptanalysis only. */
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
  // 0.19.0: record-only PQ by design — the COSE claim carries no verifyPq
  // entry; this declaration (inside the signed payload) tells the verifier.
  record.pqScope = 'record';
  // 0.19.0 c2pa-swift migration slice, PNG path (compile-time gated — see
  // the photo path's gate comment). Same discipline: SDK sign → self-verify
  // → any failure falls back to the hand-rolled path with a diagnostic.
  // 0.20.5 (c): the biometric hold ceremony — identical to the photo arm.
  const sdkArmWanted = UPSTREAM_SIGNING_EXPERIMENT && Platform.OS === 'ios' && sdkSigningExperimentActive();
  let bioHoldActive = false;
  if (sdkArmWanted && params.key.biometricBound) {
    bioHoldActive = await enclaveSealBioHold('Authorize signing this capture');
    if (!bioHoldActive) {
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'info', message: 'SDK signing skipped — biometric key, but the held-context ceremony is unavailable on this native build; hand-rolled path used (its own prompt) (png)' });
    }
  }
  const recordSignPayload = bioHoldActive && params.key.signPayload
    ? (() => {
        const expected = payloadBytes(record);
        const signPayload = params.key.signPayload!;
        return async (payload: Uint8Array) => {
          if (!equalBytes(payload, expected)) {
            throw new Error('held-bio payload mismatch — refusing to sign a payload the scan did not cover');
          }
          return signPayload(payload);
        };
      })()
    : params.key.signPayload;
  let signedRecord: AttestationRecord;
  try {
    signedRecord = await signRecord(record, params.key.signDigest, recordSignPayload, params.pq);
  } catch (e) {
    if (bioHoldActive) enclaveSealBioRelease();
    throw e;
  }
  if (sdkArmWanted && (!params.key.biometricBound || bioHoldActive)) {
    try {
      const sdkChain = params.certChainOverride ?? (await getDeviceCertChain()).chain;
      const sdk = await signSourceKitAssetSecureEnclave(stripped, 'image/png', {
        appName: `Source Kit/${appVersion()} (com.verify.camera)`,
        title: `verify-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.png`,
        telemetry: signedRecord as unknown as Record<string, unknown>,
        certChainDer: sdkChain,
        enclaveKeyTag: params.key.enclaveKeyTag ?? null,
        tsaUrls: configuredTsaUrls(), // 0.20.6: full witness pool, fallback order
        heldBioContext: params.key.biometricBound, // 0.20.5: ride the vaulted scan
      });
      const selfCheck = await verifyPhotoBytes(sdk.signedBytes);
      if (selfCheck.verdict === 'INTACT' && selfCheck.c2pa?.assetHashFailure === null) {
        logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'info', message: `upstream SDK signing path used, self-verified INTACT (migration experiment, png${sdk.untimedTsaRetry ? `; TSA fetch failed (${sdk.tsaError ?? 'reason not surfaced'}) — sealed untimed, no RFC 3161 countersignature on this claim` : sdk.tsaWitness ? `; RFC 3161 countersigned by ${sdk.tsaWitness} (0.20.8 witness named — the pool's iteration shows in the log on success too)` : ''})` });
        return { signedPngBytes: sdk.signedBytes, record: signedRecord };
      }
      const quarantined = await quarantineSdkOutput(sdk.signedBytes, 'png');
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `upstream SDK signing self-check failed (verdict ${selfCheck.verdict}${selfCheck.checksNotPerformed.length > 0 ? `; first unchecked: ${selfCheck.checksNotPerformed[0]}` : ''}, png) — hand-rolled path used${quarantined ? `; rejected SDK bytes kept at ${quarantined} (forensics only, never sealed)` : ''}` });
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `upstream SDK signing threw (${e instanceof Error ? e.message : String(e)}, png) — hand-rolled path used` });
    } finally {
      if (bioHoldActive) enclaveSealBioRelease();
    }
  }
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
 * De-identify re-key (0.9.0 source protection): the anonymised copy signs
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

/** Fields every de-identified copy strips: the IDENTIFYING values only
    (0.18.6 field-report correction — earlier builds also nulled heading /
    barometrics / motion / device model and dropped the capture-evidence
    three-state, which made Inspect show "Not recorded" for evidence the
    original carries). Non-identifying evidence — motion summary, pose trace,
    heading, pressure, altitude, depth, ENF anchor, the captureEvidence
    sink states, device model — is carried VERBATIM from the source record
    the caller passes in. Key linkage stays stripped via the ephemeral
    re-key; org + Wi-Fi + location stay redacted; audio also drops the
    transcript (the words spoken). */
const DEID_FIELDS = ['identity', 'organization', 'location', 'wifi', 'signing-key-linkage'];

/** The source record's non-identifying context, carried into the copy so a
    de-identified share still shows the motion trace / second views /
    environment it actually recorded. Absent for legacy assets with no
    record in scope — the copy then states nulls (not a silent strip: the
    `deidentified.fields` list names only what the operation removes). */
export interface DeidSourceContext {
  context?: SensorContext | null;
  deviceModel?: string | null;
}

/** Build the copy's context: identifying values redacted, everything else
    carried from the source record (when the caller has it). */
function deidContext(source?: DeidSourceContext): SensorContext {
  const src = source?.context ?? null;
  return {
    location: 'redacted',
    // Wi-Fi claim stripped with location — explicit, never absent.
    wifi: 'redacted',
    headingDeg: src?.headingDeg ?? null,
    // 0.23.0: declination bands a capture to a few hundred km — a location
    // proxy, so it redacts WITH location, never carried through (handoff §02).
    declinationDeg: null,
    pressureHPa: src?.pressureHPa ?? null,
    altitudeM: src?.altitudeM ?? null,
    motion: src?.motion ?? null,
    poseTrace: src?.poseTrace ?? null,
    sensorTiming: src?.sensorTiming ?? null,
    captureEvidence: src?.captureEvidence ?? null,
    depth: src?.depth ?? null,
    enfAnchor: src?.enfAnchor ?? null,
  };
}

/**
 * The second-camera stills + claim thumbnail a de-identified re-seal carries
 * forward (0.18.6 — Noah: the secondary lens captures "need to be preserved
 * and shown"). Parsed from the ORIGINAL file's own manifest: the same lead
 * bytes and the same full-res commitment ride into the copy unchanged. Only
 * boxes the ORIGINAL signed claim referenced are carried — an unreferenced
 * box was attached post-signing and earns no place in a fresh claim. The
 * stills are non-identifying evidence (the de-identify contract strips
 * identity, never the capture's own views). Fail-closed: an unparseable
 * source carries nothing — the copy simply lacks the boxes, stated by
 * absence, same rule as a capture that never recorded pairs.
 */
function secondCameraCarry(bytes: Uint8Array, container: 'jpeg' | 'bmff'): {
  thumbnailJpeg: Uint8Array | null;
  secondaryView: StandardAssertions['secondaryView'];
  videoStills: StandardAssertions['videoStills'];
} {
  const none: { thumbnailJpeg: null; secondaryView: null; videoStills: null } = {
    thumbnailJpeg: null, secondaryView: null, videoStills: null,
  };
  try {
    const store = container === 'jpeg' ? extractC2paStore(bytes) : extractC2paStoreBmff(bytes);
    if (!store) return none;
    const m = parseManifest(store.payload);
    if (!m) return none;
    const claimThumb = m.thumbnails.find(
      (t) => t.referenced && t.label === 'c2pa.thumbnail.claim.jpeg' && t.bytes.length > 0,
    ) ?? null;
    const thumbByLabel = new Map(
      m.thumbnails.filter((t) => t.referenced && t.bytes.length > 0).map((t) => [t.label, t.bytes] as const),
    );
    let secondaryView: StandardAssertions['secondaryView'] = null;
    const stills: NonNullable<StandardAssertions['videoStills']> = [];
    for (const ing of m.ingredients) {
      if (!ing.referenced || ing.relationship !== 'componentOf') continue;
      if (!ing.dataHashHex || !/^[0-9a-f]{64}$/i.test(ing.dataHashHex)) continue;
      const thumbBytes = ing.thumbnailIdentifier ? thumbByLabel.get(ing.thumbnailIdentifier) : undefined;
      if (!thumbBytes) continue;
      if (ing.instanceId === 'xmp:iid:verify-secondary-view') {
        secondaryView = { thumbnailJpeg: thumbBytes, fullResSha256: ing.dataHashHex };
      } else {
        const pm = /^xmp:iid:verify-video-secondary-(\d+)$/.exec(ing.instanceId ?? '');
        if (pm) {
          stills.push({
            thumbnailJpeg: thumbBytes,
            fullResSha256: ing.dataHashHex,
            pairIndex: parseInt(pm[1], 10),
            // The ingredient does not store the pair's PTS anchor — absent,
            // never reconstructed.
            hostSeconds: null,
          });
        }
      }
    }
    stills.sort((a, b) => a.pairIndex - b.pairIndex);
    return {
      thumbnailJpeg: claimThumb?.bytes ?? null,
      secondaryView,
      videoStills: stills.length > 0 ? stills : null,
    };
  } catch {
    return none;
  }
}

/** 0.18.5 post-field: at most this many periodic pair frames embed as
    ingredient leads in the video manifest (evenly spaced by the caller,
    first + last always included); the vault holds every pair — the
    manifest is the viewing surface, not the archive. */
const EMBEDDED_VIDEO_STILLS_MAX = 8;

export async function deidentifyPhotoToPng(params: {
  pngBytes: Uint8Array;
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim stays literally true. */
  capturedAt?: string;
  /** The source record's non-identifying context, carried into the copy (0.18.6). */
  source?: DeidSourceContext;
}): Promise<{ signedPngBytes: Uint8Array; record: AttestationRecord }> {
  const cleanBytes = stripCaBx(params.pngBytes);
  const fields = [...DEID_FIELDS, 'exif'];
  // Re-keyed: params.key is intentionally NOT used for signing (0.9.0).
  const { key, chain } = await deidEphemeralKey();

  const record = buildRecord({
    assetSha256: sha256Hex(cleanBytes),
    assetBytes: cleanBytes.length,
    mime: 'image/png',
    kind: 'photo',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: params.source?.deviceModel ?? null,
    platform: Platform.OS,
    identity: 'redacted',
    context: deidContext(params.source),
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
 * share copy: strips the identifying values — byline, organization, location,
 * Wi-Fi, signing-key linkage — and, for audio, the on-device transcript (the
 * words spoken) — while re-signing the same media bytes, so the copy still
 * proves integrity and custody. Non-identifying evidence (motion, heading,
 * barometrics, pose trace, depth, ENF anchor, capture-evidence states,
 * device model) is carried verbatim from the source record when the caller
 * passes it (0.18.6). The `deidentified` marker makes the redaction explicit
 * to any verifier. The original is untouched.
 */
export async function deidentifyBmff(params: {
  /** Clean or already-signed BMFF bytes; signed input is stripped first. */
  bytes: Uint8Array;
  mime: string; // video/mp4, video/quicktime, audio/mp4
  kind: 'video' | 'audio';
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim stays literally true. */
  capturedAt?: string;
  /** The source record's non-identifying context, carried into the copy (0.18.6). */
  source?: DeidSourceContext;
}): Promise<{ signedBytes: Uint8Array; record: AttestationRecord }> {
  let stripped = params.bytes;
  try {
    stripped = stripC2paFromBmff(params.bytes);
  } catch { /* unparseable containers handled by the embed gate */ }

  const fields = [
    ...DEID_FIELDS,
    ...(params.kind === 'audio' ? ['transcript'] : []),
  ];
  // Re-keyed: params.key is intentionally NOT used for signing (0.9.0).
  const { key, chain } = await deidEphemeralKey();

  const record = buildRecord({
    assetSha256: sha256Hex(stripped),
    assetBytes: stripped.length,
    mime: params.mime,
    kind: params.kind,
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: params.source?.deviceModel ?? null,
    platform: Platform.OS,
    identity: 'redacted',
    context: deidContext(params.source),
    publicKeyBase64: key.publicKeyBase64,
    fingerprint: key.fingerprint,
  });
  record.orgCredential = null; // an anonymised copy never carries the org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  // transcript: null — the words spoken never ride in a de-identified share copy.
  // The second-camera stills + claim thumbnail DO ride (0.18.6): parsed from
  // the original manifest, non-identifying, committed unchanged.
  const carry = params.kind === 'video' ? secondCameraCarry(params.bytes, 'bmff') : null;
  const signedBytes = await embedC2paInBmff(
    stripped, signedRecord, key, params.mime, null, chain,
    undefined, undefined, undefined,
    carry && (carry.thumbnailJpeg || carry.videoStills)
      ? { thumbnailJpeg: carry.thumbnailJpeg, videoStills: carry.videoStills }
      : null,
  );
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
 * 0.18.6: the finalize step re-fetches TSA tokens fresh each signing round,
 * and a 1–5 byte shortfall against the pin is unpaddeable; the builder
 * overshoots that gap to exactly +5 (always encodable) and this loop
 * re-pins to the overshot length, so an unlucky token draw costs one extra
 * round instead of the whole embed.
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
      so the lab can pin a deterministic token layout. */
  fetchTimestamp: C2paManifestParams['fetchTimestamp'] = fetchTimestampTokensBounded,
  /** WS2 Phase 2 parity assertions (com.verify.* JUMBF boxes). */
  customAssertions?: { label: string; data: unknown }[] | null,
  /** 0.16.0 standard assertions (C5 claim thumbnail for video). */
  standard?: StandardAssertions | null
): Promise<Uint8Array> {
  const chain = certChainOverride ?? (await getDeviceCertChain()).chain;
  const instanceId = 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const exclusions = bmffMandatoryExclusions(C2PA_UUID_BYTES);
  // One hash of the clean bytes: the hard binding and the per-capture
  // App Attest assertion both commit to exactly these.
  const cleanSha = sha256(stripped);
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
    cleanFileSha256: cleanSha, // unused by the BMFF builder — the v2 hash replaces it
    fetchTimestamp,
    probeTokenSizes: estimatedTsaTokenSizes,
    appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion(cleanSha) : null,
    transcript,
    identity: identityAssertionFor(chain, signedRecord),
    customAssertions: customAssertions ?? null,
    // 0.18.5 post-field fix: the `standard` block was accepted but never
    // forwarded — the video claim thumbnail silently never embedded. Wire
    // it, plus the periodic pair-still ingredients (each fail-closed
    // upstream; absent stays absent).
    thumbnailJpeg: standard?.thumbnailJpeg ?? null,
    videoStills: standard?.videoStills ?? null,
    // The photo and PNG arms have always declared c2pa.created with
    // digitalSourceType digitalCapture; this arm never did, so a sealed
    // video said less about its own origin than a sealed still of the same
    // scene. Downstream tools read digitalSourceType before anything else,
    // and a capture that does not state it invites the reader to guess.
    createdDeclaration: { when: signedRecord.capturedAt },
  };

  let fixed: number | null = null;
  let hash: Uint8Array = new Uint8Array(32); // placeholder — round 1 only sizes the store
  // 0.18.6: 8 → 12 rounds. The builder now overshoots the 1–5-byte
  // unpaddeable gap (see buildC2paStoreBmff), ratcheting the target by +5
  // per unlucky token-size draw; 12 rounds absorb a run of those while each
  // signing round stays exactly one signature (one biometric evaluation on
  // a biometric-bound key).
  for (let round = 0; round < 12; round++) {
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
  /** Cached Bitcoin tip (src/lib/beacon.ts) — signed time lower bound (0.10.0). */
  beacon?: BeaconCommitment | null;
  /** PQ record-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /** Face check outcome (0.11.1) — boolean only, never biometrics; null when no check was requested (always since 0.22.0 — the capture-time check was removed). */
  biometricGatePassed?: boolean | null;
  /** TSA token source override (default: live network fetchers). Lab seam for deterministic manifests. */
  fetchTimestamp?: C2paManifestParams['fetchTimestamp'];
  /** Raw CaptureKit sensor JSONL (WS2 Phase 2 §3) — committed as com.verify.poseTrace. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot (WS2 Phase 2 §2) — when CaptureKit ran. */
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
  /** Video stereo-pair claims (0.13.0 §8, commitStereoVideoArtifacts) — the
      pairsCommitted/pairsMissed/hardwareCost counts + pairs-root, signed
      into the context tree. */
  stereoClaims?: ContextClaim[] | null;
  /** 0.18.5 post-field: the periodic pair UW frames as viewable manifest
      ingredients — the raw vaulted pair JPEG bytes + anchors. Each is
      hashed here and embedded with a ≤512px lead (fail-closed per still:
      a still that fails to process is omitted + logged, the seal goes on).
      Bounded to EMBEDDED_VIDEO_STILLS evenly spaced across the take; the
      vault holds every pair regardless — embedding is the lead, the vault
      is the measurement. */
  videoStills?: { bytes: Uint8Array; pairIndex: number; hostSeconds: number | null }[] | null;
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
  // Capture-integrity signals (0.9.3) — self-reported, signed, bounded.
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
  // 0.19.0: record-only PQ by design — the COSE claim carries no verifyPq
  // entry; this declaration (inside the signed payload) tells the verifier.
  record.pqScope = 'record';

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
  // 0.20.5 (c): biometric hold ceremony — identical to the photo arm (the
  // SDK gate is below, after the video-stills/thumbnail prep; the 30 s
  // vault TTL covers that prep comfortably).
  const sdkArmWanted = UPSTREAM_SIGNING_EXPERIMENT && Platform.OS === 'ios' && sdkSigningExperimentActive() && mime === 'video/mp4';
  let bioHoldActive = false;
  if (sdkArmWanted && params.key.biometricBound) {
    bioHoldActive = await enclaveSealBioHold('Authorize signing this capture');
    if (!bioHoldActive) {
      logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'info', message: 'SDK signing skipped — biometric key, but the held-context ceremony is unavailable on this native build; hand-rolled path used (its own prompt) (video)' });
    }
  }
  const recordSignPayload = bioHoldActive && params.key.signPayload
    ? (() => {
        const expected = payloadBytes(record);
        const signPayload = params.key.signPayload!;
        return async (payload: Uint8Array) => {
          if (!equalBytes(payload, expected)) {
            throw new Error('held-bio payload mismatch — refusing to sign a payload the scan did not cover');
          }
          return signPayload(payload);
        };
      })()
    : params.key.signPayload;
  let signedRecord: AttestationRecord;
  try {
    signedRecord = await signRecord(record, params.key.signDigest, recordSignPayload, params.pq);
  } catch (e) {
    if (bioHoldActive) enclaveSealBioRelease();
    throw e;
  }

  // 0.18.5 post-field: the periodic pair frames as componentOf ingredients.
  // The embedded bytes ARE the vaulted pair JPEG (≤640×480, capture-side
  // byte cap) — lead and measurement coincide, and the data hash commits
  // the same bytes. Fail-closed per still; the bound keeps the file lean
  // (the vault holds every pair — embedding is the viewing surface).
  let videoStillsStd: StandardAssertions['videoStills'] = null;
  if (params.videoStills && params.videoStills.length > 0) {
    const stills: NonNullable<StandardAssertions['videoStills']> = [];
    for (const still of params.videoStills.slice(0, EMBEDDED_VIDEO_STILLS_MAX)) {
      try {
        if (!still.bytes || still.bytes.length === 0) throw new Error('empty pair frame');
        stills.push({
          thumbnailJpeg: still.bytes,
          fullResSha256: sha256Hex(still.bytes),
          pairIndex: still.pairIndex,
          hostSeconds: still.hostSeconds,
        });
      } catch (e) {
        logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'failed', message: `video pair-still ingredient omitted: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    videoStillsStd = stills.length > 0 ? stills : null;
  }

  const videoThumb = await videoThumbnailJpeg(params.videoUri);

  // 0.19.0 c2pa-swift migration slice, video (BMFF) path — compile-time
  // gated like the photo path. SDK sign → SELF-VERIFY through the same
  // verifier any recipient runs (bmff v3 binding included) → any failure
  // falls back to the hand-rolled path with a diagnostic. Pair stills ride
  // as v3 ingredient thumbnail resources + com.verify.video-stills hash
  // commitments; chunk maps/poseTrace ride as JSON custom assertions.
  // 0.20.5 (c): the biometric gate moved up to the hold ceremony; bio keys
  // enter this arm exactly when the hold is live.
  if (sdkArmWanted && (!params.key.biometricBound || bioHoldActive)) {
    try {
      const sdkChain = params.certChainOverride ?? (await getDeviceCertChain()).chain;
      const cleanSha = sha256(stripped);
      // 0.20.4 (field, SDK-sealed videos amber "not provided"): this arm
      // never passed the App Attest assertion — the photo arm always did.
      // Parity, same pattern: the helper returns the JSON document as
      // bytes; the SDK serializes it as CBOR like every other assertion it
      // writes. (Org identity stays off the SDK path — see the photo arm's
      // note: the telemetry-hash binding is not computable pre-signing
      // through c2pa-rs.)
      const aaBytes = params.key.backend === 'secure-enclave-attested' ? await getAttestationAssertion(cleanSha) : null;
      const sdk = await signSourceKitAssetSecureEnclave(stripped, 'video/mp4', {
        appName: `Source Kit/${appVersion()} (com.verify.camera)`,
        title: `verify-${signedRecord.capturedAt.replace(/[:.]/g, '-')}.mp4`,
        telemetry: signedRecord as unknown as Record<string, unknown>,
        appAttest: aaBytes ? (JSON.parse(new TextDecoder().decode(aaBytes)) as Record<string, unknown>) : null,
        customAssertions: phase2.customAssertions,
        thumbnailJpeg: videoThumb ?? null,
        videoStills: videoStillsStd,
        certChainDer: sdkChain,
        enclaveKeyTag: params.key.enclaveKeyTag ?? null,
        tsaUrls: configuredTsaUrls(), // 0.20.6: full witness pool, fallback order
        heldBioContext: params.key.biometricBound, // 0.20.5: ride the vaulted scan
      });
      const selfCheck = await verifyVideoBytes(sdk.signedBytes);
      if (selfCheck.verdict === 'INTACT' && selfCheck.c2pa?.assetHashFailure === null) {
        logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'info', message: `upstream SDK signing path used, self-verified INTACT (migration experiment, video${sdk.untimedTsaRetry ? `; TSA fetch failed (${sdk.tsaError ?? 'reason not surfaced'}) — sealed untimed, no RFC 3161 countersignature on this claim` : sdk.tsaWitness ? `; RFC 3161 countersigned by ${sdk.tsaWitness} (0.20.8 witness named — the pool's iteration shows in the log on success too)` : ''})` });
        return { signedVideoBytes: sdk.signedBytes, record: signedRecord, disclosure: phase2.disclosure, chunkMaps: phase2.chunkMaps };
      }
      const quarantined = await quarantineSdkOutput(sdk.signedBytes, 'mp4');
      // 0.20.4: name the failing axis (see the photo arm above) — the video
      // SDK path failed exactly this way in the field and the bare verdict
      // was not enough to localize it.
      logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'failed', message: `upstream SDK signing self-check failed (verdict ${selfCheck.verdict}; assertion binding ${selfCheck.c2pa ? (selfCheck.c2pa.claimAssertionsMatch ? 'matches' : 'MISMATCH') : 'n/a'}; asset hash ${selfCheck.c2pa?.assetHashFailure ?? 'intact'}${selfCheck.checksNotPerformed.length > 0 ? `; first unchecked: ${selfCheck.checksNotPerformed[0]}` : ''}, video) — hand-rolled path used${quarantined ? `; rejected SDK bytes kept at ${quarantined} (forensics only, never sealed)` : ''}` });
    } catch (e) {
      logDiagnostic({ t: Date.now(), kind: 'video', outcome: 'failed', message: `upstream SDK signing threw (${e instanceof Error ? e.message : String(e)}, video) — hand-rolled path used` });
    } finally {
      if (bioHoldActive) enclaveSealBioRelease();
    }
  }

  // Genuine C2PA embed; out-of-scope containers degrade to sidecar honestly.
  let signedVideoBytes: Uint8Array | undefined;
  try {
    signedVideoBytes = await embedC2paInBmff(stripped, signedRecord, params.key, mime, null, params.certChainOverride, params.pq, params.fetchTimestamp ?? fetchTimestampTokensBounded, phase2.customAssertions, { thumbnailJpeg: videoThumb, videoStills: videoStillsStd });
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
  /** Cached Bitcoin tip (src/lib/beacon.ts) — signed time lower bound (0.10.0). */
  beacon?: BeaconCommitment | null;
  /** PQ record-signature layer — software key; hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /** Face check outcome (0.11.1) — boolean only, never biometrics; null when no check was requested (always since 0.22.0 — the capture-time check was removed). */
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
  // Capture-integrity signals (0.9.3) — self-reported, signed, bounded.
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
  // 0.19.0: record-only PQ by design — the COSE claim carries no verifyPq
  // entry; this declaration (inside the signed payload) tells the verifier.
  record.pqScope = 'record';

  // WS2 Phase 2 §1/§2: audio gets the IDENTICAL assertion set (parity) —
  // the m4a's single audio track demuxes to a one-track v2 commitment.
  // There is no native stream-hash commitment on the audio recorder path,
  // so there is no cross-check to run; the binding is delivery-file, as
  // the assertion itself declares. The recorder's IMU sink (modules/
  // audio-capture) supplies the gyro JSONL behind params.sensorLogText, so
  // the poseTrace below commits exactly like video; the named audio
  // exceptions (no ring frames, no A/V desync) are listed in
  // parity with the stills path.
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
 * countersignature — under a fresh ONE-TIME signing key (re-keyed, 0.9.0:
 * the long-lived device key is deliberately NOT used), while removing the
 * identifying values only (0.18.6): byline, organization, location, Wi-Fi,
 * signing-key linkage. Non-identifying evidence — motion, heading,
 * barometrics, pose trace, depth, capture-evidence states, device model —
 * is carried verbatim from the source record when the caller passes it.
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
  /** The source record's non-identifying context, carried into the copy (0.18.6). */
  source?: DeidSourceContext;
}): Promise<{ signedPhotoBytes: Uint8Array; record: AttestationRecord }> {
  // Strip the old manifest AND any EXIF/IPTC metadata — the redacted record is
  // only half the job if the pixel container still carries make/model/timestamps.
  // stripMetadata is lossless: pixels (and thus the integrity binding) are untouched.
  const originalBytes = await readFileBytes(params.photoUri);
  const cleanBytes = stripMetadata(stripManifest(originalBytes));
  const fields = [...DEID_FIELDS, 'exif'];
  // Re-keyed: params.key is intentionally NOT used for signing (0.9.0).
  const { key, chain } = await deidEphemeralKey();
  // 0.18.6: the simultaneous second-camera frame + claim thumbnail carry
  // into the copy — non-identifying evidence, parsed from the original.
  const carry = secondCameraCarry(originalBytes, 'jpeg');

  const record = buildRecord({
    assetSha256: sha256Hex(cleanBytes),
    assetBytes: cleanBytes.length,
    mime: 'image/jpeg',
    kind: 'photo',
    capturedAt: params.capturedAt ?? new Date().toISOString(),
    appVersion: appVersion(),
    deviceModel: params.source?.deviceModel ?? null,
    platform: Platform.OS,
    identity: 'redacted',
    context: deidContext(params.source),
    publicKeyBase64: key.publicKeyBase64,
    fingerprint: key.fingerprint,
  });
  record.orgCredential = null; // an anonymised copy never carries the org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  const signedPhotoBytes = await embedC2paInJpeg(
    cleanBytes, signedRecord, key, chain, null, null, null,
    carry && (carry.thumbnailJpeg || carry.secondaryView)
      ? { thumbnailJpeg: carry.thumbnailJpeg, secondaryView: carry.secondaryView }
      : null,
  );
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
