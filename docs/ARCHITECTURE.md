<!-- Source Kit 0.1.0 — how the app is put together -->
# Architecture — Source Kit provenance core

One page from capture to verification.

## Capture and seal

```
camera/mic ──► media file (JPEG / MP4 / MOV / M4A)
                   │
                   ▼
            seal queue (background, restart-safe, encrypted at rest)
                   │
                   ▼
        buildRecord (manifest.ts)        ← claims: time, location, sensors,
                   │                       identity, device — all labeled claims
                   ▼
        signRecord (lib/sign.ts)         ← ES256 over canonical-JSON digest
                   │
                   ▼
   C2PA manifest embed (provenance/)
     ├─ JPEG: APP11/JUMBF segment after SOI      (jpegApp11.ts)
     ├─ PNG:  caBX chunk before IEND             (png.ts)
     └─ BMFF: C2PA uuid box after ftyp           (bmff.ts)
                   │
                   ▼
        encrypted vault (vault/vaultFs.ts)  ← AES-256-GCM, keychain key
```

Vault layout: `index.json` (metadata only), `{id}.bin` (sealed media),
`{id}.att.json` (sealed attestation record — it carries location/identity),
`{id}.thumb.bin` (sealed 512-px grid thumbnail, so the library grid decrypts
~25 KB per cell instead of the full frame). Plaintext exists only in a cache
folder that is shredded on lock and on background.

Hard binding: the manifest carries a `c2pa.hash.data` (JPEG/PNG) or
`c2pa.hash.bmff.v2` (MP4 family) assertion covering every byte **except** the
manifest container itself, so the signature and the pixels can't drift apart.
COSE_Sign1 signs the claim; the claim pins every assertion by hash;
optionally an RFC 3161 TSA countersigns.

## Verification (fully offline)

```
file ──► extract manifest (format-specific) ──► parse claim + assertions
     ──► verify COSE signature against embedded certificate chain
     ──► recompute asset hash over bytes-minus-manifest
     ──► verify inner Source Kit record signature (defense in depth)
     ──► integrity verdict: INTACT / CONTENT_MODIFIED / SIGNATURE_INVALID / NO_ATTESTATION

credibility axes (independent of the integrity verdict):
     ──► X.509 chain verifier (lib/x509.ts) — real link-by-link signature
         verification (ECDSA P-256 and P-384, RSA), name chaining, CA flags,
         validity evaluated at the VERIFIED signing time, never the
         verifier's clock; anchored only to compiled-in pinned roots
     ──► RFC 3161 verifier (lib/rfc3161.ts) — messageImprint vs. the exact
         timestamp message, CMS signature over correctly re-tagged
         signedAttrs (RFC 5652 §5.4), TSA chain links, TSA cert valid at
         genTime
     ──► App Attest verifier (provenance/verifyAppAttest.ts) — full chain to
         the PINNED Apple App Attestation root (lib/appleAttestRoot.ts),
         rpIdHash = this app, nonce extension = the emulated-key-attestation
         binding for exactly the manifest's signing key
     ──► every check lands in checksPerformed / checksNotPerformed, shown
         verbatim in the UI
```

The two axes are deliberate: a file can be cryptographically INTACT while its
signer is unknown, its attestation forged, or its timestamps absent — the UI
shows integrity and credibility independently, and anything present-but-failed
is a red warning. Signer *identity* resolves only
against anchors outside the file: this device's key, or an org credential
chained to a real CA. Nothing found inside a file can ever upgrade identity
to "known". (removed the manual known-signers list — a confirm-by-hand
trust ritual is itself an attack surface; key-continuity trust is the roadmap
replacement.)

The manifest parser follows the C2PA update-chain rule: the **last** manifest
in the store is the active one, and the verification report says so when a
store carries more than one. All DER/TLV walkers enforce strict length
decoding (multiply-accumulate, no 32-bit shifts) and a non-advancing-walker
invariant — hostile length fields throw instead of hanging.

Trust anchors are compiled-in or user-pinned only. Anything fetched at runtime
is an input, not an anchor. No network is required; nothing about verification
trusts us.

## De-identify and re-sign (share flow)

Sharing flags embedded identifying details and offers a freshly signed copy:
strip manifest (+ EXIF for JPEG), redact identity/location/sensors/device
model, drop the audio transcript, keep the original capture time, re-sign the
identical media bytes, mark the record `deidentified` with the removed field
list. The copy is independently verifiable — integrity without identity.
