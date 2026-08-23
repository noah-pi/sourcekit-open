# Provenance of this code

This repository was written with AI assistance. That's a fact about
authorship, not a disclaimer about correctness — and in a repo about
verifiable claims, "trust us, a human checked it" would be the wrong
epistemology anyway. So here's what actually holds the code to account.

## The test lab

27 suites, 769 checks, all runnable offline against the real shipping code.
Device-service imports are rewired to documented shims; every cryptographic
operation runs as shipped.

The suites include regression tests for real attacks: a self-issued "O=Reuters"
certificate, forged App Attest assertions, tampered RFC 3161 tokens, manifest
transplants, truncations. See README ▸ Run the lab.

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
strict typecheck of the staged core, a dependency allow-list with per-package
caps, and `npm audit` on every budgeted manifest — on every push and pull
request.

## What the AI assistance did and didn't do

It wrote drafts, quickly, and sometimes wrong. It didn't merge anything.

Every behavior this repo claims is pinned by a test that fails loudly when the
behavior changes. The design decisions — threat model, key custody, the
vocabulary rules — are documented in `docs/` and were made by the maintainer.

If the tests and the behavior disagree, the tests are the spec. Please report
it: see [SECURITY.md](../SECURITY.md).
