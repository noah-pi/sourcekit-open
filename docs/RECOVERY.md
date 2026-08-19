# Matching a proof back to its media

Proof sometimes travels separately from the file: a detached manifest, a
hash-only claim, a de-identified copy. Or a platform strips the credentials in
transit, which most of them do. In all of those cases something has to answer
which file a given proof belongs to.

There are three ways to answer that, and they are not interchangeable.

## Exact

The media's SHA-256 equals the proof's `mediaSha256`. Certain — bit for bit the
signed file.

## Exact after a metadata strip

A platform removed the credentials — the APP11 segment, the `caBX` chunk, the
BMFF `uuid` box — so the file reports NO_ATTESTATION on its own even though
nothing about the picture changed.

When a detached manifest is available, `src/provenance/detached.ts`
reconstructs the stripped bytes and re-evaluates the hash. This is
cryptographic, not similarity: a match means the signature verifies *and* the
asset hash commits to these exact media bytes, which is what the
`c2pa.hash.data` and `c2pa.hash.bmff.v2` exclusion construction commits to.

For BMFF the hash binds absolute box offsets, so the matcher reconstructs the
removed box's length from the store payload and tries every root-box boundary —
a full hash evaluation per candidate, not a heuristic.

It reports its own grade, because both halves are true: the file *was* altered,
its metadata is gone, and the custody chain is intact.

Recompressed or remuxed media does not match this way. The asset hash commits
to bytes, and those bytes no longer exist.

## Visual, by perceptual hash — the primitive, not a feature

The media was re-encoded, resized or recompressed since signing — messaging apps
do this silently — so the hash no longer matches but the perceptual hash is
close.

**The app does not do this comparison.** It computes the perceptual hash and
commits it, so the material for a visual match travels with the file and sits in
the vault index, but nothing in the app compares two hashes or surfaces a
likely-match result. `hammingDistanceHex` exists in `src/lib/phash.ts` and is
called by nothing. Building the comparison is left to whoever needs it.

If you do build it: **a pHash match is a lead.** Anything showing one has to say
"likely match, confirm visually" and must not render it with the weight of an
exact match.

### The recipe

`src/lib/phash.ts`: downscale to 32×32 grayscale, 2D DCT-II, keep the top-left
8×8 coefficients, threshold each against their median with DC excluded, read 64
bits row-major.

Hamming distance ≤ 6 would read as a likely match and ≤ 10 as possible and weak.
Those numbers are starting points from common practice rather than calibrated
results, and nothing in the app enforces them — they are a suggestion to whoever
implements the comparison, not a shipped threshold.

Each photo carries two copies. One is computed pre-signing and embedded in the
manifest as a `c2pa.soft-binding` assertion, so it travels with the file under
the claim signature. The vault index keeps its own as a cross-check and for
local search.

Watermarking was considered instead and rejected: visible marks deface the
evidence, invisible ones are stripped by the same recompressions that make
recovery necessary in the first place, and both suggest a binding that isn't
there. A pHash is honest because it only ever claims to be a similarity signal.

## Hash-only claims

A hash-only claim (`verify-hash-claim/1`, built in `src/lib/proofBundle.ts`)
carries no media and no record — only hashes, times and the signer fingerprint.
It's the source-protection primitive: you can prove a file existed and was
sealed without handing over the file.

Recovery against one is exact-match only, because there's nothing else to
compare. When matching media turns up later, the claim upgrades to a full
verification. If the media was re-encoded in transit, the claim can never match
it, and the honest answer is to say so rather than approximate.

That cost is stated in the share sheet that creates the claim.
