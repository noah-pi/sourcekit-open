// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RawAudioCard — the raw LPCM audio master (CAF) that rode with the
 * capture.
 *
 * Hidden entirely for still photos (the sink does not apply). For
 * video/audio exhibits it reads the sealed path from the record, parses
 * the CAF container itself, and shows:
 *
 *   - a waveform drawn from the actual PCM samples (≈200 rms bars),
 *   - the duration in seconds (frames ÷ sample rate, from the container),
 *   - the SHA-256 of the PCM payload — recomputed on this device, so a
 *     reader can match it against any copy of the same master,
 *   - a "Power-grid anchor" row when the record carries ENF anchor fields
 *     (firstSampleWallClockUtcMs / sampleRate / sampleCount) — omitted
 *     entirely when absent, never fabricated.
 *
 * "Not recorded" is the neutral absence state; a read/parse failure is
 * stated plainly and stays neutral — absence and failure are not tamper.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import type { EvidencePath } from '../../provenance/manifest';
import { readFileBytes, writeFileBytes } from '../../lib/fileHash';
import { sha256Hex } from '../../lib/sign';
import { ForensicCard, ForensicMono, NotRecorded } from './ForensicCard';
import { toFileUri } from './grayMatch';

/** ENF anchor fields, when the record carries them (added capture-side;
 *  older records simply don't — the row is then omitted). */
export interface EnfAnchor {
  firstSampleWallClockUtcMs: number;
  sampleRate: number;
  sampleCount: number;
}

const BAR_COUNT = 200;

interface CafPcm {
  sampleRate: number;
  channels: number;
  bitsPerChannel: number;
  isFloat: boolean;
  bigEndian: boolean;
  /** LPCM flag bit 2: signed integer. Absent on old CAFs — CoreAudio
   *  convention then is 8-bit unsigned, everything wider signed. */
  isSigned: boolean;
  /** LPCM flag bit 4: valid bits high-aligned in a wider slot (only
   *  meaningful when the slot is wider than bitsPerChannel). */
  alignedHigh: boolean;
  /** LPCM flag bit 5: channel-blocked layout (each channel contiguous),
   *  as AVAudioEngine input formats commonly are. */
  nonInterleaved: boolean;
  bytesPerFrame: number;
  /** The audio payload bytes (after the data chunk's edit count). */
  pcm: Uint8Array;
  frames: number;
  /** Stated anomalies the reader repaired or worked around (0.18.6) —
   *  rendered in the meta line; never silent corrections. */
  notes?: string[];
  /** 0.20.1: set when the description is stated-but-undecodable (no
   *  plausible interpretation, no anchor). The fields may LOOK coherent —
   *  the compacted-layout candidate is a legitimate read of the stated
   *  bytes — so refusal must be explicit: the waveform and the WAV
   *  converter check this flag and stand down (a drawn waveform has to be
   *  real samples). */
  incoherent?: boolean;
}

function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/** The desc fields the reader needs, at the offsets of one interpretation. */
interface CafDescFields {
  formatFlags: number;
  bytesPerFrame: number;
  channels: number;
  bitsPerChannel: number;
}

/** A desc interpretation is plausible only when every field lands in the
 *  LPCM envelope — the 0.18.6 field master parsed as "16 ch ·
 *  1718773093-bit" (the ASCII 'free' of the NEXT chunk), which no gate
 *  here would have caught before. Garbage in now means "try another
 *  interpretation", never "render nonsense confidently". */
function plausibleDesc(d: CafDescFields, sampleRate: number): boolean {
  if (!(sampleRate > 0 && sampleRate <= 768000)) return false;
  if (!(d.channels >= 1 && d.channels <= 64)) return false;
  if (!(d.bytesPerFrame > 0 && d.bytesPerFrame <= 4096)) return false;
  if (![0, 8, 16, 20, 24, 32, 64].includes(d.bitsPerChannel)) return false;
  const nonInterleaved = (d.formatFlags & 32) !== 0;
  const slot = nonInterleaved ? d.bytesPerFrame : d.bytesPerFrame / d.channels;
  if (!Number.isInteger(slot) || slot < 1 || slot > 8) return false;
  if (d.bitsPerChannel > 0 && slot < Math.ceil(d.bitsPerChannel / 8)) return false;
  return true;
}

/**
 * Minimal CAF reader: 'caff' header, then typed chunks with 64-bit BE
 * sizes. The 'desc' AudioStreamBasicDescription is read under up to three
 * interpretations, in trust order:
 *   1. standard 36-byte ASBD (what every textbook CAF carries);
 *   2. a compacted 32-byte description (the 0.18.6 field master: the
 *      mFramesPerPacket slot is absent, so every field after it sits 4
 *      bytes early — reading it as standard yields "16 ch · 'free'-bit"
 *      nonsense and the frame count doubles, which is exactly what the
 *      build-40/41 cards showed);
 *   3. anchor-derived: the sealed capture log's frame count implies the
 *      frame stride outright (payload bytes ÷ frames), used only when the
 *      container's own description is incoherent — and stated as such.
 * When the sealed ENF anchor rides along, the interpretation whose implied
 * frame count MATCHES the anchor wins; a surviving mismatch is stated.
 * Returns null only when nothing coherent emerges (the caller renders the
 * neutral failure state). Exported for the logic tests.
 */
export function parseCaf(
  bytes: Uint8Array,
  expected?: { sampleRate?: number; sampleCount?: number },
): CafPcm | null {
  if (bytes.length < 12) return null;
  if (bytes[0] !== 0x63 || bytes[1] !== 0x61 || bytes[2] !== 0x66 || bytes[3] !== 0x66) return null; // 'caff'
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let descBody = -1;
  let descSize = 0;
  let pcm: Uint8Array | null = null;
  let off = 8;
  while (off + 12 <= bytes.length) {
    const t0 = bytes[off];
    const t1 = bytes[off + 1];
    const t2 = bytes[off + 2];
    const t3 = bytes[off + 3];
    const hi = readU32BE(bytes, off + 4);
    const lo = readU32BE(bytes, off + 8);
    // Sizes beyond 4 GiB cannot be addressed in a Uint8Array anyway.
    const size = hi === 0 && lo !== 0xffffffff ? lo : bytes.length - (off + 12);
    const body = off + 12;
    if (t0 === 0x64 && t1 === 0x65 && t2 === 0x73 && t3 === 0x63) {
      descBody = body;
      descSize = size;
    } else if (t0 === 0x64 && t1 === 0x61 && t2 === 0x74 && t3 === 0x61) {
      // 'data' — 4-byte edit count, then the audio payload.
      const start = body + 4;
      const end = Math.min(bytes.length, body + size);
      if (end > start) pcm = bytes.subarray(start, end);
    }
    if (size <= 0) break;
    off = body + size;
  }
  if (descBody < 0 || !pcm) return null;
  // 'lpcm' only; flags: bit0 float, bit1 big-endian, bit2 signed int,
  // bit4 aligned-high, bit5 non-interleaved.
  if (readU32BE(bytes, descBody + 8) !== 0x6c70636d) return null;
  const sampleRate = view.getFloat64(descBody, false);
  const formatFlags = readU32BE(bytes, descBody + 12);

  const notes: string[] = [];
  const candidates: { source: 'standard' | 'compacted'; d: CafDescFields }[] = [];
  if (descBody + 36 <= bytes.length) {
    candidates.push({
      source: 'standard',
      d: {
        formatFlags,
        bytesPerFrame: readU32BE(bytes, descBody + 24),
        channels: readU32BE(bytes, descBody + 28),
        bitsPerChannel: readU32BE(bytes, descBody + 32),
      },
    });
  }
  // 0.20.1 (field, 0.20.0 (53): the audio-mode hardware-format CAF rendered
  // "32 ch · 'chan'-bit" — a compacted 32-byte description the parser never
  // tried because the candidate was gated on the chunk's size field, and
  // this writer's size field did not say 32): the compacted read is ALWAYS
  // a candidate now; plausibility and the sealed anchor do the arbitrating,
  // and the size field only orders the trust (a stated 32 puts the
  // compacted layout first).
  const compacted: { source: 'compacted'; d: CafDescFields } | null = descBody + 32 <= bytes.length
    ? {
        source: 'compacted',
        d: {
          formatFlags,
          bytesPerFrame: readU32BE(bytes, descBody + 20),
          channels: readU32BE(bytes, descBody + 24),
          bitsPerChannel: readU32BE(bytes, descBody + 28),
        },
      }
    : null;
  if (compacted) {
    if (descSize === 32) candidates.unshift(compacted);
    else candidates.push(compacted);
  }

  const frameBytesOf = (d: CafDescFields): number =>
    (d.formatFlags & 32) !== 0 ? d.bytesPerFrame * d.channels : d.bytesPerFrame;
  const anchorFrames = expected && expected.sampleCount && expected.sampleCount > 0
    ? expected.sampleCount
    : null;
  const matchesAnchor = (d: CafDescFields): boolean =>
    anchorFrames !== null && frameBytesOf(d) > 0 && Math.floor(pcm.length / frameBytesOf(d)) === anchorFrames;
  // The anchor-vouched relaxed pass (0.20.1): everything plausibleDesc
  // checks EXCEPT the slot-width arithmetic. A sealed frame count that
  // divides the payload exactly is stronger evidence than the slot rules —
  // this is how a hardware-format CAF whose byte counts sit outside the
  // textbook matrix still decodes, with the anchor doing the vouching.
  const weaklyPlausibleDesc = (d: CafDescFields): boolean =>
    sampleRate > 0 && sampleRate <= 768000 &&
    d.channels >= 1 && d.channels <= 64 &&
    d.bytesPerFrame > 0 && d.bytesPerFrame <= 4096 &&
    [0, 8, 16, 20, 24, 32, 64].includes(d.bitsPerChannel);

  let chosen = candidates.find(c => plausibleDesc(c.d, sampleRate) && matchesAnchor(c.d))
    ?? candidates.find(c => weaklyPlausibleDesc(c.d) && matchesAnchor(c.d))
    ?? candidates.find(c => plausibleDesc(c.d, sampleRate))
    ?? null;
  const anchorVouched = chosen !== null
    && !plausibleDesc(chosen.d, sampleRate)
    && matchesAnchor(chosen.d);

  let desc: Omit<CafPcm, 'pcm' | 'frames'>;
  if (chosen) {
    if (chosen.source === 'compacted') {
      notes.push(descSize === 32
        ? "the container's description chunk is a non-standard 32 bytes; read as the compacted layout"
        : `the description chunk declares ${descSize} bytes, but only the compacted 32-byte layout reads coherently — the compacted read is used`);
    }
    if (anchorVouched) {
      notes.push("the stated layout fails the strict layout arithmetic; the sealed capture log's frame count vouches for this read");
    }
    const d = chosen.d;
    // 0.18.6: a CAF may leave mBitsPerChannel 0 ("use the slot width") —
    // derive it from bytesPerFrame when that divides cleanly, so the
    // decoder below keys off real numbers, never a zero.
    let bits = d.bitsPerChannel;
    if (bits === 0) {
      const perChannel = d.bytesPerFrame / d.channels;
      if (Number.isInteger(perChannel) && perChannel > 0) bits = perChannel * 8;
    }
    desc = {
      sampleRate,
      channels: d.channels,
      bitsPerChannel: bits,
      isFloat: (d.formatFlags & 1) !== 0,
      bigEndian: (d.formatFlags & 2) !== 0,
      isSigned: (d.formatFlags & 4) !== 0,
      alignedHigh: (d.formatFlags & 16) !== 0,
      nonInterleaved: (d.formatFlags & 32) !== 0,
      bytesPerFrame: d.bytesPerFrame,
    };
  } else if (candidates.length > 0 && !anchorFrames) {
    // No plausible interpretation and no anchor to arbitrate. Still return
    // the standard read — with the incoherence STATED — so the card can
    // describe the layout it cannot decode (the decoders below refuse it:
    // a slot narrower than the sample is a null reader, never garbage).
    const d = candidates[0].d;
    notes.push("the container's description is incoherent; the layout is stated but cannot be decoded");
    desc = {
      sampleRate,
      channels: Math.max(1, Math.min(64, d.channels)),
      bitsPerChannel: d.bitsPerChannel,
      isFloat: (d.formatFlags & 1) !== 0,
      bigEndian: (d.formatFlags & 2) !== 0,
      isSigned: (d.formatFlags & 4) !== 0,
      alignedHigh: (d.formatFlags & 16) !== 0,
      nonInterleaved: (d.formatFlags & 32) !== 0,
      bytesPerFrame: d.bytesPerFrame,
      incoherent: true,
    };
  } else if (anchorFrames !== null && expected?.sampleRate) {
    // Anchor-derived last resort: the container's description is
    // incoherent, but the sealed capture log commits the frame count and
    // rate — the stride is then arithmetic, not a guess.
    const frameBytes = pcm.length / anchorFrames;
    if (!Number.isInteger(frameBytes) || frameBytes < 1 || frameBytes > 8) return null;
    notes.push("the container's description is incoherent; the layout is derived from the sealed capture log");
    // 0.22.0 (field finding: every waveform bar pinned full-height on a
    // 20 s voice take): hardware-format CAF masters are FLOAT32, and this
    // branch used to force a signed-integer read — float bytes reinterpreted
    // as int32 are huge mid-band magnitudes, so every bar saturates under
    // any normalizer. Arbitrate on the BYTES, stated: float wins only when
    // the payload measures like float (≥99.9% of samples finite and within
    // ±1.0) AND measures pathological as int32 (≥50% of samples ≥2^29 —
    // quiet int32 fails the loudness test; loud int32 fails the float test,
    // since 0x40000000 reads as 2.0 and 0x7FFFFFFF as NaN).
    let isFloat = false;
    if (frameBytes === 4) {
      const probe = Math.min(4000, anchorFrames);
      let floatOkCount = 0;
      let intLoudCount = 0;
      for (let i = 0; i < probe; i++) {
        const f = view.getFloat32(i * 4, true);
        if (Number.isFinite(f) && Math.abs(f) <= 1) floatOkCount++;
        if (Math.abs(view.getInt32(i * 4, true)) >= 0x20000000) intLoudCount++;
      }
      if (floatOkCount / probe >= 0.999 && intLoudCount / probe >= 0.5) {
        isFloat = true;
        notes.push('the payload measures as 32-bit float (samples within ±1.0, implausible as integer); decoded float');
      }
    }
    desc = {
      sampleRate: expected.sampleRate,
      channels: 1,
      bitsPerChannel: frameBytes * 8,
      isFloat,
      bigEndian: false,
      isSigned: frameBytes > 1,
      alignedHigh: false,
      nonInterleaved: false,
      bytesPerFrame: frameBytes,
    };
  } else {
    return null;
  }

  // A repaired description's endian flag is suspect (the 0.18.6 master
  // declared big-endian on a little-endian payload). Audio is low-pass:
  // under the wrong byte order the sample-to-sample deltas explode. When
  // the description needed repair, measure both ways and take the smoother
  // — stated, never silent. Untouched for standard descriptions.
  if (notes.length > 0 && !desc.isFloat && desc.bitsPerChannel === 16 && desc.bytesPerFrame >= 2) {
    const probe = Math.min(4000, Math.floor(pcm.length / desc.bytesPerFrame));
    if (probe > 8) {
      let leScore = 0;
      let beScore = 0;
      for (let i = 1; i < probe; i++) {
        const a = i * desc.bytesPerFrame;
        const b = (i - 1) * desc.bytesPerFrame;
        leScore += Math.abs(view.getInt16(a, true) - view.getInt16(b, true));
        beScore += Math.abs(view.getInt16(a, false) - view.getInt16(b, false));
      }
      if (desc.bigEndian && leScore * 3 < beScore) {
        desc = { ...desc, bigEndian: false };
        notes.push('the description claims big-endian but the payload measures little-endian; decoded little-endian');
      }
    }
  }

  if (desc.bytesPerFrame === 0 || desc.sampleRate <= 0) return null;
  // Non-interleaved CAF stores channel blocks: bytesPerFrame is per-channel,
  // so the frame count divides by channels as well.
  const frameBytes = desc.nonInterleaved ? desc.bytesPerFrame * desc.channels : desc.bytesPerFrame;
  const frames = Math.floor(pcm.length / frameBytes);
  if (frames <= 0) return null;
  if (anchorFrames !== null && frames !== anchorFrames) {
    notes.push(`the container implies ${frames} frames but the sealed capture log says ${anchorFrames}`);
  }
  return { ...desc, pcm, frames, notes: notes.length > 0 ? notes : undefined };
}

/**
 * 0.18.6 field fix (the "export WAV doesn't work" report): ONE universal
 * LPCM sample reader, shared by the waveform and the WAV converter. The
 * old code derived the frame stride from bitsPerChannel × channels and
 * supported only four (float/depth) combos — the real AVAudioFile master
 * landed outside that matrix and BOTH paths silently failed (dotted
 * waveform, null WAV). Now the CONTAINER's own bytesPerFrame is the stride
 * (the only layout truth a CAF carries), and every LPCM sample encoding
 * decodes: int 8/16/24/32 (signed per flag, unsigned 8-bit by convention),
 * float32/64, both endians, interleaved or channel-blocked, packed or
 * high-aligned in a wider slot. Returns null only when the container is
 * incoherent (slot narrower than the sample, a depth we cannot name) —
 * the caller then states the layout instead of a generic failure.
 * A read outside the payload yields NaN: the waveform skips it, the WAV
 * converter treats it as a hard failure (a short file is a fact to state,
 * not a sample to invent).
 */
function makeSampleReader(caf: CafPcm): ((frame: number, ch: number) => number) | null {
  // A stated-but-undecodable description yields no samples (0.20.1): the
  // layout may look coherent, so refusal is explicit, not incidental.
  if (caf.incoherent) return null;
  const { pcm, channels, bitsPerChannel, isFloat, bigEndian, isSigned, alignedHigh, nonInterleaved, bytesPerFrame, frames } = caf;
  const bytesPerSample = bitsPerChannel / 8;
  if (!Number.isInteger(bytesPerSample)) return null;
  if (isFloat ? (bytesPerSample !== 4 && bytesPerSample !== 8)
              : (bytesPerSample < 1 || bytesPerSample > 4)) return null;
  // Slot = the byte width one channel occupies inside one frame.
  const slot = nonInterleaved ? bytesPerFrame : bytesPerFrame / channels;
  if (!Number.isInteger(slot) || slot < bytesPerSample) return null;
  // Padding when the slot is wider than the sample: "high-aligned" and
  // "big-endian" both name the NUMERIC high end, which is opposite byte
  // ends — the sample sits at the slot's far byte end exactly when the
  // two disagree (packed slots are the same width, so pad is 0 either way).
  const pad = alignedHigh !== bigEndian ? slot - bytesPerSample : 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // CoreAudio's LPCM convention when the signed flag is absent: 8-bit is
  // unsigned, wider ints are signed.
  const signed = isSigned || bytesPerSample > 1;
  const readInt24 = (off: number, le: boolean): number => {
    const b0 = pcm[off], b1 = pcm[off + 1], b2 = pcm[off + 2];
    let v = le ? (b0 | (b1 << 8) | (b2 << 16)) : ((b0 << 16) | (b1 << 8) | b2);
    if (v & 0x800000) v -= 0x1000000;
    return v / 8388608;
  };
  const readUint24 = (off: number, le: boolean): number => {
    const b0 = pcm[off], b1 = pcm[off + 1], b2 = pcm[off + 2];
    const v = le ? (b0 | (b1 << 8) | (b2 << 16)) : ((b0 << 16) | (b1 << 8) | b2);
    return (v - 8388608) / 8388608;
  };
  return (frame, ch) => {
    if (frame < 0 || frame >= frames || ch < 0 || ch >= channels) return NaN;
    const base = nonInterleaved
      ? ch * frames * slot + frame * slot + pad
      : frame * bytesPerFrame + ch * slot + pad;
    if (base + bytesPerSample > pcm.length) return NaN;
    if (isFloat) {
      return bytesPerSample === 4
        ? view.getFloat32(base, !bigEndian)
        : view.getFloat64(base, !bigEndian);
    }
    if (bytesPerSample === 1) {
      return signed ? (view.getInt8(base) / 128) : ((pcm[base] - 128) / 128);
    }
    if (bytesPerSample === 2) {
      return signed
        ? view.getInt16(base, !bigEndian) / 32768
        : (view.getUint16(base, !bigEndian) - 32768) / 32768;
    }
    if (bytesPerSample === 3) {
      return signed ? readInt24(base, !bigEndian) : readUint24(base, !bigEndian);
    }
    return signed
      ? view.getInt32(base, !bigEndian) / 2147483648
      : (view.getUint32(base, !bigEndian) - 2147483648) / 2147483648;
  };
}

/** The master's own description of itself — for stated failures and the
 *  meta line. Facts from the container, nothing inferred. */
export function describeCafLayout(caf: CafPcm): string {
  const kind = caf.isFloat ? 'float' : caf.isSigned || caf.bitsPerChannel > 8 ? 'signed integer' : 'unsigned integer';
  return `${caf.sampleRate} Hz · ${caf.channels} ch · ${caf.bitsPerChannel}-bit ${kind} · ${caf.bigEndian ? 'big' : 'little'}-endian${caf.nonInterleaved ? ' · non-interleaved' : ''}`;
}

/** Per-bar RMS amplitude (0..1) over channel 0 of the PCM. Null when the
 *  container's layout is incoherent — the card then says so instead of
 *  drawing a dotted zero band (0.18.6). Exported for tests.
 *  0.21.1 (field: an audio-mode take rendered "full band to band" next to
 *  a video take's normal waveform): the bar was the PEAK of its
 *  subsamples — one loud sample anywhere in the bucket pinned the bar, so
 *  sustained speech drew as a solid strip. RMS (energy) carries the
 *  take's actual dynamics; silence still reads as a hairline. */
export function waveformBars(caf: CafPcm, bars: number): number[] | null {
  const read = makeSampleReader(caf);
  if (!read) return null;
  const { frames } = caf;
  const out = new Array<number>(bars).fill(0);
  const framesPerBar = Math.max(1, Math.floor(frames / bars));
  // Bound the work: at most ~24 sample reads per bar, evenly spaced.
  const readsPerBar = Math.max(1, Math.min(24, Math.floor(framesPerBar / 4)));
  const stride = Math.max(1, Math.floor(framesPerBar / readsPerBar));
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * framesPerBar;
    let sumSq = 0;
    let n = 0;
    for (let r = 0; r < readsPerBar; r++) {
      const frame = start + r * stride;
      if (frame >= frames) break;
      const v = read(frame, 0);
      if (Number.isNaN(v)) continue;
      sumSq += v * v;
      n++;
    }
    out[bar] = n > 0 ? Math.min(1, Math.sqrt(sumSq / n)) : 0;
  }
  return out;
}

/**
 * WAV (PCM16) wrapper for the parsed CAF master (0.18.5 post-field — the
 * export Noah asked for). All channels, interleaved per the WAV contract.
 * Int payloads are
 * re-encoded little-endian; float payloads are scaled to int16. The export
 * is a FORMAT conversion of the committed master — the CAF and its hash
 * stay the sealed artifact; the WAV is for listening elsewhere, and the
 * card says exactly that.
 */
export function wavBytesFromCaf(caf: CafPcm): Uint8Array | null {
  const { channels, frames, sampleRate } = caf;
  if (frames <= 0 || channels <= 0) return null;
  // 0.18.6: the shared universal reader — every LPCM layout the container
  // can honestly describe converts; an incoherent container or a short
  // payload (NaN) fails the export, and the card states the layout.
  const read = makeSampleReader(caf);
  if (!read) return null;
  const out = new Int16Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    for (let ch = 0; ch < channels; ch++) {
      const v = read(f, ch);
      if (Number.isNaN(v)) return null;
      const clamped = Math.max(-1, Math.min(1, v));
      out[f * channels + ch] = Math.round(clamped * 32767);
    }
  }
  const dataBytes = out.length * 2;
  const wav = new Uint8Array(44 + dataBytes);
  const w = new DataView(wav.buffer);
  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) wav[offset + i] = s.charCodeAt(i);
  };
  writeAscii(0, 'RIFF');
  w.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  w.setUint32(16, 16, true); // fmt chunk size
  w.setUint16(20, 1, true); // PCM
  w.setUint16(22, channels, true);
  w.setUint32(24, Math.round(sampleRate), true);
  w.setUint32(28, Math.round(sampleRate) * channels * 2, true); // byte rate
  w.setUint16(32, channels * 2, true); // block align
  w.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  w.setUint32(40, dataBytes, true);
  new Int16Array(wav.buffer, 44).set(out);
  return wav;
}

type AudioState =
  | { state: 'reading' }
  | { state: 'done'; caf: CafPcm; bars: number[] | null; durationSec: number; sha256: string; sampleRate: number; frames: number }
  | { state: 'unavailable'; reason: string };

export function RawAudioCard({ kind, rawPcmPath, enfAnchor }: {
  kind: 'photo' | 'video' | 'audio';
  /** The sealed three-state raw-PCM path (record.context.captureEvidence). */
  rawPcmPath: EvidencePath | undefined;
  /** ENF anchor fields when the record carries them; omitted row otherwise. */
  enfAnchor?: EnfAnchor | null;
}) {
  const styles = useThemedStyles(buildStyles);
  const [audio, setAudio] = useState<AudioState>({ state: 'reading' });
  const [exportError, setExportError] = useState<string | null>(null);

  const recorded = typeof rawPcmPath === 'string' && rawPcmPath !== 'never-recorded';

  useEffect(() => {
    let cancelled = false;
    if (!recorded) return;
    setAudio({ state: 'reading' });
    (async () => {
      try {
        const bytes = await readFileBytes(toFileUri(rawPcmPath as string));
        // The sealed ENF anchor arbitrates between container
        // interpretations (0.18.6 — see parseCaf).
        const caf = parseCaf(bytes, enfAnchor
          ? { sampleRate: enfAnchor.sampleRate, sampleCount: enfAnchor.sampleCount }
          : undefined);
        if (!caf) throw new Error('not a readable LPCM CAF');
        setAudio({
          state: 'done',
          caf,
          bars: waveformBars(caf, BAR_COUNT),
          durationSec: caf.frames / caf.sampleRate,
          sha256: sha256Hex(caf.pcm),
          sampleRate: caf.sampleRate,
          frames: caf.frames,
        });
      } catch (e) {
        if (!cancelled) {
          setAudio({
            state: 'unavailable',
            reason: e instanceof Error && /LPCM CAF/.test(e.message)
              ? 'the file is not a readable LPCM CAF'
              : 'the file could not be read on this device',
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorded, rawPcmPath, enfAnchor]);

  // 0.18.5 post-field (Noah: "a way to export"): the committed master as a
  // standard PCM16 WAV via the OS share sheet. The CAF + its hash stay the
  // sealed artifact — the WAV is a format conversion for listening, and
  // the button says so.
  const exportWav = async () => {
    if (audio.state !== 'done') return;
    setExportError(null);
    try {
      // 0.18.6 (field: "the export wav button doesn't do anything" — every
      // failure was swallowed): each failure path surfaces a stated line.
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        setExportError('Sharing is not available on this device.');
        return;
      }
      const wav = wavBytesFromCaf(audio.caf);
      if (!wav) {
        // 0.18.6: self-describing — the master states its own layout, the
        // reader states what it cannot do with it. No guessing, no generic
        // "unsupported".
        setExportError(`This master is ${describeCafLayout(audio.caf)} — a layout the WAV converter does not support.`);
        return;
      }
      const path = `${FileSystem.cacheDirectory}raw-audio-${audio.sha256.slice(0, 12)}.wav`;
      await writeFileBytes(path, wav);
      await Sharing.shareAsync(path, { mimeType: 'audio/wav', dialogTitle: 'Export the sealed audio master (WAV conversion)' });
    } catch {
      setExportError('The WAV could not be written or shared on this device.');
    }
  };

  // The raw-audio sink does not apply to stills — the card hides entirely.
  if (kind === 'photo') return null;

  return (
    <ForensicCard
      title="Raw Audio"
      sub="The uncompressed audio sealed alongside this capture."
    >
      {rawPcmPath === null ? (
        <Text style={styles.line}>Enabled but failed at capture; the record commits the failure.</Text>
      ) : !recorded ? (
        <NotRecorded />
      ) : audio.state === 'reading' ? (
        <Text style={styles.line}>Reading the audio master…</Text>
      ) : audio.state === 'unavailable' ? (
        <Text style={styles.line}>{`Recorded at capture: ${audio.reason}.`}</Text>
      ) : (
        <View>
          {/* 0.18.6 (field: "a black box of tiny data — not
              interpretable"): peak-normalize the bars to the take's
              loudest bar — stated in the caption, never silent — on the
              perceptual √ scale, centered on the well's midline so the
              amplitude reads symmetrically. Silence still reads as a
              hairline; a quiet room no longer renders as 2 px nubs.
              A layout the decoder cannot read is STATED (never a dotted
              zero band — a drawn waveform must be real samples). */}
          {(() => {
            const bars = audio.bars;
            if (!bars) {
              return <Text style={styles.line}>{`The waveform cannot be drawn from this layout: ${describeCafLayout(audio.caf)}.`}</Text>;
            }
            const peak = bars.reduce((m, v) => (v > m ? v : m), 0);
            const norm = peak > 0 ? peak : 1;
            return (
              <View style={styles.waveRow}>
                {bars.map((v, i) => (
                  <View key={i} style={[styles.waveBar, { height: 1.5 + Math.sqrt(v / norm) * 60 }]} />
                ))}
                <View style={styles.waveCenter} pointerEvents="none" />
              </View>
            );
          })()}
          <Text style={styles.meta}>
            {`Duration ${audio.durationSec.toFixed(2)} s · ${audio.sampleRate} Hz · ${audio.frames} frames · ${describeCafLayout(audio.caf)}${audio.bars ? ' · rms per bar, peak-normalized to the loudest bar, perceptual (√) scale' : ''}`}
          </Text>
          {audio.caf.notes?.map((n, i) => (
            <Text key={i} style={styles.meta}>{`Note: ${n}.`}</Text>
          ))}
          <Pressable
            style={({ pressed }) => [styles.exportBtn, pressed && { opacity: 0.7 }]}
            onPress={() => {
              exportWav().catch(() => setExportError('The WAV could not be written or shared on this device.'));
            }}
            accessibilityLabel="Export the audio master as WAV"
          >
            <Text style={styles.exportBtnText}>Export as WAV</Text>
          </Pressable>
          {exportError ? <Text style={styles.exportError}>{exportError}</Text> : null}
          <Text style={styles.exportNote}>A PCM16 conversion of the sealed master, for listening elsewhere. The sealed bytes are the CAF above.</Text>
          <ForensicMono label="PCM SHA-256" value={audio.sha256} />
          {enfAnchor ? (
            <View style={styles.enfRow}>
              <Text style={styles.enfTitle}>Power-grid anchor</Text>
              <Text style={styles.meta}>
                {`First sample at ${new Date(enfAnchor.firstSampleWallClockUtcMs).toISOString()} · ${enfAnchor.sampleRate} Hz · ${enfAnchor.sampleCount} samples`}
              </Text>
            </View>
          ) : null}
        </View>
      )}
    </ForensicCard>
  );
}

const buildStyles = () => StyleSheet.create({
  line: { color: colors.text, fontSize: fontSize.sm, lineHeight: 19, marginTop: spacing.xs + 2 },
  waveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    height: 64,
    marginTop: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#101013',
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  waveBar: { flex: 1, borderRadius: 1, backgroundColor: '#E8E8EC', minHeight: 1.5 },
  waveCenter: {
    position: 'absolute',
    left: 6,
    right: 6,
    top: '50%',
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(232,232,236,0.35)',
  },
  exportError: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: 6 },
  exportBtn: {
    marginTop: spacing.sm,
    alignSelf: 'flex-start',
    backgroundColor: colors.text,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  exportBtnText: { color: colors.bg, fontSize: fontSize.xs, fontWeight: '700' },
  exportNote: { color: colors.textFaint, fontSize: 9.5, lineHeight: 14, marginTop: 6 },
  meta: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  enfRow: {
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  enfTitle: { color: colors.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.9, textTransform: 'uppercase' },
});
