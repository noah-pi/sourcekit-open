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

I was a journalist at the New York Times and am now a product designer at Google. Source Kit
is neither job, and neither organization endorses it. I built it nights and weekends,
wanting a camera that could show its work.

Twenty-seven test suites, cross-checked against the C2PA reference implementation on every
run. I have also missed things a cryptographer, or a career iOS engineer, would find in an
afternoon. I would rather you found them.

## How Source Kit works

Take a photo, video or audio recording in a familiar interface. As on most C2PA-enabled
hardware, the basics go into the file at the moment of capture: time, device, and location
if you allow it. Source Kit commits a good deal more.

- **A second lens.** A downsampled view from a different physical camera, with its
  calibration, committed alongside the frame. Two lenses a known distance apart see a flat
  screen and a real room differently, and the difference is measurable.
  [`modules/exhibit-camera`](https://github.com/noah-pi/sourcekit-open/tree/main/modules/exhibit-camera)
- **The motion of the phone.** Gyroscope and attitude around the shutter, decimated and
  signed, so the movement can be checked against the optical flow of the frames it
  accompanies. [`src/provenance/poseTrace.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/provenance/poseTrace.ts)
- **A raw audio master.** Uncompressed LPCM beside the delivery file. Delivery codecs filter
  out exactly the frequencies forensic work needs, so it has to be captured now or not at
  all. [`modules/capture-kit`](https://github.com/noah-pi/sourcekit-open/tree/main/modules/capture-kit)
- **Hardware attestation, bound to the signing key.** Apple's App Attest certifies the
  device and app; a commitment construction welds that certificate to this specific key.
  [`src/lib/appAttest.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/appAttest.ts)
- **Independent time.** An RFC 3161 countersignature and an OpenTimestamps receipt anchored
  to Bitcoin — the only claims in the record that don't come from the device itself.
  [`timestamp.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/timestamp.ts) · [`ots.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/ots.ts)
- **A post-quantum signature.** ML-DSA-65 over the same commitment, so a future break of
  P-256 doesn't quietly invalidate an archive. [`src/lib/pq.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/pq.ts)
- **Selective disclosure.** Every field committed under its own salt, so you can reveal one
  later without breaking the seal, or destroy the seed and make it permanently unreadable.
  [`src/disclosure`](https://github.com/noah-pi/sourcekit-open/tree/main/src/disclosure)
- **Checks a person can run.** Shadows against the sun's real position, the horizon against
  the committed gyro, the motion trace against the footage. No model, no upload, no score.
  [`src/components/forensic`](https://github.com/noah-pi/sourcekit-open/tree/main/src/components/forensic)
- **A verdict surface that refuses to be a badge.** Five separate questions, each answered
  on its own terms, with the unreached ones saying why.
  [`src/lib/trustLadder.ts`](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/trustLadder.ts)

The C2PA engine itself is written from the specification rather than bound to the reference
library, which is what makes the differential testing possible. [`src/c2pa`](https://github.com/noah-pi/sourcekit-open/tree/main/src/c2pa)

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

## Tying the signature to the hardware

App Attest certifies that a genuine build is running on genuine hardware. But Apple gives
apps no access to the attested key, so you cannot simply attest your signing key with it.
The workaround is a commitment: set the App Attest `clientDataHash` to
`SHA256(challenge ‖ signingPublicKey)`. Apple's nonce extension in the attestation
certificate then vouches for *exactly that key*, not merely for some key on some genuine
device.

The binding rides inside every manifest, so it can be re-checked offline years later with
nothing running anywhere. `src/lib/appAttest.ts` and `server/server.mjs`.

As far as I can tell this holds, but it's the piece where I'm furthest outside my depth, and
the one I'd most like a cryptographer to either reuse or tell me is wrong.

## Gap two, in detail

A signature proves custody of bytes. It cannot prove what the lens was pointed at. Shoot
a monitor showing a generated video and you get a perfectly valid seal over a perfectly
real recording of a fake scene.

Attestation closes *injection*: substituted frames, virtual camera drivers, forged sensor
data. It does nothing about *rephotography*: real photons, fake scene. Closing injection
does not reduce rephotography. It concentrates every attacker on it.

The Cottingley photographs are the clean illustration. Everything here would have
sealed them: real camera, real plate, cut-outs propped up with hatpins at a real
distance in real light. Two lenses would measure genuine depth, because there was
genuine depth. Every rung on the ladder would be reached, and every one would be
telling the truth. That's the edge of what provenance can do — it speaks to the file,
never to the world the file depicts.

Rephotography is geometric. A flat screen three metres away is a plane, and two lenses
with a known baseline can measure that. The stereo capture path and the parallax work
exist for this reason, and the honest status is in the limits below. Everything in the
verifier is careful to keep custody and scene separate, because conflating them is how
this category loses credibility.

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

## The interface

This is the part I'm actually qualified for, and I think it matters as much as the
cryptography: saying what a signature means without overstating it.

The verdict surface is a **ladder, not a badge** — five separate questions, each with its
own answer, and an unreached rung that says why. There are no seals, shields or checkmarks
anywhere in the product. A checkmark is an institutional gesture: it works by borrowing the
authority of some body that has supposedly done the checking, a notary or a ratings board or
a verification team. No such body exists here, so a badge would be borrowed furniture — and
the borrowing, rather than the cryptography, would be the dishonest part.

So the card carries its title and limits *inside* the frame, where they survive being
screenshotted. Unsigned renders neutral grey, never red: the absence of a credential is
not evidence of tampering, and colouring it like a failure would smuggle in a claim
nobody checked.

A test fails the build if *verified*, *authentic*, *trusted*, *proven*, *real*, *secure* or
*guaranteed* turns up in a verdict position. Operations that actually ran keep their precise
verbs. That test kept the copy honest as the feature count grew, because the pressure to
round a qualified result up to a confident one is constant, and a fair amount of it came
from me.

All of it is in `src/theme.ts` and `src/components/`. Lift it if it's useful — none of it is
specific to this app, and I'd be glad to see it somewhere better engineered.

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
