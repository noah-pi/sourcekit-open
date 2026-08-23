// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Attestation orchestration: media file → signed media file + record.
 *
 * Photos (JPEG): a C2PA manifest embedded in the file as an APP11/JUMBF
 *                store: CBOR claim, c2pa.hash.data hard binding, COSE_Sign1
 *                signature with the device certificate. The Source Kit record
 *                rides inside as the com.verify.telemetry assertion.
 * Video (MP4):   the same manifest as a C2PA uuid box after ftyp, hard-bound
 *                by c2pa.hash.bmff.v2, with stco/co64 chunk offsets repaired.
 *                Out-of-scope containers fall back to the sidecar attestation
 *                rather than failing the capture.
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
import { buildC2paSegment, buildC2paStoreBmff, buildC2paStorePng, bmffHashAssertionCbor, bmffMandatoryExclusions, hashBmffV2, extractC2paStore, parseManifest, type C2paManifestParams, type TranscriptAssertion } from '../c2pa/c2pa';
import { C2PA_UUID_BYTES, embedUuidStore, stripC2paFromBmff, extractC2paStoreBmff } from '../c2pa/bmff';
import { embedCaBx, iendOffset, stripCaBx } from '../c2pa/png';
import { signRecord, sha256Hex } from '../lib/sign';
import { pqPublicBlock, type PqCaptureKey } from '../lib/pq';
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
// Type-only import of the native capture contract (depth fields), erased
// at runtime; this module never loads the camera module's expo glue.
import type { CaptureResult, DepthArtifactMetadata, EvidencePath as CameraEvidencePath } from '../lib/exhibitCamera';

/**
 * The standard-assertion set handed to the embed layer. Each
 * assertion fails closed on its own: a failed compute is absent and logged,
 * and the seal continues.
 */
interface StandardAssertions {
  /** Claim thumbnail, ≤512px JPEG (photos + video). */
  thumbnailJpeg?: Uint8Array | null;
  /** The capture-time pHash, 16 hex chars → c2pa.soft-binding (photos). */
  phashHex?: string | null;
  /** GDepth depthmap assertion payload (photos, when depth recorded). */
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
  /** The sealed artifact set → c2pa.hash.collection.data (photos, when depth recorded). */
  collectionAssets?: { uri: string; bytes: Uint8Array; dcFormat?: string | null }[] | null;
  /** Secondary viewpoint → c2pa.ingredient.v3 + ingredient thumbnail (photos, when a secondary frame exists). */
  secondaryView?: {
    thumbnailJpeg: Uint8Array;
    fullResSha256: string;
    width?: number | null;
    height?: number | null;
  } | null;
  /** Periodic video pair stills, one componentOf ingredient each. */
  videoStills?: {
    thumbnailJpeg: Uint8Array;
    fullResSha256: string;
    pairIndex: number;
    hostSeconds: number | null;
  }[] | null;
}

/**
 * The resolved depth artifact for this capture: the CaptureResult's depth
 * EvidencePath plus its committed sha256 and metadata. The bytes live on
 * disk; attest reads them, re-verifies the committed hash once, and seals the
 * claims. A 'never-recorded' EvidencePath is a signed statement of absence
 * carrying its verbatim reason.
 */
export interface DepthCommitInput {
  artifact: CameraEvidencePath;
  /** Undefined on native early-exit branches: nothing is committed here. */
  sha256?: string | null;
  metadata?: DepthArtifactMetadata | null;
}

/**
 * Resolves the depth artifact to commit from a CaptureResult: the
 * full-res path's primary map first, the degraded path's `depth` as fallback.
 * The secondary map is not committed; there is one c2pa.depthmap per claim
 * and the collection is {photo, primary depth}. Null when the CaptureResult
 * carries no depth field.
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
 * The resolved secondary viewpoint for this capture: the CaptureResult's
 * full-res ultra-wide EvidencePath plus its committed sha256 and dimensions.
 * Same handling as depth: attest reads the bytes, re-verifies the committed
 * hash, and seals both a 512px embedded thumbnail and the full-res data hash
 * as a componentOf ingredient. A 'never-recorded' or 'error' state produces
 * no ingredient; the reason rides the stereo artifact claims.
 */
export interface SecondaryCommitInput {
  artifact: CameraEvidencePath;
  /** Undefined on native early-exit branches: no ingredient is emitted. */
  sha256?: string | null;
  dimensions?: { width: number; height: number } | null;
}

/**
 * Resolves the secondary viewpoint to commit from a CaptureResult. Null when
 * the CaptureResult carries no secondary field.
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
   * Disclosure commitment for the vault store: Sealed-profile bundle plus
   * master seed. Vault-only; the seed never enters the manifest or an export.
   * sealQueue persists it via src/disclosure/burn.ts.
   */
  disclosure?: SealedCaptureDisclosure | null;
  /**
   * Per-track chunk maps behind the com.verify.streamedChunks v2 assertion
   * (video/audio). Kept in the vault record, exported as the proof-bundle
   * sidecar.
   */
  chunkMaps?: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> | null;
}

function deviceModel(): string | null {
  return Device.modelName ?? Device.modelId ?? null;
}

// ---------------------------------------------------------------------------
// Commit-at-capture + unified media assertions
//
// Parity: photo, video, and audio seals carry the same assertion set —
// com.verify.contextTree, com.verify.streamedChunks, com.verify.poseTrace
// (whenever an IMU trace exists), and com.verify.captureIntegrity. The
// divergences by media kind are the named exceptions in
// docs/MEDIA-PARITY.md: stills have no ENF trace and no streamed chunks
// beyond the zero-track structural assertion; audio has no ring-buffer
// frames and no A/V desync; photos have no A/V desync. The audio recorder
// logs gyro during every take (modules/audio-capture IMU sink), so audio
// poseTrace is absent only when the device provided no motion data, stated
// three-state in the record's captureEvidence.
// ---------------------------------------------------------------------------

/** The capture-evidence toggle snapshot, when a CaptureKit session ran (else null). */
export interface EvidenceEnabledSnapshot {
  ring: boolean;
  rawPcm: boolean;
  sensors: boolean;
}

/**
 * evidenceComplete, derived from the three-state evidence paths (E.04):
 * complete when no applicable sink is in the enabled-but-failed (null) state.
 * 'never-recorded' sinks do not make a capture incomplete. Applicability: the
 * ring is a stills sink, raw PCM applies to video sessions and audio takes,
 * the sensor log applies to every CaptureKit kind. Null means no CaptureKit
 * session ran.
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
    // Stereo-capture artifact claims (Spec-Camera-Module-0.13): built by
    // commitStereoArtifacts from the CaptureResult handoff; hash, error, and
    // never-recorded states become context.stereo-* claim values.
    ...(stereoClaims?.length ? { stereoClaims } : {}),
    // sensorLogRecorded reflects CaptureKit sensor-log presence only, never a
    // motion verdict or poseTrace from another path. The EvidencePath third
    // state is the string 'never-recorded', so the typeof check must exclude
    // that sentinel explicitly.
    sensorLogRecorded:
      typeof record.context.captureEvidence?.sensorLogPath === 'string' &&
      record.context.captureEvidence.sensorLogPath !== 'never-recorded',
    motionVerdict: record.context.motion?.verdict ?? null,
  });
}

export interface Phase2AssertionSet {
  customAssertions: { label: string; data: unknown }[];
  disclosure: SealedCaptureDisclosure;
  /** The poseTrace assertion, when an IMU trace existed. */
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
  /** Stereo-artifact context claims from commitStereoArtifacts. */
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
 * Photo path: the ≤512px claim thumbnail, same recipe as the vault grid
 * (ImageManipulator over the on-disk draft, lossy JPEG). A failure logs and
 * omits the assertion; the seal still completes.
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
 * The capture-time pHash, computed before signing so the c2pa.soft-binding
 * lands under the COSE claim signature. vaultFs computes its own copy
 * post-embed as a cross-check. 32×32 luma → pHashFromGray32.
 */
async function photoPhashHex(photoUri: string): Promise<string | null> {
  try {
    const tiny = await ImageManipulator.manipulateAsync(photoUri, [{ resize: { width: 32, height: 32 } }], {
      compress: 0.9,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    });
    if (!tiny.base64) throw new Error('32×32 encode returned no data');
    // 32×32 RGBA is 4 KB, so 1 MB of decode headroom is ample. useTArray is
    // required: jpeg-js otherwise allocates `data` via Buffer.alloc, which
    // does not exist under Hermes.
    const decoded = jpegDecode(base64ToBytes(tiny.base64), { maxMemoryUsageInMB: 1, useTArray: true });
    if (decoded.width !== 32 || decoded.height !== 32) {
      throw new Error(`32×32 decode returned ${decoded.width}×${decoded.height}`);
    }
    const rgba = decoded.data;
    const gray = new Uint8Array(32 * 32);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      // ITU-R 601 luma, as the reference pHash implementations use.
      gray[i] = Math.round(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114);
    }
    return pHashFromGray32(gray);
  } catch (e) {
    logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `c2pa.soft-binding omitted: ${e instanceof Error ? e.message : String(e)}` });
    return null;
  }
}

/**
 * Video path: a frame ~0.5 s in, resized to a ≤512px JPEG, the same
 * source as the vault grid thumbnail. When the frame cannot be read the
 * manifest ships without a claim thumbnail.
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
  certChainOverride?: Uint8Array[];
  /** Device integrity signals, signed as a self-reported assertion. */
  integritySignals?: DeviceIntegritySignals | null;
  /** Sanitized camera EXIF (src/lib/exif.ts), signed as com.verify.exif. */
  exif?: Record<string, number | string> | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts): signed time lower bound. */
  beacon?: BeaconCommitment | null;
  /** PQ dual-signature layer, software key. Hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /**
   * Result of the OS biometric check run at capture start when the toggle is
   * on; null when it was off. The flag only: no face geometry is stored.
   */
  biometricGatePassed?: boolean | null;
  /** Raw CaptureKit sensor JSONL, committed as com.verify.poseTrace. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot, when CaptureKit ran. */
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
  /**
   * Capture-result context claims (Spec-Camera-Module-0.13): built by
   * commitStereoArtifacts from the CaptureResult's three-state artifact paths
   * (context.stereo-*) plus sealQueue's full-res extras
   * (context.fullres-still / context.fullres-secondary /
   * context.capture-settings). captureCommit admits exactly those claim IDs
   * and throws on any other.
   */
  stereoClaims?: ContextClaim[] | null;
  /** The resolved depth artifact. See DepthCommitInput. */
  depth?: DepthCommitInput | null;
  /** The resolved secondary viewpoint. See SecondaryCommitInput. */
  secondary?: SecondaryCommitInput | null;
}): Promise<AttestResult> {
  const cleanBytes = await readFileBytes(params.photoUri);
  // Re-attesting an already-signed photo signs the clean bytes only.
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

  record.deviceIntegrity = params.integritySignals ?? null;
  // Capture-integrity signals: self-reported, signed.
  record.captureIntegrity = {
    captureToSignatureMs: Math.max(0, Date.now() - Date.parse(record.capturedAt)),
    sensorTiming: params.context.sensorTiming ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    note: 'self-reported' as const,
  };
  // Time lower bound from whatever beacon tip is cached, fresh or stale.
  // Never fetched here, so the shutter stays off the network. Absent when
  // nothing is cached.
  record.beacon = params.beacon ?? null;
  // A capture signed off the device identity carries no org credential: the
  // org chain belongs to the device key.
  record.orgCredential = params.certChainOverride ? null : await orgCredentialForRecord();
  if (params.key.biometricBound) record.biometricBound = true;
  // The PQ public key is committed inside the signed payload; that binding is
  // what makes the dual signature meaningful (src/lib/pq.ts).
  record.pqKey = params.pq ? pqPublicBlock(params.pq.publicKey, params.pq.enrolledAt) : null;
  // The parity assertion set. Stills commit the zero-track streamedChunks
  // assertion: a JPEG has no elementary streams and the hard binding covers
  // the whole file. Named stills exception in docs/MEDIA-PARITY.md.
  const phase2 = phase2Assertions({
    record,
    kind: 'photo',
    streamedV2: buildStreamedChunksV2ForStill(),
    chunkMaps: null,
    sensorLogText: params.sensorLogText ?? null,
    evidenceEnabled: params.evidenceEnabled ?? null,
    stereoClaims: params.stereoClaims ?? null,
  });
  // The depth artifact. 'never-recorded' and 'error' commit a signed
  // statement of absence with the verbatim reason; 'path' reads the bytes
  // from disk, re-verifies the committed sha256, then commits
  // c2pa.depthmap.GDepth (the map's normalization window is GDepth's
  // Near/Far) and set membership (photo + depth map) via
  // c2pa.hash.collection.data. Any gap omits the assertions and logs.
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
        // Cross-check the committed hash against the bytes on disk; a
        // mismatched artifact is omitted.
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
          // Disparity maps are inverse-depth encodings, so RangeInverse.
          format: md.mapSemantics === 'disparity' ? 'RangeInverse' : 'RangeLinear',
          // The min/max normalization window is the encoding's value bounds,
          // which is what GDepth's Near/Far describe. Units and MeasureType
          // stay absent because the capture side does not state them.
          near: md.normalizationMin,
          far: md.normalizationMax,
          manufacturer: Device.manufacturer,
          model: deviceModel(),
          software: `ExhibitA ${appVersion()}`,
          imageWidth: md.photoWidth,
          imageHeight: md.photoHeight,
        };
        depthStd.collectionAssets = [
          // The photo member hashes the clean bytes; hashing the signed file
          // would be circular. Verifiers reconstruct the clean bytes via the
          // hash.data exclusion.
          { uri: 'photo.jpg', bytes: stripped, dcFormat: 'image/jpeg' },
          { uri: 'depth.png', bytes, dcFormat: md.mime },
        ];
      } catch (e) {
        logDiagnostic({ t: Date.now(), kind: 'photo', outcome: 'failed', message: `depth assertions omitted: ${e instanceof Error ? e.message : String(e)}` });
        delete record.context.depth; // only commit it when the artifact verified
        depthStd.depthmap = null;
        depthStd.collectionAssets = null;
      }
    }
  }
  // The secondary viewpoint as a componentOf ingredient. Same handling as
  // depth: 'path' reads the bytes, re-verifies the committed sha256, then
  // commits the embedded 512px thumbnail and the full-res data hash (those
  // bytes stay in the vault). 'never-recorded' and 'error' produce no
  // ingredient. Any gap omits and logs.
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
  // PHash and claim thumbnail, computed pre-signing so both land under
  // the COSE claim signature. Each fails closed on its own.
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
 * The org identity assertion is emitted exactly when an org credential rides
 * the COSE chain (length > 1) and the record carries the org block. deID
 * copies (ephemeral chain, orgCredential stripped) and personal captures emit
 * none.
 */
function identityAssertionFor(chain: Uint8Array[], record: AttestationRecord): { org: string; role: string } | null {
  if (chain.length < 2 || !record.orgCredential) return null;
  // Issuer only: it is the top cert's subject name by construction, which is
  // what verifyChain surfaces as topSubject. A subject fallback would name the
  // leaf and mismatch at verification.
  return { org: record.orgCredential.issuer ?? 'organization', role: 'organization' };
}

/**
 * Embeds a signed record into clean JPEG bytes as a C2PA manifest. The record
 * travels as the com.verify.telemetry JSON assertion, hard-bound by
 * c2pa.hash.data and the COSE signature, countersigned by an RFC 3161 TSA
 * when the network allows. The x5chain is the org credential chain when
 * installed, else the self-signed device cert.
 */
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
      // The post-quantum signature rides the record, which signs its own
      // canonical JSON and commits asset.sha256.
      pq: null,
      certChain: chain,
      cleanFileSha256: sha256(stripped),
      fetchTimestamp: fetchTimestampTokensBounded,
      probeTokenSizes: estimatedTsaTokenSizes,
      exif: exif ?? null,
      identity: identityAssertionFor(chain, signedRecord),
      // The attestation is bound to this exact signing key, so attach it only
      // when the active signer is the attested key.
      appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion() : null,
      customAssertions: customAssertions ?? null,
      // Data contract, on by default; a standard assertion the caller
      // could not build is absent.
      thumbnailJpeg: standard?.thumbnailJpeg ?? null,
      assetTypes: ['image'],
      trainingMiningDenied: true,
      phashHex: standard?.phashHex ?? null,
      emitC2paMetadata: true,
      createdDeclaration: { when: signedRecord.capturedAt },
      // Depth assertions, absent unless attestPhoto verified an artifact.
      depthmap: standard?.depthmap ?? null,
      collectionAssets: standard?.collectionAssets ?? null,
      // Secondary-viewpoint ingredient, absent unless a secondary frame verified.
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
      // The post-quantum signature rides the record, which signs its own
      // canonical JSON and commits asset.sha256.
      pq: null,
      certChain: chain,
      cleanFileSha256: sha256(stripped),
      fetchTimestamp: fetchTimestampTokensBounded,
      probeTokenSizes: estimatedTsaTokenSizes,
      identity: identityAssertionFor(chain, signedRecord),
      appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion() : null,
      // Data contract. The PNG path receives pixels-only bytes with
      // no file URI, so there is no source for a claim thumbnail or pHash,
      // and no EXIF for c2pa.metadata.
      assetTypes: ['image'],
      trainingMiningDenied: true,
      createdDeclaration: { when: signedRecord.capturedAt },
    },
    insertOffset
  );
  return embedCaBx(stripped, store);
}

/**
 * Signs a clean, pixels-only PNG (re-encoded from a JPEG, so EXIF is already
 * gone) with a fresh C2PA manifest. Used by the share flow's format change.
 * `capturedAt` carries over the original capture time instead of stamping now.
 */
export async function attestPng(params: {
  pngBytes: Uint8Array;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  capturedAt?: string;
  certChainOverride?: Uint8Array[];
  /** PQ dual-signature layer, software key. Hedges P-256 cryptanalysis only. */
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
 * De-identify re-key: the anonymized copy signs with a fresh one-time key, so
 * its fingerprint shares nothing with the device's long-lived identity. The
 * copy therefore has no Enclave backing, no hardware attestation, no org
 * credential, and no PQ layer (the long-lived ML-DSA key would re-link it);
 * the record's `deidentified.rekeyed` marker records that.
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

/** Fields every de-identified copy strips: identifying values only.
    Non-identifying evidence (motion summary, pose trace, heading, pressure,
    altitude, depth, ENF anchor, captureEvidence sink states, device model) is
    carried verbatim from the source record the caller passes in. Key linkage
    is stripped by the ephemeral re-key; org, Wi-Fi, and location are
    redacted; audio also drops the transcript. */
const DEID_FIELDS = ['identity', 'organization', 'location', 'wifi', 'signing-key-linkage'];

/** The source record's non-identifying context, carried into the copy so a
    de-identified share still shows the motion trace, second views, and
    environment it recorded. Absent when the caller has no source record; the
    copy then states nulls, and `deidentified.fields` names only what the
    operation removed. */
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
    // Wi-Fi claim is redacted alongside location, explicitly rather than absent.
    wifi: 'redacted',
    headingDeg: src?.headingDeg ?? null,
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
 * The second-camera stills and claim thumbnail a de-identified re-seal
 * carries forward, parsed from the original file's own manifest: the same
 * lead bytes and full-res commitment ride into the copy. Only boxes the
 * original signed claim referenced are carried; an unreferenced box was
 * attached post-signing. An unparseable source carries nothing.
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
            // The ingredient does not store the pair's PTS anchor.
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

/** Cap on periodic pair frames embedded as ingredient leads in the video
    manifest; the caller spaces them evenly and always includes first and
    last. The vault holds every pair. */
const EMBEDDED_VIDEO_STILLS_MAX = 8;

/**
 * De-identify and re-sign into PNG: the share flow's privacy-safe format
 * conversion. Strips the same fields as deidentifyPhoto; the PNG re-encode has
 * already dropped the JPEG's EXIF.
 */
export async function deidentifyPhotoToPng(params: {
  pngBytes: Uint8Array;
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim holds. */
  capturedAt?: string;
  /** The source record's non-identifying context, carried into the copy. */
  source?: DeidSourceContext;
}): Promise<{ signedPngBytes: Uint8Array; record: AttestationRecord }> {
  const cleanBytes = stripCaBx(params.pngBytes);
  const fields = [...DEID_FIELDS, 'exif'];
  // Re-keyed: params.key is not used for signing.
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
  record.orgCredential = null; // anonymized copies carry no org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  const signedPngBytes = await embedC2paInPng(cleanBytes, signedRecord, key, chain);
  return { signedPngBytes, record: signedRecord };
}

/**
 * De-identify and re-sign for BMFF media (video and audio). Strips the
 * identifying values (byline, organization, location, Wi-Fi, signing-key
 * linkage, and for audio the transcript) and re-signs the same media bytes.
 * Non-identifying evidence (motion, heading, barometrics, pose trace, depth,
 * ENF anchor, capture-evidence states, device model) is carried verbatim from
 * the source record when the caller passes it. The `deidentified` marker
 * records the redaction. The original is untouched.
 */
export async function deidentifyBmff(params: {
  /** Clean or already-signed BMFF bytes; signed input is stripped first. */
  bytes: Uint8Array;
  mime: string; // video/mp4, video/quicktime, audio/mp4
  kind: 'video' | 'audio';
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim holds. */
  capturedAt?: string;
  /** The source record's non-identifying context, carried into the copy. */
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
  // Re-keyed: params.key is not used for signing.
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
  record.orgCredential = null; // anonymized copies carry no org credential
  record.deidentified = { at: new Date().toISOString(), fields, rekeyed: true };

  const signedRecord = await signRecord(record, key.signDigest, key.signPayload);
  // transcript stays null in a de-identified copy. The second-camera stills
  // and claim thumbnail do carry over, parsed from the original manifest.
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
 * depends on the uuid box's size but never on the hash value (a fixed-size
 * bstr). The loop therefore converges: build with the current hash, embed,
 * recompute, with the layout length pinned and padding absorbing TSA
 * variance. Finalize re-fetches TSA tokens each signing round; a 1-5 byte
 * shortfall against the pin is unpaddeable, so the builder overshoots to +5
 * and this loop re-pins to the overshot length.
 */
async function embedC2paInBmff(
  stripped: Uint8Array,
  signedRecord: AttestationRecord,
  key: DeviceSigner,
  mime: string,
  transcript: TranscriptAssertion | null = null,
  certChainOverride?: Uint8Array[],
  pq?: PqCaptureKey | null,
  /** TSA token source. Defaults to the live network fetchers; overridable so
      the lab can pin a deterministic token layout (F3, docs/SECURITY.md). */
  fetchTimestamp: C2paManifestParams['fetchTimestamp'] = fetchTimestampTokensBounded,
  /** parity assertions (com.verify.* JUMBF boxes). */
  customAssertions?: { label: string; data: unknown }[] | null,
  /** Standard assertions (claim thumbnail for video). */
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
    // The post-quantum signature is carried on the record, which signs its
    // own canonical JSON and commits asset.sha256.
    pq: null,
    certChain: chain,
    cleanFileSha256: sha256(stripped), // unused by the BMFF builder; the v2 hash replaces it
    fetchTimestamp,
    probeTokenSizes: estimatedTsaTokenSizes,
    appAttest: key.backend === 'secure-enclave-attested' ? await getAttestationAssertion() : null,
    transcript,
    identity: identityAssertionFor(chain, signedRecord),
    customAssertions: customAssertions ?? null,
    // Claim thumbnail plus the periodic pair-still ingredients; each is
    // fail-closed upstream, so absent stays absent.
    thumbnailJpeg: standard?.thumbnailJpeg ?? null,
    videoStills: standard?.videoStills ?? null,
  };

  let fixed: number | null = null;
  let hash: Uint8Array = new Uint8Array(32); // placeholder; round 1 only sizes the store
  // 12 rounds. The builder overshoots the 1-5-byte unpaddeable gap (see
  // buildC2paStoreBmff), ratcheting the target by +5 per unlucky token-size
  // draw, and each round is exactly one signature (one biometric evaluation
  // on a biometric-bound key).
  for (let round = 0; round < 12; round++) {
    const store = await buildC2paStoreBmff(params, bmffHashAssertionCbor(hash, exclusions), fixed);
    const embedded = embedUuidStore(stripped, store);
    const actual = hashBmffV2(embedded, exclusions);
    // Sizing rounds (fixed === null) carry a dummy signature; only a
    // re-signed, on-target round may be returned.
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
  certChainOverride?: Uint8Array[];
  integritySignals?: DeviceIntegritySignals | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts): signed time lower bound. */
  beacon?: BeaconCommitment | null;
  /** PQ dual-signature layer, software key. Hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /** Face check outcome, boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
  /** TSA token source override (default: live network fetchers). Lab seam for deterministic manifests. */
  fetchTimestamp?: C2paManifestParams['fetchTimestamp'];
  /** Raw CaptureKit sensor JSONL, committed as com.verify.poseTrace. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot, when CaptureKit ran. */
  evidenceEnabled?: EvidenceEnabledSnapshot | null;
  /** Video stereo-pair claims: pairsCommitted/pairsMissed/hardwareCost
      counts and pairs-root, signed into the context tree. */
  stereoClaims?: ContextClaim[] | null;
  /** Periodic pair UW frames as manifest ingredients: the vaulted pair JPEG
      bytes plus anchors. Each is hashed here and embedded with a ≤512px
      lead; a still that fails to process is omitted and logged. Bounded to
      EMBEDDED_VIDEO_STILLS_MAX evenly spaced across the take. */
  videoStills?: { bytes: Uint8Array; pairIndex: number; hostSeconds: number | null }[] | null;
}): Promise<AttestResult> {
  // Whole-file read matches the vault's own seal profile (2-minute cap).
  const rawBytes = await readFileBytes(params.videoUri);
  // Re-attesting an already-signed video signs the clean bytes only.
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
  record.deviceIntegrity = params.integritySignals ?? null;
  // Capture-integrity signals: self-reported, signed.
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
  // demuxing the finalized delivery bytes at seal time, the bytes a verifier
  // holds. No capture-time cross-check: the native stream hasher sees
  // pre-encode audio and no video bytes, so its numbers cannot agree with a
  // delivery-file demux.
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

  // The periodic pair frames as componentOf ingredients. The embedded bytes
  // are the vaulted pair JPEG (≤640×480, capture-side byte cap), so the data
  // hash commits the same bytes. Fail-closed per still.
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

  // C2PA embed; out-of-scope containers fall back to the sidecar.
  let signedVideoBytes: Uint8Array | undefined;
  try {
    signedVideoBytes = await embedC2paInBmff(stripped, signedRecord, params.key, mime, null, params.certChainOverride, params.pq, params.fetchTimestamp ?? fetchTimestampTokensBounded, phase2.customAssertions, { thumbnailJpeg: await videoThumbnailJpeg(params.videoUri), videoStills: videoStillsStd });
  } catch (e) {
    console.warn('C2PA video embed skipped (sidecar attestation still signed):', e instanceof Error ? e.message : e);
  }

  return { signedVideoBytes, record: signedRecord, disclosure: phase2.disclosure, chunkMaps: phase2.chunkMaps };
}

/**
 * Audio: the recorder writes a monolithic m4a (BMFF), so the same C2PA embed
 * applies (claim, c2pa.hash.bmff.v2, witnesses), plus the on-device
 * transcript as a signed com.verify.transcript assertion.
 */
export async function attestAudio(params: {
  audioUri: string;
  context: SensorContext;
  identity: { author: string | null; organization: string | null } | 'redacted';
  key: DeviceSigner;
  transcript: TranscriptAssertion | null;
  capturedAt?: string;
  certChainOverride?: Uint8Array[];
  integritySignals?: DeviceIntegritySignals | null;
  /** Cached Bitcoin tip (src/lib/beacon.ts): signed time lower bound. */
  beacon?: BeaconCommitment | null;
  /** PQ dual-signature layer, software key. Hedges P-256 cryptanalysis only. */
  pq?: PqCaptureKey | null;
  /** Face check outcome, boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
  /** Raw sensor JSONL, committed as com.verify.poseTrace when present. */
  sensorLogText?: string | null;
  /** Capture-evidence toggle snapshot, when CaptureKit ran. */
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
  record.deviceIntegrity = params.integritySignals ?? null;
  // Capture-integrity signals: self-reported, signed.
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

  // Audio carries the same assertion set as video: the m4a's single audio
  // track demuxes to a one-track v2 commitment, delivery-file bound. The
  // recorder's IMU sink (modules/audio-capture) supplies the gyro JSONL
  // behind params.sensorLogText, so poseTrace commits like video. Named
  // audio exceptions (no ring frames, no A/V desync) are in
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
 * De-identify and re-sign (photos). Produces a new signed JPEG with the same
 * media hash, the same capture-time claim, and a fresh RFC 3161
 * countersignature, signed by a one-time key rather than the device key. It
 * removes the identifying values only: byline, organization, location, Wi-Fi,
 * signing-key linkage. Non-identifying evidence (motion, heading,
 * barometrics, pose trace, depth, capture-evidence states, device model) is
 * carried verbatim from the source record when the caller passes it.
 *
 * The record carries a `deidentified` marker listing the removed field
 * groups. The vault copy is untouched and the media bytes are bit-identical.
 */
export async function deidentifyPhoto(params: {
  photoUri: string;
  key: DeviceSigner;
  /** Original capture time, carried over so the copy's "captured" claim holds. */
  capturedAt?: string;
  /** The source record's non-identifying context, carried into the copy. */
  source?: DeidSourceContext;
}): Promise<{ signedPhotoBytes: Uint8Array; record: AttestationRecord }> {
  // Strip the old manifest and any EXIF/IPTC metadata; the pixel container
  // would otherwise still carry make, model, and timestamps. stripMetadata is
  // lossless, so pixels and the integrity binding are untouched.
  const originalBytes = await readFileBytes(params.photoUri);
  const cleanBytes = stripMetadata(stripManifest(originalBytes));
  const fields = [...DEID_FIELDS, 'exif'];
  // Re-keyed: params.key is not used for signing.
  const { key, chain } = await deidEphemeralKey();
  // The second-camera frame and claim thumbnail carry into the copy, parsed
  // from the original manifest.
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
  record.orgCredential = null; // anonymized copies carry no org credential
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
// verification chain does not pull this module's expo glue.
