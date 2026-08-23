// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RawAudioCard — the raw LPCM audio master (CAF) that rode with the capture.
 * Hidden for still photos. For video and audio exhibits it reads the sealed
 * path, parses the CAF, and shows:
 *
 *   - a waveform from the PCM samples (≈200 peak bars),
 *   - duration in seconds (frames / sample rate, from the container),
 *   - SHA-256 of the PCM payload, recomputed on this device,
 *   - a "Power-grid anchor" row when the record carries ENF anchor fields,
 *     omitted when absent.
 *
 * Absence renders as "Not recorded"; a read or parse failure is stated and
 * stays neutral.
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

/** ENF anchor fields, when the record carries them. The row is otherwise
 *  omitted. */
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
  /** LPCM flag bit 2: signed integer. When absent, the CoreAudio convention
   *  applies: 8-bit unsigned, everything wider signed. */
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
 /** Anomalies the reader repaired or worked around, rendered in the meta
   *  line. */
  notes?: string[];
}

function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/** The desc fields the reader needs, at one interpretation's offsets. */
interface CafDescFields {
  formatFlags: number;
  bytesPerFrame: number;
  channels: number;
  bitsPerChannel: number;
}

/** An interpretation is plausible only when every field lands inside the
 *  LPCM envelope. A misread offset picks up the next chunk's bytes as a
 *  channel or bit count, so implausible fields mean try another
 *  interpretation. */
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
 * Minimal CAF reader: 'caff' header, then typed chunks with 64-bit BE sizes.
 * The 'desc' AudioStreamBasicDescription is read under up to three
 * interpretations, in trust order:
 *   1. standard 36-byte ASBD;
 *   2. compacted 32-byte description, where the mFramesPerPacket slot is
 *      absent and every later field sits 4 bytes early;
 *   3. anchor-derived, where the sealed capture log's frame count gives the
 *      stride (payload bytes / frames), used only on an incoherent desc.
 * With an ENF anchor present, the interpretation whose implied frame count
 * matches the anchor wins; a surviving mismatch is stated in the notes.
 * Returns null when nothing coherent emerges. Exported for the tests.
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
    // Sizes beyond 4 GiB cannot be addressed in a Uint8Array.
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
  if (descSize === 32 && descBody + 32 <= bytes.length) {
    candidates.push({
      source: 'compacted',
      d: {
        formatFlags,
        bytesPerFrame: readU32BE(bytes, descBody + 20),
        channels: readU32BE(bytes, descBody + 24),
        bitsPerChannel: readU32BE(bytes, descBody + 28),
      },
    });
  }

  const frameBytesOf = (d: CafDescFields): number =>
    (d.formatFlags & 32) !== 0 ? d.bytesPerFrame * d.channels : d.bytesPerFrame;
  const anchorFrames = expected && expected.sampleCount && expected.sampleCount > 0
    ? expected.sampleCount
    : null;
  const matchesAnchor = (d: CafDescFields): boolean =>
    anchorFrames !== null && frameBytesOf(d) > 0 && Math.floor(pcm.length / frameBytesOf(d)) === anchorFrames;

  let chosen = candidates.find(c => plausibleDesc(c.d, sampleRate) && matchesAnchor(c.d))
    ?? candidates.find(c => plausibleDesc(c.d, sampleRate))
    ?? null;

  let desc: Omit<CafPcm, 'pcm' | 'frames'>;
  if (chosen) {
    if (chosen.source === 'compacted') {
      notes.push("the container's description chunk is a non-standard 32 bytes; read as the compacted layout");
    }
    const d = chosen.d;
    // mBitsPerChannel 0 means "use the slot width"; derive it from
    // bytesPerFrame when that divides cleanly.
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
    // No plausible interpretation and no anchor to arbitrate. Return the
    // standard read with the incoherence noted, so the card can describe a
    // layout it cannot decode; the decoders below still refuse it.
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
    };
  } else if (anchorFrames !== null && expected?.sampleRate) {
    // Anchor-derived last resort: the sealed capture log commits the frame
    // count and rate, so the stride follows arithmetically.
    const frameBytes = pcm.length / anchorFrames;
    if (!Number.isInteger(frameBytes) || frameBytes < 1 || frameBytes > 8) return null;
    notes.push("the container's description is incoherent; the layout is derived from the sealed capture log");
    desc = {
      sampleRate: expected.sampleRate,
      channels: 1,
      bitsPerChannel: frameBytes * 8,
      isFloat: false,
      bigEndian: false,
      isSigned: frameBytes > 1,
      alignedHigh: false,
      nonInterleaved: false,
      bytesPerFrame: frameBytes,
    };
  } else {
    return null;
  }

  // A repaired description's endian flag is suspect. Audio is low-pass, so
  // the wrong byte order explodes sample-to-sample deltas: measure both ways
  // and take the smoother, noting it. Standard descriptions are untouched.
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
  // Non-interleaved CAF stores channel blocks, so bytesPerFrame is
  // per-channel and the frame count divides by channels as well.
  const frameBytes = desc.nonInterleaved ? desc.bytesPerFrame * desc.channels : desc.bytesPerFrame;
  const frames = Math.floor(pcm.length / frameBytes);
  if (frames <= 0) return null;
  if (anchorFrames !== null && frames !== anchorFrames) {
    notes.push(`the container implies ${frames} frames but the sealed capture log says ${anchorFrames}`);
  }
  return { ...desc, pcm, frames, notes: notes.length > 0 ? notes : undefined };
}

/**
 * The one LPCM sample reader, shared by the waveform and the WAV converter.
 * The container's own bytesPerFrame is the stride, and every LPCM encoding
 * decodes: int 8/16/24/32 (signed per flag, 8-bit unsigned by convention),
 * float32/64, both endians, interleaved or channel-blocked, packed or
 * high-aligned in a wider slot. Returns null when the container is
 * incoherent, e.g. a slot narrower than the sample or an unnamed depth.
 * A read outside the payload yields NaN: the waveform skips it, the WAV
 * converter fails the export.
 */
function makeSampleReader(caf: CafPcm): ((frame: number, ch: number) => number) | null {
  const { pcm, channels, bitsPerChannel, isFloat, bigEndian, isSigned, alignedHigh, nonInterleaved, bytesPerFrame, frames } = caf;
  const bytesPerSample = bitsPerChannel / 8;
  if (!Number.isInteger(bytesPerSample)) return null;
  if (isFloat ? (bytesPerSample !== 4 && bytesPerSample !== 8)
              : (bytesPerSample < 1 || bytesPerSample > 4)) return null;
  // Slot: the byte width one channel occupies inside one frame.
  const slot = nonInterleaved ? bytesPerFrame : bytesPerFrame / channels;
  if (!Number.isInteger(slot) || slot < bytesPerSample) return null;
  // Padding when the slot is wider than the sample. "high-aligned" and
  // "big-endian" both name the numeric high end, which is opposite byte
  // ends, so the sample sits at the slot's far byte end exactly when the two
  // flags disagree. Packed slots pad 0 either way.
  const pad = alignedHigh !== bigEndian ? slot - bytesPerSample : 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // CoreAudio's LPCM convention when the signed flag is absent: 8-bit
  // unsigned, wider ints signed.
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

/** The container's own layout description, for the meta line and stated
 *  failures. Nothing inferred. */
export function describeCafLayout(caf: CafPcm): string {
  const kind = caf.isFloat ? 'float' : caf.isSigned || caf.bitsPerChannel > 8 ? 'signed integer' : 'unsigned integer';
  return `${caf.sampleRate} Hz · ${caf.channels} ch · ${caf.bitsPerChannel}-bit ${kind} · ${caf.bigEndian ? 'big' : 'little'}-endian${caf.nonInterleaved ? ' · non-interleaved' : ''}`;
}

/** Per-bar peak amplitude (0..1) over channel 0 of the PCM. Null when the
 *  layout is incoherent, so the card states that instead of drawing a
 *  zero band. Exported for tests. */
export function waveformBars(caf: CafPcm, bars: number): number[] | null {
  const read = makeSampleReader(caf);
  if (!read) return null;
  const { frames } = caf;
  const out = new Array<number>(bars).fill(0);
  const framesPerBar = Math.max(1, Math.floor(frames / bars));
  // At most ~24 sample reads per bar, evenly spaced.
  const readsPerBar = Math.max(1, Math.min(24, Math.floor(framesPerBar / 4)));
  const stride = Math.max(1, Math.floor(framesPerBar / readsPerBar));
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * framesPerBar;
    let peak = 0;
    for (let r = 0; r < readsPerBar; r++) {
      const frame = start + r * stride;
      if (frame >= frames) break;
      const v = read(frame, 0);
      if (Number.isNaN(v)) continue;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    out[bar] = Math.min(1, peak);
  }
  return out;
}

/**
 * WAV (PCM16) wrapper for the parsed CAF master. All channels, interleaved
 * per the WAV contract; int payloads re-encoded little-endian, float
 * payloads scaled to int16. A format conversion only: the CAF and its hash
 * stay the sealed artifact.
 */
export function wavBytesFromCaf(caf: CafPcm): Uint8Array | null {
  const { channels, frames, sampleRate } = caf;
  if (frames <= 0 || channels <= 0) return null;
  // An incoherent container or a short payload (NaN) fails the export, and
  // the card states the layout.
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
  /** Sealed three-state raw-PCM path (record.context.captureEvidence). */
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
        // interpretations (see parseCaf).
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

  // Exports the committed master as a PCM16 WAV through the OS share sheet.
  // The CAF and its hash remain the sealed artifact.
  const exportWav = async () => {
    if (audio.state !== 'done') return;
    setExportError(null);
    try {
      // Every failure path below surfaces a line in exportError.
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        setExportError('Sharing is not available on this device.');
        return;
      }
      const wav = wavBytesFromCaf(audio.caf);
      if (!wav) {
        // Name the master's actual layout rather than a generic
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

  // The raw-audio sink does not apply to stills; the card hides entirely.
  if (kind === 'photo') return null;

  return (
    <ForensicCard
      title="Raw Audio"
      sub="The uncompressed audio master sealed with this capture."
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
          {/* Bars are peak-normalized to the take's loudest bar on a
              perceptual √ scale, centered on the well's midline, with the
              normalization noted in the caption. Silence reads as a
              hairline. A layout the decoder cannot read is stated rather
              than drawn as a zero band. */}
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
            {`Duration ${audio.durationSec.toFixed(2)} s · ${audio.sampleRate} Hz · ${audio.frames} frames · ${describeCafLayout(audio.caf)}${audio.bars ? ' · peak-normalized to the loudest bar, perceptual (√) scale' : ''}`}
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
