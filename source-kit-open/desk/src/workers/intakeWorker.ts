// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * intakeWorker.ts — the Tier-0 intake pipeline, off the main thread
 * (ARCHITECTURE §5.1: "byte analyses are synchronous typed-array work,
 * safe in-worker").
 *
 * Extends hashWorker's job without touching it ([KEEP]): one pass computes
 * the chunked SHA-256 (same 4 MiB chunks, same cancel-by-terminate rule —
 * a cancelled intake yields NO digest and NO reads), then runs the Tier-0
 * byte reads (byteReads.ts — pure, bytes in/data out) on the same bytes:
 * metadata layer, strings layer, JPEG structure + quantization, embedded
 * thumbnail extraction.
 *
 * Canvas steps are deliberately NOT here: pHash and the thumbnail-vs-main
 * diff stay on the main thread (OffscreenCanvas is patchy in Safari — §11
 * risk note), as does the full C2PA verify (c2pa-wasm is not assumed in
 * workers).
 *
 * WIRE PROTOCOL (postMessage, structured clone):
 *
 *   request (main → worker):
 *     { blob: Blob, chunkSize?: number, runByteReads?: boolean }
 *     // runByteReads defaults true; false = hash-only path (over-1 GiB
 *     // items: the byte reads need the whole file in memory — stated,
 *     // not hidden — so they are skipped and tier0 comes back null)
 *
 *   messages (worker → main), in order:
 *     { type: 'progress', bytesDone, bytesTotal }      // per hash chunk
 *     { type: 'done', hex, bytes, tier0 }              // terminal
 *     { type: 'error', message }                       // terminal
 *
 *   cancel: terminate() the worker — same rule as hashWorker. A cancelled
 *   intake yields NO digest and NO byte reads (fail closed).
 *
 * Vite usage (see intakeInWorker below):
 *   new Worker(new URL('./intakeWorker.ts', import.meta.url), { type: 'module' })
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  readByteLayer,
  readJpegStructure,
  extractEmbeddedThumbnail,
  type ByteReads,
  type JpegStructure,
  type ThumbnailExtraction,
} from '../core/byteReads';
import type { SignalStatus } from '../contracts-ext';

/**
 * 4 MiB — same chunk size as hashWorker (kept as a LOCAL constant: importing
 * hashWorker would run its worker-side onmessage install inside THIS worker
 * bundle; the two workers must stay independent).
 */
const INTAKE_CHUNK_SIZE = 4 * 1024 * 1024;

/** The byte-heavy Tier-0 result, straight off the byte array. */
export interface Tier0WorkerResult {
  sha256Hex: string;
  byteReads: ByteReads;
  jpegStructure: JpegStructure | SignalStatus;
  thumbnail: ThumbnailExtraction;
}

export interface IntakeWorkerRequest {
  blob?: Blob;
  chunkSize?: number;
  runByteReads?: boolean;
}

export interface IntakeWorkerProgress {
  type: 'progress';
  bytesDone: number;
  bytesTotal: number;
}

export interface IntakeWorkerDone {
  type: 'done';
  hex: string;
  bytes: number;
  /** Null on the hash-only path (runByteReads: false). */
  tier0: Tier0WorkerResult | null;
}

export interface IntakeWorkerError {
  type: 'error';
  message: string;
}

export type IntakeWorkerResponse = IntakeWorkerProgress | IntakeWorkerDone | IntakeWorkerError;

const MIN_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Worker side. Inert on the main thread (same guard as hashWorker).
// ---------------------------------------------------------------------------

interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: IntakeWorkerResponse) => void;
}

const workerScope: WorkerScope | null =
  typeof self !== 'undefined' && typeof window === 'undefined'
    ? (self as unknown as WorkerScope)
    : null;

if (workerScope) {
  workerScope.onmessage = async (ev: MessageEvent) => {
    try {
      const req = (ev.data ?? {}) as IntakeWorkerRequest;
      const blob = req.blob;
      if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') {
        workerScope.postMessage({ type: 'error', message: 'intake worker request must carry a Blob as `blob`' });
        return;
      }
      const requested = Number(req.chunkSize);
      const chunkSize = Number.isFinite(requested)
        ? Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.floor(requested)))
        : INTAKE_CHUNK_SIZE;

      // 1. Chunked hash — the file never lands in memory all at once here.
      const bytesTotal = blob.size;
      const hasher = sha256.create();
      let offset = 0;
      while (offset < bytesTotal) {
        const end = Math.min(offset + chunkSize, bytesTotal);
        const buf = await blob.slice(offset, end).arrayBuffer();
        hasher.update(new Uint8Array(buf));
        offset = end;
        workerScope.postMessage({ type: 'progress', bytesDone: offset, bytesTotal });
      }
      const hex = bytesToHex(hasher.digest());

      // 2. Tier-0 byte reads on the whole byte array (synchronous typed-array
      //    work). Skipped on the declared hash-only path.
      let tier0: Tier0WorkerResult | null = null;
      if (req.runByteReads !== false) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        tier0 = {
          sha256Hex: hex,
          byteReads: readByteLayer(bytes),
          jpegStructure: readJpegStructure(bytes),
          thumbnail: extractEmbeddedThumbnail(bytes),
        };
      }
      workerScope.postMessage({ type: 'done', hex, bytes: bytesTotal, tier0 });
    } catch (e) {
      workerScope.postMessage({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };
}

// ---------------------------------------------------------------------------
// Main-thread promise API (mirrors hashFileInWorker's cancel discipline).
// ---------------------------------------------------------------------------

export interface IntakeResult {
  hex: string;
  bytes: number;
  tier0: Tier0WorkerResult | null;
}

export interface IntakePromise extends Promise<IntakeResult> {
  cancel: () => void;
}

/**
 * Run Tier-0 intake (hash + byte reads) on a File/Blob in a Web Worker.
 * Resolves with { hex, bytes, tier0 }; rejects on worker error or cancel().
 * Cancel is terminate(): no partial digest and no partial reads ever escape.
 */
export function intakeInWorker(
  file: Blob,
  opts?: { runByteReads?: boolean; onProgress?: (p: { bytesDone: number; bytesTotal: number }) => void },
): IntakePromise {
  const worker = new Worker(new URL('./intakeWorker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectPromise: (e: Error) => void = () => undefined;

  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    worker.terminate();
    fn();
  };

  const promise = new Promise<IntakeResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as IntakeWorkerResponse;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        opts?.onProgress?.({ bytesDone: msg.bytesDone, bytesTotal: msg.bytesTotal });
      } else if (msg.type === 'done') {
        settle(() => resolve({ hex: msg.hex, bytes: msg.bytes, tier0: msg.tier0 }));
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(`intake worker failed: ${msg.message}`)));
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      settle(() => reject(new Error(`intake worker error: ${ev.message ?? 'unknown'}`)));
    };
    worker.postMessage({ blob: file, runByteReads: opts?.runByteReads !== false });
  }) as IntakePromise;

  promise.cancel = () => {
    settle(() => rejectPromise(new Error('intakeInWorker cancelled')));
  };
  return promise;
}
