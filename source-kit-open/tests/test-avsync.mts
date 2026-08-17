// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Onset-alignment A/V desync suite — synthetic audio +
 * motion series with KNOWN offset:
 *
 *   - a clap 150 ms AFTER the motion onset must measure ≈ +150 ms (audio
 *     lags) with strong correlation;
 *   - an aligned capture must measure ≈ 0 ms;
 *   - several onset pairs must lock at the right lag, not just one;
 *   - no-onset / no-audio / too-short inputs report 'insufficient' with
 *     the specific reason — never a zero offset dressed up as alignment.
 *
 * No network, no ffmpeg (the analyzer is pure; motion samples are fed
 * directly, as the CLI's adapters do).
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-avsync.mts
 */
import {
  analyzeOnsetAlignment, AVSYNC_METHOD_VERSION, type MotionSample,
} from './avSync.mts';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FS = 16000;
const FPS = 10; // motion grid: 100 ms
const SECONDS = 8;
const NOW = new Date('2026-08-05T12:00:00Z');

/**
 * Synthetic capture: motion onsets at `events` (seconds) as global-motion
 * magnitude steps; audio claps at events + audioDelaySec as short bursts.
 */
function synth(events: number[], audioDelaySec: number, seed: number): { motion: MotionSample[]; samples: Float64Array } {
  const rnd = mulberry32(seed);
  const motion: MotionSample[] = [];
  const nFrames = Math.round(SECONDS * FPS);
  for (let k = 0; k < nFrames; k++) {
    const t = (k + 0.5) / FPS;
    let mag = 0.3 + rnd() * 0.1; // handheld jitter floor
    for (const e of events) {
      if (t >= e && t < e + 0.35) mag += 4 * Math.exp(-(t - e) / 0.1); // motion transient
    }
    motion.push({ tSec: t, magnitude: mag });
  }
  const n = Math.round(SECONDS * FS);
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    let v = (rnd() - 0.5) * 0.01; // room tone
    for (const e of events) {
      const c = e + audioDelaySec;
      if (t >= c && t < c + 0.12) v += 0.5 * Math.sin(2 * Math.PI * 900 * t) * Math.exp(-(t - c) / 0.03);
    }
    samples[i] = v;
  }
  return { motion, samples };
}

console.log('\n— avsync: claps 150 ms AFTER motion onsets (audio lags) —');

{
  const { motion, samples } = synth([1.5, 3.2, 5.0, 6.4], 0.15, 3);
  const ev = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, motion, { now: NOW });
  check('measured (not insufficient)', ev.insufficient === false, String(ev.insufficient));
  check('offset ≈ +150 ms (±60 ms — grid is 100 ms, envelope-centroid refined)',
    ev.offsetMs !== null && Math.abs(ev.offsetMs - 150) <= 60, `offset=${ev.offsetMs}`);
  check('peak correlation strong (≥ 0.7)', ev.correlation !== null && ev.correlation >= 0.7, `r=${ev.correlation}`);
  check('sign convention stated: positive = audio later', true && ev.offsetMs! > 0);
  check('method version + corpus limitation fixed',
    ev.methodVersion === AVSYNC_METHOD_VERSION &&
    ev.limitations.some((l) => l.includes('corpus characterization pending; no error rates published')));
  check('never a dubbing verdict — evidence language fixed',
    ev.limitations.some((l) => l.includes('never a dubbing verdict')));
  check('small-offsets-are-expected honesty fixed',
    ev.limitations.some((l) => l.includes('EXPECTED on honest files')));
}

console.log('\n— avsync: aligned capture (delay 0) —');

{
  const { motion, samples } = synth([1.5, 3.2, 5.0, 6.4], 0, 4);
  const ev = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, motion, { now: NOW });
  check('measured (not insufficient)', ev.insufficient === false, String(ev.insufficient));
  check('|offset| ≤ 60 ms (one half-grid)', ev.offsetMs !== null && Math.abs(ev.offsetMs) <= 60, `offset=${ev.offsetMs}`);
}

console.log('\n— avsync: audio LEADS motion by 200 ms (negative offset) —');

{
  const { motion, samples } = synth([1.5, 3.2, 5.0, 6.4], -0.2, 6);
  const ev = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, motion, { now: NOW });
  check('measured (not insufficient)', ev.insufficient === false, String(ev.insufficient));
  check('offset ≈ −200 ms (±60 ms)', ev.offsetMs !== null && Math.abs(ev.offsetMs + 200) <= 60, `offset=${ev.offsetMs}`);
}

console.log('\n— avsync: insufficient-data paths (reasons, never numbers) —');

{
  const { motion } = synth([1.5, 3.2], 0, 7);
  const evNoAudio = analyzeOnsetAlignment(null, motion, { now: NOW });
  check('audio absent → "not available", no offset',
    evNoAudio.status === 'insufficient' && evNoAudio.offsetMs === null &&
    typeof evNoAudio.insufficient === 'string' && evNoAudio.insufficient.includes('audio track not available'),
    String(evNoAudio.insufficient));

  const { samples } = synth([1.5, 3.2, 5.0], 0, 8);
  const evNoMotion = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, null, { now: NOW });
  check('motion absent → "not available", no offset',
    evNoMotion.status === 'insufficient' && evNoMotion.offsetMs === null &&
    typeof evNoMotion.insufficient === 'string' && evNoMotion.insufficient.includes('motion series not available'),
    String(evNoMotion.insufficient));

  const quiet = new Float64Array(Math.round(SECONDS * FS)).fill(0);
  const evQuiet = analyzeOnsetAlignment({ sampleRateHz: FS, samples: quiet }, motion, { now: NOW });
  check('silent audio → no-onset insufficient (never zero offset)',
    evQuiet.status === 'insufficient' && typeof evQuiet.insufficient === 'string' && evQuiet.insufficient.includes('no audio onset'),
    String(evQuiet.insufficient));

  const staticMotion: MotionSample[] = motion.map((m) => ({ tSec: m.tSec, magnitude: 0.5 }));
  const evStatic = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, staticMotion, { now: NOW });
  check('static scene → no-motion-onset insufficient (never zero offset)',
    evStatic.status === 'insufficient' && typeof evStatic.insufficient === 'string' && evStatic.insufficient.includes('no motion onset'),
    String(evStatic.insufficient));

  const shortMotion = motion.slice(0, 5);
  const evShort = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, shortMotion, { now: NOW });
  check('too few samples → insufficient with count reason',
    evShort.status === 'insufficient' && typeof evShort.insufficient === 'string' && evShort.insufficient.includes('motion samples'),
    String(evShort.insufficient));
}

console.log('\n— avsync: determinism —');

{
  const { motion, samples } = synth([2, 4.5], 0.15, 12);
  const a = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, motion, { now: NOW });
  const b = analyzeOnsetAlignment({ sampleRateHz: FS, samples }, motion, { now: NOW });
  check('identical input + clock → identical evidence', JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL AVSYNC TESTS PASSED');
