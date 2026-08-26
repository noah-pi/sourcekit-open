// Source Kit 0.1.0 — bitcoin beacon: a signed time lower bound
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Bitcoin beacon: a signed time lower bound. The hash of the latest known
 * block, embedded in the signed payload, proves the signature was made after
 * that block was mined. With the OpenTimestamps anchor bounding from above:
 *
 *   beacon block time  ≤  signing time  ≤  OTS confirmation time
 *
 * It proves nothing finer; `observedAt` is the device's own clock reading.
 *
 * Refresh is a jittered schedule (app foreground + timer), not a per-capture
 * fetch, so network activity cannot be correlated with a shutter event. One
 * cached tip serves every capture until the next refresh; seal time reads
 * whatever is cached, fresh or stale, and the record carries `observedAt` and
 * `source`. setBeaconEndpoint pins a newsroom's own Esplora instance. With no
 * cached tip the beacon is omitted from the record and capture continues.
 */

export interface BeaconCommitment {
  chain: 'bitcoin';
  /** 64 lowercase hex chars — the block hash observed. */
  blockHash: string;
  /** Block height, monotonicity-checked against the cache. */
  blockHeight: number;
  /** When the device fetched this tip (ISO), from the self-reported device clock. */
  observedAt: string;
  /** Host that served the tip (e.g. "mempool.space"). Self-reported. */
  source: string;
  /** Disclosure label carried in the record, as with captureIntegrity/deviceIntegrity. */
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
 * Jittered delay until the next scheduled refresh; `rng` is injectable for
 * tests. The jitter keeps fetches off a correlatable rhythm.
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
 * Fetches the current tip and updates the cache, trying each endpoint in
 * order. A tip that fails shape validation or regresses in height is refused,
 * so a hostile or broken endpoint cannot move the lower bound backwards.
 * Never throws; returns null when every endpoint fails.
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
      // Endpoint failed; try the next one.
    }
  }
  return null;
}
