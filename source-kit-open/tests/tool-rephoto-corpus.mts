#!/usr/bin/env tsx
/**
 * Re-photography corpus runner — the error-rate gate.
 *
 * Runs the desk's re-photo analyzers (the SHARED core, same code the desk
 * runs) over a labeled corpus folder and emits the ROC data every signal
 * must ship with before it gains any UI prominence.
 *
 * Corpus layout (JPEG only in v1 — stated, not hidden):
 *   corpus/
 *     positive/   screen re-photos (red-team set)
 *     negative/   genuine captures of natural scenes
 *
 * Usage (from tests/.staged):
 *   ./node_modules/.bin/tsx tool-rephoto-corpus.mts /path/to/corpus out/
 *
 * Outputs:
 *   out/scores.jsonl   one row per image: {id, label, banding, moire, blackFloor, gamut}
 *   out/roc.json       RocReport per thresholded signal (banding snrDb, moire snrDb)
 *
 * The manifest string in roc.json records sizes, the absolute corpus path,
 * and the run date — an ROC without provenance is decoration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { decode as jpegDecode } from 'jpeg-js';
import { analyzeBanding, analyzeMoire, analyzeBlackFloor, analyzeGamut } from './rephoto.mts';
import { buildRocReport, type LabeledScore } from './roc.mts';

const ANALYSIS_LONG_SIDE = 512; // matches desk/src/core/rephoto.ts

function rasterize(jpeg: Uint8Array): { gray: Float64Array; rgba: Uint8Array; width: number; height: number } | null {
  const dec = jpegDecode(jpeg, { maxMemoryUsageInMB: 64, formatAsRGBA: true });
  if (!dec || dec.width < 32 || dec.height < 32) return null;
  const scale = Math.min(1, ANALYSIS_LONG_SIDE / Math.max(dec.width, dec.height));
  const w = Math.max(8, Math.round(dec.width * scale));
  const h = Math.max(8, Math.round(dec.height * scale));
  // Box-downsample (deterministic; the desk uses canvas resampling — close
  // enough at these sizes that thresholds transfer, and corpus-calibrated
  // thresholds are derived HERE, on this exact pipeline).
  const gray = new Float64Array(w * h);
  const rgba = new Uint8Array(w * h * 4);
  const sx = dec.width / w;
  const sy = dec.height / h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const y0 = Math.floor(y * sy);
      const x1 = Math.min(dec.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      const y1 = Math.min(dec.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const o = (yy * dec.width + xx) * 4;
          r += dec.data[o]; g += dec.data[o + 1]; b += dec.data[o + 2];
          n++;
        }
      }
      r /= n; g /= n; b /= n;
      const i = y * w + x;
      gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
    }
  }
  return { gray, rgba, width: w, height: h };
}

const corpusDir = process.argv[2];
const outDir = process.argv[3] ?? '.';
if (!corpusDir) {
  console.error('usage: tsx tool-rephoto-corpus.mts /path/to/corpus [outDir]');
  process.exit(2);
}

interface Row {
  id: string;
  label: 'positive' | 'negative';
  bandingSnrDb: number | null;
  moireSnrDb: number | null;
  blackFloorP005: number;
  trueBlackFraction: number;
  hardSaturatedFraction: number;
  channelClipFraction: number;
}

const rows: Row[] = [];
for (const label of ['positive', 'negative'] as const) {
  const dir = path.join(corpusDir, label);
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort()) {
    const raster = rasterize(new Uint8Array(fs.readFileSync(path.join(dir, file))));
    if (!raster) {
      console.error(`skip (unrasterizable): ${label}/${file}`);
      continue;
    }
    const banding = analyzeBanding(raster.gray, raster.width, raster.height);
    const moire = analyzeMoire(raster.gray, raster.width, raster.height);
    const bf = analyzeBlackFloor(raster.gray, raster.width, raster.height);
    const gm = analyzeGamut(raster.rgba, raster.width * raster.height);
    rows.push({
      id: `${label}/${file}`,
      label,
      bandingSnrDb: Number.isFinite(banding.snrDb) ? banding.snrDb : null,
      moireSnrDb: Number.isFinite(moire.snrDb) ? moire.snrDb : null,
      blackFloorP005: bf.p005,
      trueBlackFraction: bf.trueBlackFraction,
      hardSaturatedFraction: gm.hardSaturatedFraction,
      channelClipFraction: gm.channelClipFraction,
    });
  }
}

if (rows.length === 0) {
  console.error('no corpus images found — expected corpus/positive/*.jpg and corpus/negative/*.jpg');
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'scores.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const manifest = `corpus=${path.resolve(corpusDir)} run=${new Date().toISOString()} analyzer=src/lib/rephoto.ts raster=box≤${ANALYSIS_LONG_SIDE}px decoder=jpeg-js`;
const toScores = (key: 'bandingSnrDb' | 'moireSnrDb'): LabeledScore[] =>
  rows.filter((r) => r[key] !== null).map((r) => ({ id: r.id, label: r.label, score: r[key]! }));
const roc = {
  banding: buildRocReport('banding.snrDb', toScores('bandingSnrDb'), manifest),
  moire: buildRocReport('moire.snrDb', toScores('moireSnrDb'), manifest),
};
fs.writeFileSync(path.join(outDir, 'roc.json'), JSON.stringify(roc, null, 2));

console.log(`scored ${rows.length} images (${rows.filter((r) => r.label === 'positive').length} positive, ${rows.filter((r) => r.label === 'negative').length} negative)`);
console.log(`banding AUC=${roc.banding.auc.toFixed(4)}  moire AUC=${roc.moire.auc.toFixed(4)}`);
console.log(`wrote ${path.join(outDir, 'scores.jsonl')} and ${path.join(outDir, 'roc.json')}`);
