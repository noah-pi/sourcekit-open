// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Bitcoin beacon — a signed TIME LOWER BOUND.
 *
 * Embedding the hash of the latest known Bitcoin block in the signed payload
 * proves the signature was created AFTER that block existed: nobody can know
 * a block's hash before it is mined. This is the counterpart of the
 * OpenTimestamps anchor (which bounds time from above — the digest existed
 * before its confirmation block). Together they bracket the signing moment:
 *
 *   beacon block time  ≤  signing time  ≤  OTS confirmation time
 *
 * WHAT IT PROVES: the payload was signed no earlier than the embedded block.
 * WHAT IT DOES NOT PROVE: anything finer. The device's `observedAt` clock
 * reading is self-reported; the block hash is the only objectivity here.
 *
 * DOC-2 CONSTRAINTS (implemented, not aspirational):
 *  - NEVER a per-capture fetch. The app refreshes the cache on a jittered
 *    schedule decoupled from shutter events (app foreground + timer). At
 *    seal time the signer reads whatever is cached — fresh or stale — and
 *    the staleness is disclosed in the record (`observedAt`).
 *  - Cache aggressively: one cached tip serves every capture until the next
 *    scheduled refresh.
 *  - User-pinnable endpoint: setBeaconEndpoint overrides the default pool
 *    (a newsroom can run its own Esplora instance and pin it).
 *  - Network presence is never hidden: refreshes happen on a schedule
 *    unrelated to captures, so an observer cannot correlate a fetch with a
 *    shutter event; the record states where the tip came from (`source`).
 *  - Fail safe: no cached tip → beacon is simply absent from the record and
 *    the verifier reports that honestly. Never blocks a capture.
 */

export interface BeaconCommitment {
  chain: 'bitcoin';
  /** 64 lowercase hex chars — the block hash observed. */
  blockHash: string;
  /** Block height, monotonicity-checked against the cache. */
  blockHeight: number;
  /** When the device fetched this tip (ISO). SELF-REPORTED device clock. */
  observedAt: string;
  /** Host that served the tip (e.g. "mempool.space"). Self-reported. */
  source: string;
  /** Honesty label, matches the captureIntegrity/deviceIntegrity pattern. */
  note: 'lower-bound: signing happened after this block existed; observation time self-reported';
}

export const BEACON_NOTE: BeaconCommitment['note'] =
  'lower-bound: signing happened after this block existed; observation time self-reported';

/** Default tip endpoints (Esplora-compatible). Override with setBeaconEndpoint. */
export const DEFAULT_BEACON_ENDPOINTS = [
  'https://mempool.space',
  'https://blockstream.info',
] as const;

/** Base refresh cadence; actual delay adds uniform jitter — see nextRefreshDelayMs. */
export const BEACON_REFRESH_BASE_MS = 10 * 60 * 1000; // 10 min
export const BEACON_REFRESH_JITTER_MS = 5 * 60 * 1000; // +0–5 min

/** A cached tip older than this is reported as stale by the verifier copy. */
export const BEACON_STALE_MS = 60 * 60 * 1000; // 1 hour

interface Cache {
  blockHash: string;
  blockHeight: number;
  observedAtMs: number;
  source: string;
}

let cache: Cache | null = null;
let pinnedEndpoint: string | null = null;

/** Deterministic-shape check for a tip response. Exported for the verifier. */
export function isValidTip(blockHash: unknown, blockHeight: unknown): boolean {
  return (
    typeof blockHash === 'string' &&
    /^[0-9a-f]{64}$/.test(blockHash) &&
    typeof blockHeight === 'number' &&
    Number.isInteger(blockHeight) &&
    blockHeight >= 0 &&
    blockHeight < 100_000_000 // absurdity ceiling, not a consensus rule
  );
}

/**
 * Jittered delay until the next scheduled refresh. `rng` injectable for
 * tests (defaults to Math.random). The jitter is what decouples fetches
 * from any regular, correlatable rhythm.
 */
export function nextRefreshDelayMs(rng: () => number = Math.random): number {
  return BEACON_REFRESH_BASE_MS + Math.floor(rng() * BEACON_REFRESH_JITTER_MS);
}

/** Pin a user/newsroom endpoint (Esplora base URL). null restores defaults. */
export function setBeaconEndpoint(baseUrl: string | null): void {
  pinnedEndpoint = baseUrl ? baseUrl.replace(/\/+$/, '') : null;
}

export function beaconEndpoints(): string[] {
  return pinnedEndpoint ? [pinnedEndpoint] : [...DEFAULT_BEACON_ENDPOINTS];
}

/** Whatever is cached right now — fresh or stale. Null when never fetched. */
export function currentBeacon(nowMs: number = Date.now()): BeaconCommitment | null {
  if (!cache) return null;
  return {
    chain: 'bitcoin',
    blockHash: cache.blockHash,
    blockHeight: cache.blockHeight,
    observedAt: new Date(cache.observedAtMs).toISOString(),
    source: cache.source,
    note: BEACON_NOTE,
  };
}

/** Test hook: reset module state. */
export function resetBeaconForTests(): void {
  cache = null;
  pinnedEndpoint = null;
}

/**
 * Fetch the current tip and update the cache. Tries each endpoint in order;
 * a tip that fails shape validation or REGRESSES in height is refused (a
 * hostile or broken endpoint cannot move the lower bound backwards). Never
 * throws — returns null on total failure; the absence is disclosed, not
 * hidden.
 */
export async function refreshBeacon(
  fetchImpl: typeof fetch = fetch,
  nowMs: number = Date.now()
): Promise<BeaconCommitment | null> {
  for (const base of beaconEndpoints()) {
    try {
      const [hashRes, heightRes] = await Promise.all([
        fetchImpl(`${base}/api/blocks/tip/hash`),
        fetchImpl(`${base}/api/blocks/tip/height`),
      ]);
      if (!hashRes.ok || !heightRes.ok) continue;
      const blockHash = (await hashRes.text()).trim().toLowerCase();
      const blockHeight = Number((await heightRes.text()).trim());
      if (!isValidTip(blockHash, blockHeight)) continue;
      if (cache && blockHeight < cache.blockHeight) continue; // refuse regression
      const source = base.replace(/^https?:\/\//, '');
      cache = { blockHash, blockHeight, observedAtMs: nowMs, source };
      return currentBeacon(nowMs);
    } catch {
      // endpoint failed — fall through to the next one
    }
  }
  return null;
}
