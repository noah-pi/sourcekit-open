// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The disclosure bundle (docs/INTEGRITY.md — selective disclosure). A bundle
 * opens a subset of the committed context leaves against the signed root.
 *
 *   - Withheld means absent: a withheld leaf is not in `opened`, and the
 *     bundle carries only a count. Nothing is encrypted.
 *   - Never-recorded is separate from withheld in every output: claims
 *     declared at commit time to have no data. They have no leaves, but the
 *     declaration is committed via the inventory meta-leaf at tree index 0,
 *     and it is not part of withheldCount.
 *   - Opened leaves still verify after the master seed is burned.
 *   - verifyBundle reports named failures and the claims that verified; it
 *     draws no conclusion about the capture.
 *
 * Profiles are selection presets: sealed, short, full, custom.
 */

import { hexToBytes, bytesToHex } from '../lib/bytes';
import { rungIndex, ladderFor, type ClaimFamily } from './ladder';
import {
  DISCLOSURE_VERSION,
  inventoryDigest,
  validateClaim,
  type ContextClaim,
  type InventoryAssertion,
  type InventoryEntry,
} from './inventory';
import { deriveLeafSalt, leafDigest } from './salts';
import {
  inclusionProof,
  proofFromHex,
  proofToHex,
  verifyInclusion,
  type MerkleTree,
} from './tree';

export type DisclosureProfile = 'sealed' | 'short' | 'full' | 'custom';

export interface OpenedLeaf {
  claim: ContextClaim;
  /** 32-byte salt, lowercase hex. */
  salt: string;
  /** Sibling digests bottom-up, lowercase hex. */
  proof: string[];
  /** Index among the committed claims (0-based); tree index = +1 (meta-leaf at 0). */
  leafIndex: number;
}

export interface DisclosureBundle {
  version: typeof DISCLOSURE_VERSION;
  /** Lowercase hex Merkle root over meta-leaf + committed leaf digests. */
  root: string;
  /** Number of committed claims (the tree holds treeSize + 1 leaves). */
  treeSize: number;
  /**
   * Commit-time inventory entries bound by the root: digest =
   * SHA-256('inventory-v1' ‖ canonical(entries)) is the tree's meta-leaf at
   * index 0, proven by `inventoryProof`. Any edit to the never-recorded
   * declaration, including a count-preserving swap, fails that inclusion check.
   */
  inventoryEntries: InventoryEntry[];
  /** Inclusion proof for the inventory meta-leaf (tree index 0), hex. */
  inventoryProof: string[];
  opened: OpenedLeaf[];
  /** Committed leaves not opened here. Absent, not encrypted. */
  withheldCount: number;
  /** ClaimIds declared never-recorded at commit time (immutable). */
  neverRecorded: string[];
  /**
   * Selection preset label. Named profiles are recomputed against the opened
   * set and a mismatch fails by name; 'custom' requires `customClaimIds`.
   */
  profile?: DisclosureProfile;
  /** Required when profile === 'custom': the exact claimId set to open. */
  customClaimIds?: string[];
  createdAt: string;
}

export interface VerifyResult {
  ok: boolean;
  /** Claims whose leaf digest + inclusion proof verified against the root. */
  openedClaims: ContextClaim[];
  /** Every failure, named. */
  failures: string[];
}

/**
 * Selection presets:
 *   sealed — open nothing: root + never-recorded list only
 *   short  — location ≤ country, time ≤ day, identity = key-fingerprint only.
 *            The spec names only those three families; sensor and context
 *            stay withheld.
 *   full   — open everything committed
 *   custom — open exactly the given claimId set
 */
export function profileSelection(
  profile: DisclosureProfile,
  customIds?: Iterable<string>
): (claim: ContextClaim) => boolean {
  switch (profile) {
    case 'sealed':
      return () => false;
    case 'full':
      return () => true;
    case 'custom': {
      const ids = new Set(customIds ?? []);
      return (claim) => ids.has(claim.claimId);
    }
    case 'short': {
      const country = rungIndex('location', 'country');
      const day = rungIndex('time', 'day');
      return (claim) => {
        if (claim.family === 'location') return claim.rung <= country;
        if (claim.family === 'time') return claim.rung <= day;
        if (claim.family === 'identity') return claim.claimId === 'identity.key-fingerprint';
        return false;
      };
    }
  }
}

/**
 * Open the subset of committed leaves selected by `selection`. Salts are
 * derived from the master seed on demand for the selected leaves only; the
 * seed is the only way to open a leaf, so after a burn withheld leaves stay
 * closed.
 *
 * `inventoryEntries` is the commit-time inventory (from
 * commitContext.inventoryAssertion.entries), committed under the root via the
 * meta-leaf at tree index 0; the bundle carries it plus its inclusion proof so
 * a verifier can recheck the binding. `neverRecordedIds` is denormalized out
 * of it, sorted, for display.
 */
export function openSubset(
  tree: MerkleTree,
  leaves: ContextClaim[],
  masterSeed: Uint8Array,
  selection: (claim: ContextClaim) => boolean,
  profileName?: DisclosureProfile,
  neverRecordedIds: string[] = [],
  inventoryEntries: InventoryEntry[] = [],
  customClaimIds?: string[]
): DisclosureBundle {
  const leafCount = tree.layers.length === 0 ? 0 : tree.layers[0].length;
  if (leaves.length + 1 !== leafCount) {
    throw new Error(`bundle: tree holds ${leafCount} leaves (incl. the inventory meta-leaf) but ${leaves.length} claims were given`);
  }
  const opened: OpenedLeaf[] = [];
  for (let i = 0; i < leaves.length; i++) {
    if (!selection(leaves[i])) continue;
    opened.push({
      claim: leaves[i],
      // Derived at open time; never stored.
      salt: bytesToHex(deriveLeafSalt(masterSeed, leaves[i].claimId, leaves[i].rung)),
      proof: proofToHex(inclusionProof(tree, i + 1)),
      leafIndex: i,
    });
  }
  const bundle: DisclosureBundle = {
    version: DISCLOSURE_VERSION,
    root: tree.root,
    treeSize: leaves.length,
    inventoryEntries,
    inventoryProof: proofToHex(inclusionProof(tree, 0)),
    opened,
    withheldCount: leaves.length - opened.length,
    neverRecorded: [...neverRecordedIds].sort(),
    createdAt: new Date().toISOString(),
  };
  if (profileName !== undefined) bundle.profile = profileName;
  if (customClaimIds !== undefined) bundle.customClaimIds = [...customClaimIds].sort();
  return bundle;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Verify a disclosure bundle: recompute each opened leaf's digest from its
 * claim + salt and check its inclusion proof against the root; recompute the
 * inventory meta-leaf from the bundle's entries and check its inclusion at
 * tree index 0; validate the profile label against the opened set; cross-check
 * withheld count, never-recorded list, and tree size. Failures are named in
 * `failures` and `ok` is the absence of failures; `openedClaims` lists what
 * verified, so one tampered leaf does not poison the rest.
 *
 * `expectedRoot`, when given, pins the bundle to a root obtained elsewhere
 * (e.g. the signed manifest). `inventory`, when given, cross-checks against
 * the commit-time inventory assertion: never-recorded lists must match, opened
 * claims must be committed claims, and treeSize must equal the committed count.
 */
export function verifyBundle(
  bundle: DisclosureBundle,
  expectedRoot?: string,
  inventory?: InventoryAssertion
): VerifyResult {
  const failures: string[] = [];
  const openedClaims: ContextClaim[] = [];

  if (!bundle || typeof bundle !== 'object') {
    return { ok: false, openedClaims, failures: ['bundle is not an object'] };
  }
  if (bundle.version !== DISCLOSURE_VERSION) {
    failures.push(`unsupported-version: '${String(bundle.version)}' (this verifier reads '${DISCLOSURE_VERSION}')`);
  }
  if (typeof bundle.root !== 'string' || !HEX64.test(bundle.root)) {
    failures.push('malformed-root: root must be 64 lowercase hex characters');
  }
  if (expectedRoot !== undefined && bundle.root !== expectedRoot) {
    failures.push(`root-mismatch: bundle commits to ${String(bundle.root)}, expected ${expectedRoot}`);
  }
  if (!Number.isInteger(bundle.treeSize) || bundle.treeSize < 0) {
    failures.push(`malformed-treeSize: ${String(bundle.treeSize)}`);
  }
  if (!Array.isArray(bundle.opened)) {
    failures.push('malformed-opened: not an array');
  }
  if (!Array.isArray(bundle.neverRecorded)) {
    failures.push('malformed-neverRecorded: not an array');
  }
  if (!Array.isArray(bundle.inventoryEntries)) {
    failures.push('malformed-inventoryEntries: not an array; the root-bound inventory is required, never optional');
  }
  if (!Array.isArray(bundle.inventoryProof)) {
    failures.push('malformed-inventoryProof: not an array');
  }
  if (failures.length > 0) return { ok: false, openedClaims, failures };

  const treeSize = bundle.treeSize; // committed claims; the tree holds treeSize + 1 leaves (meta-leaf at 0)

  // --- the inventory meta-leaf: recompute + prove ---------------------
  // The digest is recomputed from the bundle's own entries, so any edit to the
  // never-recorded declaration changes it and fails the inclusion check at
  // tree index 0.
  const entries = bundle.inventoryEntries;
  let entriesWellFormed = true;
  for (const [i, e] of entries.entries()) {
    const keysOk = e && typeof e === 'object' &&
      Object.keys(e).every((k) => k === 'claimId' || k === 'family' || k === 'state');
    if (!keysOk || typeof e.claimId !== 'string' ||
        (e.state !== 'committed' && e.state !== 'never-recorded')) {
      failures.push(`inventoryEntries[${i}]: malformed entry (claimId/family/state only, state committed|never-recorded)`);
      entriesWellFormed = false;
    }
  }
  const committedEntries = entries.filter((e) => e.state === 'committed');
  const neverEntries = entries.filter((e) => e.state === 'never-recorded');
  if (committedEntries.length !== treeSize) {
    failures.push(
      `inventory-size-mismatch: treeSize ${treeSize} but the inventory lists ${committedEntries.length} committed claims`
    );
    entriesWellFormed = false;
  }
  if (entriesWellFormed) {
    let metaProof: Uint8Array[];
    try {
      metaProof = proofFromHex(bundle.inventoryProof);
    } catch {
      metaProof = [];
      failures.push('inventoryProof is not lowercase hex digests');
    }
    if (!verifyInclusion(bundle.root, inventoryDigest(entries), metaProof, 0, treeSize + 1)) {
      failures.push(
        'inventory-commitment-mismatch: the inventory entries do not recompute to the meta-leaf committed ' +
        `under ${bundle.root}; the never-recorded declaration or the committed claim set was altered after commit`
      );
    }
  }

  // --- profile label: recomputed against the opened set ----------------
  if (bundle.profile !== undefined) {
    const openedIds = new Set(bundle.opened.map((l) => l?.claim?.claimId));
    const committedIds = committedEntries.map((e) => e.claimId);
    if (bundle.profile === 'custom') {
      if (!Array.isArray(bundle.customClaimIds)) {
        failures.push("profile-mismatch: profile is 'custom' but the bundle carries no customClaimIds set");
      } else {
        const want = [...bundle.customClaimIds].sort();
        if (JSON.stringify(want) !== JSON.stringify([...openedIds].sort())) {
          failures.push(
            `profile-mismatch: profile is 'custom' but opened [${[...openedIds].sort().join(', ')}] ` +
            `does not equal customClaimIds [${want.join(', ')}]`
          );
        }
      }
    } else if (bundle.profile === 'sealed' || bundle.profile === 'short' || bundle.profile === 'full') {
      // Expected selection from the profile rules over the inventory's
      // committed claims. Entries carry no rung number, so the rung is
      // recovered from the claimId's rung name via the family ladder.
      const select = profileSelection(bundle.profile);
      const expected = committedIds.filter((id) => {
        const family = id.split('.')[0] as ClaimFamily;
        const rungName = id.split('.')[1] ?? '';
        const ladder = ladderFor(family);
        const rung = ladder.length > 0 ? ladder.indexOf(rungName) : 0;
        return select({ claimId: id, family, rung: rung < 0 ? Number.MAX_SAFE_INTEGER : rung, value: '' });
      }).sort();
      if (JSON.stringify(expected) !== JSON.stringify([...openedIds].sort())) {
        failures.push(
          `profile-mismatch: bundle is labeled '${bundle.profile}' but opens [${[...openedIds].sort().join(', ') || '(nothing)'}] ` +
          `while the '${bundle.profile}' rules select [${expected.join(', ') || '(nothing)'}]; a withheld-as-complete relabel is a named failure`
        );
      }
    } else {
      failures.push(
        `unknown-profile: '${String(bundle.profile)}' is not one of sealed|short|full|custom; no label outside that set`
      );
    }
  }

  const seenIndexes = new Set<number>();
  const seenClaims = new Set<string>();

  for (const [pos, leaf] of bundle.opened.entries()) {
    const where = `opened[${pos}]${leaf && leaf.claim ? ` ('${leaf.claim.claimId}')` : ''}`;
    let claimOk = true;
    try {
      validateClaim(leaf.claim);
    } catch (e) {
      failures.push(`${where}: malformed claim: ${(e as Error).message}`);
      claimOk = false;
    }
    if (typeof leaf.salt !== 'string' || !HEX64.test(leaf.salt)) {
      failures.push(`${where}: salt is not 32 bytes of lowercase hex`);
      claimOk = false;
    }
    if (!Number.isInteger(leaf.leafIndex) || leaf.leafIndex < 0 || leaf.leafIndex >= treeSize) {
      failures.push(`${where}: leafIndex ${String(leaf.leafIndex)} is outside the tree (size ${treeSize})`);
      claimOk = false;
    } else if (seenIndexes.has(leaf.leafIndex)) {
      failures.push(`${where}: leafIndex ${leaf.leafIndex} opened twice`);
      claimOk = false;
    }
    if (claimOk && leaf.claim) {
      if (seenClaims.has(leaf.claim.claimId)) {
        failures.push(`${where}: claim '${leaf.claim.claimId}' opened twice`);
        claimOk = false;
      }
    }
    if (!claimOk) continue;
    seenIndexes.add(leaf.leafIndex);
    seenClaims.add(leaf.claim.claimId);

    let proof: Uint8Array[];
    try {
      proof = proofFromHex(leaf.proof);
    } catch {
      failures.push(`${where}: proof is not lowercase hex digests`);
      continue;
    }
    const digest = leafDigest(leaf.claim, hexToBytes(leaf.salt));
    // Tree index = committed-claim index + 1; tree index 0 is the inventory
    // meta-leaf and is not openable as a claim.
    if (!verifyInclusion(bundle.root, digest, proof, leaf.leafIndex + 1, treeSize + 1)) {
      failures.push(
        `${where}: leaf commitment mismatch: claim+salt does not recompute to a leaf of ${bundle.root} ` +
        '(value, salt, proof, or leafIndex was altered)'
      );
      continue;
    }
    openedClaims.push(leaf.claim);
  }

  // Withheld accounting: withheld = committed and not opened. Counted only.
  const impliedWithheld = treeSize - bundle.opened.length;
  if (!Number.isInteger(bundle.withheldCount) || bundle.withheldCount !== impliedWithheld) {
    failures.push(
      `withheld-count-mismatch: declared ${String(bundle.withheldCount)}, ` +
      `but treeSize ${treeSize} minus ${bundle.opened.length} opened leaves is ${impliedWithheld}`
    );
  }

  // Never-recorded is distinct from withheld and from opened.
  const seenNever = new Set<string>();
  for (const id of bundle.neverRecorded) {
    if (seenNever.has(id)) failures.push(`never-recorded claimId '${id}' listed twice`);
    seenNever.add(id);
    if (seenClaims.has(id)) {
      failures.push(
        `never-recorded-opened-conflict: '${id}' was declared never-recorded at commit time ` +
        'but this bundle opens it; the commit-time declaration is immutable'
      );
    }
  }

  // The denormalized neverRecorded list must equal the inventory's
  // never-recorded entries, which the root binds via the meta-leaf.
  const invNeverIds = neverEntries.map((e) => e.claimId).sort();
  if (JSON.stringify([...seenNever].sort()) !== JSON.stringify(invNeverIds)) {
    failures.push(
      `never-recorded-mismatch: bundle lists [${[...seenNever].sort().join(', ')}], ` +
      `the root-bound inventory declares [${invNeverIds.join(', ')}]`
    );
  }
  // Opened claims must be committed claims in the root-bound inventory.
  for (const id of seenClaims) {
    if (!committedEntries.some((e) => e.claimId === id)) {
      failures.push(`opened claim '${id}' is not a committed claim in the root-bound inventory`);
    }
  }

  if (inventory !== undefined) {
    const invNever = inventory.entries.filter((e) => e.state === 'never-recorded').map((e) => e.claimId);
    const invCommitted = inventory.entries.filter((e) => e.state === 'committed').map((e) => e.claimId);
    const bundleNever = [...bundle.neverRecorded].sort();
    if (JSON.stringify(bundleNever) !== JSON.stringify([...invNever].sort())) {
      failures.push(
        `never-recorded-mismatch: bundle declares [${bundleNever.join(', ')}], ` +
        `the committed inventory declares [${[...invNever].sort().join(', ')}]`
      );
    }
    for (const id of seenClaims) {
      if (!invCommitted.includes(id)) {
        failures.push(`opened claim '${id}' is not a committed claim in the inventory`);
      }
    }
    if (treeSize !== invCommitted.length) {
      failures.push(`treeSize ${treeSize} does not match the inventory's ${invCommitted.length} committed claims`);
    }
  }

  return { ok: failures.length === 0, openedClaims, failures };
}
