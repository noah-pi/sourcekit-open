/**
 * exhibit-c — the Source Kit Desk CLI (renamed from exhibit-c; the old path is
 * a forwarding shim, removed next minor).
 *
 * Batch verification around the SAME shared core as the browser app:
 * signatures, custody, time evidence, trust resolution, cross-item recovery
 * matches. Photo/video analysis runs through the SAME shared DSP as the web
 * app, rasterized by ffmpeg instead of canvas (stated in every report).
 *
 * Usage:
 *   exhibit-c <paths...> [options]
 *     --trust <roster.json>   trust list (repeatable); an invalid roster is
 *                             refused loudly, never silently ignored
 *     --online                bind OTS receipts to block headers (default:
 *                             offline — structural checks only, and said so)
 *     --json <out.json>       machine-readable report
 *     --sign                  sign the JSON report with this CLI's key
 *                             (~/.exhibit-c; software key — custody of the
 *                             REPORT, never vouching for capture truth)
 *     --pdf <out.pdf>         human-readable rendering of the report
 *     --corpus <labels.csv>   regression mode over a labeled corpus: per-file
 *                             verdicts + rephoto signal distributions by class
 *
 * HONESTY INVARIANTS (same as the app):
 *   - unsigned files are neutral, never red;
 *   - every sensor/context signal is evidence a person weighs — the CLI
 *     prints measurements, never detector verdicts;
 *   - pHash matches are leads, never verdicts;
 *   - "custody, not reality": a green line means bytes unchanged + known
 *     signer, never that the camera pointed at what anyone claims.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  classifyAndVerify, checkProofBundle, checkHashClaim, checkRoster,
  resolveDeskTrust, resolveSignerTrust, findRecoveryMatches, findManifestCustodyMatches,
  type IntakeItem, type DeskAdapters, type DeskTrust,
} from '../src/core/deskCore';
import { isRoster, type Roster } from '@exhibit/lib/roster';
import { getOrCreateDeskKey, signReport, migrateConfigDir } from './deskKey';
import { buildPdf, type PdfLine } from './pdf';
import { nodePHash, nodeRephoto, nodeVideoMotion, ffmpegAvailable } from './raster';
import { analyzeParallaxBurst, parseSensorLogJsonl, type ParallaxEvidence } from '../src/core/parallax';
import { analyzeDisplayBeat, type DisplayBeatEvidence } from '../src/core/displayBeat';
import { extractEnfTrace, ENF_MIN_DURATION_SEC, type EnfExtractEvidence } from '../src/core/enfExtract';
import { analyzeOnsetAlignment, type AvSyncEvidence } from '../src/core/avSync';
import { analyzeRollingShutterSkew, type SkewEvidence } from '../src/core/rollingShutter';
import { probeVideo, extractGrayFrames, lumaSeriesFromPlanes, extractPcmMono16k, motionSeriesFromPlanes } from './avExtract';
import { deskAnalyzer } from '../src/core/analyzers';
import { readRingDir } from './ringDecode';
import { stereoMain } from './stereoVerify';
import { resolveAsset, RESOLVE_ENGINE_PINS, type ResolveResult } from '../src/core/resolve';
import type { EngineTrustOptions } from '@exhibit/provenance/engine/upstreamEngine';

const VERSION = '0.15.0';

/**
 * Print and exit(2) — typed `never` so strict null-assignability and
 * definite-assignment analysis hold after a refusal regardless of how the
 * host types `process.exit` (the W1 strict-gate fixes; no behavior change).
 */
function bail(message: string): never {
  console.error(message);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface CliArgs {
  paths: string[];
  trustPaths: string[];
  online: boolean;
  jsonOut: string | null;
  sign: boolean;
  pdfOut: string | null;
  corpusCsv: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { paths: [], trustPaths: [], online: false, jsonOut: null, sign: false, pdfOut: null, corpusCsv: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--trust') args.trustPaths.push(argv[++i]);
    else if (a === '--online') args.online = true;
    else if (a === '--json') args.jsonOut = argv[++i];
    else if (a === '--sign') args.sign = true;
    else if (a === '--pdf') args.pdfOut = argv[++i];
    else if (a === '--corpus') args.corpusCsv = argv[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); printUsage(); process.exit(2); }
    else args.paths.push(a);
  }
  return args;
}

function printUsage(): void {
  console.log(`exhibit-c ${VERSION} — batch verification for Source Kit captures
  exhibit-c <paths...> [--trust roster.json ...] [--online]
                          [--json out.json] [--sign] [--pdf out.pdf]
                          [--corpus labels.csv]
  exhibit-c parallax <ringDir> [--sensors log.jsonl] [--json]
                          scene-flatness measurement from an 8-frame ring
                          dump (analyzer tier 1 — evidence, never a verdict)
  exhibit-c resolve <paths...> [--json out.json]
                          [--trust-anchors anchors.pem --trust-list official|interim]
                          RESOLVE: what any producer's C2PA manifest
                          carries + what the official engine said — verdicts
                          remain the policy layer's alone
  WS5 Tier-1 forensic analyzers (evidence, never verdicts; each reports
  'not available — <reason>' rather than fabricating):
  exhibit-c displaybeat <video|ringDir> [--fps N] [--interval S] [--json]
                          periodic luma beat at display-refresh families
                          — measured frequency + strength, never a
                          recapture verdict
  exhibit-c enf <audio> [--mains 50|60] [--json]
                          ENF trace extraction only, NO reference matching
                          — under ${ENF_MIN_DURATION_SEC} s of audio the
                          report is 'insufficient' with no trace
  exhibit-c avsync <video> [--fps N] [--json]
                          audio-onset vs motion-onset alignment offset in ms
                          — dubbing-relevant desync as a measurement,
                          never a dubbing verdict
  exhibit-c skew <video> [--sensors log.jsonl] [--fps N] [--json]
                          rolling-shutter row skew vs gyro rotation rate
                          — geometric consistency, no score
  exhibit-c stereo <bundle.json> [--correspondences pts.json] [--json]
                          stereo-artifact extraction from a proof bundle:
                          committed hashes checked (a mismatch is PROVEN
                          TAMPER, red-class — never "absence of proof"),
                          never-recorded stated as an unreached state,
                          then the planarity SIGNAL when correspondences
                          are supplied — its text prints verbatim, bounds
                          included, a signal never a verdict`);
}

// ---------------------------------------------------------------------------
// resolve subcommand — parse-any-manifest over ARBITRARY C2PA assets.
// RESOLVE reports what the asset carries and what the engine said. It never
// emits a verdict — the policy layer is the only verdict authority.
// ---------------------------------------------------------------------------

interface ResolveCliArgs {
  paths: string[];
  jsonOut: string | null;
  trustAnchorsPath: string | null;
  trustList: 'official' | 'interim' | null;
}

async function resolveMain(argv: string[]): Promise<void> {
  const args: ResolveCliArgs = { paths: [], jsonOut: null, trustAnchorsPath: null, trustList: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.jsonOut = argv[++i];
    else if (a === '--trust-anchors') args.trustAnchorsPath = argv[++i];
    else if (a === '--trust-list') {
      const v = argv[++i];
      if (v !== 'official' && v !== 'interim') {
        bail(`--trust-list must be 'official' or 'interim', got "${v}"`);
      }
      args.trustList = v;
    } else if (a === '--help' || a === '-h') { printUsage(); return; }
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); printUsage(); process.exit(2); }
    else args.paths.push(a);
  }
  if (args.paths.length === 0) { printUsage(); process.exit(2); }

  // Trust material is caller-pinned and offline; the anchors and the list
  // they are claimed to be must arrive TOGETHER — one without the other
  // would imply an evaluation basis that was never declared.
  let trust: EngineTrustOptions | undefined;
  if (args.trustAnchorsPath || args.trustList) {
    const anchorsPath = args.trustAnchorsPath;
    const trustList = args.trustList;
    if (!anchorsPath || !trustList) {
      bail('REFUSED: --trust-anchors and --trust-list must be given together (anchors without a declared list, or a list without anchors, is an undeclared trust basis)');
    }
    let anchorsPem: string;
    try {
      anchorsPem = fs.readFileSync(anchorsPath, 'utf8');
    } catch (e) {
      bail(`REFUSED: cannot read trust anchors ${anchorsPath}: ${(e as Error).message}`);
    }
    trust = { anchorsPem, kind: trustList };
  }

  const items: { name: string; result: ResolveResult | null; error?: string }[] = [];
  for (const p of args.paths) {
    const name = path.basename(p);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(fs.readFileSync(p));
    } catch {
      items.push({ name, result: null, error: 'file not found' });
      continue;
    }
    items.push({ name, result: await resolveAsset(bytes, { trust }) });
  }

  const trustBasis = trust ? `${trust.kind} (caller-pinned anchors: ${args.trustAnchorsPath})` : 'not evaluated — no caller-pinned anchors';
  console.log(`exhibit-c ${VERSION} — RESOLVE · engine pins: c2pa-node@${RESOLVE_ENGINE_PINS.c2paNode} (${RESOLVE_ENGINE_PINS.c2paNodeRequires}), wasm fallback @${RESOLVE_ENGINE_PINS.c2paWasm} · trust-list basis: ${trustBasis}`);

  for (const item of items) {
    console.log(`\n${item.name}`);
    if (!item.result) {
      console.log(`  ${item.error}`);
      continue;
    }
    const r = item.result;
    console.log(`  resolved: ${r.resolved ? 'yes' : 'no'} (engine: ${r.engine} ${r.engineVersion})`);
    if (r.activeManifest) {
      const m = r.activeManifest;
      console.log(`  producer: ${m.producer ?? '(not stated)'} · claim version: ${m.claimVersion ?? '(not stated)'} · format: ${m.format ?? '(not stated)'}`);
      if (m.title) console.log(`  title: ${m.title}`);
      if (m.signature) {
        console.log(`  signature: ${m.signature.alg ?? '?'} · issuer ${m.signature.issuer ?? m.signature.commonName ?? '?'} · chain length ${m.signature.certChainLength}${m.signature.time ? ` · signed ${m.signature.time}` : ''}`);
      }
      console.log(`  ingredients: ${m.ingredients.length}${m.ingredients.length === 0 ? ' (none — an original capture, as far as the claim states)' : ''}`);
      for (const ing of m.ingredients) {
        console.log(`    - ${ing.title ?? ing.label ?? '(untitled)'}${ing.relationship ? ` [${ing.relationship}]` : ''}${ing.format ? ` · ${ing.format}` : ''}`);
      }
    }
    if (r.manifests.length > 1) console.log(`  manifests: ${r.manifests.length} (report above is the active one)`);
    console.log(`  validation state: ${r.validationState ?? '(not reported)'}`);
    if (r.validationStatus.length > 0) {
      console.log('  validation status codes:');
      for (const s of r.validationStatus) {
        console.log(`    - ${s.code} [${s.severity}]${s.explanation ? ` — ${s.explanation}` : ''}`);
      }
    } else {
      console.log('  validation status codes: none reported');
    }
    console.log(`  trustListStatus: ${r.trustListStatus}`);
    for (const d of r.disclosures) console.log(`  disclosure: ${d}`);
    for (const e of r.errors) console.log(`  engine error: ${e}`);
  }
  console.log('\nRESOLVE reports what each asset carries and what the engine said — verdicts (INTACT / CONTENT_MODIFIED / SIGNATURE_INVALID / NO_ATTESTATION / UNSUPPORTED) remain the policy layer\'s alone; run plain exhibit-c for verdicts.');

  if (args.jsonOut) {
    const report = {
      format: 'exhibit-c.resolve-report' as const,
      version: 1,
      createdAt: new Date().toISOString(),
      tool: { name: 'exhibit-c CLI', version: VERSION },
      enginePins: RESOLVE_ENGINE_PINS,
      trust: trust
        ? { anchorsPath: args.trustAnchorsPath, declaredList: trust.kind }
        : { anchorsPath: null, declaredList: null, note: 'trust not evaluated — no caller-pinned anchors this run' },
      items: items.map((i) => ({ name: i.name, error: i.error ?? null, result: i.result })),
      verdictAuthority: 'RESOLVE emits no verdicts; the policy layer (src/provenance/engine/policyLayer.ts) is the only verdict authority.',
    };
    fs.writeFileSync(args.jsonOut, JSON.stringify(report, null, 2));
    console.log(`\nJSON report: ${args.jsonOut}`);
  }
}

// ---------------------------------------------------------------------------
// parallax subcommand — ring-dump flatness measurement.
// The camera commits, it never concludes; Source Kit Desk measures, it never decides.
// ---------------------------------------------------------------------------

async function parallaxMain(argv: string[]): Promise<void> {
  let ringDir: string | null = null;
  let sensorsPath: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sensors') sensorsPath = argv[++i];
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') { printUsage(); return; }
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); printUsage(); process.exit(2); }
    else if (!ringDir) ringDir = a;
    else { console.error(`unexpected argument: ${a}`); printUsage(); process.exit(2); }
  }
  if (!ringDir) { printUsage(); process.exit(2); }

  let frames: ReturnType<typeof readRingDir>;
  try {
    frames = readRingDir(ringDir, fs, path);
  } catch (e) {
    console.error(`exhibit-c parallax: cannot read ring directory ${ringDir}: ${(e as Error).message}`);
    process.exit(2);
  }
  if (frames.length === 0) {
    console.error(`exhibit-c parallax: no f*.jpg frames in ${ringDir} — expected a CaptureKit ring dump (f000.jpg…f007.jpg)`);
    process.exit(2);
  }

  let gyro = null;
  if (sensorsPath) {
    try {
      gyro = parseSensorLogJsonl(fs.readFileSync(sensorsPath, 'utf8'));
    } catch (e) {
      console.error(`exhibit-c parallax: cannot read sensor log ${sensorsPath}: ${(e as Error).message}`);
      process.exit(2);
    }
  }

  const evidence: ParallaxEvidence = analyzeParallaxBurst(frames, { gyro });
  const entry = deskAnalyzer('parallax');

  if (json) {
    console.log(JSON.stringify({ analyzer: entry ?? null, evidence }, null, 2));
    return;
  }

  console.log(`exhibit-c ${VERSION} — parallax scene-flatness MEASUREMENT (analyzer tier ${entry?.tier ?? 1}, method ${evidence.methodVersion})`);
  console.log(`ring: ${ringDir} — ${evidence.framesDecoded} frames decoded · gyro rotation compensation: ${evidence.rotationCompensated ? 'yes (sensor-log prior UNAUTHENTICATED — a crafted log can bias this measurement)' : 'no'}`);
  if (evidence.insufficient) {
    console.log(`\nINSUFFICIENT DATA — no measurement offered:\n  ${evidence.insufficient}`);
  } else {
    console.log(`\ntracks used: ${evidence.tracksUsed} (inlier ratio ${evidence.inlierRatio})`);
    console.log(`planar-model residual: median ${evidence.planarResidualPx.median} px, p90 ${evidence.planarResidualPx.p90} px`);
    console.log(`depth spread estimate: ${evidence.depthSpreadEstimate.value} ${evidence.depthSpreadEstimate.unit}`);
    console.log(`  ${evidence.depthSpreadEstimate.note}`);
    if (evidence.depthModelResidualPx) console.log(`common-direction (translational parallax) fit residual: median ${evidence.depthModelResidualPx.median} px`);
    console.log(`burst baseline: ${evidence.baselinePx} px · rotation/pair rad: [${evidence.rotationPerPairRad.join(', ')}]`);
  }
  console.log('\nlimitations:');
  for (const l of evidence.limitations) console.log(`  - ${l}`);
  console.log('\nThis is a geometric measurement a person weighs — never a detector verdict, never a gate. The camera commits, it never concludes; Source Kit Desk measures, it never decides.');
}

// ---------------------------------------------------------------------------
// Tier-1 forensic subcommands — evidence, never verdicts. Every subcommand
// prints the analyzer registry entry, the evidence object, and its
// limitations; unavailable input is 'not available — <reason>', never an
// error and never a fabricated number.
// ---------------------------------------------------------------------------

function printAnalyzerFooter(evidence: { limitations: string[] }): void {
  console.log('\nlimitations:');
  for (const l of evidence.limitations) console.log(`  - ${l}`);
  console.log('\nThis is a measurement a person weighs — never a detector verdict, never a gate. The camera commits, it never concludes; Source Kit Desk measures, it never decides.');
}

/** Shared option parse for the analyzer subcommands: flags with values + --json. */
function ws5Args(argv: string[], valueFlags: string[]): { pos: string[]; json: boolean; flags: Record<string, string> } {
  const out = { pos: [] as string[], json: false, flags: {} as Record<string, string> };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (valueFlags.includes(a)) out.flags[a] = argv[++i];
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (a.startsWith('--')) { console.error(`unknown option: ${a}`); printUsage(); process.exit(2); }
    else out.pos.push(a);
  }
  return out;
}

async function displaybeatMain(argv: string[]): Promise<void> {
  const { pos, json, flags } = ws5Args(argv, ['--fps', '--interval']);
  const target = pos[0];
  if (!target) { printUsage(); process.exit(2); }
  const entry = deskAnalyzer('displaybeat');

  let evidence: DisplayBeatEvidence;
  let sourceDesc: string;
  const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
  if (isDir) {
    // Preview ring frames: uniform spacing assumed (the dump records no
    // per-frame timestamps) — the analyzer's limitations carry the note.
    const intervalSec = flags['--interval'] ? Number(flags['--interval']) : 1 / 30;
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      console.error(`exhibit-c displaybeat: --interval must be a positive number of seconds`);
      process.exit(2);
    }
    const frames = readRingDir(target, fs, path).filter((f): f is NonNullable<typeof f> => f !== null);
    const fps = 1 / intervalSec;
    sourceDesc = `${target} (ring dump, ${frames.length} frames decoded @ uniform ${(intervalSec * 1000).toFixed(1)} ms assumed spacing)`;
    evidence = analyzeDisplayBeat(lumaSeriesFromPlanes(frames, fps), {
      sampleRateHz: fps,
      sourceNote: `preview ring dump (jpeg-js decode), uniform ${intervalSec.toFixed(4)} s spacing assumed — the dump records no per-frame timestamps`,
    });
  } else {
    if (!fs.existsSync(target)) {
      console.error(`exhibit-c displaybeat: ${target} not found — not available, nothing measured`);
      process.exit(2);
    }
    const probe = probeVideo(target);
    const fps = flags['--fps'] ? Number(flags['--fps']) : Math.min(60, Math.max(1, Math.round(probe?.fps ?? 30)));
    if (!Number.isFinite(fps) || fps <= 0) {
      console.error(`exhibit-c displaybeat: --fps must be a positive number`);
      process.exit(2);
    }
    const raster = extractGrayFrames(target, fps, 96, 900);
    sourceDesc = `${target} (video track, ffmpeg fps=${fps} grid)`;
    evidence = analyzeDisplayBeat(raster ? lumaSeriesFromPlanes(raster.frames, fps) : null, {
      sampleRateHz: fps,
      sourceNote: raster
        ? `video track via ffmpeg, uniform fps=${fps} grid, 96-px raster${raster.dropped > 0 ? `, analysis capped at ${raster.frames.length} frames (${raster.dropped} dropped — stated, not hidden)` : ''}`
        : 'not available — ffmpeg could not decode the video track',
    });
  }

  if (json) {
    console.log(JSON.stringify({ analyzer: entry ?? null, evidence }, null, 2));
    return;
  }
  console.log(`exhibit-c ${VERSION} — display-beat MEASUREMENT (analyzer tier ${entry?.tier ?? 1}, method ${evidence.methodVersion})`);
  console.log(`source: ${sourceDesc}`);
  if (evidence.insufficient) {
    console.log(`\nINSUFFICIENT DATA — no measurement offered:\n  ${evidence.insufficient}`);
  } else {
    console.log(`\nsamples: ${evidence.samplesUsed} @ ${evidence.sampleRateHz} Hz (${evidence.durationSec} s)`);
    if (evidence.strongestBeat) {
      console.log(`strongest periodic component: ${evidence.strongestBeat.frequencyHz} Hz at ${evidence.strongestBeat.snrDb} dB over the noise floor`);
    } else {
      console.log('strongest periodic component: none above the report floor — NOT evidence of absence (see limitations)');
    }
    console.log('display-family candidates:');
    for (const c of evidence.candidates) {
      console.log(`  ${c.familyHz} Hz ×${c.harmonic} (${c.sourceHz} Hz → aliased ${c.aliasedHz} Hz): ${c.assessable ? `SNR ${c.snrDb} dB` : `NOT assessable — ${c.note}`}`);
    }
  }
  printAnalyzerFooter(evidence);
}

async function enfMain(argv: string[]): Promise<void> {
  const { pos, json, flags } = ws5Args(argv, ['--mains']);
  const target = pos[0];
  if (!target) { printUsage(); process.exit(2); }
  const entry = deskAnalyzer('enf-extract');

  let mainsHz: 50 | 60 | null = null;
  if (flags['--mains'] !== undefined) {
    const v = Number(flags['--mains']);
    if (v !== 50 && v !== 60) {
      bail(`exhibit-c enf: --mains must be 50 or 60 (the capture's region-derived mainsHz hint), got "${flags['--mains']}"`);
    }
    mainsHz = v;
  }
  if (!fs.existsSync(target)) {
    console.error(`exhibit-c enf: ${target} not found — not available, nothing extracted`);
    process.exit(2);
  }
  const pcm = extractPcmMono16k(target);
  const evidence: EnfExtractEvidence = extractEnfTrace(
    pcm ? pcm.samples : null,
    pcm?.sampleRateHz ?? 16000,
    { mainsHz },
  );

  if (json) {
    console.log(JSON.stringify({ analyzer: entry ?? null, evidence }, null, 2));
    return;
  }
  console.log(`exhibit-c ${VERSION} — ENF trace EXTRACTION ONLY, no reference matching at Tier 1 (analyzer tier ${entry?.tier ?? 1}, method ${evidence.methodVersion})`);
  console.log(`source: ${target}${pcm ? '' : ' — audio NOT AVAILABLE (no decodable track; absent vs never-recorded cannot be distinguished from the file alone)'}`);
  console.log(`mainsHz hint: ${evidence.mainsHintHz ?? 'absent'} (${evidence.mainsHintBasis})`);
  if (evidence.insufficient) {
    console.log(`\nINSUFFICIENT — no trace, no number offered as evidence:\n  ${evidence.insufficient}`);
  } else {
    const q = evidence.quality!;
    console.log(`\nnominal family: ${evidence.nominalHz} Hz (${evidence.nominalBasis}) · duration ${evidence.durationSec} s @ ${evidence.sampleRateHz} Hz`);
    console.log(`windows: ${q.windowsUsable}/${q.windowsTotal} usable (coverage ${q.coverage}) · mean hum SNR ${q.meanSnrDb} dB · trace stability σ=${q.hzStd} Hz`);
    console.log(`trace (${evidence.trace!.length} points, first/last shown):`);
    const t = evidence.trace!;
    const shown = t.length <= 12 ? t : [...t.slice(0, 6), null, ...t.slice(-5)];
    for (const p of shown) {
      if (p === null) { console.log('  …'); continue; }
      console.log(`  t=${p.tSec}s  ${p.hz} Hz  (${p.snrDb} dB${p.usable ? '' : ', below usability gate'})`);
    }
    console.log('\nEXTRACT ONLY: this trace is never compared against any grid reference at Tier 1 — no consistency-with-claims conclusion follows from it by itself (reference matching is a separate tier with grid data).');
  }
  printAnalyzerFooter(evidence);
}

async function avsyncMain(argv: string[]): Promise<void> {
  const { pos, json, flags } = ws5Args(argv, ['--fps']);
  const target = pos[0];
  if (!target) { printUsage(); process.exit(2); }
  const entry = deskAnalyzer('avsync');
  if (!fs.existsSync(target)) {
    console.error(`exhibit-c avsync: ${target} not found — not available, nothing measured`);
    process.exit(2);
  }
  const fps = flags['--fps'] ? Number(flags['--fps']) : 10;
  if (!Number.isFinite(fps) || fps <= 0) {
    console.error(`exhibit-c avsync: --fps must be a positive number`);
    process.exit(2);
  }
  const probe = probeVideo(target);
  const raster = extractGrayFrames(target, fps, 96, 600);
  const pcm = extractPcmMono16k(target);
  const motion = raster ? motionSeriesFromPlanes(raster.frames, fps) : null;
  const evidence: AvSyncEvidence = analyzeOnsetAlignment(
    pcm ? { sampleRateHz: pcm.sampleRateHz, samples: pcm.samples } : null,
    motion ? motion.motion : null,
  );
  if (raster && raster.dropped > 0) evidence.limitations.push(`CLI: analysis capped at ${raster.frames.length} frames (${raster.dropped} dropped — stated, not hidden)`);
  if (motion && motion.gaps > 0) evidence.limitations.push(`CLI: ${motion.gaps} frame pair(s) produced no global motion fit (counted as zero magnitude — disclosed, never interpolated)`);
  if (probe && !probe.hasAudio) evidence.limitations.push('CLI: ffprobe reports NO audio stream in this container — the audio side is absent/never-recorded, not failed');

  if (json) {
    console.log(JSON.stringify({ analyzer: entry ?? null, evidence }, null, 2));
    return;
  }
  console.log(`exhibit-c ${VERSION} — onset-alignment A/V desync MEASUREMENT (analyzer tier ${entry?.tier ?? 1}, method ${evidence.methodVersion})`);
  console.log(`source: ${target} (ffmpeg fps=${fps} motion grid + 16 kHz mono envelope; motion magnitude = |translation| + |roll|·width/2, px-equivalent)`);
  if (evidence.insufficient) {
    console.log(`\nINSUFFICIENT DATA — no measurement offered:\n  ${evidence.insufficient}`);
  } else {
    console.log(`\nmeasured offset: ${evidence.offsetMs} ms (positive = audio onsets LATER than motion onsets) · peak correlation ${evidence.correlation} over ±${evidence.lagRangeMs[1]} ms`);
    console.log(`onsets: audio ${evidence.audioOnsets}, motion ${evidence.motionOnsets} · grid ${evidence.sampleIntervalMs} ms × ${evidence.samplesUsed} samples`);
    if (evidence.strongestOnset) {
      console.log(`strongest-onset pair: audio @ ${evidence.strongestOnset.audioAtSec}s vs motion @ ${evidence.strongestOnset.motionAtSec}s → ${evidence.strongestOnset.offsetMs} ms (single event pair, stated as such)`);
    }
  }
  printAnalyzerFooter(evidence);
}

async function skewMain(argv: string[]): Promise<void> {
  const { pos, json, flags } = ws5Args(argv, ['--sensors', '--fps']);
  const target = pos[0];
  if (!target) { printUsage(); process.exit(2); }
  const entry = deskAnalyzer('rolling-shutter');
  if (!fs.existsSync(target)) {
    console.error(`exhibit-c skew: ${target} not found — not available, nothing measured`);
    process.exit(2);
  }
  const fps = flags['--fps'] ? Number(flags['--fps']) : 30;
  if (!Number.isFinite(fps) || fps <= 0) {
    console.error(`exhibit-c skew: --fps must be a positive number`);
    process.exit(2);
  }
  let gyro = null;
  if (flags['--sensors']) {
    try {
      gyro = parseSensorLogJsonl(fs.readFileSync(flags['--sensors'], 'utf8'));
    } catch (e) {
      console.error(`exhibit-c skew: cannot read sensor log ${flags['--sensors']}: ${(e as Error).message}`);
      process.exit(2);
    }
  }
  const raster = extractGrayFrames(target, fps, 160, 150);
  const evidence: SkewEvidence = analyzeRollingShutterSkew(raster ? raster.frames : null, {
    gyro,
    frameIntervalSec: 1 / fps,
    sourceNote: raster
      ? `video track via ffmpeg, uniform fps=${fps} grid, 160-px raster${raster.dropped > 0 ? `, capped at ${raster.frames.length} frames (${raster.dropped} dropped — stated, not hidden)` : ''}`
      : 'not available — ffmpeg could not decode the video track',
  });

  if (json) {
    console.log(JSON.stringify({ analyzer: entry ?? null, evidence }, null, 2));
    return;
  }
  console.log(`exhibit-c ${VERSION} — rolling-shutter skew vs IMU MEASUREMENT (analyzer tier ${entry?.tier ?? 1}, method ${evidence.methodVersion})`);
  console.log(`source: ${target} · gyro reference: ${gyro ? 'present (UNAUTHENTICATED sidecar — consistency is evidence, never a trust upgrade)' : 'not provided'}`);
  if (evidence.insufficient) {
    console.log(`\nINSUFFICIENT DATA — no measurement offered:\n  ${evidence.insufficient}`);
  } else {
    console.log(`\nskew estimate: ${evidence.skewEstimate!.value} ${evidence.skewEstimate!.unit} (median over ${evidence.pairsAnalyzed} pairs)`);
    console.log(`per-pair slope px/row: [${evidence.perPair.map((p) => p.bandGradientPxPerRow).join(', ')}]`);
    if (evidence.gyroConsistency) {
      const g = evidence.gyroConsistency;
      console.log(`gyro consistency (${g.axisResolved}): correlation ${g.correlation ?? 'n/a'}, sign agreement ${g.signAgreement ?? 'n/a'} over ${g.pairsUsed} pairs`);
      console.log(`per-pair gyro rate rad/s: [${evidence.perPair.map((p) => p.gyroRateRadPerSec ?? 'n/a').join(', ')}]`);
    } else {
      console.log('gyro consistency: not available — see limitations');
    }
  }
  printAnalyzerFooter(evidence);
}

// ---------------------------------------------------------------------------
// Trust lists — refused loudly when invalid, never silently ignored
// ---------------------------------------------------------------------------

function loadRosters(paths: string[]): { rosters: Roster[]; lines: string[] } {
  const rosters: Roster[] = [];
  const lines: string[] = [];
  for (const p of paths) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!isRoster(parsed)) {
        lines.push(`REFUSED ${p}: not a roster file`);
        continue;
      }
      const check = checkRoster(parsed);
      if (!check.ok) {
        lines.push(`REFUSED ${p}: ${check.reason}`);
        continue;
      }
      rosters.push(parsed);
      lines.push(`Trust list "${parsed.newsroom}" accepted (editor ${parsed.editor.name}, ${parsed.entries.length} entries, signature valid)`);
    } catch (e) {
      lines.push(`REFUSED ${p}: unreadable (${(e as Error).message})`);
    }
  }
  return { rosters, lines };
}

// ---------------------------------------------------------------------------
// Per-item reporting
// ---------------------------------------------------------------------------

const adapters: DeskAdapters = { pHash: nodePHash, rephoto: nodeRephoto, videoMotion: nodeVideoMotion };

interface ItemSummary {
  name: string;
  kind: string;
  verdict: string | null;
  signerFingerprint: string | null;
  trust: DeskTrust | null;
  lines: string[];
}

function summarizeItem(item: IntakeItem, rosters: Roster[], online: boolean): ItemSummary {
  const lines: string[] = [];
  let verdict: string | null = null;
  let fp: string | null = null;
  let trust: DeskTrust | null = null;

  if (item.kind === 'media' && item.report) {
    verdict = item.report.verdict;
    fp = item.report.c2pa?.signerFingerprint ?? item.report.record?.signer?.fingerprint ?? null;
    trust = resolveDeskTrust(item.report, rosters);
    lines.push(`  verdict: ${verdict}`);
    if (item.policy) {
      // The policy layer is the verdict authority; the engine only
      // returns facts. Row + reason are disclosed, never hidden.
      lines.push(`  verdict basis: policy layer row ${item.policy.mappingRow} — ${item.policy.reason}`);
    }
    if (fp && trust) lines.push(`  signer: ${fp.slice(0, 16)}… — ${trust.basis}`);
    for (const l of item.report.checksPerformed ?? []) lines.push(`  checked: ${l}`);
    for (const l of item.report.checksNotPerformed ?? []) lines.push(`  not checked: ${l}`);
    if (item.rephoto) {
      lines.push(`  rephoto signals (evidence, never a verdict): banding ${item.rephoto.banding.strength} (${item.rephoto.banding.snrDb.toFixed(1)} dB), moiré ${item.rephoto.moire.strength} (${item.rephoto.moire.snrDb.toFixed(1)} dB), black lift ${item.rephoto.blackFloor.liftEstimate.toFixed(1)}, clipped channels ${(item.rephoto.gamut.channelClipFraction * 100).toFixed(1)}%`);
    } else if (item.bytes && (item.bytes[0] === 0xff || item.bytes[0] === 0x89)) {
      // Photos only — rephoto analysis is a still-image signal.
      lines.push('  rephoto signals: not measured (rasterizer unavailable or unrasterizable)');
    }
    if (item.imuFlow) {
      lines.push(`  IMU↔flow cross-check (evidence, never a verdict): ${item.imuFlow.note}`);
    }
  } else if (item.kind === 'proof-bundle' && item.bundle) {
    lines.push('  proof bundle (no media) — internal consistency only, stated as such');
  } else if (item.kind === 'hash-claim' && item.claim) {
    lines.push('  hash claim — structural checks only; nothing to verify against without media');
  } else if (item.kind === 'roster') {
    lines.push('  roster file — verified separately when passed via --trust');
  } else {
    lines.push(`  ${item.error ?? 'unrecognized input'}`);
  }
  return { name: item.name, kind: item.kind, verdict, signerFingerprint: fp, trust, lines };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Config-dir rename migration (§7): copy ~/.exhibit-desk → ~/.exhibit-c
  // once, say so in one line, never delete the old directory.
  try {
    migrateConfigDir(os.homedir(), fs, (msg) => console.error(msg));
  } catch {
    // A failed migration must never block verification — the legacy dir is
    // simply left in place and the new one is created on demand.
  }

  // Subcommand dispatch: ring-dump flatness measurement and RESOLVE
  // stand alone from the batch-intake path (additive; batch unchanged).
  if (process.argv[2] === 'parallax') return parallaxMain(process.argv.slice(3));
  if (process.argv[2] === 'resolve') return resolveMain(process.argv.slice(3));
  if (process.argv[2] === 'displaybeat') return displaybeatMain(process.argv.slice(3));
  if (process.argv[2] === 'enf') return enfMain(process.argv.slice(3));
  if (process.argv[2] === 'avsync') return avsyncMain(process.argv.slice(3));
  if (process.argv[2] === 'skew') return skewMain(process.argv.slice(3));
  if (process.argv[2] === 'stereo') return stereoMain(process.argv.slice(3), VERSION);

  const args = parseArgs(process.argv.slice(2));
  const rasterNote = ffmpegAvailable()
    ? 'ffmpeg rasterizer (same shared DSP as the browser app)'
    : 'NO rasterizer — pHash/rephoto/video-motion measurements not performed, stated not hidden';

  const { rosters, lines: rosterLines } = loadRosters(args.trustPaths);

  // Corpus mode reads its file list from labels.csv; everything else is argv paths.
  const inputs: { name: string; path: string; corpusClass?: string }[] = [];
  if (args.corpusCsv) {
    const csvPath = path.resolve(args.corpusCsv);
    const base = path.dirname(csvPath);
    const rows = fs.readFileSync(csvPath, 'utf8').split('\n').slice(1)
      .map((r) => r.trim()).filter(Boolean);
    for (const row of rows) {
      const [file, cls] = row.split(',').map((s) => s.trim());
      if (file && cls) inputs.push({ name: file, path: path.join(base, file), corpusClass: cls });
    }
  }
  for (const p of args.paths) inputs.push({ name: path.basename(p), path: p });

  if (inputs.length === 0) { printUsage(); process.exit(2); }

  const items: IntakeItem[] = [];
  for (const input of inputs) {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(fs.readFileSync(input.path));
    } catch {
      items.push({ id: `missing-${input.name}`, name: input.name, kind: 'unknown', error: 'file not found' });
      continue;
    }
    const item = await classifyAndVerify(input.name, bytes, adapters);
    if (input.corpusClass) (item as IntakeItem & { corpusClass?: string }).corpusClass = input.corpusClass;
    items.push(item);
  }

  // Artifact checks (proof bundles / hash claims) run through the same desk fns.
  const artifactChecks: { name: string; performed: string[]; notPerformed: string[] }[] = [];
  for (const item of items) {
    if (item.kind === 'proof-bundle' && item.bundle) {
      const c = await checkProofBundle(item.bundle, args.online);
      artifactChecks.push({ name: item.name, performed: c.performed, notPerformed: c.notPerformed });
    } else if (item.kind === 'hash-claim' && item.claim) {
      const c = checkHashClaim(item.claim);
      artifactChecks.push({ name: item.name, performed: c.performed, notPerformed: c.notPerformed });
    }
  }

  // Cross-item custody: exact-hash + visual-lead recovery, manifest custody.
  const recovery = findRecoveryMatches(items, 10, 22);
  const custody = findManifestCustodyMatches(items);

  // ---- console report ----
  console.log(`exhibit-c ${VERSION} — ${items.length} item(s) · ${args.online ? 'ONLINE (block binding checked)' : 'OFFLINE (structural time checks only)'} · raster: ${rasterNote}`);
  for (const l of rosterLines) console.log(l);
  const summaries = items.map((i) => summarizeItem(i, rosters, args.online));
  for (const s of summaries) {
    console.log(`\n${s.name} [${s.kind}]`);
    for (const l of s.lines) console.log(l);
  }
  for (const a of artifactChecks) {
    console.log(`\n${a.name} — artifact checks`);
    for (const l of a.performed) console.log(`  checked: ${l}`);
    for (const l of a.notPerformed) console.log(`  not checked: ${l}`);
  }
  if (recovery.length) {
    console.log('\nCustody links (pHash matches are LEADS, never verdicts):');
    for (const m of recovery) {
      console.log(`  ${m.proofName} ↔ ${m.mediaName} — ${m.grade}${m.distance !== null ? ` (hamming ${m.distance})` : ' (exact bytes)'}${m.viaMediaName ? ` via ${m.viaMediaName}` : ''}`);
    }
  }
  if (custody.length) {
    console.log('\nManifest custody matches (credential-stripped media re-homed to its manifest):');
    for (const m of custody) console.log(`  ${m.mediaName} ↔ ${m.bundleName} (${m.how}, ${m.manifestLabel})`);
  }

  // ---- corpus regression summary ----
  if (args.corpusCsv) printCorpusSummary(items);

  // ---- JSON / PDF reports ----
  const report = {
    format: 'exhibit-c.report' as const,
    version: 1,
    createdAt: new Date().toISOString(),
    tool: { name: 'exhibit-c CLI', version: VERSION },
    mode: { online: args.online, rasterizer: rasterNote, trustLists: rosters.map((r) => ({ newsroom: r.newsroom, editor: r.editor.name, entries: r.entries.length })) },
    items: summaries.map((s) => ({ name: s.name, kind: s.kind, verdict: s.verdict, signerFingerprint: s.signerFingerprint, trust: s.trust ? { tier: s.trust.tier, basis: s.trust.basis } : null })),
    custody: { recovery, manifestCustody: custody },
    honestLimits: 'Custody, not reality: INTACT means bytes unchanged since signing plus an identified signer — never proof of what a camera pointed at. Unsigned files are neutral. Every sensor/context signal printed here is evidence for a person to weigh, never a detector verdict. pHash matches are leads, never verdicts.',
  };

  if (args.jsonOut) {
    const signed = args.sign ? { ...report, signer: signReport(report, getOrCreateDeskKey()) } : report;
    fs.writeFileSync(args.jsonOut, JSON.stringify(signed, null, 2));
    console.log(`\nJSON report: ${args.jsonOut}${args.sign ? ` (signed by CLI report key ${(signed as typeof signed & { signer: { fingerprint: string } }).signer.fingerprint.slice(0, 16)}… — software key; proves report custody, never capture truth)` : ''}`);
  }
  if (args.pdfOut) {
    const lines: PdfLine[] = [
      { text: `Mode: ${args.online ? 'online (block binding)' : 'offline (structural only)'} · Raster: ${rasterNote}` },
      { text: '' },
    ];
    for (const s of summaries) {
      lines.push({ text: `${s.name} [${s.kind}]${s.verdict ? ` — ${s.verdict}` : ''}`, bold: true });
      for (const l of s.lines) lines.push({ text: l.trim() });
    }
    if (recovery.length) {
      lines.push({ text: '' }, { text: 'Custody links (leads, never verdicts)', bold: true });
      for (const m of recovery) lines.push({ text: `${m.proofName} ↔ ${m.mediaName} — ${m.grade}` });
    }
    lines.push({ text: '' }, { text: report.honestLimits });
    fs.writeFileSync(args.pdfOut, buildPdf(`Source Kit Desk report — ${report.createdAt}`, `${summaries.length} item(s) · exhibit-c ${VERSION}`, lines));
    console.log(`PDF report: ${args.pdfOut}`);
  }
}

function printCorpusSummary(items: IntakeItem[]): void {
  type Row = { cls: string; verdicts: Map<string, number>; banding: number[]; moire: number[] };
  const byClass = new Map<string, Row>();
  for (const raw of items) {
    const item = raw as IntakeItem & { corpusClass?: string };
    const cls = item.corpusClass ?? 'unlabeled';
    if (!byClass.has(cls)) byClass.set(cls, { cls, verdicts: new Map(), banding: [], moire: [] });
    const row = byClass.get(cls)!;
    const v = item.report?.verdict ?? 'n/a';
    row.verdicts.set(v, (row.verdicts.get(v) ?? 0) + 1);
    if (item.rephoto) {
      row.banding.push(item.rephoto.banding.snrDb);
      row.moire.push(item.rephoto.moire.snrDb);
    }
  }
  console.log('\nCorpus regression (characterization, NOT thresholds — thresholds ship only after the real-corpus ROC):');
  for (const row of byClass.values()) {
    const vs = [...row.verdicts.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
    const stats = (xs: number[]) => xs.length
      ? `min ${Math.min(...xs).toFixed(1)} / median ${xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)].toFixed(1)} / max ${Math.max(...xs).toFixed(1)} dB`
      : 'no measurements';
    console.log(`  ${row.cls}: ${vs}`);
    console.log(`    banding snr: ${stats(row.banding)}`);
    console.log(`    moiré  snr: ${stats(row.moire)}`);
  }
}

main().catch((e) => { console.error(`exhibit-c failed: ${(e as Error).message}`); process.exit(1); });
