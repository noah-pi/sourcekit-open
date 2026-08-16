/**
 * Desk analyzer registry — one list of every measurement the desk can
 * run, with the tier that constrains how its output may be used.
 *
 * Tiers (project law, G1 design rules — docs/INTEGRITY.md):
 *  - Tier 1: DETERMINISTIC GEOMETRIC / SIGNAL MEASUREMENTS. No trained ML
 *    model, no metadata-statistical scoring, no fused probability, no
 *    per-frame probability aggregation, no dual-trajectory similarity score.
 *    Output is a human-reviewed measurement with stated error bounds and an
 *    explicit 'insufficient' path. Evidence a person weighs — never a gate,
 *    never a verdict.
 *  - Tier 2 (W4): AD-HOC IN-BROWSER IMAGE ANALYSES + VIEWING AIDS
 *    (ARCHITECTURE §5.3 — imageFx.ts). Same law as Tier 1: deterministic,
 *    no ML, no fused score, abstention over guessing, every result labeled
 *    "measured in this tab". The viewing aids claim nothing at all.
 *  - (No Tier exists that would produce a recapture/fraud score or
 *    probability — that is not a higher tier, it is out of bounds.)
 */

import { PARALLAX_METHOD_VERSION } from './parallax';
import { DISPLAY_BEAT_METHOD_VERSION } from './displayBeat';
import { ENF_EXTRACT_METHOD_VERSION } from './enfExtract';
import { AVSYNC_METHOD_VERSION } from './avSync';
import { SKEW_METHOD_VERSION } from './rollingShutter';
import {
  CLONE_METHOD_VERSION,
  ELA_METHOD_VERSION,
  NOISE_METHOD_VERSION,
  VIEWING_AID_METHOD_VERSION,
} from './imageFx';

export interface DeskAnalyzer {
  /** Stable identifier used in CLI output and reports. */
  id: string;
  /**
   * 0 = automatic at intake (byte reads) · 1 = deterministic signal
   * measurements · 2 = ad-hoc in-browser analyses/viewing aids (W4) ·
   * 3 = ad-hoc, leaves the browser (connectors — consent-gated, W3).
   */
  tier: 0 | 1 | 2 | 3;
  methodVersion: string;
  /** One-line statement of what is measured. */
  measures: string;
  /** Where the method and its limitations are documented. */
  docs: string;
}

export const DESK_ANALYZERS: DeskAnalyzer[] = [
  {
    id: 'parallax',
    tier: 1,
    methodVersion: PARALLAX_METHOD_VERSION,
    measures:
      'scene flatness from the 8-frame pre-shutter ring: per-track residual disparity after (gyro-aided) rotation compensation, best-fit planar model residual, and disparity spread — a geometric measurement with stated error bounds, never a recapture score',
    docs: 'docs/INTEGRITY.md#desk-side-parallax-flatness-measurement-100-ws4',
  },
  {
    id: 'rephoto',
    tier: 1,
    methodVersion: '0.10.0-w2.1',
    measures: 'screen re-photography signals (banding / moiré / black floor / gamut) as raw measurements with descriptive strengths',
    docs: 'docs/INTEGRITY.md#signals-deliberately-left-to-the-desk-tool-094',
  },
  {
    id: 'imuflow',
    tier: 1,
    methodVersion: '0.10.0-w2.2',
    measures: 'correlation between the signed pose trace and optical flow in the frames — a consistency measurement, not a similarity score fed to any model',
    docs: 'docs/INTEGRITY.md#the-signed-pose-trace',
  },
  // ---- Tier-1 forensic analyzers (desk-side) ------------------------------
  // Method + limitations are documented in each analyzer's header; nothing
  // here publishes error rates before the corpus characterization.
  {
    id: 'displaybeat',
    tier: 1,
    methodVersion: DISPLAY_BEAT_METHOD_VERSION,
    measures:
      'periodic luma beat in the video track / ring frames: measured beat frequency + SNR, and display-refresh family candidates (50/59.94/60 Hz harmonics folded through the actual sample rate, DC-aliased candidates marked NOT assessable) — a signal measurement, never a recapture verdict',
    docs: 'desk/src/core/displayBeat.ts (method + limitations in header); corpus error-rate docs pending the characterization shoot',
  },
  {
    id: 'enf-extract',
    tier: 1,
    methodVersion: ENF_EXTRACT_METHOD_VERSION,
    measures:
      'mains-frequency (ENF) trace from mono LPCM around the region-derived mainsHz hint — EXTRACT ONLY, no reference matching at Tier 1; under 30 s of audio the report is insufficient with no trace and no number that looks like evidence',
    docs: 'desk/src/core/enfExtract.ts (method + limitations in header); Tier-2 matching (F.07) is a separate analyzer with reference data',
  },
  {
    id: 'avsync',
    tier: 1,
    methodVersion: AVSYNC_METHOD_VERSION,
    measures:
      'audio-onset vs motion-onset alignment offset in ms (cross-correlation lag of the two flux series on a shared time grid + strongest-onset pair) — dubbing-relevant desync as a measured offset, never a dubbing verdict',
    docs: 'desk/src/core/avSync.ts (method + limitations in header)',
  },
  {
    id: 'rolling-shutter',
    tier: 1,
    methodVersion: SKEW_METHOD_VERSION,
    measures:
      'rolling-shutter row skew (per-band vertical displacement slope, px/row) vs gyro rotation rate consistency (shape correlation + sign agreement, raw per-pair series) — geometric only, no score of any kind',
    docs: 'desk/src/core/rollingShutter.ts (method + limitations in header)',
  },
  // ---- Tier-2 ad-hoc image analyses (Forensics tab, W4) -------------------
  // User-triggered, chunked, cancellable, computed in the tab; abstention
  // with a stated reason is a first-class result.
  {
    id: 'clone-detection',
    tier: 2,
    methodVersion: CLONE_METHOD_VERSION,
    measures:
      'copy-move duplication: Haar-wavelet fuzzy block keys, hash-bucket matching, min-detail filter, min source–dest distance, offset clustering on a size-capped raster — reports what the matcher found AT THESE SETTINGS, with the quantized debug view of exactly what it saw; never proof that no duplication exists',
    docs: 'desk/src/core/imageFx.ts (method + limitations in header); r3 clone-detection algorithm set',
  },
  {
    id: 'noise-analysis',
    tier: 2,
    methodVersion: NOISE_METHOD_VERSION,
    measures:
      'median-residual noise texture ("reverse denoising"): separable median filter, amplitude-stretched residual — reveals retouching patterns ELA/clone detection miss; ABSTAINS with a stated reason on flat, small, or too-smooth inputs',
    docs: 'desk/src/core/imageFx.ts (method + limitations in header); r3 noise-analysis algorithm set',
  },
  {
    id: 'ela',
    tier: 2,
    methodVersion: ELA_METHOD_VERSION,
    measures:
      'error level analysis: JPEG-only re-encode at a stated quality + amplified per-channel difference — shows where recompression levels differ; JPEG-gated with a reason, non-dismissible misleading-results caveat, a viewing aid never evidence of manipulation',
    docs: 'desk/src/core/imageFx.ts (method + limitations in header); r3 deliberate-exclusion guidance (gated + caveated)',
  },
  {
    id: 'level-sweep',
    tier: 2,
    methodVersion: VIEWING_AID_METHOD_VERSION,
    measures: 'a narrow luminance histogram slice stretched to the full range — a viewing aid, it shows the picture differently and claims nothing',
    docs: 'desk/src/core/imageFx.ts; r3 viewing aids (low evidentiary value)',
  },
  {
    id: 'luminance-gradient',
    tier: 2,
    methodVersion: VIEWING_AID_METHOD_VERSION,
    measures: 'per-pixel brightness-gradient magnitude — a viewing aid, it shows the picture differently and claims nothing',
    docs: 'desk/src/core/imageFx.ts; r3 viewing aids (low evidentiary value)',
  },
  {
    id: 'magnifier',
    tier: 2,
    methodVersion: VIEWING_AID_METHOD_VERSION,
    measures: 'zoom window with local contrast modes (none / auto / auto-by-channel / histogram equalization) — a viewing aid, it shows the picture differently and claims nothing',
    docs: 'desk/src/core/imageFx.ts; r3 viewing aids (low evidentiary value)',
  },
];

export function deskAnalyzer(id: string): DeskAnalyzer | undefined {
  return DESK_ANALYZERS.find((a) => a.id === id);
}
