// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * OpenTimestamps network client. Accountless; the only thing that leaves the
 * device is a 32-byte SHA-256 digest. When every calendar is unreachable the
 * digest waits in the on-device queue and the wait is recorded as
 * queueDelayMs; capture is not blocked on it.
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
    // Wire body is a bare Timestamp (no MAGIC header) whose initial msg is
    // the digest; wrap it into a DetachedTimestampFile. Null when it does not
    // parse or commits to a different digest.
    const detached = ensureDetachedReceipt(digest, buf);
    if (!detached) return null;
    return { calendar: base, receipt: detached };
  });
  const settled = await Promise.all(attempts);
  return settled.filter((r): r is OtsSubmitResult => r !== null);
}

/**
 * Asks a calendar for the upgraded (Bitcoin-attested) continuation of a
 * timestamp it accepted. The endpoint is keyed by the commitment the pending
 * attestation sits on (attestation.msgHex, the msg after walking the stored
 * receipt's op chain), not the submitted digest; a digest-keyed GET answers
 * "Not found". Returns the bare Timestamp continuation, or null while pending
 * (plain-text body) or on error. Caller splices and re-validates via
 * mergeUpgradedTimestamp.
 */
export async function fetchUpgradedReceipt(
  commitmentHex: string,
  calendarBase: string,
  fetchFn: FetchFn = fetch
): Promise<Uint8Array | null> {
  const res = await withTimeout((signal) => fetchFn(`${calendarBase}/timestamp/${commitmentHex}`, { signal }), UPGRADE_TIMEOUT_MS);
  if (!res || !res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  // Shape check: a binary timestamp continuation starts with an op or an
  // attestation marker; the pending text body does not.
  if (buf.length === 0 || (buf[0] !== 0x00 && buf[0] !== 0x08 && buf[0] !== 0xf0 && buf[0] !== 0xf1 && buf[0] !== 0xff)) return null;
  return buf;
}

/**
 * Fetches the 80-byte Bitcoin block header at `height` from an Esplora-
 * compatible API (default mempool.space, public, no key). Required to
 * complete the receipt-to-blockchain binding check; offline, the receipt is
 * still internally consistent but the binding is reported as unchecked.
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
