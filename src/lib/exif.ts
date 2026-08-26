// Source Kit 0.1.0 — EXIF sanitization for the signed com.verify.exif assertion
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * EXIF sanitization for the signed com.verify.exif assertion.
 *
 * Closed allowlist: anything not listed below is dropped, so GPS, maker
 * notes, serial numbers, and free-text fields never reach a signed
 * assertion (location is carried by the record's own location claim).
 * Kept values are normalized — finite numbers, short printable strings.
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
 * throws; unknown or malformed values are dropped.
 */
export function sanitizeExif(raw: unknown): Record<string, number | string> {
  const out: Record<string, number | string> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (NUMERIC_FIELDS.has(k) && typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v;
    } else if (STRING_FIELDS.has(k) && typeof v === 'string' && v.length > 0 && v.length <= MAX_STRING_LEN) {
      // Printable ASCII only: no control bytes in a signed field.
      if (/^[\x20-\x7e]+$/.test(v)) out[k] = v;
    }
  }
  return out;
}

/** True when the sanitized object carries anything worth signing. */
export function hasExifSignal(sanitized: Record<string, number | string>): boolean {
  return Object.keys(sanitized).length > 0;
}
