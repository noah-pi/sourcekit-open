# Proof↔media recovery — matching proofs to pixels at the desk

When proof travels separately from media (hash-only claims, proof-only
bundles, de-identified copies), the desk eventually needs to answer: *which
file does this proof belong to?* This document defines the recovery index
the desk tool builds locally, and the honesty rules for matches.

## The three match grades — never merged

1. **Exact** — the media's SHA-256 equals the proof's `mediaSha256`.
   Certain. Bit-for-bit the signed file.
2. **Exact after metadata strip** — a platform removed the
   credentials in transit (APP11 segment, caBX chunk, uuid box), so the file
   reports NO_ATTESTATION on its own. When a proof bundle in the intake
   carries the detached manifest, the desk tries the asset hash with the
   manifest's own bytes excluded — exactly what the c2pa.hash.data /
   c2pa.hash.bmff.v2 exclusion construction commits to. A match is
   cryptographic, never similarity: the manifest's signature verifies AND
   its asset hash commits to these exact media bytes. For BMFF the hash
   binds absolute box offsets, so the matcher reconstructs the removed
   box's length from the store payload and tries every root-box boundary —
   a full hash evaluation per candidate, never a heuristic. Reported as its
   own grade: the file WAS altered (its metadata is gone) and the custody
   chain is intact. What does not match: recompressed or remuxed media —
   the asset hash commits to bytes, and those bytes no longer exist.
3. **Visual (pHash)** — the media was re-encoded, resized, or recompressed
   since signing (messaging apps do this silently), so the hash no longer
   matches but the perceptual hash is close. **A pHash match is a LEAD,
   never a verdict.** The UI must say "likely match — confirm visually"
   and must never render it with the same weight as an exact match.

## Index format (`verify-recovery-index/1`)

Built and stored locally by the desk tool at intake; never uploaded.

```json
{
  "format": "verify-recovery-index/1",
  "builtAt": "2026-08-03T00:00:00Z",
  "entries": [
    {
      "sha256": "<hex, exact-match key>",
      "phash": "<64-bit DCT pHash, hex>",
      "deskLabel": "desk-supplied filename or note",
      "receivedAt": "ISO-8601",
      "source": "email|shared-drive|direct",
      "proofRefs": ["<payloadDigestHex of matched proofs, if any>"]
    }
  ]
}
```

## pHash algorithm (the soft binding)

64-bit DCT perceptual hash: downscale to 32×32 grayscale, 2D DCT-II, keep
the top-left 8×8 coefficients, threshold each (except DC) against the
median, 64 bits row-major. Hamming distance ≤ 6 = "likely match, confirm
visually"; ≤ 10 = "possible — weak"; beyond = no match. These thresholds
are starting points from common practice, stated as tuning parameters, not
science; the desk UI exposes them in trust configuration.

Watermarks were evaluated and rejected: visible watermarks deface evidence,
invisible ones are stripped by the same recompressions that motivate
recovery, and both create a false sense of binding. pHash is honest
because it claims only what it is: a similarity signal.

## What the desk does with a hash-only claim

A hash-only claim (`verify-hash-claim/1`) contains no media and no record —
only hashes, times, and the signer fingerprint. Recovery against it is
exact-match only by construction (there is nothing else to compare). When
media later arrives and its SHA-256 equals the claim's `mediaSha256`, the
desk upgrades the claim to a full verification. If the media was
re-encoded in transit, the claim can never match — the desk must say so
plainly rather than approximate. This is the deliberate cost of the
source-protection primitive, and it is stated in the share sheet that
creates the claim.
