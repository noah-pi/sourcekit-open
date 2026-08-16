/**
 * OpenTimestamps network client — hash-only, accountless, free.
 *
 * What leaves the device: a 32-byte SHA-256 digest. Never media, never the
 * record, never a key. Calendars are public goods run by the OTS project
 * and volunteers; if all are down the digest waits in the on-device queue
 * and the delay is recorded in the record (queueDelayMs) — the capture is
 * never blocked on time evidence.
 */

import { OTS_CALENDARS, ensureDetachedReceipt } from './ots';

const SUBMIT_TIMEOUT_MS = 6000;
const UPGRADE_TIMEOUT_MS = 8000;

type FetchFn = typeof fetch;

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await p(ctl.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export interface OtsSubmitResult {
  calendar: string;
  receipt: Uint8Array;
}

/**
 * Submits `digest` to every calendar concurrently; returns the receipts
 * that parse and commit to this digest. Empty array when fully offline.
 */
export async function submitDigestToCalendars(
  digest: Uint8Array,
  calendarUrls: string[] = OTS_CALENDARS,
  fetchFn: FetchFn = fetch
): Promise<OtsSubmitResult[]> {
  const attempts = calendarUrls.map(async (base): Promise<OtsSubmitResult | null> => {
    const res = await withTimeout(
      (signal) => fetchFn(`${base}/digest`, { method: 'POST', body: digest as unknown as BodyInit, signal }),
      SUBMIT_TIMEOUT_MS
    );
    if (!res || !res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    // The wire body is a BARE Timestamp (no MAGIC header) whose initial msg
    // is our digest — wrap it into a DetachedTimestampFile; null when the
    // result doesn't parse or commits to a different digest.
    const detached = ensureDetachedReceipt(digest, buf);
    if (!detached) return null;
    return { calendar: base, receipt: detached };
  });
  const settled = await Promise.all(attempts);
  return settled.filter((r): r is OtsSubmitResult => r !== null);
}

/**
 * Asks a calendar for the upgraded (Bitcoin-attested) continuation of a
 * timestamp it previously accepted. The endpoint is keyed by the COMMITMENT
 * the pending attestation sits on — the msg after walking the stored
 * receipt's op chain (attestation.msgHex), NOT the originally submitted
 * digest; a digest-keyed GET is answered "Not found" and the upgrade never
 * lands.
 *
 * Returns the raw response (a bare Timestamp continuation, per
 * opentimestamps-server) or null while still pending (the calendar answers
 * with a plain-text "Pending confirmation…" body then) or on any error.
 * The caller splices and re-validates (mergeUpgradedTimestamp).
 */
export async function fetchUpgradedReceipt(
  commitmentHex: string,
  calendarBase: string,
  fetchFn: FetchFn = fetch
): Promise<Uint8Array | null> {
  const res = await withTimeout((signal) => fetchFn(`${calendarBase}/timestamp/${commitmentHex}`, { signal }), UPGRADE_TIMEOUT_MS);
  if (!res || !res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  // Cheap shape check: a binary timestamp continuation starts with an op or
  // an attestation marker; the text "still pending" body does not.
  if (buf.length === 0 || (buf[0] !== 0x00 && buf[0] !== 0x08 && buf[0] !== 0xf0 && buf[0] !== 0xf1 && buf[0] !== 0xff)) return null;
  return buf;
}

/**
 * Fetches the 80-byte Bitcoin block header at `height` from an Esplora-
 * compatible API (default mempool.space — public, no key). This is the ONLY
 * way to complete the receipt↔blockchain binding check; without network the
 * receipt is internally consistent but the binding is stated as unchecked.
 */
export async function fetchBlockHeader(
  height: number,
  esploraBase = 'https://mempool.space/api',
  fetchFn: FetchFn = fetch
): Promise<Uint8Array | null> {
  const hashRes = await withTimeout((signal) => fetchFn(`${esploraBase}/block-height/${height}`, { signal }), UPGRADE_TIMEOUT_MS);
  if (!hashRes || !hashRes.ok) return null;
  const hash = (await hashRes.text()).trim();
  const headRes = await withTimeout((signal) => fetchFn(`${esploraBase}/block/${hash}/header`, { signal }), UPGRADE_TIMEOUT_MS);
  if (!headRes || !headRes.ok) return null;
  const hex = (await headRes.text()).trim();
  if (!/^[0-9a-fA-F]{160}$/.test(hex)) return null;
  const out = new Uint8Array(80);
  for (let i = 0; i < 80; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
