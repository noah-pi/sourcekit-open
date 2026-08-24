# Provenance of this code

This repository was written with AI assistance. That's a fact about
authorship, not a disclaimer about correctness — and in a repo about
verifiable claims, "trust us, a human checked it" would be the wrong
epistemology anyway. So here's what actually holds the code to account.

## The test lab

30 suites, all runnable offline against the real shipping code. Device-service
imports are rewired to documented shims; every cryptographic operation runs as
shipped.

The suites include regression tests for real attacks: a self-issued "O=Reuters"
certificate, forged App Attest assertions, tampered RFC 3161 tokens, manifest
transplants, truncations. See README ▸ Run the lab.

`tests/corpus/foreign/` holds media this app did not produce — signed by
c2patool, the C2PA reference implementation, with its own chain and its own
claim generator. Everything else in the lab verifies media this code signed,
which cannot show that the reader handles a stranger's output.

## The Swift compiles

`ios-build` generates the iOS project, installs the pods, and compiles every
local module — around 13,500 lines across `modules/` — against Xcode 26.6,
the same toolchain the shipping build uses. Pinned to that version rather
than to whatever is newest, so this gate and the real build cannot drift.

The first time it ran, it found three API errors in the preview-layer
registry that no test and no typechecker could have seen.

## What the lab still does not reach

The shims that let every cryptographic operation run offline are also a wall,
and compiling is not the same as testing:

- **The camera is never exercised.** `tests/shims/` replaces every native
  import, so session lifecycle, capture, the ring buffer, and the sensor
  sinks are absent from the lab by construction. The crash class this app
  has actually shipped — an AVFoundation session deallocating while a
  preview layer still references it — is invisible to all 30 suites and to
  the compiler alike. Multi-cam needs real hardware; a simulator will not do.
- **The whole app is never built here.** `ios-build` compiles the local
  modules, not the application target. Expo's JavaScript-engine bridge does
  not compile on the Xcode versions these runners carry, so the app build
  stays with EAS.
- **The Secure Enclave and App Attest run against shims.** The verification
  math is tested against real fixtures; the hardware paths are not.

What covers that ground is an on-device soak run and a device build, both
manual. That is weaker than the checks above, and it is worth knowing which
half of this system each claim is about.

## An independent verifier

The gold-standard checks use `c2patool`, the C2PA reference implementation, to
validate what this code produces. This verifier agreeing with itself would prove
nothing. CI pins the exact c2patool release binary by SHA-256.

## A differential oracle

`tests/test-oracle.mts` runs the TypeScript verification engine and the upstream
C2PA engine against the same inputs, and fails on any disagreement the policy
layer can't explain.

## Continuous enforcement

CI (`.github/workflows/ci.yml`) runs every suite `tests/.staged` discovers, a
strict typecheck of both the staged core and the app, a dependency allow-list
with per-package caps, and `npm audit` on every budgeted manifest — on every
push and pull request.

## What the AI assistance did and didn't do

It wrote drafts, quickly, and sometimes wrong. It didn't merge anything.

Every behavior this repo claims is pinned by a test that fails loudly when the
behavior changes. The design decisions — threat model, key custody, the
vocabulary rules — are documented in `docs/` and were made by the maintainer.

If the tests and the behavior disagree, the tests are the spec. Please report
it: see [SECURITY.md](../SECURITY.md).
