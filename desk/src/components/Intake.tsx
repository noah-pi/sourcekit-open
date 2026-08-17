// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Intake — the sidebar dropzone and ingest queue. Files are checked locally
 * in THIS tab; nothing is uploaded, ever. The only network call Source Kit Desk can
 * make at all is the explicitly opt-in Bitcoin block header check in
 * Settings.
 *
 * Ingest contract (the tab must stay responsive and honest):
 *  - Every file is SHA-256 hashed in a Web Worker (4 MiB chunks, off the
 *    main thread) with a per-file progress bar and a cancel button. A
 *    cancelled hash yields NO digest — a partial hash is never reported,
 *    and a cancelled file is never added to the library (the result line
 *    says exactly what happened instead).
 *  - One file at a time (a sequential queue; parallel workers are a later
 *    tier), always async — the UI never blocks on a drop, and a drop during
 *    an active ingest simply waits its turn.
 *  - Size limits fail CLOSED with plain language: over 4 GiB is refused
 *    (use the CLI); over 1 GiB is hashed but not fully verified (the parse
 *    needs the whole file in memory); verified videos over 256 MiB keep no
 *    bytes in React state — preview plays from a lazy object URL instead.
 *  - .exhibitcase files route to the workspace-file opener, never to
 *    classification.
 *  - Every finished file gets a one-line, plain-language result; failures
 *    are stated, never swallowed.
 *
 * The item list lives in LibraryPanel; props are the narrowed
 * IntakeProps from contracts.ts.
 */
import React, { useRef, useState } from 'react';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@exhibit/lib/bytes';
import { classifyAndVerify } from '../core/deskCore';
import { intakeInWorker, type Tier0WorkerResult } from '../workers/intakeWorker';
import { buildIntakeReport } from '../core/intakeReport';
import { readByteLayer, readJpegStructure, extractEmbeddedThumbnail } from '../core/byteReads';
import {
  type DeskItem,
  MAX_INGEST_BYTES,
  FULL_VERIFY_MAX_BYTES,
  VIDEO_STATE_MAX_BYTES,
  isVideoBytes,
  videoMime,
  fmtBytes,
} from '../core/deskItem';
import type { IntakeProps } from '../contracts';
import { mkId } from '../core/util';
import '../library.css';

type Tone = 'neutral' | 'info' | 'warn' | 'bad';

interface ResultLine {
  key: string;
  tone: Tone;
  text: string;
}

interface QueueEntry {
  key: string;
  file: File;
}

interface ActiveEntry {
  name: string;
  phase: 'hashing' | 'checking';
  bytesDone: number;
  bytesTotal: number;
}

/** One calm sentence per intake outcome — never a verdict, never jargon. */
function resultFor(item: DeskItem): ResultLine {
  const key = `r-${item.id}`;
  if (item.kind === 'media' && item.report) {
    switch (item.report.verdict) {
      case 'INTACT':
        // Green is reserved for intact AND roster-trusted, which intake
        // cannot know — this line stays neutral on purpose.
        return { key, tone: 'neutral', text: `${item.name} — integrity intact; open it to see who signed, and whether you trust them` };
      case 'CONTENT_MODIFIED':
        return { key, tone: 'bad', text: `${item.name} — the bytes changed after signing; the signature no longer matches the content` };
      case 'SIGNATURE_INVALID':
        return { key, tone: 'bad', text: `${item.name} — the attestation itself does not check out (signature invalid)` };
      case 'NO_ATTESTATION':
        return { key, tone: 'neutral', text: `${item.name} — no credentials found. This is normal; most files today carry none.` };
      case 'UNSUPPORTED':
        return { key, tone: 'neutral', text: `${item.name} — credentials found in a structure this build cannot check. Unchecked — neither condemned nor endorsed.` };
      case 'NOT_JPEG':
      case 'NOT_BMFF':
        return { key, tone: 'neutral', text: `${item.name} — a container this build can't check, so it was left unchecked` };
      case 'UNREADABLE':
        return { key, tone: 'warn', text: `${item.name} — could not be read: corrupt, or not what its name suggests` };
      default:
        return { key, tone: 'neutral', text: `${item.name} — added` };
    }
  }
  if (item.kind === 'proof-bundle') {
    return { key, tone: 'info', text: `${item.name} — proof bundle added; consistency checks run when you open it` };
  }
  if (item.kind === 'hash-claim') {
    return { key, tone: 'info', text: `${item.name} — hash claim added; it can only be matched exactly` };
  }
  // Unrecognized / refused files: the item's error string is already plain
  // language — lead with its first sentence.
  const first = item.error ? item.error.split(/(?<=[.!?])\s/)[0] : 'not a checkable file type; hashed and listed so nothing is hidden';
  return { key, tone: 'warn', text: `${item.name} — ${first}` };
}

export function Intake(props: IntakeProps) {
  const [over, setOver] = useState(false);
  const [waiting, setWaiting] = useState<QueueEntry[]>([]);
  const [active, setActive] = useState<ActiveEntry | null>(null);
  const [results, setResults] = useState<ResultLine[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const waitingRef = useRef<QueueEntry[]>([]);
  const pumpingRef = useRef(false);
  const cancelHashRef = useRef<(() => void) | null>(null);

  function pushResult(line: ResultLine) {
    setResults((prev) => [...prev.slice(-19), line]);
  }

  function syncWaiting() {
    setWaiting([...waitingRef.current]);
  }

  /**
   * The same pipeline the workspace has always run — hash off-thread with
   * progress + cancel, fail-closed size limits, then classifyAndVerify —
   * with progress reported through `onProgress` and `addedAt` stamped on
   * every item that comes back. Returns null for files routed elsewhere
   * (workspace files) or cancelled before any digest existed.
   */
  async function ingestOne(
    f: File,
    onProgress: (done: number, total: number) => void,
    onPhase: (phase: ActiveEntry['phase']) => void,
    /**
     * F8: fired the moment the SHA-256 exists, so a later classification
     * failure still yields an item carrying its (exact) digest — never
     * "Could not read this file" after a successful hash.
     */
    onHashed?: (hex: string) => void,
  ): Promise<DeskItem | null> {
    const id = mkId(f.name);
    const addedAt = Date.now();

    // Fail closed on size before any byte moves — stated, never silent.
    if (f.size > MAX_INGEST_BYTES) {
      const item: DeskItem = {
        id, name: f.name, kind: 'unknown', addedAt,
        error: `over 4 GiB (${fmtBytes(f.size)}). This browser build refuses it rather than guessing; the CLI handles files this large.`,
      };
      item.intakeReport = await buildIntakeReport(item, null);
      return item;
    }

    // Workspace files are sessions, not evidence — route them to the opener.
    if (/\.exhibitcase$/i.test(f.name)) {
      props.onOpenCase(f);
      return null;
    }

    // Tier-0 first, off the main thread, with progress + cancel: the chunked
    // hash AND the byte reads (metadata/strings/JPEG structure/thumbnail)
    // run in the intake worker. Over 1 GiB is the declared hash-only path —
    // the byte reads need the whole file in memory, so they are skipped and
    // the report says so.
    const hashOnly = f.size > FULL_VERIFY_MAX_BYTES;
    let bytes: Uint8Array | null = null;
    let hex: string | null = null;
    let tier0: Tier0WorkerResult | null = null;
    if (typeof Worker !== 'undefined') {
      try {
        const hp = intakeInWorker(f, {
          runByteReads: !hashOnly,
          onProgress: (p) => onProgress(p.bytesDone, p.bytesTotal),
        });
        cancelHashRef.current = () => hp.cancel();
        const res = await hp;
        hex = res.hex;
        tier0 = res.tier0;
        onHashed?.(hex);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('cancelled')) {
          // Cancelled: NO digest, NO library item — the result line says why.
          return null;
        }
        // The worker itself failed: fall back only where memory allows.
        if (f.size > FULL_VERIFY_MAX_BYTES) {
          const item: DeskItem = {
            id, name: f.name, kind: 'unknown', addedAt,
            error: `The intake worker failed (${msg}) and at ${fmtBytes(f.size)} this file is too large to hash on the main thread — no digest was computed. The CLI hashes files of any size.`,
          };
          item.intakeReport = await buildIntakeReport(item, null);
          return item;
        }
        bytes = new Uint8Array(await f.arrayBuffer());
        hex = bytesToHex(sha256(bytes));
        onHashed?.(hex);
        // Byte reads run on the main thread in the fallback (they are
        // sub-millisecond–millisecond typed-array work — still honest, still local).
        tier0 = {
          sha256Hex: hex,
          byteReads: readByteLayer(bytes),
          jpegStructure: readJpegStructure(bytes),
          thumbnail: extractEmbeddedThumbnail(bytes),
        };
      } finally {
        cancelHashRef.current = null;
      }
    }

    if (f.size > FULL_VERIFY_MAX_BYTES) {
      const item: DeskItem = {
        id, name: f.name, kind: 'unknown', addedAt, sha256Hex: hex ?? undefined,
        error: `over 1 GiB (${fmtBytes(f.size)}): hashed, but not fully checked here (the check needs the whole file in memory — stated, not hidden). The hash shown is exact and usable for matching; the CLI checks files this large.`,
      };
      item.intakeReport = await buildIntakeReport(item, null);
      return item;
    }

    if (!bytes) {
      bytes = new Uint8Array(await f.arrayBuffer());
      if (!tier0) {
        // No-worker environment (Worker undefined): the worker hash path was
        // skipped entirely, so hash and byte reads both run here instead.
        hex ??= bytesToHex(sha256(bytes));
        if (hex) onHashed?.(hex);
        tier0 = {
          sha256Hex: hex,
          byteReads: readByteLayer(bytes),
          jpegStructure: readJpegStructure(bytes),
          thumbnail: extractEmbeddedThumbnail(bytes),
        };
      }
    }
    onPhase('checking');
    const item = (await classifyAndVerify(f.name, bytes)) as DeskItem;
    item.addedAt = addedAt;
    if (!item.sha256Hex && hex) item.sha256Hex = hex;
    // Tier-0 report: worker byte reads + main-thread canvas steps (thumbnail
    // decode/diff) + the declared-C2PA summary — computed once, cached here.
    item.intakeReport = await buildIntakeReport(item, tier0);

    // Large videos: verified, then bytes leave React state — the preview
    // plays from a lazy object URL instead of bytes-in-state.
    if (item.kind === 'media' && isVideoBytes(bytes) && f.size > VIDEO_STATE_MAX_BYTES) {
      item.objectUrl = URL.createObjectURL(f);
      item.objectMime = videoMime(bytes);
      item.bytes = undefined;
    }
    return item;
  }

  /** Sequential pump: one file at a time, always async, never racing. */
  async function pump() {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        const entry = waitingRef.current.shift();
        if (!entry) break;
        syncWaiting();
        const f = entry.file;
        const setActivePhase = (phase: ActiveEntry['phase'], bytesDone = 0, bytesTotal = f.size) =>
          setActive({ name: f.name, phase, bytesDone, bytesTotal });
        setActivePhase('hashing');
        let item: DeskItem | null = null;
        // F8: the digest, the moment it exists — so a classification failure
        // below still yields an item with its exact SHA-256.
        let hashedHex: string | null = null;
        try {
          item = await ingestOne(
            f,
            (done, total) => setActivePhase('hashing', done, total),
            (phase) => setActivePhase(phase),
            (hex) => { hashedHex = hex; },
          );
          if (item === null) {
            if (/\.exhibitcase$/i.test(f.name)) {
              pushResult({ key: `r-${entry.key}`, tone: 'info', text: `${f.name} — opened as a workspace file` });
            } else {
              // The only other null path: the hash was cancelled. NO digest
              // was computed and nothing was added — stated, never silent.
              pushResult({ key: `r-${entry.key}`, tone: 'neutral', text: `${f.name} — cancelled before hashing finished; no digest was produced and nothing was added` });
            }
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // F8: if the hash already succeeded, the item carries its digest
          // and the message says exactly which step failed — "could not
          // read" after a successful hash would be a lie.
          item = hashedHex
            ? {
                id: mkId(f.name), name: f.name, kind: 'unknown', addedAt: Date.now(),
                sha256Hex: hashedHex,
                error: `Read, but classification failed: ${msg} — the SHA-256 shown is exact and usable for matching.`,
              }
            : { id: mkId(f.name), name: f.name, kind: 'unknown', addedAt: Date.now(), error: `Could not read this file: ${msg}` };
        }
        if (item) {
          if (item.kind === 'roster') {
            props.onRosterFile(item);
            pushResult({ key: `r-${item.id}`, tone: 'info', text: `${item.name} — a Trust Roster file; its signature is checked on the way in (see the notice)` });
          } else {
            props.onAdd([item]);
            pushResult(resultFor(item));
          }
        }
        setActive(null);
      }
    } finally {
      pumpingRef.current = false;
      setActive(null);
      syncWaiting();
    }
  }

  function enqueue(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) return;
    waitingRef.current.push(...list.map((file, i) => ({ key: `q-${Date.now().toString(36)}-${i}-${file.name}`, file })));
    syncWaiting();
    void pump();
  }

  function removeWaiting(key: string) {
    const idx = waitingRef.current.findIndex((e) => e.key === key);
    if (idx >= 0) {
      const [removed] = waitingRef.current.splice(idx, 1);
      syncWaiting();
      pushResult({ key: `r-${key}`, tone: 'neutral', text: `${removed.file.name} — removed from the queue before it started` });
    }
  }

  const pct = active && active.phase === 'hashing' && active.bytesTotal > 0
    ? Math.min(100, Math.round((active.bytesDone / active.bytesTotal) * 100))
    : null;

  return (
    <div className="lib-intake">
      <div
        className={`lib-dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); enqueue(e.dataTransfer.files); }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Add files to check — drop a photo, clip, proof bundle, hash claim, or case file here, or press Enter to browse"
      >
        <strong>Drop files here, or choose files</strong>
        <span className="lib-dropzone-sub">
          Photos, clips, proof bundles, hash claims. Checked here, in this
          tab — the files never go anywhere.
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { if (e.target.files) enqueue(e.target.files); e.target.value = ''; }}
        />
      </div>

      {active && (
        <div className="lib-queue-active" role="status" aria-live="polite">
          <div className="lib-queue-name">{active.name}</div>
          {active.phase === 'hashing' ? (
            <>
              <div className="lib-queue-detail">
                Hashing… {pct !== null ? `${pct}% (${fmtBytes(active.bytesDone)} of ${fmtBytes(active.bytesTotal)})` : 'starting'}
              </div>
              <div className="lib-progress"><div style={{ width: `${pct ?? 0}%` }} /></div>
              <button className="btn secondary lib-queue-cancel" onClick={() => cancelHashRef.current?.()}>
                Cancel
              </button>
            </>
          ) : (
            <div className="lib-queue-detail">Checking…</div>
          )}
        </div>
      )}

      {waiting.length > 0 && (
        <div className="lib-queue-waiting">
          {waiting.map((e) => (
            <div key={e.key} className="lib-queue-row">
              <span className="lib-queue-row-name">{e.file.name}</span>
              <span className="lib-queue-row-state">Waiting</span>
              <button
                className="lib-queue-remove"
                aria-label={`Remove ${e.file.name} from the queue`}
                onClick={() => removeWaiting(e.key)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {results.length > 0 && (
        <div className="lib-results">
          <div className="lib-results-head">
            <span>Intake results</span>
            <button className="lib-results-clear" onClick={() => setResults([])}>Clear</button>
          </div>
          {results.map((r) => (
            <div key={r.key} className={`lib-result ${r.tone}`}>{r.text}</div>
          ))}
        </div>
      )}
    </div>
  );
}
