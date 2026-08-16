# archive/handrolled-verifier — the hand-rolled C2PA verifier (archived, WS3)

**Status:** archived reference implementation — **moved, not deleted, not
disconnected.** This is the exact verification pipeline the project built
before adopting the official C2PA engine (WS3, 2026-08-06). It is still:

1. **the desk's current verification engine** — `desk/` imports these files
   directly (`@verify-archive/handrolled-verifier/*`); the Stage-4 CLI swap
   will move the desk to the upstream engine through the policy layer;
2. **the differential oracle in CI** — `tests/test-oracle.mts` runs every
   corpus asset through BOTH this verifier and the upstream engine
   (`@contentauth/c2pa-node` / wasm fallback) and fails on any unwhitelisted
   divergence (see `src/provenance/engine/oracle.ts`,
   `tests/oracle-whitelist.json`);
3. **the semantic reference** — our verdict model, the A-1 binding guard,
   void-binding semantics, and the UNSUPPORTED tri-state are DEFINED by this
   code. The policy layer (`src/provenance/engine/policyLayer.ts`) is the
   only verdict authority, and its mapping table re-expresses exactly what
   this verifier does.

## Contents

| File | Role |
|---|---|
| `verifyAsset.ts` | The verification pipeline: `verifyPhotoBytes`, `verifyVideoBytes`, `verifyWithSidecarBytes`, the `VerdictCode` set (INTACT / CONTENT_MODIFIED / SIGNATURE_INVALID / NO_ATTESTATION / NOT_JPEG / NOT_BMFF / UNSUPPORTED / UNREADABLE), the full `VerificationReport` (checks performed / not performed, trust axis, TSA pinning, PQ layer, App Attest, update chains). |
| `c2pa.ts` | Hand-rolled COSE_Sign1 / JUMBF / claim parser + verifier (`parseManifest`, `verifyManifest`, `parseManifestChain`) AND the builders (`buildC2paSegment`, `buildC2paStoreBmff`, `buildC2paStorePng`, `hashBmffV2`) the capture path still signs with — signing migration is a later decision (SPEC §3 non-goal). |
| `bmff.ts` | MP4/MOV container: uuid-box store extraction, `c2pa.hash.bmff.v2` evaluation, `BmffUnsupported` (merkle-aux structures → the UNSUPPORTED verdict). |
| `jpegApp11.ts` | JPEG APP11 JUMBF extraction/strip + legacy Verify-manifest extraction. |
| `png.ts` | PNG caBX chunk extraction/strip. |
| `verifyAppAttest.ts` | Offline App Attest assertion verification. |

Shared libraries these files import back from `src/` (`lib/sign`, `lib/pq`,
`lib/x509`, `lib/rfc3161`, `lib/tsaTrustList`, `provenance/manifest`, …) are
NOT archived — the signing path (`src/provenance/attest.ts`) uses the same
code, and archiving them would fork capture-side crypto for no audit gain.

## The A-1 audit history (why the binding guard exists)

0.11.0 audit finding **A-1**: a hash binding is honored ONLY when the signed
claim references it. Before the guard, three defective-credential shapes were
mislabeled — including a false-green attach attack (a genuinely signed
telemetry-only claim plus a binding box added post-signing over different
media verified INTACT). The guard lives in `c2pa.ts` (`verifyManifest`): an
unreferenced or malformed binding is **void** — `assetHashFailure:
'void-binding'`, verdict `SIGNATURE_INVALID` (defective credentials,
integrity UNPROVEN), never `CONTENT_MODIFIED` (proven tamper). Regression
suite: `tests/test-binding-guard.mts`.

The upstream engine is *stricter* here (spec 2.2 §15.10.3.1: undeclared
assertions reject the claim with `assertion.undeclared`). The policy layer
maps that code onto the same SIGNATURE_INVALID + void-binding semantics —
neither engine was weakened to make them agree (SPEC §0.3).

## Why it's kept (oracle rationale)

The upstream engine (c2pa-rs via `@contentauth/c2pa-node` or the wasm build)
and this verifier are independent implementations of the same spec. Running
both over every corpus asset and diffing the composed verdicts catches:

- upstream behavior drift across 0.x upgrades (c2patool 0.14.0 → 0.27.5,
  claim-v2 defaults, spec 2.2 compliance changes),
- regressions in our own parsing that the corpus alone wouldn't flag,
- intentional semantic deltas (UNSUPPORTED for merkle-aux BMFF — upstream
  has no tri-state; binding-guard leniency vs `assertion.undeclared`
  fail-closed) — these are whitelisted WITH A WRITTEN REASON in
  `tests/oracle-whitelist.json`, never silently absorbed.

If you change anything in this directory, you are changing the reference
oracle AND the desk's live verifier: run the full staged board
(`node tests/stage.mjs`, then every `test-*.mts`) plus `test-oracle.mts`.
