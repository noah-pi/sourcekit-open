# Source Kit — open provenance core

**Show your work.**

This repository publishes the **auditable core** of
Source Kit — an iOS provenance camera whose every capture is
cryptographically sealed on-device with genuine
[C2PA Content Credentials](https://c2pa.org) embedded in the file itself.

> **Naming (0.18.3).** The product is **Source Kit** (it was Signet Cam,
> then Source, briefly Exhibit A in this repo's docs); the sealed file is
> still *an exhibit*; its C2PA manifest is *the label*; the signing key's
> identity is *the hand*; roster enrollment is *accession*. Museum grammar,
> chosen because a label describes the object without adjudicating it —
> which is exactly what this software does. Product copy bans the
> adjudication words (verified, authentic, trusted, proven, real, secure,
> guaranteed) in verdict position; operations that actually ran keep their
> precise verbs ("signature mathematically valid", "proven tamper"). The
> repository and code identifiers keep their historical names — renaming
> symbols is churn, not honesty. Concretely: the slug, URL scheme, and
> bundle identifier remain `verify-app` / `verify` / `com.verify.camera` —
> renaming shipped identifiers breaks installs, and the App Attest keys are
> bound to them. **Source Kit** is the display name, and the rename stops
> there deliberately.

We open-source the parts a skeptic needs to check our claims, and we publish
the validation suites that prove them. You can run every cryptographic claim
in this README yourself, offline, in about five minutes (see
**Reproduce our results** below). Found a vulnerability while checking?
Please report it privately — see [SECURITY.md](SECURITY.md).

## What's inside

| Path | What it is |
|---|---|
| `src/provenance/` | The provenance pipeline: attestation orchestration (`attest.ts`), record schema (`manifest.ts`), background seal queue (`sealQueue.ts`), detached manifests (`detached.ts`), per-track streamed chunks (`trackChunks.ts`), signed pose traces (`poseTrace.ts`), OTS queue (`otsQueue.ts`), the file-to-verifier wrappers (`verifyFs.ts`), and the engine layer (`engine/` — hand-rolled engine, upstream engine, the iOS binding `upstreamEngineIos.ts` whose normalization is verbatim from the desk engine, policy layer, differential oracle) |
| `archive/handrolled-verifier/` | The hand-rolled C2PA engine (archived, still wired as the differential oracle and the desk's engine): manifest construction & verification (`c2pa.ts`), JPEG APP11 embed (`jpegApp11.ts`), PNG `caBX` embed (`png.ts`), BMFF/MP4/MOV/M4A embed (`bmff.ts`), the two-axis verifier (`verifyAsset.ts`), the offline App Attest verifier (`verifyAppAttest.ts`) |
| `src/lib/` | Crypto plumbing: the X.509 chain verifier (`x509.ts`), the RFC 3161 token verifier (`rfc3161.ts`), the pinned Apple App Attestation root (`appleAttestRoot.ts`), COSE/X.509 (`cert.ts`, `der.ts`), ECDSA record signing (`sign.ts`), the ML-DSA-65 dual-signature layer (`pq.ts`, `pqKeyStore.ts`), RFC 3161 token acquisition (`timestamp.ts`), Secure Enclave + App Attest bridges (`deviceKey.ts`, `enclave.ts`, `appAttest.ts`), org credentials (`orgCert.ts`), PIN lockout (`pinLockout.ts`), AES-256-GCM vault cipher (`cipher.ts`), canonical JSON (`canonical.ts`), on-device transcription bridge (`audioCapture.ts`, `transcript.ts`), opt-in Wi-Fi network claim bridge (`wifi.ts`), the five-rung trust-ladder projection (`trustLadder.ts`) |
| `src/vault/` | The encrypted on-device vault (`vaultFs.ts`, `passcode.ts`) — media, attestation records and grid thumbnails are all AES-256-GCM sealed; plaintext only ever exists in a cache folder shredded on lock/background |
| `src/store/` | Settings/state the crypto code reads (`useStore.ts`) |
| `modules/` | Native modules: `secure-enclave` (Swift — Enclave keygen/signing, App Attest), `audio-capture` (Swift — recording, the raw LPCM master sink, and on-device live transcription), `c2pa-ios` (Swift — the c2pa-rs FFI binding plus the vendored C2PA Rust sources under `ios/Vendor/`), `capture-kit` (Swift capture helpers), and `wifi-info` (Swift — the opt-in Wi-Fi claim's native read) |
| `server/` | The zero-framework attestation relay (App Attest verification, rate-limited — since 0.9.5 its only job). Runs on any node 20+ host |
| `desk/` | Source Kit Desk (since 0.9.4): the newsroom verifier — a local web app that checks media, proof bundles, and hash claims entirely in the browser, importing this same `src/` tree (never a fork). Includes the roster editor and the "how we know this" export. See `docs/DESK.md` |
| `tests/` | The validation lab: staging script, shims, and the exact suites quoted below |

## What's deliberately NOT inside — and why

The app shell (screens, onboarding, components, theme, store branding, the
Inspect reader's display mapping), the camera engine
(`modules/exhibit-camera/` and its bridge), and the sensor-collection glue
(GPS/compass/barometer permission orchestration — the disclosure accounting
it feeds is public and lab-tested). None of it is secret for security's sake:
key custody, attestation, signing, and verification are all in this repo.
The shell stays out because a provenance app's entire value is that users can
trust what they install — a one-command fork that ships a pixel-identical
lookalike under the same name is the one supply-chain attack we can cheaply
prevent. The camera engine stays out because it's the product's core
engineering; the claims it makes are bound into records by the public
attestation code above, so nothing it proves is hidden. Everything that makes
a *security claim* is here; what's withheld makes no claims.

If you fork this core to build your own signer: wonderful, that's the point —
ship it under your own name.

## The claims, and how they're enforced

- **Verification is proof, not presence (0.8.0).** Every credibility claim the
  verifier shows is backed by an on-device cryptographic check, and the
  report lists what was and was not checked. X.509 chains verify link by link
  (ECDSA P-256/P-384, RSA) against compiled-in pinned roots — never a root
  fetched at runtime. RFC 3161 timestamps verify fully: imprint, CMS
  signature, TSA chain, validity at genTime. Apple hardware attestation
  verifies offline against the pinned Apple App Attestation root, including
  the nonce-extension binding to exactly the signing key. A failed
  attestation/timestamp/chain is a red warning and never moves the integrity
  verdict — integrity and credibility are separate axes, shown separately.
  Signer identity resolves only against out-of-band anchors (this device,
  an org credential) — 0.8.1 removed the manual known-signers list, which
  was itself an attack surface (see `docs/SECURITY.md`). Certificate
  validity is evaluated at the
  verified signing time, never the verifier's clock. What remains unchecked —
  TSA root anchoring, revocation — is said, in-app, on every verification.
- **Real Content Credentials.** Every signed JPEG/PNG/MP4/MOV/M4A carries a
  spec-conformant C2PA manifest: CBOR claim, `c2pa.hash.data` /
  `c2pa.hash.bmff.v2` hard binding, COSE_Sign1 (ES256) with the device
  certificate, optional RFC 3161 countersignatures. Validated against
  `c2patool` — the independent reference implementation — not just ourselves.
- **Hardware-backed keys.** Signing keys live in the Secure Enclave where
  available. Apple's App Attest certifies the device and app are genuine,
  and that certificate is cryptographically **bound to the signing key** —
  Apple gives apps no direct access to App Attest keys, so Source Kit uses
  emulated key attestation: the App Attest `clientDataHash` commits to the
  Enclave signing public key (`SHA256(challenge ‖ signingPublicKey)`), and
  Apple's nonce extension in the attestation leaf certificate vouches for
  exactly that key. Verified server-side against Apple's attestation root,
  and the binding rides in every C2PA manifest (`com.verify.app-attest`)
  so anyone can re-check it offline.
  Attestation is **strictly on demand** (0.9.5): the app ships with no
  registry address bundled and makes **no launch-time network call of any
  kind**. The handshake with an attestation registry (self-hostable — see
  `server/`) runs only when the user enters a URL in Settings and taps
  "attest now". Offline devices simply sign unattested and say so.
  A software keychain fallback exists and is **labeled as such** in the UI —
  the app never dresses it up as hardware.
- **Post-quantum dual signature (0.10.0).** Every capture also carries an
  ML-DSA-65 (FIPS 204) signature over the *same* commitment the ES256
  signature makes — on the record and on the COSE claim — so a future break
  of P-256 does not silently invalidate the archive. The PQ public key is
  committed **inside** the classically signed payload (and thereby into the
  OpenTimestamps/Bitcoin anchor), so a stripped PQ layer is detectable and a
  forged one binds to nothing. The ML-DSA key is **software** (the Secure
  Enclave cannot hold one): it is insurance against cryptanalysis, not a
  second hardware anchor, and it is labeled that way everywhere it appears.
  Assignment and de-identified copies deliberately carry no PQ layer — a
  long-lived device key would re-link them.
- **Optional Wi-Fi network claim (0.10.0, W5.7).** With an explicit opt-in
  (default off), a capture records the Wi-Fi SSID/BSSID the phone *reports*
  being connected to. This is a self-reported, trivially spoofable claim —
  anyone can name an access point anything — so it is signed as a lead a desk
  corroborates, never proof of place, and it never feeds any verdict. BSSID
  geo-lookup happens desk-side only. The claim is always stripped from
  de-identified copies, and iOS returns nothing unless the build carries the
  Wi-Fi Information entitlement and the user granted location permission —
  in which case the record honestly says `unavailable`.
- **Custody, not reality.** A valid signature proves bytes unchanged since
  signing + which key signed. It does not prove what a camera pointed at, and
  the app says so, in-app, in plain language.
- **Privacy by construction.** No accounts, no analytics. Transcription is
  on-device (Apple Speech). No media ever leaves the device: the Google
  Vision reverse-image lookup was removed in 0.9.5 — it was the only
  feature that sent media off the device.

## Reproduce our results

Requirements: node 20+, ffmpeg, and (for the independent checks) `c2patool`
0.9.12+ on PATH or via `C2PATOOL=/path/to/c2patool`.

```sh
node tests/stage.mjs          # builds tests/.staged: real code + tiny expo shims
cd tests/.staged
npm install
./node_modules/.bin/tsx test-070-final.mts       # 19 checks: all formats + tamper + red team
./node_modules/.bin/tsx test-bmff-deid.mts       # 18 checks: de-identify & re-sign flow
./node_modules/.bin/tsx test-verification.mts    # 25 checks: verifiers vs. real forgeries & hostile parsers
```

Expected: `19 passed, 0 failed`, `18 passed, 0 failed`, `25 passed, 0 failed`.
The suites sign fresh media with a random lab key on every run — nothing is
canned. The verification suite runs against openssl-generated fixtures in
`tests/fixtures/`, including a genuine RFC 3161 token and a self-issued
"O=Reuters" certificate — the exact attacks an external audit threw at 0.7.4,
now permanent regression tests.

The staging script rewrites *only* device-service imports (keychain,
filesystem, device model) to the shims in `tests/shims/`. Every cryptographic
operation — canonicalization, CBOR, COSE, hashes, X.509, ECDSA, RSA, CMS —
runs as the real shipping code.

Latest results (0.18.3, on this tree — the only checks not run locally are
the c2patool gold-standard ones, which run in CI against the SHA-256-pinned
binary):

- **146/146** — verification & forgery regression: real chains anchor and
  verify; one flipped signature bit breaks the chain; a self-issued
  "O=Reuters" cert does not anchor; genuine RFC 3161 tokens verify (and a
  different message or one flipped byte invalidates them); forged and junk
  App Attest assertions fail cleanly; absent checks report absent. Roster
  trust (membership evaluated at the verified signing time — the
  departed-photographer case stays genuine, post-revocation captures are
  red flags; revocation marks only the named member and the re-signed
  roster still verifies), OpenTimestamps receipts (strict parse; tampered
  digests and tampered attestations refused; block binding checked only
  against fetched headers), the three share modes (hash-only claims leak
  nothing — the suite scans the serialized JSON for byline/location/
  signature leakage), CSV formula-injection guards, KML escaping, and
  capture-integrity signals (timing regularity reports "no signal" rather
  than guessing under 8 samples).
- **51/51** — the trust-ladder projection (W7.3): every rung-state
  combination pinned, including the honesty rules — credentials failure
  blocks every rung above, changed media fails rung 1 only, org vouching is
  earned only outside the file, unpinned/unchecked time anchors are
  unreached and never reached, and the limits sentence ships with the card.
- **18/18** — the org identity assertion (W7.2): the org claim is
  cross-checked against the chain top inside the verifier — binding
  mismatch fails, name mismatch is a loud MISMATCH, an uncheckable
  cross-check reports the org unproven, never vouched.
- **19/19** — JPEG, PNG, MP4, MOV, M4A sign → INTACT → c2patool clean →
  tampered copies rejected by both our verifier and c2patool; transplant,
  truncation, and unsigned inputs rejected.
- **18/18** — de-identified video/audio verify INTACT and pass c2patool;
  identity/location redacted; transcript byte-level absent; tamper still
  caught; original capture time preserved.
- **33/33** — the reference corpus (`tests/corpus/`): genuine captures
  INTACT (including the signed pose trace and capture-integrity signals),
  tampered/stripped/hostile/recaptured inputs all correctly rejected.
- **10/10** — the full-offline chain (0.9.5): with every network call
  rejecting, capture signs, verification returns INTACT while performing
  **zero** fetches (counted), timestamp tokens and App Attest report
  honestly absent, tampering is still caught, and every export builds.
- **13/13** crypto red-team attacks rejected (see `docs/SECURITY.md`).
- **New in 0.15.0:** vault hygiene 8/8 (atomic index write, fail-loud
  corruption, rebuild from sealed records), commit-at-capture 51/51,
  stereo/match suites 49/49 · 45/45 · 45/45 · 80/80, oracle 32/32,
  detached 19/19, disclosure 58/58, pose trace 31/31, policy layer 28/28,
  PQ 39/39 — every suite in `tests/` green, with the manifest parser now
  fail-closed on malformed records (the exported-dossier injection fix).

Milestone notes live in `docs/RELEASE-0.9.0.md` through
`docs/RELEASE-0.9.5.md`; the desk tool has its own guide in
`docs/DESK.md`, and recovery matching its honesty model in
`docs/RECOVERY.md`. The 0.10.0 docs set: `docs/THREAT-MODEL.md` (named
adversaries, the AI-assisted-attacker assumption, 26 scenarios),
`docs/DECISIONS.md` (the engine and deferral record), `docs/SETTINGS.md`
(the long-form explanations behind the app's terse rows),
`docs/SECURITY.md` (audit-and-fix history), `docs/INTEGRITY.md`
(per-signal bounds), `docs/NETWORK.md` (every network event, named).

## License

Apache-2.0 — see [LICENSE](LICENSE). The server is included under the same terms.
