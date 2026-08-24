/**
 * World Magnetic Model declination. Spherical-harmonic evaluation to degree
 * 12, following the NOAA/BGS WMM technical report. Prediction only: it takes
 * a coordinate and an instant and returns the field angle the model expects
 * there, with no reference to anything the device reported.
 */
import { WMM_EPOCH, WMM_G, WMM_H, WMM_GDOT, WMM_HDOT, WMM_N_MAX } from './wmmCoefficients';

const A_KM = 6378.137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RE_KM = 6371.2; // the model's geomagnetic reference radius

const idx = (n: number, m: number): number => (n * (n + 1)) / 2 + m;

/** Decimal year, the model's time argument. */
function decimalYear(at: Date): number {
  const y = at.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (at.getTime() - start) / (end - start);
}

/** Schmidt semi-normalized associated Legendre values and their derivatives
 *  with respect to geocentric latitude. */
function legendre(x: number, nMax: number): { p: Float64Array; dp: Float64Array } {
  const size = ((nMax + 1) * (nMax + 2)) / 2;
  const p = new Float64Array(size);
  const dp = new Float64Array(size);
  const z = Math.sqrt((1 - x) * (1 + x));
  p[0] = 1;
  dp[0] = 0;
  for (let n = 1; n <= nMax; n++) {
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      if (n === m) {
        const j = idx(n - 1, m - 1);
        p[i] = z * p[j];
        dp[i] = z * dp[j] + x * p[j];
      } else if (n === 1 && m === 0) {
        p[i] = x * p[0];
        dp[i] = x * dp[0] - z * p[0];
      } else if (m > n - 2) {
        const j = idx(n - 1, m);
        p[i] = x * p[j];
        dp[i] = x * dp[j] - z * p[j];
      } else {
        const k = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        const j1 = idx(n - 2, m);
        const j2 = idx(n - 1, m);
        p[i] = x * p[j2] - k * p[j1];
        dp[i] = x * dp[j2] - z * p[j2] - k * dp[j1];
      }
    }
  }
  // Schmidt quasi-normalization, applied in place.
  const q = new Float64Array(size);
  q[0] = 1;
  for (let n = 1; n <= nMax; n++) {
    q[idx(n, 0)] = (q[idx(n - 1, 0)] * (2 * n - 1)) / n;
    for (let m = 1; m <= n; m++) {
      q[idx(n, m)] = q[idx(n, m - 1)] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
    }
  }
  for (let i = 0; i < size; i++) {
    p[i] *= q[i];
    dp[i] *= -q[i];
  }
  return { p, dp };
}

/**
 * Declination at a coordinate and instant, degrees east of true north.
 * Returns null outside the model's validity window rather than extrapolating.
 *
 * 0.23.0 gate note: NOAA's WMM_TEST_VALUES.txt evaluates at altitude, so
 * altKm is a parameter (0 from the app — captures seal no reliable MSL
 * height reference); near-pole test rows need it to hold the 0.01° gate.
 */
export function wmmDeclination(latDeg: number, lonDeg: number, at: Date, altKm = 0): number | null {
  const t = decimalYear(at) - WMM_EPOCH;
  if (t < 0 || t > 5) return null;

  const lat = (latDeg * Math.PI) / 180;
  const lon = (lonDeg * Math.PI) / 180;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);

  // Geodetic to geocentric, at altKm above the ellipsoid.
  const rc = A_KM / Math.sqrt(1 - E2 * sinLat * sinLat);
  const pxy = (rc + altKm) * cosLat;
  const pz = (rc * (1 - E2) + altKm) * sinLat;
  const r = Math.hypot(pxy, pz);
  const latC = Math.asin(pz / r);

  const { p, dp } = legendre(Math.sin(latC), WMM_N_MAX);

  let bx = 0;
  let by = 0;
  let bz = 0;
  const cosLatC = Math.cos(latC);
  for (let n = 1; n <= WMM_N_MAX; n++) {
    const rr = Math.pow(RE_KM / r, n + 2);
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m);
      const g = WMM_G[i] + t * WMM_GDOT[i];
      const h = WMM_H[i] + t * WMM_HDOT[i];
      const cm = Math.cos(m * lon);
      const sm = Math.sin(m * lon);
      bz -= rr * (g * cm + h * sm) * (n + 1) * p[i];
      bx -= rr * (g * cm + h * sm) * dp[i];
      if (Math.abs(cosLatC) > 1e-10) {
        by += (rr * (g * sm - h * cm) * m * p[i]) / cosLatC;
      }
    }
  }

  // Rotate the geocentric components onto the geodetic frame.
  const psi = latC - lat;
  const xGeo = bx * Math.cos(psi) - bz * Math.sin(psi);
  return (Math.atan2(by, xGeo) * 180) / Math.PI;
}
