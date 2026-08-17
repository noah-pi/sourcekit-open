// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * SignalsTab — Tier-1 analyzers as a first-class dashboard tab (was the
 * collapsed AdvancedSignals panel). Semantics are IDENTICAL to the donor:
 * each analyzer is its own measurement with its stated bounds and the
 * analyzer's own honesty note + limitations; nothing is fused; "insufficient"
 * is an honest result printed with its reason; the 30 s ENF minimum refuses
 * verbatim; nothing runs until the reviewer asks (sig.notrun / sig.run), and
 * any run can be cancelled.
 *
 * Changes vs the donor are host-shape only:
 *  - always-rendered tab with four rows visible up front (not-run states —
 *    nothing hidden, nothing spins unasked, ARCHITECTURE §5.2);
 *  - per-analyzer run buttons with a literal status line and a Cancel button
 *    (DESIGN §7);
 *  - completed rows cache on the item via onItemPatched (CachedSignalRow) so
 *    a re-opened tab shows the same numbers without re-decoding anything.
 */
import React, { useRef, useState } from 'react';
import { extractVideoMotion, type VideoMotionResult } from '../../core/videoMotion';
import { analyzeDisplayBeat } from '../../core/displayBeat';
import { analyzeRollingShutterSkew } from '../../core/rollingShutter';
import { analyzeOnsetAlignment, type MotionSample } from '../../core/avSync';
import { extractEnfTrace } from '../../core/enfExtract';
import { deskAnalyzer } from '../../core/analyzers';
import { isVideoBytes, videoMime } from '../../core/deskItem';
import type { DeskItem } from '../../core/deskItem';
import type { CachedSignalRow } from '../../contracts-ext';
import { SignalRow, TOOLTIPS } from './dashUi';

/* ------------------------------------------------------------------ */
/* Row builders — copied verbatim from AdvancedSignals (semantics kept) */
/* ------------------------------------------------------------------ */

const meanGray = (g: Float64Array): number => {
  let s = 0;
  for (let i = 0; i < g.length; i++) s += g[i];
  return g.length > 0 ? s / g.length : 0;
};

function registryNote(id: string): { version: string; measures: string } {
  const a = deskAnalyzer(id);
  return { version: a?.methodVersion ?? 'unknown', measures: a?.measures ?? '' };
}

function unavailableRow(id: string, title: string, reason: string): CachedSignalRow {
  const r = registryNote(id);
  return {
    id, title, version: r.version,
    measurement: `not performed — ${reason}`,
    bound: '—',
    note: r.measures,
    limitations: ['absence of a signal is not suspicion — nothing is implied by an analyzer that did not run'],
    computedAt: new Date().toISOString(),
  };
}

interface AudioTrack {
  sampleRateHz: number;
  samples: Float32Array;
}

/** Decode the container's audio track via Web Audio; null + reason on failure. */
async function decodeAudio(bytes: Uint8Array): Promise<{ audio: AudioTrack | null; reason: string | null }> {
  try {
    const AC: (typeof AudioContext) | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return { audio: null, reason: 'this browser exposes no Web Audio decoder' };
    const ctx = new AC();
    try {
      const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      const len = buf.length;
      const mono = new Float32Array(len);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += d[i] / buf.numberOfChannels;
      }
      return { audio: { sampleRateHz: buf.sampleRate, samples: mono }, reason: null };
    } finally {
      void ctx.close().catch(() => undefined);
    }
  } catch (e) {
    return { audio: null, reason: `the browser could not decode this container's audio (${e instanceof Error ? e.message : String(e)})` };
  }
}

function displayBeatRow(vm: VideoMotionResult): CachedSignalRow {
  const id = 'displaybeat';
  const r = registryNote(id);
  try {
    const series = vm.frames.map((f) => ({ tSec: f.tSec, luma: meanGray(f.gray) }));
    const span = series.length > 1 ? series[series.length - 1].tSec - series[0].tSec : 0;
    const fs = span > 0 ? (series.length - 1) / span : 0;
    if (fs <= 0) return unavailableRow(id, 'Display-beat', 'only one decodable frame — no series to measure');
    const ev = analyzeDisplayBeat(series, {
      sampleRateHz: fs,
      sourceNote: `video track decoded in this tab, mean luma of ~${fs.toFixed(2)} Hz frame samples (96px raster)`,
    });
    const assessable = ev.candidates.filter((c) => c.assessable);
    return {
      id, title: 'Display-beat', version: r.version,
      measurement:
        ev.status === 'measured' && ev.strongestBeat
          ? `strongest periodic luma component ${ev.strongestBeat.frequencyHz.toFixed(3)} Hz at ${ev.strongestBeat.snrDb.toFixed(1)} dB SNR — ${ev.strongestBeat.note}`
          : `insufficient — ${ev.insufficient || 'no periodic component measured'}`,
      bound: `sample rate ${fs.toFixed(2)} Hz over ${ev.durationSec.toFixed(1)} s; assessable display-family candidates: ${assessable.length > 0 ? assessable.map((c) => `${c.familyHz} Hz ×${c.harmonic} (SNR ${c.snrDb?.toFixed(1) ?? '?'} dB)`).join(', ') : 'none at this sample rate (DC-aliased candidates are marked NOT assessable)'}`,
      note: r.measures,
      limitations: ev.limitations,
      computedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ...unavailableRow(id, 'Display-beat', 'the analyzer threw — see below'), failed: true, measurement: `analyzer failed to run: ${e instanceof Error ? e.message : String(e)} — a Source Kit Desk bug to report, not a finding about this file` };
  }
}

function skewRow(vm: VideoMotionResult): CachedSignalRow {
  const id = 'rolling-shutter';
  const r = registryNote(id);
  try {
    const dts = vm.frames.slice(1).map((f, i) => f.tSec - vm.frames[i].tSec).filter((d) => d > 0).sort((a, b) => a - b);
    const frameIntervalSec = dts.length > 0 ? dts[Math.floor(dts.length / 2)] : undefined;
    const ev = analyzeRollingShutterSkew(vm.frames, {
      gyro: null,
      frameIntervalSec,
      sourceNote: 'video track decoded in this tab (~2.5 Hz sampling, 96px-wide raster); no gyro sidecar in the Source Kit Desk intake, so gyro consistency is not available',
    });
    return {
      id, title: 'Rolling-shutter skew', version: r.version,
      measurement:
        ev.status === 'measured' && ev.skewEstimate
          ? `median skew ${ev.skewEstimate.value.toExponential(2)} px/row across ${ev.pairsAnalyzed} frame pairs — ${ev.skewEstimate.note}`
          : `insufficient — ${ev.insufficient || 'no measurement'}`,
      bound: 'px/row at the analysis raster — absolute row-time needs intrinsics this analyzer never assumes; gyro consistency: not available (no sensor-log sidecar)',
      note: r.measures,
      limitations: ev.limitations,
      computedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ...unavailableRow(id, 'Rolling-shutter skew', 'the analyzer threw — see below'), failed: true, measurement: `analyzer failed to run: ${e instanceof Error ? e.message : String(e)} — a Source Kit Desk bug to report, not a finding about this file` };
  }
}

function avSyncRow(vm: VideoMotionResult | null, audio: AudioTrack | null, audioReason: string | null, epochMsAtStart: number): CachedSignalRow {
  const id = 'avsync';
  const r = registryNote(id);
  if (!vm) return unavailableRow(id, 'A/V onset alignment', 'video frames could not be decoded in this browser');
  try {
    const motion: MotionSample[] = vm.flow.map((f) => ({
      tSec: (f.tMs - epochMsAtStart) / 1000,
      magnitude: Math.hypot(f.motion.tx, f.motion.ty),
    }));
    const ev = analyzeOnsetAlignment(
      audio ? { sampleRateHz: audio.sampleRateHz, samples: audio.samples } : null,
      motion,
    );
    return {
      id, title: 'A/V onset alignment', version: r.version,
      measurement:
        ev.status === 'measured' && ev.offsetMs !== null
          ? `audio onsets ${ev.offsetMs >= 0 ? 'lag' : 'LEAD'} motion onsets by ${Math.abs(ev.offsetMs).toFixed(0)} ms (peak correlation ${ev.correlation!.toFixed(2)}; ${ev.audioOnsets} audio / ${ev.motionOnsets} motion onsets)` +
            (ev.strongestOnset ? `; strongest-onset pair ${ev.strongestOnset.offsetMs.toFixed(0)} ms` : '')
          : `insufficient — ${ev.insufficient || 'no measurement'}${!audio && audioReason ? ` (audio: ${audioReason})` : ''}`,
      bound: `lag searched ±${ev.lagRangeMs[1]} ms — beyond that an "alignment" is coincidence; peak correlation below 0.5 is reported as insufficient, never as zero offset`,
      note: r.measures,
      limitations: ev.limitations,
      computedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ...unavailableRow(id, 'A/V onset alignment', 'the analyzer threw — see below'), failed: true, measurement: `analyzer failed to run: ${e instanceof Error ? e.message : String(e)} — a Source Kit Desk bug to report, not a finding about this file` };
  }
}

/** The 30 s ENF minimum, verbatim (sig.enf.short) — never a partial number. */
const ENF_MIN_SEC = 30;
const ENF_SHORT = 'The clip is shorter than 30 s — ENF needs at least that much audio. Not run; stated, not hidden.';

function enfRow(audio: AudioTrack | null, audioReason: string | null): CachedSignalRow {
  const id = 'enf-extract';
  const r = registryNote(id);
  try {
    // The 30 s rule is enforced up front with the deck's own sentence; the
    // analyzer's internal refusal is the second, unchanged gate.
    if (audio && audio.sampleRateHz > 0 && audio.samples.length / audio.sampleRateHz < ENF_MIN_SEC) {
      return {
        id, title: 'ENF extract', version: r.version,
        measurement: `insufficient — ${ENF_SHORT}`,
        bound: 'extract-only at Tier 1: no reference matching, no timestamp claims; under 30 s of audio the report is insufficient with NO trace — never a partial number',
        note: r.measures,
        limitations: ['under 30 s of audio the trace is not extracted at all — never a partial number'],
        computedAt: new Date().toISOString(),
      };
    }
    const ev = extractEnfTrace(audio?.samples ?? null, audio?.sampleRateHz ?? 0, { mainsHz: null });
    return {
      id, title: 'ENF extract', version: r.version,
      measurement:
        ev.status === 'extracted' && ev.trace && ev.quality
          ? `${ev.quality.windowsUsable}/${ev.quality.windowsTotal} windows usable around nominal ${ev.nominalHz} Hz (${ev.nominalBasis}); mean hum SNR ${ev.quality.meanSnrDb.toFixed(1)} dB; trace stability σ ${ev.quality.hzStd.toFixed(3)} Hz` +
            (ev.bothFamilyMeanSnrDb ? `; both families evaluated (50 Hz ${ev.bothFamilyMeanSnrDb.at50Hz.toFixed(1)} dB, 60 Hz ${ev.bothFamilyMeanSnrDb.at60Hz.toFixed(1)} dB)` : '')
          : `insufficient — ${ev.insufficient || 'no extraction'}${!audio && audioReason ? ` (audio: ${audioReason})` : ''}`,
      bound: 'extract-only at Tier 1: no reference matching, no timestamp claims; under 30 s of audio the report is insufficient with NO trace — never a partial number',
      note: r.measures,
      limitations: ev.limitations,
      computedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { ...unavailableRow(id, 'ENF extract', 'the analyzer threw — see below'), failed: true, measurement: `analyzer failed to run: ${e instanceof Error ? e.message : String(e)} — a Source Kit Desk bug to report, not a finding about this file` };
  }
}

/* ------------------------------------------------------------------ */
/* The tab                                                              */
/* ------------------------------------------------------------------ */

/** Deck §10.6 analyzer ids/titles + what each run needs decoded. */
const ANALYZERS: readonly { id: string; title: string; needs: 'video' | 'audio' | 'both' }[] = [
  { id: 'displaybeat', title: 'Display-beat', needs: 'video' },
  { id: 'rolling-shutter', title: 'Rolling-shutter skew', needs: 'video' },
  { id: 'avsync', title: 'A/V onset alignment', needs: 'both' },
  { id: 'enf-extract', title: 'ENF extract', needs: 'audio' },
];

/** Still-photo rows: every advanced analyzer needs frames the photo doesn't carry. */
const PHOTO_REASONS: Record<string, string> = {
  displaybeat: 'a video-track analyzer — not applicable to a still',
  'rolling-shutter': 'a frame-series analyzer — not applicable to a still',
  avsync: 'an audio/video analyzer — not applicable to a still',
  'enf-extract': 'an audio analyzer — not applicable to a still',
};

/** §10.13: each analyzer row's ⓘ pair, by analyzer id (deck rows verbatim). */
const TIP_FOR: Record<string, (typeof TOOLTIPS)[keyof typeof TOOLTIPS] | undefined> = {
  displaybeat: TOOLTIPS.displaybeat,
  'rolling-shutter': TOOLTIPS.rollingShutter,
  avsync: TOOLTIPS.avsync,
  'enf-extract': TOOLTIPS.enfExtract,
};

export function SignalsTab(props: { item: DeskItem; onItemPatched?: (id: string, patch: (current: DeskItem) => DeskItem) => void }) {
  const { item, onItemPatched } = props;
  // Completed rows, seeded from the item's cache (patched back after runs).
  const [rows, setRows] = useState<Record<string, CachedSignalRow>>(() => {
    const seed: Record<string, CachedSignalRow> = {};
    for (const r of item.tier1Signals ?? []) seed[r.id] = r;
    return seed;
  });
  const [running, setRunning] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const generationRef = useRef(0);
  const videoRef = useRef<VideoMotionResult | null | undefined>(undefined);
  const audioRef = useRef<{ audio: AudioTrack | null; reason: string | null } | null>(null);

  if (item.kind !== 'media') {
    return (
      <div>
        <h2 className="dash-tab-title">Signals — measured in this tab</h2>
        <div className="card">
          <p className="dash-absence" style={{ margin: 0 }}>
            Not applicable — this item carries no media bytes to analyze.
          </p>
        </div>
      </div>
    );
  }

  const isVideo = item.bytes
    ? isVideoBytes(item.bytes)
    : Boolean(item.objectMime?.startsWith('video')) || item.report?.record?.asset?.kind === 'video';

  function commitRow(row: CachedSignalRow) {
    setRows((prev) => ({ ...prev, [row.id]: row }));
    // F1: merge against the CURRENT item inside App's setter — a stale
    // render closure can never drop a sibling analyzer's committed row.
    onItemPatched?.(item.id, (current) => ({
      ...current,
      tier1Signals: [...(current.tier1Signals ?? []).filter((r) => r.id !== row.id), row],
    }));
  }

  async function run(id: string) {
    if (!item.bytes || running) return;
    const spec = ANALYZERS.find((a) => a.id === id);
    if (!spec) return;
    const gen = ++generationRef.current;
    setRunning(id);
    try {
      const bytes = item.bytes;
      const epochMsAtStart = Date.parse(item.report?.record?.capturedAt ?? '') || 0;
      let vm: VideoMotionResult | null = null;
      let audio: AudioTrack | null = null;
      let audioReason: string | null = null;

      if (spec.needs === 'video' || spec.needs === 'both') {
        setStatusLine('Decoding video frames in this tab…');
        if (videoRef.current === undefined) {
          videoRef.current = item.videoMotion ?? (await extractVideoMotion(bytes, videoMime(bytes), epochMsAtStart));
        }
        vm = videoRef.current;
      }
      if (spec.needs === 'audio' || spec.needs === 'both') {
        setStatusLine('Decoding audio in this tab…');
        if (audioRef.current === null) audioRef.current = await decodeAudio(bytes);
        audio = audioRef.current.audio;
        audioReason = audioRef.current.reason;
      }
      setStatusLine('Measuring…');
      if (gen !== generationRef.current) return; // cancelled — results discarded

      const row =
        id === 'displaybeat'
          ? vm ? displayBeatRow(vm) : unavailableRow(id, spec.title, 'video frames could not be decoded in this browser')
          : id === 'rolling-shutter'
            ? vm ? skewRow(vm) : unavailableRow(id, spec.title, 'video frames could not be decoded in this browser')
            : id === 'avsync'
              ? avSyncRow(vm, audio, audioReason, epochMsAtStart)
              : enfRow(audio, audioReason);
      commitRow(row);
    } catch (e) {
      if (gen === generationRef.current) {
        commitRow({
          ...unavailableRow(id, spec.title, 'the run itself failed'),
          failed: true,
          measurement: `The analyzer run itself failed: ${e instanceof Error ? e.message : String(e)} — a Source Kit Desk bug to report, not a finding about this file.`,
        });
      }
    } finally {
      if (gen === generationRef.current) {
        setRunning(null);
        setStatusLine(null);
      }
    }
  }

  function cancel() {
    // Abandon: the in-flight decode may finish, but its results are
    // discarded and the row keeps its previous state. Stated, not faked.
    generationRef.current++;
    setRunning(null);
    setStatusLine(null);
  }

  return (
    <div>
      <h2 className="dash-tab-title">Signals — measured in this tab</h2>
      {/* sig.intro */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Deterministic measurements, computed here. Each stands alone with its own limits; none is a score,
        none combines into one. “Insufficient” is an honest result; absence of a signal is not suspicion.
      </p>

      {!isVideo && (
        <p className="honest-note">
          This is a still photo: the screen re-photography measurements on the Forensics tab are its
          applicable signal set. The analyzers below are listed with exactly why they do not apply.
        </p>
      )}
      {isVideo && !item.bytes && (
        <p className="honest-note">
          This item’s bytes are not held in the tab (large-file path, or a reference restored from a case
          file), and the frame/audio analyzers measure pixels and samples — so they cannot run here.
          Re-drop the original file, or run the full analyzer set with the CLI. Stated, not hidden.
        </p>
      )}

      {ANALYZERS.map((a) => {
        const row = rows[a.id] ?? null;
        const naReason = !isVideo ? PHOTO_REASONS[a.id] : !item.bytes ? 'this item’s bytes are not held in this tab' : null;
        return (
          <div key={a.id} className="card" id={`dash-card-signal-${a.id}`}>
            <h2>{a.title}</h2>
            {naReason ? (
              <SignalRow label={a.title} chip={{ tone: 'neutral', text: 'Not applicable' }} tip={TIP_FOR[a.id]}>
                Not applicable — {naReason}.
                <div className="field-note" style={{ marginTop: 2 }}>method {registryNote(a.id).version}</div>
              </SignalRow>
            ) : row ? (
              <>
                <SignalRow
                  label={a.title}
                  chip={
                    row.failed
                      ? { tone: 'warn', text: 'Could not run' }
                      : row.measurement.startsWith('insufficient')
                        ? { tone: 'neutral', text: 'Insufficient signal' }
                        : row.measurement.startsWith('not performed')
                          ? { tone: 'neutral', text: 'Not run' }
                          : { tone: 'info', text: 'Observed' }
                  }
                  tip={TIP_FOR[a.id]}
                >
                  {row.failed ? (
                    <div className="warn-box" style={{ margin: '0 0 6px' }}>{row.measurement}</div>
                  ) : (
                    <div>{row.measurement}</div>
                  )}
                  {row.bound !== '—' && <div className="field-note" style={{ marginTop: 2 }}>Bounds: {row.bound}</div>}
                  {row.note && <div className="honest-note" style={{ marginTop: 2 }}>{row.note}</div>}
                  <div className="field-note" style={{ marginTop: 2 }}>
                    method {row.version} · measured {row.computedAt}
                  </div>
                </SignalRow>
                {row.limitations.length > 0 && (
                  <details style={{ marginTop: 4 }}>
                    <summary className="field-note" style={{ cursor: 'pointer' }}>
                      Limitations ({row.limitations.length}) — stated by the analyzer itself
                    </summary>
                    <ul className="checks notdone" style={{ marginTop: 4 }}>
                      {row.limitations.map((l, i) => <li key={i}>{l}</li>)}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <SignalRow label={a.title} chip={{ tone: 'neutral', text: 'Not run' }} tip={TIP_FOR[a.id]}>
                Not run — nothing runs until you ask; the decode is real work and stays in this tab.
                <div className="field-note" style={{ marginTop: 2 }}>method {registryNote(a.id).version}</div>
              </SignalRow>
            )}

            {!naReason && (
              <div className="btn-row" style={{ marginTop: 10 }}>
                {running === a.id ? (
                  <>
                    <span className="honest-note" role="status" style={{ alignSelf: 'center' }}>
                      Running in this tab… {statusLine}
                    </span>
                    <span className="dash-progress" aria-hidden="true"><span className="dash-progress-fill" /></span>
                    <button className="btn secondary" onClick={cancel}>Cancel</button>
                  </>
                ) : (
                  <button className="btn secondary" disabled={running !== null} onClick={() => void run(a.id)}>
                    Run {a.title}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}

      <p className="honest-note">
        What is not wired here, stated plainly: the parallax flatness analyzer needs the capture’s sensor
        ring (JSONL) — a single dropped photo or video does not carry one. Its ring-dump input lives on
        the Forensics tab, and it also runs via the CLI on the evidence directory.
      </p>
    </div>
  );
}
