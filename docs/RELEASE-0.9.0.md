# 0.9.0 — portable trust + source protection

The first milestone of the 0.9 program (see the audit conversation and
`Exhibit-A-0.9.0-Plan.md`). Theme: trust that travels with the file, and
protection for the people holding the camera.

## Server hardening (both from the external audit)

- **JSON.parse crash fixed.** A single malformed POST body crashed the whole
  relay process (`req.on('end')` throwing past the handler). Both body-parse
  sites now fail closed with a clean 400. Deploying the server is REQUIRED
  for this milestone.
- **App Attest verification completed.** The relay and the offline verifier
  now check: the aaguid matches the expected environment
  (`appattest`+zeros in production, `appattestdevelop` in dev), the
  credential ID equals SHA-256 of the credential public key, and the leaf
  certificate's key equals the credential key — so two genuine attestations
  can no longer be mixed and matched.

## Signed newsroom roster (portable trust)

- An editor-signed canonical-JSON roster file binds signing-key fingerprints
  to names, roles, and validity windows. ES256 over SHA-256 of the canonical
  payload; re-signing requires the editor key (wrong key = refused).
- Membership is evaluated **at the verified signing time** — never the
  verifier's clock. States: `active`, `active-then-revoked` (the departed
  photographer: past captures stay genuine), `revoked` and `not-yet-valid`
  (red flags), `expired`, `unknown-time` (honestly unevaluable).
- Roster import in Settings shows the editor fingerprint for out-of-band
  confirmation.

## Four trust tiers in the Inspect screen

`this device` → `newsroom roster` → `organization credential` → `unknown`
(trust lists reserved, not shipped). Display invariants: unsigned renders
neutral; valid-but-untrusted never shows green; the tier AND its basis are
always surfaced together.

## Source protection

- **De-identify re-keys the copy**: a fresh ephemeral key + self-signed cert
  per anonymised copy, breaking fingerprint linkability by construction.
  The record says `rekeyed: true`; the UI states the honest cost.
- **Per-assignment keys**: software keys scoped to an assignment label, so
  assignments are unlinkable to each other and to the device. Honest cost,
  stated at capture: no Secure Enclave, no hardware attestation, no org
  credential in assignment mode.
- **Vault key ACL**: the vault key can require Face ID/Touch ID when a
  passcode is set. A two-key storage design avoids the "locked key looks
  like a missing key" trap that would silently regenerate and brick the
  vault — a locked vault now throws, never regenerates.
- **Compromise self-report**: emulator suspicion + jailbreak path indicators
  are signed into the record as a *self-reported assertion* — commitment,
  not detection.

## CAWG identity modes

Anonymous (redacted) / Organization (cert-chain claim only) / Named (byline).
The old boolean byline toggle migrates automatically.

## Reference corpus (the engine-swap oracle)

`tests/build-corpus.mts` generates seven files across the auditor's five
categories — signed, tampered, stripped, hostile, recaptured (the analog
hole, pinned so INTACT is documented as correct) — with
`expected-verdicts.json`. `test-corpus.mts` is now a CI gate and the base
of the future comparison harness.

## Verification

47 checks in `test-verification` (25 prior + 11 roster + OTS foundations),
core + real suites green, corpus 7/7, `tsc --noEmit` clean. Two bugs were
caught by this suite before shipping: a roster re-sign that embedded the
old signature in the payload, and a hostile-claim crash in the manifest
parser (now: invalid credentials, never a crash).
