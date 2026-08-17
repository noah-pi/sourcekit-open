// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * imageFx.test.ts — Tier-2 image analyses on synthetic rasters.
 *
 * Runs under `tsx --test` (node:test) — no test-runner dependency, no DOM:
 * every core function here is pure typed-array work (the one browser-only
 * helper, reencodeJpeg, is DOM-guarded and not exercised). Deterministic,
 * seeded fixtures: a planted copy-move the clone detector MUST find, a
 * clean gradient it must NOT flood on, a flat input noise analysis must
 * abstain on, the ELA JPEG-only gate, and viewing-aid output sanity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectClones,
  analyzeNoise,
  elaGate,
  elaGateForBytes,
  elaDiff,
  levelSweep,
  luminanceGradient,
  applyMagnifierMode,
  FxCancelled,
  ELA_GATE_REASON,
  type FxRaster,
} from './imageFx';

/* ------------------------------------------------------------------ */
/* Fixture builders (seeded, deterministic)                            */
/* ------------------------------------------------------------------ */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function rasterFromLuma(gray: number[], width: number, height: number): FxRaster {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = Math.max(0, Math.min(255, Math.round(gray[i])));
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** Seeded random-texture raster (every block essentially unique). */
function noiseRaster(width: number, height: number, seed: number): FxRaster {
  const rand = lcg(seed);
  const gray: number[] = new Array(width * height);
  for (let i = 0; i < gray.length; i++) gray[i] = rand() * 255;
  return rasterFromLuma(gray, width, height);
}

function copyBlock(img: FxRaster, sx: number, sy: number, dx: number, dy: number, size: number): void {
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const so = ((sy + j) * img.width + sx + i) * 4;
      const doff = ((dy + j) * img.width + dx + i) * 4;
      for (let c = 0; c < 4; c++) img.rgba[doff + c] = img.rgba[so + c];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Clone detection                                                     */
/* ------------------------------------------------------------------ */

test('clone detection finds a planted copy-move at the planted offset', async () => {
  const img = noiseRaster(192, 192, 1337);
  copyBlock(img, 16, 16, 110, 100, 40); // 40×40 clone, offset (+94, +84)

  const res = await detectClones(img, {
    maxSizePx: 512, // no downscale at 192px
    blockSize: 16,
    minDetail: 1,
    minDistancePx: 40,
    minClusterSize: 4,
    quantLevels: 4,
  });
  assert.equal(res.state, 'measured');
  if (res.state !== 'measured') return;
  assert.ok(res.blocksConsidered > 0, 'blocks were considered');
  assert.ok(res.matchedBlocks > 0, 'some blocks matched');
  const hit = res.clusters.some((c) => Math.abs(c.dx) === 94 && Math.abs(c.dy) === 84);
  assert.ok(hit, `a cluster at the planted offset (94, 84) exists — got ${JSON.stringify(res.clusters)}`);
  // The debug view is exactly what the matcher saw, at the analysis raster.
  assert.equal(res.debugView.width, res.analyzedWidth);
  assert.equal(res.debugView.height, res.analyzedHeight);
  assert.equal(res.overlay.width, res.analyzedWidth);
});

test('clone detection does not flood on a clean smooth gradient', async () => {
  const W = 192;
  const H = 192;
  const gray: number[] = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = 0.5 * x + 0.5 * y;
  const res = await detectClones(rasterFromLuma(gray, W, H), { minDistancePx: 40, minClusterSize: 4 });
  assert.equal(res.state, 'measured');
  if (res.state !== 'measured') return;
  // Low detail everywhere → blocks honestly filtered; nothing matched.
  assert.ok(res.blocksFilteredLowDetail > 0, 'the low-detail filter engaged (stated, not hidden)');
  assert.equal(res.clusters.length, 0);
  assert.equal(res.matchedBlocks, 0);
});

test('clone detection enforces its size cap (stated and real)', async () => {
  const img = noiseRaster(600, 400, 42);
  const res = await detectClones(img, { maxSizePx: 256 });
  assert.equal(res.state, 'measured');
  if (res.state !== 'measured') return;
  assert.ok(Math.max(res.analyzedWidth, res.analyzedHeight) <= 256);
  assert.equal(res.params.maxSizePx, 256);
});

test('clone detection honours cancellation — partial work is discarded', async () => {
  const img = noiseRaster(320, 320, 7);
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(() => detectClones(img, {}, ctrl.signal), FxCancelled);
});

test('clone detection caps a pathological bucket and SAYS matching was truncated', async () => {
  // A tiled texture: one 16×16 pattern repeated — every phase-aligned block
  // keys identically, producing the giant O(k²) bucket the caps exist for.
  const W = 128;
  const H = 128;
  const rand = lcg(2024);
  const tile: number[] = [];
  for (let i = 0; i < 16 * 16; i++) tile.push(rand() * 255);
  const gray: number[] = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = tile[(y % 16) * 16 + (x % 16)];

  const res = await detectClones(rasterFromLuma(gray, W, H), {
    blockSize: 16,
    minDetail: 1,
    minDistancePx: 8,
    maxPairsPerBucket: 32,
    maxTotalPairs: 200,
  });
  assert.equal(res.state, 'measured');
  if (res.state !== 'measured') return;
  assert.equal(res.pairsConsidered, 200, 'the total-pairs cap held exactly');
  assert.ok(res.pairsTruncated > 0, 'the skipped pairs are counted — truncation is stated, not hidden');
  assert.equal(res.pairsConsidered + res.pairsTruncated > res.pairsTruncated, true, 'bookkeeping is coherent');
});

test('clone detection: default caps leave an ordinary run untruncated', async () => {
  const img = noiseRaster(192, 192, 1337);
  copyBlock(img, 16, 16, 110, 100, 40);
  const res = await detectClones(img, { minDistancePx: 40, minClusterSize: 4 });
  assert.equal(res.state, 'measured');
  if (res.state !== 'measured') return;
  assert.equal(res.pairsTruncated, 0);
  assert.ok(res.pairsConsidered > 0);
});

/* ------------------------------------------------------------------ */
/* Noise analysis                                                      */
/* ------------------------------------------------------------------ */

test('noise analysis abstains on a flat input, with a reason', async () => {
  const W = 128;
  const H = 128;
  const gray: number[] = new Array(W * H).fill(128);
  const res = await analyzeNoise(rasterFromLuma(gray, W, H));
  assert.equal(res.state, 'insufficient');
  if (res.state !== 'insufficient') return;
  assert.match(res.reason, /flat/i);
});

test('noise analysis measures a real noise residual on textured input', async () => {
  const img = noiseRaster(160, 160, 99);
  const res = await analyzeNoise(img);
  assert.equal(res.state, 'measured');
  if (res.state !== 'measured') return;
  assert.ok(res.p95AbsResidual > 0.75);
  assert.equal(res.image.width, res.analyzedWidth);
  assert.equal(res.image.height, res.analyzedHeight);
});

test('noise analysis abstains on a tiny input, with a reason', async () => {
  const img = noiseRaster(32, 32, 5);
  const res = await analyzeNoise(img);
  assert.equal(res.state, 'insufficient');
  if (res.state !== 'insufficient') return;
  assert.match(res.reason, /32×32/);
});

/* ------------------------------------------------------------------ */
/* ELA — the gate, and the pure diff                                   */
/* ------------------------------------------------------------------ */

test('ELA refuses non-JPEG with the deck gate reason', () => {
  const png = elaGate('png');
  assert.equal(png.ok, false);
  if (png.ok) return;
  assert.equal(png.reason, ELA_GATE_REASON);
  assert.equal(png.reason, 'JPEG only — not applicable to this file.');

  // Same gate via raw bytes (PNG signature).
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0]);
  const g = elaGateForBytes(pngBytes);
  assert.equal(g.ok, false);

  // JPEG passes the gate (the caveat is UI law, not the gate's job).
  assert.equal(elaGate('jpeg').ok, true);
  const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
  assert.equal(elaGateForBytes(jpgBytes).ok, true);
});

test('ELA diff amplifies and reports recompression differences', () => {
  const img = noiseRaster(64, 64, 11);
  const resaved: FxRaster = {
    width: img.width,
    height: img.height,
    rgba: new Uint8ClampedArray(img.rgba),
  };
  // Simulate a re-encode: quantize a patch harder (as a re-save would).
  for (let y = 8; y < 24; y++) {
    for (let x = 8; x < 24; x++) {
      const o = (y * img.width + x) * 4;
      for (let c = 0; c < 3; c++) resaved.rgba[o + c] = Math.round(resaved.rgba[o + c] / 8) * 8;
    }
  }
  const res = elaDiff(img, resaved, 0.9, 16);
  assert.equal(res.state, 'measured');
  assert.ok(res.meanAbsDiff > 0);
  assert.ok(res.maxAbsDiff >= 3 && res.maxAbsDiff <= 4, `the quantization step shows up (max diff ${res.maxAbsDiff})`);
  assert.equal(res.image.width, img.width);
  // Mismatched dims throw an honest error, never a bogus image.
  assert.throws(() =>
    elaDiff(img, { width: 8, height: 8, rgba: new Uint8ClampedArray(8 * 8 * 4) }, 0.9),
  );
});

/* ------------------------------------------------------------------ */
/* Viewing aids                                                        */
/* ------------------------------------------------------------------ */

test('level sweep stretches the slice and blacks out the rest', () => {
  const W = 64;
  const H = 8;
  const gray: number[] = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = x * 4; // 0..252
  const out = levelSweep(rasterFromLuma(gray, W, H), 0.5, 0.2); // slice ≈ 102..153
  assert.equal(out.width, W);
  const at = (x: number) => out.rgba[(3 * W + x) * 4]; // row 3
  assert.equal(at(10), 0, 'outside the slice → black');
  assert.equal(at(60), 0, 'outside the slice → black');
  const mid = at(32); // v=128, inside the slice
  assert.ok(mid > 100 && mid < 160, `slice interior stretched to range (got ${mid})`);
  assert.ok(at(26) < at(38), 'monotonic inside the slice');
});

test('luminance gradient lights up an edge and stays dark elsewhere', () => {
  const W = 64;
  const H = 64;
  const gray: number[] = new Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = x < 32 ? 0 : 255;
  const out = luminanceGradient(rasterFromLuma(gray, W, H));
  const at = (x: number, y: number) => out.rgba[(y * W + x) * 4];
  assert.ok(at(32, 32) > 200, `edge column bright (got ${at(32, 32)})`);
  assert.ok(at(8, 32) < 10, 'flat region dark');
  assert.ok(at(56, 32) < 10, 'flat region dark');
});

test('magnifier modes return same-size rasters and stretch contrast', () => {
  const img = noiseRaster(32, 32, 3);
  for (const mode of ['none', 'auto', 'auto-channels', 'equalize'] as const) {
    const out = applyMagnifierMode(img, mode);
    assert.equal(out.width, img.width);
    assert.equal(out.height, img.height);
    assert.equal(out.rgba.length, img.rgba.length);
  }
  // A narrow-range input must visibly stretch under auto contrast.
  const narrow = rasterFromLuma(new Array(64).fill(0).map((_, i) => 100 + (i % 8)), 8, 8);
  const stretched = applyMagnifierMode(narrow, 'auto');
  const vals = new Set<number>();
  for (let i = 0; i < 64; i++) vals.add(stretched.rgba[i * 4]);
  assert.ok(Math.max(...vals) - Math.min(...vals) > 100, 'auto contrast expanded the range');
});
