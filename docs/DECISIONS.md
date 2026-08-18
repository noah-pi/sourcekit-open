# Why it's built this way

Four choices that aren't obvious from reading the code, and what they cost.

## Two verification engines, checked against each other

C2PA reading, verification and trust projection are written in TypeScript
(`src/c2pa/`, `src/lib/x509.ts`, `src/lib/rfc3161.ts`, `src/lib/trustLadder.ts`)
rather than bound to c2pa-rs or the CAI native SDK. On iOS the upstream engine
runs too, and `src/provenance/engine/oracle.ts` runs both against the same asset
and flags disagreement.

The TypeScript engine exists for two reasons. It runs in the app's JS engine and
in CI with no platform code, so it behaves identically on device and on a test
runner, offline, and can be read line by line. And the display rules — unsigned
renders neutral, failed is distinct from unreached, org vouching is earned
outside the file, self-asserted roots are named as such — are decisions about
what the UI may honestly claim. A general-purpose SDK answers "is this
C2PA-valid". It doesn't answer that question, so that layer had to be local
either way.

What it costs:

- **Standards tracking is manual.** C2PA evolves and every revision has to be
  ported by hand. Multi-manifest update chains are the kind of detail a
  maintained SDK handles for you.
- **Interoperability is read-mostly.** Files produced here carry standard C2PA
  manifests and `c2patool` reads them, which CI checks on every run. But exotic
  manifests from other tools may parse as `unsupported` rather than being fully
  evaluated. The report says when that happens.
- **No conformance claim.** There's no conformance certification behind this.

## Verdicts come from one place

`src/provenance/engine/policyLayer.ts` composes every verdict — INTACT,
CONTENT_MODIFIED, SIGNATURE_INVALID, NO_ATTESTATION, UNSUPPORTED — from
normalized engine facts.

Engines return facts; the policy layer decides. Reading a verdict directly off
an engine's fields will drift from what the UI shows, so don't. For the
TypeScript engine a parity assertion compares the composed verdict against the
archived one and throws on any difference rather than absorbing it.

A `trustListHit` on a non-INTACT result is context, not an upgrade. A trust-list
hit on a SIGNATURE_INVALID asset describes who the broken credential chained to.

## The known-signers list was removed on purpose

There used to be a flow for manually confirming a key into a trusted list. It
was itself the attack surface — social engineering onto the list, and grinding
an 8-hex-prefix fingerprint.

Identity is now one of: this device, a roster, an org credential, a trust list,
or unknown, with full 64-character fingerprints for out-of-band comparison.

This is written down because "a trust feature was removed deliberately" is
something a future maintainer could otherwise undo by accident. Key-continuity
trust through countersigned history would be a reasonable thing to build; a
confirm-this-key button would not.

## The noble version split is deliberate

`@noble/post-quantum@0.6.1`, which backs the ML-DSA-65 layer, is written against
the noble 2.x API line and imports 2.x-only modules such as
`@noble/curves/abstract/fft.js`. The rest of the tree pins 1.x:
`@noble/hashes@1.8.0`, `@noble/curves@1.9.7`, `@noble/ciphers@1.3.0`. So the
lockfile carries two copies of every noble primitive.

Collapsing them with npm `overrides` was tried and rejected — forcing either
line onto the other consumer breaks it, and the break is silent until the PQ
suite runs. `tests/test-pq.mts` pins the behaviour against the split as shipped.

Instead of collapsing, the dependency-budget gate
(`scripts/check-dependency-budget.mjs`) counts resolved versions rather than
names. Every multi-version package has to be declared in `KNOWN_VERSION_SPLITS`
with its exact version set and a reason, so a new split fails CI instead of
accumulating quietly.

Worth revisiting when a post-quantum release targets a noble line the rest of
the tree can adopt.

## A note on unused modules in `src/lib`

`shamir.ts`, `rephoto.ts`, `roc.ts`, `imuflow.ts` and `opticalflow.ts` are not
imported by the app. They're working library code — secret sharing,
rephotography checks, ROC/error-rate math, IMU and optical flow — kept here
because they're useful to build on. They are not dead code the app depends on,
and removing them breaks nothing.
