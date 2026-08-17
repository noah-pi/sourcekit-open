// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Desk item extensions + ingest limits.
 *
 * The desk's standing rule is "nothing leaves this tab" — but "stays in the
 * tab" also means "doesn't exhaust the tab". Multi-hundred-megabyte videos
 * must never be read whole into React state; these constants make the memory
 * contract explicit and every limit below fails CLOSED with a plain-language
 * message, never a silent truncation:
 *
 *  - MAX_INGEST_BYTES: above this the desk refuses the file outright and
 *    points at the CLI (stated, not hidden).
 *  - FULL_VERIFY_MAX_BYTES: above this the file is hashed (in the worker,
 *    off the main thread) but NOT parsed for verification — the parse needs
 *    the whole file in memory, and pretending otherwise would be dishonest.
 *  - VIDEO_STATE_MAX_BYTES: above this a verified video's bytes are dropped
 *    from React state after verification; preview plays from a lazy object
 *    URL. Exact-after-strip custody matching needs bytes in memory, so it is
 *    disclosed as not-run for these items (the asset dashboard says so).
 */

import type { IntakeItem } from './deskCore';
import type { CachedSignalRow, IntakeReport, Tier2FxCache } from '../contracts-ext';

/** An intake item plus the desk-local, non-serializable extras. */
export interface DeskItem extends IntakeItem {
  /**
   * When the item entered this workspace (epoch ms), set by Intake (and by
   * case restore at restore time). Drives the library's "added" display and
   * newest/oldest sort. Local metadata — never part of any verification.
   */
  addedAt: number;
  /** Lazy preview URL for large videos whose bytes are not held in state. */
  objectUrl?: string;
  /** MIME for the objectUrl preview. */
  objectMime?: string;
  /**
   * The Tier-0 intake record (ARCHITECTURE §3.3): computed once at intake
   * and cached here so the dashboard renders without recomputing. Plain
   * serializable data — it survives kept-item storage intact.
   */
  intakeReport?: IntakeReport | null;
  /**
   * Cached Tier-1 analyzer rows (Signals tab). A completed run is patched
   * back onto the item via onItemPatched so a re-opened tab shows the same
   * numbers without re-decoding anything.
   */
  tier1Signals?: CachedSignalRow[] | null;
  /**
   * Cached Tier-2 forensic results (Forensics tab). Same caching contract
   * as tier1Signals: a completed ad-hoc run is patched back onto the item
   * so a re-opened tab shows the same result without recomputing.
   */
  tier2Fx?: Tier2FxCache | null;
}

/** 4 GiB — the desk's single-file ceiling in this browser build. */
export const MAX_INGEST_BYTES = 4 * 1024 ** 3;

/** 1 GiB — above this: hash-only, no full verification in the browser. */
export const FULL_VERIFY_MAX_BYTES = 1024 ** 3;

/** 256 MiB — above this a video's bytes leave React state after verification. */
export const VIDEO_STATE_MAX_BYTES = 256 * 1024 ** 2;

/** BMFF brands: 'ftyp' at offset 4 — same probe deskCore uses. */
export function isVideoBytes(bytes: Uint8Array): boolean {
  return bytes.length > 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
}

/** MP4-compatible by default; 'qt  ' brand → quicktime (same rule as deskCore). */
export function videoMime(bytes: Uint8Array): string {
  return bytes[8] === 0x71 && bytes[9] === 0x74 ? 'video/quicktime' : 'video/mp4';
}

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}
