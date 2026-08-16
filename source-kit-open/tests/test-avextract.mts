/**
 * avExtract adapter suite (desk/cli/avExtract.ts) — the ffmpeg
 * boundary that feeds the desk's pure analyzers (displayBeat, enfExtract,
 * avSync, rollingShutter). The analyzers are covered by their own suites;
 * this suite pins the ADAPTER contract:
 *
 *   - happy path: a synthetic A/V capture probes, rasterizes to gray planes
 *     on the stated uniform fps grid, decodes to mono 16 kHz s16 PCM, and
 *     yields luma/motion series whose timestamps and lengths match the
 *     stated grid exactly;
 *   - missing file: every adapter returns null — never a throw, never a
 *     fabricated measurement;
 *   - non-media file: same null contract;
 *   - video without an audio track: probe says hasAudio=false and the PCM
 *     adapter returns null, and the downstream analyzer then reports the
 *     EXACT insufficient strings the CLI relies on ('audio track not
 *     available', 'motion series not available') — insufficient is a
 *     sentence, never a zero dressed up as a number.
 *
 * Fixtures are generated with ffmpeg at run time. When ffmpeg is absent the
 * suite SKIPS with a loud note — it does not pass.
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-avextract.mts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  probeVideo, extractGrayFrames, lumaSeriesFromPlanes,
  extractPcmMono16k, motionSeriesFromPlanes,
} from './avExtract.mts';
import { ffmpegAvailable } from './raster.mts';
import { analyzeOnsetAlignment } from './avSync.mts';

const LAB = '/tmp/lab/avextract/';
const AV = path.join(LAB, 'av.mp4');       // video + 440 Hz tone, 2 s
const VONLY = path.join(LAB, 'vonly.mp4'); // video only, 2 s
const NOTMEDIA = path.join(LAB, 'notes.txt');
const MISSING = path.join(LAB, 'does-not-exist.mp4');

const FPS = 10;
const RASTER_W = 96;

if (!ffmpegAvailable()) {
  console.log('\n========================================================');
  console.log('SKIPPED: ffmpeg/ffprobe not found on PATH.');
  console.log('test-avextract exercises the desk\'s ffmpeg adapters and');
  console.log('cannot run without them. Install ffmpeg and re-run —');
  console.log('this is a SKIP, not a pass.');
  console.log('========================================================\n');
  process.exit(0);
}

fs.mkdirSync(LAB, { recursive: true });
const f = (args: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: 'pipe' });
f(['-f', 'lavfi', '-i', `testsrc=duration=2:size=320x240:rate=${FPS}`,
   '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
   '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', AV]);
f(['-f', 'lavfi', '-i', `testsrc=duration=2:size=320x240:rate=${FPS}`,
   '-pix_fmt', 'yuv420p', VONLY]);
fs.writeFileSync(NOTMEDIA, 'this is not media — a desk-side note file\n');
console.log('fixtures generated with ffmpeg →', LAB);

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n— avextract: happy-path probe of a synthetic A/V capture —');

{
  const probe = probeVideo(AV);
  check('probe succeeds', probe !== null);
  check('dimensions 320x240', probe!.width === 320 && probe!.height === 240,
    `${probe!.width}x${probe!.height}`);
  check('fps ≈ 10', Math.abs(probe!.fps - FPS) < 0.01, `fps=${probe!.fps}`);
  check('duration ≈ 2 s (±0.5 s container tolerance)',
    Math.abs(probe!.durationSec - 2) <= 0.5, `duration=${probe!.durationSec}`);
  check('audio stream detected', probe!.hasAudio === true);
}

console.log('\n— avextract: gray-frame rasterization on the stated uniform grid —');

{
  const raster = extractGrayFrames(AV, FPS, RASTER_W, 900);
  check('rasterization succeeds', raster !== null);
  check('raster width as requested', raster!.width === RASTER_W, `w=${raster!.width}`);
  // h = max(16, round(240/320*96)) & ~1 = 72 — even, aspect-preserving.
  check('raster height 72 (aspect-preserving, forced even)', raster!.height === 72,
    `h=${raster!.height}`);
  check('frame count ≈ duration × fps (2 s × 10 = 20, ±2)',
    Math.abs(raster!.frames.length - 20) <= 2, `frames=${raster!.frames.length}`);
  check('every plane matches the stated geometry',
    raster!.frames.every((fr) => fr.width === RASTER_W && fr.height === 72 && fr.gray.length === RASTER_W * 72));
  check('nothing dropped under a generous cap', raster!.dropped === 0, `dropped=${raster!.dropped}`);

  const capped = extractGrayFrames(AV, FPS, RASTER_W, 5);
  check('maxFrames caps the planes', capped!.frames.length === 5, `frames=${capped!.frames.length}`);
  check('dropped count disclosed (total − kept)', capped!.dropped > 0, `dropped=${capped!.dropped}`);

  const luma = lumaSeriesFromPlanes(raster!.frames, FPS);
  check('luma series length == frame count', luma.length === raster!.frames.length);
  check('luma timestamps on the uniform grid (t = k/fps)',
    luma.every((s, k) => Math.abs(s.tSec - k / FPS) < 1e-9));
  check('luma values in the gray range [0, 255]',
    luma.every((s) => s.luma >= 0 && s.luma <= 255));
}

console.log('\n— avextract: PCM + motion series —');

{
  const pcm = extractPcmMono16k(AV);
  check('PCM decode succeeds', pcm !== null);
  check('sample rate stated as 16000 Hz', pcm!.sampleRateHz === 16000);
  check('sample count ≈ 2 s × 16 kHz (±2000 codec priming)',
    Math.abs(pcm!.samples.length - 32000) <= 2000, `n=${pcm!.samples.length}`);
  check('440 Hz tone is actually present (nonzero energy)',
    pcm!.samples.some((s) => s !== 0));

  const raster = extractGrayFrames(AV, FPS, RASTER_W, 900)!;
  const { motion, gaps } = motionSeriesFromPlanes(raster.frames, FPS);
  check('motion series length == frames − 1', motion.length === raster.frames.length - 1);
  check('motion timestamps at pair midpoints (t = (k−0.5)/fps)',
    motion.every((m, i) => Math.abs(m.tSec - (i + 1 - 0.5) / FPS) < 1e-9));
  check('magnitudes non-negative', motion.every((m) => m.magnitude >= 0));
  check('gap count disclosed and within series bounds', gaps >= 0 && gaps <= motion.length);
}

console.log('\n— avextract: missing file → null everywhere, never a throw —');

{
  check('probeVideo(null) on a missing path', probeVideo(MISSING) === null);
  check('extractGrayFrames(null) on a missing path',
    extractGrayFrames(MISSING, FPS, RASTER_W, 10) === null);
  check('extractPcmMono16k(null) on a missing path', extractPcmMono16k(MISSING) === null);
}

console.log('\n— avextract: non-media file → null everywhere —');

{
  check('probeVideo(null) on a text file', probeVideo(NOTMEDIA) === null);
  check('extractGrayFrames(null) on a text file',
    extractGrayFrames(NOTMEDIA, FPS, RASTER_W, 10) === null);
  check('extractPcmMono16k(null) on a text file', extractPcmMono16k(NOTMEDIA) === null);
}

console.log('\n— avextract: video without an audio track —');

{
  const probe = probeVideo(VONLY);
  check('probe succeeds and reports hasAudio=false', probe !== null && probe!.hasAudio === false);
  check('PCM adapter returns null (absent stream, honestly)',
    extractPcmMono16k(VONLY) === null);
  check('video track still rasterizes', extractGrayFrames(VONLY, FPS, RASTER_W, 10) !== null);
}

console.log('\n— avextract: null adapter output → exact analyzer honesty strings —');

{
  // The CLI hands null series straight to the analyzers; the analyzers must
  // answer with the fixed insufficient sentences — never a zero offset.
  const evNoAudio = analyzeOnsetAlignment(null, [{ tSec: 0.05, magnitude: 1 }], { now: new Date('2026-08-05T12:00:00Z') });
  check('null audio → "audio track not available", no offset',
    evNoAudio.status === 'insufficient' && evNoAudio.offsetMs === null &&
    typeof evNoAudio.insufficient === 'string' && evNoAudio.insufficient.includes('audio track not available'),
    String(evNoAudio.insufficient));

  const evNoMotion = analyzeOnsetAlignment(
    { sampleRateHz: 16000, samples: new Float64Array(16000) }, null,
    { now: new Date('2026-08-05T12:00:00Z') });
  check('null motion → "motion series not available", no offset',
    evNoMotion.status === 'insufficient' && evNoMotion.offsetMs === null &&
    typeof evNoMotion.insufficient === 'string' && evNoMotion.insufficient.includes('motion series not available'),
    String(evNoMotion.insufficient));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL AVEXTRACT TESTS PASSED');
