// Source Kit 0.1.0 — OpenTimestamps anchor and queue lifecycle
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * OpenTimestamps anchor and queue lifecycle. At seal time the record's
 * payload digest (the same one the device signature signs) goes to the free
 * public calendars.
 *
 *   - online:  'pending' receipts attach to the record at once; Bitcoin
 *              confirmation lands ~1-2 h later via upgradePendingOts.
 *   - offline: the digest waits in an on-device queue file and drains when
 *              the network returns, recording the signing-to-anchor gap as
 *              queueDelayMs.
 *
 * Only the 32-byte digest leaves the device.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { bytesToHex, bytesToBase64, base64ToBytes, hexToBytes } from '../lib/bytes';
import { payloadDigest } from '../lib/sign';
import { OTS_CALENDARS, parseOtsReceipt, mergeUpgradedTimestamp } from '../lib/ots';
import { submitDigestToCalendars, fetchUpgradedReceipt } from '../lib/otsClient';
import type { AttestationRecord, OtsSubmission } from './manifest';
import { updateRecord } from '../vault/vaultFs';

const QUEUE_FILE = `${FileSystem.documentDirectory}exhibit-ots-queue.json`;

interface QueueEntry {
  digestHex: string;
  recordId: string;
  /** ISO signing time: when the digest first failed to submit. */
  queuedAt: string;
}

async function readQueue(): Promise<QueueEntry[]> {
  try {
    const info = await FileSystem.getInfoAsync(QUEUE_FILE);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(QUEUE_FILE);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueueEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(entries: QueueEntry[]): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(QUEUE_FILE, JSON.stringify(entries));
  } catch {
    // Queue loss degrades to "no ledger anchor", never to a broken capture.
  }
}

async function enqueue(digestHex: string, recordId: string): Promise<void> {
  const entries = await readQueue();
  if (entries.some((e) => e.digestHex === digestHex)) return;
  entries.push({ digestHex, recordId, queuedAt: new Date().toISOString() });
  await writeQueue(entries);
}

function toSubmissions(
  results: { calendar: string; receipt: Uint8Array }[],
  queueDelayMs?: number
): OtsSubmission[] {
  const now = new Date().toISOString();
  return results.map((r) => ({
    calendar: r.calendar,
    receipt: bytesToBase64(r.receipt),
    state: 'pending' as const,
    submittedAt: now,
    ...(queueDelayMs !== undefined ? { queueDelayMs } : {}),
  }));
}

/**
 * Anchors a freshly sealed record: submits its payload digest and attaches
 * pending receipts, or queues it when offline. Never throws; the capture is
 * already signed and complete without an anchor.
 */
export async function anchorRecordWithOts(
  recordId: string,
  record: AttestationRecord,
  calendarUrls: string[] = OTS_CALENDARS
): Promise<void> {
  try {
    const digest = payloadDigest(record);
    const digestHex = bytesToHex(digest);
    const results = await submitDigestToCalendars(digest, calendarUrls);
    if (results.length === 0) {
      await enqueue(digestHex, recordId);
      return;
    }
    const submissions = toSubmissions(results);
    await updateRecord(recordId, (r) => ({ ...r, ots: { digestHex, submissions } }));
  } catch {
    // best-effort: a failed anchor never fails the seal
  }
}

/**
 * Drains the offline queue. Called on app start and after any successful
 * network operation. Each drained digest attaches its submissions to its
 * record with the real queue delay recorded.
 */
export async function drainOtsQueue(calendarUrls: string[] = OTS_CALENDARS): Promise<void> {
  const entries = await readQueue();
  if (entries.length === 0) return;
  const remaining: QueueEntry[] = [];
  for (const entry of entries) {
    try {
      const digest = new Uint8Array(entry.digestHex.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
      const results = await submitDigestToCalendars(digest, calendarUrls);
      if (results.length === 0) {
        remaining.push(entry);
        continue;
      }
      const queueDelayMs = Math.max(0, Date.now() - Date.parse(entry.queuedAt));
      await updateRecord(entry.recordId, (r) => {
        // A later live submission may have beaten the queue: merge, don't clobber.
        const existing = r.ots?.digestHex === entry.digestHex ? (r.ots?.submissions ?? []) : [];
        const known = new Set(existing.map((s) => s.calendar));
        const fresh = toSubmissions(results, queueDelayMs).filter((s) => !known.has(s.calendar));
        return { ...r, ots: { digestHex: entry.digestHex, submissions: [...existing, ...fresh] } };
      });
    } catch {
      remaining.push(entry);
    }
  }
  await writeQueue(remaining);
}

/**
 * Upgrades a record's pending receipts by re-asking their calendars. The
 * upgrade endpoint is keyed by the commitment the pending attestation sits
 * on, not by the submitted digest, so the commitment is read out of the
 * stored receipt first. The bare continuation Timestamp that comes back is
 * spliced on (mergeUpgradedTimestamp) and re-validated before anything is
 * persisted. Returns the updated OTS set when anything changed, else null.
 */
export async function upgradePendingOts(
  recordId: string,
  record: AttestationRecord
): Promise<AttestationRecord['ots'] | null> {
  const ots = record.ots;
  if (!ots || !ots.submissions.some((s) => s.state === 'pending')) return null;
  let digest: Uint8Array;
  try {
    digest = hexToBytes(ots.digestHex);
  } catch {
    return null; // corrupt anchor set: nothing to upgrade against
  }
  let changed = false;
  const submissions = await Promise.all(
    ots.submissions.map(async (s): Promise<OtsSubmission> => {
      try {
        if (s.state !== 'pending') return s;
        const storedRaw = base64ToBytes(s.receipt);
        const storedParsed = parseOtsReceipt(storedRaw);
        const commitment = storedParsed?.attestations.find((a) => a.kind === 'pending')?.msgHex;
        if (!commitment) return s;
        const upgraded = await fetchUpgradedReceipt(commitment, s.calendar).catch(() => null);
        if (!upgraded) return s;
        const merged = mergeUpgradedTimestamp(storedRaw, upgraded, digest);
        if (!merged) return s;
        const parsed = parseOtsReceipt(merged);
        const height = parsed?.attestations.find((a) => a.kind === 'bitcoin')?.blockHeight;
        if (!height) return s;
        changed = true;
        return {
          ...s,
          receipt: bytesToBase64(merged),
          state: 'confirmed' as const,
          blockHeight: height,
          confirmedAt: new Date().toISOString(),
        };
      } catch {
        // A corrupt stored receipt stays pending and does not fail the
        // upgrade pass for the other calendars.
        return s;
      }
    })
  );
  if (!changed) return null;
  const next = { digestHex: ots.digestHex, submissions };
  await updateRecord(recordId, (r) => ({ ...r, ots: next }));
  return next;
}
