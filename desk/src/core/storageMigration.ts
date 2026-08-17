// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * storageMigration.ts — the verifyDesk.* → exhibitC.* localStorage rename
 * (ARCHITECTURE §7), as a pure function so it is testable without a browser.
 *
 * Rules, exactly as specified:
 *  - For each KNOWN legacy key: if the new key is absent and the legacy key
 *    is present, copy the value over, then remove the legacy key.
 *  - Unknown legacy keys are left untouched (read-only fallback).
 *  - Runs once, on App mount, before any persisted state is read.
 */

/** Every localStorage key Source Kit Desk owns carries this prefix — the wipe control removes exactly these and nothing else. */
export const LS_PREFIX = 'exhibitC.';

export const LS_KEYS = {
  rosters: 'exhibitC.rosters.v1',
  thresholds: 'exhibitC.thresholds.v1',
  /** W3: user-declared connector endpoints (Settings → connectors card). */
  connectors: 'exhibitC.connectors.v1',
  // No `online` key: the online-checks opt-in is session-only by design —
  // it is never persisted, so there is nothing to store or migrate.
} as const;

/**
 * The keys the legacy build wrote. Anything else under the old prefix is
 * not ours to move. The legacy `verifyDesk.online.v1` is deliberately NOT
 * carried over: online checks are session-only now, and migrating a network
 * opt-in forward would turn the network on without a fresh decision.
 */
const LEGACY_MAP: ReadonlyArray<readonly [string, string]> = [
  ['verifyDesk.rosters.v1', LS_KEYS.rosters],
  ['verifyDesk.thresholds.v1', LS_KEYS.thresholds],
];

/** The subset of the Storage interface the migration needs (mockable). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Copy-and-remove migration. Returns the legacy keys that were migrated
 * (empty when there was nothing to do) so the caller can write an audit
 * entry (`storage-migrated`). Never throws on a single bad key — one
 * unreadable legacy value must not block the app from opening.
 */
export function migrateLocalStorage(storage: StorageLike): string[] {
  const migrated: string[] = [];
  for (const [oldKey, newKey] of LEGACY_MAP) {
    try {
      if (storage.getItem(newKey) !== null) continue; // a value under the new key wins; the legacy key is left alone
      const legacy = storage.getItem(oldKey);
      if (legacy === null) continue;
      storage.setItem(newKey, legacy);
      storage.removeItem(oldKey);
      migrated.push(oldKey);
    } catch {
      // Fail open per key: a half-migrated preference is recoverable; a
      // crashed app is not. The legacy key stays if the copy failed.
    }
  }
  return migrated;
}
