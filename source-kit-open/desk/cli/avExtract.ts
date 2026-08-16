/**
 * Tier-1 CLI extraction adapters — the node/ffmpeg counterparts
 * that feed the desk's pure analyzers (desk/src/core/displayBeat.ts,
 * enfExtract.ts, avSync.ts, rollingShutter.ts). Same pattern as raster.ts:
 * ffmpeg/ffprobe produce raw pixels/PCM; every measurement runs in the
 * SHARED core code; the report states which rasterizer ran. When ffmpeg or
 * a stream is absent the adapter returns null and the CLI prints an honest
 * "not available — <reason>" line; nothing is faked.
 */

import { execFileSync } from 'node:child_process';
import { ffmpegAvailable } from './raster';
import type { GrayPlane } from '../src/core/parallax';
import type { LumaSample } from '../src/core/displayBeat';
import type { MotionSample } from '../src/core/avSync';
import { estimateGlobalMotion } from '@exhibit/lib/opticalflow';

export interface VideoProbe {
  width: number;
  height: number;
  durationSec: number;
  /** Container average frame rate, Hz (0 when unprobeable). */
  fps: number;
  hasAudio: boolean;
}

/** ffprobe video+audio facts; null when the file is unprobeable. */
export function probeVideo(file: string): VideoProbe | null {
  if (!ffmpegAvailable()) return null;
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,width,height,avg_frame_rate:format=duration',
      '-of', 'json', file,
    ], { stdio: 'pipe' }).toString();
    const j = JSON.parse(out);
    const v = (j.streams ?? []).find((s: { codec_type?: string }) => s.codec_type === 'video');
    if (!v?.width || !v?.height) return null;
    const [an, ad] = String(v.avg_frame_rate ?? '0/1').split('/').map(Number);
    const fps = ad ? an / ad : 0;
    return {
      width: v.width,
      height: v.height,
      durationSec: parseFloat(j.format?.duration ?? '0') || 0,
      fps: Number.isFinite(fps) ? fps : 0,
      hasAudio: (j.streams ?? []).some((s: { codec_type?: string }) => s.codec_type === 'audio'),
    };
  } catch {
    return null;
  }
}

function ffmpegRaw(file: string, args: string[]): Buffer | null {
  try {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', file, ...args], {
      stdio: 'pipe',
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Rasterize a video track to gray planes at `fps` (uniform grid stated, not
 * assumed — the fps filter resamples the container timeline). Null when
 * ffmpeg/video decode fails. Frames beyond maxFrames are dropped (disclosed
 * by the caller).
 */
export function extractGrayFrames(
  file: string,
  fps: number,
  rasterWidth: number,
  maxFrames: number,
): { frames: GrayPlane[]; width: number; height: number; dropped: number } | null {
  const probe = probeVideo(file);
  if (!probe || probe.fps <= 0) return null;
  const w = rasterWidth;
  const h = Math.max(16, Math.round((probe.height / probe.width) * w)) & ~1;
  const raw = ffmpegRaw(file, ['-vf', `fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  if (!raw) return null;
  const frameBytes = w * h;
  const total = Math.floor(raw.length / frameBytes);
  if (total < 1) return null;
  const count = Math.min(total, maxFrames);
  const frames: GrayPlane[] = [];
  for (let k = 0; k < count; k++) {
    frames.push({
      width: w,
      height: h,
      gray: Float64Array.from(new Uint8Array(raw.buffer, raw.byteOffset + k * frameBytes, frameBytes)),
    });
  }
  return { frames, width: w, height: h, dropped: total - count };
}

/** Mean-luma series from gray planes on a uniform fps grid. */
export function lumaSeriesFromPlanes(frames: GrayPlane[], fps: number): LumaSample[] {
  return frames.map((f, k) => {
    let sum = 0;
    for (let i = 0; i < f.gray.length; i++) sum += f.gray[i];
    return { tSec: k / fps, luma: sum / f.gray.length };
  });
}

/**
 * Decode the audio track to mono 16 kHz signed-16 PCM (the capture
 * format). Null when ffmpeg fails or the file has no audio stream — the
 * caller distinguishes absent vs never-recorded via probeVideo().hasAudio.
 */
export function extractPcmMono16k(file: string): { samples: Int16Array; sampleRateHz: number } | null {
  if (!ffmpegAvailable()) return null;
  const raw = ffmpegRaw(file, ['-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-acodec', 'pcm_s16le', '-']);
  if (!raw || raw.length < 4) return null;
  const n = Math.floor(raw.length / 2);
  return { samples: new Int16Array(raw.buffer, raw.byteOffset, n), sampleRateHz: 16000 };
}

/**
 * Motion series for the onset-alignment analyzer: global motion per sampled
 * frame pair on the uniform fps grid; magnitude = |translation| + |roll|·w/2
 * (px-equivalent rotation at the frame edge — the composition is stated in
 * the CLI output). Pairs with no global fit are gaps; their magnitude is 0
 * and the gap count is returned for disclosure.
 */
export function motionSeriesFromPlanes(
  frames: GrayPlane[],
  fps: number,
): { motion: MotionSample[]; gaps: number } {
  const motion: MotionSample[] = [];
  let gaps = 0;
  for (let k = 1; k < frames.length; k++) {
    const prev = frames[k - 1];
    const cur = frames[k];
    const m = estimateGlobalMotion(prev.gray, cur.gray, cur.width, cur.height);
    if (!m) {
      gaps++;
      motion.push({ tSec: (k - 0.5) / fps, magnitude: 0 });
      continue;
    }
    motion.push({
      tSec: (k - 0.5) / fps,
      magnitude: Math.hypot(m.tx, m.ty) + Math.abs(m.rotRad) * (cur.width / 2),
    });
  }
  return { motion, gaps };
}
