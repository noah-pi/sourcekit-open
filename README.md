<p align="center">
  <img src=".github/banner.svg" alt="Source Kit — an open cryptographic camera" width="100%">
</p>

<p align="center">
  <b>A camera that seals what it sees.</b><br>
  The moment you shoot, the phone signs the bytes, the time, and what its sensors said.<br>
  Nothing about the file can change afterwards without breaking that seal.
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1F6B45?style=flat-square"></a>
  <a href=".github/workflows/ci.yml"><img alt="CI" src="https://github.com/noah-pi/sourcekit-open/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="C2PA conformant" src="https://img.shields.io/badge/C2PA-conformant-1F6B45?style=flat-square">
  <img alt="Platform iOS" src="https://img.shields.io/badge/platform-iOS-6E6E73?style=flat-square">
</p>

<p align="center">
  <a href="https://noah-pi.github.io/sourcekit-open/"><b>Read the deep dive →</b></a>
</p>

---

This is a working cryptographic camera, opened up so the next one is easier to build.

Fakes are free and perfect now, and eyes can't settle it. One answer is to record
provenance at the only moment it's cheap to establish — the instant of capture — and
then let anyone check it, offline, forever. That's what this app does, and everything
it takes to do it is in this repository: the cryptography, the native modules, the
test lab, and the whole interface.

**Take what's useful.** Port it to Android, lift the C2PA engine, steal the interface
patterns, or fork the entire thing under your own name. That's what it's here for.

## What happens when you press the shutter

| | Step | Where |
|---|---|---|
| 1 | **Hash the exact bytes.** SHA-256, chunked — checking a video never loads the whole file into memory. | `src/lib/fileHash.ts` |
| 2 | **Record what the sensors said.** Time, GPS (opt-in), compass heading, barometric altitude, a motion signal. | `src/sensors/` |
| 3 | **Sign it in the Secure Enclave.** ECDSA P-256. The key is generated on the chip and can't be extracted — signing happens there, never in app memory. | `src/lib/deviceKey.ts`, `modules/secure-enclave/` |
| 4 | **Write Content Credentials into the file.** A real C2PA manifest — CBOR claim, hard binding, COSE_Sign1 — inside the JPEG, PNG, MP4, MOV or M4A itself. Any C2PA reader can open it. | `src/c2pa/` |
| 5 | **Add a second signature for later.** ML-DSA-65 (FIPS 204) over the same commitment, so a future break of P-256 doesn't quietly invalidate an archive. | `src/lib/pq.ts` |
| 6 | **Anchor the time.** RFC 3161 countersignature when there's a network; an OpenTimestamps receipt for independent proof-of-existence. Offline, it signs without and says so. | `src/lib/timestamp.ts`, `src/lib/ots.ts` |

Sealing and checking both work with the radio off. There are no accounts, no analytics,
and no launch-time network calls of any kind. Every optional network event is enumerated
in [`docs/NETWORK.md`](docs/NETWORK.md).

## It proves the file. Not the scene.

A seal says these bytes haven't changed since this phone signed them, and which key
signed them. It does **not** prove what the camera was pointed at. A photograph of a
screen, a staged scene, or an AI image shot off a monitor will all seal perfectly.

The app says this on screen, in plain words, every time. The camera commits; it never
concludes.

## The interface is open too

Getting the cryptography right is half the problem. The other half is telling someone
what a signature actually means without overstating it — and that lives in the
interface. It's all here: design tokens, the UI kit, and the screens.

- **Five rungs, never a badge.** The verdict surface is a ladder, not a shield. Each
  rung is a separate question with its own answer, and an unreached rung says why.
  There are no seals or checkmark icons anywhere in the product — they read as
  authority claims, and this software isn't an authority. *(`src/components/TrustLadder.tsx`)*
- **The card survives the crop.** It carries its own title and limits *inside* the
  frame, so it still tells the truth when someone screenshots it.
- **Words the product may never use.** A test fails the build if *verified*,
  *authentic*, *trusted*, *proven*, *real*, *secure* or *guaranteed* appears in a
  verdict position. Operations that genuinely ran keep their precise verbs.
- **Unsigned is neutral grey, never red.** Absence of a credential is not evidence of
  tampering, so it isn't coloured like it.
- **A dual light/dark palette** resolved at module load, with contrast ratios recorded
  next to the values that carry the product's honesty sentences. *(`src/theme.ts`)*

## What you can take

Most of this is platform-neutral TypeScript with no build step.

| Path | What it is, and why you might want it |
|---|---|
| `src/c2pa/` | A complete, dependency-light C2PA implementation: CBOR claims, COSE_Sign1, JPEG APP11/JUMBF, PNG `caBX`, BMFF/MP4 embedding with chunk-offset repair, and the verifier. Cross-checked against `c2patool` on every CI run. |
| `src/lib/` | Crypto plumbing, all pure TS: a strict X.509 chain verifier, an RFC 3161 token verifier, COSE/DER, ECDSA signing, the ML-DSA-65 layer, AES-256-GCM, canonical JSON. No WebCrypto, no network. |
| `src/provenance/` | The pipeline that turns a capture into a sealed record — orchestration, schema, background seal queue, detached manifests, and a differential oracle that cross-checks two independent engines against each other. |
| `src/vault/` | Encrypted on-device storage. Media, records and thumbnails are all sealed; plaintext only ever exists in a cache folder shredded on lock. |
| `src/disclosure/` | Selective disclosure — commit at capture, reveal per field later, without breaking the original signature. |
| `src/theme.ts`, `src/components/`, `app/` | The whole interface: tokens, UI kit, and the screens — capture, inspect, exhibits, settings, onboarding. |
| `modules/` | The native Swift: Secure Enclave keygen and signing, App Attest, the AVFoundation capture engine, the raw-audio sink, the C2PA Rust binding, Wi-Fi claims. |
| `server/` | A zero-dependency App Attest relay in one file. Run your own, or skip it — offline devices simply sign unattested and say so. |
| `tests/` | The lab: 27 suites that run the real shipping code against real forgeries. |

## Run the lab

```sh
node tests/stage.mjs
cd tests/.staged && npm install
./node_modules/.bin/tsx test-verification.mts     # → 146 passed, 0 failed
```

The staging script rewires only device services — keychain, filesystem, device model —
to small shims. Every cryptographic operation is the code that runs on the phone. The
suites sign fresh media with a random key on each run, then attack it: flipped bits,
transplanted manifests, self-issued "O=Reuters" certificates, truncated files, hostile
parsers.

Put `c2patool` on your path and the independent-verifier checks run too, cross-checking
the output against the reference C2PA implementation. Without it those checks report
`SKIP` and are counted separately — never silently passed.

## Things worth doing next

Genuinely open — no coordination needed, no permission to ask.

- **An Android port.** The provenance core is platform-neutral. What's needed is the
  equivalent of `modules/secure-enclave` against Android Keystore and Play Integrity;
  the record format and verifier carry over unchanged.
- **A standalone verifier.** Wrap `src/c2pa/verifyAsset.ts` in a CLI so anyone can
  check a file with `npx`, no app required.
- **Better time anchoring.** TSA root anchoring is the honest gap — there's no mature
  public root store for timestamping the way there is for the web PKI. A curated,
  auditable trust list would help everyone working in this space.
- **Newsroom key custody.** Rosters and revocation are implemented and lab-pinned, but
  how a desk actually enrols and retires a photographer's key deserves real field design.
- **Attack it.** If you can make a forged file verify, that's a contribution to the
  field. The suites in `tests/` show the shape of a good repro.

## Honest limits

- **Two checks it doesn't perform:** TSA root anchoring and certificate revocation.
  Both are named on every verification rather than silently skipped.
- **Sensors are claims, not facts.** Time, GPS, heading and altitude are what the
  device reported, bound into the signature. The binding is real; whether the device
  told the truth is a separate question.
- **Stereo capture is pending on-device validation** on iPhone 17 / iOS 26. The stereo
  *verification* code is lab-tested; the capture path uses Apple's virtual dual-wide
  device graph and hasn't been confirmed in the field yet.
- **This is beta software**, written with AI assistance and held to account by the test
  lab, an independent reference verifier, and a differential oracle — see
  [`docs/PROVENANCE.md`](docs/PROVENANCE.md). It carries no conformance certification.
  Don't keep your only copy of something important in it.

## Building it

See [`docs/BUILDING.md`](docs/BUILDING.md). It's an Expo app: `npm install`, then
`npx expo run:ios` on a Mac with Xcode. The Secure Enclave and App Attest paths need a
real device — the simulator falls back to a software key and labels itself as such.

Forking for your own build: `app.json` carries a placeholder EAS project id, and the
App Attest app id in `src/lib/appleAttestRoot.ts` is bound to this project's team —
both need to be yours.

## Documentation

[`ARCHITECTURE.md`](docs/ARCHITECTURE.md) · [`THREAT-MODEL.md`](docs/THREAT-MODEL.md) ·
[`SECURITY.md`](docs/SECURITY.md) · [`INTEGRITY.md`](docs/INTEGRITY.md) ·
[`NETWORK.md`](docs/NETWORK.md) · [`SETTINGS.md`](docs/SETTINGS.md) ·
[`DECISIONS.md`](docs/DECISIONS.md) · [`RECOVERY.md`](docs/RECOVERY.md) ·
[`PROVENANCE.md`](docs/PROVENANCE.md)

## License

Apache-2.0 — see [LICENSE](LICENSE), and [NOTICE](NOTICE) for attribution that travels
with redistribution. The name "Source Kit" is a trademark and isn't licensed for
derivative use ([TRADEMARK.md](TRADEMARK.md)): fork it freely, ship it under your own
name. If you build something with this, I'd love to hear about it.
