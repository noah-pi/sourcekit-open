# Security design and known gaps

How the system defends itself, and what it doesn't defend against. For named
adversaries and scenarios see [THREAT-MODEL.md](THREAT-MODEL.md). To report a
vulnerability see [SECURITY.md](../SECURITY.md) in the repo root.

## What it defends against

- Forging or altering a signed file: pixel edits, metadata edits, manifest
  surgery, transplanting credentials onto different media.
- Passing off one device's signatures as another's.
- Replaying App Attest challenges, or reusing another key's attestation.
- Extracting identifying details — byline, GPS, sensors, transcript — from the
  on-device vault or from shared de-identified copies.
- Abusing the attestation relay: request flooding, memory exhaustion.

## What it doesn't

- **What the camera was pointed at.** Signatures prove custody of bytes, not
  reality. Screenshots of screens, staged scenes and AI images photographed off
  a monitor are all validly signed. The app never calls content real.
- **A compromised or jailbroken device.** Signing happens in the app's own
  process, so code execution there can feed the signer pixels of its choosing.
  App Attest raises the cost and the key binding keeps the attack per-device,
  but it isn't a guarantee. In-pipeline hardware signing — the Pixel 10, or a
  Snapdragon TEE — closes this properly in a way an app can't. See
  [THREAT-MODEL.md](THREAT-MODEL.md) ▸ Where the signature sits.
- **Stripped credentials.** Any file can have its manifest removed, and the
  absence of credentials proves nothing either way.

All three are stated in the app, not just here.

## Cryptographic design

**Record signing.** ES256 — ECDSA P-256 with SHA-256 — over the SHA-256 of a
canonical-JSON record. Every signing path (software keychain, Secure Enclave,
biometric Enclave) normalizes signatures to low-S canonical form, and verifiers
enforce `lowS`, so malleated signatures are rejected and genuine ones always
verify.

**C2PA binding.** `c2pa.hash.data` for JPEG and PNG, with a byte exclusion
spanning exactly the manifest container; `c2pa.hash.bmff.v2` for MP4, MOV and
M4A, with `stco`/`co64` offset repair after the `uuid` box is inserted. Embedding
is a length-pinned fixpoint: hash values never influence layout size.

**Keys.** Secure Enclave where available, non-extractable. App Attest certifies
that a genuine build is running on genuine hardware, bound to the signing key by
emulated key attestation: `clientDataHash = SHA256(challenge ‖ signingPublicKey)`,
with the full Apple chain verified server-side, `rpIdHash` bound to the app id,
single-use 5-minute challenges, and the leaf certificate's nonce extension
checked against exactly that construction. The software fallback is labelled as
software in the UI.

**Vault.** AES-256-GCM, a random 12-byte nonce per item, key in the OS keychain
under `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Media, attestation records and the seal
queue are all encrypted at rest. A GCM tag failure is a read failure, not silent
corruption.

**Timestamps.** RFC 3161 countersignatures from public TSAs, embedded as COSE
countersigns and verified on-device in `src/lib/rfc3161.ts`. The messageImprint
must match the exact timestamp message per the RFC 5652 countersignature
construction; the CMS signature must verify over correctly re-tagged signedAttrs
(SET OF, tag 0x31); the TSA chain's links must verify; and the TSA certificate
must have been valid at genTime.

**Certificate chains.** `src/lib/x509.ts` verifies every link — ECDSA P-256 and
P-384, and RSA PKCS#1 v1.5 through a constant-structure modpow rather than `s**e`
then mod. Name chaining is byte-exact DER comparison. CA flags are checked.
Validity is evaluated at the *verified signing time* — the earliest valid RFC
3161 genTime — never the verifier's own clock.

A chain anchors only to a compiled-in pinned root; the Apple App Attestation
root ships in the binary as `src/lib/appleAttestRoot.ts`. A valid chain to a
self-asserted root is displayed as exactly that.

**Signer identity.** Resolves only against anchors outside the file: this
device's key, or an org credential chained to a real CA. Nothing inside a file
can claim or upgrade identity.

There is no manual known-signers list. Full 64-character fingerprints are shown
for out-of-band comparison — prefix comparison invites fingerprint grinding,
which is about 4 billion tries for 8 hex characters. Identity reads as this
device, an org credential, a roster, a trust list, or unknown.

Editor-signed newsroom rosters ship (import-only in the app), as does the
five-rung trust ladder in `src/lib/trustLadder.ts` — a projection of the
verification report, not a second verdict engine.

**PIN lockout.** The 6-digit app passcode has an escalating lockout
(`src/lib/pinLockout.ts`): 4 free failures, then 30 s doubling to a 5-minute
ceiling, persisted in SecureStore so a force-quit doesn't reset it.

## Proof, not presence

No badge is earned by a box merely existing. Each of these is enforced by an
on-device cryptographic check.

1. **Hardware attested** requires a full offline verification: a chain to the
   pinned Apple root, `rpIdHash` bound to this app, and Apple's nonce extension
   recomputed against `SHA256(authData ‖ SHA256(challenge ‖ signingPublicKey))`
   for exactly the manifest's signing key (`src/c2pa/verifyAppAttest.ts`).
2. **Timestamped** means real RFC 3161 verification per token. A displayed
   capture time uses only cryptographically valid tokens, never a scrape of
   genTime.
3. **Certificate chain** means real link verification, not `chain.length > 1`. A
   valid chain to a self-asserted root says so, and adding intermediates can't
   suppress the caveat.
4. **Org credential import** runs the chain verifier and rejects a forgery at the
   door. A self-issued "O=Reuters" cert doesn't import as genuine.

The Apple root is pinned in the app binary and embedded in the server source.
Anything fetched at runtime is an input, never an anchor. The server's nonce
check is a real DER walk requiring exactly one 32-byte value in context [1],
never a substring scan.

## Parser robustness

The verifier parses hostile input by definition, so the parsing rules are part
of the security surface.

**DER length decoding is multiply-accumulate**, exact to 2^53, and never wraps.
`len = (len << 8) | byte` is a 32-bit signed shift in JavaScript: a 4-byte length
of `0xFFFFFFFA` decodes to −6, an overrun guard passes against a negative, and a
TLV walker loops forever. Every walker — `src/lib/x509.ts`, `src/lib/orgCert.ts`,
`server/server.mjs` — validates offset and length on every TLV and enforces a
non-advancing-walker invariant (`next <= o` throws) that closes the class
regardless of what the length field claims. `tests/test-fuzz.mts` throws several
hundred randomly generated buffers at each of five walkers, plus a set of fixed
poison cases; every one must terminate or throw, so a regression hangs CI rather
than shipping.

**Non-finite certificate dates are a parse error**, never a passed validity
window. `atMs < NaN` is always false, so an unparseable date would otherwise
pass silently.

**Base64 validates strictly** and throws on any non-alphabet byte. Indexing a
lookup table with an invalid character yields `undefined`, and `|| 0` would
quietly turn that into a zero sextet. Verification paths convert the throw into
a clean FAILED verdict.

**The active manifest is the last one**, per the C2PA update-chain rule. The
report states when a store contains several: "store contains N manifests —
verified the active (most recent) one; earlier manifests not evaluated."

## Attacks the suites pin

Each of these is a permanent regression test: manifest transplant onto
different media, claim tamper in JPEG and PNG, assertion and telemetry tamper,
pixel tamper, ECDSA high-S malleability, exclusion-range tamper, truncated
files, trailing garbage after IEND, random garbage, and unsigned files.

A tampered or transplanted file fails the hard binding. A malleated signature
fails the low-S check. A junk or truncated container fails the parser closed.

The suites also pin the data-at-rest guarantees:

- De-identified JPEGs carry no EXIF. A lossless segment stripper removes APP1,
  APP13 and COM while leaving pixels byte-identical.
- Vault attestation records and the background seal queue — byline, GPS,
  transcript — are AES-256-GCM sealed with the vault key, never plaintext.
- De-identified copies carry the original capture time, so every remaining claim
  stays literally true.

## The relay

- A zero-dependency sliding-window rate limiter, keyed after verification on the
  unforgeable attested keyId.
- Expired challenges swept under a hard cap. `/attest` request bodies capped at
  2 MB, with the connection killed on overflow.
- Server state (challenges, rate buckets) checkpointed to the mounted volume, so
  it survives a SIGTERM and restart.
- No `/devices` listing. A public roster of real journalist hardware is a
  liability, so the endpoint returns 404.

## Attacks that aren't fixable in code

Screenshot-the-green, strip-and-discredit, tamper-to-red and the liar's dividend
all attack *readers*, not cryptography.

The defence is claim discipline. A reached rung means "these bytes are unchanged
since this key signed them", never "this is real", and every verification shows
which checks were performed and which weren't.

## Known gaps

- **No revocation checking anywhere.** Device certs, org chains and TSA certs are
  verified for structure, validity window and — for TSAs — EKU, but never against
  CRLs or OCSP. A compromised-but-unexpired key keeps verifying until its cert
  expires. What exists instead: org credentials are short-lived and
  device-bound, and newsroom rosters are editor-signed and replaceable, so a
  leaked key is removed by re-issuing the roster, whose own timestamp bounds its
  membership. A real revocation story needs infrastructure that doesn't exist
  yet across this ecosystem. Listed under "not checked" in-app.
- **TSA trust is reputational.** Tokens are fully verified, but TSA chains aren't
  anchored to a curated trust list, because no mature public TSA root store
  exists. A valid token proves this TSA's key signed this imprint at genTime;
  whether to trust that TSA is a separate judgment. Said on every verification.
- **Emulated key attestation is a binding, not a key.** Apple gives apps no
  SecKey access to App Attest keys. The construction binds the Enclave signing
  key into the attestation, which proves an Apple-certified genuine device and
  app bound to this signing key. It does not make the signing key itself an App
  Attest key.
- **PIN lockout is device-local hardening.** It raises the cost of casual
  probing. It is not a substitute for the iOS passcode and hardware protections,
  and a wiped or reinstalled app resets it — though the vault key dies with the
  keychain in that case anyway.
- **Seal-queue draft media** (`.jpg`, `.m4a`) sit as plaintext in the app
  container for the seconds to minutes before sealing, protected by iOS Data
  Protection and deleted afterwards.
- **Server state persistence is best-effort**, on a 5 s debounce. A hard crash —
  not a deploy, which flushes on SIGTERM — can lose a few seconds of rate-limit
  counts. Challenges expire in 5 minutes regardless.
- **Device migration isn't supported.** Enclave and keychain keys are per-device
  by design. Exported signed files stay verifiable forever; the vault doesn't
  move.
- **c2patool labels self-signed device certificates "untrusted issuer"** until an
  org credential chains them to a real organization. Expected, and the app
  explains it.

## Worth building

Per-capture App Attest assertions, whose counter would expose cloned keys, at
the cost of a network call at capture time. Key-continuity trust, earned by a
key's own countersigned history. Moving the vault key into the Enclave. Re-keying
on de-identify, to break fingerprint linkability between copies.
