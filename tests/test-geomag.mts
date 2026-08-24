/**
 * test-geomag — the declination row's ship gate (0.23.0, auditor handoff:
 * "Do not ship the row until it passes"). Reads NOAA's published
 * WMM_TEST_VALUES.txt (WMM2025) and asserts each computed declination
 * within 0.01° of NOAA's value. 100 rows across latitudes ±89°, longitudes,
 * altitudes 0–28 km, and the 2025.0–2030.0 validity window — including the
 * null-on-extrapolation contract at both window edges.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { wmmDeclination } from '../src/reader/verify/geomag';

const here = dirname(fileURLToPath(import.meta.url));
const lines = readFileSync(join(here, 'WMM_TEST_VALUES.txt'), 'utf8').split('\n');

let pass = 0;
const failures: string[] = [];

function decimalYearToDate(dy: number): Date {
  const y = Math.floor(dy);
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return new Date(start + (dy - y) * (end - start));
}

for (const raw of lines) {
  const line = raw.trim();
  if (!line || line.startsWith('#')) continue;
  const a = line.split(/\s+/).map(Number);
  const [dy, altKm, lat, lon, decExpected] = a;
  const got = wmmDeclination(lat, lon, decimalYearToDate(dy), altKm);
  if (got === null) {
    failures.push(`lat ${lat} lon ${lon} alt ${altKm} t ${dy}: got null, expected ${decExpected}`);
    continue;
  }
  const err = Math.abs(got - decExpected);
  if (err > 0.01) {
    failures.push(`lat ${lat} lon ${lon} alt ${altKm} t ${dy}: got ${got.toFixed(4)}, expected ${decExpected} (err ${err.toFixed(4)}°)`);
    continue;
  }
  pass++;
}

// Validity-window contract: never extrapolate outside the model epoch.
const inWindow = wmmDeclination(40, -105, new Date(Date.UTC(2027, 5, 15)), 0);
const before = wmmDeclination(40, -105, new Date(Date.UTC(2024, 11, 31)), 0);
const after = wmmDeclination(40, -105, new Date(Date.UTC(2030, 0, 2)), 0);
if (inWindow === null) failures.push('in-window (2027.5) returned null');
else pass++;
if (before !== null) failures.push(`before epoch returned ${before}, expected null`);
else pass++;
if (after !== null) failures.push(`after window returned ${after}, expected null`);
else pass++;

console.log(`test-geomag: ${pass} pass, ${failures.length} fail`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length === 0 ? 0 : 1);
