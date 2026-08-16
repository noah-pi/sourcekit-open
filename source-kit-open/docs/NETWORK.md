# Network calls — the complete audit (0.10.0)

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
| 4 | OTS calendar `POST <calendar>/digest` | Sealing a capture (0.9.1), when "Bitcoin-anchored timestamps" is on (default) | A 32-byte SHA-256 digest of the record's signed payload — same disclosure profile as (3) | Queued on-device and submitted on reconnect; the queue delay is recorded in the record (`queueDelayMs`), never backdated |
| 5 | OTS calendar `GET <calendar>/timestamp/<digest>` | Viewing a capture whose anchor is still pending; app start after offline captures | Nothing. Receives the upgraded receipt | The record keeps saying "awaiting confirmation" — no timer-based pretending |
| 6 | Esplora `GET block-height`, `GET block/<hash>/header` (mempool.space) | Verifying a file with a confirmed OTS anchor | Nothing. Receives an 80-byte block header | The receipt is shown as internally consistent with the blockchain binding honestly "unchecked" |
| 7 | Esplora `GET /blocks/tip/hash` + `GET /block/<hash>/header` (0.10.0 beacon) | A jittered timer decoupled from shutter events, and app foreground — **never a per-capture fetch**, so an observer cannot correlate this traffic with captures. Endpoint pinnable in Settings | Nothing. Receives the tip block hash, height, and header | The beacon is simply absent from new records, and the record's `observedAt` staleness is disclosed |

Calls 3–7 are hash-or-nothing flows: digests out, receipts in. Custom TSA
endpoints and custom OTS calendars are configurable in Settings (every
trust claim is swappable); the defaults are free, accountless public goods.

**The dead-man's switch (0.10.0, W5.4) was REMOVED.** It was the largest
blast radius in the app — an automatic upload of the entire vault — and its
mitigation (sealing to a desk key whose private half exists only as Shamir
shares) was never wired to a real intake flow. With the switch gone, no
flow sends capture bytes off the device at all. (The desk-key Shamir
custody itself lives on in the desk's key manager; it was never the
switch's code.)

**0.9.5 removed the Google Cloud Vision reverse-image lookup** — its app
client and its relay route. It was the only feature that sent media off
the device and the only one with a recurring bill; neither fit a
zero-dependency tool.

## What is NOT here (and never will be)

- No analytics, no telemetry, no crash reporting, no ads.
- **No launch-time phone-home of any kind (0.9.5).** Attestation is on
  demand: the app ships with **no registry address bundled** and contacts
  one only when the user enters a URL and taps "attest now".
- No account system of any kind. No push tokens. No device fingerprinting.
- No bundled API keys — and, since 0.9.5, no bundled server endpoints of
  any kind. The remaining defaults (TSA URLs, OTS calendars, the Esplora
  base) are free public-goods protocols, each overridable in Settings.

## The CaptureKit capture module (1.0.0, WS1) — no network at all

The native capture module (`modules/capture-kit`) — streamed chunk hashing,
raw audio master, sensor log, stills ring buffer — performs **no network I/O
of any kind**. It opens no socket, makes no request, and has no endpoint to
configure: capture and the `camera.streamedChunks` commitment are computed
entirely on-device. `camera.streamedChunks` is a **project-specific label,
not a `c2pa.*` label** (the upstream binding migration is WS3); in this
build it rides as a field inside the signed record's capture-metadata block
(the real JUMBF assertion lands in Phase 2). One honesty note (1.0.0
audits): the Merkle leaves are ordered by the timing-dependent video/audio
interleave, which nothing yet records, so the root is **not recomputable
from the delivery file alone** in this build — desk-side re-chunk
verification waits for the per-track roots in the next fix wave; byte
equality of the delivery file is enforced today by the unchanged
`c2pa.hash.bmff.v2` hard binding. Nothing
about the module hides a network event, because it causes none.

## Server-side (the relay, `server/server.mjs`)

The relay is optional and self-hostable, and since 0.9.5 does exactly one
thing: App Attest registration. It holds: an aggregate registration counter
(no key IDs, no fingerprints, no per-device records — the registry was
reduced to a count because the entries were write-only and accumulated a
hardware roster nobody read), single-use 5-minute challenges, and
rate-limit buckets. State checkpoints to a volume so redeploys don't reset
abuse controls. There is deliberately no `/devices` listing — a public
roster of real hardware is an opsec liability.

## Verifying this document

`grep -rn "fetch\|XMLHttpRequest\|WebSocket" src/ app/ modules/` — every real
call site maps to a row above. (0.10.0 audit A7: the grep must be the bare
word, not `fetch(` — two surfaces call the network through an injectable
wrapper whose DEFAULT is the global fetch: `otsClient.fetchFn` and
`beacon.fetchImpl`. A paren-grep silently misses both.) If you find a call
site that doesn't map to a row, that is a bug: please report it.
