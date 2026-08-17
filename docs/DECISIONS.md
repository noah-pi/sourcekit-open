# Decision record — Exhibit A 0.10.0

Decisions that were deliberate, who made them, and the trade-offs accepted.
Newest first. For audit history see `SECURITY.md`; for what we defend and
accept see `THREAT-MODEL.md`.

## D1. Hand-rolled provenance engine, not a c2pa-rs binding (noah-pi, 0.10.0)

**Decision.** Exhibit A's C2PA reading, verification, and trust projection are
hand-rolled in TypeScript (`src/provenance/`, `src/lib/x509.ts`,
`src/lib/rfc3161.ts`, `src/lib/trustLadder.ts`) rather than bound to
c2pa-rs / the CAI native SDK.

**Why.**
- **No native dependency.** The whole verifier runs in the app's JS engine
  and in CI with zero platform code — offline, auditable line by line, and
  identical on device, desk, and test runner. A native binding would add an
  unauditable binary surface to the one component whose entire job is being
  auditable.
- **Claim discipline is enforceable in our own code.** The honesty
  invariants (unsigned → neutral, failed ≠ unreached, org vouching earned
  only outside the file, self-asserted roots named as such, the ladder as
  projection-not-verdict) are *our* display semantics. A general-purpose
  SDK answers "is this C2PA-valid"; it does not answer "what may this UI
  honestly claim" — that layer had to be ours regardless.
- **The audit trail demands it.** The 0.8.0/0.8.1 external audits reviewed
  this exact code; the regression suites pin this exact behavior. Switching
  engines would invalidate the reviewed surface.

**Trade-offs accepted (stated, not hidden).**
- **Standards-tracking burden is ours.** C2PA evolves; every spec revision
  must be tracked and ported by hand. Multi-manifest update-chain handling
  (0.8.1) is the kind of detail a maintained SDK gets for free.
- **Conformance claims wait.** We make no `cawg.identity` or C2PA-conformance
  claim until the W10 conformance work (Trust List cert, third-party audit)
  lands; org identity ships under the vendor-labeled `com.verify.identity`
  assertion and says so.
- **Interoperability is read-mostly.** Files we produce carry standard C2PA
  manifests (c2patool reads them; the lab verifies that in CI), but exotic
  manifests produced by other tools may parse as "unsupported" rather than
  being fully evaluated — and the report says when that happens.

**Revisit when:** W10 conformance work starts, or a maintained RN/JS binding
with reproducible builds appears.

## D2. Roster administration lives on the desk, never the app (W7.4)

**Decision.** Create/edit/revoke/rotate/re-sign of newsroom rosters exists
only in the desk web tool. The app imports, lists, and removes — nothing
else. **Why:** the app is a capture-and-verify endpoint; key-management
ceremonies on the same device that captures would collapse the separation
that makes an editor's vouch mean anything. The import flow instructs
out-of-band editor-fingerprint confirmation. **Accepted:** a newsroom
without desk infrastructure can't mint rosters — they can still use org
credentials or per-device fingerprints.

## D3. Duress PIN — designed, deferred pending legal review (W5.3)

**Status.** NOT IMPLEMENTED, deliberately. (Update: the dead-man's switch
this design referenced has since been REMOVED — see NETWORK.md — so the
duress scenario it answered no longer has a switch to coerce; the deferral
reasoning below stands on its own.)

**The design on paper:** a second passcode that behaves like success while
silently skipping dead-man check-ins (or silently arming an upload) — for a
user compelled to "prove" they've checked in.

**Why deferred.**
- **Legal exposure varies by jurisdiction and must be named before ship.**
  In some jurisdictions a duress feature could be construed as obstruction,
  and in others failing to have one is the greater risk. A jurisdiction
  matrix (at minimum: US, UK, EU member states, and the jurisdictions of the
  first deploying newsrooms) needs review by counsel with
  press-freedom/safety expertise before any code lands.
- **The coercion model is unresolved.** A duress PIN protects against
  compelled check-in only if the coercer can't distinguish duress from
  success — which requires the app to be *indistinguishably* normal under
  the duress code, including vault contents. That is a much larger promise
  than a PIN gate, and promising less would violate the honesty rules.
- **What exists instead (and is honest):** desk key shares (Shamir) stay
  desk-side, and sealed-to-newsroom capture means a seized device holds
  ciphertext the photographer cannot open.

**Trigger to revisit:** counsel's written guidance on the jurisdiction
matrix, plus a shipped answer to indistinguishability. Until then the app
makes no duress claim of any kind.

## D4. Known-signers list removed (0.8.1, from the external audit)

The manual confirm-a-key ritual was itself the attack surface (social
engineering onto the list; 8-hex-prefix fingerprint grinding). Identity is
"this device / roster / org credential / trust list / unknown", with full
64-character fingerprints for out-of-band comparison. Key-continuity trust
(countersigned history) remains roadmap. Recorded here because "we removed
a trust feature on purpose" is a decision future maintainers must not
accidentally undo.

## D5. src/lib carries desk-only modules — by design, not dead code (0.11.0, auditor F5)

The audit flagged `shamir.ts`, `rephoto.ts`, `roc.ts`, `imuflow.ts`,
`opticalflow.ts` as unimported in the app tree. They are app-unused but
**ecosystem-live**: `shamir` backs the desk key manager, `rephoto`/
`imuflow`/`opticalflow` are the desk-side analyzers named in
docs/INTEGRITY.md ("signals deliberately left to the desk tool"), and `roc`
is the error-rate math behind the corpus gate (no UI signal without
characterized error rates). The app and desk share one mirrored `src/lib`
by deliberate repo-boundary design — the desk imports the same tree, never
a fork — so the files ship in both. Disposition: kept and documented here,
not removed; removing them from the app copy would fork the mirror, and
removing them outright would delete shipped desk features.

## D6. The noble 1.x/2.x version split is accepted, and the budget gate counts versions

`@noble/post-quantum@0.6.1` (the ML-DSA-65 layer) is written against the
noble **2.x** API line — it imports 2.x-only modules such as
`@noble/curves/abstract/fft.js` — while the rest of the tree pins the 1.x
line (`@noble/hashes@1.8.0`, `@noble/curves@1.9.7`, `@noble/ciphers@1.3.0`).
The lockfile therefore carries two copies of every noble primitive.
Collapsing them with npm `overrides` was evaluated and rejected: forcing
either line onto the other consumer breaks it (the 2.x-only imports have no
1.x counterpart), and the failure would be silent until the PQ suite ran.
`tests/test-pq.mts` (39 checks) pins the PQ behavior against the split as
shipped. Mitigation instead of collapse: the dependency-budget gate
(`scripts/check-dependency-budget.mjs`) now counts RESOLVED VERSIONS, not
just names — every multi-version package must be declared in
`KNOWN_VERSION_SPLITS` with its exact version set and reason, so a new
split fails CI instead of accumulating quietly. Re-vet on every bump;
when a post-quantum release targets a noble line the rest of the tree can
adopt wholesale, unify then — not piecemeal.
