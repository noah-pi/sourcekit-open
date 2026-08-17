// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * intakeReport.ts — assembles the Tier-0 IntakeReport (ARCHITECTURE §3.3/§5.1)
 * from the pieces intake already computes: the worker hash, the worker byte
 * reads (byteReads.ts), the main-thread verification path (classifyAndVerify),
 * and the main-thread canvas steps (thumbnail decode + diff — canvas stays
 * off the worker per the OffscreenCanvas risk note, §11).
 *
 * The report is DATA, not verdicts: every field is a measurement, a
 * declaration attributed to its source, or an explicit N/A/not-run with
 * reason. Nothing here touches the network.
 */
import { extractC2paStore, parseManifestChain } from '@exhibit-archive/handrolled-verifier/c2pa';
import { extractCaBx } from '@exhibit-archive/handrolled-verifier/png';
import { extractC2paStoreBmff } from '@exhibit-archive/handrolled-verifier/bmff';
import { sniffFormat } from './byteReads';
import type { Tier0WorkerResult } from '../workers/intakeWorker';
import type {
  C2paSummary,
  IntakeReport,
  SignalStatus,
  ThumbnailDiff,
  ThumbnailResult,
} from '../contracts-ext';
import type { DeskItem } from './deskItem';

/* ------------------------------------------------------------------ */
/* Declared-C2PA summary (L7/L8: declarations, attributed)             */
/* ------------------------------------------------------------------ */

function c2paSummaryFromBytes(bytes: Uint8Array): C2paSummary | SignalStatus {
  const format = sniffFormat(bytes);
  try {
    let store: Uint8Array | null = null;
    if (format === 'jpeg') store = extractC2paStore(bytes)?.payload ?? null;
    else if (format === 'png') store = extractCaBx(bytes)?.store ?? null;
    else if (format === 'bmff') store = extractC2paStoreBmff(bytes)?.payload ?? null;
    if (!store) {
      return {
        state: 'not-applicable',
        reason: 'No credentials are embedded in these bytes — nothing to summarize. This is normal; most files today carry none.',
      };
    }
    const chain = parseManifestChain(store);
    const active = chain?.manifests[chain.manifests.length - 1] ?? null;
    if (!chain || !active) {
      return { state: 'error', reason: 'a credential store was found but could not be parsed — treated as unreadable, not as absent' };
    }
    return {
      claimGenerator: active.claimGenerator,
      manifestLabel: active.manifestLabel,
      manifestCount: chain.manifests.length,
      actions: active.actions
        ? active.actions.list.map((a) => ({
            action: a.action,
            softwareAgent: a.softwareAgent,
            when: a.when,
            description: a.description,
            referenced: active.actions!.referenced,
          }))
        : null,
      ingredients: active.ingredients.map((i) => ({
        title: i.title,
        format: i.format,
        relationship: i.relationship,
        referenced: i.referenced,
      })),
      signerFingerprint: null, // filled by the caller from the verification report
      // This build parses no digitalSourceType assertion of its own — the AI
      // tab renders that honestly rather than implying "no AI declared".
      digitalSourceType: null,
    };
  } catch (e) {
    return { state: 'error', reason: `the credential parse failed (${e instanceof Error ? e.message : String(e)}) — treated as unreadable, not as absent` };
  }
}

/* ------------------------------------------------------------------ */
/* Thumbnail decode + diff (main thread — canvas)                      */
/* ------------------------------------------------------------------ */

const THUMB_COMPARE_RASTER = 64;
/** Mean per-channel difference beyond which the preview is said to differ. */
const THUMB_DIFF_FLOOR = 12;

async function rasterize(bytes: Uint8Array, mime: string, size: number): Promise<{ w: number; h: number; data: Uint8ClampedArray } | null> {
  try {
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      bmp.close();
      return null;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  } catch {
    return null;
  }
}

/**
 * Diff the embedded preview against the main image on a small comparison
 * raster. Every failure path is an explicit SignalStatus with a reason —
 * never an exception, never a silent null.
 */
export async function computeThumbnailDiff(
  mainBytes: Uint8Array,
  mainMime: string,
  thumbBytes: Uint8Array,
): Promise<ThumbnailDiff | SignalStatus> {
  const [main, thumb] = await Promise.all([
    rasterize(mainBytes, mainMime, THUMB_COMPARE_RASTER),
    rasterize(thumbBytes, 'image/jpeg', THUMB_COMPARE_RASTER),
  ]);
  if (!main) return { state: 'not-run', reason: 'the main image could not be rasterized in this browser — no diff was computed' };
  if (!thumb) return { state: 'error', reason: 'the embedded preview could not be decoded in this browser — extraction succeeded, decode did not' };
  const w = Math.min(main.w, thumb.w);
  const h = Math.min(main.h, thumb.h);
  let sum = 0;
  let cells = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mi = (y * main.w + x) * 4;
      const ti = (y * thumb.w + x) * 4;
      sum += (Math.abs(main.data[mi] - thumb.data[ti]) + Math.abs(main.data[mi + 1] - thumb.data[ti + 1]) + Math.abs(main.data[mi + 2] - thumb.data[ti + 2])) / 3;
      cells++;
    }
  }
  const mean = cells > 0 ? sum / cells : 0;
  return {
    meanAbsDiff: +mean.toFixed(2),
    fraction: +(mean / 255).toFixed(4),
    comparedAt: THUMB_COMPARE_RASTER,
    differs: mean >= THUMB_DIFF_FLOOR,
  };
}

/* ------------------------------------------------------------------ */
/* Report assembly                                                     */
/* ------------------------------------------------------------------ */

/**
 * Build the Tier-0 report for one item. `tier0` is the intake worker's
 * byte-read result (null when byte reads did not run — the reason is
 * rendered from the item's own path). Canvas steps (thumbnail decode/diff)
 * run here on the main thread.
 */
export async function buildIntakeReport(item: DeskItem, tier0: Tier0WorkerResult | null): Promise<IntakeReport> {
  const report = item.report ?? null;

  // Declared-C2PA summary: parse once from the bytes when held; the signer
  // fingerprint comes from the verification report (already checked there).
  let c2paSummary: C2paSummary | SignalStatus | null = null;
  if (item.bytes) {
    const s = c2paSummaryFromBytes(item.bytes);
    if (!('state' in s)) {
      s.signerFingerprint = report?.c2pa?.signerFingerprint ?? report?.record?.signer?.fingerprint ?? null;
    }
    c2paSummary = s;
  }

  // Thumbnail: extraction ran in the worker; decode + diff run here.
  let thumbnail: ThumbnailResult | SignalStatus | null = null;
  if (tier0) {
    const t = tier0.thumbnail;
    if (t.state === 'observed') {
      let width: number | null = null;
      let height: number | null = null;
      let diff: ThumbnailDiff | SignalStatus | null = null;
      try {
        const blob = new Blob([t.bytes.slice().buffer as ArrayBuffer], { type: 'image/jpeg' });
        const bmp = await createImageBitmap(blob);
        width = bmp.width;
        height = bmp.height;
        bmp.close();
      } catch {
        // Decode failure is reported by the diff path below — dims stay null.
      }
      if (item.bytes) {
        const mime = item.bytes[0] === 0xff ? 'image/jpeg' : item.bytes[0] === 0x89 ? 'image/png' : 'application/octet-stream';
        diff = await computeThumbnailDiff(item.bytes, mime, t.bytes);
      } else {
        diff = { state: 'not-run', reason: 'the item\u2019s bytes are not held in this tab — no diff was computed' };
      }
      thumbnail = { state: 'observed', bytes: t.bytes, byteLength: t.bytes.length, width, height, diff };
    } else {
      thumbnail = t;
    }
  }

  return {
    itemId: item.id,
    computedAt: new Date().toISOString(),
    sha256Hex: item.sha256Hex ?? tier0?.sha256Hex ?? '',
    classification: item.kind,
    byteReads: tier0?.byteReads ?? null,
    jpegStructure: tier0
      ? tier0.jpegStructure
      : item.bytes
        ? { state: 'not-run', reason: 'byte reads did not run on this intake path — stated, not hidden' }
        : null,
    thumbnail,
    c2paSummary,
    pHashHex: item.pHash ?? null,
    custody: { recoveryMatches: 0, exactAfterStrip: 0 },
  };
}
