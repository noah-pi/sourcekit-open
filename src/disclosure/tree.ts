// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Merkle tree over committed leaf digests
 * (docs/INTEGRITY.md — selective disclosure).
 *
 * Conventions match the capture-side streaming tree (exhibit-app CaptureKit
 * StreamingHasher.swift):
 *
 *   - leaves are raw 32-byte digests, never hex, inside the tree
 *   - an odd leaf is promoted unchanged to the next level
 *   - the root is emitted as lowercase hex
 *   - zero leaves gives SHA-256 of the empty input
 *   - a single leaf is its own root
 *
 * Leaves are sorted by claimId upstream (inventory.ts) and paired in that
 * order; parents are positional, parent = SHA-256(left || right). That
 * binds a leaf's slot, so a proof presented for the wrong index or the
 * wrong tree size fails.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, concatBytes, hexToBytes } from '../lib/bytes';

export interface MerkleTree {
  /** Lowercase hex root. */
  root: string;
  /** layers[0] = leaf digests (raw 32 bytes each); last layer = [root]. */
  layers: Uint8Array[][];
}

/** parent = SHA-256(left || right), positional. Matches StreamingHasher. */
export function hashPair(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(left, right));
}

/** Root of an empty tree: SHA-256 of the empty input (StreamingHasher convention). */
export const EMPTY_ROOT = bytesToHex(sha256(new Uint8Array(0)));

/**
 * Build the tree over raw 32-byte leaf digests in the given order (the
 * disclosure leaf set is sorted by claimId upstream, in inventory.ts).
 */
export function buildTree(leaves: Uint8Array[]): MerkleTree {
  for (const [i, leaf] of leaves.entries()) {
    if (!(leaf instanceof Uint8Array) || leaf.length !== 32) {
      throw new Error(`tree: leaf ${i} must be a raw 32-byte digest`);
    }
  }
  if (leaves.length === 0) return { root: EMPTY_ROOT, layers: [] };
  const layers: Uint8Array[][] = [leaves.map((l) => l.slice())];
  let level = layers[0];
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) next.push(hashPair(level[i], level[i + 1]));
      else next.push(level[i]); // odd leaf promoted unchanged
    }
    layers.push(next);
    level = next;
  }
  return { root: bytesToHex(level[0]), layers };
}

/**
 * Sibling digests (raw, bottom-up) proving the leaf at `leafIndex`.
 * A promoted odd leaf contributes no sibling at that level; the proof
 * carries one digest per level where the node was paired.
 */
export function inclusionProof(tree: MerkleTree, leafIndex: number): Uint8Array[] {
  const leafCount = tree.layers.length === 0 ? 0 : tree.layers[0].length;
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= leafCount) {
    throw new Error(`tree: no leaf at index ${leafIndex} (tree holds ${leafCount})`);
  }
  const proof: Uint8Array[] = [];
  let idx = leafIndex;
  for (let level = 0; level < tree.layers.length - 1; level++) {
    const nodes = tree.layers[level];
    const isPromotedOdd = nodes.length % 2 === 1 && idx === nodes.length - 1;
    if (!isPromotedOdd) proof.push(nodes[idx ^ 1]);
    idx = idx >> 1;
  }
  return proof;
}

/**
 * Recompute the root from a leaf digest, its proof, and its slot, and
 * compare against `root` (lowercase hex). `index` and `treeSize` pin the
 * slot, so a valid proof presented for the wrong index fails.
 */
export function verifyInclusion(
  root: string,
  leafDigest: Uint8Array,
  proof: Uint8Array[],
  index: number,
  treeSize: number
): boolean {
  if (!Number.isInteger(treeSize) || treeSize < 1) return false;
  if (!Number.isInteger(index) || index < 0 || index >= treeSize) return false;
  if (!(leafDigest instanceof Uint8Array) || leafDigest.length !== 32) return false;
  if (!/^[0-9a-f]{64}$/.test(root)) return false;

  let node = leafDigest;
  let idx = index;
  let levelSize = treeSize;
  let used = 0;
  while (levelSize > 1) {
    const isPromotedOdd = levelSize % 2 === 1 && idx === levelSize - 1;
    if (!isPromotedOdd) {
      const sibling = proof[used++];
      if (!(sibling instanceof Uint8Array) || sibling.length !== 32) return false;
      // Positional: even index is the left child, odd is the right child.
      node = idx % 2 === 0 ? hashPair(node, sibling) : hashPair(sibling, node);
    }
    idx = idx >> 1;
    levelSize = Math.ceil(levelSize / 2);
  }
  if (used !== proof.length) return false; // trailing junk in the proof
  return bytesToHex(node) === root.toLowerCase();
}

/** Hex helpers for bundle (de)serialization: proofs travel as hex arrays. */
export function proofToHex(proof: Uint8Array[]): string[] {
  return proof.map(bytesToHex);
}

export function proofFromHex(hexProof: string[]): Uint8Array[] {
  return hexProof.map((h) => hexToBytes(h));
}
