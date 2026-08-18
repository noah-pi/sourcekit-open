# Contributing

Contributions are welcome. This is the core of a shipping app, so changes need
to hold up on a real device.

## Four rules

1. **Every claim is pinned by a test.** If your change alters a behavior
   the lab checks, the suite must change with it in the same commit. A
   green suite that no longer tests what it names is worse than a red one.
2. **Honesty rules are load-bearing.** Product copy bans adjudication words
   (verified, authentic, trusted, proven, real, secure, guaranteed) in
   verdict position; unsigned renders neutral; red is reserved for proven
   tamper. A test enforces this — see `tests/`.
3. **Dependencies are a budget, not a convenience.** Adding one means
   editing `scripts/check-dependency-budget.mjs` in the same commit, with
   the reason in the commit message. Version splits must be declared.
4. **Device-service imports are shimmed, never mocked.** The lab runs the
   real code; only keychain/filesystem/device-model edges are rewired
   (`tests/shims/`). Don't add a shim surface for something the lab could
   run for real.

## Running the checks

See README ▸ Run the lab. Before sending a change:

```sh
node scripts/check-dependency-budget.mjs   # must exit 0
npx tsc --noEmit                           # must be clean
node tests/stage.mjs                       # then run the suites your change touches
```

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

Be precise and be kind, in that order. There's no separate code of conduct —
one maintainer reads everything. If that stops scaling, this file will grow a
section.
