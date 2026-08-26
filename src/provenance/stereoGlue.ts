// Source Kit 0.1.0 — stereo ingestion glue: maps the ExhibitCamera CaptureResult's three-state
/**
 * Stereo ingestion glue (0.13.0): maps the ExhibitCamera CaptureResult's
 * three-state EvidencePaths onto the commitStereoArtifacts input contract
 * (src/provenance/stereoArtifacts.ts — the ONLY ingestion-library touch
 * point; src/ never imports desk/).
 *
 * Two jobs:
 *
 *  1. THREE-STATE MAPPING. The bridge's object-form EvidencePath
 *     ({state:'path'} / {state:'error'} / {state:'never-recorded'}) becomes
 *     the manifest's path/null/'never-recorded' vocabulary, with bytes read
 *     for recorded paths (REQUIRED), the native error string carried
 *     verbatim for failures (REQUIRED), and the stated reason for
 *     never-recorded. A recorded file that cannot be READ at seal time is
 *     stated as an error ('seal-time read failed: …') — never committed as
 *     recorded-without-bytes, never silently dropped.
 *
 *  2. COMMITTED-SHAPE CONVERSION. The native module commits its own JSON
 *     shapes; the desk's parsers (parseStereoCalibration /
 *     parseStereoTimestamps / stereoMetadataFromBlock) define the COMMITTED
 *     contract, so the conversion happens here, in the glue, before
 *     hashing — the hashed/committed bytes are the desk-shape JSON:
 *
 *     calibration: the native 4×3 row-major extrinsic (secondary→primary)
 *       is INVERTED to the committed rotation[9] (row-major) +
 *       translationM[3] with P_secondary = R·P_primary + t semantics
 *       (rigid inverse: R' = Rᵀ, t' = −Rᵀ·t). Intrinsics 3×3 row-major →
 *       {fx,fy,cx,cy,width,height} pixels from the session-photo full
 *       calibration. baselineMeters is OMITTED (the device never commits
 *       it; the desk cross-checks |t| when present — a glue-computed value
 *       would be self-agreement, not a cross-check). calibrationSource
 *       carries the native source labels.
 *
 *     timestamps: native {primaryHostSeconds, secondaryHostSeconds,
 *       capturedAtMs, synchronizedDeltaMs} → {primaryPtsSeconds,
 *       secondaryPtsSeconds, wallClockAnchorIso, synchronizedDeltaMs}.
 *
 *     metadata: the nested {primary, secondary} native blocks flatten to
 *       the desk's primary-device block. controlsReportedBy:'device' and
 *       focusDistanceMeters:null carry through verbatim (verified, not
 *       assumed). focalLengthMm is DERIVED from the committed calibration
 *       (fx px × pixelSizeMicrometers / 1000) — the device reports no mm
 *       number natively; the derivation note is committed alongside so the
 *       desk can recompute the same value from the calibration artifact.
 *
 *     A conversion failure does NOT fabricate: the artifact becomes an
 *     'error' state with the reason verbatim, and the raw native file is
 *     still vault-stored (<name>-native-raw) so nothing is destroyed.
 *
 * rawDng: bytes are read for the hash but flagged hash-only by the
 * ingestion library (INLINE_IN_BUNDLE.rawDng === false) — the bundle
 * carries the commitment, the vault holds the bytes.
 */

import { bytesToUtf8, utf8ToBytes } from '../lib/bytes';
import type { CaptureResult, CalibrationFile, SerializedCalibrationData } from '../lib/exhibitCamera';
import type { StereoArtifactId, StereoCaptureArtifacts, StereoArtifactInput, StereoVideoPairInput } from './stereoArtifacts';
import { STEREO_ARTIFACT_IDS } from './stereoArtifacts';

/** A committed artifact file to vault-store: fileName + the COMMITTED bytes
    (post-conversion for the JSON artifacts — what the hash binds). */
export interface CommittedStereoFile {
  id: StereoArtifactId;
  fileName: string;
  bytes: Uint8Array;
}

export interface StereoGlueResult {
  artifacts: StereoCaptureArtifacts;
  /** Files for the record's evidence dir (committed bytes; plus any native-raw fallbacks). */
  files: CommittedStereoFile[];
}

const FILE_STEMS: Record<StereoArtifactId, string> = {
  secondaryFrame: 'secondary-frame',
  calibration: 'calibration',
  timestamps: 'timestamps',
  metadata: 'metadata',
  rawDng: 'raw-dng',
};

function extOf(p: string): string {
  const dot = p.lastIndexOf('.');
  return dot >= 0 ? p.slice(dot) : '.bin';
}

// ---------------------------------------------------------------------------
// Calibration conversion (native CalibrationFile → committed desk shape)
// ---------------------------------------------------------------------------

function intrinsicsShapeFrom(full: SerializedCalibrationData, label: string): {
  fx: number; fy: number; cx: number; cy: number; width: number; height: number;
} {
  const m = full.intrinsicMatrixRowMajor;
  if (!Array.isArray(m) || m.length !== 9 || !m.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${label}: intrinsicMatrixRowMajor must be 9 finite numbers`);
  }
  const d = full.intrinsicMatrixReferenceDimensions;
  if (!d || !Number.isFinite(d.width) || !Number.isFinite(d.height)) {
    throw new Error(`${label}: intrinsicMatrixReferenceDimensions must be finite`);
  }
  return { fx: m[0], fy: m[4], cx: m[2], cy: m[5], width: d.width, height: d.height };
}

/**
 * Native 4×3 row-major extrinsic (3 rows × 4 cols: [R|t]), secondary→primary
 * → committed rotation[9] row-major + translationM[3] with
 * P_secondary = R·P_primary + t semantics (the rigid inverse).
 */
function convertExtrinsics(m12: number[], label: string): { rotation: number[]; translationM: [number, number, number] } {
  if (!Array.isArray(m12) || m12.length !== 12 || !m12.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error(`${label}: extrinsicMatrixRowMajor must be 12 finite numbers (4×3 row-major)`);
  }
  // R_np / t_np: secondary → primary.
  const r = [m12[0], m12[1], m12[2], m12[4], m12[5], m12[6], m12[8], m12[9], m12[10]];
  const t = [m12[3], m12[7], m12[11]];
  // Inverse of a rigid transform: R' = Rᵀ, t' = −Rᵀ·t.
  const rt = [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]]; // transpose
  const tInv: [number, number, number] = [
    -(rt[0] * t[0] + rt[1] * t[1] + rt[2] * t[2]),
    -(rt[3] * t[0] + rt[4] * t[1] + rt[5] * t[2]),
    -(rt[6] * t[0] + rt[7] * t[1] + rt[8] * t[2]),
  ];
  return { rotation: rt, translationM: tInv };
}

/**
 * Convert the native calibration JSON to the committed desk shape
 * (parseStereoCalibration's contract). Throws with the reason when the
 * session-photo full calibration is absent — per-frame intrinsics alone
 * cannot bind the rig extrinsic, and a partial commitment is not evidence.
 */
export function convertCalibrationJson(nativeText: string): string {
  const o = JSON.parse(nativeText) as CalibrationFile & Record<string, unknown>;
  if (!o.primaryFull || !o.secondaryFull) {
    throw new Error(
      `session-photo full calibration unavailable (full: ${o.calibrationSource?.full ?? 'unavailable'}) — the rig extrinsic cannot be committed without it`,
    );
  }
  const primary = o.primaryFull;
  const secondary = o.secondaryFull;
  const converted = {
    calibrationSource: `avcamera-calibration-data (session-photo-capture; per-frame intrinsics: ${o.calibrationSource?.intrinsics ?? 'unavailable'})`,
    intrinsicsWide: intrinsicsShapeFrom(primary, 'primaryFull'),
    intrinsicsUltraWide: intrinsicsShapeFrom(secondary, 'secondaryFull'),
    extrinsics: convertExtrinsics(secondary.extrinsicMatrixRowMajor, 'secondaryFull'),
    // Honesty passthrough: which physical devices the slots actually are.
    deviceLabels: { wide: primary.device, ultraWide: secondary.device },
  };
  return JSON.stringify(converted);
}

// ---------------------------------------------------------------------------
// Timestamps conversion (native SyncTimestampsFile → committed desk shape)
// ---------------------------------------------------------------------------

export function convertTimestampsJson(nativeText: string): string {
  const o = JSON.parse(nativeText) as {
    captureId?: string;
    capturedAtMs?: number;
    primaryHostSeconds?: number | null;
    secondaryHostSeconds?: number | null;
    synchronizedDeltaMs?: number | null;
    clockNote?: string;
  };
  const num = (v: unknown, label: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`timestamps: ${label} is ${v === null ? 'null' : 'absent'} — the sync claim cannot be committed without it`);
    }
    return v;
  };
  return JSON.stringify({
    primaryPtsSeconds: num(o.primaryHostSeconds, 'primaryHostSeconds'),
    secondaryPtsSeconds: num(o.secondaryHostSeconds, 'secondaryHostSeconds'),
    ...(typeof o.capturedAtMs === 'number' && Number.isFinite(o.capturedAtMs)
      ? { wallClockAnchorIso: new Date(o.capturedAtMs).toISOString() }
      : {}),
    synchronizedDeltaMs: num(o.synchronizedDeltaMs, 'synchronizedDeltaMs'),
    ...(o.captureId ? { captureId: o.captureId } : {}),
    ...(o.clockNote ? { clockNote: o.clockNote } : {}),
  });
}

// ---------------------------------------------------------------------------
// Metadata conversion (native nested blocks → committed flat desk block)
// ---------------------------------------------------------------------------

function devicePositionOf(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : '';
  if (s.includes('UltraWide')) return 'ultra-wide';
  if (s.includes('Telephoto')) return 'telephoto';
  if (s.includes('WideAngle')) return 'wide';
  return s.length > 0 ? s : 'wide';
}

/**
 * Flatten the native {primary, secondary, …} metadata JSON to the desk's
 * primary-device block. controlsReportedBy and focusDistanceMeters carry
 * through VERBATIM (verified, not assumed). focalLengthMm is derived from
 * the committed calibration (fx px × pixelSizeMicrometers / 1000) and the
 * derivation note is committed — the device reports no mm number natively.
 */
export function convertMetadataJson(nativeText: string, calibrationText: string | null): string {
  const o = JSON.parse(nativeText) as {
    primary?: Record<string, unknown> | null;
    secondary?: Record<string, unknown> | null;
    captureId?: string;
    secondaryBytes?: number | null;
    secondaryJpegQuality?: number | null;
  };
  const p = o.primary;
  if (!p || typeof p !== 'object') throw new Error('metadata: no primary block — the primary device facts are the commitment');
  if (p.controlsReportedBy !== 'device') {
    throw new Error(`metadata: controlsReportedBy is '${String(p.controlsReportedBy)}' — control values must be device read-backs, labeled`);
  }
  if (p.focusDistanceMeters !== null && p.focusDistanceMeters !== undefined) {
    throw new Error('metadata: focusDistanceMeters must be null by construction (iOS exposes no focus-distance API)');
  }
  // focalLengthMm: derived from the committed session calibration when no
  // native mm number exists (it never does on this path).
  let focalLengthMm: number | null = typeof p.focalLengthMm === 'number' && Number.isFinite(p.focalLengthMm) ? p.focalLengthMm : null;
  if (focalLengthMm === null && calibrationText) {
    try {
      const cal = JSON.parse(calibrationText) as CalibrationFile;
      const full = cal.primaryFull;
      if (full && Number.isFinite(full.intrinsicMatrixRowMajor?.[0]) && Number.isFinite(full.pixelSizeMicrometers) && full.pixelSizeMicrometers > 0) {
        focalLengthMm = (full.intrinsicMatrixRowMajor[0] * full.pixelSizeMicrometers) / 1000;
      }
    } catch { /* fall through to the stated failure below */ }
  }
  if (focalLengthMm === null || !Number.isFinite(focalLengthMm)) {
    throw new Error('metadata: focalLengthMm is not device-reported and could not be derived from the committed calibration');
  }
  const num = (v: unknown, label: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`metadata: ${label} is ${v === null ? 'null' : 'absent'} — a stated gap upstream, not a number to invent`);
    }
    return v;
  };
  const ab = p.antiBanding as { mainsHz?: number; note?: string } | string | undefined;
  const antiBanding =
    typeof ab === 'string' ? ab : ab && typeof ab === 'object' && typeof ab.mainsHz === 'number'
      ? `${ab.mainsHz}Hz (${ab.note ?? 'region-derived'})`
      : 'not reported';
  return JSON.stringify({
    // The full native primary block rides through untyped — the desk reads
    // what it needs; the committed contract fields below override by key.
    ...p,
    controlsReportedBy: 'device',
    focusDistanceMeters: null,
    focalLengthMm,
    focalLengthMmNote:
      typeof p.focalLengthMm === 'number'
        ? 'device-reported'
        : 'derived: committed primary intrinsics fx (px) × pixelSizeMicrometers / 1000 — recomputable from the calibration artifact',
    apertureFNumber: num(p.apertureFNumber, 'apertureFNumber'),
    exposureDurationSec: num(p.exposureDurationSec, 'exposureDurationSec'),
    iso: num(p.iso, 'iso'),
    physicalDevice: devicePositionOf(p.physicalDevice),
    physicalDeviceRaw: p.physicalDevice ?? null,
    antiBanding,
    antiBandingRaw: typeof ab === 'object' ? ab : null,
    // The secondary device's block stays nested — the desk's block is the
    // primary's; nothing is dropped.
    secondary: o.secondary ?? null,
    ...(o.captureId ? { captureId: o.captureId } : {}),
    secondaryBytes: o.secondaryBytes ?? null,
    secondaryJpegQuality: o.secondaryJpegQuality ?? null,
  });
}

// ---------------------------------------------------------------------------
// The mapping entry point
// ---------------------------------------------------------------------------

/**
 * Map a CaptureResult to commitStereoArtifacts inputs. `readBytes` reads a
 * plain filesystem path (the bridge never emits file:// URIs, but tolerate
 * both). JSON artifacts are CONVERTED to the committed desk shape before
 * hashing; conversion failures become stated 'error' entries and the raw
 * native bytes ride the file list as <stem>-native-raw<ext>.
 */
export async function buildStereoInputs(
  result: CaptureResult,
  readBytes: (uri: string) => Promise<Uint8Array>,
): Promise<StereoGlueResult> {
  const eps: Record<StereoArtifactId, CaptureResult[StereoArtifactId]> = {
    secondaryFrame: result.secondaryFrame,
    calibration: result.calibration,
    timestamps: result.timestamps,
    metadata: result.metadata,
    rawDng: result.rawDng,
  };

  // Read every recorded artifact's bytes first (raw native bytes).
  const raw = new Map<StereoArtifactId, { path: string; bytes: Uint8Array }>();
  const readFailures = new Map<StereoArtifactId, string>();
  for (const id of STEREO_ARTIFACT_IDS) {
    const ep = eps[id];
    if (ep.state !== 'path') continue;
    try {
      const uri = ep.path.startsWith('file://') ? ep.path : `file://${ep.path}`;
      const bytes = await readBytes(uri);
      raw.set(id, { path: ep.path, bytes });
    } catch (e) {
      readFailures.set(id, e instanceof Error ? e.message : 'read failed');
    }
  }

  // Calibration conversion runs first: metadata's focalLengthMm derivation
  // reads the native calibration numbers.
  const calibrationNativeText = raw.has('calibration') ? bytesToUtf8(raw.get('calibration')!.bytes) : null;
  const converted = new Map<StereoArtifactId, Uint8Array>();
  const conversionFailures = new Map<StereoArtifactId, string>();
  if (calibrationNativeText !== null) {
    try {
      converted.set('calibration', utf8ToBytes(convertCalibrationJson(calibrationNativeText)));
    } catch (e) {
      conversionFailures.set('calibration', `calibration conversion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (raw.has('timestamps')) {
    try {
      converted.set('timestamps', utf8ToBytes(convertTimestampsJson(bytesToUtf8(raw.get('timestamps')!.bytes))));
    } catch (e) {
      conversionFailures.set('timestamps', `timestamps conversion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (raw.has('metadata')) {
    try {
      converted.set('metadata', utf8ToBytes(convertMetadataJson(bytesToUtf8(raw.get('metadata')!.bytes), calibrationNativeText)));
    } catch (e) {
      conversionFailures.set('metadata', `metadata conversion failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const artifacts = {} as StereoCaptureArtifacts;
  const files: CommittedStereoFile[] = [];
  for (const id of STEREO_ARTIFACT_IDS) {
    const ep = eps[id];
    const stem = FILE_STEMS[id];
    if (ep.state === 'never-recorded') {
      artifacts[id] = { path: 'never-recorded', reason: ep.reason };
      continue;
    }
    if (ep.state === 'error') {
      artifacts[id] = { path: null, error: `${ep.code}: ${ep.message}` };
      continue;
    }
    // ep.state === 'path'
    const readFailure = readFailures.get(id);
    if (readFailure) {
      artifacts[id] = { path: null, error: `seal-time artifact read failed: ${readFailure}` };
      continue;
    }
    const conversionFailure = conversionFailures.get(id);
    const committedBytes = converted.get(id) ?? raw.get(id)!.bytes;
    const ext = extOf(raw.get(id)!.path);
    if (conversionFailure) {
      // Stated failure; the raw native file is preserved in the vault.
      artifacts[id] = { path: null, error: conversionFailure };
      files.push({ id, fileName: `${stem}-native-raw${ext}`, bytes: raw.get(id)!.bytes });
      continue;
    }
    const input: StereoArtifactInput = { path: raw.get(id)!.path, bytes: committedBytes };
    artifacts[id] = input;
    files.push({ id, fileName: `${stem}${ext}`, bytes: committedBytes });
  }
  return { artifacts, files };
}

// ---------------------------------------------------------------------------
// VIDEO pair glue (Spec §8): the module writes pairs/pair-%04d-secondary.jpg
// and pairs/pair-%04d-calibration.json during recording; the PTS anchors
// ride the onStereoPairCaptured event (no timestamps file exists per pair).
// The events — collected by the capture screen and carried on the seal job —
// are the enumeration source: dense pairIndex, anchors verbatim. A null
// artifact path in an event is the module's own sink-failure report and maps
// to a stated 'error' entry; the calibration JSON converts to the committed
// desk shape exactly like the photo path.
// ---------------------------------------------------------------------------

/** Structural mirror of the bridge's StereoPairCapturedEvent — declared
    here so the glue's contract stands alone (the bridge type is assignable
    to this; the open tree stages this file without the bridge). */
export interface StereoVideoPairEvent {
  index: number;
  secondaryPath: string | null;
  calibrationPath: string | null;
  primaryHostSeconds: number | null;
  synchronizedDeltaMs: number | null;
}

export interface StereoVideoGlueResult {
  pairs: StereoVideoPairInput[];
  /** Committed bytes for the record's evidence dir (pairs/… file names). */
  files: CommittedStereoFile[];
}

const PAIR_STEM: Record<'secondaryFrame' | 'calibration', string> = {
  secondaryFrame: 'secondary',
  calibration: 'calibration',
};

function pairFileName(index: number, id: 'secondaryFrame' | 'calibration', ext: string): string {
  return `pairs/pair-${String(index).padStart(4, '0')}-${PAIR_STEM[id]}${ext}`;
}

/**
 * Map the collected pair events to commitStereoVideoArtifacts inputs.
 * `readBytes` reads a plain filesystem path. Read failures and calibration
 * conversion failures become stated 'error' entries (native-raw preserved
 * in the file list) — never fabricated, never silently dropped.
 */
export async function buildStereoVideoPairInputs(
  events: StereoVideoPairEvent[],
  readBytes: (uri: string) => Promise<Uint8Array>,
): Promise<StereoVideoGlueResult> {
  const pairs: StereoVideoPairInput[] = [];
  const files: CommittedStereoFile[] = [];
  for (const ev of [...events].sort((a, b) => a.index - b.index)) {
    const artifacts = {} as StereoVideoPairInput['artifacts'];
    for (const id of ['secondaryFrame', 'calibration'] as const) {
      const path = id === 'secondaryFrame' ? ev.secondaryPath : ev.calibrationPath;
      if (path === null) {
        // The module reported this sink failure at capture time (E_SINK) —
        // stated as an error entry, verbatim about what is known.
        artifacts[id] = {
          path: null,
          error: `the module reported a null ${id === 'secondaryFrame' ? 'secondaryPath' : 'calibrationPath'} for pair ${ev.index} at capture time (sink write failure, stated by the module)`,
        };
        continue;
      }
      let nativeBytes: Uint8Array;
      try {
        const uri = path.startsWith('file://') ? path : `file://${path}`;
        nativeBytes = await readBytes(uri);
      } catch (e) {
        artifacts[id] = { path: null, error: `seal-time artifact read failed: ${e instanceof Error ? e.message : 'read failed'}` };
        continue;
      }
      const ext = extOf(path);
      if (id === 'calibration') {
        try {
          const committedBytes = utf8ToBytes(convertCalibrationJson(bytesToUtf8(nativeBytes)));
          artifacts[id] = { path, bytes: committedBytes };
          files.push({ id, fileName: pairFileName(ev.index, id, ext), bytes: committedBytes });
        } catch (e) {
          artifacts[id] = { path: null, error: `calibration conversion failed: ${e instanceof Error ? e.message : String(e)}` };
          files.push({ id, fileName: pairFileName(ev.index, id, `-native-raw${ext}`), bytes: nativeBytes });
        }
      } else {
        artifacts[id] = { path, bytes: nativeBytes };
        files.push({ id, fileName: pairFileName(ev.index, id, ext), bytes: nativeBytes });
      }
    }
    pairs.push({
      pairIndex: ev.index,
      anchors: { primaryHostSeconds: ev.primaryHostSeconds, synchronizedDeltaMs: ev.synchronizedDeltaMs },
      artifacts,
    });
  }
  return { pairs, files };
}
