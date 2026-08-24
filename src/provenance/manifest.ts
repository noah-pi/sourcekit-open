// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The Source Kit attestation record: the self-contained provenance statement
 * embedded in every signed photo (JPEG APP11/JUMBF) or written as a sidecar
 * JSON for video. Human-readable by design. The signature proves the media
 * bytes and telemetry are unaltered since signing — not that the scene was
 * real, and not that clock/GPS/sensors told the truth (device-reported claims).
 */

import type { JsonValue } from '../lib/canonical';
import type { BeaconCommitment } from '../lib/beacon';
import type { PqPublicKeyBlock } from '../lib/pq';
import { bytesToHex, bytesToUtf8, concatBytes, hexToBytes } from '../lib/bytes';
import { sha256 } from '@noble/hashes/sha256';

export const ATTESTATION_FORMAT = 'verify-attestation';
export const ATTESTATION_VERSION = 1;

export type MotionVerdict = 'handheld' | 'steady' | 'moving' | 'insufficient-data';

export interface MotionSummary {
  verdict: MotionVerdict;
  /** RMS of gravity-compensated acceleration magnitude, in g. */
  rms: number;
  /** Dominant motion frequency in the 1–25 Hz band, Hz. */
  peakHz: number;
}

export interface LocationClaim {
  lat: number;
  lon: number;
  accuracyM: number | null;
}

/**
 * The Wi-Fi network the phone REPORTED at capture — strictly opt-in, always
 * stripped on the de-identify path. SSID/BSSID are what the OS told the app
 * and are trivially spoofable: a lead a desk weighs, never proof of place.
 * BSSID geo-lookup is desk-side only; the app never resolves it to a map.
 * 'redacted' = the signer opted out (the default); 'unavailable' = opted in
 * but iOS returned nothing. A null field means iOS omitted that attribute.
 */
export interface WifiClaim {
  ssid: string | null;
  bssid: string | null;
}

/**
 * The signed pose trace: a decimated, quantized window of DeviceMotion
 * samples bracketing the shutter (rotation rate, fused attitude, gravity-free
 * acceleration). EVIDENCE a desk cross-checks against the video, never a
 * verdict. Quantization is part of the signed format: rotation 1 mrad/s,
 * attitude 0.1°, accel 0.001 g, timestamps on the decimated `hz` grid.
 * Flat arrays are xyz-interleaved, 3 × `samples`; sample `i` sits at
 * t[i] = capturedAt + (i - anchor) × (1000 / hz) ms.
 */
export interface PoseTrace {
  /** Decimated sample rate, Hz. */
  hz: number;
  /** Index of the sample nearest the shutter moment. */
  anchor: number;
  /** Sample count — every flat array below has 3× this length. */
  samples: number;
  /** Device rotation rate, millirad/s, int16-clamped, xyz-interleaved. */
  rotRate: number[];
  /** Fused attitude (roll/pitch/yaw), decidegrees, xyz-interleaved. */
  attitude: number[];
  /** User acceleration (gravity removed), milli-g, xyz-interleaved. */
  accel: number[];
}

/**
 * Three-state evidence path (E.04 / SPEC-WS1 rule 4b). Every sink reports
 * EXACTLY one per capture:
 *   string           — recorded; the on-device path (no file:// prefix)
 *                      where the file sat at seal time
 *   null             — sink ENABLED but failed (an onError fired) — a
 *                      failure, stated as one
 *   'never-recorded' — toggle off, fallback camera path, or the sink does
 *                      not apply to the media kind (PCM on a still, ring
 *                      on a video)
 * No silent middle states.
 */
export type EvidencePath = string | null | 'never-recorded';

/**
 * The CaptureKit session's three evidence sinks (see EvidencePath for state
 * semantics). Absent only on pre-1.0.0 records; every 1.0.0 capture states
 * all three.
 */
export interface CaptureEvidencePaths {
  /** Raw LPCM master (.caf) — a video-session sink; 'never-recorded' on stills. */
  rawPcmPath: EvidencePath;
  /** Full-rate IMU/baro/location JSONL. */
  sensorLogPath: EvidencePath;
  /** Dumped JPEG ring frames — a stills-only sink; 'never-recorded' on videos. */
  ringBufferDir: EvidencePath;
}

/**
 * The v2 super-root: SHA-256 over the concatenated per-track Merkle roots
 * in manifest order (SPEC-WS2-Phase2 §1). Zero tracks → SHA-256 of the empty
 * input.
 */
export function streamedChunksSuperRoot(trackRootsHex: string[]): string {
  return bytesToHex(sha256(concatBytes(...trackRootsHex.map(hexToBytes))));
}

// ---- WS2 Phase 2: unified media assertions (SPEC-WS2-Phase2 §1–§3) ----
// PARITY PRINCIPLE: photo, video, and audio share the same JUMBF assertion
// labels, schema, field names, and verification math. The only allowed
// divergences (canonical list: docs/MEDIA-PARITY.md): stills have no ENF
// trace and no streamed chunks beyond the zero-track structural assertion
// (buildStreamedChunksV2ForStill — stated, never absent); audio has no
// ring-buffer frames and no A/V desync; photos have no A/V desync.
// Any other per-kind divergence is a bug.

/** JUMBF assertion labels (WS2 Phase 2). v1 assets carry `camera.*` shapes
    inside the telemetry JSON — the verifier accepts both, forever. */
export const STREAMED_CHUNKS_V2_LABEL = 'com.verify.streamedChunks';
export const CONTEXT_TREE_LABEL = 'com.verify.contextTree';
export const POSE_TRACE_LABEL = 'com.verify.poseTrace';
export const CAPTURE_INTEGRITY_LABEL = 'com.verify.captureIntegrity';

/** Fixed 1 MiB chunk size (SPEC-WS1 §3). */
export const STREAM_CHUNK_BYTES = 1048576;

/**
 * The honest report when a verifier has the assertion but no chunk map:
 * roots are checkable where the container allows; byte-range localization
 * needs the map. Locked wording (SPEC-WS2-Phase2 §1) — tests pin it.
 */
export const MISSING_CHUNK_MAP_NOTE = 'chunk map not present — root-only verification';

export type StreamedChunksTrackId = 'video' | 'audio';

/**
 * streamedChunks v2 (SPEC-WS2-Phase2 §1): a fixed-size per-track Merkle
 * structure; the full chunk digest list lives in the vault record
 * (`chunkMaps[trackId]`) and the proof-bundle sidecar, not the manifest.
 * `binding` names what the roots bind: v2 roots are recomputed at seal from
 * the finalized delivery file's elementary streams — they bind DELIVERY-FILE
 * BYTES, a different claim from the v1 capture-time sample-stream root.
 * Neither may be read as the other.
 */
export interface StreamedChunksTrackV2 {
  trackId: StreamedChunksTrackId;
  /** Sample-entry fourcc from the track's stsd (e.g. 'avc1', 'mp4a') — a container fact, never inferred. */
  codec: string;
  /** Fixed chunk size in bytes — 1048576 (1 MiB). */
  chunkBytes: number;
  chunkCount: number;
  /** Merkle root over this track's chunk digests (hex lowercase). */
  root: string;
  digest: 'SHA-256';
}

export interface StreamedChunksAssertionV2 {
  label: typeof STREAMED_CHUNKS_V2_LABEL;
  v: 2;
  alg: 'sha256-merkle';
  chunkBytes: number;
  /** Ordered track entries; single-track assets (photos-as-video,
      audio-only) use the identical structure with one entry. */
  tracks: StreamedChunksTrackV2[];
  /** SHA-256 over the concatenated track roots in `tracks` order (hex);
      SHA-256 of the empty input when there are no tracks (a still has no
      elementary streams — structural, stated in `note`). */
  superRoot: string;
  /** What the roots bind — see the interface comment above. */
  binding: 'delivery-file';
  note: string;
}

export const STREAMED_CHUNKS_V2_NOTE =
  'Per-track Merkle roots over 1 MiB chunks of the finalized delivery file\'s elementary streams ' +
  '(chunk digest = SHA-256(trackId ‖ uint64BE index ‖ bytes)), recomputed at seal time. ' +
  'binding: delivery-file — these roots bind the delivery bytes, a different claim from the v1 ' +
  'capture-stream root the native hasher committed during recording. The full chunk maps live in ' +
  'the vault record and the proof-bundle sidecar, never in this manifest.';

/**
 * One track's full chunk map — sealed in the vault record; serialized as a
 * ChunkMapSidecar, it lets a desk verify byte ranges without the vault.
 */
export interface TrackChunkMap {
  trackId: StreamedChunksTrackId;
  codec: string;
  chunkBytes: number;
  digest: 'SHA-256';
  chunkCount: number;
  chunks: { index: number; bytes: number; sha256Hex: string }[];
}

export const CHUNK_MAP_SIDECAR_FORMAT = 'verify-chunk-maps/1';

/** Proof-bundle sidecar: the chunk maps for one asset, export-ready. */
export interface ChunkMapSidecar {
  format: typeof CHUNK_MAP_SIDECAR_FORMAT;
  /** SHA-256 of the SIGNED delivery bytes the maps were derived from. */
  assetSha256: string;
  maps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>>;
}

/**
 * com.verify.poseTrace (SPEC-WS2-Phase2 §3): Merkle root over the 100 Hz
 * gyro sample lines from the CaptureKit sensor JSONL; the full trace stays
 * in the vault record and rides the proof bundle for desk parallax.
 * HONESTY INVARIANT (G1, docs/INTEGRITY.md): `gyroPriorAuthenticated` is
 * always false — committed, but SELF-REPORTED until a hardware-attested
 * IMU path exists.
 */
export interface PoseTraceAssertion {
  label: typeof POSE_TRACE_LABEL;
  v: 1;
  alg: 'sha256-merkle';
  /** Nominal sample rate derived from the trace's own intervals. */
  hz: number;
  sampleCount: number;
  /** Merkle root over the gyro sample leaves (hex lowercase). */
  root: string;
  gyroPriorAuthenticated: false;
  note: string;
}

export const POSE_TRACE_NOTE =
  'Gyro trace committed at seal: existence and content are bound by this root, but the device ' +
  'motion claims remain self-reported — no hardware-attested IMU path exists on this platform. ' +
  'Evidence for desk parallax, not a verdict.';

/**
 * com.verify.captureIntegrity (SPEC-WS2-Phase2 §2): evidence-completeness
 * and biometric-gate facts, every media kind. All fields self-reported;
 * null = "not applicable / not collected", stated explicitly (E.04).
 */
export interface CaptureIntegrityAssertion {
  label: typeof CAPTURE_INTEGRITY_LABEL;
  v: 1;
  /** Which CaptureKit evidence sinks were enabled (the capture-evidence
      toggles at capture); null when no CaptureKit session ran. */
  evidenceEnabled: { ring: boolean; rawPcm: boolean; sensors: boolean } | null;
  /** true when every ENABLED sink produced its evidence file; null when
      no CaptureKit session ran (fallback path — disclosed, never faked). */
  evidenceComplete: boolean | null;
  /** The OS biometric check outcome at capture start; null when the
      toggle was off or the check was unavailable. A flag, never biometrics. */
  biometricGatePassed: boolean | null;
  /** Milliseconds from shutter moment to signature. */
  captureToSignatureMs: number;
  note: 'self-reported';
}

export interface SensorContext {
  location: LocationClaim | 'redacted' | 'unavailable';
  /** Degrees clockwise from true north. 0.18.6+: the CAMERA's azimuth at
      the shutter instant (device −Z from the sealed pose buffer, plus the
      compass declination). Older records hold the OS one-shot compass read
      taken just after capture — same field, coarser semantics. Null = not
      collected (sensors/location off, or no usable source). */
  headingDeg: number | null;
  /** Degrees east of true north, from the OS compass difference
      (trueHeading − magHeading). The compass's own error cancels in the
      difference, so this is the field model the device applied, not a
      measurement of the phone's aim. Redacted with location. 0.23.0+;
      absent on older records (parse as null). */
  declinationDeg?: number | null;
  pressureHPa: number | null;
  /** Barometric altitude estimate, meters above sea level. */
  altitudeM: number | null;
  motion: MotionSummary | null;
  /** Signed gyro trace around the shutter (0.10.0) — desk evidence, stripped
      on de-identify; absent on older records and when sensors are off. */
  poseTrace?: PoseTrace | null;
  /** Sensor-frame timing regularity in the capture window (0.9.3) — a bounded
      signal (synthetic feeds run too regular or too bursty), never a verdict. */
  sensorTiming?: { samples: number; intervalCv: number } | null;
  /** Wi-Fi the phone reported at capture — a lead, never proof (see WifiClaim).
      'redacted' = opt-in off (the default) or de-identified copy;
      'unavailable' = iOS returned nothing. Absent on older records. */
  wifi?: WifiClaim | 'redacted' | 'unavailable' | null;
  /** Three-state record of the CaptureKit evidence sinks (E.04) — present on
      every 1.0.0 capture; absent only on pre-1.0.0 records. See EvidencePath. */
  captureEvidence?: CaptureEvidencePaths | null;
  /**
   * Depth-map three-state (0.16.0, D1): when the capture side produced a
   * depth artifact, its claims (container mime, pixel dims, disparity-vs-
   * depth semantics, sha256 of the exact bytes — the same hash committed
   * in the C2PA c2pa.hash.collection.data set); when the depth module ran
   * and produced nothing, an explicit not-recorded WITH the reason —
   * absence is stated, never silent. Field absent entirely when no depth
   * module ran (like `stereo` before it).
   */
  depth?:
    | {
        recorded: true;
        mime: string;
        /** The DEPTH MAP's own dimensions. */
        width: number;
        height: number;
        semantics: 'depth' | 'disparity';
        sha256: string;
        /** The normalization window (map encoding bounds) — GDepth Near/Far. */
        normalizationMin?: number | null;
        normalizationMax?: number | null;
        /** The COLOR image's dimensions — what the map is stretched to fit. */
        photoWidth?: number | null;
        photoHeight?: number | null;
      }
    | { recorded: false; reason: string }
    | null;
  /**
   * Power-grid (ENF) anchor for the raw-audio master (0.18.0, native
   * 0.17.2): present only on video records whose PCM sink committed. The
   * anchor lets a desk cross-correlate the 50/60 Hz mains trace against a
   * reference ENF series in absolute time; fileSha256 binds the analysis
   * to the exact committed bytes. firstSampleAnchor states WHICH clock
   * fact firstSampleWallClockUtcMs is (mach-PTS → wall conversion, or the
   * append instant), verbatim. Null fields are stated, never omitted.
   * Absent entirely when no master committed (the three-state
   * captureEvidence.rawPcmPath says which case that is).
   */
  enfAnchor?: {
    firstSampleWallClockUtcMs: number | null;
    firstSampleAnchor: string | null;
    sampleCount: number;
    sampleRate: number;
    fileSha256: string | null;
  } | null;
  /** 0.20.5: which camera produced the frame. The desk's projections need
      it — the front camera looks out device +Z (the rear out −Z) and its
      committed pixels are mirrored by the pipeline, which together decide
      how the sealed attitude maps onto the image. Absent on older records
      (treat as 'back'). */
  cameraFacing?: 'front' | 'back';
  /** 0.20.5: the PRIMARY camera's horizontal field of view in degrees,
      device-reported (activeFormat.videoFieldOfView) at capture. Drives
      the horizon line's position and the sun marker's in-frame window on
      the desk; absent → the desk's nominal fallbacks. */
  hfovDeg?: number;
}

export interface AttestationRecord {
  format: typeof ATTESTATION_FORMAT;
  version: number;
  asset: {
    /** SHA-256 of the exact media bytes that were signed (hex). */
    sha256: string;
    bytes: number;
    mime: string;
    kind: 'photo' | 'video' | 'audio';
  };
  /** Device clock at signing time (UTC ISO-8601). Device-reported. */
  capturedAt: string;
  app: { name: string; version: string };
  device: { model: string | null; platform: string };
  identity: { author: string | null; organization: string | null } | 'redacted';
  context: SensorContext;
  signer: {
    alg: 'ES256';
    curve: 'P-256';
    /** Uncompressed point, base64. */
    publicKey: string;
    /** SHA-256 of the public key bytes (hex) — the device's identity. */
    fingerprint: string;
  };
  /** Base64 DER ECDSA signature over SHA-256(canonical JSON of this record minus this field). */
  signature?: string;
  /** ML-DSA-65 PUBLIC KEY committed INSIDE the signed payload: the classical
      signature and the OTS anchor vouch for WHICH PQ key this device used at
      capture — a post-P-256 forger cannot backdate that commitment. Software
      key (the Secure Enclave cannot hold ML-DSA); custody labeled, never
      implied. Honest limits: src/lib/pq.ts. */
  pqKey?: PqPublicKeyBlock | null;
  /** ML-DSA-65 signature over the same canonical payload `signature` signs —
      one commitment, two signatures. Excluded from the signed payload, like
      `signature`. Absent on legacy captures and de-identified copies (a
      long-lived PQ key would re-link an anonymised copy). pqKey present +
      pqSignature absent = stripped layer; verifiers flag it. */
  pqSignature?: string;
  /** Where this capture's ML-DSA-65 signature lives.
   *
   *  'claim+record' (the default when absent — every capture through 0.18.9)
   *  means the COSE unprotected header carries a `verifyPq` entry as well as
   *  the record. 'record' means the record carries it alone — the design from
   *  0.19.0, and the only shape a general-purpose C2PA writer can produce:
   *  there is no place in the Builder API to park a second signature.
   *
   *  Dropping the claim entry does not drop post-quantum coverage of the
   *  media: `pqSignature` covers this record's canonical JSON, which contains
   *  `asset.sha256`, which the verifier compares against the bytes it read.
   *
   *  This field lives INSIDE the signed payload on purpose. A stripped claim
   *  entry is still detectable, because an attacker cannot set this to
   *  'record' to silence the warning without breaking `signature`. */
  pqScope?: 'claim+record' | 'record';
  /** Present when the signature chains to an org-issued credential instead of
      the bare self-signed device cert. Verifiable in the C2PA x5chain;
      mirrored here for display. */
  orgCredential?: {
    issuer: string | null;
    subject: string | null;
    serialHex: string;
    notAfter: string;
  } | null;
  /** Present on de-identified re-signs: the signer stripped the identifying
      values (identity / organization / location / Wi-Fi / key linkage;
      + transcript on audio) before sharing. Non-identifying evidence
      (motion, heading, barometrics, depth, capture-evidence states, device
      model) is carried verbatim (0.18.6). Media hash unchanged; removed
      context is gone from the copy, not hidden. */
  deidentified?: {
    at: string;
    fields: string[];
    /** 0.9.0+: signed with a fresh one-time key, breaking fingerprint linkage
        between identified and anonymised copies. The signer is deliberately
        NOT the device key — verifiers must not flag the difference. */
    rekeyed?: boolean;
  } | null;
  /** True when each signature required Face ID/Touch ID (biometric-bound key). */
  biometricBound?: boolean;
  /** Present when the capture signed with a per-assignment key (0.9.0 source
      protection) instead of the device key. The label is self-asserted; what
      the signature proves is this key is NOT the device's long-lived key. */
  assignment?: { label: string } | null;
  /** Device integrity signals (0.9.0) committed at capture. SELF-REPORTED —
      a compromised device can lie; commitment, not detection. */
  deviceIntegrity?: {
    checkedAt: string;
    emulatorSuspected: boolean;
    jailbreakIndicators: string[];
    /** Runtime-instrumentation state at capture (debugger traced, injected
        dylib artifacts). Same honesty ceiling — self-reported, patchable.
        Null on old native builds / non-iOS. */
    runtimeInstrumentation?: { debuggerAttached: boolean; injectedLibraries: string[] } | null;
    note: 'self-reported';
  } | null;
  /** Capture-integrity signals (0.9.3) — ALL self-reported; commitment under
      signature, not detection. Bounds and blind spots: docs/INTEGRITY.md. */
  captureIntegrity?: {
    /** Milliseconds from shutter to signature — a long gap means the bytes
        could have been altered in between. */
    captureToSignatureMs: number;
    /** Sensor-frame timing regularity (see SensorContext.sensorTiming). */
    sensorTiming: { samples: number; intervalCv: number } | null;
    /** Face check (0.11.1): written whenever captureIntegrity is. true = the
        OS reported a match; null = no check was requested. 0.22.0: the
        capture-time check was removed, so null is the only value written.
        An EVENT RECORD, not an identity — no face geometry, template, or
        image is ever stored anywhere in the app. Never fabricated true. */
    biometricGatePassed?: boolean | null;
    note: 'self-reported';
  } | null;
  /** OpenTimestamps ledger anchoring (0.9.1). EXCLUDED from the signed
      payload — receipts are added/upgraded after signing, and mutating
      signed bytes would break the signature. Each receipt commits to
      SHA-256(canonical signed payload), so it needs no signature of its
      own. Ledger time (Bitcoin) and authority time (TSA, RFC 3161) stay
      separate claims. */
  ots?: OtsAnchorSet | null;
  /** Stereo-capture artifact section (0.13.0, Spec-Camera-Module-0.13 §5):
      the committed three-state artifact entries (secondary frame /
      calibration / timestamps / metadata / raw DNG), built by
      commitStereoArtifacts at seal time. EXCLUDED from the signed payload —
      persisted after signing, same rule as `ots`. The states are already
      bound by the SIGNED context.stereo-* claim values in the context tree;
      this field is the bundle-ready mirror (buildProofBundle's 4th arg).
      Absent on pre-0.13 records and captures where no stereo module ran. */
  stereo?: import('./stereoArtifacts').StereoBundleSection | null;
  /** VIDEO stereo-pair section (0.13.0, Spec-Camera-Module-0.13 §8): the
      committed periodic-pair entries (secondary frame + calibration each,
      PTS anchors verbatim) plus the native pairsCommitted / pairsMissed /
      hardwareCost counts. EXCLUDED from the signed payload — persisted
      after signing, same rule as `stereo`/`ots`; the counts and the
      pairs-root hash are bound by the signed context.stereo-video-* claims.
      Absent on pre-0.13 records and captures where no pair cadence ran. */
  videoStereo?: import('./stereoArtifacts').VideoStereoBundleSection | null;
  /** Bitcoin beacon — signed TIME LOWER BOUND: the latest block hash the
      device had cached at signing, so the signature cannot predate that
      block (counterpart of `ots`, which bounds time from above). INSIDE the
      signed payload — the commitment only means something signed. The tip
      is fetched on a jittered schedule, never per-capture; `observedAt` is
      self-reported. Absent (not fabricated) when no tip was cached. */
  beacon?: BeaconCommitment | null;
}

export interface OtsSubmission {
  /** Calendar base URL that issued/upgraded this receipt. */
  calendar: string;
  /** Base64 DetachedTimestampFile receipt (pending or bitcoin-attested). */
  receipt: string;
  state: 'pending' | 'confirmed';
  /** Set once the calendar's tree is anchored in a block. */
  blockHeight?: number;
  /** When the receipt was fetched (ISO). */
  submittedAt: string;
  /** When a confirmation upgrade was fetched (ISO). */
  confirmedAt?: string;
  /** Present when offline at signing: how long the digest queued on-device
      before submission — the delay is evidence, not hidden. */
  queueDelayMs?: number;
}

export interface OtsAnchorSet {
  /** Hex digest the receipts commit to — SHA-256(canonical signed payload). */
  digestHex: string;
  submissions: OtsSubmission[];
}

/** The signed payload: the whole record minus `signature`, `pqSignature`,
    the post-signing `ots` receipts, and the seal-time `stereo` /
    `videoStereo` sections (whose states/counts are bound by the signed
    context.stereo-* / context.stereo-video-* claims). */
export function signedPayload(record: AttestationRecord): JsonValue {
  const { signature: _sig, ots: _ots, pqSignature: _pqSig, stereo: _stereo, videoStereo: _videoStereo, ...rest } = record;
  return rest as unknown as JsonValue;
}

export function buildRecord(params: {
  assetSha256: string;
  assetBytes: number;
  mime: string;
  kind: 'photo' | 'video' | 'audio';
  capturedAt: string;
  appVersion: string;
  deviceModel: string | null;
  platform: string;
  identity: { author: string | null; organization: string | null } | 'redacted';
  context: SensorContext;
  publicKeyBase64: string;
  fingerprint: string;
}): AttestationRecord {
  return {
    format: ATTESTATION_FORMAT,
    version: ATTESTATION_VERSION,
    asset: {
      sha256: params.assetSha256,
      bytes: params.assetBytes,
      mime: params.mime,
      kind: params.kind,
    },
    capturedAt: params.capturedAt,
    app: { name: 'Source Kit', version: params.appVersion },
    device: { model: params.deviceModel, platform: params.platform },
    identity: params.identity,
    context: params.context,
    signer: {
      alg: 'ES256',
      curve: 'P-256',
      publicKey: params.publicKeyBase64,
      fingerprint: params.fingerprint,
    },
  };
}

/** Structural validation of a parsed record (types and required fields). */
export function isAttestationRecord(x: unknown): x is AttestationRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  const asset = r.asset as Record<string, unknown> | undefined;
  const signer = r.signer as Record<string, unknown> | undefined;
  return (
    r.format === ATTESTATION_FORMAT &&
    typeof r.version === 'number' &&
    !!asset &&
    typeof asset.sha256 === 'string' &&
    typeof asset.bytes === 'number' &&
    typeof asset.mime === 'string' &&
    typeof r.capturedAt === 'string' &&
    !!signer &&
    typeof signer.publicKey === 'string' &&
    typeof signer.fingerprint === 'string' &&
    typeof r.signature === 'string'
  );
}

/** Parse a record from manifest bytes. Pure (no device APIs) so the desk can
    run it in a browser; lives here because attest.ts is the capture side and
    legitimately imports expo glue. FAIL CLOSED: a parsed manifest is untrusted
    input (the desk feeds it straight into the exported HTML dossier), so the
    format check alone is not enough — anything that fails isAttestationRecord
    is rejected, not coerced. Every record this app writes passes the validator
    (signRecord always sets `signature` before persistence), so this rejects
    only malformed or crafted manifests. */
export function recordFromManifestBytes(bytes: Uint8Array): AttestationRecord | null {
  try {
    const parsed: unknown = JSON.parse(bytesToUtf8(bytes));
    return isAttestationRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
