# Security notes — Source Kit 0.10.0 (audit history through 0.8.1)

How the system defends itself, what was audited, what was found, and what we
consciously accept. If you find a hole, please open an issue — that is exactly
why this repo exists. **The current threat model — named adversaries, the
AI-assisted-attacker assumption, and 26 scenarios with their honest statuses —
lives in `THREAT-MODEL.md`; this file is the audit-and-fix record.**

## Reporting a vulnerability (disclosure policy)

- **Where:** open a GitHub issue for anything that is *not* exploitable on its
  face (robustness bugs, parser weirdness, documentation errors). For
  something that *is* exploitable — a forgery path, a key-exposure path, a
  remote DoS — email the maintainer privately first (address in the repo
  profile) and give us 90 days before public disclosure.
- **What you get:** acknowledgment within 72 hours, credit in the fix commit
  and in this file's audit record unless you ask otherwise, and a straight
  answer about whether we agree it's a hole.
- **Scope honesty:** this is a reference implementation in beta — it carries
  no production certificate and no conformance record. A finding that
  requires a jailbroken device or physical possession is *documented
  accepted risk* (see below), not a vulnerability, unless it defeats a
  protection we explicitly claim.
- **Every confirmed finding becomes a permanent regression test** — that is
  the standing rule of this repo since the 0.8.1 audit, and the fuzz suite
  (`tests/test-fuzz.mts`) exists so the *class* of parser bugs stays dead,
  not just the instance.

## Threat model

**We defend against:**
- Forging or altering a signed file (pixel edits, metadata edits, manifest
  surgery, transplanting credentials onto different media).
- Passing off one device's signatures as another's.
- Replaying App Attest challenges or reusing another key's attestation.
- Extracting identifying details (byline, GPS, sensors, transcript) from the
  on-device vault or from shared "de-identified" copies.
- Abusing the attestation relay (request flooding, memory exhaustion).
  (Pre-0.9.5 this included draining the Google Vision budget; that route,
  its budget, and its app client were removed in 0.9.5.)

**We do not defend against (and say so in-app):**
- What the camera was pointed at. Signatures prove custody of bytes, not
  reality. Screenshots of screens, staged scenes, and AI images signed by a
  device are *validly signed* — the app never calls content "real".
- A compromised/jailbroken device (Secure Enclave extraction is out of scope;
  App Attest raises the bar, it is not a guarantee).
- Stripped credentials. Any file can have its manifest removed; absence of
  credentials proves nothing either way.

## Cryptographic design

- **Record signing**: ES256 (ECDSA/P-256 + SHA-256) over SHA-256 of
  canonical-JSON record. All signing paths — software keychain, Secure
  Enclave, biometric Enclave — normalize signatures to
  **low-S** canonical form; verifiers enforce `lowS`, so malleated signatures
  are rejected and genuine ones always verify.
- **C2PA binding**: `c2pa.hash.data` (JPEG/PNG) with a byte-exclusion spanning
  exactly the manifest container, or `c2pa.hash.bmff.v2` (MP4/MOV/M4A) with
  stco/co64 offset repair after `uuid` box insertion. Embed is a length-pinned
  fixpoint — hash values never influence layout size.
- **Keys**: Secure Enclave where available (non-extractable); App Attest
  certifies device + app genuineness, bound to the signing key by emulated
  key attestation (`clientDataHash = SHA256(challenge ‖ signingPublicKey)`;
  full Apple chain verified server-side, rpIdHash bound to the app id,
  single-use 5-minute challenges, the leaf-certificate nonce extension
  checked against exactly that construction). Software fallback is labeled
  in the UI as software.
- **Vault**: AES-256-GCM, random 12-byte nonce per item, key in the OS
  keychain `WHEN_UNLOCKED_THIS_DEVICE_ONLY`. Media, attestation records, and
  the seal queue are all encrypted at rest. GCM tag failure = read failure,
  not silent corruption.
- **Timestamps**: RFC 3161 countersignatures from public TSAs, embedded as
  COSE countersigns. Since 0.8.0 each token is **cryptographically verified
  on-device** (`lib/rfc3161.ts`): messageImprint must match the exact
  timestamp message (RFC 5652 countersignature construction), the CMS
  signature must verify over correctly re-tagged signedAttrs (SET OF tag
  0x31), the TSA chain's links must verify, and the TSA certificate must have
  been valid at genTime. Stated plainly, and listed under "not checked": TSA
  chains are **not yet anchored to a curated TSA trust list** (the ecosystem
  has no mature public equivalent of the WebPKI root store), and revocation
  (OCSP/CRL) is not consulted. A token therefore proves "this TSA's key signed
  this imprint at genTime" — the trustworthiness of the TSA itself is, for
  now, the TSA's reputation.
- **Certificate chains**: since 0.8.0 a real X.509 engine (`lib/x509.ts`)
  verifies every link (ECDSA P-256/P-384 and RSA PKCS#1 v1.5 — RSA via
  constant-structure modpow, never `s**e` then mod), name chaining by
  byte-exact DER comparison, CA flags, and validity at the **verified signing
  time** (earliest valid RFC 3161 genTime) — never the verifier's clock. A
  chain "anchors" only to a compiled-in pinned root (the Apple App
  Attestation root ships in the binary; `lib/appleAttestRoot.ts`). A valid
  chain to a self-asserted root is displayed as exactly that.
- **Signer identity**: resolves only against anchors outside the file —
  this device's key, or an org credential chained to a real CA. Nothing
  inside a file can claim or upgrade identity. 0.8.1 **removed** the manual
  "known signers" list: a confirm-a-stranger's-key ritual is itself an
  attack surface (an attacker social-engineers their way onto the list and
  is from then on displayed as trusted), and prefix-comparison habits made
  fingerprint grinding (~4 billion tries for 8 hex chars) practical.
  Identity is now honestly "this device / org credential / unknown", with
  the full 64-character fingerprint shown for out-of-band comparison. The
  replacement is **key continuity** (roadmap): trust earned by a key's own
  countersigned history, never by a manual ritual. Since 0.10.0 the roster
  and trust-ladder layers are SHIPPED: editor-signed newsroom rosters
  (desk-administered, app import-only; revocation semantics lab-pinned) and
  the five-rung trust ladder (`lib/trustLadder.ts`) — a projection of the
  verification report, never a second verdict engine. CAWG conformance and
  Trust List anchoring remain roadmap (W10), not shipped.
- **PIN lockout**: the 6-digit app passcode now has an escalating lockout
  (`lib/pinLockout.ts`) — 4 free failures, then 30 s doubling to a 5-minute
  ceiling, persisted in SecureStore so force-quit does not reset it.

## The 0.8.0 external audit — presence is not proof

An independent reviewer audited the 0.7.4 tree and found the signing side
genuine but the verifying side checking **presence, not proof**. We verified
every claim against the code before acting; the reviewer was right on the
substance. Everything below was fixed before 0.8.0 shipped — nothing shipped
in between.

**Badge overclaims (the core findings — each violated our own "every security
claim literally true" rule):**
1. "Hardware attested" badge required only that a `com.verify.app-attest`
   box exist → now a full offline verification: chain to the pinned Apple
   root, rpIdHash bound to this app, and Apple's nonce extension recomputed
   against `SHA256(authData ‖ SHA256(challenge ‖ signingPublicKey))` for
   exactly the manifest's signing key (`provenance/verifyAppAttest.ts`).
2. "Timestamped" counted tokens and scraped their genTime with a regex →
   now real RFC 3161 verification per token; a displayed capture time uses
   only cryptographically valid tokens.
3. "Certificate chain" was `chain.length > 1` — and worse, a multi-cert
   chain *suppressed* the self-signed warning, so a forgery looked **more**
   credible than a genuine capture → now real link verification; a valid
   chain to a self-asserted root says so; the self-signed caveat cannot be
   suppressed.
4. Org credential import never verified the CA actually signed the leaf →
   a self-issued "O=Reuters" cert imported cleanly → import now runs the
   chain verifier and rejects the forgery at the door.

**Trust-anchor and server findings:**
5. The Apple root was fetched from the network at runtime → pinned, in the
   app binary and embedded in the server source; anything fetched
   at runtime is an input, never an anchor.
6. Server nonce check was a substring scan (with an abandoned `void nonceOid`)
   → real DER walking to the nonce extension, requiring exactly one 32-byte
   value in context [1].
7. `/devices` listed every registered device to the world → removed entirely.
   A public roster of real journalist hardware is an opsec liability.
8. The device registry was write-only from the app's perspective — attestation
   *displayed* credibility no one could check → the offline verifier (1) is
   the check; the registry remains for server-side abuse control only.

**Hardening findings:**
9. No lockout/delay/attempt counter on the 6-digit PIN → escalating lockout
   (above).
10. The test suite was excluded from `tsconfig` and had silently rotted
    (stale imports that could no longer compile) → repaired, un-excluded, and
    extended into a forgery-regression suite (`scripts/test-verification.mts`,
    mirrored in `tests/` here): the audit's own attacks as permanent tests —
    junk x5chain → chain badge broken, never green; forged attestation →
    FAILED; junk/tampered tokens → timestamps invalid. It runs on real
    openssl-generated fixtures, including a genuine RFC 3161 token, so the
    verifiers — not parser error-handling — do the rejecting.

Writing the regression suite caught two real verifier bugs before ship: the
CMS signed-bytes re-tag used SEQUENCE (0x30) where RFC 5652 §5.4 requires
SET OF (0x31) — which would have rejected every genuine token — and a TSA
that includes its own certificate twice was mistaken for a two-cert chain.
Both fixed; both now covered by tests.

**Audit points we checked and found overstated** (for the record): the nonce
substring check was ugly but not exploitable (a forged nonce cannot survive
the real chain check — the leaf is Apple-signed); eas.json PII never entered
the public repo.

## The 0.8.1 external audit — parser robustness and the human layer

A second independent reviewer probed the 0.8.0 tree for implementation bugs
and "inverse attacks" (using the verifier itself as the weapon). We again
verified every claim against the code before acting. Four findings were real
and exploitable; all four were fixed before 0.8.1 shipped, with the attack
inputs as permanent regression tests.

**Parser robustness (the critical findings):**
1. **DER length arithmetic used 32-bit signed shifts — a one-file remote
   wedge.** `len = (len << 8) | byte` wraps in JavaScript: a 4-byte length of
   `0xFFFFFFFA` decodes to **−6**, the overrun guard passes against a
   negative, and the TLV walker loops forever. Reachable from any crafted
   certificate inside a file handed to Source Kit — and, worse, from the public
   unauthenticated `/attest` endpoint, whose parser had no guards at all (the
   reviewer demonstrated exit=124, a wedged worker). Fixed everywhere
   (`lib/x509.ts`, `lib/orgCert.ts`, `server/server.mjs`): multiply-accumulate
   length decoding (exact to 2^53, never wraps), offset/length validation on
   every TLV, and a hard **non-advancing-walker invariant**
   (`next <= o` → throw) that kills the entire bug class regardless of what
   the length field says. Regression: the reviewer's stall payload plus a
   4000-buffer fuzz over every DER walker must terminate or throw — a future
   regression now hangs CI loudly instead of shipping silently.
2. **NaN validity-window bypass.** An unparseable certificate date produced
   `NaN`; `atMs < NaN` is always false, so the validity check silently passed
   for any date. Fixed: non-finite validity dates are a parse error, never a
   passed window.
3. **Base64 decoded garbage as 'A'.** An invalid character indexed the lookup
   table to `undefined`, and `|| 0` silently turned it into a zero sextet.
   Fixed: strict character validation that throws on any non-alphabet byte,
   and verification paths convert the throw into a clean FAILED verdict.

**Verifier semantics:**
4. **Multi-manifest stores verified the *first* manifest; the C2PA spec says
   the *last* is active.** Two verifiers could legitimately produce two
   verdicts on one file. Fixed: the active manifest is the last per the
   update-chain rule, and the report states "store contains N manifests —
   verified the active (most recent) one; earlier manifests not evaluated."

**Human-layer changes (same release):**
- **Known-signers list removed** (see *Signer identity* above) — the manual
  trust ritual was the weakest link, not a feature.
- **Transcription honesty**: audio transcription is now gated on both
  hardware support (`supportsOnDeviceRecognition`) and Speech authorization,
  and the app says *why* it is off (unsupported / denied / restricted)
  instead of silently recording without it. The recording is signed and
  sealed regardless — transcription is a convenience, never part of the
  security claim.
- **One Face ID scan per capture**: biometric Enclave keys prompted per
  signature (up to three per photo). A 15-second `LAContext` session is now
  primed at the shutter and reused across that capture's signatures.

**Inverse attacks acknowledged, not fixable in code** (the reviewer's larger
point, which we endorse): screenshot-the-green, strip-and-discredit,
tamper-to-red, and the liar's dividend attack *readers*, not cryptography.
The defense is claim discipline — a green badge means "these bytes are
unchanged since this key signed them", never "this is real" — plus the
"checks performed / not performed" panel on every verification. That
discipline is exactly what this document, the in-app copy, and the regression
suites exist to protect.

**Roadmap from this audit (not shipped):** per-capture App Attest assertions
(the counter exposes cloned keys; costs network-at-capture), key continuity
trust (above), moving the vault key into the Enclave, re-keying on
de-identify to break fingerprint linkability. (The reverse-image lookup this
list once mentioned was removed outright in 0.9.5 instead of gated.)

## The 0.11.0 external audit — the container boundary and the TSA's papers

Seven findings from an adversarial review of the shipped 0.11.0 tree.

1. **Trust tier lived in the verdict enum's presentation, not the data
   model (F1) — fixed.** `verifyPhotoBytes`/`verifyVideoBytes` accept an
   injected `trustResolver` and attach the outcome to
   `report.signerTrust`; a desk scripting against the verifier sees the
   same amber as the UI. No resolver → disclosed as UNRESOLVED, never
   silently green. Pinned by `tests/test-trust-axis.mts`.
2. **157 malleable bytes (F3) — one real bug, the rest spec-conformant
   framing, all of it now enumerated and pinned.** The C2PA COSE payload
   slot was unchecked (spec requires detached/null): fixed, 157 → 156.
   The remaining set is JUMBF/APP11 container framing that is outside the
   hash by design; `docs/INTEGRITY.md` enumerates every field and
   `tests/test-malleability.mts` flips every byte of both container paths
   (JPEG + BMFF video) so the set cannot silently grow.
3. **Uncaught `undefined.length` under mutation (F7a) — fixed.**
   `c2pa.hash.data` (and `.hash.bmff.v2`) assertions were blind-cast from
   CBOR; a mutated map missing `exclusions` crashed `verifyManifest`.
   Both paths now validate structure and degrade to "integrity UNPROVEN,
   disclosed" — the malleability suite asserts no byte flip ever throws.
4. **No id-kp-timeStamping EKU check on TSA certs (F7b) — fixed.** RFC
   3161 §2.3 requires the TSA signer cert to carry the timeStamping EKU;
   without the check any general-purpose cert could mint timestamps we'd
   call genuine. Enforced (`hasKeyPurpose` in `x509.ts`), with lab TSA
   fixtures updated to be RFC-conformant and `tests/test-tsa-eku.mts`
   pinning accept/reject behavior. Same fix: one unparseable embedded
   cert (e.g. an RSA-PSS CA we don't yet verify) no longer blinds the
   whole token — certs are dropped individually and validity is decided
   by cryptography, not parser error handling.
5. **Video seal reads whole files (F4) — documented honestly, streaming
   seal deferred to 0.12.0** (the README's "chunked" claim was wrong for
   the seal path; memory numbers are the audit's).
6. **ITSAppUsesNonExemptEncryption (F6) —** flipped to `true` with the
   exemption analysis documented; final posture is a counsel question.
7. **Smaller items (F7c/d) —** revocation-checking is a documented known
   limitation (no CRL/OCSP anywhere in the ecosystem); the Swift
   `isAvailable()` stub became a real Secure Enclave probe.

## The 0.11.0 standing self-audit — the attach attack

Two passes over the finished 0.11.0 tree under the standing workflow
(cryptographic adversary + cross-examiner). Three fixed, two deferred with
reasons.

1. **A-1: a binding the signed claim doesn't reference could lend arbitrary
   media a false INTACT — fixed (the attach attack).** A genuinely signed
   claim that references no `c2pa.hash.*` assertion (a foreign signer's, or a
   crafted one) plus a self-consistent binding box added AFTER signing
   verified INTACT over media the signer never saw. Three related mislabels
   shared the root cause: no-binding claims surfaced as CONTENT_MODIFIED
   ("media altered" — absence of proof stated as proven tamper), and
   malformed exclusion sets / unwalkable containers surfaced as 'mismatch'.
   The verifier now honors a binding assertion ONLY when the signed claim
   references it, and every defective-credential shape collapses to
   `void-binding` → SIGNATURE_INVALID with UNPROVEN disclosed. Pinned by
   `tests/test-binding-guard.mts` (11 checks, including the attach attack
   end-to-end). Our own manifests were never vulnerable — every Source Kit claim
   references its binding — but the verifier is a public instrument and must
   be safe against foreign files.
2. **B-1: the vault asset chip ignored the trust axis — fixed.** The
   asset-screen chip showed green "Re-verified intact" on verdict alone;
   a vault item sealed by a key this device no longer knows (restore,
   import) earned green without an outside anchor. The chip now follows the
   same rule as the Inspect tab: green requires an anchor ('Checked and
   unchanged. The hand is unknown.' in amber otherwise).
3. **B-2: void-binding UI copy named only one void shape — fixed.** The
   SIGNATURE_INVALID subline now covers all three void causes (exclusions
   exempt the media, malformed exclusion set, no referenced binding).
4. **A-4: unsupported BMFF structures reported SIGNATURE_INVALID — fixed
   (adopted into 0.11.0).** A foreign manifest using structures we can't
   parse (e.g. merkle aux boxes) now reports a dedicated UNSUPPORTED verdict
   — "unchecked", never condemned credentials we never evaluated — with the
   reason disclosed in checksNotPerformed. Rippled through the report type,
   the app UI (neutral, "can't check this one here"), and the desk.
5. **0.12.0 backlog: duplicate assertion labels are last-wins.** A manifest
   with two same-labeled assertion boxes parses the last; consistency between
   the claim-hash check and the binding walk makes this unexploitable today,
   but rejecting duplicates outright is the stricter read of the spec.
   Bundled with the 0.12.0 foreign-manifest hardening.

## Audit history (0.7.0 cycle)

Three independent passes plus a final two-agent cleanup; every fix
re-validated in the lab.

**Crypto red team — 13/13 attacks correctly rejected.** Manifest transplant
to different media, claim tamper (JPEG & PNG), assertion/telemetry tamper,
pixel tamper, ECDSA high-S malleability, exclusion-range tamper, truncated
files, trailing garbage after IEND, random garbage, unsigned files.

**Data layer — 3 findings, all fixed.**
1. De-identified JPEGs kept their EXIF (make/model/timestamps) → added a
   lossless segment stripper (APP1/APP13/COM out; pixels byte-identical).
2. Vault attestation records were plaintext JSON (byline/location) → now
   AES-256-GCM sealed with the vault key (plaintext fallback for pre-0.7
   items).
3. The background seal queue was plaintext (GPS + byline + transcript) →
   sealed the same way.

**Server — 3 findings, all fixed and live-tested.**
1. No rate limiting anywhere → zero-dependency sliding-window limiter per
   client IP; global hourly/daily caps on the paid Google Vision route.
2. Expired challenges never swept (memory DoS) → sweep + hard cap.
3. Unbounded request bodies on /attest → 2 MB cap; the connection is killed
   and the handler rejects cleanly.

**Final cleanup audit — 2 findings, all fixed.**
1. Pinch-zoom used a multiplicative mapping that could never engage from
   zoom 0 (0 × anything = 0) → additive mapping.
2. De-identified copies stamped "captured" with de-identification time →
   they now carry the original capture time, so every claim stays literally
   true.

**Post-audit hardening (0.7.0 build 3).**
1. Server state (challenges, rate buckets, forensics budget) was in-memory
   and reset on redeploy → now checkpointed to the mounted volume
   (debounced, expired entries skipped on restore), verified across a live
   SIGTERM/restart cycle.
2. iOS audio interruptions (phone call, Siri) lost partial recordings → the
   native module now finalizes the .m4a at the last good frame on
   `AVAudioSession.interruptionNotification` and the app seals it like a
   manual stop.

## Accepted residual risks (documented, not hidden)

- **No revocation checking anywhere (0.11.0, auditor F7c).** Device certs,
  org chains, and TSA certs are verified for structure, validity window, and
  (for TSAs) EKU — never against CRLs or OCSP. A compromised-but-unexpired
  key keeps verifying until its cert expires. Mitigations that exist today:
  org credentials are short-lived and device-bound; newsroom rosters are
  editor-signed and replaceable, so a leaked key is removed by re-issuing
  the roster (the roster's own timestamp bounds its membership). A real
  revocation story needs ecosystem infrastructure (CRL distribution for
  org CAs, roster re-issue playbooks) — tracked for 0.12.0, not claimed now.
- Server state persistence is best-effort (5 s debounce): a hard crash — not
  a deploy, which flushes on SIGTERM — can lose a few seconds of rate-limit
  counts. Challenges expire in 5 minutes regardless.
- Device migration: Enclave/keychain keys are per-device by design. Exported
  signed files stay verifiable forever; the vault does not move.
- Seal-queue draft media (.jpg/.m4a) are plaintext in the app container for
  the seconds-to-minutes they await sealing; protected by iOS Data
  Protection, deleted after sealing.
- c2patool labels self-signed device certificates "untrusted issuer" until an
  org credential chains them to a real organization. Expected; the app
  explains it.
- **TSA trust is reputational (0.8.0, stated in-app).** Timestamp tokens are
  fully verified, but TSA chains are not anchored to a curated trust list —
  no mature public TSA root store exists. A valid token proves the TSA's key
  signed the imprint; whether to trust that TSA is a separate judgment. The
  "checks performed / not performed" panel says this on every verification.
- **Revocation is not consulted.** X.509 validity windows are enforced at the
  verified signing time, but OCSP/CRL are not checked — for org credentials,
  revocation status is the org's own endpoints, checked by external verifiers.
  Listed under "not checked" in-app.
- **Emulated key attestation is a binding, not a key.** Apple deliberately
  gives apps no SecKey access to App Attest keys. Our construction binds the
  Enclave *signing* key into the attestation (the reviewer called this "the
  right design"); it proves "Apple-certified genuine device/app, bound to
  this signing key" — it does not make the signing key itself an App Attest
  key.
- **PIN lockout is device-local hardening.** It raises the cost of casual
  probing; it is not a substitute for the iOS passcode and hardware
  protections, and a wiped/reinstalled app resets it (the vault key dies with
  the keychain in that scenario anyway).
