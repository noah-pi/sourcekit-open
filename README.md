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
cryptography, native modules, interface, test suite — because people who know more will get
further with it than I will.

## How Source Kit works

Take a photo, video or audio recording in a familiar interface. As on most C2PA-enabled
hardware, the basics go into the file at the moment of capture: time, device, and location
if you allow it. Source Kit commits a good deal more, and commits it in a form other C2PA
tools can read.

### A second lens

Nearly every flagship phone ships a multi-camera array — a main wide, an ultra-wide, usually
a telephoto. Almost nothing uses the second one for provenance.

Source Kit captures a simultaneous downsampled frame from a secondary lens, usually the
ultra-wide, and seals it alongside the main image as a first-class C2PA ingredient: the
`c2pa.ingredient.v3` schema with relationship `componentOf`, meaning the second frame is a
component of this exhibit rather than a parent it was derived from. A 512-pixel thumbnail
rides in the manifest as `c2pa.thumbnail.ingredient.jpeg`. Anyone opening the file in any
C2PA reader sees the second viewpoint.

The cheap attack it counters is rephotography: point a camera at a screen. An ultra-wide sees
far more of the room than the frame you composed, so a monitor bezel, the edge of a laptop,
the reflection off an OLED panel all land in the second view.

Past that, the geometry. Two lenses a known distance apart see a flat plane identically, up
to a single projective transform. They see a scene with real depth with a residual
disagreement no homography removes. Because the second frame and the full calibration are
both committed, anyone can undistort the pair, match features, fit a homography and measure
that residual themselves rather than trusting the device's arithmetic. Disparity falls off
with distance, so beyond a few metres the answer is **insufficient**, never *passed*.

*Status: the verification side is lab-tested and green. The capture path moved to Apple's
virtual dual-wide device graph and has not been confirmed in the field on iPhone 17 / iOS 26.
It is not finished.* [`modules/exhibit-camera`](https://github.com/noah-pi/sourcekit-open/tree/main/modules/exhibit-camera)

### The motion of the phone

A decimated, quantized window of gyroscope and fused-attitude samples from around the shutter
is signed into the record as `context.poseTrace`, and drawn against the optical flow of the
frames themselves.

Natural hand movement over a real three-dimensional scene produces motion the footage should
agree with: near detail moves the way the gyro says the phone moved. A recapture of a screen
inherits the screen's horizon rather than the phone's, and a synthetic trace that matches the
frames has to be fabricated consistently across two independent signals.
[`src/provenance/poseTrace.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/provenance/poseTrace.ts)

### A raw audio master

Alongside the AAC delivery track, Source Kit writes an uncompressed 16 kHz mono LPCM master,
converted on-device from the same native buffers that feed the delivery file. Its path and
hash are signed into the record.

The reason is electrical network frequency. Mains hum at 50 or 60 Hz leaks into any indoor
recording and fluctuates in a pattern unique to a grid region over time, which makes it a
timestamp you cannot forge without the grid's own history. Delivery codecs filter exactly
that band. Capturing the master costs a few megabytes and keeps the analysis possible for as
long as the file exists. Source Kit does not perform that analysis; it preserves the evidence
for someone who can. [`modules/capture-kit`](https://github.com/noah-pi/sourcekit-open/tree/main/modules/capture-kit)

### Hardware attestation, welded to the signing key

Signing keys are generated inside the Secure Enclave and cannot be extracted. App Attest
certifies the device and the app — but Apple gives applications no access to the attested
key, so there is no direct way to say "and this is the key I sign with."

The workaround is a commitment. Set the App Attest `clientDataHash` to
`SHA256(challenge ‖ signingPublicKey)`. Apple's nonce extension in the resulting certificate
then vouches for exactly that key rather than for some key on some genuine device. An
attestation cannot be lifted from a real phone and pointed at a key someone else controls.

The binding rides inside every manifest, so it can be re-checked offline years later with
nothing running anywhere. It is the piece I would most like a cryptographer to check.
[`src/lib/appAttest.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/appAttest.ts)

### Time from somewhere other than the phone

Two independent anchors. An RFC 3161 countersignature from a public timestamp authority,
verified cryptographically on-device rather than scraped: the message imprint must match, the
CMS signature must verify over correctly re-tagged signed attributes, the chain must link,
and the authority's certificate must have been valid at the stated time. And an
OpenTimestamps receipt, which lands the record's digest in a Bitcoin block and gives a lower
bound nobody controls.

Offline, the capture signs without either and the record says the anchor is missing. Queued
anchors record their own delay rather than backdating.
[`timestamp.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/timestamp.ts) · [`ots.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/ots.ts)

### A second signature, for later

Every record carries an ML-DSA-65 signature over the same commitment as the ECDSA one. If
P-256 is broken in twenty years, an archive sealed today does not quietly become
unverifiable. [`src/lib/pq.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/pq.ts)

### Deciding what travels, at the shutter

Every signal is a live toggle in the viewfinder, so the decision happens in context rather
than in a settings screen from months earlier. What is switched off is recorded as
deliberately absent, a different and more useful fact than silently missing.

Each field is also committed under its own salt, derived from one master seed, into a Merkle
tree whose root is signed. That gives three states a verifier can tell apart: **disclosed**,
opened in this bundle and checkable against the root; **withheld**, committed but absent,
with no ciphertext to attack because nothing was encrypted; and **never-recorded**, declared
at capture time and bound into the root, so a withheld field cannot later be relabelled as
one that never existed.

You can reveal a single field later and have it verify against the original signature. Or
destroy the master seed, which makes the withheld fields permanently underivable — by anyone,
including me. [`src/disclosure`](https://github.com/noah-pi/sourcekit-open/tree/main/src/disclosure)

### Checks a person can run, with no model in the loop

Inspect opens any sealed file and renders the signed claims against independent physical
expectations, then leaves the inference to the reader. From the signed time and place, the
sun's true elevation and azimuth are deterministic, so the card shows which way shadows
should fall. The committed gyro attitude predicts where level sits in the frame. The motion
trace is drawn against the optical flow. The parallax measurement runs on-device from the
committed second view.

It uploads nothing, runs no classifier and returns no probability. A check that could not run
says so, and insufficient data reports insufficient.

None of this is a panacea. Any single check falls to someone who knows it is there. What the
stack restores is friction: forgery becomes a physical production, consistent across
geometry, optics, motion, audio and time, committed before the forger knew which checks would
run. Not proof. What photographs used to have.
[`src/components/forensic`](https://github.com/noah-pi/sourcekit-open/tree/main/src/components/forensic)

### A verdict surface that refuses to be a badge

A checkmark borrows the authority of a body that supposedly did the checking. No such body
exists here. The result is a ladder of five separate questions, each answered on its own
terms, with the unreached rungs stating why. Unsigned renders neutral grey rather than red,
because the absence of a credential is not evidence of tampering.

*Verified*, *authentic* and *trusted* name a conclusion somebody reached, and nothing here
reaches conclusions, so the interface names the operation instead: *signature mathematically
valid*, *media unchanged since signing*, *proven tamper*. A test fails the build if a verdict
word appears in a summary position. [`src/lib/trustLadder.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/trustLadder.ts)

### None of it needs a network

Sealing and verifying both complete with the radio off. No accounts, no analytics, no
launch-time network calls, and no registry address bundled in the app at all. The optional
calls that exist — a timestamp authority, a Bitcoin anchor, an attestation relay you choose
and host — are enumerated by name in [`docs/NETWORK.md`](docs/NETWORK.md), and an offline
capture signs without them and says so.

Apple's Reference Image sends the raw image, sensor signatures and hardware identifiers to
Private Cloud Compute and returns an authenticated copy. That is a reasonable trade for most
people. It is not available to someone who cannot afford to be seen talking to a server, and
that person is who this was built for.

## Chasing instruments of truth

A photograph has never been proof. It has only ever been expensive to fake.

In July 1917 two girls in Yorkshire photographed some fairies. The images were examined by
Arthur Conan Doyle, who found them persuasive, and by Kodak, which declined to certify them
but conceded it could not prove them fake. The fairies were cardboard, copied from a
children's book and held up with hatpins. What is striking about the Cottingley affair is
not that anyone was fooled but that the question was already understood to be a technical
one, a matter for Kodak, rather than a question about two girls and a hatpin.

Susan Sontag put the presumption exactly: "A photograph passes for incontrovertible proof
that a given thing happened. The picture may distort; but there is always a presumption that
something exists, or did exist, which is like what's in the picture."

The presumption was never earned by the medium. Retouching is as old as the negative, and
Soviet censors airbrushed the disgraced out of group portraits for fifty years before
Photoshop shipped in 1990. What a photograph had was friction: a darkroom, a skill, an
afternoon, with picture desks, wire services and libel law making lying expensive.

Generative models did not make images forgeable. They made forgery fast and essentially
free, which is lighter fluid on an already smouldering sense of reality.

### Two responses, both pushed along by law

The EU AI Act's transparency obligations became applicable on 2 August 2026, and
California's AI Transparency Act became operative the same day.

**The first response is marking synthetic content.** Google's SynthID, and now Anthropic's
text watermarking, announced on 11 August 2026 and built on the SynthID-Text approach, embed
a machine-readable signal in what a model produces. This is worth doing and it is not
sufficient. Watermarks are strippable, open-weight models generate unmarked output, and any
motivated actor can still pass off manipulated media.

Meanwhile the liar's dividend keeps paying. Once everyone knows video can be faked, real
video can be dismissed as fake. Tesla's lawyers argued that Elon Musk's recorded statements
about self-driving safety might be deepfakes and should not be admitted. A defendant charged
over the January 6th Capitol riot argued the video evidence against him might be
AI-generated. Marking what is synthetic does nothing for someone who needs to prove that
something is not.

**The second response is provenance.** In February 2021, Adobe, Arm, the BBC, Intel,
Microsoft and Truepic folded two existing efforts — Adobe's Content Authenticity Initiative
and the Microsoft and BBC Project Origin — into the Coalition for Content Provenance and
Authenticity. The first specification followed in 2022.

The vision inverts the detection problem. Rather than examining a file for signs of forgery,
put a tamper-evident seal on it at the source, so that any later change is visible as a
change. The work has been careful, open, and unusually candid about its own limits.

C2PA defines four assurance levels for how well an implementation protects the signing
process. Level 2, which requires hardware-backed key storage and dynamic security evidence,
is the one that matters, and it has now been reached in shipping consumer hardware.

## From bytes to photons

It shipped. The **Pixel 10** signs every photo inside the imaging pipeline, claim keys in a
Titan M2 chip, timestamp authority on the same die, certified at Assurance Level 2. Qualcomm
put a signer in the Snapdragon trusted execution environment. **Apple's Reference Image**,
visible in an iOS 27 beta, captures sensor signatures and hardware identifiers with the
frame.

The difference is not the strength of the key. Everyone protects the key in hardware. The
difference is how much untrusted code touches the pixels between the sensor and the
signature. On a Pixel there is none: the pixels never leave the chip, so there is nothing in
between to attack. Photograph something with a Pixel 10 and you can claim, with
justification, that these are the literal photons that struck the sensor.

That is a real achievement, and it is more than any third-party application on iOS can do.
Source Kit signs in its own process, which is a longer and more exposed path.

## Four gaps remain

None of them is closed by moving the signature into the silicon.

1. **The standard underneath has real problems.** C2PA's first comprehensive independent
   security analysis found generators and validators disagreeing on trusted timestamps,
   revocation weak enough that validators accept known-compromised certificates, and an
   exclusion range permitting undetectable alterations. Their conclusion: don't stake
   journalism or legal evidence on C2PA yet.
   ([Golaszewski et al., UMBC, 2026](https://eprint.iacr.org/2026/804))
2. **No signature reaches the scene.** Point a hardware-signed camera at a good monitor and
   every guarantee holds: the sensor did see those photons.
3. **Signing a claim doesn't make it true.** Civilian GPS is unauthenticated and spoofers
   are commodity hardware. In-pipeline signing binds a forged fix as faithfully as a real
   one.
4. **The credential dies in transit.** Most platforms strip metadata on upload, so the
   manifest disappears exactly when an image starts to spread.

The Nikon Z6 III is the demonstration. In August 2025 a researcher found the camera would
sign an AI-generated image run through Multiple Exposure mode. Hardware-rooted,
cryptographically valid, nothing broken: the picture was handed to the signer, which signed
it as designed. Nikon revoked every certificate it had issued; a year later the service is
still suspended.

Detection is the obvious response, and I think it is the wrong one. A detector is a
classifier guessing at the output of a generator, and it gets worse exactly as the generator
gets better. What is left is narrower: raise what a forger has to keep consistent across
geometry, motion, shadows and time, then present it so that a person can weigh it quickly.
This repo is an attempt at gaps two and three, a careful pass at one, and unfinished
business on four.

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
