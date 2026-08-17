// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Detached-manifest custody matching (W5.5, docs/RECOVERY.md): platforms strip
 * credentials (APP11/caBX/uuid), so the sidecar bundle is matched by exact
 * cryptographic reconstruction of the stripped bytes — never similarity. A
 * match (EXACT-AFTER-STRIP) means the signature verifies AND the asset hash
 * commits to these media bytes. Recompressed/remuxed media honestly does NOT
 * match: that falls back to pHash leads, which stay leads, never verdicts.
 */

import { sha256 } from '@noble/hashes/sha256';
import {
  parseManifestChain, verifyManifest, sha256ExcludingRanges,
  boxExcluded, u64be,
  type C2paManifest,
} from '../c2pa/c2pa';
import { parseRootBoxes } from '../c2pa/bmff';

export interface DetachedMatch {
  /** The active manifest's label, for display. */
  manifestLabel: string;
  /** COSE signature over the claim verified against the embedded cert. */
  signatureValid: boolean;
  /** Assertion hashes in the claim match the assertion boxes. */
  claimAssertionsMatch: boolean;
  /** Which exact reconstruction matched — both are cryptographic, never similarity. */
  how: 'stripped-container' | 'exclusion-ranges';
  /** Manifests in the store — update chains are normal, and said so. */
  manifestCount: number;
}

function hashMatches(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Match media bytes (typically credential-stripped) against a detached store
 * payload. Null = no exact match, which says nothing about the pixels (pHash leads).
 */
export function matchDetachedManifest(mediaBytes: Uint8Array, storePayload: Uint8Array): DetachedMatch | null {
  const chain = parseManifestChain(storePayload);
  if (!chain || chain.manifests.length === 0) return null;
  const active: C2paManifest | null = chain.manifests[chain.manifests.length - 1];
  if (!active) return null;

  // The standard verifier's asset-hash line is ignored — the media layout
  // changed, that is the premise — and replaced by exact reconstructions below.
  const v = verifyManifest(mediaBytes, active);
  if (!v.signatureValid || !v.claimAssertionsMatch) return null;

  const base = {
    manifestLabel: active.manifestLabel,
    signatureValid: v.signatureValid,
    claimAssertionsMatch: v.claimAssertionsMatch,
    manifestCount: chain.manifests.length,
  };

  if (active.hashBmff && active.hashBmff.alg === 'sha256' && active.hashBmff.exclusions.length > 0) {
    // c2pa.hash.bmff.v2 prefixes each non-excluded root box with its ABSOLUTE
    // file offset, so stripping the uuid box shifts every later offset. The
    // removed box's length is known from the store payload (45 + payload:
    // 8 header + 16 UUID + 4 version/flags + 9 "manifest\0" + 8 merkle-offset);
    // try every root-box boundary, ≤ N+1 full evaluations. Fail closed.
    const boxLen = 45 + storePayload.length;
    let boxes;
    try {
      boxes = parseRootBoxes(mediaBytes);
    } catch {
      return null; // malformed container fails closed
    }
    for (let gapBefore = 0; gapBefore <= boxes.length; gapBefore++) {
      const h = sha256.create();
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (boxExcluded(mediaBytes, b, active.hashBmff.exclusions)) continue;
        h.update(u64be(b.start + (i >= gapBefore ? boxLen : 0)));
        h.update(mediaBytes.subarray(b.start, b.start + b.size));
      }
      if (hashMatches(h.digest(), active.hashBmff.hash)) {
        return { ...base, how: 'stripped-container' };
      }
    }
    return null;
  }

  if (active.hashData && active.hashData.alg === 'sha256' && active.hashData.exclusions.length > 0) {
    // Candidate A: exact when the exclusions covered exactly the removed segment(s).
    if (hashMatches(sha256(mediaBytes), active.hashData.hash)) {
      return { ...base, how: 'stripped-container' };
    }
    // Candidate B: exclusion ranges applied to the stripped bytes — exact when nothing before the first exclusion moved.
    const recomputed = sha256ExcludingRanges(mediaBytes, active.hashData.exclusions);
    if (recomputed !== null && hashMatches(recomputed, active.hashData.hash)) {
      return { ...base, how: 'exclusion-ranges' };
    }
  }

  return null;
}
