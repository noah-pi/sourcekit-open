# Capture integrity — what each signal bounds, and what it misses (0.10.0)

> **0.11.0 addendum — the binding must be signed INTO the claim (audit A-1).**
> The verifier honors a `c2pa.hash.*` assertion only when the signed claim
> references it. A binding box attached after signing — however
> self-consistent — proves nothing, and every defective-credential shape
> (unreferenced binding, malformed exclusion set, unwalkable container, no
> binding at all) reports `void-binding`: integrity UNPROVEN, defective
> credentials, never "media altered" and never INTACT. Pinned by
> `tests/test-binding-guard.mts`.

Every signal on this page is **self-reported by the capturing device** and
signed into the record. A compromised device can fabricate any of them.
Their value is *commitment under signature*: the device swore to these
numbers at this time, and a verifier can check their internal consistency.
None of them is a "real photo" verdict. There is no such verdict.

## The signed pose trace

**What it is.** A decimated, quantized window of gyroscope and fused-attitude
samples around the shutter moment, signed into the record
(`context.poseTrace` — sample count, rate, and the quantized trace itself).
Natural hand movement over a real 3D scene produces motion a desk can
cross-check against the footage: near detail should move the way the gyro
says the phone moved.

**How to review it.** A person (or the desk tool) compares the signed motion
against the media. The motion summary should show handheld-class motion for
a handheld shot; a perfectly static capture carries no motion evidence and
says so (`steady` / `insufficient-data`).

**What it misses (read this before trusting it):**
- There is **no automated verdict** from the trace — none on-device, none
  desk-side as a score. It is evidence a person weighs, never a gate.
- A determined attacker can replay a *video* of a scene (not just a still)
  and move the phone to match. The trace raises the attacker's cost; it
  does not close the analog hole.
- A static scene (tripod, distant flat vista) legitimately produces little
  motion. Absence of motion is not evidence of fraud.
- A compromised enrolled device can sign a fabricated trace outright. The
  trace is commitment under signature, not detection.

*(0.10.0 note: the trace replaced the earlier "proof clip" capture mode,
which bound the same physical phenomenon as a second media artifact. The
clip mode was removed; the trace carries the evidence as pure signed data.)*

## Shutter → signature latency

`captureIntegrity.captureToSignatureMs` — milliseconds from the shutter
moment to the record signature. Bytes altered *after* capture but *before*
sealing live in this gap, so the gap is signed and bounded (typically
seconds: hashing, embedding, Enclave signing).

**What it misses:** a compromised device reports any number it likes.
Against an honest device with a tampered pipeline (a malicious gallery
app re-saving files), it is a real bound. Against the OS itself, nothing is.

## Sensor-frame timing regularity

`captureIntegrity.sensorTiming.intervalCv` — the coefficient of variation
of inter-sample intervals in the motion feed during capture. Real sensor
delivery is slightly irregular; a synthetic feed tends to be too regular
(scripted constant interval) or too bursty (replayed bursts).

**What it misses:** this is a bounded consistency signal, not detection.
A good replay mimics irregularity. Thresholds are deliberately NOT
hard-coded into verdicts anywhere in the UI.

## The streamed capture commitment and its evidence files (1.0.0, WS1)

**What it is.** On builds carrying the CaptureKit native module, video bytes
are hashed as a stream — fixed 1 MiB chunks, constant memory — while they
are written, and the Merkle root over the chunk hashes is fixed the moment
recording stops. In this build the commitment rides in the signed record's
capture-metadata block as `context.streamedChunks` — a field of the signed
context JSON, **not yet a real JUMBF assertion in the C2PA manifest**
(SPEC-WS1 §6.4 specifies a `camera.streamedChunks` JUMBF assertion, named
**`camera.streamedChunks` — project-specific, deliberately NOT a `c2pa.*`
label**; that assertion-plumbing lands in Phase 2, and the context-block
carriage keeps the whole commitment under one signed payload until then).
Alongside, the session
writes evidence files whose on-device paths are signed into the same block
(`context.captureEvidence`): a raw LPCM audio master (16 kHz mono `.caf`,
resampled/downmixed on-device from the same native buffers that feed the
delivery track — iOS always delivers the device-native audio format, so the
canonical master format is produced by conversion), a full-rate
sensor log (100 Hz IMU + barometer + location fixes, JSONL), and — for
stills only — an 8-frame JPEG ring straddling the shutter. Evidence
collection is user-controllable (Settings → Capture evidence: ring, raw
audio master, sensor log; all on by default), and every sink is recorded in
exactly one of three states (E.04): the file's path when collected, an
explicit `null` when the sink was **enabled but failed** (an `onError`
fired), or **`never-recorded`** when the toggle was off, the sink does not
apply to the media kind (PCM on a still, ring on a video), or the CaptureKit
module was unavailable. No silent middle states — a disabled sink is never
indistinguishable from a failed one. Evidence failures never destroy the
delivery capture: photo and video always land, and the native result's
`evidenceComplete: false` says an enabled sink failed.

**What it bounds.** The commitment narrows the capture→signature gap from
the other side: the hash was fixed while the camera ran, not recomputed
later from a file that sat around. Byte equality of the finished file is
verified separately at verify time by the unchanged exclusions-based hard
binding (`c2pa.hash.bmff.v2`) — the streamed-chunks commitment is additive
to that binding, never a replacement. **Honesty about recomputation (1.0.0
audits A-03/B-5):** the Merkle leaves are ordered by the *global completion
order* of the two elementary-stream tracks (video/audio interleaved in real
time), and in this build nothing records that interleaving — not the
assertion (root + chunkCount + chunkBytes only), not the chunk events. So
**the current root is NOT desk-reproducible from the delivery file alone**:
a desk cannot re-chunk and compare, and no desk code claims to. Per-track
roots (deterministic order, fully recomputable) land in the next fix wave;
until then the root is a capture-time commitment whose independent
recomputation is pending, and truncation/tamper detection rests on the
bmff hard binding.

**The exact wire format (recorded here so the schedule, once committed, is
checkable against it).** Chunks are
fixed **1 MiB (1048576 bytes) per elementary-stream track**, tracked
separately per track over the concatenated ES byte stream; the chunk hash
input is `trackId || chunkIndex || bytes` where `trackId` is the UTF-8
string `"video"` or `"audio"` and `chunkIndex` is a **UInt64 big-endian**
counter starting at 0 **per track**. A trailing partial chunk is committed
with its actual byte count. The Merkle tree is binary over the chunk hashes
in global completion order — leaves are the raw 32-byte SHA-256 digests
(not hex), an odd leaf is promoted unchanged — and the root is emitted
hex-lowercase. The delivery
file itself is 1080p H.264/AAC at 10 Mb/s with AAC audio at the device's
native capture rate (iOS does not allow configuring the audio data output's
format; the delivery track encodes whatever the hardware delivers). The
sensor log is JSONL whose **first line is an anchor** (`{"kind":"anchor",…}`
tying the log to the session's frame-clock epoch); barometer lines use
`relAlt`/`press` fields, and location lines are fused `CLLocation` fixes
labeled as such.

**What it misses (read this before trusting it):**
- Same ceiling as everything on this page: a compromised device can
  stream-hash bytes it fabricated. Commitment under signature, not detection.
- The evidence files are inputs for desk-side analysis. There is NO
  on-device analysis of them — the camera commits, it never concludes — and
  no verdict fields exist anywhere in the record for them.
- Location samples are fused `CLLocation` fixes. iOS provides no raw GNSS
  (pseudoranges are Android-only); none is claimed.
- `mainsHz` is **region-derived** (50/60 Hz from the device region, recorded
  with the literal note `region-derived`, plus the last known exposure
  duration) — iOS exposes no anti-banding API, so nothing about measured
  flicker at capture time is claimed.
- The ring buffer is **stills-only**; video keeps no ring and the record
  says `ringBufferDir: 'never-recorded'` — a not-applicable sink, never
  mislabeled as a failure.
- Lens selection is best-effort: if the requested lens is absent on the
  hardware the session silently falls back to the wide camera, and no lens
  claim is recorded anywhere in the payload — the record says nothing rather
  than something possibly wrong.
- On the fallback camera path (simulator, older builds) all three sinks are
  stated `never-recorded` and `context.streamedChunks` is absent — disclosed
  here, never faked. Records written before 1.0.0 simply predate the block.

## Desk-side parallax flatness measurement (1.0.0, WS4)

**What it is.** A desk analyzer (`desk/src/core/parallax.ts`, CLI:
`exhibit-desk parallax <ringDir> [--sensors log.jsonl] [--json]`, analyzer
registry tier 1) that measures **scene flatness from the 8-frame pre-shutter
ring dump** (§4 above) with optional gyro rotation compensation from the
sensor log (§5.2). Feature points are tracked across the burst with the same
SAD block matcher as the desk's global-motion estimator; inter-frame
rotation is compensated — by integrated gyro when the log is present
(axis and handedness resolved once from the data; the gyro is used ONLY as a
geometric prior inside the solve, never as a second trajectory scored for
similarity), otherwise by the image fit, and large gyro-less rotation is
refused outright. After de-rotation and removal of each pair's median
(global) motion, per-track residual disparity accumulates over the burst.
The output is a **geometric measurement**: track count, inlier ratio,
best-fit planar-model residual (median/p90 px), and a depth-spread estimate
(disparity px), with `methodVersion`, `computedAt`, and inline limitations.
A real 3D scene under translation leaves disparity spread a single plane
fit cannot absorb (disparity ∝ inverse depth per track); a plane — a screen
or a print — is explained by one fit. That is a number a person weighs,
never a detector verdict.

**Design rules (G1, locked).** The analyzer is pure deterministic geometry:
- **no trained ML model and no recapture/fraud score** of any kind;
- **no metadata-statistical scoring** — EXIF and metadata distributions are
  never read;
- **no combined probability or meta-model** — output stays a measured
  quantity with stated error bounds, presented to a human examiner;
- **no per-frame probability aggregation** — the burst is used only for
  parallax geometry;
- **no dual-trajectory similarity score** — IMU data, when present, enters
  only as a geometric prior in the solve (design rule 5);
- it is named and documented as a *scene depth/flatness measurement for
  forensic review*, never "recapture detection" (design rule 6).

**Insufficient data is a first-class answer**, with the specific reason and
NO measurement numbers: fewer than 5 decodable frames; fewer than 30
full-span feature tracks; gyro absent AND large detected rotation; burst
baseline below tracker noise. An insufficient result is never a number
dressed up as evidence.

**What it misses (read this before trusting it):**
- **Corpus characterization is pending; no error rates are published.** The
  numbers are raw measurements with stated model assumptions — there is no
  calibrated threshold behind them, and none may ship until the real-corpus
  ROC lands.
- Small-baseline first-order model: the planar fit is affine in image
  position; large depth relief at a wide baseline violates the model and
  inflates the planar residual honestly (that IS the signal, but it is not
  a calibrated one).
- Block matching is integer-px: per-pair track noise is roughly ±1 px at
  the analysis raster; disparities near that floor are noise, not depth.
- Ring frames carry no timestamps; gyro alignment assumes uniform frame
  spacing ending at the last gyro sample, and says so in the limitations.
- **The sensor log is an unauthenticated sidecar in this build** (only its
  path is signed, never its bytes), so rotation compensation treats it as
  an untrusted prior: the gyro↔image agreement gate checks magnitude as
  well as direction (a forged log at a multiple of the true rate is
  refused and the analyzer falls back to the image fit), the evidence
  carries `gyroPriorAuthenticated: false`, and the limitations state that
  a crafted log can bias the measurement. Signed poseTrace binding is
  planned (WS2 Phase 2).
- A motion rig replaying a screen can produce genuine-looking parallax.
  The measurement raises review confidence; it closes nothing by itself.
  The camera commits, it never concludes; the desk measures, it never
  decides.

## RESOLVE (WS3) — what any producer's manifest carries

RESOLVE (`desk/src/core/resolve.ts`, CLI: `exhibit-desk resolve <paths...>
[--json out.json] [--trust-anchors anchors.pem --trust-list official|interim]`)
parses **any producer's C2PA manifest** via the official engine
(`@contentauth/c2pa-node@0.8.1` on node ≥ 22; `@contentauth/c2pa-wasm@0.11.1`
fallback on node 20 — the same c2pa-rs core; which one ran is printed per
run and the pins are recorded in the JSON report). It reports **what the
asset carries and what the engine said**: producer, claim version,
ingredients, signature summary, engine validation state and validation
status codes, and the trust-list basis — official TL vs frozen ITL vs none
vs unknown — disclosed **per run**. Trust material is caller-pinned and
offline; `--trust-anchors` and `--trust-list` must be given together or the
run is refused, because anchors without a declared list (or vice versa) is
an undeclared trust basis.

**Verdicts remain the policy layer's alone.** RESOLVE emits no verdict. Our
verdict codes — INTACT / CONTENT_MODIFIED / SIGNATURE_INVALID /
NO_ATTESTATION / UNSUPPORTED — are composed only by the policy layer
(`src/provenance/engine/policyLayer.ts`) from normalized engine facts, and
desk verification routes through it: engines return facts, the policy layer
decides, and for the hand-rolled engine a parity assertion (composed verdict
= archived verdict) throws loudly on any drift rather than absorbing it (the
desk intake catches that throw and quarantines the one item with a named
"internal parity failure" finding rather than aborting the batch). A
RESOLVE line saying "validation state: Valid" is the *engine's* statement,
never the desk's verdict.

**Two standing rules for consumers (1.0.0 audits M-06/M1).** Callers must
NEVER hand-compose verdicts out of `NormalizedEngineResult` fields — the
policy layer is the single verdict authority, and bypassing it (importing
an engine and reading verdicts off its facts) is a known footgun, not a
supported path. And `trustListHit` riding on a non-INTACT result is
presentational context only: a trust-list hit on a SIGNATURE_INVALID asset
describes who the broken credential chained to — it is never an upgrade,
never a badge.

**What it misses (read this before trusting it):**
- The upstream engine's trust evaluation means nothing without pinned
  anchors. With none supplied, `trustListStatus: unknown` — the signer is
  NOT shown as trusted, and that is stated, not implied.
- `trustListStatus: none` means the signer chains to neither pinned list —
  valid-but-unattributed is the honest label, never a condemnation.
- An asset with no manifest is not suspicious by itself: most of the world's
  media carries no credentials. RESOLVE says "no", and that is all it says.
- Corpus characterization pending; no error rates published.

## Signals deliberately left to the desk tool (0.9.4)

Moiré analysis (screen-refresh interference patterns), specular/flat-field
checks, and focus-consistency heuristics need pixel access and compute the
phone doesn't spend at capture time. They run desk-side on received media,
where they are presented as bounded signals with their own "what this
misses" notes — never as a fake-detector score.

## Scene depth (LiDAR) — status

Depth capture (ARKit LiDAR on Pro devices) is **designed but not shipped**:
a native depth pipeline cannot be validated without a physical Pro device,
and shipping untested hardware code would violate the rule that every UI
claim is literally true. The record schema reserves `sceneDepth`; captures
simply omit it. When a device-validated build lands, depth maps will be
signed as an additional bounded signal — with its own entry on this page.

## The signed byte boundary — which bytes a flip breaks, and which it doesn't (0.11.0)

The sections above cover capture-time signals. This one covers the container:
an external audit measured that flipping **157 specific bytes** of a signed
JPEG left it verifying INTACT, and asked whether that was a vulnerability.
Measured precisely, the answer is: it is the C2PA spec working as designed,
one byte of it was our bug (fixed), and the exact set is now enumerated here
and pinned by `tests/test-malleability.mts` so it can never silently grow.

### What the signature actually covers

Three nested commitments, no more:

1. **The COSE signature signs the claim** (its CBOR bytes are the Sig_structure
   payload). Any flip inside the claim breaks the signature.
2. **The claim hashes each assertion box's content** (its jumd description +
   data). Any flip inside an assertion — the media hash, the telemetry record,
   EXIF, identity — breaks the claim's hash table, hence the signature.
3. **The media hash binds the asset bytes** (SHA-256 over the file with the
   declared exclusion ranges). Any flip in the media outside the manifest
   region breaks the hash.

Everything outside those three commitments is **container framing** — the
envelope, not the letter. C2PA (and JUMBF beneath it, and COSE beneath that)
deliberately leaves framing unsigned so manifests can be transported,
re-wrapped, and padded without re-signing.

### The enumerated malleable set — JPEG (APP11/JUMBF)

Flipping any of these bytes changes nothing the verifier reports. Count:
**153 fixed bytes + up to 2 length low-bytes** (see the swing rule below).

| Field | Bytes | Why it is outside the hash |
|---|---|---|
| APP11 `En` (instance) | 2 | ISO 19566-5 transport framing; multi-segment reassembly metadata |
| APP11 `Z` high byte | 1 | Ignored on read (`payload[4]`); the low three bytes are NOT here — see the note below |
| store `jumb.length` (high 3 bytes) | 3 | Box lengths are parser scaffolding; see swing rule |
| store `jumd.uuid` suffix (after the `c2pa` prefix) | 12 | The JUMBF box-type UUID; the parser reads the prefix, the suffix is spec-fixed padding |
| store `jumd.label` (`c2pa`) | 5 | The store label; manifests are located by structure, not by this string |
| manifest `jumd.uuid` (`c2ma`) | 16 | The manifest box's type UUID |
| manifest `jumd.label` (`verify:urn:uuid:…`) | 49 | The manifest's instance label. Cosmetic: the claim never references it |
| claim `jumd.uuid` (`c2cl`) + `jumd.toggle` | 17 | Framing around the claim; the claim's CONTENT is signed |
| claim `cbor` leaf length (high 3) + type | 7 | The parser reads the claim by box position |
| assertions `jumd.uuid` (`c2as`) | 16 | Framing around the assertion set; each assertion's content is claim-hashed |
| signature `jumd.uuid` (`c2cs`) + `jumd.toggle` | 17 | Framing around the COSE block |
| signature `cbor` leaf length (high 3) + type | 7 | The COSE payload is located by box position |

**Swing rule (value-dependent, pinned as allowed-not-required).** The low
byte of `store jumb.length` and of the claim `cbor` leaf length is malleable
exactly when the flipped value does not truncate a box the parser needs
(flipped-larger clamps harmlessly against the container; flipped-shorter
amputates the store and fails). Which way a given byte falls depends on the
manifest's length that run — so the test pins the high 3 bytes as always
malleable and the low byte as allowed.

**The 157th byte was a bug, and is fixed.** The audit's count included the
COSE payload slot. C2PA requires a *detached* payload (CBOR null); our
parser never checked the slot, so that byte flipped freely. The verifier now
rejects any non-null payload — a non-conformant embedded payload fails
instead of being ignored. Fixed bytes: 157 → 156.

**Three more bytes left the set (156 → 153) with the 0.18.x APP11
chain-hardening.** `Z`'s low three bytes carry the packet-sequence number,
and reassembly now ENFORCES it: a chain with a gap, a duplicate, or
non-contiguous packets is stated absence, never a guess. Flipping a
sequence byte is therefore detected, and the bytes are protected. Only the
high byte — which the reader ignores — remains malleable.

### Video (BMFF uuid box)

The same store rides in a `uuid` box after `ftyp`, so the same framing
classes are malleable, plus two video-specific ones:

- **`uuid` box version/flags** (4 bytes) — transport header. The usertype,
  the `manifest` purpose string, and the merkle-offset field are all
  parser-checked and therefore protected.
- **The COSE `pad` entry** — a byte-string of zeros in the unprotected
  header, reserved deliberately so TSA tokens can be embedded later without
  shifting `mdat` chunk offsets. Spec-sanctioned slack (c2pa-rs does the
  same); it can carry arbitrary bytes but no asserted fact.
- **Timestamp-token bytes, precisely:** a flip inside a *valid* embedded
  RFC 3161 token degrades the report — trusted time is lost and the report
  says so (`verdict` stays INTACT because the byte-math is untouched; the
  `timestamps` block and the disclosed-checks list change). Bytes of a token
  that *already fails* validation are report-neutral because the token was
  contributing nothing. Neither case is silent.

The video path is pinned by the same suite (`test-malleability.mts`, BMFF
section) with a deterministic no-token build; the token-region behavior is
reproducible with `tests/tool-malleable-map.mts`.

### What an attacker gets for these bytes

They can relabel a manifest's cosmetic `urn:uuid`, perturb APP11 sequencing
metadata, or hide data in the COSE pad (a steganographic channel, not a
forgery). They **cannot** change any asserted fact — who signed, what was
signed, when it was timestamped, what the sensors reported — and they cannot
make a tampered file read as an untampered one: every byte that carries a
claim is inside the three commitments above.

This is why the README says "any edit to the signed **media** breaks the
math visibly" and points here for the container framing, rather than
claiming every byte of the file is hashed.

## Selective disclosure — the context-claim tree (1.0.0, WS2 Phase 1)

**What it is.** Alongside the media commitment, the camera commits a fixed
set of *context claims* — where, when, whose key, which sensors — into a
Merkle tree (`src/disclosure/`), and later hands out **disclosure
bundles** that open a chosen subset of those claims against the signed
root. The camera commits; it never concludes. A bundle is evidence a
verifier weighs, not a verdict.

**The three-state rule, always.** Every claim in every capture is in
exactly one of three states:

- **disclosed** — committed, and opened in this bundle (claim + salt +
  inclusion proof, all recomputed by the verifier);
- **withheld** — committed, and *absent* from this bundle. Withheld means
  ABSENT, never encrypted: the bundle carries a count, never ciphertext.
  There is nothing to decrypt because nothing was encrypted;
- **never-recorded** — declared AT COMMIT TIME in the inventory
  assertion (`camera.contextTree`, a project-specific custom label) and
  immutable after, because the inventory entries are hashed
  (`SHA-256('inventory-v1' ‖ canonical(entries))`) into a reserved
  meta-leaf at tree index 0 — the root itself binds the declaration, so
  even a count-preserving relabel (withheld ↔ never-recorded) fails the
  meta-leaf inclusion check by name (1.0.0 audits A-01/B-5). It is
  distinct from withheld in every output: no leaf exists for the claim
  and none can ever appear. Binding the root to the asset under a
  signature is still Phase 2; in Phase 1 the caller pins the root
  (`verifyBundle`'s `expectedRoot`).

**Schema and ladders.** Every capture carries the full expected claim
set — all rungs of all ladders, coarsest first: location
(`grid-region … exact`), time (`year … exact-ms`), identity
(`key-fingerprint … named`), sensor (`present`, `residual-summary` —
schema ships now, values are Phase 2), plus free-form `context.*` claims.
A claim with no data at capture is never-recorded; an expected claim that
is neither committed nor declared fails the commit with the gap named.
Time coarsening is pure prefix truncation of the exact-ms string; geohash
encoding is Phase 2, so the core accepts pre-derived rung values.

**Salts and burn.** Each leaf digest is
`SHA-256('leaf-v1' ‖ canonical(claim) ‖ salt)` with
`salt = HKDF-SHA256(masterSeed, info = 'exhibit-leaf-v1' ‖ claimId ‖ rungBE)`.
One 32-byte master seed opens any subset forever; nothing is stored per
claim **and no salt table ever exists outside transient derivation**
(1.0.0 audit A-02): `commitContext` returns root + tree + inventory only,
and `openSubset` re-derives each selected leaf's salt from the seed on
demand. The mirror image is **burn**: delete the seed and no salt is
recoverable — by anyone, including us — and there is no second copy of
the salts to scrub. An unopened leaf can never be opened again, because
the seed is the only thing `openSubset` can open with. The commitment
says "I can't", not "I won't". Bundles
already produced still verify, because an opened leaf carries everything
its verification needs: commitments close, opened evidence doesn't.
Phase 1 burn is all-or-nothing; per-claim custody is a Phase 2 design
question.

**Tree conventions.** The Merkle tree matches the capture-side streaming
tree (`StreamingHasher.swift`): raw 32-byte digests as leaves, an odd
leaf promoted unchanged, parent = `SHA-256(left ‖ right)` over pairs of
the claimId-sorted leaf set, empty tree = SHA-256 of the empty input,
lowercase-hex root. Leaf 0 is the reserved inventory meta-leaf
(`SHA-256('inventory-v1' ‖ canonical(inventoryEntries))`) — the tree
commits the declaration AND the claims; the meta-leaf is never openable
as a claim. Parents are positional, so a proof presented for the
wrong leaf index or tree size fails — the slot is bound.

**Profiles.** Bundle selection presets are named `sealed` (root +
never-recorded list only), `short` (location ≤ country, time ≤ day,
identity = key-fingerprint), `full` (everything committed), and `custom`
(an explicit claimId set carried in the bundle as `customClaimIds`).
`sealed` still verifies: it proves the
commitment exists while opening nothing. The label is **verified, never
decorative** (1.0.0 audit B-6): `verifyBundle` recomputes the expected
selection from the profile rules and names a `profile-mismatch` failure
when `opened` differs — a `short` bundle relabeled `full` fails — and any
label outside the four names fails as `unknown-profile`.

**What verification does and does not say.** `verifyBundle` recomputes
every opened leaf from its claim and salt, checks its inclusion proof
against the root, **recomputes the inventory meta-leaf from the bundle's
inventory entries and verifies ITS inclusion at tree index 0** (the root
binds the never-recorded declaration — the claims carry fixed-schema
claimIds only, never withheld values), validates the profile label, and
cross-checks the accounting (withheld count,
never-recorded list, tree size, optionally the committed inventory and an
expected root). Every failure is NAMED in the result — a flipped value,
salt, proof, index, count, declaration, or label each fails with its own
label,
and one bad leaf never poisons the leaves that check. It never renders a
verdict about the capture.

**What it misses.** Context claims are self-reported by the capturing
device, exactly like every other signal on this page: a compromised
device can commit fabricated values under a real signature. The tree
proves the device swore to these values at commit time and that a bundle
hasn't been altered since — never that the values were true. Withheld
claims are honestly unknowable from the bundle (that is the point), and
never-recorded claims are honestly absent forever.

Pinned by `tests/test-disclosure.mts` (round trip, absence of withheld
material, burn semantics, tamper naming, never-recorded immutability,
determinism, tree edge cases, sealed profile).
