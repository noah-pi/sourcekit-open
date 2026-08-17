// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RawAudioCard — the raw LPCM audio master (CAF) that rode with the
 * capture.
 *
 * Hidden entirely for still photos (the sink does not apply). For
 * video/audio exhibits it reads the sealed path from the record, parses
 * the CAF container itself, and shows:
 *
 *   - a waveform drawn from the actual PCM samples (≈200 peak bars),
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
import { View, Text, StyleSheet } from 'react-native';

import { colors, spacing, fontSize, useThemedStyles } from '../../theme';
import type { EvidencePath } from '../../provenance/manifest';
import { readFileBytes } from '../../lib/fileHash';
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
  /** LPCM flag bit 5: channel-blocked layout (each channel contiguous),
   *  as AVAudioEngine input formats commonly are. */
  nonInterleaved: boolean;
  bytesPerFrame: number;
  /** The audio payload bytes (after the data chunk's edit count). */
  pcm: Uint8Array;
  frames: number;
}

function readU32BE(b: Uint8Array, off: number): number {
  return ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) >>> 0;
}

/**
 * Minimal CAF reader: 'caff' header, then typed chunks with 64-bit BE
 * sizes. Only what the waveform needs — the 'desc' AudioStreamBasicDescription
 * and the 'data' payload. Returns null on anything unexpected (the caller
 * renders the neutral failure state). Exported for the logic tests.
 */
export function parseCaf(bytes: Uint8Array): CafPcm | null {
  if (bytes.length < 12) return null;
  if (bytes[0] !== 0x63 || bytes[1] !== 0x61 || bytes[2] !== 0x66 || bytes[3] !== 0x66) return null; // 'caff'
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let desc: Omit<CafPcm, 'pcm' | 'frames'> | null = null;
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
    if (t0 === 0x64 && t1 === 0x65 && t2 === 0x73 && t3 === 0x63 && body + 36 <= bytes.length) {
      // 'desc' — AudioStreamBasicDescription.
      const sampleRate = view.getFloat64(body, false);
      const formatID = readU32BE(bytes, body + 8);
      const formatFlags = readU32BE(bytes, body + 12);
      const bytesPerFrame = readU32BE(bytes, body + 24);
      const channels = readU32BE(bytes, body + 28);
      const bitsPerChannel = readU32BE(bytes, body + 32);
      // 'lpcm' only; flags: bit0 float, bit1 big-endian (bit2 signed int),
      // bit5 non-interleaved.
      if (formatID !== 0x6c70636d || bytesPerFrame === 0 || channels === 0) return null;
      desc = {
        sampleRate,
        channels,
        bitsPerChannel,
        isFloat: (formatFlags & 1) !== 0,
        bigEndian: (formatFlags & 2) !== 0,
        nonInterleaved: (formatFlags & 32) !== 0,
        bytesPerFrame,
      };
    } else if (t0 === 0x64 && t1 === 0x61 && t2 === 0x74 && t3 === 0x61) {
      // 'data' — 4-byte edit count, then the audio payload.
      const start = body + 4;
      const end = Math.min(bytes.length, body + size);
      if (end > start) pcm = bytes.subarray(start, end);
    }
    if (size <= 0) break;
    off = body + size;
  }
  if (!desc || !pcm) return null;
  if (desc.bytesPerFrame === 0 || desc.sampleRate <= 0) return null;
  // Non-interleaved CAF stores channel blocks: bytesPerFrame is per-channel,
  // so the frame count divides by channels as well.
  const frameBytes = desc.nonInterleaved ? desc.bytesPerFrame * desc.channels : desc.bytesPerFrame;
  const frames = Math.floor(pcm.length / frameBytes);
  if (frames <= 0) return null;
  return { ...desc, pcm, frames };
}

/** Per-bar peak amplitude (0..1) over channel 0 of the PCM. Exported for tests. */
export function waveformBars(caf: CafPcm, bars: number): number[] {
  const { pcm, channels, bitsPerChannel, isFloat, bigEndian, frames } = caf;
  const bytesPerSample = bitsPerChannel / 8;
  // Interleaved: a frame holds every channel. Non-interleaved: channel 0 is
  // the first contiguous block of frames × bytesPerSample.
  const bytesPerFrame = caf.nonInterleaved ? bytesPerSample : bytesPerSample * channels;
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const out = new Array<number>(bars).fill(0);
  const framesPerBar = Math.max(1, Math.floor(frames / bars));
  // Bound the work: at most ~24 sample reads per bar, evenly spaced.
  const readsPerBar = Math.max(1, Math.min(24, Math.floor(framesPerBar / 4)));
  const stride = Math.max(1, Math.floor(framesPerBar / readsPerBar));
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * framesPerBar;
    let peak = 0;
    for (let r = 0; r < readsPerBar; r++) {
      const frame = start + r * stride;
      if (frame >= frames) break;
      const off = frame * bytesPerFrame;
      if (off + bytesPerSample > pcm.length) break;
      let v = 0;
      if (isFloat && bytesPerSample === 4) {
        v = view.getFloat32(off, !bigEndian);
      } else if (!isFloat && bytesPerSample === 2) {
        v = view.getInt16(off, !bigEndian) / 32768;
      } else if (!isFloat && bytesPerSample === 4) {
        v = view.getInt32(off, !bigEndian) / 2147483648;
      } else if (!isFloat && bytesPerSample === 1) {
        v = (pcm[off] - 128) / 128;
      } else {
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    out[bar] = Math.min(1, peak);
  }
  return out;
}

type AudioState =
  | { state: 'reading' }
  | { state: 'done'; bars: number[]; durationSec: number; sha256: string; sampleRate: number; frames: number }
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

  const recorded = typeof rawPcmPath === 'string' && rawPcmPath !== 'never-recorded';

  useEffect(() => {
    let cancelled = false;
    if (!recorded) return;
    setAudio({ state: 'reading' });
    (async () => {
      try {
        const bytes = await readFileBytes(toFileUri(rawPcmPath as string));
        const caf = parseCaf(bytes);
        if (!caf) throw new Error('not a readable LPCM CAF');
        setAudio({
          state: 'done',
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
  }, [recorded, rawPcmPath]);

  // The raw-audio sink does not apply to stills — the card hides entirely.
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
          <View style={styles.waveRow}>
            {audio.bars.map((v, i) => (
              <View key={i} style={[styles.waveBar, { height: 2 + v * 34 }]} />
            ))}
          </View>
          <Text style={styles.meta}>
            {`Duration ${audio.durationSec.toFixed(2)} s · ${audio.sampleRate} Hz · ${audio.frames} frames`}
          </Text>
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
    height: 40,
    marginTop: spacing.sm,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: '#101013',
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  waveBar: { flex: 1, borderRadius: 1, backgroundColor: '#A9A9B2', minHeight: 2 },
  meta: { color: colors.textDim, fontSize: fontSize.xs, lineHeight: 17, marginTop: spacing.sm },
  enfRow: {
    marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  enfTitle: { color: colors.textFaint, fontSize: 10.5, fontWeight: '800', letterSpacing: 1.9, textTransform: 'uppercase' },
});
