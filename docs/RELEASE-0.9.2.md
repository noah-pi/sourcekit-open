# 0.9.2 — proof portability

Proof that travels separately from the media. Three share modes, in
increasing order of disclosure:

- **Hash only** (`verify-hash-claim/1`) — the source-protection primitive.
  Proves a capture with this SHA-256 exists, was signed by this key, and
  was anchored at these times. Nothing else leaves the device: no media,
  no record, no location, no signature. The test suite asserts the
  disclosure discipline, not just the schema (the serialized claim is
  checked for byline, location, and signature leakage).
- **Proof bundle** (`verify-proof-bundle/1`) — the full attestation record
  (including OTS receipts) plus the embedded C2PA manifest segment, bound
  to the media by hash. A desk verifies every claim except the pixels and
  matches the media later — exact hash, or pHash recovery (see
  `docs/RECOVERY.md`).
- **Proof + media** — the signed file itself, via the existing share sheet
  with its anti-doxxing de-identify gate. Unchanged.

## Desk intake export

Multi-select in the vault now exports the metadata index of the chosen
items — never the media:

- **CSV** for the desk spreadsheet, with spreadsheet formula-injection
  guards (cells starting `= + - @` are quote-prefixed) and honestly empty
  coordinates for redacted locations.
- **GeoJSON** and **KML** for the map — only items that actually carry a
  location appear; XML-hostile labels are escaped (tested).

## Recovery format

`docs/RECOVERY.md` defines the desk-side recovery index
(`verify-recovery-index/1`), the 64-bit DCT pHash soft binding, and the
two match grades that must never be merged: **exact** (SHA-256 — certain)
and **visual** (pHash — a lead, always labeled "confirm visually").
Watermarks were evaluated and rejected; the document says why.

Hash-only claims are exact-match only by construction — if the media is
re-encoded in transit, the claim can never match, and the desk must say so
plainly. That is the deliberate cost of the primitive, and the share sheet
states it.

## Verification

56 checks in `test-verification` (47 prior + 9 proof): claim/bundle
round-trips with the record signature surviving serialization, disclosure
discipline, injection guards, redacted-location honesty, GeoJSON
coordinate order, KML escaping. Corpus 7/7, `tsc --noEmit` clean.
