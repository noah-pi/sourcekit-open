# 0.9.5 — Zero-dependency

The last 0.9 milestone: Exhibit A now ships with **no bundled server
endpoints, no launch-time phone-home, and no feature that sends media off
the device**. Capture, sign, verify, and export all work with the network
physically down — and an automated test proves it.

## Removed

- **Google Vision reverse-image lookup, end to end.** The app client
  (`src/lib/forensics.ts`), the "online check" card on the Inspect screen,
  and the relay route (`POST /forensics/web`) with its global budget
  counter. It was the only feature that shipped media to a third party and
  the only one with a recurring bill; neither fit this tool. Docs updated
  (NETWORK.md row 7 removed; SECURITY.md annotations kept historical).

## Changed

- **Attestation is strictly on demand.** The app no longer bundles a
  default registry address (`DEFAULT_ATTEST_SERVER` is gone), no longer
  contacts a registry at launch, and no longer retries in the background
  from Settings. Settings → "Attest this device now" is the only path, and
  it asks for a registry URL first — self-hosted with the open server in
  `server/`, or a public one the user chooses. Unattested captures are
  reported by verifiers exactly as before: honestly absent.
- **The relay is single-purpose.** `server.mjs` now does App Attest
  registration and nothing else; no media ever transits it.

## Added

- **`tests/test-offline.mts` — the full-offline chain proof (10 checks).**
  With a fetch stub that rejects every network call: capture signs,
  capture-integrity signals record, the signed photo verifies INTACT,
  verification performs **zero** network calls (counted — a tripwire for
  any future regression), timestamp tokens and App Attest report honestly
  absent, a tampered copy is still rejected, and the hash claim /
  payload-digest binding / CSV / GeoJSON / KML exports all build.

## Honesty notes

- The remaining default endpoints (RFC 3161 authorities, OTS calendars,
  the Esplora base for block headers) are free, accountless public-goods
  protocols — hash-or-nothing flows — each overridable in Settings and
  listed in docs/NETWORK.md. The 0.9.5 rule targets Exhibit-A-operated
  infrastructure: none is bundled, none is contacted by default.
- Older app builds pointing at a 0.9.5 relay simply see "web lookup not
  enabled"; every cryptographic check is unaffected.

## Validation

- Offline chain: **10/10** (new suite).
- App suite: 59 checks passing; corpus: 11/11 verdict expectations met.
- Server: syntax-checked; rate limiting, challenges, and registry
  persistence unchanged.
