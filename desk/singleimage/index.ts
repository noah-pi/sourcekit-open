// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * P5 single-image physics checks — orchestration (P5, items
 * 22–24; Lumethic-derived, geometric/statistical, no ML).
 *
 * analyzeSingleImage runs every applicable check on ONE decoded image and
 * returns each check's {state, score?, text}. Standing rules:
 *
 *   - Every check text carries its limits inline: these are statistical
 *     signals with UNCHARACTERIZED error rates until the P6 corpus ROC
 *     lands; thresholds are first-principles placeholders, versioned with
 *     the code.
 *   - 'not-applicable' and 'insufficient-data' are first-class states —
 *     a check that cannot run says so, and says why; nothing is faked.
 *   - Nothing here claims "passed", "authentic", or "verified". Absence
 *     of a flag is not evidence of genuineness, and every text says what
 *     evades it.
 *
 * INPUT CONTRACT: the analyzer consumes DECODED planes. For JPEG delivery
 * files, planesFromJpeg decodes with jpeg-js (pure JS, node-side). For RAW
 * captures the caller supplies a decoded LINEAR-RGB buffer (RgbPlanes) —
 * DNG/RAW decoding itself is OUT OF SCOPE for this module (no embedded
 * decoder); the caller declares the pixel provenance in meta.provenance,
 * and jpegGrid refuses to run on anything but 'raw-linear' (see its
 * header for why the gate exists).
 */

import { createRequire } from 'node:module';
import { analyzeCaRadial, type CaRadialResult, type PlaneSet } from './caRadial';
import { analyzeJpegGrid, type JpegGridResult, type PixelProvenance } from './jpegGrid';
import { analyzePoissonPrnu, type PoissonPrnuResult } from './poissonPrnu';

export const SINGLE_IMAGE_METHOD_VERSION = '0.1.0-p5-scaffold';

export { analyzeCaRadial, type CaRadialResult } from './caRadial';
export { analyzeJpegGrid, fft2dMagnitudes, type JpegGridResult, type PixelProvenance } from './jpegGrid';
export { analyzePoissonPrnu, type PoissonPrnuResult, type ReferenceLeg } from './poissonPrnu';

/** Decoded planar RGB, linear light, length width*height per channel. */
export interface RgbPlanes {
  width: number;
  height: number;
  r: ArrayLike<number>;
  g: ArrayLike<number>;
  b: ArrayLike<number>;
}

export interface SingleImageMeta {
  /** REQUIRED pixel provenance — jpegGrid refuses 'jpeg-delivery' outright. */
  provenance: PixelProvenance;
  /** Principal point in pixels (defaults to frame center) for the CA fit. */
  principalPoint?: [number, number];
  /** Committed flat-field reference pattern for the PRNU leg (image length). */
  referencePattern?: ArrayLike<number>;
}

export interface SingleImageReport {
  methodVersion: string;
  checks: {
    caRadial: CaRadialResult;
    jpegGrid: JpegGridResult;
    poissonPrnu: PoissonPrnuResult;
  };
  /** Standing limitations, always attached — quote them with any score. */
  limitations: string[];
}

export const SINGLE_IMAGE_LIMITATIONS: string[] = [
  'Error rates are UNCHARACTERIZED until the P6 corpus ROC lands; every threshold is a first-principles placeholder versioned with the code.',
  'CA radial structure: a consistent field is evadable (re-photographing a photograph carries the original CA through); its absence is also produced by in-camera CA correction — neither direction is suspicion or clearance by itself.',
  'JPEG grid: meaningful ONLY on pixels claimed raw-linear (refused on JPEG delivery files); a resized or off-grid-cropped JPEG evades it, so "no grid" clears nothing.',
  'Poisson–PRNU: the orchestrated profile runs on the green channel (luma recombination of misaligned channels corrupts the fit — an artifact of recombination, not the sensor); Poisson-shaped noise can be synthesized; noise reduction and tone mapping reshape the profile either way; the reference leg needs a committed flat-field pattern and never fabricates one from the image itself.',
  'RAW/DNG decoding is out of scope — the caller supplies decoded linear-RGB planes and declares their provenance; an undeclared or misdeclared buffer is a caller-side failure, not a measurement.',
  'Every output is a statistical signal a person weighs, never a verdict; absence of a flag is not evidence of genuineness.',
];

/** Rec.601 luma from planar RGB. */
export function lumaFromPlanes(planes: RgbPlanes): Float64Array {
  const n = planes.width * planes.height;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.299 * planes.r[i] + 0.587 * planes.g[i] + 0.114 * planes.b[i];
  }
  return out;
}

export function analyzeSingleImage(planes: RgbPlanes, meta: SingleImageMeta): SingleImageReport {
  if (!meta || (meta.provenance !== 'raw-linear' && meta.provenance !== 'jpeg-delivery')) {
    throw new Error("singleimage: meta.provenance must be declared ('raw-linear' or 'jpeg-delivery') — undeclared pixels are never scored");
  }
  const planeSet: PlaneSet = planes;
  const luma = lumaFromPlanes(planes);
  return {
    methodVersion: SINGLE_IMAGE_METHOD_VERSION,
    checks: {
      caRadial: analyzeCaRadial(planeSet, { principalPoint: meta.principalPoint }),
      jpegGrid: analyzeJpegGrid(luma, planes.width, planes.height, { provenance: meta.provenance }),
      // Noise profiling runs on the GREEN channel, not the recombined luma:
      // standard forensic practice. Recombining channels whose sub-pixel
      // alignment differs (any real lens's CA) injects mean-INDEPENDENT
      // variance modulation that flattens the variance-vs-mean fit — an
      // artifact of the recombination, not the sensor. The luma-residual
      // API in poissonPrnu.ts remains for direct single-plane use.
      poissonPrnu: analyzePoissonPrnu(planes.g, planes.width, planes.height, { referencePattern: meta.referencePattern }),
    },
    limitations: [...SINGLE_IMAGE_LIMITATIONS],
  };
}

// ---------------------------------------------------------------------------
// JPEG decode helper (node-side; jpeg-js — the same decoder the desk CLI and
// the staged lab use). In the browser desk, node:module resolves to a stub
// that throws honestly — the analyzer core takes decoded planes regardless.
// ---------------------------------------------------------------------------

interface JpegJs {
  decode(data: Uint8Array, opts?: { maxMemoryUsageInMB?: number }): { width: number; height: number; data: Uint8Array };
}

/** Decode JPEG bytes to planar RGB (gamma-encoded, as stored — stated). */
export function planesFromJpeg(bytes: Uint8Array): RgbPlanes {
  const require = createRequire(import.meta.url);
  const jpeg = require('jpeg-js') as JpegJs;
  const img = jpeg.decode(bytes, { maxMemoryUsageInMB: 256 });
  if (!img || img.width < 8 || img.height < 8) {
    throw new Error('singleimage: undecodable or degenerate JPEG — nothing to analyze');
  }
  const n = img.width * img.height;
  const r = new Float64Array(n), g = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = img.data[i * 4];
    g[i] = img.data[i * 4 + 1];
    b[i] = img.data[i * 4 + 2];
  }
  return { width: img.width, height: img.height, r, g, b };
}
