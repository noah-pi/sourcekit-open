# 0.9.1 — time without accounts (OpenTimestamps)

Adds ledger-anchored time alongside the existing RFC 3161 authority time.
Two independent claims, never merged: **authority time** (a quorum of
timestamp authorities countersigns the signature) and **ledger time** (the
record's digest is anchored in the Bitcoin blockchain).

## What changed

- **OpenTimestamps at capture.** Each sealed record's payload digest (the
  exact digest the device signature signs) is submitted to the free public
  OTS calendars. Hash-only: 32 bytes out, receipt in. No account, no cost,
  no keys held by anyone. On by default; off switch in Settings.
- **Receipts live in the record, outside the signed payload** — a pending
  receipt becomes a confirmed one hours later, and mutating signed bytes
  would break the signature. Receipts verify independently against the
  payload digest, so they need no signature of their own.
- **Upgrade on view.** Opening a capture with a pending anchor re-asks the
  calendars; a confirmed receipt (block height + confirmation time) is
  persisted back into the encrypted vault record.
- **Offline queue with honest delay.** Captures sealed offline queue their
  digest on-device; on reconnect the queue drains and the record carries
  `queueDelayMs` — the gap between signing and anchoring is evidence,
  never backdated.
- **Verification display.** The Inspect screen shows the ledger claim
  separately: pending (submitted, awaiting confirmation — normal), confirmed
  (block height), and — when online — the receipt's Merkle root checked
  against the actual block header (bytes 36..68). Offline the receipt is
  shown as internally consistent with the binding honestly "unchecked".
  A receipt that commits to different bytes, or that fails the block
  binding, is a red flag — never a quiet downgrade.
- **Swappable trust.** Custom RFC 3161 TSA endpoints and custom OTS
  calendars in Settings; the defaults are free, accountless public goods.
  `docs/NETWORK.md` lists all six call types with their exact disclosure.

## Format notes

`src/lib/ots.ts` implements the DetachedTimestampFile format (magic,
varuint/varbytes, op chain: prepend/append/sha256, pending + Bitcoin
attestations). Forked trees and unsupported ops are refused rather than
guessed — no public calendar produces them. Attestation blobs are parsed
strictly (trailing bytes = malformed) after a tampered-height receipt
showed a plausible-but-wrong read in testing.

## Verification

47 checks in `test-verification` (36 prior + 11 OTS): pending/confirmed
round-trips, wrong digest refused, Merkle-root↔block-header binding both
ways, unchecked-binding honesty offline, tampered digest and tampered
attestation both rejected, garbage and unsupported ops refused.
Corpus 7/7, `tsc --noEmit` clean.
