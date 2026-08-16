/**
 * Ring-dump JPEG decoding for the desk CLI.
 *
 * Decodes a CaptureKit ring directory (f000.jpg…f007.jpg, oldest first)
 * into luma analysis rasters with jpeg-js: a pure-JS decoder,
 * so ring analysis needs no ffmpeg and the CLI runs the SAME decode the
 * staged test suite exercises. Undecodable frames come back null in place —
 * the analyzer counts them and says so; nothing is faked.
 */

import { createRequire } from 'node:module';
import { grayPlaneFromRgba, type GrayPlane } from '../src/core/parallax';

interface JpegJs {
  decode(data: Uint8Array, opts?: { maxMemoryUsageInMB?: number }): { width: number; height: number; data: Uint8Array };
}

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js') as JpegJs;

/** Long-side cap for the analysis raster — rides in the evidence limitations. */
export const RING_ANALYSIS_LONG_SIDE = 320;

/** Decode one JPEG to a luma raster; null when undecodable (disclosed upstream). */
export function decodeRingJpeg(bytes: Uint8Array): GrayPlane | null {
  try {
    const img = jpeg.decode(bytes, { maxMemoryUsageInMB: 256 });
    if (!img || img.width < 16 || img.height < 16) return null;
    return grayPlaneFromRgba(img.data, img.width, img.height, RING_ANALYSIS_LONG_SIDE);
  } catch {
    return null;
  }
}

/**
 * Read a ring dump directory: every f*.jpg, sorted by name (oldest first),
 * decoded in order. Missing/garbled files decode to null at their position —
 * the analyzer's insufficient path handles the count honestly.
 */
export function readRingDir(ringDir: string, fs: typeof import('node:fs'), path: typeof import('node:path')): (GrayPlane | null)[] {
  const names = fs
    .readdirSync(ringDir)
    .filter((n) => /^f\d+\.jpe?g$/i.test(n))
    .sort();
  return names.slice(0, 8).map((n) => decodeRingJpeg(new Uint8Array(fs.readFileSync(path.join(ringDir, n)))));
}
