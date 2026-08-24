# Invariants — rules that must not regress

Read this before changing verification, sealing, or the network surface, and
before porting code between trees. Every entry states the rule, why it exists,
and the test that guards it. A change that breaks one of these is a change to
what this app claims, not a refactor.

If you remove an entry, remove its test in the same commit and say why in the
message. An invariant with no test is a wish.

---

## Prose that is not generated

Two sections are written by hand and must survive any port from the closed
tree: **Things I have not built yet**, in both `README.md` and
`site/index.html`. They are a roadmap and an argument, not a description of
the code, so nothing in the closed tree is a source of truth for them. Both
carry a comment saying so.

A port that rewrites either one has overwritten an edit, not updated a fact.
Diff them before committing a bulk adoption.

---

## Verification

### A receipt must commit to the digest the signature covers

`signedPayload` strips `ots` before signing, so `record.ots.digestHex` sits
**outside** the signature. Trusting the declared digest lets a forged record
carry any valid ledger receipt and name that receipt's own digest; the rung
then validates the attacker's own bytes. Rung 4 compares against
`payloadDigest(record)` and diverges when they differ.

`src/reader/verify/ladder.ts` · guarded by `tests/test-custody-ladder.mts`

### An unreferenced hash binding is void, not tamper

A binding is honored only when the signed claim references it. Without this,
a genuinely signed telemetry-only claim plus a binding box added after signing
over different media verifies INTACT — a false green. An unreferenced or
malformed binding is `assetHashFailure: 'void-binding'`, verdict
`SIGNATURE_INVALID` (defective credentials, integrity unproven), never
`CONTENT_MODIFIED` (proven tamper).

`archive/handrolled-verifier/c2pa.ts` (`verifyManifest`) · guarded by
`tests/test-binding-guard.mts`

### A BMFF exclusion with a null length is not a length constraint

c2pa-rs writes an absent length as CBOR `null` rather than omitting the key.
Treating `undefined` as the whole absent case skips every exclusion a foreign
manifest declares, and every c2pa-rs-signed MP4 and M4A reads
`SIGNATURE_INVALID` with void-binding. The test is `ex.length != null`, never
`!== undefined`.

`archive/handrolled-verifier/c2pa.ts` (`boxExcluded`) · guarded by
`tests/test-foreign.mts`

### A post-quantum failure never flips the classical verdict

The PQ layer is additive assurance, not a downgrade vector. A failed or absent
ML-DSA-65 signature leaves the ES256 verdict standing. A *stripped* layer is
different: the committed key cannot leave the signed payload, so a committed
key with no signature is tamper evidence.

`archive/handrolled-verifier/verifyAsset.ts` · guarded by `tests/test-pq.mts`

### The claim-layer PQ entry is not emitted, but is still verified

The builder no longer writes a `verifyPq` entry into the COSE unprotected
header; the signature lives on the record, and the record declares
`pqScope: 'record'`. Parsing and verification of that entry **stay**, so
earlier captures and foreign files keep verifying.

`archive/handrolled-verifier/c2pa.ts` · guarded by `tests/test-pq.mts`

### The verdict authority is the policy layer

Both engines are normalized before a verdict is composed. Neither engine is
weakened to make them agree; intentional semantic deltas are whitelisted in
`tests/oracle-whitelist.json` **with a written reason**, never absorbed
silently.

`src/provenance/engine/policyLayer.ts` · guarded by `tests/test-oracle.mts`
and `tests/test-policy-layer.mts`

---

## Network

### Capture, sign, verify, and export work with the network off

No verification path may require a fetch. The offline suite runs with a stub
that rejects every call and a tripwire that fails if verification performs
even one.

guarded by `tests/test-offline.mts`

### The weather lookup is opt-in and never fires on its own

It sends the sealed coordinate and the capture day to a third party, so it is
gated twice: the `weatherLookupEnabled` setting (default off) and a tap on the
card. Opening a located capture must send nothing.

Wire any new weather surface to **both** gates. A setting that gates only a
component nothing renders is not a gate.

`src/components/forensic/EnvironmentCard.tsx` · `src/store/useStore.ts`

### Coordinates are not resolved to place names

The platform geocoder hands the sealed coordinates to Apple. Sealed latitude
and longitude are displayed as sealed; no reverse lookup runs on any screen.

`app/(tabs)/inspect.tsx` · `app/asset/[id].tsx`

### Every network call is in the table

`docs/NETWORK.md` lists every call the app can make, its trigger, what leaves
the device, and the offline behavior. A new `fetch` without a new row is a
broken promise, not a missing doc.

---

## The record

### De-identifying redacts location and everything that proxies it

`declinationDeg` narrows a capture to a band a few hundred kilometers wide, so
it is redacted with `location` and `wifi`, not carried through with the other
sensors.

`src/provenance/attest.ts` (`deidContext`)

### Evidence paths are three-state and never conflated

Every sink reports exactly one of: a path (recorded), `null` (enabled but
failed), or `'never-recorded'` (toggle off, or not applicable to that media
kind). An off toggle must never be indistinguishable from a failure.

`src/provenance/manifest.ts` (`EvidencePath`) · guarded by
`tests/test-commit-at-capture.mts`

### The same assertion set is emitted for photo, video, and audio

Divergences by media kind are enumerated in `docs/MEDIA-PARITY.md`. Anything
that diverges outside that list is a bug, including which code writes the
container.

---

## Keys

### Biometric captures sign with the biometric key

`ENCLAVE_KEY_TAG` and `ENCLAVE_BIO_KEY_TAG` must match the native tags exactly
(`com.verify.camera.signing-key` and `com.verify.camera.signing-key-bio`). A
mismatch signs biometric captures with the wrong key and the error is silent.

`src/lib/deviceKey.ts` · `modules/secure-enclave/`

---

## Native

### No preview layer may reference a session that is about to deallocate

AVFoundation asserts inside `detachFromFigCaptureSession` when a session
deallocates with a layer still attached. The sweep decides from the bind-time
registry, never from `layer.session` — that getter can read nil or stale while
Fig still considers the layer attached.

`modules/exhibit-camera/ios/ExhibitCameraModule.swift` · guarded by a debug
assertion, and exercised by **Settings ▸ Diagnostics ▸ Run soak**
(`src/lib/sessionSoak.ts`): forty open-and-close cycles alternating cameras.
`ios-build` compiles this file but cannot exercise it — multi-cam needs real
hardware, so the soak is the only check that reaches this rule.

### Expo async functions that block declare their own queue

`AsyncFunction` runs on a shared serial queue unless `runOnQueue` is declared.
Two blocking functions without it deadlock the bridge and the camera freezes.

`modules/c2pa-ios/ios/C2paIosModule.swift`
