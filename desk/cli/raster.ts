// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Desk CLI rasterizer — the node counterpart of the browser
 * adapters in desk/src/core. Same shared DSP (@exhibit/lib/rephoto,
 * @exhibit/lib/phash, @exhibit/lib/opticalflow), same raster caps and luma
 * math; only the pixel source differs: ffmpeg/ffprobe instead of
 * canvas/<video>. The report states which rasterizer ran.
 *
 * Every measurement remains EVIDENCE a person weighs — never a verdict,
 * never a gate. If ffmpeg is absent, each adapter returns null and the CLI
 * prints an honest "not performed" line; nothing is faked.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pHashFromGray32, PHASH_SIZE } from '@exhibit/lib/phash';
import {
  analyzeBanding, analyzeMoire, analyzeBlackFloor, analyzeGamut,
} from '@exhibit/lib/rephoto';
import { estimateGlobalMotion, type GlobalMotion } from '@exhibit/lib/opticalflow';
import type { FlowSample } from '@exhibit/lib/imuflow';
import type { RephotoReport } from '../src/core/rephoto';
import type { VideoMotionResult, SampledFrame } from '../src/core/videoMotion';

/** Same caps as the browser adapters — parity matters more than resolution. */
const ANALYSIS_LONG_SIDE = 512;
const RASTER_WIDTH = 96;
const SAMPLE_INTERVAL_SEC = 0.4;
const MAX_SAMPLES = 60;

let ffmpegCache: boolean | null = null;
export function ffmpegAvailable(): boolean {
  if (ffmpegCache !== null) return ffmpegCache;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' });
    execFileSync('ffprobe', ['-version'], { stdio: 'pipe' });
    ffmpegCache = true;
  } catch {
    ffmpegCache = false;
  }
  return ffmpegCache;
}

function withTempFile<T>(bytes: Uint8Array, ext: string, fn: (p: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exhibit-desk-'));
  const p = path.join(dir, `in.${ext}`);
  try {
    fs.writeFileSync(p, bytes);
    return fn(p);
  } finally {
    try { fs.unlinkSync(p); fs.rmdirSync(dir); } catch { /* temp litter is not a failure */ }
  }
}

function probe(file: string): { width: number; height: number; durationSec: number } | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration',
      '-of', 'json', file,
    ], { stdio: 'pipe' }).toString();
    const j = JSON.parse(out);
    const s = j.streams?.[0];
    if (!s?.width || !s?.height) return null;
    return { width: s.width, height: s.height, durationSec: parseFloat(j.format?.duration ?? '0') || 0 };
  } catch {
    return null;
  }
}

function ffmpegRaw(file: string, vf: string, pixFmt: string): Buffer | null {
  try {
    return execFileSync('ffmpeg', [
      '-v', 'error', '-i', file,
      '-vf', vf, '-f', 'rawvideo', '-pix_fmt', pixFmt, '-',
    ], { stdio: 'pipe', maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** pHash via ffmpeg — the CLI's adapter for DeskAdapters.pHash. */
export async function nodePHash(bytes: Uint8Array, mime: string): Promise<string | null> {
  if (!ffmpegAvailable()) return null;
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  return withTempFile(bytes, ext, (p): string | null => {
    const raw = ffmpegRaw(p, `scale=${PHASH_SIZE}:${PHASH_SIZE}`, 'gray');
    if (!raw || raw.length !== PHASH_SIZE * PHASH_SIZE) return null;
    return pHashFromGray32(new Uint8Array(raw.buffer, raw.byteOffset, raw.length));
  });
}

/** Rephoto signals via ffmpeg — mirrors rephoto.ts in caps and luma math. */
export async function nodeRephoto(bytes: Uint8Array, mime: string): Promise<RephotoReport | null> {
  if (!ffmpegAvailable()) return null;
  const ext = mime === 'image/png' ? 'png' : 'jpg';
  return withTempFile(bytes, ext, (p): RephotoReport | null => {
    const dims = probe(p);
    if (!dims) return null;
    const scale = Math.min(1, ANALYSIS_LONG_SIDE / Math.max(dims.width, dims.height));
    const w = Math.max(8, Math.round(dims.width * scale));
    const h = Math.max(8, Math.round(dims.height * scale));
    const raw = ffmpegRaw(p, `scale=${w}:${h}`, 'rgba');
    if (!raw || raw.length !== w * h * 4) return null;
    const rgba = new Uint8Array(raw.buffer, raw.byteOffset, w * h * 4);

    // ITU-R 601 luma plane — identical to the browser adapter.
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
  });
}

/** Video motion via ffmpeg — mirrors videoMotion.ts cadence and assembly. */
export async function nodeVideoMotion(bytes: Uint8Array, mime: string, epochMsAtStart: number): Promise<VideoMotionResult | null> {
  if (!ffmpegAvailable()) return null;
  const ext = mime === 'video/quicktime' ? 'mov' : 'mp4';
  return withTempFile(bytes, ext, (p): VideoMotionResult | null => {
    const dims = probe(p);
    if (!dims || dims.durationSec < SAMPLE_INTERVAL_SEC * 2) return null;

    const count = Math.min(MAX_SAMPLES, Math.floor(dims.durationSec / SAMPLE_INTERVAL_SEC));
    const w = RASTER_WIDTH;
    const h = Math.max(8, Math.round((dims.height / dims.width) * w)) & ~1; // even for the encoder
    const raw = ffmpegRaw(p, `fps=${1 / SAMPLE_INTERVAL_SEC},scale=${w}:${h}`, 'gray');
    if (!raw) return null;

    const frameBytes = w * h;
    const frameCount = Math.min(count, Math.floor(raw.length / frameBytes));
    if (frameCount < 2) return null;

    const frames: SampledFrame[] = [];
    for (let k = 0; k < frameCount; k++) {
      const buf = new Uint8Array(raw.buffer, raw.byteOffset + k * frameBytes, frameBytes);
      frames.push({ tSec: k * SAMPLE_INTERVAL_SEC, width: w, height: h, gray: Float64Array.from(buf) });
    }

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
  });
}
