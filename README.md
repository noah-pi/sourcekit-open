<p align="center">
  <img src=".github/banner.svg" alt="Source Kit — an open cryptographic camera" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1F6B45?style=flat-square"></a>
  <a href=".github/workflows/ci.yml"><img alt="CI" src="https://github.com/noah-pi/sourcekit-open/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Opens in c2patool" src="https://img.shields.io/badge/C2PA-opens%20in%20c2patool-1F6B45?style=flat-square">
  <img alt="Platform iOS" src="https://img.shields.io/badge/platform-iOS-6E6E73?style=flat-square">
  &nbsp;<a href="https://noah-pi.github.io/sourcekit-open/"><b>Deep dive →</b></a>
</p>

---

# Fuck deepfakes. Prove your work.

**Source Kit is a cryptographic camera app that signs each photo and video as you take
it.** The signature and the capture context go inside the file, on the device, with no
network involved — so anyone can check it later without needing anything from me. Any C2PA
reader opens it.

I'm a journalist who became a product designer. I'm not a cryptographer, and I'm not a
career engineer. This is a side project, published in full — camera, cryptography, native
modules, interface, test suite — because people who know more than I do will get further
with it than I will.

### Where this comes from

I was a journalist at the New York Times and I'm now a product designer at Google. Source
Kit isn't either of those jobs. It's a side project, built nights and weekends, because I
wanted a camera that could show its work and couldn't find one. It isn't affiliated with or
endorsed by either organization.

So the honest framing: I've read the specifications closely and tested this as carefully as
I know how — 27 suites, cross-checked against the C2PA reference implementation on every
run. I've also almost certainly missed things a cryptographer or a career iOS engineer
would catch in an afternoon. If that's you, I would genuinely rather you found them than
didn't.

The people working on this properly — Apple, Google, the C2PA working group, newsrooms with
real security teams — have resources I don't. What a solo project can do is try things
quickly, publish all of it, and be straight about where the limits are.

### Why provenance, and not detection

There was never a golden age of photographic truth. Conan Doyle published two schoolgirls'
paper cut-outs as evidence of fairies in 1920, after Kodak experts confirmed the negatives
showed no tampering — which was true, and beside the point. What a photograph had was never
self-evidence. It was friction: a darkroom, a skill, an afternoon. Generative models didn't
make images forgeable, they made forgery free and fast.

Detection is the obvious replacement and I think it's the wrong one: a detector is a
classifier guessing at the output of a generator, and it gets worse exactly as the generator
gets better. Provenance is the alternative — not proof that a scene was real, but a
checkable record of where a file came from and what has happened to it since. It's a much
smaller claim than most people want, and it's the one I could see a way to actually keep.

Provenance is cheap at exactly one instant: capture. Everything after that is
reconstruction. So the whole thing collapses to one problem — commit to as much as you can,
at the shutter, in a form anyone can check later without needing anything from me.

**[Read the deep dive →](https://noah-pi.github.io/sourcekit-open/)**

## The shutter path

Six things happen on the device before the file exists.

| | | |
|---|---|---|
| 1 | **Hash the exact bytes.** SHA-256, chunked, so verifying a video never loads it whole. | `src/lib/fileHash.ts` |
| 2 | **Record what the sensors said.** Time, GPS (opt-in), heading, barometric altitude, a motion signal. | `src/sensors/` |
| 3 | **Sign in the Secure Enclave.** ECDSA P-256. The key is generated on the chip and can't leave it; signing happens there, not in app memory. | `src/lib/deviceKey.ts`, `modules/secure-enclave/` |
| 4 | **Write Content Credentials into the file.** A real C2PA manifest — CBOR claim, hard binding, COSE_Sign1 — inside the JPEG, PNG, MP4, MOV or M4A. Any C2PA reader opens it. | `src/c2pa/` |
| 5 | **Sign it again, post-quantum.** ML-DSA-65 over the same commitment, so a future break of P-256 doesn't quietly invalidate an archive. | `src/lib/pq.ts` |
| 6 | **Anchor the time.** RFC 3161 when there's a network, OpenTimestamps for independent proof-of-existence. Offline it signs without, and says so. | `src/lib/timestamp.ts`, `src/lib/ots.ts` |

Sealing and verifying both work with the radio off. No accounts, no analytics, no
launch-time network calls. Every optional network event is named in
[`docs/NETWORK.md`](docs/NETWORK.md).

## Tying the signature to the hardware

App Attest certifies that a genuine build is running on genuine hardware, but Apple gives
apps no access to the attested key — so you can't simply attest your signing key. The
workaround is a commitment: set the App Attest `clientDataHash` to
`SHA256(challenge ‖ signingPublicKey)`. Apple's nonce extension in the attestation
certificate then vouches for *exactly that key*, not merely for some key on some genuine
device.

The binding rides inside every manifest, so it can be re-checked offline years later with
nothing running anywhere. `src/lib/appAttest.ts` and `server/server.mjs`.

As far as I can tell this holds, but it's the piece where I'm furthest outside my depth, and
the one I'd most like a cryptographer to either reuse or tell me is wrong.

## What it can't do

A signature proves custody of bytes. It cannot prove what the lens was pointed at. Shoot
a monitor showing a generated video and you get a perfectly valid seal over a perfectly
real recording of a fake scene.

Attestation closes *injection*: substituted frames, virtual camera drivers, forged sensor
data. It does nothing about *rephotography*: real photons, fake scene. Closing injection
doesn't reduce rephotography — it concentrates every attacker on it.

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
