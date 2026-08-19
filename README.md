<p align="center">
  <img src=".github/banner.svg" alt="Source Kit — an open cryptographic camera" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1F6B45?style=flat-square"></a>
  <a href=".github/workflows/ci.yml"><img alt="CI" src="https://github.com/noah-pi/sourcekit-open/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Opens in c2patool" src="https://img.shields.io/badge/C2PA-opens%20in%20c2patool-1F6B45?style=flat-square">
  <img alt="Platform iOS" src="https://img.shields.io/badge/platform-iOS-6E6E73?style=flat-square">
  &nbsp;<a href="https://testflight.apple.com/join/cRuRw2MN"><b>Try it on TestFlight →</b></a>
  &nbsp;<a href="https://noah-pi.github.io/sourcekit-open/"><b>Deep dive →</b></a>
</p>

---

# Fuck deepfakes. Prove your work.

**Source Kit is a cryptographic camera app that embeds each photo and video with a signed
record of how it was made** — which device, which instant, what the sensors read, what a
second lens saw — so anyone can check later where a file came from and what has happened to
it since.

The record is signed and sealed into the file at the moment of capture, as a standard C2PA
manifest. It works without a network, and it can be checked with any C2PA tool.

**Download the beta:
[testflight.apple.com/join/cRuRw2MN](https://testflight.apple.com/join/cRuRw2MN)** ·
[Deep dive →](https://noah-pi.github.io/sourcekit-open/)

Secure Enclave and App Attest need real hardware. The simulator falls back to a software key
and says so.

## An open source proof-of-concept

All of Source Kit's code is published under Apache-2.0. I'm a journalist turned product
designer, not a cryptographer or a career engineer. Everything is here — camera,
cryptography, native modules, interface, test suite.

## What it commits

All of it optional, all of it switchable in the viewfinder, all of it readable by any C2PA tool.

<details>
<summary><b>A second lens</b> — the cheapest counter to photographing a screen</summary>

Nearly every flagship ships a multi-camera array, and almost nothing uses the second one for
provenance. Source Kit seals a simultaneous downsampled ultra-wide frame into the same file,
as a C2PA ingredient with relationship `componentOf`. Open the photo in any C2PA reader and
the second viewpoint is there.

An ultra-wide sees far more of the room than the frame you composed. A monitor bezel, the
edge of a laptop, the glow off an OLED panel — all of it lands in the second view.

Past that, the geometry. Two lenses a known distance apart see a flat plane identically and a
real scene with a disagreement no homography removes. The frame and the calibration are both
committed, so anyone can measure that residual themselves. Beyond a few metres the answer is
*insufficient*, never *passed*.

Status: the verification side is lab-tested. The capture path has not been confirmed in the
field on iPhone 17 hardware.
[`src/provenance/stereoGlue.ts`](src/provenance/stereoGlue.ts)

</details>

<details>
<summary><b>The motion of the phone</b> — hard to fake consistently with the footage</summary>

A window of gyroscope and attitude samples from around the shutter, signed into the record
and drawn against the optical flow of the frames themselves. Near detail should move the way
the gyro says the phone moved. A recapture of a screen inherits the screen's horizon, not the
phone's — and a fake that matches has to stay consistent across two independent signals.
[`src/provenance/poseTrace.ts`](src/provenance/poseTrace.ts)

</details>

<details>
<summary><b>A raw audio master</b> — delivery codecs destroy what forensic work needs</summary>

Alongside the compressed track, an uncompressed 16 kHz master converted from the same native
buffers, with its hash signed into the record. Mains hum at 50 or 60 Hz leaks into any indoor
recording and drifts in a pattern unique to a grid region — effectively a timestamp you
cannot forge without the grid's own history. Delivery codecs filter exactly that band out.
Capturing the master costs a few megabytes and keeps the analysis possible for as long as the
file exists. [`modules/capture-kit`](modules/capture-kit)

</details>

<details>
<summary><b>Hardware attestation, bound to the key</b> — not just a real phone, this key on this phone</summary>

Signing keys are generated inside the Secure Enclave and cannot be extracted. Apple's App
Attest certifies the device and the app, but gives applications no access to the attested
key, so there is no direct way to say "and this is the key I sign with."

The workaround is a commitment: set the App Attest `clientDataHash` to
`SHA256(challenge ‖ signingPublicKey)`. Apple's certificate then vouches for exactly that
key, in the nonce extension at OID `1.2.840.113635.100.8.2`. An attestation cannot be lifted
off a real phone and pointed at someone else's key. The binding rides inside every manifest,
so it can be re-checked offline years later.
[`src/lib/appAttest.ts`](src/lib/appAttest.ts)

</details>

<details>
<summary><b>Independent time</b> — the only claim that does not come from your phone</summary>

An RFC 3161 countersignature, verified cryptographically on-device rather than read off the
token. And an OpenTimestamps receipt, which lands the record's digest in a Bitcoin block and
gives a lower bound nobody controls. Offline, the capture signs without either and says the
anchor is missing. Queued anchors record their delay rather than backdating.
[`src/lib/timestamp.ts`](src/lib/timestamp.ts) · [`src/lib/ots.ts`](src/lib/ots.ts)

</details>

<details>
<summary><b>A post-quantum signature</b> — a photograph may need to prove itself in twenty years</summary>

Evidence outlives its cryptography. A photograph taken today might matter in a court, an
archive or a history in two decades, by which time the signature protecting it could be
breakable. So every record carries an ML-DSA-65 signature over the same commitment as the
ECDSA one. A few kilobytes now, against a file that quietly stops being provable later.
[`src/lib/pq.ts`](src/lib/pq.ts)

</details>

<details>
<summary><b>Field-by-field disclosure</b> — the record is a dossier, you decide what travels</summary>

A provenance record says where you were, when, on which device, sometimes who you are. For a
photographer working somewhere hostile that file is a threat as much as a defence.

Every field is committed under its own salt into a signed Merkle tree, which gives three
states a verifier can tell apart: **disclosed**, **withheld** — committed but absent, with no
ciphertext to attack — and **never-recorded**, declared at capture and bound into the root,
so a withheld field cannot later be passed off as one that never existed.

Reveal one field later and it still verifies against the original signature. Or destroy the
seed, and the withheld fields become permanently underivable by anyone, including me.
[`src/disclosure`](src/disclosure)

</details>

<details>
<summary><b>Forensic checks any person can run</b> — no model, no upload, no probability</summary>

Inspect renders the signed claims against independent physical expectations and leaves the
inference to you. The sun's elevation and azimuth are deterministic from the signed time and
place, so the card shows which way shadows should fall. The committed gyro predicts where
level sits in frame. The motion trace is drawn against the optical flow.

A detector returns a number nobody can audit, and it gets worse exactly as generators
improve. This inverts that. A check that could not run says so.
[`app/(tabs)/inspect.tsx`](<app/(tabs)/inspect.tsx>)

</details>

<details>
<summary><b>A verdict that refuses to be a badge</b> — five questions, five answers, no checkmark</summary>

A checkmark borrows the authority of a body that supposedly did the checking. No such body
exists here. So the result is a ladder of five separate questions, with the unreached rungs
stating why. Unsigned renders neutral grey, never red: the absence of a credential is not
evidence of tampering. *Verified*, *authentic* and *trusted* name a conclusion somebody
reached, and nothing here reaches conclusions. A test fails the build if one of those words
appears in a verdict position. [`src/lib/trustLadder.ts`](src/lib/trustLadder.ts)

</details>

<details>
<summary><b>It works with the radio off</b> — sealing and verifying both, with no network at all</summary>

No accounts, no analytics, no launch-time network calls, and no registry address bundled in
the app. The optional calls that exist — a timestamp authority, a Bitcoin anchor, an
attestation relay you host — are named individually in
[`docs/NETWORK.md`](docs/NETWORK.md).

Apple's Reference Image sends the raw image, sensor signatures and hardware identifiers to
Private Cloud Compute and returns an authenticated copy. That is a reasonable trade for most
people. It is not available to someone who cannot afford to be seen talking to a server.

</details>

## Chasing instruments of truth

A photograph has never been proof. It has only ever been expensive to fake.

In July 1917 two girls in Yorkshire photographed some fairies. The images were examined by
Arthur Conan Doyle, who found them persuasive, and by Kodak, which declined to certify them
but conceded it could not prove them fake. The fairies were cardboard, copied from a
children's book and held up with hatpins. What is striking about the Cottingley affair is
not that anyone was fooled but that the question was already understood to be a technical
one, a matter for Kodak, rather than a question about two girls and a hatpin.

Retouching is as old as the negative, and Soviet censors
[airbrushed the disgraced out of group portraits](https://en.wikipedia.org/wiki/The_Commissar_Vanishes)
for fifty years before Photoshop shipped in 1990. A convincing lie took a darkroom, a skill
and an afternoon, and picture desks, wire services and libel law made it expensive to
attempt.

Generative models did not make images forgeable. They made forgery fast and essentially
free, which is lighter fluid on an already smouldering sense of reality.

### Lawmakers have written more bills about synthetic media than about any other use of AI

State legislatures introduced
[635 AI bills in 2024 and more than 1,200 in 2025](https://www.multistate.ai/artificial-intelligence-ai-legislation),
and synthetic media is the
[most-legislated corner](https://www.transparencycoalition.ai/news/state-bill-topic-tracker-ai-deepfakes)
of the subject. The [EU AI Act's Article 50](https://artificialintelligenceact.eu/article/50/)
and [California's AI Transparency Act](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB942)
both took effect on 2 August 2026. Penalties differ; the two technologies they lean on do not.

### Watermarking marks what a machine made, and it can be washed off

A watermark rides inside what a model generates, and it holds up against ordinary handling.
It does not hold up against effort. Regenerating an image through a diffusion model
[strips the mark and keeps the picture](https://arxiv.org/abs/2408.10446), one watermark can
[overwrite another](https://arxiv.org/abs/2605.16796), and there is
[tooling for it on GitHub](https://github.com/guillaumemeyer/watermarks-remover).
Open-weight models emit nothing to strip in the first place.

The deeper limit is that a watermark can only speak for what a machine made. It says nothing
about a photograph, which leaves the person holding real footage with nothing to show. Once
everyone knows video can be faked, real video gets dismissed as fake — a move already run in
court by
[Tesla's lawyers over recordings of Elon Musk](https://fortune.com/2023/04/27/elon-musk-lawyers-argue-recordings-of-him-touting-tesla-autopilot-safety-could-be-deepfakes/)
and by
[January 6th defendants over footage from inside the Capitol](https://btlj.org/2025/06/deepfaked-evidence-what-case-law-tells-us-about-how-the-rules-of-authenticity-needs-to-change/).

### Provenance signs what a camera saw, and the signature travels with the file

Adobe, Arm, the BBC, Intel, Microsoft and Truepic founded the
[Coalition for Content Provenance and Authenticity](https://c2pa.org/) in February 2021, and
the first specification followed a year later. It inverts the problem: instead of examining a
file for signs of forgery, seal it at the source so any later change reads as a change. A
watermark says a machine was involved. A manifest says which device, which moment, and what
has happened since.

### Four assurance levels grade the signer, and only two of them are available

A signature is worth the process that produced it, so C2PA's
[conformance program](https://c2pa.org/conformance/) grades the signer and writes the grade
into the certificate. **Level 1** covers documented key handling with software protection.
**Level 2** adds hardware-backed keys and a live attestation from the silicon at enrolment —
reached so far by the
[Pixel 10 camera](https://blog.google/security/pixel-android-trusted-images-c2pa-content-credentials/),
and for a mobile app currently reachable only on Android. Levels 3 and 4 exist in the
specification and are not yet issued. Source Kit signs at the software tier, holds no
certificate, and says so in every manifest.

## From bytes to photons

Between the sensor and the signature there is a stretch of code. How long it is decides what
the signature is worth.

A digital photograph begins as electrical charge on a grid of sensor wells and ends as a
compressed file. Something has to turn one into the other: read the wells, interpolate colour
across the filter mosaic, correct the lens, reduce noise, tone-map, encode. That chain runs
for tens of milliseconds, and every stage of it is code that could in principle hand the next
stage a different picture. So the question that decides what a provenance signature actually
proves is not how strong the key is. Everyone keeps the key in hardware. The question is how
much of that chain sits between the photons and the signing, and whether any of it can be
replaced.

On the
[Pixel 10](https://blog.google/security/pixel-android-trusted-images-c2pa-content-credentials/),
almost none of it can. Google signs inside the imaging pipeline on the Tensor G5; the claim
key is generated and held in Android StrongBox on the Titan M2 security chip; a timestamp
authority runs on the device, so a capture made with the radio off still carries trusted
time. The frame is never handed to general-purpose code between the sensor and the
signature, which means there is no seam at which a different image could be substituted.
Photograph something with a Pixel 10 and the file can support a claim almost nothing else
can: that these are the photons that struck the sensor.

Qualcomm took the same idea to the other end of the Android market, putting a signer inside
the Snapdragon trusted execution environment so the pipeline is isolated from the operating
system running above it. Apple's Reference Image, visible in the iOS 27 beta, captures sensor
signatures and hardware identifiers with the frame — but it sends them to Private Cloud
Compute and returns an authenticated copy, and it is not built on C2PA.

Source Kit sits at the far end of that chain. It receives a finished image from the operating
system and signs the bytes it was handed, in its own process, with a key in the Secure
Enclave. Everything upstream of that hand-off is code it cannot attest to. This is the
ceiling for a third-party app on iOS, not a design preference: Assurance Level 2 for a mobile
app is currently reachable only on Android. What the app can do is commit far more *around*
the frame — a second lens, the motion of the phone, independent time — so that a forger has
to keep several signals consistent rather than one.

### Cameras got there first, and California is about to make it universal

Phones are the late arrivals. Leica shipped the
[first camera with Content Credentials](https://leica-camera.com/en-US/photography/content-credentials),
the M11-P, in October 2023, with a signing certificate in the body. Sony added capture-time
signing across the Alpha 1 II and Alpha 9 III, Canon launched its
[Authenticity Imaging System](https://c2paviewer.com/articles/canon-authenticity-imaging-system)
for newsrooms in May 2026, and Nikon
[added C2PA to the Z6III](https://www.nikonusa.com/press-room/nikon-develops-firmware-that-adds-function-compliant-with-cp2a-standards-to-z6iii)
in firmware — then withdrew it within a week, when a researcher used the camera's
multiple-exposure mode to make it sign a composite it had not photographed. Nikon suspended
the service and invalidated every certificate it had issued. The credentials from that window
no longer verify, which is the standard working exactly as intended, and a fair measure of
how new all of this is.

From 1 January 2028, this stops being a feature. California's
[AB 853](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB853)
requires every capture device sold in the state — the statute names "video and still
photography cameras, mobile phones with built-in cameras or microphones, and voice
recorders" — to offer a latent disclosure carrying the manufacturer, the device, and the time
and date of capture, and to embed it *by default*. Provenance metadata goes from a
differentiator on a flagship to a condition of selling a camera in the largest state in the
country.

## Where it still comes up short

Six ways a file can carry a perfect signature and still mislead you. The first independent
security review of the specification,
[Golaszewski et al. at UMBC](https://eprint.iacr.org/2026/804), found implementation problems
on top of these — disagreeing validators, weak revocation, an exclusion range that hides
edits. Those are fixable. The six below are structural.

**The lens can be pointed at a screen.** Photograph a good monitor and every guarantee holds,
because they are all true: that sensor really did see those photons. No signature, from any
device, reaches past the front of the lens.

**A signature binds a claim without checking it.** Civilian GPS is unauthenticated and
spoofers cost less than a phone. The scene can be entirely real while the time and place
sealed beside it are not, and the seal makes a forged fix look exactly as solid as a true one.

**Most platforms strip the credential on upload.** The manifest disappears at the exact moment
a picture starts to travel, and an unsigned file is indistinguishable from one that never had
a signature. The industry answer is a fingerprint plus a lookup service. The fingerprint
exists here; the lookup does not.

**Below Level 2, a picture can be handed to the signer.** If the frame reaches the signing
step through code that isn't attested, whatever arrives gets signed correctly. In 2025 a
researcher used the Nikon Z6III's multiple-exposure mode to do exactly this; Nikon invalidated
every certificate it had issued.

**A staged scene is a true photograph of a lie.** Everything here would have sealed the
Cottingley fairies without complaint. Real camera, real plate, real garden, real light, real
distance — two lenses would even measure genuine depth, because there was genuine depth. Every
check passes and every one of them is telling the truth.

**Protecting someone in the frame breaks the proof.** Blur a bystander's face, crop a
landmark, drop the coordinates, and the signature fails — the file now reads as modified,
which is the same verdict a forgery gets. Selective disclosure here covers the metadata, so
fields can be withheld and still verify. Nothing yet covers the pixels.

None of this is fixed by detection. You cannot out-classify a generator — it improves as the
classifier does. What you can do is raise what a forger has to keep consistent at once:
geometry, motion, shadows, time. Everything this app commits is aimed at the first gap, the
one that stays open however good the hardware gets.

[Diagrams for each of these are on the page.](https://noah-pi.github.io/sourcekit-open/#holes)

## The shutter path

Six things happen on the device before the file exists.

| | | |
|---|---|---|
| 1 | **Hash the exact bytes.** SHA-256, chunked, so verifying a video never loads it whole. | `src/lib/fileHash.ts` |
| 2 | **Record what the sensors said.** Time, GPS (opt-in), heading, barometric altitude, a motion signal. | `src/sensors/` |
| 3 | **Sign in the Secure Enclave.** ECDSA P-256. The key is generated on the chip and can't leave it; signing happens there, not in app memory. | `src/lib/deviceKey.ts`, `modules/secure-enclave/` |
| 4 | **Write Content Credentials into the file.** A real C2PA manifest — CBOR claim, hard binding, COSE_Sign1 — inside the JPEG, PNG, MP4, MOV or M4A. CI checks on every run that `c2patool` reads it. | `src/c2pa/` |
| 5 | **Sign it again, post-quantum.** ML-DSA-65 over the same commitment, so a future break of P-256 doesn't quietly invalidate an archive. | `src/lib/pq.ts` |
| 6 | **Anchor the time.** RFC 3161 when there's a network, OpenTimestamps for independent proof-of-existence. Offline it signs without, and says so. | `src/lib/timestamp.ts`, `src/lib/ots.ts` |

Sealing and verifying both work with the radio off. No accounts, no analytics, no
launch-time network calls. Every optional network event is named in
[`docs/NETWORK.md`](docs/NETWORK.md).

## What you can take

Most of it is platform-neutral TypeScript with no build step.

| Path | What it is |
|---|---|
| `src/c2pa/` | A complete, dependency-light C2PA implementation: CBOR claims, COSE_Sign1, JPEG APP11/JUMBF, PNG `caBX`, BMFF/MP4 embedding with chunk-offset repair, and the verifier. Cross-checked against `c2patool` on every CI run. Probably the most reusable thing here. |
| `src/lib/` | Crypto plumbing, pure TS: a strict X.509 chain verifier, RFC 3161 tokens, COSE/DER, ECDSA, the ML-DSA-65 layer, AES-256-GCM, canonical JSON. No WebCrypto, no network. |
| `src/provenance/` | Capture → sealed record: orchestration, schema, background seal queue, detached manifests, and a differential oracle that runs two independent engines against each other and flags disagreement. |
| `src/disclosure/` | Commit every field at capture, reveal them individually later, without breaking the original signature. |
| `src/vault/` | Encrypted storage. Media, records and thumbnails all sealed; plaintext exists only in a cache folder shredded on lock. |
| `src/theme.ts`, `src/components/`, `app/` | The whole interface — tokens, UI kit, screens. |
| `modules/` | The Swift: Secure Enclave keygen and signing, App Attest, the AVFoundation capture engine, the raw-audio sink, the C2PA Rust binding. |
| `server/` | An App Attest relay in one dependency-free file. Run your own or skip it — offline devices sign unattested and say so. |
| `tests/` | 27 suites, 769 checks, run against the real shipping code. |

## Run the lab

```sh
node tests/stage.mjs
cd tests/.staged && npm install
./node_modules/.bin/tsx test-verification.mts     # → 146 passed, 0 failed
```

Staging rewires only device services — keychain, filesystem, device model — to small
shims. Every cryptographic operation is the code that runs on the phone. The suites
sign fresh media with a random key each run, then attack it: flipped bits, transplanted
manifests, a self-issued "O=Reuters" certificate, truncated files, hostile parsers.

With `c2patool` on your path the independent-verifier checks run too. Without it they
report `SKIP` and are counted separately.

## Worth building next

No coordination needed, no permission to ask.

- **An Android port.** The core is platform-neutral; what's missing is the equivalent of
  `modules/secure-enclave` against Keystore and Play Integrity. The record format and
  verifier carry over unchanged.
- **A standalone verifier CLI.** `src/c2pa/verifyAsset.ts` has no platform dependencies.
  Someone should make `npx` check a file.
- **A TSA trust list.** Timestamping has no mature public root store the way the web PKI
  does. That's a gap for everyone in this space, not just me.
- **Rephotography geometry.** Chromatic-aberration radial physics, JPEG grid artifacts
  surviving into RAW, homography residual across a known baseline. Real signals with
  real error rates, which is the bar — anything that can't publish a false-positive rate
  on a named corpus shouldn't ship a number.
- **Break it.** Make a forged file verify and I'd genuinely like to see it. `tests/`
  shows the shape of a good repro.

## Limits

- **Two checks aren't performed:** TSA root anchoring and certificate revocation. Both
  are named on every verification rather than skipped quietly.
- **Sensors are claims.** Time, GPS, heading, altitude are what the device reported,
  bound into the signature. The binding is real; whether the device told the truth is a
  separate question.
- **Stereo capture is unvalidated on iPhone 17 / iOS 26.** The verification side is
  lab-tested. The capture side moved to Apple's virtual dual-wide device graph and I
  haven't confirmed it in the field yet.
- **No conformance certification.** Files carry standard C2PA manifests and `c2patool`
  reads them on every CI run, but nothing here has been through the conformance program.
- **Beta software, written by one person with AI assistance**, and held to account by the
  test lab, an independent reference verifier and the differential oracle — see
  [`docs/PROVENANCE.md`](docs/PROVENANCE.md). Don't keep your only copy of anything
  important in it, and please don't stake anything serious on it without reading the code
  yourself.

## Building it

If you just want to use it, the beta is on
[TestFlight](https://testflight.apple.com/join/cRuRw2MN).

To build it yourself:
[`docs/BUILDING.md`](docs/BUILDING.md). It's an Expo app: `npm install`, then
`npx expo run:ios` on a Mac with Xcode. Secure Enclave and App Attest need a real
device; the simulator falls back to a software key and labels itself as such. Forking
for your own build means replacing the EAS project id in `app.json` and the App Attest
app id in `src/lib/appleAttestRoot.ts`.

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Threat model](docs/THREAT-MODEL.md) ·
[Security](docs/SECURITY.md) · [Integrity](docs/INTEGRITY.md) ·
[Network](docs/NETWORK.md) · [Settings](docs/SETTINGS.md) ·
[Decisions](docs/DECISIONS.md) · [Recovery](docs/RECOVERY.md) ·
[Provenance](docs/PROVENANCE.md)

## License

Apache-2.0 ([LICENSE](LICENSE), with [NOTICE](NOTICE) for attribution that travels).
"Source Kit" is a trademark and isn't licensed for derivative use
([TRADEMARK.md](TRADEMARK.md)) — fork it, ship it under your own name.

If you build something with this, or find something I got wrong, I'd really like to hear
about it.

— Noah Bassetti-Blum
