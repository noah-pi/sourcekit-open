// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Display-beat analyzer suite — synthetic luma series
 * with KNOWN periodicity:
 *
 *   - a series modulated at a KNOWN beat frequency must measure that
 *     frequency with strong SNR;
 *   - a display-family harmonic (59.94 Hz ×2 at 240 fps sampling) must show
 *     up in the family candidates with high SNR;
 *   - a family whose beat aliases below the frequency resolution must be
 *     marked NOT assessable — never silently scored as absent;
 *   - flat / short / absent series must report 'insufficient' with the
 *     specific reason — never a number dressed up as evidence.
 *
 * No network, no ffmpeg (the analyzer is pure; the CLI's ffmpeg path is
 * exercised separately by the desk CLI).
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-displaybeat.mts
 */
import {
  analyzeDisplayBeat, DISPLAY_BEAT_METHOD_VERSION, type LumaSample,
} from './displayBeat.mts';

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

function series(fs: number, seconds: number, fn: (t: number) => number): LumaSample[] {
  const out: LumaSample[] = [];
  const n = Math.round(fs * seconds);
  for (let k = 0; k < n; k++) out.push({ tSec: k / fs, luma: fn(k / fs) });
  return out;
}

const NOW = new Date('2026-08-05T12:00:00Z');

console.log('\n— displaybeat: known 2.5 Hz beat at 30 fps (recapture-like cadence mismatch) —');

{
  const rnd = mulberry32(11);
  const s = series(30, 12, (t) => 128 + 18 * Math.sin(2 * Math.PI * 2.5 * t) + (rnd() - 0.5) * 3);
  const ev = analyzeDisplayBeat(s, { sampleRateHz: 30, now: NOW });
  check('measured (not insufficient)', ev.insufficient === false, String(ev.insufficient));
  check('strongest beat ≈ 2.5 Hz (±0.1)', ev.strongestBeat !== null && Math.abs(ev.strongestBeat.frequencyHz - 2.5) < 0.1,
    JSON.stringify(ev.strongestBeat));
  check('strongest beat SNR strong (≥ 20 dB)', ev.strongestBeat !== null && ev.strongestBeat.snrDb >= 20,
    `snr=${ev.strongestBeat?.snrDb}`);
  check('method version + corpus limitation fixed',
    ev.methodVersion === DISPLAY_BEAT_METHOD_VERSION &&
    ev.limitations.some((l) => l.includes('corpus characterization pending; no error rates published')));
  check('never a verdict: evidence language in limitations',
    ev.limitations.some((l) => l.includes('never a recapture verdict')));
  check('computedAt is the injected clock (dated, re-runnable)', ev.computedAt === NOW.toISOString());
}

console.log('\n— displaybeat: 59.94 Hz display, 2nd harmonic, 240 fps sampling —');

{
  const rnd = mulberry32(23);
  // Physical flicker at 2×59.94 = 119.88 Hz, sampled at 240 fps → alias 119.88 (inside Nyquist).
  const s = series(240, 8, (t) => 120 + 10 * Math.sin(2 * Math.PI * 119.88 * t) + (rnd() - 0.5) * 2);
  const ev = analyzeDisplayBeat(s, { sampleRateHz: 240, now: NOW });
  check('measured (not insufficient)', ev.insufficient === false, String(ev.insufficient));
  const cand = ev.candidates.find((c) => c.familyHz === 59.94 && c.harmonic === 2);
  check('59.94×2 candidate present and assessable', cand !== undefined && cand.assessable, JSON.stringify(cand));
  check('59.94×2 candidate SNR strong (≥ 15 dB)', cand !== undefined && cand.snrDb !== null && cand.snrDb >= 15,
    `snr=${cand?.snrDb}`);
  check('strongest beat lands at the 119.88 Hz family position (±0.5 Hz)',
    ev.strongestBeat !== null && Math.abs(ev.strongestBeat.frequencyHz - 119.88) < 0.5,
    JSON.stringify(ev.strongestBeat));
  // A clean series with no family content: 50 Hz family candidates should be weak.
  const c50 = ev.candidates.filter((c) => c.familyHz === 50 && c.assessable && c.snrDb !== null);
  check('50 Hz family weak on a 59.94-driven series (all assessable bins < candidate SNR)',
    c50.every((c) => c.snrDb! < (cand?.snrDb ?? 0)), JSON.stringify(c50.map((c) => c.snrDb)));
}

console.log('\n— displaybeat: 60 Hz display at exactly 30 fps — DC alias is NOT assessable, never scored absent —');

{
  const rnd = mulberry32(31);
  const s = series(30, 12, (t) => 128 + (rnd() - 0.5) * 4);
  const ev = analyzeDisplayBeat(s, { sampleRateHz: 30, now: NOW });
  check('measured (series is fine; assessment is per-candidate)', ev.insufficient === false, String(ev.insufficient));
  const c60 = ev.candidates.find((c) => c.familyHz === 60 && c.harmonic === 1);
  check('60 Hz ×1 marked NOT assessable (aliases to DC)', c60 !== undefined && !c60.assessable && c60.snrDb === null,
    JSON.stringify(c60));
  check('non-assessability reason disclosed in the candidate note',
    c60 !== undefined && c60.note !== null && c60.note.includes('NOT assessable'), c60?.note ?? '');
  check('limitation discloses unassessable candidates exist',
    ev.limitations.some((l) => l.includes('alias below the frequency resolution')));
}

console.log('\n— displaybeat: insufficient-data paths (reasons, never numbers) —');

{
  const flat = series(30, 12, () => 128);
  const evFlat = analyzeDisplayBeat(flat, { sampleRateHz: 30, now: NOW });
  check('flat luma → insufficient with flatness reason',
    evFlat.status === 'insufficient' && typeof evFlat.insufficient === 'string' && evFlat.insufficient.includes('flat'),
    String(evFlat.insufficient));
  check('flat luma → no beat, no candidates offered',
    evFlat.strongestBeat === null && evFlat.candidates.length === 0);

  const short = series(30, 0.3, (t) => 128 + 20 * Math.sin(2 * Math.PI * 5 * t));
  const evShort = analyzeDisplayBeat(short, { sampleRateHz: 30, now: NOW });
  check('short series → insufficient with sample-count reason',
    evShort.status === 'insufficient' && typeof evShort.insufficient === 'string' && evShort.insufficient.includes('luma samples'),
    String(evShort.insufficient));

  const evNull = analyzeDisplayBeat(null, { sampleRateHz: 30, now: NOW });
  check('absent series → insufficient, "not available" honesty',
    evNull.status === 'insufficient' && typeof evNull.insufficient === 'string' && evNull.insufficient.includes('not available'),
    String(evNull.insufficient));

  const evBadFs = analyzeDisplayBeat(series(30, 5, () => 128), { sampleRateHz: 0, now: NOW });
  check('no time base → insufficient with sample-rate reason',
    evBadFs.status === 'insufficient' && typeof evBadFs.insufficient === 'string' && evBadFs.insufficient.includes('sample rate'),
    String(evBadFs.insufficient));
}

console.log('\n— displaybeat: determinism (re-runnable, same bytes → same evidence) —');

{
  const mk = () => {
    const rnd = mulberry32(77);
    return series(30, 10, (t) => 128 + 15 * Math.sin(2 * Math.PI * 3 * t) + (rnd() - 0.5) * 4);
  };
  const a = analyzeDisplayBeat(mk(), { sampleRateHz: 30, now: NOW });
  const b = analyzeDisplayBeat(mk(), { sampleRateHz: 30, now: NOW });
  check('identical input + clock → identical evidence', JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL DISPLAY-BEAT TESTS PASSED');
