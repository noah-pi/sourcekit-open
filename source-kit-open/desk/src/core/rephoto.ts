/**
 * Screen re-photography signals — the desk's browser adapter.
 *
 * All DSP lives in the SHARED core (@exhibit/lib/rephoto) — the same module
 * the open test suite exercises on synthetic patterns. This file only
 * rasterizes a dropped photo onto a canvas and hands the analyzers planes.
 *
 * HONESTY: every number here is EVIDENCE a person weighs — never a verdict,
 * never a gate. The dossier panel renders raw measurements with descriptive
 * strength labels and says exactly that. Photos only for now: video frame
 * analysis is not implemented here, and the absence is stated, not hidden.
 */

import {
  analyzeBanding, analyzeMoire, analyzeBlackFloor, analyzeGamut,
  type BandingResult, type MoireResult, type BlackFloorResult, type GamutResult,
} from '@exhibit/lib/rephoto';

export interface RephotoReport {
  banding: BandingResult;
  moire: MoireResult;
  blackFloor: BlackFloorResult;
  gamut: GamutResult;
  /** The raster the analysis ran on (long side), for transparency. */
  analyzedWidth: number;
  analyzedHeight: number;
}

/** Long-side cap for the analysis raster (moiré downsamples further internally). */
const ANALYSIS_LONG_SIDE = 512;

export async function analyzeRephoto(bytes: Uint8Array, mime: string): Promise<RephotoReport | null> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, ANALYSIS_LONG_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(8, Math.round(bmp.width * scale));
    const h = Math.max(8, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const rgba = ctx.getImageData(0, 0, w, h).data;

    // ITU-R 601 luma plane for the spectral analyzers.
    const gray = new Float64Array(w * h);
    for (let i = 0; i < gray.length; i++) {
      const o = i * 4;
      gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
    }

    return {
      banding: analyzeBanding(gray, w, h),
      moire: analyzeMoire(gray, w, h),
      blackFloor: analyzeBlackFloor(gray, w, h),
      gamut: analyzeGamut(rgba, w * h),
      analyzedWidth: w,
      analyzedHeight: h,
    };
  } catch {
    // Unrasterizable input is not an analysis failure — it is no signal.
    return null;
  }
}
