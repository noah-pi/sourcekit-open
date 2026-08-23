// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Disclosure ladders — the fixed coarseness rungs every claim family commits
 * under (docs/INTEGRITY.md — selective disclosure). A ladder is an ordered
 * list of rung names, coarsest first (rung 0), and every capture carries the
 * full expected claim set. A claim with no data is declared `never-recorded`
 * in the inventory assertion at commit time, which the signed root binds.
 *
 * The `context` family has no fixed ladder: free-form claims
 * (`context.<label>`) whose rung numbers the caller assigns.
 *
 * `coarsen` derives time and location values by prefix truncation — of the
 * normalized exact-ms string for time, of the full 9-char geohash for
 * location. Location country/region/grid-region are reverse geocoding, and
 * identity and sensor values are pre-derived, so all of those stay
 * caller-side.
 */

export type ClaimFamily = 'location' | 'time' | 'identity' | 'sensor' | 'context';

export const LOCATION_RUNGS = [
  'grid-region', 'country', 'region', 'geohash-5', 'geohash-7', 'geohash-9', 'exact',
] as const;

export const TIME_RUNGS = [
  'year', 'month', 'day', 'hour', 'minute', 'exact-ms',
] as const;

export const IDENTITY_RUNGS = [
  'key-fingerprint', 'roster-status', 'org', 'named',
] as const;

export const SENSOR_RUNGS = [
  'present', 'residual-summary',
] as const;

/** Families with a fixed ladder. `context` has none. */
export const LADDERS = {
  location: LOCATION_RUNGS,
  time: TIME_RUNGS,
  identity: IDENTITY_RUNGS,
  sensor: SENSOR_RUNGS,
} as const;

export type LadderedFamily = keyof typeof LADDERS;

export const CLAIM_FAMILIES: readonly ClaimFamily[] = [
  'location', 'time', 'identity', 'sensor', 'context',
];

/** The rung-name ladder for a family; [] for the free-form `context` family. */
export function ladderFor(family: ClaimFamily): readonly string[] {
  return family === 'context' ? [] : LADDERS[family];
}

/** Index of a rung name in its family's ladder, or -1 when unknown. */
export function rungIndex(family: ClaimFamily, name: string): number {
  return ladderFor(family).indexOf(name);
}

/** The claimId for a laddered family rung: `${family}.${rungName}`. */
export function claimIdFor(family: LadderedFamily, rungName: string): string {
  return `${family}.${rungName}`;
}

/**
 * Every claimId a capture must account for, sorted: all rungs of all fixed
 * ladders. Each is either committed or declared never-recorded at commit time.
 * `context.*` claims are optional additions outside this set.
 */
export function expectedClaimIds(): string[] {
  const ids: string[] = [];
  for (const family of Object.keys(LADDERS) as LadderedFamily[]) {
    for (const rung of LADDERS[family]) ids.push(claimIdFor(family, rung));
  }
  return ids.sort();
}

const EXACT_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---------------------------------------------------------------------------
// Geohash — the location family's derivation. The exact claim value is
// `'<lat>,<lon>'` at 6 decimal places (round-half-away-from-zero at
// 5e-7° ≈ 5 cm, below GPS noise). Coarser rungs are prefix truncations of the
// full 9-character geohash: geohash-9 → geohash-7 → geohash-5.
//
// country / region / grid-region are not derived here; naming an
// administrative region from coordinates needs a reverse-geocoding lookup.
// Callers declare those rungs never-recorded.
// ---------------------------------------------------------------------------

const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** Standard geohash (base32, interleaved lon/lat bits), `precision` chars. */
export function geohashEncode(lat: number, lon: number, precision: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`geohash: coordinates out of range (${lat}, ${lon})`);
  }
  if (!Number.isInteger(precision) || precision < 1 || precision > 12) {
    throw new Error(`geohash: precision must be 1..12 chars, got ${precision}`);
  }
  let latLo = -90, latHi = 90, lonLo = -180, lonHi = 180;
  let even = true; // even bit positions are longitude
  let bit = 0, char = 0, out = '';
  while (out.length < precision) {
    if (even) {
      const mid = (lonLo + lonHi) / 2;
      if (lon >= mid) { char = (char << 1) | 1; lonLo = mid; } else { char = char << 1; lonHi = mid; }
    } else {
      const mid = (latLo + latHi) / 2;
      if (lat >= mid) { char = (char << 1) | 1; latLo = mid; } else { char = char << 1; latHi = mid; }
    }
    even = !even;
    bit++;
    if (bit === 5) { out += GEOHASH_BASE32[char]; bit = 0; char = 0; }
  }
  return out;
}

const EXACT_LOC = /^(-?\d+\.\d{6}),(-?\d+\.\d{6})$/;

/** The canonical exact location string: `'<lat>,<lon>'` at 6 decimal places. */
export function exactLocationValue(lat: number, lon: number): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw new Error(`location: coordinates out of range (${lat}, ${lon})`);
  }
  // toFixed rounds half-away-from-zero for these magnitudes; -0 normalizes to 0.
  const f = (v: number) => (Object.is(-0, v) ? 0 : v).toFixed(6);
  return `${f(lat)},${f(lon)}`;
}

/**
 * Derive the canonical value of a claim at a coarser rung from its exact
 * value. For time and location the result is a strict prefix of the normalized
 * exact string (`YYYY-MM-DDTHH:MM:SS.sssZ` → year `YYYY`, month `YYYY-MM`, day
 * `YYYY-MM-DD`, hour `YYYY-MM-DDTHH`, minute `YYYY-MM-DDTHH:MM`, exact-ms
 * unchanged; 9-char geohash → geohash-9/7/5, exact unchanged). The
 * reverse-geocoded location rungs (country, region, grid-region) and the
 * identity and sensor families throw; those values are caller-derived.
 */
export function coarsen(family: ClaimFamily, exactValue: string, rung: string | number): string {
  const idx = typeof rung === 'number' ? rung : rungIndex(family, rung);
  if (idx < 0 || idx >= ladderFor(family).length) {
    throw new Error(`coarsen: unknown rung '${String(rung)}' for family '${family}'`);
  }
  if (family === 'time') {
    if (!EXACT_MS.test(exactValue)) {
      throw new Error(`coarsen: time exact value must be YYYY-MM-DDTHH:MM:SS.sssZ, got '${exactValue}'`);
    }
    // Prefix lengths into the normalized exact-ms string, one per rung.
    const prefix: Record<string, number> = {
      year: 4, month: 7, day: 10, hour: 13, minute: 16,
    };
    const name = TIME_RUNGS[idx];
    if (name === 'exact-ms') return exactValue;
    return exactValue.slice(0, prefix[name]);
  }
  if (family === 'location') {
    const name = LOCATION_RUNGS[idx];
    if (name === 'exact') {
      if (!EXACT_LOC.test(exactValue)) {
        throw new Error(`coarsen: location exact value must be '<lat>,<lon>' at 6 decimals, got '${exactValue}'`);
      }
      return exactValue;
    }
    if (name === 'geohash-5' || name === 'geohash-7' || name === 'geohash-9') {
      const m = EXACT_LOC.exec(exactValue);
      if (!m) {
        throw new Error(`coarsen: location exact value must be '<lat>,<lon>' at 6 decimals, got '${exactValue}'`);
      }
      const precision = name === 'geohash-5' ? 5 : name === 'geohash-7' ? 7 : 9;
      // Prefix truncation of the full geohash: a coarse value is always a
      // prefix of the finer one.
      return geohashEncode(Number(m[1]), Number(m[2]), 9).slice(0, precision);
    }
    throw new Error(
      `coarsen: location rung '${name}' is reverse geocoding, not a pure derivation; ` +
      'declare it never-recorded instead of faking a lookup in the commitment core'
    );
  }
  throw new Error(
    `coarsen: ${family} value derivation is not core; identity and sensor ` +
    'values are pre-derived by the caller; pass each rung\'s value to commitContext'
  );
}
