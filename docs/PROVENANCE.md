# Provenance of this code

This repository was written with AI assistance. That sentence is a fact
about authorship, not a disclaimer about correctness — and in a repo whose
entire purpose is verifiable claims, "trust us, a human checked it" would be
the wrong epistemology anyway. So here is how every line is actually held to
account:

## Verification, not vibes

- **The validation lab (`tests/`).** 39 suites, 1,192 checks, all runnable
  offline against the real shipping code (device-service imports are
  rewired to documented shims; every cryptographic operation runs as
  shipped). The suites include regression tests for attacks an external
  audit originally threw at the code — a self-issued "O=Reuters"
  certificate, forged App Attest assertions, tampered RFC 3161 tokens,
  manifest transplants, truncations. See README ▸ Reproduce our results.
- **An independent verifier.** The gold-standard checks use `c2patool`,
  the C2PA reference implementation, to validate what this code produces —
  our own verifier agreeing with itself would prove nothing. CI pins the
  exact c2patool release binary by SHA-256.
- **A differential oracle.** `tests/test-oracle.mts` runs the hand-rolled
  verification engine and the upstream C2PA engine against the same inputs
  and fails on any disagreement the policy layer can't explain.
- **Continuous enforcement.** CI (`.github/workflows/ci.yml`) runs the full
  suite list, a strict typecheck of the app core and the desk, a
  dependency allow-list with per-package caps, and `npm audit` on every
  budgeted manifest, on every push and pull request.

## What AI assistance did and didn't do

It wrote drafts — quickly, and sometimes wrong. It did not merge anything.
Every behavior this repo claims is pinned by a test that fails loudly when
the behavior changes, and the design decisions (threat model, key custody,
the banned-words honesty rules) are documented in `docs/` and were made by
the maintainer, who stands behind them.

If you find a place where the tests and the behavior disagree, the tests
are the spec — please report it: see [SECURITY.md](../SECURITY.md).

## Why the per-file marker changed

Files previously carried the line "generated with AI assistance and is
still being audited. Use with caution." That sentence made a promise the
repo couldn't keep (an audit is never finished) and implied the code was
unchecked, which was no longer true. The marker now states the fact and
points here, where the verification story lives. One honest paragraph beats
219 worried comments.
