// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Context-claim inventory (docs/INTEGRITY.md — selective disclosure).
 *
 * Every capture carries the FULL expected claim set — all rungs of all
 * fixed ladders (ladder.ts) plus any free-form `context.*` claims. Each
 * claim is in exactly one of three states, always:
 *
 *   committed       — a value was recorded and committed as a tree leaf
 *                     (it may later be disclosed or withheld per bundle)
 *   never-recorded  — declared AT COMMIT TIME in the inventory assertion;
 *                     immutable after, because the inventory entries are
 *                     hashed (`inventoryDigest`) into a reserved meta-leaf
 *                     of the tree — the root itself binds the declaration.
 *                     No leaf exists for the claim and none can ever appear.
 *   (withheld)      — not an inventory state: a committed claim that a
 *                     given disclosure bundle simply does not open.
 *                     Withheld means ABSENT from the bundle, never
 *                     encrypted.
 *
 * This module commits context claims; it never concludes anything about
 * them. No verdicts.
 */

import { sha256 } from '@noble/hashes/sha256';
import { asciiToBytes, concatBytes, utf8ToBytes } from '../lib/bytes';
import { canonicalize, type JsonValue } from '../lib/canonical';
import {
  CLAIM_FAMILIES,
  LADDERS,
  claimIdFor,
  expectedClaimIds,
  ladderFor,
  type ClaimFamily,
  type LadderedFamily,
} from './ladder';

export type { ClaimFamily } from './ladder';

export type ClaimState = 'committed' | 'never-recorded';

/**
 * A single context claim. `value` is the canonical string for this rung
 * (pre-derived by the caller; see ladder.ts coarsen). `rung` is the
 * ladder level, 0 = coarsest.
 */
export interface ContextClaim {
  claimId: string;
  family: ClaimFamily;
  rung: number;
  value: string;
}

export interface InventoryEntry {
  claimId: string;
  family: ClaimFamily;
  state: ClaimState;
}

/**
 * The assertion shape destined for the manifest, under the project-specific
 * custom label `camera.contextTree`: custom `camera.*` labels only; verdict
 * codes and the policy layer are untouched. Nothing wires it into a manifest
 * yet.
 */
export interface InventoryAssertion {
  label: 'camera.contextTree';
  version: '1.0.0-ws2';
  /** Every claim the capture accounts for, sorted by claimId. */
  entries: InventoryEntry[];
}

export const INVENTORY_LABEL = 'camera.contextTree' as const;
export const DISCLOSURE_VERSION = '1.0.0-ws2' as const;

const CLAIM_ID = /^(location|time|identity|sensor|context)\.[a-z0-9][a-z0-9-]*$/;

/** A claim object carries EXACTLY these keys — nothing else digests in. */
const CLAIM_KEYS = new Set(['claimId', 'family', 'rung', 'value']);

/**
 * The inventory meta-leaf binds the whole inventory into the root. Were the
 * root to cover only the committed claims' leaf digests, a bundle maker
 * holding the seed could reclassify a withheld claim as never-recorded. So
 * the entries (sorted by claimId) are canonicalized and hashed under their
 * own domain, and the digest rides in the tree as a distinguished meta-leaf
 * at index 0.
 */
export const INVENTORY_DIGEST_DOMAIN = 'inventory-v1';
export const INVENTORY_META_CLAIM_ID = '\x00inventory';

/**
 * inventoryDigest = SHA-256('inventory-v1' ‖ canonical(entries sorted by
 * claimId)). Recomputed identically by the committer and every verifier —
 * a count-preserving swap of the never-recorded set changes it and fails
 * the meta-leaf inclusion check by name (bundle.ts).
 */
export function inventoryDigest(entries: InventoryEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
  const canonical = canonicalize(sorted as unknown as JsonValue);
  return sha256(concatBytes(asciiToBytes(INVENTORY_DIGEST_DOMAIN), utf8ToBytes(canonical)));
}

/**
 * Validate one claim's shape: known family, well-formed claimId, rung
 * within the family ladder, and — for laddered families — the claimId
 * exactly `${family}.${rungName}` so a leaf cannot smuggle a rung name
 * that disagrees with its rung number. Throws with the reason named.
 */
export function validateClaim(claim: ContextClaim): void {
  if (!claim || typeof claim !== 'object') throw new Error('inventory: claim is not an object');
  // Schema-pinned: canonicalize serializes ALL own
  // enumerable keys, so an unexpected key would digest differently across
  // implementations of "the same" claim. Reject them outright.
  for (const k of Object.keys(claim)) {
    if (!CLAIM_KEYS.has(k)) {
      throw new Error(`inventory: claim '${(claim as ContextClaim)?.claimId}' has unexpected key '${k}'; claims carry exactly claimId/family/rung/value`);
    }
  }
  if (claim.claimId === INVENTORY_META_CLAIM_ID) {
    throw new Error('inventory: the inventory meta-leaf is reserved; it is never a claim');
  }
  if (!CLAIM_FAMILIES.includes(claim.family)) {
    throw new Error(`inventory: claim '${claim?.claimId}' has unknown family '${claim?.family}'`);
  }
  if (typeof claim.claimId !== 'string' || !CLAIM_ID.test(claim.claimId)) {
    throw new Error(`inventory: malformed claimId '${claim?.claimId}'`);
  }
  if (!claim.claimId.startsWith(claim.family + '.')) {
    throw new Error(`inventory: claimId '${claim.claimId}' does not match family '${claim.family}'`);
  }
  if (!Number.isInteger(claim.rung) || claim.rung < 0) {
    throw new Error(`inventory: claim '${claim.claimId}' has non-integer or negative rung`);
  }
  if (typeof claim.value !== 'string') {
    throw new Error(`inventory: claim '${claim.claimId}' value must be a canonical string`);
  }
  if (claim.family !== 'context') {
    const rungs = LADDERS[claim.family as LadderedFamily];
    if (claim.rung >= rungs.length) {
      throw new Error(
        `inventory: claim '${claim.claimId}' rung ${claim.rung} is past the ${claim.family} ladder (${rungs.length} rungs)`
      );
    }
    const expected = claimIdFor(claim.family as LadderedFamily, rungs[claim.rung]);
    if (claim.claimId !== expected) {
      throw new Error(`inventory: claimId '${claim.claimId}' disagrees with rung ${claim.rung} ('${expected}')`);
    }
    if (claim.claimId.split('.')[1] !== ladderFor(claim.family)[claim.rung]) {
      throw new Error(`inventory: claim '${claim.claimId}' rung name mismatch`);
    }
  }
}

/**
 * Build the sorted leaf set and the inventory assertion for a capture.
 * Pure and deterministic: same inputs → same leaves, same entries,
 * same order (sorted by claimId).
 *
 * Fixed-leaf schema: every expected claimId (all rungs of all
 * ladders) must be accounted for — present in `claims` with a value, or
 * listed in `neverRecordedIds`. Anything else throws with the gap named:
 * a capture that cannot say which state a claim is in must not commit.
 */
export function buildInventory(
  claims: ContextClaim[],
  neverRecordedIds: string[]
): { leaves: ContextClaim[]; inventoryAssertion: InventoryAssertion } {
  for (const c of claims) validateClaim(c);

  const committedIds = new Set<string>();
  for (const c of claims) {
    if (committedIds.has(c.claimId)) {
      throw new Error(`inventory: duplicate committed claim '${c.claimId}'`);
    }
    committedIds.add(c.claimId);
  }

  const neverIds = new Set<string>();
  for (const id of neverRecordedIds) {
    if (typeof id !== 'string' || !CLAIM_ID.test(id)) {
      throw new Error(`inventory: malformed never-recorded claimId '${id}'`);
    }
    if (neverIds.has(id)) {
      throw new Error(`inventory: duplicate never-recorded claimId '${id}'`);
    }
    if (committedIds.has(id)) {
      throw new Error(
        `inventory: claim '${id}' is both committed and never-recorded; the three states are exclusive`
      );
    }
    neverIds.add(id);
  }

  // Fixed leaf schema: full coverage of the expected claim set.
  const expected = expectedClaimIds();
  for (const id of expected) {
    if (!committedIds.has(id) && !neverIds.has(id)) {
      throw new Error(
        `inventory: expected claim '${id}' is unaccounted for; every rung of every ladder ` +
        'is either committed or declared never-recorded at commit time'
      );
    }
  }
  for (const id of neverIds) {
    if (!expected.includes(id)) {
      throw new Error(
        `inventory: never-recorded claimId '${id}' is not in the expected claim set; ` +
        'never-recorded is a fixed-schema declaration, not a free label'
      );
    }
  }

  const leaves = [...claims].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));

  const entries: InventoryEntry[] = [
    ...leaves.map((c): InventoryEntry => ({ claimId: c.claimId, family: c.family, state: 'committed' })),
    ...[...neverIds].map((id): InventoryEntry => ({
      claimId: id,
      family: id.split('.')[0] as ClaimFamily,
      state: 'never-recorded',
    })),
  ].sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));

  return {
    leaves,
    inventoryAssertion: { label: INVENTORY_LABEL, version: DISCLOSURE_VERSION, entries },
  };
}
