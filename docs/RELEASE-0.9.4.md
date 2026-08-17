# 0.9.4 — Exhibit desk: the newsroom half of the trust model

The camera proves custody; now the desk can check it. 0.9.4 adds Exhibit
Desk (`desk/`): a local web app that verifies photos, clips, proof
bundles, and hash claims **entirely in the browser tab** — no server, no
upload, no accounts — using the *same* verification sources the app
ships, imported from the same tree (`@verify` → `../src`), never forked.

## What's new

- **Dossiers** for every intake item: verdict with the shared display
  invariants (unsigned = neutral; tampered = red; **valid-but-untrusted
  is never green**), trust tier with its basis always attached, the three
  time claims kept separate (device / RFC 3161 authority / Bitcoin
  ledger, with binding state verified / failed / unchecked), checks
  performed *and* checks not performed, capture-integrity signals
  labelled self-reported.
- **Proof ↔ media recovery** per docs/RECOVERY.md: exact SHA-256 matches
  (certain) and pHash visual leads ("confirm visually", never verdicts),
  thresholds desk-configurable; hash-only claims stay exact-match only,
  and the desk says so.
- **"How we know this" export** — a standalone HTML statement of every
  check, non-check, and trust basis, for methodology notes and evidence
  archives.
- **Roster editor** — create a newsroom roster with a fresh editor key
  (shown once, never stored), add / revoke / rotate members, every edit
  re-signed; import is gated on editor-signature verification.
- **Trust configuration** — trusted rosters, opt-in online block-binding
  checks (the desk's only possible network call, off by default), pHash
  thresholds.
- **docs/DESK.md** — newsroom guidance including CMS/WordPress publishing
  without breaking the hash binding, and the identity-claims honesty
  model.

## Verification-core refactor (enabler)

- `verifyAsset` is now bytes-pure (`verifyPhotoBytes` / `verifyVideoBytes`
  / `verifyWithSidecarBytes`); all file IO moved to the app-only
  `verifyFs.ts` wrappers. The entire verification chain is host-clean.
- `recordFromManifestBytes` moved from `attest.ts` (capture-side, expo
  glue) to `manifest.ts` (pure) — the final cut that keeps the browser
  chain free of any device API.

## Honesty notes

- The desk's only network call is the opt-in Bitcoin block-header fetch;
  the header bar states "fully offline" or "block-header checks only" at
  all times.
- Editor private keys are never persisted — memory only, per edit, and
  the UI says so at the exact moment of custody transfer.
- Trusted rosters and thresholds persist in browser local storage only.

## Validation

- App suite: 59 checks passing (unchanged coverage, re-run after the
  refactor).
- Corpus: 11/11 verdict expectations met.
- Desk: strict TypeScript clean; production build green; imports the
  repo's verification sources directly.
