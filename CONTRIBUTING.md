# Contributing

Contributions are welcome. This repository is the published, auditable core
of a shipping product — the bar for changes is set by that, not by anything
about you.

## The rules that matter here

1. **Every claim is pinned by a test.** If your change alters a behavior
   the lab checks, the suite must change with it in the same commit. A
   green suite that no longer tests what it names is worse than a red one.
2. **Honesty rules are load-bearing.** Product copy bans adjudication words
   (verified, authentic, trusted, proven, real, secure, guaranteed) in
   verdict position; unsigned is neutral, red is reserved for proven
   tamper; forensic output juxtaposes, never concludes. See
   `desk/src/core/bannedWords.ts` — it is enforced by tests.
3. **Dependencies are a budget, not a convenience.** Adding one means
   editing `scripts/check-dependency-budget.mjs` in the same commit, with
   the reason in the commit message. Version splits must be declared.
4. **Device-service imports are shimmed, never mocked.** The lab runs the
   real code; only keychain/filesystem/device-model edges are rewired
   (`tests/shims/`). Don't add a shim surface for something the lab could
   run for real.

## Running the checks

See README ▸ Reproduce our results. Before sending a change:
`node scripts/check-dependency-budget.mjs` must exit 0, the staged suites
touching your change must pass, and the desk must typecheck
(`cd desk && npx tsc --noEmit`) and build (`npm run build`).

## Good first issues

- **EKU purpose enforcement (crypto, well-scoped).** `src/lib/x509.ts`
  accepts a critical `extKeyUsage` extension without enforcing it — the
  fail-closed list would otherwise reject real-world certs. Tighten it:
  when a chain purpose is known (signing leaf, TSA), enforce the matching
  EKU and fail closed on a *constraining* EKU that excludes it. The seam
  is `RECOGNIZED_CRITICAL_EXTENSIONS`; `tests/test-tsa-eku.mts` shows the
  enforcement pattern already used for RFC 3161 tokens. Touch the docblock
  ("accepted without enforcement") in the same commit.
- **Docs and fixtures.** A failing case you can demonstrate is a gift:
  open an issue with the file, the suite, and the output.

## Security reports

Never in issues. See [SECURITY.md](SECURITY.md).

## Conduct

Be precise and be kind, in that order. We don't have a separate code of
conduct; we have a maintainer who reads everything. If that stops scaling,
this file will grow the section.
