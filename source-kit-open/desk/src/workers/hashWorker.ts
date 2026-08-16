/**
 * Worker-based chunked SHA-256 for large files.
 *
 * The desk hashes evidence in this browser tab and nowhere else; for
 * multi-hundred-megabyte videos the whole-file read in deskCore would block
 * the main thread (and exhaust memory). This module mirrors the app's
 * src/lib/fileHash.ts chunked approach — 4 MiB chunks, one incremental
 * @noble/hashes SHA-256 state — but runs inside a Web Worker, reading the
 * Blob slice-by-slice so peak memory stays at one chunk. Same hash, same
 * bytes, computed off the main thread. Nothing leaves this tab.
 *
 * WIRE PROTOCOL (postMessage, structured clone):
 *
 *   request (main → worker):
 *     { blob: Blob, chunkSize?: number }     // `file` accepted as an alias
 *                                            // for `blob` (File IS a Blob)
 *
 *   messages (worker → main), in order:
 *     { type: 'progress', bytesDone: number, bytesTotal: number }  // per chunk
 *     { type: 'done',     hex: string, bytes: number }             // terminal
 *     { type: 'error',    message: string }                        // terminal
 *
 *   cancel: there is no cancel message — terminate() the worker. A
 *   terminated worker simply stops replying; hashFileInWorker's cancel()
 *   additionally rejects its promise with a 'cancelled' error so callers
 *   never hang. A cancelled hash yields NO digest: a partial hash is never
 *   reported as complete (fail closed).
 *
 * Malformed requests are answered with an 'error' message, never thrown
 * across the boundary; a chunkSize that is missing or not a finite number
 * falls back to the default rather than trusting the caller.
 *
 * Vite usage (see hashFileInWorker below):
 *   new Worker(new URL('./hashWorker.ts', import.meta.url), { type: 'module' })
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/** Default chunk size: 4 MiB, matching src/lib/fileHash.ts. */
export const HASH_CHUNK_SIZE = 4 * 1024 * 1024;

/** Sanity bounds for a caller-supplied chunkSize. */
const MIN_CHUNK_SIZE = 64 * 1024;
const MAX_CHUNK_SIZE = 64 * 1024 * 1024;

export interface HashWorkerRequest {
  blob?: Blob;
  file?: Blob;
  chunkSize?: number;
}

export interface HashWorkerProgress {
  type: 'progress';
  bytesDone: number;
  bytesTotal: number;
}

export interface HashWorkerDone {
  type: 'done';
  hex: string;
  bytes: number;
}

export interface HashWorkerError {
  type: 'error';
  message: string;
}

export type HashWorkerResponse = HashWorkerProgress | HashWorkerDone | HashWorkerError;

// ---------------------------------------------------------------------------
// Worker side. Runs ONLY inside a DedicatedWorkerGlobalScope: on the main
// thread (where the integration agent imports hashFileInWorker) this block
// is inert — importing this module never starts hashing and never touches
// a message port.
// ---------------------------------------------------------------------------

interface WorkerScope {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (msg: HashWorkerResponse) => void;
}

const workerScope: WorkerScope | null =
  typeof self !== 'undefined' && typeof window === 'undefined'
    ? (self as unknown as WorkerScope)
    : null;

if (workerScope) {
  workerScope.onmessage = async (ev: MessageEvent) => {
    try {
      const req = (ev.data ?? {}) as HashWorkerRequest;
      const blob = req.blob ?? req.file;
      if (!blob || typeof blob.size !== 'number' || typeof blob.slice !== 'function') {
        workerScope.postMessage({
          type: 'error',
          message: 'hash worker request must carry a Blob as `blob` (or `file`)',
        });
        return;
      }
      const requested = Number(req.chunkSize);
      const chunkSize = Number.isFinite(requested)
        ? Math.min(MAX_CHUNK_SIZE, Math.max(MIN_CHUNK_SIZE, Math.floor(requested)))
        : HASH_CHUNK_SIZE;

      const bytesTotal = blob.size;
      const hasher = sha256.create();
      let offset = 0;
      while (offset < bytesTotal) {
        const end = Math.min(offset + chunkSize, bytesTotal);
        // slice() bounds the read to one chunk; the whole file never lands
        // in memory at once.
        const buf = await blob.slice(offset, end).arrayBuffer();
        hasher.update(new Uint8Array(buf));
        offset = end;
        workerScope.postMessage({ type: 'progress', bytesDone: offset, bytesTotal });
      }
      workerScope.postMessage({ type: 'done', hex: bytesToHex(hasher.digest()), bytes: bytesTotal });
    } catch (e) {
      workerScope.postMessage({
        type: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Main-thread promise API.
// ---------------------------------------------------------------------------

export interface HashResult {
  hex: string;
  bytes: number;
}

export type HashProgressCallback = (progress: {
  bytesDone: number;
  bytesTotal: number;
}) => void;

/** Promise with an explicit cancel — cancel terminates the worker. */
export interface HashFilePromise extends Promise<HashResult> {
  cancel: () => void;
}

/**
 * Hash a File/Blob in a Web Worker, chunked, off the main thread.
 *
 * Resolves with { hex, bytes } on completion; rejects on a worker error,
 * a worker-reported failure, or cancel(). Cancel is terminate(): the worker
 * is destroyed mid-chunk and the promise rejects with a 'cancelled' error —
 * no partial digest ever escapes.
 */
export function hashFileInWorker(file: Blob, onProgress?: HashProgressCallback): HashFilePromise {
  const worker = new Worker(new URL('./hashWorker.ts', import.meta.url), { type: 'module' });
  let settled = false;
  let rejectPromise: (e: Error) => void = () => undefined;

  const settle = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    worker.terminate();
    fn();
  };

  const promise = new Promise<HashResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as HashWorkerResponse;
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        onProgress?.({ bytesDone: msg.bytesDone, bytesTotal: msg.bytesTotal });
      } else if (msg.type === 'done') {
        settle(() => resolve({ hex: msg.hex, bytes: msg.bytes }));
      } else if (msg.type === 'error') {
        settle(() => reject(new Error(`hash worker failed: ${msg.message}`)));
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      settle(() => reject(new Error(`hash worker error: ${ev.message ?? 'unknown'}`)));
    };
    worker.postMessage({ blob: file });
  }) as HashFilePromise;

  promise.cancel = () => {
    settle(() => rejectPromise(new Error('hashFileInWorker cancelled')));
  };
  return promise;
}
