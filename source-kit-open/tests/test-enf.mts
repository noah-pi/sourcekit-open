/**
 * ENF extractor suite — synthetic 16 kHz mono with
 * KNOWN mains hum:
 *
 *   - 35 s with hum at 50.15 Hz must extract a trace centered on 50.15 Hz,
 *     explicitly labeled extract-only, never matched;
 *   - under 30 s the report is 'insufficient' with NO trace and NO number
 *     that looks like evidence;
 *   - hint absent → both families evaluated, stronger disclosed;
 *   - silence / null audio / unusable sample rate → insufficient with the
 *     specific reason.
 *
 * No network, no ffmpeg (the analyzer is pure).
 *
 * Run (staged lab): node stage.mjs && cd .staged && npm install --no-audit --no-fund
 *   && ./node_modules/.bin/tsx test-enf.mts
 */
import {
  extractEnfTrace, ENF_EXTRACT_METHOD_VERSION, ENF_MIN_DURATION_SEC,
} from './enfExtract.mts';

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
const NOW = new Date('2026-08-05T12:00:00Z');

/** Synthetic recording: mains hum at fHz (+ drift option) + speech-ish noise. */
function synthAudio(seconds: number, fHz: number | null, humAmp = 0.02, seed = 5): Float64Array {
  const rnd = mulberry32(seed);
  const n = Math.round(FS * seconds);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    // speech-ish: a few low tones + wideband noise
    const speech =
      0.15 * Math.sin(2 * Math.PI * 180 * t + 1) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t)) +
      0.1 * Math.sin(2 * Math.PI * 313 * t) +
      (rnd() - 0.5) * 0.12;
    x[i] = speech + (fHz === null ? 0 : humAmp * Math.sin(2 * Math.PI * fHz * t));
  }
  return x;
}

console.log('\n— enf: 35 s with 50.15 Hz hum, mainsHz hint 50 —');

{
  const ev = extractEnfTrace(synthAudio(35, 50.15), FS, { mainsHz: 50, now: NOW });
  check('extracted (not insufficient)', ev.status === 'extracted' && ev.insufficient === false, String(ev.insufficient));
  check('extractOnly literal true; no matching at Tier 1', ev.extractOnly === true);
  const usable = ev.trace!.filter((p) => p.usable);
  check('usable windows present (coverage ≥ 0.5)', ev.quality !== null && ev.quality.coverage >= 0.5,
    JSON.stringify(ev.quality));
  const meanHz = usable.reduce((s, p) => s + p.hz, 0) / usable.length;
  check('trace centered on 50.15 Hz (±0.05)', Math.abs(meanHz - 50.15) < 0.05, `mean=${meanHz.toFixed(4)}`);
  check('trace stable (σ ≤ 0.05 Hz)', ev.quality !== null && ev.quality.hzStd <= 0.05,
    `std=${ev.quality?.hzStd}`);
  check('nominal basis is the hint; hint basis region-derived',
    ev.nominalHz === 50 && ev.nominalBasis === 'mainsHz-hint' && ev.mainsHintBasis === 'region-derived');
  check('extract-only label in limitations (no reference matching at Tier 1)',
    ev.limitations.some((l) => l.includes('extract only; no reference matching at Tier 1')));
  check('corpus characterization pending limitation fixed',
    ev.limitations.some((l) => l.includes('corpus characterization pending; no error rates published')));
  check('region-derived hint never overstated as a measurement',
    ev.limitations.some((l) => l.includes('region-derived')));
  check('method version + injected clock', ev.methodVersion === ENF_EXTRACT_METHOD_VERSION && ev.computedAt === NOW.toISOString());
}

console.log('\n— enf: 60 Hz hum with NO mainsHz hint — both families evaluated, basis disclosed —');

{
  const ev = extractEnfTrace(synthAudio(35, 60.1), FS, { now: NOW });
  check('extracted (not insufficient)', ev.status === 'extracted', String(ev.insufficient));
  check('nominal 60 chosen as the stronger family',
    ev.nominalHz === 60 && ev.nominalBasis === 'strongest-hum-of-both-families',
    `nominal=${ev.nominalHz} basis=${ev.nominalBasis}`);
  check('both-family SNRs disclosed', ev.bothFamilyMeanSnrDb !== null && ev.bothFamilyMeanSnrDb.at60Hz > ev.bothFamilyMeanSnrDb.at50Hz,
    JSON.stringify(ev.bothFamilyMeanSnrDb));
  check('hint absence disclosed in limitations', ev.limitations.some((l) => l.includes('hint absent')));
  const usable = ev.trace!.filter((p) => p.usable);
  const meanHz = usable.reduce((s, p) => s + p.hz, 0) / usable.length;
  check('trace centered on 60.1 Hz (±0.05)', Math.abs(meanHz - 60.1) < 0.05, `mean=${meanHz.toFixed(4)}`);
}

console.log(`\n— enf: THE 30-SECOND RULE — under ${ENF_MIN_DURATION_SEC} s, nothing that looks like evidence —`);

{
  const ev10 = extractEnfTrace(synthAudio(10, 50.15), FS, { mainsHz: 50, now: NOW });
  check('10 s → insufficient with the duration reason',
    ev10.status === 'insufficient' && typeof ev10.insufficient === 'string' && ev10.insufficient.includes('< 30'),
    String(ev10.insufficient));
  check('10 s → NO trace (null, not empty-but-present)',
    ev10.trace === null && ev10.quality === null && ev10.nominalHz === null);
  const ev29 = extractEnfTrace(synthAudio(29.9, 50.15), FS, { mainsHz: 50, now: NOW });
  check('29.9 s → still insufficient (the rule is hard)', ev29.status === 'insufficient' && ev29.trace === null);
  const ev30 = extractEnfTrace(synthAudio(30.2, 50.15), FS, { mainsHz: 50, now: NOW });
  check('30.2 s → extraction runs', ev30.status === 'extracted', String(ev30.insufficient));
}

console.log('\n— enf: honesty paths —');

{
  const evNull = extractEnfTrace(null, FS, { mainsHz: 50, now: NOW });
  check('null audio → "not available", never fabricated',
    evNull.status === 'insufficient' && typeof evNull.insufficient === 'string' && evNull.insufficient.includes('not available'),
    String(evNull.insufficient));

  const evSilent = extractEnfTrace(new Float64Array(FS * 35), FS, { mainsHz: 50, now: NOW });
  check('silence → insufficient, no trace',
    evSilent.status === 'insufficient' && evSilent.trace === null && typeof evSilent.insufficient === 'string' && evSilent.insufficient.includes('silence'),
    String(evSilent.insufficient));

  const evNoHum = extractEnfTrace(synthAudio(35, null), FS, { mainsHz: 50, now: NOW });
  check('no hum coupled → insufficient no-extraction (a few noisy windows must not fabricate a trace)',
    evNoHum.status === 'insufficient' && typeof evNoHum.insufficient === 'string' && evNoHum.insufficient.includes('not sustained'),
    String(evNoHum.insufficient));

  const evLowFs = extractEnfTrace(synthAudio(35, 50.15), 100, { mainsHz: 50, now: NOW });
  check('unusable sample rate → insufficient with reason',
    evLowFs.status === 'insufficient' && typeof evLowFs.insufficient === 'string' && evLowFs.insufficient.includes('sample rate'),
    String(evLowFs.insufficient));
}

console.log('\n— enf: determinism —');

{
  const a = extractEnfTrace(synthAudio(32, 50.1, 0.02, 9), FS, { mainsHz: 50, now: NOW });
  const b = extractEnfTrace(synthAudio(32, 50.1, 0.02, 9), FS, { mainsHz: 50, now: NOW });
  check('identical input + clock → identical evidence', JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL ENF EXTRACT TESTS PASSED');
