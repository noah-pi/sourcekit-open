<!-- Source Kit 0.1.0 — every network call the app can make -->
# Network calls

Every network call the app can make, what triggers it, what leaves the
device, and what happens offline. The rule: **capture, sign, verify, and
export all work with the network off** — and `tests/test-offline.mts`
proves it, with a fetch stub that rejects every call and a tripwire that
fails if verification ever performs even one.

| # | Call | Trigger | What leaves the device | Offline behavior |
|---|------|---------|------------------------|------------------|
| 1 | `GET <registry>/challenge` | Only when an organization registry URL has been entered on the Device key card. Attestation itself runs on first launch with a local challenge and makes no call | Nothing. Receives a 32-byte random challenge | Attestation simply doesn't happen; capture and signing are unaffected |
| 2 | `POST <registry>/attest` | Same flow, once per attestation | The Apple attestation object + the signing public key. No media, no identity, no location | Same as above |
| 3 | RFC 3161 `POST <TSA>` | Sealing a capture (background queue), once per timestamp authority | A SHA-256 digest of the signature — **never the media, never the record** | The seal completes with device-clock time and the record says "device clock only". Queued countersigning does not backdate it |
| 4 | OTS calendar `POST <calendar>/digest` | Sealing a capture, when "Bitcoin-anchored timestamps" is on (default) | A 32-byte SHA-256 digest of the record's signed payload — same disclosure profile as (3) | Queued on-device and submitted on reconnect; the queue delay is recorded in the record (`queueDelayMs`), never backdated |
| 5 | OTS calendar `GET <calendar>/timestamp/<digest>` | Viewing a capture whose anchor is still pending; app start after offline captures | Nothing. Receives the upgraded receipt | The record keeps saying "awaiting confirmation" — no timer-based pretending |
| 6 | Esplora `GET block-height`, `GET block/<hash>/header` (mempool.space) | Verifying a file with a confirmed OTS anchor | Nothing. Receives an 80-byte block header | The receipt is shown as internally consistent, with the blockchain binding "unchecked" |
| 7 | Esplora `GET /blocks/tip/hash` + `GET /block/<hash>/header` (beacon) | A jittered timer decoupled from shutter events, and app foreground — **never a per-capture fetch**, so an observer cannot correlate this traffic with captures | Nothing. Receives the tip block hash, height, and header | The beacon is simply absent from new records, and the record's `observedAt` staleness is disclosed |
| 8 | Open-Meteo `GET archive-api.open-meteo.com/v1/archive` | **Tapping "Check the archive"** on the Weather card of a located capture, on the asset and Inspect screens — never on open, never part of sealing | **The sealed latitude and longitude, rounded to four decimals, and the capture date.** This is the only call that sends anything about where you were; every other row sends a digest or nothing | The card states "Network not available" rather than inventing a reading |
| 9 | `GET https://<your domain>/.well-known/sourcekit-site.json` | Tapping Create file or Test on Settings › Website, for a domain you typed | Nothing but the request itself, to a domain you entered. No capture, no identity, no location | The screen says the website did not answer. Nothing is stored |
| 10 | `GET https://<org domain>/.well-known/sourcekit-org.json` | Tapping Fetch credential on Settings › Identity via certificate authority | Same as (9). The request itself tells that server your IP and which organization you are asking about; the member entry for this device's key is found and verified locally, after the document arrives | The credential is not installed and the screen says the domain did not answer. The file-import path needs no network at all |
| 11 | `GET https://trust.iptc.org/anchor-list.pem` | Opening Settings › Identity via certificate authority, and importing a certificate — at most once a week, and never at launch | Nothing. A plain GET for a public file, byte-identical from every device. Receives the anchor list | The device keeps whatever list it already holds, or none, and says which. A certificate it cannot place reads *Certificate* rather than *Certified* |

Calls 3–7 are hash-or-nothing flows: digests out, receipts in; the defaults
are free, accountless public goods. Calls 9–11 send nothing at all: they are
fetches of public documents, two of them to addresses you typed yourself and
the third to one published list. None of the three is ever triggered by a
capture.

> **Row 8.** Comparing a sealed capture against the
> official weather for that hour is a genuinely useful check, and it costs a
> third party the coordinates. So it does not happen on its own: the card sits
> idle behind a button that names what the tap sends, and nothing leaves until
> someone presses it. Turn location off at the shutter and there is nothing to
> send at all.
>
> Nothing else on either screen resolves a coordinate. Place names are not
> looked up — the platform geocoder would hand the coordinates to Apple — so
> the sealed latitude and longitude are shown as sealed.
>
> **Rows 9 and 10.** Row 8 is the only call that sends a location. Rows 9
> and 10 send no capture data at all, but a request is itself a disclosure:
> the server learns your address and that you are enrolling with it. Each
> fires only when you type a domain and ask for it.

## What there isn't

- No analytics, no telemetry, no crash reporting, no ads.
- **No launch-time phone-home of any kind.** Attestation runs locally. The
  app ships with no registry address and contacts one only after a URL is
  entered.
- No account system, no push tokens, no device fingerprinting.
- No bundled API keys and no bundled server endpoints. The remaining defaults
  (TSA URLs, OTS calendars, the Esplora base) are free public protocols.
- No flow sends capture bytes off the device.

## The capture module makes no calls at all

`modules/exhibit-camera` — the capture session, raw audio master, and sensor
log — performs no network I/O. It opens no socket, makes no request, and has
no endpoint to configure. Capture and the `com.verify.streamedChunks` commitment
are computed entirely on-device, the latter in TypeScript
(`src/provenance/trackChunks.ts`) by demuxing what the module wrote.

`com.verify.streamedChunks` is a project-specific label rather than a `c2pa.*` one,
and rides as a field inside the signed record's capture-metadata block. See
[INTEGRITY.md](INTEGRITY.md) for what that commitment does and doesn't bound.

## Verifying this document

```sh
grep -rn "fetch\|XMLHttpRequest\|WebSocket" src/ app/ modules/
```

Every call site maps to a row above. Grep the bare word rather than `fetch(`:
two surfaces reach the network through an injectable wrapper defaulting to the
global fetch (`otsClient.fetchFn` and `beacon.fetchImpl`), and a paren-grep
misses both.

A call site that doesn't map to a row is a bug. Please report it.
