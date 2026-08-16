/**
 * Video motion extraction — the desk's browser adapter.
 *
 * Seeks through a dropped video on a hidden <video> element, rasterizes
 * sampled frames to a small grayscale plane, and runs the SHARED global
 * motion estimator (src/lib/opticalflow.ts) on consecutive pairs. The
 * resulting flow series feeds two things:
 *   - the IMU↔flow consistency cross-check against the signed pose trace
 *     (desk/src/core/deskCore.ts wires it into the dossier);
 *   - the flow-field overlay (the sampled frames are returned too, so the
 *     dossier can draw the block-match vectors for human review).
 *
 * LIMITS, stated not hidden:
 *  - Frame times come from the container's timeline; the pose trace's clock
 *    is the device's. Small skew is tolerated by the lag-tolerant
 *    correlation; large skew shows up as weak correlation — evidence, not
 *    a verdict.
 *  - Everything runs in this tab. No upload, no server.
 */

import { estimateGlobalMotion, type GlobalMotion } from '@exhibit/lib/opticalflow';
import type { FlowSample } from '@exhibit/lib/imuflow';

export interface SampledFrame {
  /** Video-time of this frame, seconds from container start. */
  tSec: number;
  width: number;
  height: number;
  gray: Float64Array;
}

export interface VideoMotionResult {
  frames: SampledFrame[];
  flow: FlowSample[];
  /** Pairs that produced a usable global fit (rest are gaps — disclosed). */
  usablePairs: number;
}

/** Analysis raster width; height follows aspect. Small = fast + robust. */
const RASTER_WIDTH = 96;
/** Wall-clock cap on total analysis time — long videos stop early, stated. */
const MAX_SAMPLES = 60;
/** Seconds of video-time between sampled frames. */
const SAMPLE_INTERVAL_SEC = 0.4;

function rasterize(video: HTMLVideoElement, canvas: HTMLCanvasElement): SampledFrame | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || video.videoWidth === 0) return null;
  const w = RASTER_WIDTH;
  const h = Math.max(8, Math.round((video.videoHeight / video.videoWidth) * w));
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  const gray = new Float64Array(w * h);
  for (let i = 0; i < gray.length; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return { tSec: video.currentTime, width: w, height: h, gray };
}

function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('seek failed'));
    };
    const cleanup = () => {
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = t;
  });
}

/**
 * Extract sampled frames + frame-pair global motion from video bytes.
 * `epochMsAtStart` maps container time zero onto the record's clock
 * (capturedAt) so flow samples land on the same timeline as the pose trace.
 * Returns null when the browser can't decode the container — disclosed by
 * the caller, never faked.
 */
export async function extractVideoMotion(bytes: Uint8Array, mime: string, epochMsAtStart: number): Promise<VideoMotionResult | null> {
  try {
    const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'auto';
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error('video decode failed')), { once: true });
    });
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (duration < SAMPLE_INTERVAL_SEC * 2) {
      URL.revokeObjectURL(url);
      return null; // too short for even one pair — the caller says so
    }

    const canvas = document.createElement('canvas');
    const frames: SampledFrame[] = [];
    const count = Math.min(MAX_SAMPLES, Math.floor(duration / SAMPLE_INTERVAL_SEC));
    for (let k = 0; k < count; k++) {
      await seekTo(video, k * SAMPLE_INTERVAL_SEC);
      const f = rasterize(video, canvas);
      if (f) frames.push(f);
    }
    URL.revokeObjectURL(url);

    const flow: FlowSample[] = [];
    for (let k = 1; k < frames.length; k++) {
      const prev = frames[k - 1];
      const cur = frames[k];
      const motion: GlobalMotion | null = estimateGlobalMotion(prev.gray, cur.gray, cur.width, cur.height);
      if (!motion) continue; // a gap, disclosed via usablePairs vs pairs
      flow.push({
        tMs: epochMsAtStart + ((prev.tSec + cur.tSec) / 2) * 1000,
        dtMs: (cur.tSec - prev.tSec) * 1000,
        motion,
        frameBIndex: k,
      });
    }
    return { frames, flow, usablePairs: flow.length };
  } catch {
    return null;
  }
}
