/**
 * ForensicsTab — the Tier-2 ad-hoc tool suite (ARCHITECTURE §5.3, DESIGN
 * §10.7 copy verbatim). Every tool is a card with: its ⓘ "can show /
 * cannot show" pair (§10.13), an N/A state WITH A REASON (L3), a run
 * button (nothing runs unasked), literal progress + Cancel (DESIGN §7),
 * and results that cache on the item via onItemPatched so a re-opened tab
 * shows the same numbers without recomputing.
 *
 * The tools: clone detection (with the quantized "what the matcher saw"
 * debug view), noise analysis (abstains honestly), Error Level Analysis
 * (JPEG-gated; the fx.ela.caveat warn-box is NON-DISMISSIBLE and rendered
 * above the run button — L-fixed disclaimer), the magnifier / level sweep
 * / luminance gradient viewing aids (labeled as aids — they claim
 * nothing), parallax flatness measurement (external ring-dump input), and
 * the screen re-photography signals (measured at intake, re-hosted here).
 *
 * W4 deviation DECISION (ARCHITECTURE §4 vs W2 reality): the Tier-0 byte
 * reads (metadata / strings / JPEG structure / embedded thumbnail) STAY on
 * the Overview tab — the Assistant's deep-links point there (W3, frozen),
 * and moving them would break those bases. This tab carries a standing
 * cross-link card instead. The rephoto signals move here per §5.3.
 */
import React, { useEffect, useRef, useState } from 'react';
import type { DeskItem } from '../../core/deskItem';
import { isVideoBytes } from '../../core/deskItem';
import type { BasisRef, Tier2FxCache } from '../../contracts-ext';
import {
  analyzeNoise,
  applyMagnifierMode,
  CLONE_DEFAULTS,
  detectClones,
  elaDiff,
  elaGateForBytes,
  FxCancelled,
  levelSweep,
  luminanceGradient,
  MAGNIFIER_MODES,
  NOISE_DEFAULTS,
  reencodeJpeg,
  type FxRaster,
  type MagnifierMode,
} from '../../core/imageFx';
import {
  analyzeParallaxBurst,
  grayPlaneFromRgba,
  parseSensorLogJsonl,
} from '../../core/parallax';
import { deskAnalyzer } from '../../core/analyzers';
import { SignalRow, TOOLTIPS } from './dashUi';

/* ------------------------------------------------------------------ */
/* Shared plumbing                                                     */
/* ------------------------------------------------------------------ */

/**
 * Decode the item's still-image bytes to an RGBA raster (browser only),
 * capped at 2048px longest side — the draw-time downscale is native, and
 * every tool reports the exact analysis raster it then worked on.
 */
const DECODE_CAP_PX = 2048;

async function decodeItemRaster(item: DeskItem): Promise<FxRaster> {
  if (!item.bytes) throw new Error('this item’s bytes are not held in this tab');
  const mime = item.bytes[0] === 0xff ? 'image/jpeg' : item.bytes[0] === 0x89 ? 'image/png' : null;
  if (!mime) throw new Error('not a JPEG/PNG still image');
  const bmp = await createImageBitmap(new Blob([item.bytes.slice().buffer as ArrayBuffer], { type: mime }));
  const scale = Math.min(1, DECODE_CAP_PX / Math.max(bmp.width, bmp.height));
  const w = Math.max(8, Math.round(bmp.width * scale));
  const h = Math.max(8, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    bmp.close();
    throw new Error('this browser gave no 2D canvas — the decode could not run');
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  return { width: w, height: h, rgba: ctx.getImageData(0, 0, w, h).data };
}

/** One FxRaster drawn to a canvas element. */
function RasterCanvas({ raster, label }: { raster: FxRaster; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = raster.width;
    c.height = raster.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(raster.rgba), raster.width, raster.height), 0, 0);
  }, [raster]);
  return <canvas ref={ref} className="fx-canvas" role="img" aria-label={label} />;
}

/** Run/cancel plumbing for one tool (generation guard + AbortSignal). */
function useRun() {
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const genRef = useRef(0);
  // Synchronous re-entrancy guard (F3): a double-click fires run() twice
  // before any state update lands, and genRef alone cannot stop the second
  // invocation from starting a parallel analysis. busyRef can.
  const busyRef = useRef(false);

  async function run<T>(
    fn: (signal: AbortSignal, progress: (stage: string, fraction: number) => void) => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; cancelled: boolean; error?: string }> {
    if (busyRef.current) return { ok: false, cancelled: true }; // a second run while running is a no-op
    busyRef.current = true;
    const gen = ++genRef.current;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRunning(true);
    setStatus(null);
    try {
      const value = await fn(ctrl.signal, (stage) => {
        if (genRef.current === gen) setStatus(stage);
      });
      return { ok: true, value };
    } catch (e) {
      if (e instanceof FxCancelled) return { ok: false, cancelled: true };
      return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      busyRef.current = false;
      if (genRef.current === gen) {
        setRunning(false);
        setStatus(null);
      }
    }
  }

  function cancel() {
    // The in-flight work aborts at its next yield point; partial work is
    // discarded, the row keeps its previous state. Stated, not faked.
    genRef.current++;
    ctrlRef.current?.abort();
    setRunning(false);
    setStatus(null);
  }

  return { running, status, run, cancel };
}

function methodVersion(id: string): string {
  return deskAnalyzer(id)?.methodVersion ?? 'unknown';
}

/** The run-button row shared by every ad-hoc tool. */
function RunRow(props: {
  label: string;
  running: boolean;
  status: string | null;
  disabled?: boolean;
  onRun: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="btn-row" style={{ marginTop: 10 }}>
      {props.running ? (
        <>
          <span className="honest-note" role="status" style={{ alignSelf: 'center' }}>
            Running in this tab… {props.status}
          </span>
          {/* §7: indeterminate progress while a run is in flight. */}
          <span className="dash-progress" aria-hidden="true"><span className="dash-progress-fill" /></span>
          <button className="btn secondary" onClick={props.onCancel}>Cancel</button>
        </>
      ) : (
        <button className="btn secondary" disabled={props.disabled} onClick={props.onRun}>{props.label}</button>
      )}
    </div>
  );
}

/** N/A row with a mandatory reason (L3) — the same shape on every tool. */
function NaRow({ label, reason, tip }: { label: string; reason: string; tip?: { can: string; cannot: string } }) {
  return (
    <SignalRow label={label} chip={{ tone: 'neutral', text: 'Not applicable' }} tip={tip}>
      Not applicable — {reason}
    </SignalRow>
  );
}

/* ------------------------------------------------------------------ */
/* Clone detection (fx.clone.*)                                        */
/* ------------------------------------------------------------------ */

function CloneCard(props: {
  item: DeskItem;
  naReason: string | null;
  getRaster: () => Promise<FxRaster>;
  patch: (p: Partial<Tier2FxCache>) => void;
}) {
  const { item, naReason, getRaster, patch } = props;
  const cached = item.tier2Fx?.clone ?? null;
  const [blockSize, setBlockSize] = useState(CLONE_DEFAULTS.blockSize);
  const [similarity, setSimilarity] = useState(CLONE_DEFAULTS.quantLevels);
  const [detail, setDetail] = useState(CLONE_DEFAULTS.minDetail);
  const { running, status, run, cancel } = useRun();
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setError(null);
    const out = await run(async (signal, progress) => {
      const raster = await getRaster();
      return detectClones(
        raster,
        { blockSize, quantLevels: similarity, minDetail: detail },
        signal,
        (p) => progress(p.stage, p.fraction),
      );
    });
    if (out.ok) patch({ clone: out.value });
    else if (!out.cancelled) setError(out.error ?? 'the run failed');
  }

  return (
    <div className="card" id="dash-card-fx-clone">
      <h2>Clone detection</h2>
      {/* fx.clone.sizecap — the cap is stated, and enforced in imageFx. */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Runs on a downscaled copy (max {CLONE_DEFAULTS.maxSizePx} px) — cost grows with the square of
        size. The debug view shows exactly what the matcher saw.
      </p>
      {naReason ? (
        <NaRow label="Clone detection" reason={naReason} tip={TOOLTIPS.cloneDetection} />
      ) : (
        <>
          {!cached && !error && (
            <SignalRow label="Clone detection" chip={{ tone: 'neutral', text: 'Not run' }} tip={TOOLTIPS.cloneDetection}>
              Not run — nothing runs until you ask. Method {methodVersion('clone-detection')}.
            </SignalRow>
          )}
          {error && (
            <SignalRow label="Clone detection" chip={{ tone: 'warn', text: 'Could not run' }} tip={TOOLTIPS.cloneDetection}>
              The run itself failed: {error} — a Source Kit Desk bug to report, not a finding about this file.
            </SignalRow>
          )}
          {cached?.state === 'insufficient' && (
            <SignalRow label="Clone detection" chip={{ tone: 'neutral', text: 'Insufficient signal' }} tip={TOOLTIPS.cloneDetection}>
              {cached.reason}
            </SignalRow>
          )}
          {cached?.state === 'measured' && (
            <>
              <SignalRow
                label="Duplicated regions"
                chip={{ tone: 'info', text: 'Observed' }}
                tip={TOOLTIPS.cloneDetection}
              >
                {cached.clusters.length === 0 ? (
                  /* fx.clone.result.none — verbatim; a negative is not proof. */
                  <>No duplicated regions found at these settings. That is not proof none exist — settings and resizing hide things.</>
                ) : (
                  <>
                    {cached.matchedBlocks} block positions in {cached.clusters.length} shared-offset
                    cluster{cached.clusters.length === 1 ? '' : 's'} at these settings.
                  </>
                )}
                <div className="field-note" style={{ marginTop: 2 }}>
                  {cached.blocksConsidered} blocks considered · {cached.blocksFilteredLowDetail} filtered
                  as low-detail (flat blocks clone legitimately) · {cached.candidatePairs} candidate pairs
                  beyond {cached.params.minDistancePx}px apart
                </div>
                {cached.pairsTruncated > 0 && (
                  /* The safety cap fired — stated, never hidden: a truncated
                     match can miss clones and must not read as a clean sweep. */
                  <div className="field-note" style={{ marginTop: 2 }}>
                    Matching was truncated — {cached.pairsTruncated.toLocaleString('en-US')} candidate
                    pairs skipped by the safety cap. Re-run with a smaller block or higher detail floor
                    for full coverage.
                  </div>
                )}
                {cached.clusters.length > 0 && (
                  <div className="field-note" style={{ marginTop: 2 }}>
                    Offsets: {cached.clusters.slice(0, 5).map((c) => `(${c.dx}, ${c.dy}) ×${c.pairs}`).join(' · ')}
                    {cached.clusters.length > 5 ? ` · +${cached.clusters.length - 5} more` : ''}
                  </div>
                )}
                <div className="field-note" style={{ marginTop: 2 }}>
                  Analyzed at {cached.analyzedWidth}×{cached.analyzedHeight} (cap {cached.params.maxSizePx}px
                  longest side) · block {cached.params.blockSize}px · min cluster {cached.params.minClusterSize} ·
                  method {cached.methodVersion} · measured in this tab {cached.computedAt}
                </div>
              </SignalRow>
              <div className="fx-canvas-grid">
                <figure>
                  <RasterCanvas raster={cached.overlay} label="Clone-detection overlay: matched blocks tinted, shared offsets linked" />
                  <figcaption className="field-note">
                    Overlay — tinted blocks duplicate each other at these settings; lines link a few
                    pairs per shared offset. Informational marks, not a verdict.
                  </figcaption>
                </figure>
                <figure>
                  <RasterCanvas raster={cached.debugView} label="Quantized debug view: what the matcher saw" />
                  <figcaption className="field-note">
                    What the matcher saw — every considered block rebuilt from its quantized Haar key.
                    If this view does not look like the picture, the matches above rest on little.
                  </figcaption>
                </figure>
              </div>
            </>
          )}
          <div className="fx-tool-params">
            <label>
              Block size
              <select value={blockSize} onChange={(e) => setBlockSize(Number(e.target.value))} disabled={running}>
                <option value={8}>8 px</option>
                <option value={16}>16 px</option>
                <option value={32}>32 px</option>
              </select>
            </label>
            <label>
              Similarity
              <select value={similarity} onChange={(e) => setSimilarity(Number(e.target.value))} disabled={running}>
                <option value={2}>fuzzy</option>
                <option value={4}>standard</option>
                <option value={8}>sharp</option>
              </select>
            </label>
            <label>
              Detail floor
              <select value={detail} onChange={(e) => setDetail(Number(e.target.value))} disabled={running}>
                <option value={1}>low (keep more blocks)</option>
                <option value={2.5}>standard</option>
                <option value={6}>high (strict)</option>
              </select>
            </label>
          </div>
          <RunRow label="Run clone detection" running={running} status={status} onRun={() => void onRun()} onCancel={cancel} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Noise analysis (fx.noise.*)                                         */
/* ------------------------------------------------------------------ */

function NoiseCard(props: {
  item: DeskItem;
  naReason: string | null;
  getRaster: () => Promise<FxRaster>;
  patch: (p: Partial<Tier2FxCache>) => void;
}) {
  const { item, naReason, getRaster, patch } = props;
  const cached = item.tier2Fx?.noise ?? null;
  const [amplitude, setAmplitude] = useState(NOISE_DEFAULTS.amplitude);
  const { running, status, run, cancel } = useRun();
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setError(null);
    const out = await run(async (signal, progress) => {
      const raster = await getRaster();
      return analyzeNoise(raster, { amplitude }, signal, (p) => progress(p.stage, p.fraction));
    });
    if (out.ok) patch({ noise: out.value });
    else if (!out.cancelled) setError(out.error ?? 'the run failed');
  }

  return (
    <div className="card" id="dash-card-fx-noise">
      <h2>Noise analysis</h2>
      {/* fx.noise.note — verbatim. */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Surfaces noise-pattern differences ELA and clone detection miss — leads for your eyes, never
        findings. Works best on high-quality images; on small or heavily compressed files it abstains
        rather than guesses.
      </p>
      {naReason ? (
        <NaRow label="Noise analysis" reason={naReason} tip={TOOLTIPS.noiseEstimation} />
      ) : (
        <>
          {!cached && !error && (
            <SignalRow label="Noise analysis" chip={{ tone: 'neutral', text: 'Not run' }} tip={TOOLTIPS.noiseEstimation}>
              Not run — nothing runs until you ask. Method {methodVersion('noise-analysis')}.
            </SignalRow>
          )}
          {error && (
            <SignalRow label="Noise analysis" chip={{ tone: 'warn', text: 'Could not run' }} tip={TOOLTIPS.noiseEstimation}>
              The run itself failed: {error} — a Source Kit Desk bug to report, not a finding about this file.
            </SignalRow>
          )}
          {cached?.state === 'insufficient' && (
            <SignalRow label="Noise analysis" chip={{ tone: 'neutral', text: 'Insufficient signal' }} tip={TOOLTIPS.noiseEstimation}>
              {cached.reason}
              <div className="field-note" style={{ marginTop: 2 }}>
                analyzed at {cached.analyzedWidth}×{cached.analyzedHeight} · method {cached.methodVersion}
              </div>
            </SignalRow>
          )}
          {cached?.state === 'measured' && (
            <>
              <SignalRow label="Median residual" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.noiseEstimation}>
                mean {cached.meanAbsResidual.toFixed(2)} of 255 · p95 {cached.p95AbsResidual.toFixed(2)} ·
                stretched ×{cached.amplitude} for display
                <div className="field-note" style={{ marginTop: 2 }}>
                  Analyzed at {cached.analyzedWidth}×{cached.analyzedHeight} · separable median radius {cached.radius} ·
                  luma σ {cached.lumaStd.toFixed(1)} · method {cached.methodVersion} · measured in this tab {cached.computedAt}
                </div>
                <div className="honest-note" style={{ marginTop: 2 }}>
                  A patchwork of different noise levels is a lead for your eyes — resaving, resizing,
                  and honest recompression also change noise. It claims nothing by itself.
                </div>
              </SignalRow>
              <div className="fx-canvas-grid one">
                <figure>
                  <RasterCanvas raster={cached.image} label="Noise residual, amplitude-stretched" />
                  <figcaption className="field-note">
                    The residual the median filter removed, stretched ×{cached.amplitude}. Uniform
                    texture is ordinary; oddly smooth or oddly noisy patches are leads, not findings.
                  </figcaption>
                </figure>
              </div>
            </>
          )}
          <div className="fx-tool-params">
            <label>
              Display stretch
              <select value={amplitude} onChange={(e) => setAmplitude(Number(e.target.value))} disabled={running}>
                <option value={4}>×4</option>
                <option value={8}>×8</option>
                <option value={16}>×16</option>
              </select>
            </label>
          </div>
          <RunRow label="Run noise analysis" running={running} status={status} onRun={() => void onRun()} onCancel={cancel} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Error Level Analysis (fx.ela.*) — gated, caveat non-dismissible      */
/* ------------------------------------------------------------------ */

function ElaCard(props: {
  item: DeskItem;
  naReason: string | null;
  getRaster: () => Promise<FxRaster>;
  patch: (p: Partial<Tier2FxCache>) => void;
}) {
  const { item, naReason, getRaster, patch } = props;
  const cached = item.tier2Fx?.ela ?? null;
  // Default re-save quality: the file's own quantization tables are the best
  // first guess (the compression recipe the last JPEG saver used); 0.90
  // otherwise. Labeled as an estimate wherever it is used.
  const intakeQuality = (() => {
    const js = item.intakeReport?.jpegStructure ?? null;
    if (js && !('state' in js) && js.quantization?.closestQuality != null) {
      const q = js.quantization.closestQuality / 100;
      return Math.min(0.98, Math.max(0.5, Math.round(q * 100) / 100));
    }
    return null;
  })();
  const [quality, setQuality] = useState<number>(intakeQuality ?? 0.9);
  const { running, status, run, cancel } = useRun();
  const [error, setError] = useState<string | null>(null);

  const gate = item.bytes ? elaGateForBytes(item.bytes) : { ok: false as const, reason: 'this item’s bytes are not held in this tab' };
  const blocked = naReason ?? (gate.ok ? null : gate.reason);
  // When the JPEG gate itself is what blocks, the deck's gate string renders
  // VERBATIM (fx.ela.gate) — not wrapped in a second "Not applicable —".

  async function onRun() {
    setError(null);
    const out = await run(async (signal, progress) => {
      progress('Decoding the image in this tab…', 0.1);
      const raster = await getRaster();
      progress(`Re-encoding as JPEG at quality ${quality.toFixed(2)}…`, 0.4);
      const resaved = await reencodeJpeg(raster, quality);
      if (signal.aborted) throw new FxCancelled();
      progress('Differencing…', 0.8);
      return elaDiff(raster, resaved, quality, 16);
    });
    if (out.ok) patch({ ela: out.value });
    else if (!out.cancelled) setError(out.error ?? 'the run failed');
  }

  return (
    <div className="card" id="dash-card-fx-ela">
      <h2>Error Level Analysis</h2>
      {/* fx.ela.caveat — a FIXED disclaimer (DESIGN §5.6): non-dismissible,
          rendered above the run button, always. Verbatim. */}
      <div className="warn-box">
        <strong>The results of this tool can be misleading.</strong> ELA responds to recompression
        history, not to honesty; a genuine resaved photo can light up, and a careful fake can stay
        dark. Read it as a viewing aid, never as evidence of manipulation.
      </div>
      {blocked ? (
        naReason ? (
          <NaRow label="Error Level Analysis" reason={blocked} tip={TOOLTIPS.ela} />
        ) : (
          <SignalRow label="Error Level Analysis" chip={{ tone: 'neutral', text: 'Not applicable' }} tip={TOOLTIPS.ela}>
            {/* fx.ela.gate — verbatim. */}
            {blocked}
          </SignalRow>
        )
      ) : (
        <>
          {!cached && !error && (
            <SignalRow label="Error Level Analysis" chip={{ tone: 'neutral', text: 'Not run' }} tip={TOOLTIPS.ela}>
              Not run — nothing runs until you ask. Method {methodVersion('ela')}.
            </SignalRow>
          )}
          {error && (
            <SignalRow label="Error Level Analysis" chip={{ tone: 'warn', text: 'Could not run' }} tip={TOOLTIPS.ela}>
              The run itself failed: {error} — a Source Kit Desk bug to report, not a finding about this file.
            </SignalRow>
          )}
          {cached && (
            <>
              <SignalRow label="Recompression difference" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.ela}>
                mean per-channel difference {cached.meanAbsDiff.toFixed(2)} of 255 (max {cached.maxAbsDiff})
                against a quality-{cached.quality.toFixed(2)} re-save, amplified ×{cached.amplification}
                <div className="field-note" style={{ marginTop: 2 }}>
                  Analyzed at {cached.analyzedWidth}×{cached.analyzedHeight} · method {cached.methodVersion} ·
                  measured in this tab {cached.computedAt}
                </div>
              </SignalRow>
              <div className="fx-canvas-grid one">
                <figure>
                  <RasterCanvas raster={cached.image} label="ELA difference image, amplified" />
                  <figcaption className="field-note">
                    Brighter = larger difference from the re-save. The caveat above applies to every
                    pixel of this image.
                  </figcaption>
                </figure>
              </div>
            </>
          )}
          <div className="fx-tool-params">
            <label>
              Re-save quality
              <select value={quality} onChange={(e) => setQuality(Number(e.target.value))} disabled={running}>
                {intakeQuality !== null && ![0.75, 0.9, 0.95].includes(intakeQuality) && (
                  <option value={intakeQuality}>
                    {intakeQuality.toFixed(2)} (from this file’s tables — an estimate)
                  </option>
                )}
                <option value={0.75}>0.75</option>
                <option value={0.9}>0.90</option>
                <option value={0.95}>0.95</option>
              </select>
            </label>
          </div>
          <RunRow label="Run Error Level Analysis" running={running} status={status} onRun={() => void onRun()} onCancel={cancel} />
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Viewing aids (fx.magnifier / levels / gradient + fx.viewingaid)      */
/* ------------------------------------------------------------------ */

type AidId = 'magnifier' | 'levels' | 'gradient';

const AIDS: readonly { id: AidId; title: string }[] = [
  { id: 'magnifier', title: 'Magnifier' },
  { id: 'levels', title: 'Level sweep' },
  { id: 'gradient', title: 'Luminance gradient' },
];

function MagnifierAid({ raster }: { raster: FxRaster }) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const magRef = useRef<HTMLCanvasElement>(null);
  const [mode, setMode] = useState<MagnifierMode>('none');
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const WIN = 96; // source window edge, px
  const ZOOM = 3;

  useEffect(() => {
    const c = baseRef.current;
    if (!c) return;
    c.width = raster.width;
    c.height = raster.height;
    c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(raster.rgba), raster.width, raster.height), 0, 0);
  }, [raster]);

  useEffect(() => {
    const c = magRef.current;
    if (!c || !pos) return;
    const sx = Math.max(0, Math.min(raster.width - WIN, pos.x - WIN / 2));
    const sy = Math.max(0, Math.min(raster.height - WIN, pos.y - WIN / 2));
    const region: FxRaster = { width: WIN, height: WIN, rgba: new Uint8ClampedArray(WIN * WIN * 4) };
    for (let y = 0; y < WIN; y++) {
      const srcRow = ((sy + y) * raster.width + sx) * 4;
      region.rgba.set(raster.rgba.subarray(srcRow, srcRow + WIN * 4), y * WIN * 4);
    }
    const enhanced = applyMagnifierMode(region, mode);
    c.width = WIN;
    c.height = WIN;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(enhanced.rgba), WIN, WIN), 0, 0);
  }, [pos, mode, raster]);

  return (
    <div>
      <div className="fx-tool-params">
        <label>
          Contrast
          <select value={mode} onChange={(e) => setMode(e.target.value as MagnifierMode)}>
            {MAGNIFIER_MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
      </div>
      <div
        className="fx-magnifier"
        onMouseMove={(e) => {
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          setPos({
            x: Math.round(((e.clientX - rect.left) / rect.width) * raster.width),
            y: Math.round(((e.clientY - rect.top) / rect.height) * raster.height),
          });
        }}
        onMouseLeave={() => setPos(null)}
      >
        <canvas ref={baseRef} className="fx-canvas" role="img" aria-label="The image; move the pointer to magnify a region" />
        {pos && (
          <canvas
            ref={magRef}
            className="fx-mag-window"
            style={{ width: WIN * ZOOM, height: WIN * ZOOM }}
            role="img"
            aria-label="Magnified region"
          />
        )}
      </div>
      <p className="field-note" style={{ marginBottom: 0 }}>
        {pos ? `Magnifying around (${pos.x}, ${pos.y}) at ×${ZOOM}, contrast: ${MAGNIFIER_MODES.find((m) => m.id === mode)?.label}.`
          : 'Move the pointer over the image to magnify a region.'}
      </p>
    </div>
  );
}

function LevelSweepAid({ raster }: { raster: FxRaster }) {
  const [position, setPosition] = useState(0.5);
  const [width, setWidth] = useState(0.1);
  const [out, setOut] = useState<FxRaster | null>(null);

  useEffect(() => {
    // O(n) single pass — recomputed per slider move; never blocks long.
    setOut(levelSweep(raster, position, width));
  }, [raster, position, width]);

  return (
    <div>
      <div className="fx-tool-params">
        <label>
          Slice center {(position * 100).toFixed(0)}%
          <input type="range" min={0} max={1} step={0.01} value={position} onChange={(e) => setPosition(Number(e.target.value))} />
        </label>
        <label>
          Slice width {(width * 100).toFixed(0)}%
          <input type="range" min={0.01} max={0.5} step={0.01} value={width} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
      </div>
      {out && <RasterCanvas raster={out} label="Level sweep: one luminance slice stretched to the full range" />}
      <p className="field-note" style={{ marginBottom: 0 }}>
        One narrow luminance band stretched to the full range; everything else black. Pasted edges
        can appear as discontinuities inside the band — a lead for your eyes, nothing more.
      </p>
    </div>
  );
}

function GradientAid({ raster }: { raster: FxRaster }) {
  const [out, setOut] = useState<FxRaster | null>(null);
  useEffect(() => {
    setOut(luminanceGradient(raster));
  }, [raster]);
  return (
    <div>
      {out && <RasterCanvas raster={out} label="Luminance gradient magnitude" />}
      <p className="field-note" style={{ marginBottom: 0 }}>
        Per-pixel brightness-gradient magnitude. A sharper gradient along one edge than its
        neighbours can hint at a paste boundary — a lead, not a finding.
      </p>
    </div>
  );
}

function ViewingAidsCard(props: { item: DeskItem; naReason: string | null; getRaster: () => Promise<FxRaster> }) {
  const { item, naReason, getRaster } = props;
  const [aid, setAid] = useState<AidId>('magnifier');
  const [raster, setRaster] = useState<FxRaster | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const genRef = useRef(0);

  useEffect(() => {
    setRaster(null);
    setError(null);
  }, [item.id]);

  async function ensureRaster() {
    if (raster || loading) return;
    const gen = ++genRef.current;
    setLoading(true);
    try {
      const r = await getRaster();
      if (genRef.current === gen) setRaster(r);
    } catch (e) {
      if (genRef.current === gen) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (genRef.current === gen) setLoading(false);
    }
  }

  return (
    <div className="card" id="dash-card-fx-aids">
      <h2>Magnifier · Level sweep · Luminance gradient</h2>
      {/* fx.viewingaid — verbatim; these aids claim nothing. */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Viewing aid — it shows the picture differently and claims nothing.
      </p>
      {naReason ? (
        <NaRow label="Viewing aids" reason={naReason} tip={TOOLTIPS.viewingAids} />
      ) : (
        <>
          <div className="fx-aid-tabs" role="tablist" aria-label="Viewing aids">
            {AIDS.map((a) => (
              <button
                key={a.id}
                role="tab"
                aria-selected={aid === a.id}
                className={aid === a.id ? 'active' : ''}
                onClick={() => {
                  setAid(a.id);
                  void ensureRaster();
                }}
              >
                {a.title}
              </button>
            ))}
          </div>
          {!raster && !error && (
            <SignalRow
              label={AIDS.find((a) => a.id === aid)?.title ?? 'Viewing aid'}
              chip={{ tone: 'neutral', text: 'Not loaded' }}
              tip={TOOLTIPS.viewingAids}
            >
              {loading ? 'Decoding the image in this tab…' : 'Not loaded — choose an aid to decode the image in this tab.'}
            </SignalRow>
          )}
          {error && (
            <SignalRow label="Viewing aids" chip={{ tone: 'warn', text: 'Could not run' }} tip={TOOLTIPS.viewingAids}>
              The image could not be decoded in this tab: {error}
            </SignalRow>
          )}
          {raster && aid === 'magnifier' && <MagnifierAid raster={raster} />}
          {raster && aid === 'levels' && <LevelSweepAid raster={raster} />}
          {raster && aid === 'gradient' && <GradientAid raster={raster} />}
          <p className="field-note" style={{ marginBottom: 0 }}>method {methodVersion(aid === 'magnifier' ? 'magnifier' : aid === 'levels' ? 'level-sweep' : 'luminance-gradient')} · computed in this tab</p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Parallax flatness measurement (fx.parallax.*) — external ring input  */
/* ------------------------------------------------------------------ */

function ParallaxCard(props: { item: DeskItem; patch: (p: Partial<Tier2FxCache>) => void }) {
  const { item, patch } = props;
  const cached = item.tier2Fx?.parallax ?? null;
  const [frameFiles, setFrameFiles] = useState<File[]>([]);
  const [logFile, setLogFile] = useState<File | null>(null);
  const { running, status, run, cancel } = useRun();
  const [error, setError] = useState<string | null>(null);

  async function onRun() {
    setError(null);
    const out = await run(async (signal, progress) => {
      progress(`Decoding ${frameFiles.length} ring frames in this tab…`, 0.1);
      const ordered = [...frameFiles].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const planes = [];
      for (let i = 0; i < ordered.length; i++) {
        if (signal.aborted) throw new FxCancelled();
        try {
          const bmp = await createImageBitmap(ordered[i]);
          const canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) throw new Error('no 2D canvas');
          ctx.drawImage(bmp, 0, 0);
          bmp.close();
          const px = ctx.getImageData(0, 0, canvas.width, canvas.height);
          planes.push(grayPlaneFromRgba(px.data, canvas.width, canvas.height));
        } catch {
          planes.push(null); // undecodable frames die honestly — the analyzer counts them
        }
        progress(`Decoding ring frames… ${i + 1} of ${ordered.length}`, (0.4 * (i + 1)) / ordered.length);
      }
      let gyro = null;
      if (logFile) {
        progress('Parsing the sensor log…', 0.5);
        gyro = parseSensorLogJsonl(await logFile.text());
      }
      progress('Measuring parallax flatness…', 0.7);
      // Let the status line paint, then one bounded synchronous call: the
      // analyzer itself is existing deterministic geometry (core/parallax.ts,
      // unchanged) on a 320px-capped raster — sub-second in practice; the
      // decode above is the chunked part.
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      if (signal.aborted) throw new FxCancelled();
      return analyzeParallaxBurst(planes, { gyro });
    });
    if (out.ok) patch({ parallax: out.value });
    else if (!out.cancelled) setError(out.error ?? 'the run failed');
  }

  const ev = cached;
  return (
    <div className="card" id="dash-card-fx-parallax">
      <h2>Parallax flatness measurement</h2>
      {/* fx.parallax.input — verbatim. */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Needs the capture’s sensor ring (JSONL). Provide the ring dump; the measurement runs here.
      </p>

      <div className="fx-file-row">
        <label>
          Ring frames (f000.jpg…f007.jpg, 8 expected)
          <input
            type="file"
            accept="image/jpeg,image/png"
            multiple
            disabled={running}
            onChange={(e) => setFrameFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <label>
          Sensor log (JSONL — optional, aids rotation compensation)
          <input
            type="file"
            accept=".jsonl,.json,.txt"
            disabled={running}
            onChange={(e) => setLogFile(e.target.files?.[0] ?? null)}
          />
        </label>
      </div>
      {frameFiles.length > 0 && (
        <p className="field-note">
          {frameFiles.length} frame{frameFiles.length === 1 ? '' : 's'} selected
          {frameFiles.length < 5 ? ' — the analyzer needs at least 5 decodable frames' : ''}
          {logFile ? ` · sensor log: ${logFile.name}` : ' · no sensor log — rotation from the image fit itself'}
        </p>
      )}

      {!ev && !error && frameFiles.length === 0 && (
        /* The honest absence card when no ring was ever provided. */
        <SignalRow label="Parallax flatness" chip={{ tone: 'neutral', text: 'Not run' }} tip={TOOLTIPS.parallaxRing}>
          Not run — no ring dump provided in this tab. A single dropped photo or video does not
          carry the 8-frame pre-shutter ring this measurement rests on; nothing is implied by its absence.
        </SignalRow>
      )}
      {error && (
        <SignalRow label="Parallax flatness" chip={{ tone: 'warn', text: 'Could not run' }} tip={TOOLTIPS.parallaxRing}>
          The run itself failed: {error} — a Source Kit Desk bug to report, not a finding about this file.
        </SignalRow>
      )}
      {ev && (
        <>
          {ev.insufficient ? (
            <SignalRow label="Parallax flatness" chip={{ tone: 'neutral', text: 'Insufficient signal' }} tip={TOOLTIPS.parallaxRing}>
              {ev.insufficient}
            </SignalRow>
          ) : (
            <>
              <SignalRow label="Frames / tracks" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.parallaxRing}>
                {ev.framesDecoded} frames decoded · {ev.tracksUsed} full-span feature tracks
              </SignalRow>
              <SignalRow label="Planar-model residual" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.parallaxRing}>
                median {ev.planarResidualPx.median.toFixed(2)} px · p90 {ev.planarResidualPx.p90.toFixed(2)} px
                · inlier ratio {(ev.inlierRatio * 100).toFixed(0)}%
              </SignalRow>
              <SignalRow label="Depth spread (disparity p90−p10)" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.parallaxRing}>
                {ev.depthSpreadEstimate.value.toFixed(2)} disparity-px — {ev.depthSpreadEstimate.note}
              </SignalRow>
              <SignalRow label="Rotation compensation" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.parallaxRing}>
                {ev.rotationCompensated
                  ? 'gyro-aided (integrated sensor-log rotation)'
                  : 'from the image fit itself (no usable gyro)'}
                · accumulated baseline {ev.baselinePx.toFixed(1)} px
              </SignalRow>
              {ev.rotationCompensated && !ev.gyroPriorAuthenticated && (
                <p className="honest-note">
                  The sensor log is an unauthenticated sidecar — it aided rotation compensation but is
                  not a trust upgrade of any kind.
                </p>
              )}
            </>
          )}
          <details style={{ marginTop: 4 }}>
            <summary className="field-note" style={{ cursor: 'pointer' }}>
              Limitations ({ev.limitations.length}) — stated by the analyzer itself
            </summary>
            <ul className="checks notdone" style={{ marginTop: 4 }}>
              {ev.limitations.map((l, i) => <li key={i}>{l}</li>)}
            </ul>
          </details>
          <p className="field-note">
            method {ev.methodVersion} · measured in this tab {ev.computedAt} — from the ring dump and
            sensor log you provided: external inputs, not facts embedded in this asset.
          </p>
        </>
      )}

      <RunRow
        label="Run parallax measurement"
        running={running}
        status={status}
        disabled={frameFiles.length < 5}
        onRun={() => void onRun()}
        onCancel={cancel}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Screen re-photography signals (fx.rephoto.*) — re-hosted from the    */
/* Overview tab per ARCHITECTURE §5.3 ("surface results here").         */
/* ------------------------------------------------------------------ */

function RephotoCard({ item }: { item: DeskItem }) {
  const r = item.rephoto;
  return (
    <div className="card" id="dash-card-fx-rephoto">
      <h2>Screen re-photography signals</h2>
      {/* fx.rephoto.note — verbatim. */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Statistical measurements — evidence for a person to weigh, never a verdict, never a gate.
        A photo of a screen can be entirely legitimate; these numbers say nothing about intent.
      </p>
      {!r ? (
        <SignalRow label="Re-photography signals" chip={{ tone: 'neutral', text: 'Not applicable' }} tip={TOOLTIPS.rephoto}>
          {item.bytes && isVideoBytes(item.bytes)
            ? 'Not applicable — photos only; video frame analysis is not implemented (stated, not hidden).'
            : 'Not applicable — not computed for this item (the browser could not rasterize it, or it entered before these signals ran).'}
        </SignalRow>
      ) : (
        <>
          <SignalRow
            label="Rolling-shutter banding"
            tip={TOOLTIPS.rephoto}
            chip={r.banding.strength === 'insufficient-signal'
              ? { tone: 'neutral', text: 'Insufficient signal' }
              : { tone: 'info', text: 'Observed' }}
          >
            {r.banding.strength === 'insufficient-signal'
              ? 'no usable signal (flat or featureless content)'
              : <>
                  {r.banding.strength} periodic striping — peak/floor {r.banding.snrDb.toFixed(1)} dB
                  at {r.banding.peakFreq.toFixed(4)} cycles/row
                </>}
          </SignalRow>
          <SignalRow
            label="Moiré (display-grid aliasing)"
            tip={TOOLTIPS.rephoto}
            chip={r.moire.strength === 'insufficient-signal'
              ? { tone: 'neutral', text: 'Insufficient signal' }
              : { tone: 'info', text: 'Observed' }}
          >
            {r.moire.strength === 'insufficient-signal'
              ? 'no usable signal (flat or featureless content)'
              : <>
                  {r.moire.strength} high-frequency peak — {r.moire.snrDb.toFixed(1)} dB
                  at ({r.moire.peakU.toFixed(3)}, {r.moire.peakV.toFixed(3)}) cycles/pixel
                </>}
          </SignalRow>
          <SignalRow label="Black floor" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.rephoto}>
            darkest pixel {r.blackFloor.minLuma}, 0.5th-percentile {r.blackFloor.p005},
            near-black pixels {(r.blackFloor.trueBlackFraction * 100).toFixed(2)}%
            — screens lift blacks; natural dark scenes usually reach near zero somewhere
          </SignalRow>
          <SignalRow label="Display gamut" chip={{ tone: 'info', text: 'Observed' }} tip={TOOLTIPS.rephoto}>
            {(r.gamut.hardSaturatedFraction * 100).toFixed(2)}% hard-saturated pixels (one channel
            railed, another near zero), {(r.gamut.channelClipFraction * 100).toFixed(1)}% with any
            railed channel — panels pin channels; natural scenes rarely do in bulk
          </SignalRow>
          <p className="honest-note" style={{ marginBottom: 0 }}>
            Analyzed at {r.analyzedWidth}×{r.analyzedHeight}, when this file was taken in. Photos only —
            video frame analysis is not implemented yet (stated, not hidden).
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The tab                                                             */
/* ------------------------------------------------------------------ */

export function ForensicsTab({ item, onItemPatched, onOpenBasis }: {
  item: DeskItem;
  onItemPatched?: (id: string, patch: (current: DeskItem) => DeskItem) => void;
  onOpenBasis?: (basis: BasisRef) => void;
}) {
  const rasterRef = useRef<Promise<FxRaster> | null>(null);
  // A different item invalidates the shared decoded raster.
  useEffect(() => {
    rasterRef.current = null;
  }, [item.id]);

  if (item.kind !== 'media') {
    return (
      <div>
        {/* fx.title */}
        <h2 className="dash-tab-title">Forensics — run on your say-so</h2>
        <div className="card">
          <p className="dash-absence" style={{ margin: 0 }}>
            Not applicable — this item carries no media bytes to analyze.
          </p>
        </div>
      </div>
    );
  }

  /**
   * F1: the patch is a MERGE against the CURRENT item inside App's setter —
   * a stale render closure can never wipe another tool's just-committed
   * result (concurrent clone + noise runs both survive).
   */
  function patch(p: Partial<Tier2FxCache>) {
    onItemPatched?.(item.id, (current) => ({
      ...current,
      tier2Fx: { ...(current.tier2Fx ?? {}), ...p },
    }));
  }

  function getRaster(): Promise<FxRaster> {
    rasterRef.current ??= decodeItemRaster(item);
    return rasterRef.current;
  }

  const isVideo = item.bytes
    ? isVideoBytes(item.bytes)
    : Boolean(item.objectMime?.startsWith('video')) || item.report?.record?.asset?.kind === 'video';

  // One N/A reason, computed once, shared by every still-image tool (L3).
  const stillNaReason = isVideo
    ? 'a still-image analysis — not applicable to a video'
    : !item.bytes
      ? 'this item’s bytes are not held in this tab — re-drop the original file to run it here'
      : null;

  return (
    <div>
      {/* fx.title */}
      <h2 className="dash-tab-title">Forensics — run on your say-so</h2>
      {/* fx.intro */}
      <p className="honest-note" style={{ marginTop: 0 }}>
        Heavier analyses run only when you ask. Everything here computes in this tab; nothing is sent
        anywhere.
      </p>

      {/* W4 decision: the Tier-0 byte reads STAY on Overview (the Assistant's
          deep-links point there). This standing cross-link says so — nothing
          hidden, nothing duplicated. */}
      <div className="card">
        <h2>Computed at intake — on the Overview tab</h2>
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-dim)' }}>
          The cheap byte reads — embedded metadata, the strings layer, JPEG structure &amp;
          quantization tables (the compression recipe the last JPEG saver used), and the embedded
          thumbnail — were computed when this file was taken in. They render on the{' '}
          <strong>Overview</strong> tab, each with its ⓘ “what this can and cannot show” and its
          not-applicable state. Stated here so nothing is hidden or duplicated.
        </p>
        {onOpenBasis && (
          <div className="btn-row" style={{ marginTop: 10 }}>
            {/* An actual tab switch, like an Assistant deep-link. */}
            <button className="btn secondary" onClick={() => onOpenBasis({ tab: 'overview', card: 'jpeg-structure' })}>
              Open the byte reads on the Overview tab
            </button>
          </div>
        )}
      </div>

      <CloneCard item={item} naReason={stillNaReason} getRaster={getRaster} patch={patch} />
      <NoiseCard item={item} naReason={stillNaReason} getRaster={getRaster} patch={patch} />
      <ElaCard item={item} naReason={stillNaReason} getRaster={getRaster} patch={patch} />
      <ViewingAidsCard item={item} naReason={stillNaReason} getRaster={getRaster} />
      <ParallaxCard item={item} patch={patch} />
      <RephotoCard item={item} />
    </div>
  );
}
