// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * WS2 Phase 1: commit + burn semantics (docs/INTEGRITY.md — selective disclosure).
 * One Merkle root commits the full claim set; leaf 0 is the inventory meta-leaf,
 * so the root binds the never-recorded declaration at commit time. No salt table
 * ever leaves this module (1.0.0 audit A-02): salts are re-derived from the master
 * seed, so burning the seed closes unopened leaves for everyone, including us
 * (SPEC §0.3). The camera commits; it never concludes — no verdicts here.
 */

import { buildInventory, inventoryDigest, type ContextClaim, type InventoryAssertion } from './inventory';
import { MASTER_SEED_BYTES, deriveLeafSalt, leafDigest } from './salts';
import { buildTree, type MerkleTree } from './tree';

/** The commit-time declaration plus the root and tree size it commits to. */
export interface CommittedInventoryAssertion extends InventoryAssertion {
  root: string;
  /** Number of COMMITTED claims (leaf count minus the meta-leaf). */
  treeSize: number;
  neverRecorded: string[];
}

export interface CommittedContext {
  /** Hex Merkle root: leaf 0 = SHA-256('inventory-v1' ‖ canonical(entries)), leaves 1..N = claim digests, claimId-sorted. */
  root: string;
  /** Committed claims, sorted by claimId. Tree index = position + 1. */
  leaves: ContextClaim[];
  /** The tree itself (digests only — no salts, no values beyond leaves). */
  tree: MerkleTree;
  inventoryAssertion: CommittedInventoryAssertion;
}

/**
 * Commit the full context-claim set under one root; buildInventory enforces
 * exact coverage of the expected claim set. Deterministic in (seed, claims,
 * declarations). No salt table is returned (1.0.0 audit A-02): salts exist
 * only as transient derivations and are re-derived from the seed at open time.
 */
export function commitContext(
  masterSeed: Uint8Array,
  claims: ContextClaim[],
  neverRecordedIds: string[]
): CommittedContext {
  if (!(masterSeed instanceof Uint8Array) || masterSeed.length !== MASTER_SEED_BYTES) {
    throw new Error(`commit: master seed must be ${MASTER_SEED_BYTES} bytes`);
  }
  const { leaves, inventoryAssertion } = buildInventory(claims, neverRecordedIds);
  const digests = leaves.map((c) => leafDigest(c, deriveLeafSalt(masterSeed, c.claimId, c.rung)));
  // The inventory meta-leaf rides at index 0: the root binds the
  // never-recorded declaration, not just the committed claims.
  const tree = buildTree([inventoryDigest(inventoryAssertion.entries), ...digests]);
  return {
    root: tree.root,
    leaves,
    tree,
    inventoryAssertion: {
      ...inventoryAssertion,
      root: tree.root,
      treeSize: leaves.length,
      neverRecorded: [...neverRecordedIds].sort(),
    },
  };
}
