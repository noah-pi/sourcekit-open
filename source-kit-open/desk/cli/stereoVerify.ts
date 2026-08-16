/**
 * exhibit-desk stereo — stereo-artifact extraction + the planarity signal.
 *
 * Loads a proof bundle ('exhibit-proof-bundle/2'), extracts the stereo
 * section, checks every artifact's embedded bytes against its committed
 * hash, builds the StereoCommitment from the committed inputs, and — when
 * the caller supplies correspondences — runs verifyStereoCommitment and
 * prints the PlanaritySignal text VERBATIM (it carries its own bounds).
 *
 * Honesty contract (standing rules):
 *   - never-recorded artifacts print exactly that state — an unreached
 *     state, never suspicion, never red;
 *   - enabled-but-failed artifacts print the committed error string;
 *   - a hash mismatch is PROVEN TAMPER — red-class, fail-closed, distinct
 *     from absence; nothing geometric is measured from altered bytes;
 *   - the planarity output is a signal a person weighs, never a verdict,
 *     and its text says so itself;
 *   - no string here says "passed" or "authentic".
 *
 * Correspondences are INJECTED by the caller (--correspondences pts.json):
 * ORB/SIFT feature extraction between the committed frames is a later
 * dependency (desk/stereo/index.ts header). Without them the command still
 * extracts, integrity-checks, and states the per-artifact truth.
 *
 * --primary <media file>: when the caller also hands over the primary
 * delivery frame, the desk runs the committed-calibration matcher
 * (desk/stereo/match.ts matchFrames) between the two committed frames and
 * prints the EPIPOLAR SURVIVAL row — a geometric-consistency measurement
 * co-reported NEXT TO the planarity signal, never fused into it, never a
 * verdict. The match runs only after integrity passes: nothing is measured
 * from altered bytes.
 */

import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  PROOF_BUNDLE_FORMAT,
  proofBundleGate,
  type ProofBundle,
} from '@exhibit/lib/proofBundle';
import {
  STEREO_ARTIFACT_IDS,
  STEREO_VIDEO_ARTIFACT_IDS,
  buildStereoCommitment,
  buildStereoVideoPairCommitment,
  checkStereoSectionIntegrity,
  checkVideoStereoSectionIntegrity,
  type StereoArtifactId,
  type StereoBundleSection,
  type StereoVideoArtifactId,
  type VideoStereoBundleSection,
} from '@exhibit/provenance/stereoArtifacts';
import {
  verifyStereoCommitment,
  type Correspondence,
  type PlanaritySignal,
  type StereoCommitment,
} from '../stereo/index';
import { matchFrames, type MatchReport, type MatchResult } from '../stereo/match';

// jpeg-js via createRequire — the same decode pattern as cli/ringDecode.ts:
// pure-JS, no native dependency, honest failure on undecodable input.
interface JpegJs {
  decode(data: Uint8Array, opts?: { maxMemoryUsageInMB?: number }): { width: number; height: number; data: Uint8Array };
}
const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js') as JpegJs;

export interface StereoDeskArtifact {
  id: StereoArtifactId;
  state: 'recorded' | 'error' | 'never-recorded';
  integrity: string;
  line: string;
}

export interface StereoDeskVideoPair {
  pairIndex: number;
  anchors: { primaryHostSeconds: number | null; synchronizedDeltaMs: number | null };
  artifacts: StereoDeskArtifact[];
  /** Per-pair planarity: 'clean' | 'tamper' | 'incomplete' | 'no-correspondences'. */
  planarityPath: string;
  signal?: PlanaritySignal;
}

export interface StereoDeskVideoReport {
  primaryVideoSha256: string;
  pairsCommitted: number;
  pairsMissed: number;
  hardwareCost: number | null;
  /** True when ANY pair entry failed integrity — each tamper names its pairIndex. */
  tamper: boolean;
  pairs: StereoDeskVideoPair[];
}

export interface StereoDeskReport {
  /** The format gate + stereo-section presence. */
  gate: { ok: boolean; error?: string };
  /** Media hash the section pairs with, when the gate passed. */
  primaryFrameSha256?: string;
  artifacts?: StereoDeskArtifact[];
  /** 'clean' | 'tamper' | 'incomplete' | 'no-correspondences' | 'no-stereo-section' */
  planarityPath: string;
  signal?: PlanaritySignal;
  /**
   * The matcher's own count-only evidence (desk/stereo/match.ts) — present
   * only when the caller supplied --primary and integrity passed. A SEPARATE
   * measurement from the planarity signal: co-reported, never fused.
   */
  matchReport?: MatchReport;
  /** Video pair analysis, when the bundle carries a videoStereo section. */
  video?: StereoDeskVideoReport;
  lines: string[];
}

/** Accept [{primary:[x,y],secondary:[x,y]}…] or { correspondences: [...] }. */
export function parseCorrespondencesJson(text: string): Correspondence[] {
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : parsed?.correspondences;
  if (!Array.isArray(arr)) {
    throw new Error('correspondences JSON must be an array (or { correspondences: [...] }) of { primary: [x,y], secondary: [x,y] }');
  }
  return arr.map((c: unknown, i: number) => {
    const o = c as { primary?: unknown; secondary?: unknown };
    const pt = (v: unknown): [number, number] => {
      if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
        throw new Error(`correspondence #${i}: points must be [x, y] finite numbers`);
      }
      return [v[0], v[1]];
    };
    return { primary: pt(o?.primary), secondary: pt(o?.secondary) };
  });
}

const ARTIFACT_LABEL: Record<StereoArtifactId, string> = {
  secondaryFrame: 'secondary frame (640×480 ultra-wide JPEG — geometry input)',
  calibration: 'calibration (intrinsics/extrinsics/distortion LUTs)',
  timestamps: 'sync timestamps',
  metadata: 'camera metadata block',
  rawDng: 'raw DNG (hash-only commitment — bytes stay in the vault)',
};

const VIDEO_ARTIFACT_LABEL: Record<StereoVideoArtifactId, string> = {
  secondaryFrame: 'secondary frame (640×480 ultra-wide JPEG — geometry input)',
  calibration: 'calibration (intrinsics/extrinsics)',
};

/**
 * VIDEO pair analysis (Spec §8): per-pair states printed, missed-pair
 * counts printed verbatim, planarity per pair when the caller injected
 * correspondences for that pairIndex. Fail-closed PER PAIR: a tampered
 * pair measures nothing, the others still report — each tamper names its
 * pairIndex. No string here says "passed" or "authentic".
 */
function analyzeVideoSection(
  bundle: ProofBundle,
  section: VideoStereoBundleSection,
  pairCorrespondences: Record<number, Correspondence[]> | null,
  lines: string[],
): StereoDeskVideoReport {
  const pairsPrimary = section.primaryVideoSha256 === bundle.media.sha256;
  lines.push(
    pairsPrimary
      ? `primary video: the video-stereo section pairs with this bundle's delivery file sha256:${section.primaryVideoSha256}`
      : `PROVEN TAMPER — the video-stereo section commits primary sha256:${section.primaryVideoSha256} but this bundle's delivery file is sha256:${bundle.media.sha256}. The section does not belong to this bundle.`,
  );
  lines.push(
    `pair cadence counts, committed verbatim: ${section.pairsCommitted} committed, ${section.pairsMissed} missed ` +
    '(a missed pair is a declared count — a stated fact, never suspicion, never silently absent); ' +
    `hardware cost ${section.hardwareCost === null ? 'not reported' : section.hardwareCost} (committed, uninterpreted). ` +
    `${section.pairs.length} pair entries ride this section.`,
  );

  const integrity = checkVideoStereoSectionIntegrity(section);
  const pairs: StereoDeskVideoPair[] = [];
  let tamper = !pairsPrimary;
  for (const pair of section.pairs) {
    const results = integrity.find((r) => r.pairIndex === pair.pairIndex)!;
    const artifacts: StereoDeskArtifact[] = [];
    let pairTamper = false;
    for (const id of STEREO_VIDEO_ARTIFACT_IDS) {
      const entry = pair.artifacts[id];
      const r = results.results[id];
      if (r.integrity === 'PROVEN-TAMPER') { pairTamper = true; tamper = true; }
      const line =
        r.integrity === 'never-recorded'
          ? `${id}: never-recorded${entry.reason ? ` (reason: ${entry.reason})` : ''} — an unreached state, never suspicion, never red`
          : r.integrity === 'record-error'
            ? `${id}: record error — the committed failure string: "${entry.error}" (a stated degradation, never a silent absence)`
            : r.integrity === 'hash-match'
              ? `${id}: recorded — ${entry.bytes} bytes, embedded bytes hash to the committed sha256:${entry.sha256}`
              : r.detail;
      artifacts.push({ id, state: entry.state, integrity: r.integrity, line });
      lines.push(`  pair ${pair.pairIndex} · ${VIDEO_ARTIFACT_LABEL[id]}\n    ${line}`);
    }
    lines.push(
      `  pair ${pair.pairIndex} anchors (from the pair event, verbatim): primary pts ` +
      `${pair.anchors.primaryHostSeconds === null ? 'not reported' : `${pair.anchors.primaryHostSeconds} s`}, sync delta ` +
      `${pair.anchors.synchronizedDeltaMs === null ? 'not reported' : `${pair.anchors.synchronizedDeltaMs} ms`}.`,
    );

    // Per-pair planarity — only from unaltered bytes, only when the caller
    // injected correspondences FOR THIS pair.
    let planarityPath = 'no-correspondences';
    let signal: PlanaritySignal | undefined;
    if (pairTamper) {
      planarityPath = 'tamper';
      lines.push(
        `  pair ${pair.pairIndex}: planarity NOT computed — the pair failed integrity; tamper fails closed. ` +
        'Nothing is measured from altered bytes, and a failed hash is never read as "absence of proof".',
      );
    } else {
      const corrs = pairCorrespondences?.[pair.pairIndex];
      if (!corrs || corrs.length === 0) {
        lines.push(
          `  pair ${pair.pairIndex}: planarity NOT computed — no correspondences supplied for this pair ` +
          '(inject them per pairIndex; nothing geometric was measured, and nothing is implied by that).',
        );
      } else {
        try {
          const commitment = buildStereoVideoPairCommitment(section, pair.pairIndex);
          signal = verifyStereoCommitment(commitment, corrs);
          planarityPath = 'clean';
          lines.push(
            `  pair ${pair.pairIndex}: commitment built from the committed inputs (no per-pair metadata block — the ` +
            `module commits none; the distance gate weighs the disparity cue alone); ${corrs.length} correspondences injected by the caller.`,
          );
          lines.push(`  pair ${pair.pairIndex} planarity signal state: ${signal.state}`);
          lines.push(signal.text);
        } catch (e) {
          planarityPath = 'incomplete';
          lines.push(
            `  pair ${pair.pairIndex}: planarity NOT computed — ${(e as Error).message} ` +
            'Absence of a signal is not suspicion and not clearance.',
          );
        }
      }
    }
    pairs.push({ pairIndex: pair.pairIndex, anchors: pair.anchors, artifacts, planarityPath, signal });
  }

  return {
    primaryVideoSha256: section.primaryVideoSha256,
    pairsCommitted: section.pairsCommitted,
    pairsMissed: section.pairsMissed,
    hardwareCost: section.hardwareCost,
    tamper,
    pairs,
  };
}

/**
 * Extract + integrity-check the stereo section of a parsed proof bundle and
 * run the planarity signal when correspondences are available. Pure with
 * respect to IO: pass the parsed bundle JSON, get the report + print lines.
 */
export function analyzeStereoBundle(
  parsed: unknown,
  correspondences?: Correspondence[] | null,
  pairCorrespondences?: Record<number, Correspondence[]> | null,
  /**
   * Optional: runs the committed-calibration matcher on the two committed
   * frames (IO lives in the caller — this function stays pure). Invoked only
   * after artifact integrity passes and the commitment builds; a throw or
   * null is reported as "match NOT run" with the reason, never absorbed.
   */
  matchProvider?: (commitment: StereoCommitment) => MatchResult | null,
): StereoDeskReport {
  const lines: string[] = [];
  const gate = proofBundleGate(parsed);
  if (!gate.ok) {
    lines.push(`REJECTED at the format gate: ${gate.error}`);
    return { gate: { ok: false, error: gate.error }, planarityPath: 'no-stereo-section', lines };
  }
  const bundle: ProofBundle = gate.bundle;
  const section: StereoBundleSection | undefined = bundle.stereo;
  if (!section) {
    // A video capture carries a videoStereo section instead (Spec §8) —
    // absence of the photo section is honest absence, stated either way.
    if (bundle.videoStereo) {
      if (matchProvider) {
        lines.push(
          'epipolar match row: NOT run — the committed-calibration matcher measures still pairs; ' +
          'this bundle carries a VIDEO stereo section and this path decodes no video frames. Stated, nothing implied by that.',
        );
      }
      const video = analyzeVideoSection(bundle, bundle.videoStereo, pairCorrespondences ?? null, lines);
      return {
        gate: { ok: true },
        primaryFrameSha256: bundle.videoStereo.primaryVideoSha256,
        planarityPath: video.tamper ? 'tamper' : video.pairs.some((p) => p.planarityPath === 'clean') ? 'clean' : 'no-correspondences',
        video,
        lines,
      };
    }
    lines.push(
      'no stereo section in this bundle — the capture path recorded no stereo artifacts ' +
      '(legacy single-lens fallback or a pre-stereo build). An absent section is honest ' +
      'absence: not suspicion, not clearance.',
    );
    return { gate: { ok: true }, planarityPath: 'no-stereo-section', lines };
  }

  // The section must pair with THIS bundle's delivery file — a section
  // pointing at a different primary is an internal contradiction.
  const pairsPrimary = section.primaryFrameSha256 === bundle.media.sha256;
  lines.push(
    pairsPrimary
      ? `primary frame: the stereo section pairs with this bundle's delivery file sha256:${section.primaryFrameSha256}`
      : `PROVEN TAMPER — the stereo section commits primary sha256:${section.primaryFrameSha256} but this bundle's delivery file is sha256:${bundle.media.sha256}. The section does not belong to this bundle.`,
  );

  const integrity = checkStereoSectionIntegrity(section);
  const artifacts: StereoDeskArtifact[] = [];
  let tamper = !pairsPrimary;
  for (const id of STEREO_ARTIFACT_IDS) {
    const entry = section.artifacts[id];
    const r = integrity[id];
    if (r.integrity === 'PROVEN-TAMPER') tamper = true;
    const line =
      r.integrity === 'never-recorded'
        ? `${id}: never-recorded${entry.reason ? ` (reason: ${entry.reason})` : ''} — an unreached state, never suspicion, never red`
        : r.integrity === 'record-error'
          ? `${id}: record error — the committed failure string: "${entry.error}" (a stated degradation, never a silent absence)`
          : r.integrity === 'hash-match'
            ? `${id}: recorded — ${entry.bytes} bytes, embedded bytes hash to the committed sha256:${entry.sha256}`
            : r.detail; // PROVEN-TAMPER / hash-only details speak for themselves
    artifacts.push({ id, state: entry.state, integrity: r.integrity, line });
    lines.push(`  ${ARTIFACT_LABEL[id]}\n    ${line}`);
  }

  if (tamper) {
    lines.push(
      'planarity NOT computed: the bundle failed integrity — tamper fails closed. ' +
      'Nothing is measured from altered bytes, and a failed hash is never read as "absence of proof".',
    );
    return { gate: { ok: true }, primaryFrameSha256: section.primaryFrameSha256, artifacts, planarityPath: 'tamper', lines };
  }

  let commitment: StereoCommitment;
  try {
    // Structural conformance: the app-side builder's output is assigned
    // through the CANONICAL desk type — drift fails this typecheck.
    commitment = buildStereoCommitment(section);
  } catch (e) {
    lines.push(
      `planarity NOT computed: ${(e as Error).message} ` +
      'Absence of a signal is not suspicion and not clearance.',
    );
    return { gate: { ok: true }, primaryFrameSha256: section.primaryFrameSha256, artifacts, planarityPath: 'incomplete', lines };
  }

  // The matcher's epipolar-survival measurement (desk/stereo/match.ts) —
  // run ONLY here: integrity passed and the commitment built. It is its own
  // row, co-reported with the planarity signal, never fused into it.
  let matchReport: MatchReport | undefined;
  if (matchProvider) {
    let match: MatchResult | null = null;
    try {
      match = matchProvider(commitment);
    } catch (e) {
      lines.push(
        `match NOT run: ${(e as Error).message} ` +
        'Absence of a signal is not suspicion and not clearance.',
      );
    }
    if (match) {
      matchReport = match.report;
      const es = match.report.epipolarSurvivalRate;
      lines.push(
        `epipolar survival — ${es.inliers}/${es.total} matches within ${es.threshold}px (Sampson) — ` +
        'a measurement of geometric consistency, never a verdict.' +
        (es.total === 0 ? ' Nothing was offered to the epipolar gate (low texture is a data limit, not a flag).' : ''),
      );
      lines.push(
        `  match survivor counts (committed-style, counts not adjectives): ${match.report.matchesAfterCrossCheck} after mutual cross-check, ` +
        `${match.report.matchesAfterRatio} after ratio test, ${match.report.matchesAfterEpipolar} after the epipolar gate; ` +
        `corners kept ${match.report.primary.keptCorners} (primary) / ${match.report.secondary.keptCorners} (secondary). ` +
        'Survivor counts show WHERE correspondences thinned out — characterization, never a score.',
      );
    } else {
      lines.push('match NOT run: the provider returned no result — stated, nothing implied by that.');
    }
  }

  if (!correspondences || correspondences.length === 0) {
    lines.push(
      'stereo commitment built from the committed inputs (calibration source: committed in the calibration artifact; ' +
      `sync delta ${commitment.syncTimestampDeltaMs} ms committed, uninterpreted).`,
    );
    lines.push(
      'planarity NOT computed: no correspondences supplied — feature extraction between the committed frames ' +
      'is a later dependency (desk/stereo/index.ts header); pass --correspondences pts.json to run the signal. ' +
      'Nothing geometric was measured, and nothing is implied by that.',
    );
    return { gate: { ok: true }, primaryFrameSha256: section.primaryFrameSha256, artifacts, planarityPath: 'no-correspondences', matchReport, lines };
  }

  const signal = verifyStereoCommitment(commitment, correspondences);
  lines.push(
    `stereo commitment built from the committed inputs; sync delta ${commitment.syncTimestampDeltaMs} ms (committed, uninterpreted); ` +
    `${correspondences.length} correspondences injected by the caller.`,
  );
  lines.push(`planarity signal state: ${signal.state}`);
  // The signal text passes through UNTOUCHED — it carries its own bounds
  // (effective range, "signal, not a verdict" framing).
  lines.push(signal.text);
  return {
    gate: { ok: true },
    primaryFrameSha256: section.primaryFrameSha256,
    artifacts,
    planarityPath: 'clean',
    signal,
    matchReport,
    lines,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function stereoMain(argv: string[], version: string): Promise<void> {
  let bundlePath: string | null = null;
  let corrPath: string | null = null;
  let primaryPath: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--correspondences') corrPath = argv[++i];
    else if (a === '--primary') primaryPath = argv[++i];
    else if (a === '--json') json = true;
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); process.exit(2); }
    else if (!bundlePath) bundlePath = a;
    else { console.error(`unexpected argument: ${a}`); process.exit(2); }
  }
  if (!bundlePath) {
    console.error('usage: exhibit-desk stereo <bundle.json> [--correspondences pts.json] [--primary <media file>] [--json]\n  pts.json: [corr…] for a photo section, or { "pairs": { "0": [corr…], … } } keyed by pairIndex for a video section\n  --primary: the primary delivery frame (JPEG) — runs the committed-calibration matcher and prints the epipolar-survival row (photo sections only)');
    process.exit(2);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
  } catch (e) {
    console.error(`exhibit-desk stereo: cannot read/parse ${bundlePath}: ${(e as Error).message}`);
    process.exit(2);
  }
  let correspondences: Correspondence[] | null = null;
  let pairCorrespondences: Record<number, Correspondence[]> | null = null;
  if (corrPath) {
    try {
      const raw = JSON.parse(fs.readFileSync(corrPath, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.pairs && typeof raw.pairs === 'object') {
        // Video pairs: { pairs: { "0": [corr…], "1": [corr…] } } — keyed by pairIndex.
        pairCorrespondences = {};
        for (const [k, v] of Object.entries(raw.pairs as Record<string, unknown>)) {
          const idx = Number(k);
          if (!Number.isInteger(idx) || idx < 0) throw new Error(`pairs key '${k}' is not a non-negative pairIndex`);
          pairCorrespondences[idx] = parseCorrespondencesJson(JSON.stringify(v));
        }
      } else {
        correspondences = parseCorrespondencesJson(fs.readFileSync(corrPath, 'utf8'));
      }
    } catch (e) {
      console.error(`exhibit-desk stereo: cannot read correspondences ${corrPath}: ${(e as Error).message}`);
      process.exit(2);
    }
  }

  // --primary: decode the caller's primary frame and the committed
  // secondary, run the matcher. All IO lives here; analyzeStereoBundle
  // stays pure and decides WHEN the match may run (integrity first).
  let matchProvider: ((commitment: StereoCommitment) => MatchResult | null) | undefined;
  if (primaryPath) {
    let primaryBytes: Uint8Array;
    try {
      primaryBytes = fs.readFileSync(primaryPath);
    } catch (e) {
      console.error(`exhibit-desk stereo: cannot read primary frame ${primaryPath}: ${(e as Error).message}`);
      process.exit(2);
    }
    matchProvider = (commitment) => {
      const primary = jpeg.decode(primaryBytes, { maxMemoryUsageInMB: 512 });
      if (!primary || primary.width < 16 || primary.height < 16) {
        throw new Error(`primary frame ${primaryPath} is not a decodable JPEG (the matcher measures pixels, it never guesses)`);
      }
      const secSource = commitment.secondaryFrame;
      const secBytes = 'bytes' in secSource ? secSource.bytes : new Uint8Array(fs.readFileSync(secSource.path));
      const secondary = jpeg.decode(secBytes, { maxMemoryUsageInMB: 256 });
      if (!secondary || secondary.width < 16 || secondary.height < 16) {
        throw new Error('the committed secondary frame is not a decodable JPEG — no pixels, no measurement');
      }
      return matchFrames(
        { data: primary.data, width: primary.width, height: primary.height },
        { data: secondary.data, width: secondary.width, height: secondary.height },
        commitment.calibration,
      );
    };
  }

  const report = analyzeStereoBundle(parsed, correspondences, pairCorrespondences, matchProvider);

  if (json) {
    console.log(JSON.stringify({ ...report, lines: undefined }, null, 2));
    if (!report.gate.ok) process.exit(1);
    return;
  }

  console.log(`exhibit-desk ${version} — stereo artifact extraction + planarity SIGNAL (bundle format ${PROOF_BUNDLE_FORMAT}; committed inputs, recomputed geometry — evidence a person weighs, never a verdict)`);
  for (const l of report.lines) console.log(l);
  if (!report.gate.ok) process.exit(1);
  if (report.planarityPath === 'tamper') process.exit(1);
}
