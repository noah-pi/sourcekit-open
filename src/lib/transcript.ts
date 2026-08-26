// Source Kit 0.1.0 — transcript export formats for signed audio
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Transcript export formats for signed audio. The transcript of record lives
 * in the com.verify.transcript C2PA assertion; these functions only reshape it
 * as plain text or SRT. Pure module, no React Native dependencies.
 */

export interface TranscriptSegmentLike {
  start: number;
  duration: number;
  text: string;
}

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rem = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(rem, 3)}`;
}

/** SubRip (.srt) — one cue per segment, times relative to recording start. */
export function transcriptToSrt(segments: TranscriptSegmentLike[]): string {
  return segments
    .map((seg, i) => {
      const end = seg.start + Math.max(seg.duration, 0.4); // zero-length cues are invalid
      return `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(end)}\n${seg.text.trim()}`;
    })
    .join('\n\n') + '\n';
}

/** Plain text — the formatted transcript with a provenance header. */
export function transcriptToTxt(text: string, capturedAt: string): string {
  return [
    `Signed audio · captured ${capturedAt}`,
    `Transcribed on-device (Apple Speech). Transcript is inside the signed file.`,
    '',
    text.trim(),
    '',
  ].join('\n');
}
