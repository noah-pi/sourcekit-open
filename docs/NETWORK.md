# Network calls

Every network call the app can make, what triggers it, what leaves the
device, and what happens offline. The rule: **capture, sign, verify, and
export all work with the network off** — and `tests/test-offline.mts`
proves it, with a fetch stub that rejects every call and a tripwire that
fails if verification ever performs even one.

| # | Call | Trigger | What leaves the device | Offline behavior |
|---|------|---------|------------------------|------------------|
| 1 | `GET <registry>/challenge` | App Attest attestation — **on demand only** (Settings → attest now), then only when re-attestation is needed (key rotation, stale binding) | Nothing. Receives a 32-byte random challenge | Attestation simply doesn't happen; capture and signing are unaffected |
| 2 | `POST <registry>/attest` | Same flow, once per attestation | The Apple attestation object + the signing public key. No media, no identity, no location | Same as above |
| 3 | RFC 3161 `POST <TSA>` | Sealing a capture (background queue), once per timestamp authority | A SHA-256 digest of the signature — **never the media, never the record** | The seal completes with device-clock time; the record honestly says "device clock only". Queued countersigning is not retro-faked |
| 4 | OTS calendar `POST <calendar>/digest` | Sealing a capture, when "Bitcoin-anchored timestamps" is on (default) | A 32-byte SHA-256 digest of the record's signed payload — same disclosure profile as (3) | Queued on-device and submitted on reconnect; the queue delay is recorded in the record (`queueDelayMs`), never backdated |
| 5 | OTS calendar `GET <calendar>/timestamp/<digest>` | Viewing a capture whose anchor is still pending; app start after offline captures | Nothing. Receives the upgraded receipt | The record keeps saying "awaiting confirmation" — no timer-based pretending |
| 6 | Esplora `GET block-height`, `GET block/<hash>/header` (mempool.space) | Verifying a file with a confirmed OTS anchor | Nothing. Receives an 80-byte block header | The receipt is shown as internally consistent with the blockchain binding honestly "unchecked" |
| 7 | Esplora `GET /blocks/tip/hash` + `GET /block/<hash>/header` (beacon) | A jittered timer decoupled from shutter events, and app foreground — **never a per-capture fetch**, so an observer cannot correlate this traffic with captures. Endpoint pinnable in Settings | Nothing. Receives the tip block hash, height, and header | The beacon is simply absent from new records, and the record's `observedAt` staleness is disclosed |
| 8 | Open-Meteo `GET archive-api.open-meteo.com/v1/archive` | Viewing a capture that carries a location, on the asset and Inspect screens — a reader-side call, never part of sealing | **The sealed latitude and longitude, rounded to four decimals, and the capture date.** This is the only call that sends anything about where you were; every other row sends a digest or nothing | The card states "Network not available" rather than inventing a reading |

Calls 3–7 are hash-or-nothing flows: digests out, receipts in. Custom TSA
endpoints and custom OTS calendars are configurable in Settings (every
trust claim is swappable); the defaults are free, accountless public goods.

> **Row 8 deserves its own sentence.** Comparing a sealed capture against the
> official weather for that hour is a genuinely useful check, and it costs a
> third party the coordinates. It fires when a reader opens a located capture,
> not when one is taken, so it discloses the location of a file you are already
> looking at rather than your own movements. Turn location off at the shutter
> and there is nothing to send.

## What there isn't

- No analytics, no telemetry, no crash reporting, no ads.
- **No launch-time phone-home of any kind.** Attestation is on demand: the app
  ships with no registry address bundled and contacts one only after the user
  enters a URL and taps "attest now".
- No account system, no push tokens, no device fingerprinting.
- No bundled API keys and no bundled server endpoints. The remaining defaults
  (TSA URLs, OTS calendars, the Esplora base) are free public protocols, each
  overridable in Settings.
- No flow sends capture bytes off the device.

## The capture module makes no calls at all

`modules/exhibit-camera` — the capture session, raw audio master, and sensor
log — performs no network I/O. It opens no socket, makes no request, and has
no endpoint to configure. Capture and the `camera.streamedChunks` commitment
are computed entirely on-device, the latter in TypeScript
(`src/provenance/trackChunks.ts`) by demuxing what the module wrote.

`camera.streamedChunks` is a project-specific label rather than a `c2pa.*` one,
and rides as a field inside the signed record's capture-metadata block. See
[INTEGRITY.md](INTEGRITY.md) for what that commitment does and doesn't bound.

## Server-side (the relay, `server/server.mjs`)

The relay is optional and self-hostable, and does exactly one thing: App Attest
registration.

It holds an aggregate registration counter, single-use 5-minute challenges, and
rate-limit buckets. No key IDs, no fingerprints, no per-device records — a
count, because a per-device registry is a roster of real hardware and nobody
needs one. State checkpoints to a volume so redeploys don't reset the abuse
controls. There is no `/devices` listing.

## Verifying this document

```sh
grep -rn "fetch\|XMLHttpRequest\|WebSocket" src/ app/ modules/
```

Every call site maps to a row above. Grep the bare word rather than `fetch(`:
two surfaces reach the network through an injectable wrapper defaulting to the
global fetch (`otsClient.fetchFn` and `beacon.fetchImpl`), and a paren-grep
misses both.

A call site that doesn't map to a row is a bug. Please report it.
