# Contributing

Thanks for looking. This is the code behind a shipping app, so the bar is that a
change works on a real phone, not only in the lab.

## Before you start

**Tests come with the change.** If you alter something the suites check, update
the suite in the same commit. A green suite that no longer tests what its name
says is worse than a failing one.

**Verdict words are off limits.** The app never tells anyone a file is verified,
authentic, trusted, proven, real, secure or guaranteed. It reports what was
checked and what came back. Unsigned renders neutral grey; red is reserved for
proven tampering. This is a convention rather than a lint rule, so it depends on
people keeping it — `src/reader/types.ts` explains the reasoning.

**Dependencies need a reason.** Adding one means editing
`scripts/check-dependency-budget.mjs` in the same commit, with the reason in the
commit message. Version splits get declared there too.

**Device edges are shimmed, not mocked.** The lab runs the real cryptography.
Only the keychain, filesystem and device-model calls are swapped out, in
`tests/shims/`. If the lab can run something for real, let it.

## Before you send it

```sh
node scripts/check-dependency-budget.mjs   # exits 0
npx tsc --noEmit                           # clean
node tests/stage.mjs                       # then run the suites you touched
```

The README has more on the lab.

## Something to pick up

**EKU enforcement, in `src/lib/x509.ts`.** The verifier accepts a critical
`extKeyUsage` extension without checking that it permits what the certificate is
being used for. A strict list would reject too many real certificates, so right
now they all pass. The fix is to enforce it where the purpose is known — a
signing leaf, or a timestamp authority — and fail closed when the EKU excludes
that use. `tests/test-tsa-eku.mts` already does this for RFC 3161 tokens and
shows the shape. Start at `RECOGNIZED_CRITICAL_EXTENSIONS`, and update the
docblock that says "accepted without enforcement" when the behavior changes.

**A file that breaks something.** If you have one, open an issue with the file,
the suite you ran, and what it printed. That is the most useful thing anyone can
send.

## Security

Not in issues, please. See [SECURITY.md](SECURITY.md).

## Conduct

Be precise and be kind, in that order. One person reads everything here, so
there is no separate code of conduct. If that stops being true, this section
will get longer.
