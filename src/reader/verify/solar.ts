/**
 * Solar geometry: where the committed time and place put the sun.
 *
 * Implements the NOAA solar ephemeris (fractional-year equation of time and
 * declination, true solar time, hour angle, elevation, azimuth), accurate to
 * ~0.01° from latitude, longitude, and UTC instant.
 *
 * Prediction side only. Measuring a shadow in the pixels is image analysis
 * this engine does not run, so the card state is 'insufficient'. The one
 * standalone finding is a sun below the horizon, where no shadow grammar
 * applies. Every value text marks the self-reported location with ◌; a
 * record with no usable location ('redacted', 'unavailable', absent) renders
 * not-run. Numbers carry SOLAR_CAVEAT.
 */

import type { AttestationRecord, LocationClaim } from '../../provenance/manifest';
import { makeCard, makeNotRun } from '../interpret/cards';
import type { EvidenceCard } from '../types';

/** The standing caveat, appended to every number this module reports. */
export const SOLAR_CAVEAT = 'error bounds are provisional pending corpus characterization';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

export interface SolarPosition {
  /** Degrees above the horizon (negative = sun down). */
  elevationDeg: number;
  /** Degrees clockwise from north. */
  azimuthDeg: number;
}

/**
 * NOAA solar position (noaa.gov/gmd/grad/solcalc): equation of time and
 * declination from the fractional year, true solar time from longitude,
 * elevation from the hour angle, azimuth clockwise from north.
 */
export function solarPosition(latDeg: number, lonDeg: number, at: Date): SolarPosition {
  const yearStart = Date.UTC(at.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((at.getTime() - yearStart) / 86_400_000) + 1;
  const utcHours = at.getUTCHours() + at.getUTCMinutes() / 60 + at.getUTCSeconds() / 3600;

  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (utcHours - 12) / 24);
  const eqTimeMin =
    229.18 *
    (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const declRad =
    0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);

  const trueSolarMin = utcHours * 60 + eqTimeMin + 4 * lonDeg;
  const hourAngleRad = (trueSolarMin / 4 - 180) * RAD;

  const latRad = latDeg * RAD;
  const cosZenith =
    Math.sin(latRad) * Math.sin(declRad) +
    Math.cos(latRad) * Math.cos(declRad) * Math.cos(hourAngleRad);
  const zenithDeg = Math.acos(Math.min(1, Math.max(-1, cosZenith))) * DEG;
  const elevationDeg = 90 - zenithDeg;

  const azRad = Math.atan2(
    Math.sin(hourAngleRad),
    Math.cos(hourAngleRad) * Math.sin(latRad) - Math.tan(declRad) * Math.cos(latRad),
  );
  const azimuthDeg = (azRad * DEG + 180 + 360) % 360;

  return { elevationDeg, azimuthDeg };
}

/** Shadow grammar for a vertical object, in the object's own height units. */
export interface ShadowGrammar {
  /** Shadow length for a 1 m pole, cm. */
  poleShadowCm: number;
  /** Direction the shadow points, degrees clockwise from north (azimuth + 180°). */
  bearingDeg: number;
}

export function shadowGrammar(pos: SolarPosition): ShadowGrammar | null {
  if (pos.elevationDeg <= 0) return null; // sun down, no shadow grammar applies
  const tanEl = Math.tan(pos.elevationDeg * RAD);
  return {
    poleShadowCm: Math.round((100 / tanEl) * 10) / 10,
    bearingDeg: Math.round(((pos.azimuthDeg + 180) % 360) * 10) / 10,
  };
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

export function solarCard(record: AttestationRecord): EvidenceCard {
  const loc = record.context?.location;
  const methodBase =
    `Read ▸ NOAA ephemeris over the committed place ◌ and the committed device clock ◌ (longitude-implied solar time included); ${SOLAR_CAVEAT}`;

  if (!loc || loc === 'redacted' || loc === 'unavailable' || typeof loc !== 'object') {
    const why =
      loc === 'redacted'
        ? 'the signer redacted the location (opt-out or de-identified copy), so there is no committed place to put the sun over'
        : loc === 'unavailable'
          ? 'the device reported no location at capture, so there is no committed place to put the sun over'
          : 'the record commits no location, so there is no place to put the sun over';
    return makeNotRun('coherence.solar', 'Sun position', why, { method: methodBase });
  }
  const claim = loc as LocationClaim;
  if (typeof claim.lat !== 'number' || typeof claim.lon !== 'number') {
    return makeNotRun('coherence.solar', 'Sun position', 'the committed location is malformed; no usable latitude/longitude', { method: methodBase });
  }
  const at = new Date(record.capturedAt);
  if (!Number.isFinite(at.getTime())) {
    return makeNotRun('coherence.solar', 'Sun position', 'the committed capture time does not parse; no instant to place the sun at', { method: methodBase });
  }

  const pos = solarPosition(claim.lat, claim.lon, at);
  const prediction =
    `committed place ◌ ${claim.lat.toFixed(4)}, ${claim.lon.toFixed(4)}${claim.accuracyM ? ` ±${claim.accuracyM} m` : ''} at committed time ◌ ${record.capturedAt}; these fix the sun's geometry`;
  const base = {
    id: 'coherence.solar', title: 'Sun position',
    prediction,
    method: methodBase,
    audit: 'Audit ▸ lat/lon + UTC instant → elevation/azimuth is deterministic (NOAA); the shadow grammar follows from elevation alone',
  } as const;

  if (pos.elevationDeg <= 0) {
    return makeCard({
      ...base, state: 'insufficient',
      measurement: `sun ${round1(pos.elevationDeg)}° BELOW the horizon at the committed place ◌ and time ◌; no shadow grammar applies`,
      gap: 'undecidable: the sun was down; there is no shadow to predict or measure',
      interpretation:
        'consistent with a night capture; if the photo reads as daylight, that disagreement is visible in the committed data. This card only places the sun',
    });
  }

  const shadow = shadowGrammar(pos)!;
  // A scaled restatement for a familiar object: shadow scales with height.
  const objectCm = 30;
  const objectShadowCm = Math.round((shadow.poleShadowCm * objectCm) / 1000) * 10;
  return makeCard({
    ...base, state: 'insufficient',
    measurement:
      `sun ${Math.round(pos.elevationDeg)}° up, azimuth ${Math.round(pos.azimuthDeg)}°: a 1 m pole throws a ${shadow.poleShadowCm} cm shadow pointing ${shadow.bearingDeg}°; a ${objectCm} cm object throws ${objectShadowCm} cm`,
    gap: 'undecidable: no shadow has been measured in the pixels; shadow reading is image analysis the full Reader runs, not this engine',
    interpretation:
      'the prediction is shown next to the photo: shadows in the scene should point ' +
      `${shadow.bearingDeg}° and scale with elevation. Agreement is corroboration, disagreement is a question, neither is a conclusion`,
    gauge: { value: round1(pos.elevationDeg), band: [0, 90], units: '° above horizon' },
  });
}
