# Capture integrity — what each signal bounds, and what it misses

Every signal on this page is self-reported by the capturing device and signed
into the record. A compromised device can fabricate any of them.

What they're worth is commitment under signature: the device stated these
numbers at this time, and a verifier can check them for internal consistency
afterwards. None of them is a "this photo is real" verdict. There is no such
verdict anywhere in the app.

## The signed pose trace

A decimated, quantized window of gyroscope and fused-attitude samples from
around the shutter moment, signed into the record as `context.poseTrace` —
sample count, rate, and the trace itself.

Natural hand movement over a real 3D scene produces motion you can check
against the footage: near detail should move the way the gyro says the phone
moved. Inspect draws the trace so a person can compare the two.

What it misses:

- There is no automated verdict from the trace. It's evidence a person weighs.
- Someone can replay a video of a scene and move the phone to match. The trace
  raises the cost of that; it doesn't close it.
- A static scene — tripod, distant vista — legitimately produces little motion,
  and reports `steady` or `insufficient-data`. Absence of motion is not
  evidence of anything.
- A compromised device can sign a fabricated trace outright.

## Shutter-to-signature latency

`captureIntegrity.captureToSignatureMs` records the milliseconds between the
shutter and the record signature. Bytes altered after capture but before
sealing would live in that gap, so the gap is signed and bounded — typically a
few seconds of hashing, embedding and Enclave signing.

Against an honest device with a tampered pipeline — a gallery app re-saving
files, say — this is a real bound. Against a compromised OS it isn't, and a
compromised device reports whatever number it likes.

## Sensor-frame timing regularity

`captureIntegrity.sensorTiming.intervalCv` is the coefficient of variation of
inter-sample intervals in the motion feed during capture. Real sensor delivery
is slightly irregular. A synthetic feed tends to be too regular or too bursty.

This is a consistency signal, not detection — a good replay mimics
irregularity. No threshold on it feeds a verdict anywhere in the UI.

## The streamed capture commitment

On builds carrying the CaptureKit native module, video bytes are hashed as a
stream — fixed 1 MiB chunks, constant memory — while they're being written, and
the Merkle root over those chunk hashes is fixed the moment recording stops. It
rides in the signed record's capture-metadata block as `context.streamedChunks`.

This narrows the capture-to-signature gap from the other side: the hash was
fixed while the camera was running, not recomputed later from a file that sat
around. Byte equality of the finished file is checked separately at verify time
by the exclusions-based hard binding (`c2pa.hash.bmff.v2`). The streamed
commitment is additive to that binding, not a replacement for it.

**One limitation worth stating up front.** The Merkle leaves are ordered by the
global completion order of the video and audio tracks, interleaved in real
time, and nothing in the record captures that interleaving. So the root can't
be recomputed from the delivery file alone — you can't re-chunk and compare.
Truncation and tamper detection rest on the BMFF hard binding, not on this. The
root is a capture-time commitment whose independent recomputation isn't
possible yet.

### Wire format

Chunks are 1 MiB (1048576 bytes) per elementary-stream track, tracked
separately per track over the concatenated ES byte stream. The chunk hash input
is `trackId || chunkIndex || bytes`, where `trackId` is the UTF-8 string
`"video"` or `"audio"` and `chunkIndex` is a big-endian UInt64 starting at 0 per
track. A trailing partial chunk is committed with its actual byte count.

The Merkle tree is binary over the chunk hashes in global completion order.
Leaves are the raw 32-byte SHA-256 digests, not hex. An odd leaf is promoted
unchanged. The root is emitted lowercase hex.

The delivery file is 1080p H.264 at 10 Mb/s with AAC audio at the device's
native capture rate — iOS doesn't allow configuring the audio data output's
format, so the delivery track encodes whatever the hardware delivers.

## Evidence files

Alongside the delivery file, the session writes evidence files whose on-device
paths are signed into the same block as `context.captureEvidence`:

- **A raw LPCM audio master** — 16 kHz mono `.caf`, resampled and downmixed
  on-device from the same native buffers that feed the delivery track.
- **A full-rate sensor log** — 100 Hz IMU, barometer and location fixes, as
  JSONL. The first line is an anchor tying the log to the session's frame-clock
  epoch. Barometer lines use `relAlt` and `press`; location lines are fused
  `CLLocation` fixes, labelled as such.
- **An 8-frame JPEG ring** straddling the shutter, for stills only.

All three are switchable in Settings ▸ Capture evidence and on by default.

Each sink is recorded in exactly one of three states: the file's path when it
was collected, an explicit `null` when the sink was enabled but failed, or
`never-recorded` when the toggle was off, the sink doesn't apply to that media
kind, or CaptureKit wasn't available. A disabled sink and a failed one are
never indistinguishable.

Evidence failures don't affect the capture itself — the photo or video always
lands, and the native result's `evidenceComplete: false` reports that an
enabled sink failed.

What these miss:

- Same ceiling as everything else here: a compromised device can stream-hash
  bytes it fabricated.
- The app performs no analysis of the evidence files beyond the on-device
  parallax measurement below. There are no verdict fields for them in the
  record.
- Location samples are fused `CLLocation` fixes. iOS provides no raw GNSS —
  pseudoranges are Android-only — and none is claimed.
- `mainsHz` is derived from the device region, recorded with the literal note
  `region-derived` alongside the last known exposure duration. iOS exposes no
  anti-banding API, so nothing is claimed about measured flicker.
- The ring is stills-only. Video records `ringBufferDir: 'never-recorded'`.
- Lens selection is best-effort. If the requested lens isn't on the hardware
  the session falls back to the wide camera, and no lens claim is recorded —
  the record says nothing rather than something possibly wrong.
- On the fallback camera path — the simulator, mainly — all three sinks are
  `never-recorded` and `context.streamedChunks` is absent.

## Parallax, measured on-device

`src/components/forensic/MultipleLensCard.tsx` measures scene flatness from the
committed second view and its calibration.

Two cameras separated by a known baseline see a flat plane identically, up to a
single projective transform. They see a scene with real depth with a residual
disagreement no homography removes. The card reports a geometric measurement —
track count, inlier ratio, best-fit planar residual, depth spread — not a
score.

It is deterministic geometry. There's no trained model, no probability, and no
combined "recapture" number. Metadata distributions are never read.

Insufficient data is a first-class answer with a stated reason and no numbers:
too few decodable frames, too few full-span feature tracks, or a baseline below
tracker noise. Past a few metres disparity falls below what the baseline can
resolve, and the answer is `insufficient` rather than a pass.

What it misses:

- **No error rates are published.** These are raw measurements with stated model
  assumptions, not calibrated thresholds. Nothing should ship a number until
  there's a real-corpus characterization behind it.
- The planar fit is affine in image position. Large depth relief at a wide
  baseline violates the model and inflates the residual.
- Block matching is integer-pixel, so per-pair track noise is roughly ±1 px at
  the analysis raster. Disparities near that floor are noise.
- A motion rig replaying a screen can produce genuine-looking parallax.

## Scene depth (LiDAR)

Designed, not shipped. A native depth pipeline can't be validated without a
physical Pro device. The record schema reserves `sceneDepth` and captures omit
it.

## The signed byte boundary

Not every byte of a signed file is covered by the signature, and it's worth
being exact about which ones aren't.

### What the signature covers

Three nested commitments:

1. **The COSE signature signs the claim.** Its CBOR bytes are the Sig_structure
   payload, so any flip inside the claim breaks the signature.
2. **The claim hashes each assertion box's content** — its jumd description plus
   data. Any flip inside an assertion (the media hash, the telemetry record,
   EXIF, identity) breaks the claim's hash table, and so the signature.
3. **The media hash binds the asset bytes** — SHA-256 over the file with the
   declared exclusion ranges. Any flip in the media outside the manifest region
   breaks the hash.

Everything outside those three is container framing. C2PA, JUMBF and COSE all
leave framing unsigned deliberately, so manifests can be transported,
re-wrapped and padded without re-signing.

### The malleable set — JPEG (APP11/JUMBF)

Flipping any of these changes nothing **this** verifier reports: 153 fixed
bytes, plus up to 2 length low-bytes under the swing rule below.

The number comes from measurement, not from reading the spec.
`tests/test-malleability.mts` flips every byte of the manifest region one at a
time, re-verifies each mutated file, and records which ones still report
INTACT. It then checks both directions — every documented byte must be
malleable, and no undocumented byte may be — so the set can't silently grow.

Two limits worth stating. The measurement covers the manifest region, not the
whole file. And it is measured against this verifier only: whether `c2patool`
or another implementation would catch some of these bytes is untested here.

| Field | Bytes | Why it's outside the hash |
|---|---|---|
| APP11 `En` (instance) | 2 | ISO 19566-5 transport framing; multi-segment reassembly metadata |
| APP11 `Z` high byte | 1 | Ignored on read (`payload[4]`) |
| store `jumb.length` (high 3 bytes) | 3 | Box lengths are parser scaffolding; see the swing rule |
| store `jumd.uuid` suffix, after the `c2pa` prefix | 12 | The parser reads the prefix; the suffix is spec-fixed padding |
| store `jumd.label` (`c2pa`) | 5 | Manifests are located by structure, not by this string |
| manifest `jumd.uuid` (`c2ma`) | 16 | The manifest box's type UUID |
| manifest `jumd.label` (`verify:urn:uuid:…`) | 49 | The instance label; the claim never references it |
| claim `jumd.uuid` (`c2cl`) + `jumd.toggle` | 17 | Framing around the claim; the claim's content is signed |
| claim `cbor` leaf length (high 3) + type | 7 | The claim is read by box position |
| assertions `jumd.uuid` (`c2as`) | 16 | Framing around the set; each assertion's content is claim-hashed |
| signature `jumd.uuid` (`c2cs`) + `jumd.toggle` | 17 | Framing around the COSE block |
| signature `cbor` leaf length (high 3) + type | 7 | The COSE payload is located by box position |

**Swing rule.** The low byte of `store jumb.length` and of the claim `cbor` leaf
length is malleable exactly when the flipped value doesn't truncate a box the
parser needs: flipped larger clamps harmlessly against the container, flipped
shorter amputates the store and fails. Which way a given byte falls depends on
the manifest's length that run, so the test pins the high 3 bytes as always
malleable and the low byte as allowed.

The COSE payload slot used to be in this set. C2PA requires a detached payload
(CBOR null) and the parser didn't check the slot. It does now — a
non-conformant embedded payload fails rather than being ignored.

`Z`'s low three bytes carry the packet-sequence number, and reassembly enforces
it: a chain with a gap, a duplicate or non-contiguous packets is reported as
absence rather than guessed at. Only the high byte, which the reader ignores,
stays malleable.

### Video (BMFF uuid box)

The same store rides in a `uuid` box after `ftyp`, so the same framing classes
are malleable, plus two specific to video:

- **`uuid` box version and flags** (4 bytes) — transport header. The usertype,
  the `manifest` purpose string and the merkle-offset field are all
  parser-checked.
- **The COSE `pad` entry** — a byte string of zeros in the unprotected header,
  reserved so TSA tokens can be embedded later without shifting `mdat` chunk
  offsets. It can carry arbitrary bytes but no asserted fact. c2pa-rs does the
  same.
- **Timestamp-token bytes.** A flip inside a valid embedded RFC 3161 token
  degrades the report: trusted time is lost and the report says so. The verdict
  stays INTACT because the byte-math is untouched, but the `timestamps` block
  and the disclosed-checks list change. Bytes of a token that already fails
  validation are report-neutral, because the token was contributing nothing.
  Neither case is silent.

### What that buys an attacker

They can relabel a manifest's cosmetic `urn:uuid`, perturb APP11 sequencing
metadata, or hide data in the COSE pad — a steganographic channel, not a
forgery. They can't change any asserted fact: who signed, what was signed, when
it was timestamped, what the sensors reported. And they can't make a tampered
file read as untampered, because every byte carrying a claim sits inside the
three commitments above.

Both paths are pinned by `tests/test-malleability.mts`, so the set can't
silently grow. `tests/tool-malleable-map.mts` reproduces the token-region
behaviour.

## Selective disclosure

Alongside the media commitment, the camera commits a fixed set of context
claims — where, when, whose key, which sensors — into a Merkle tree
(`src/disclosure/`). Later you can hand out a **disclosure bundle** that opens a
chosen subset of them against the signed root.

Every claim in every capture is in exactly one of three states:

- **disclosed** — committed, and opened in this bundle: claim, salt and
  inclusion proof, all recomputed by the verifier.
- **withheld** — committed, and absent from this bundle. Withheld means absent,
  not encrypted. The bundle carries a count, never ciphertext.
- **never-recorded** — declared at commit time in the inventory assertion
  (`camera.contextTree`) and immutable afterwards. The inventory entries are
  hashed into a reserved meta-leaf at tree index 0, so the root itself binds the
  declaration and a count-preserving relabel from withheld to never-recorded
  fails the meta-leaf check by name.

### Schema

Every capture carries the full expected claim set — all rungs of all ladders,
coarsest first: location (`grid-region` … `exact`), time (`year` …
`exact-ms`), identity (`key-fingerprint` … `named`), and sensor (`present`,
`residual-summary`), plus free-form `context.*` claims. A claim with no data at
capture is never-recorded. An expected claim that is neither committed nor
declared fails the commit, with the gap named.

Time coarsening is prefix truncation of the exact-ms string. The core accepts
pre-derived rung values for location.

### Salts and burn

Each leaf digest is `SHA-256('leaf-v1' ‖ canonical(claim) ‖ salt)`, where
`salt = HKDF-SHA256(masterSeed, info = 'exhibit-leaf-v1' ‖ claimId ‖ rungBE)`.

One 32-byte master seed opens any subset, forever. Nothing is stored per claim,
and no salt table exists outside transient derivation: `commitContext` returns
the root, tree and inventory only, and `openSubset` re-derives each selected
leaf's salt from the seed on demand.

Burn is the mirror image. Delete the seed and no salt is recoverable by anyone,
and there's no second copy to scrub. An unopened leaf can never be opened
again. Bundles already produced still verify, because an opened leaf carries
everything its own verification needs.

Burn is all-or-nothing. Per-claim custody isn't implemented.

### Tree conventions

The tree matches the capture-side streaming tree in `StreamingHasher.swift`:
raw 32-byte digests as leaves, an odd leaf promoted unchanged, parent =
`SHA-256(left ‖ right)` over pairs of the claimId-sorted leaf set, empty tree =
SHA-256 of the empty input, lowercase-hex root.

Leaf 0 is the reserved inventory meta-leaf,
`SHA-256('inventory-v1' ‖ canonical(inventoryEntries))`, and is never openable
as a claim. Parents are positional, so a proof presented for the wrong leaf
index or tree size fails.

### Profiles

Selection presets are `sealed` (root and never-recorded list only), `short`
(location ≤ country, time ≤ day, identity = key-fingerprint), `full` (everything
committed) and `custom` (an explicit claimId set carried as `customClaimIds`).

`sealed` still verifies — it proves the commitment exists while opening nothing.

The label is recomputed, not taken on faith: `verifyBundle` derives the expected
selection from the profile rules and reports `profile-mismatch` when `opened`
differs, so a `short` bundle relabelled `full` fails. Any label outside the four
fails as `unknown-profile`.

### What verification says

`verifyBundle` recomputes every opened leaf from its claim and salt, checks its
inclusion proof against the root, recomputes the inventory meta-leaf from the
bundle's inventory entries and verifies its inclusion at index 0, validates the
profile label, and cross-checks the accounting — withheld count, never-recorded
list, tree size, and optionally the committed inventory and an expected root.

Every failure is named in the result. A flipped value, salt, proof, index,
count, declaration or label each fails with its own label, and one bad leaf
doesn't poison the leaves that check.

It renders no verdict about the capture.

### What it misses

Context claims are self-reported, like everything else here. A compromised
device can commit fabricated values under a real signature. The tree proves the
device stated these values at commit time and that a bundle hasn't been altered
since — not that the values were true.

Pinned by `tests/test-disclosure.mts`.
