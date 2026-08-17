// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * EXIF sanitization for the signed com.verify.exif assertion (0.10.0).
 *
 * The camera pipeline reports exposure and lens facts alongside every frame.
 * Signed into the manifest, they give a desk cross-checks that are awkward
 * to fake (does the claimed focal length match the scene's perspective? the
 * claimed exposure the lighting?) — self-reported metadata, stated as such,
 * never a verdict.
 *
 * The allowlist is CLOSED and privacy-first. EXIF can carry GPS
 * coordinates, maker notes, serial numbers, and free-text user fields —
 * none of those may ever enter a signed assertion: location is governed by
 * the record's own location claim (with its redaction path), and free text
 * is an unbounded identifier. Anything not explicitly listed is dropped;
 * values are normalized (finite numbers, short plain strings) so a hostile
 * camera app can't smuggle payloads through a field we do keep.
 */

/** Numeric EXIF fields worth signing (exposure + optics + dimensions). */
const NUMERIC_FIELDS = new Set([
  'ISO', 'ISOSpeedRatings',
  'ExposureTime', 'ShutterSpeedValue',
  'FNumber', 'ApertureValue',
  'ExposureBiasValue', 'BrightnessValue',
  'FocalLength', 'FocalLengthIn35mmFilm',
  'DigitalZoomRatio',
  'ExposureMode', 'MeteringMode', 'WhiteBalance', 'Flash',
  'SensingMethod', 'SceneCaptureType', 'ColorSpace',
  'Orientation',
  'PixelXDimension', 'PixelYDimension', 'ExifImageWidth', 'ExifImageHeight',
]);

/** Short string EXIF fields worth signing (optics identity + clock). */
const STRING_FIELDS = new Set([
  'LensMake', 'LensModel', 'LensSpecification',
  'Make', 'Model',
  'DateTimeOriginal', 'DateTimeDigitized',
]);

const MAX_STRING_LEN = 80;

/**
 * Returns the signed-assertion-safe subset of a camera EXIF object. Never
 * throws; unknown/odd values are dropped, not guessed at.
 */
export function sanitizeExif(raw: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (NUMERIC_FIELDS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (STRING_FIELDS.has(k) && typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN) {
      // Printable ASCII only — no control bytes riding a signed field.
      if (/^[\x20-\x7e]+$/.test(v)) out[k] = v;
    }
  }
  return out;
}

/** True when the sanitized object carries anything worth signing. */
export function hasExifSignal(sanitized: Record<string, number | string>): boolean {
  return Object.keys(sanitized).length > 0;
}
