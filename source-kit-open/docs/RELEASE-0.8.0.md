# Exhibit A 0.8.0 — "presence is not proof"

0.8.0 is a verification overhaul, driven by an external security audit of
0.7.4. The audit's verdict: the signing side was real; the verifying side
checked that credentials were *present*, not that they were *valid*. We
confirmed every finding against the code, held the release entirely, and
rebuilt the verifier before shipping anything. This release is that rebuild.

Nothing between 0.7.4 and 0.8.0 was released. The audit's attacks are now
permanent regression tests.

## What changed

**Real verification, on-device, offline**
- New X.509 engine (`src/lib/x509.ts`): link-by-link signature verification
  (ECDSA P-256/P-384, RSA PKCS#1 v1.5), byte-exact name chaining, CA flags,
  validity evaluated at the *verified signing time* (earliest valid RFC 3161
  genTime), never the verifier's clock. Anchors are compiled-in pinned roots
  only — the Apple App Attestation root ships in the binary.
- New RFC 3161 verifier (`src/lib/rfc3161.ts`): messageImprint vs. the exact
  countersignature message, CMS signature over correctly re-tagged signedAttrs
  (RFC 5652 §5.4), TSA chain links, TSA cert valid at genTime.
- New offline App Attest verifier (`src/provenance/verifyAppAttest.ts`): full
  chain to the pinned Apple root, rpIdHash bound to this app, nonce extension
  recomputed against `SHA256(authData ‖ SHA256(challenge ‖ signingPublicKey))`
  for exactly the manifest's signing key.
- Org credential import now verifies the CA actually signed the leaf — the
  audit's self-issued "O=Reuters" forgery is rejected at the door.

**Two-axis verdict UI**
- Integrity (unchanged bytes, valid signature) and credibility (attestation,
  timestamps, chain, signer identity) are independent axes. A failed
  credibility check never moves the integrity verdict — and never disappears:
  present-but-failed is a red warning with the reason shown.
- New "checks performed / not performed" panel on every verification, in
  plain language. TSA root anchoring and revocation are listed as not
  checked, every time.
- The self-signed caveat can no longer be suppressed by presenting a longer
  chain (in 0.7.4 a forgery looked *more* credible than a genuine capture).

**Personal trust anchor**
- Known signers: mark a verified signer as known from the Inspect tab; manage
  the list in Settings. Identity resolves only against this list and this
  device — nothing inside a file can claim identity.

**Server hardening** (requires redeploy)
- Apple root embedded in the server source (the PEM stays in the repo for
  inspection only — a trust anchor must not depend on filesystem layout),
  never fetched at runtime.
- Nonce verification walks the DER to the extension (replacing the substring
  scan).
- `GET /devices` removed entirely — a public roster of real journalist
  hardware is an opsec liability, not a feature.

**Hardening**
- PIN lockout: 4 free failures, then escalating delays (30 s doubling to a
  5-minute ceiling), persisted in SecureStore so force-quit doesn't reset it.

**Tests**
- Repaired the rotted suites (they had been excluded from `tsconfig` and
  silently stopped compiling). Scripts are now type-checked with the app.
- New `tests/test-verification.mts` — 18 checks against openssl-generated
  fixtures, including a genuine RFC 3161 token and the audit's exact
  forgeries. Writing it caught two real verifier bugs before ship (the CMS
  re-tag byte, and duplicate certs mistaken for a chain). Both fixed.

## What 0.8.0 still does not do (stated in-app)

- TSA chains are verified but not anchored to a curated TSA trust list (no
  mature public equivalent of the WebPKI root store exists).
- Revocation (OCSP/CRL) is not consulted; org-credential revocation is the
  org's own endpoints, checked by external verifiers.
- Signer identity beyond your own device and your manually confirmed known
  signers (newsroom roster / CA trust ladder / CAWG / C2PA conformance) is
  roadmap.
- A valid signature still proves custody, not reality. It always will.

## Upgrade notes

- **Server redeploy is mandatory** — the app and server share the attestation
  binding, and the server changed. Deploy `server/` before judging any
  attestation behavior.
- Existing signed files remain verifiable; files signed by 0.7.4 verify
  identically under the new engine (their attestations and tokens now get
  *real* checks — a genuine capture passes them).
- Package version and app version are now kept in lockstep (0.8.0 / build 8);
  the 1.0.0-vs-0.7.4 drift the audit noted is gone.
