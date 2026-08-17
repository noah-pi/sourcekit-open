# Exhibit A 0.8.1 — audit-hardening release

A second external audit of the 0.8.0 tree probed implementation robustness and
"inverse attacks" (using the verifier as the weapon). Four findings were real
and exploitable; all are fixed here, with the attack inputs as permanent
regression tests. Full narrative in `docs/SECURITY.md`.

## Security fixes (all audited, all tested)

1. **DER length-decoding remote DoS — client and server.** 32-bit signed-shift
   length arithmetic (`(len << 8) | byte`) wrapped a 4-byte length of
   `0xFFFFFFFA` to −6; the TLV walker then looped forever. Reachable via any
   crafted certificate handed to the verifier, and via the public
   unauthenticated `/attest` endpoint (whose parser had no guards at all).
   Fixed in `src/lib/x509.ts`, `src/lib/orgCert.ts`, and `server/server.mjs`:
   multiply-accumulate length decoding, per-TLV offset validation, and a
   non-advancing-walker invariant (`next <= o` → throw). **If you self-host the
   relay, redeploy the server — this is the one server-side change.**
2. **NaN validity-window bypass.** Unparseable certificate dates became `NaN`,
   and `atMs < NaN` is always false — the validity check silently passed.
   Non-finite validity dates are now a parse error.
3. **Silent base64 garbage.** Invalid characters decoded as `0` ('A') via a
   `|| 0` fallback. Strict validation now throws; verification paths turn the
   throw into a clean FAILED verdict.
4. **Multi-manifest confusion.** The verifier evaluated the *first* manifest
   in a C2PA store; the spec's update-chain rule makes the *last* one active.
   Two verifiers could legitimately disagree. Now: last manifest wins, and the
   report states "store contains N manifests — verified the active (most
   recent) one; earlier manifests not evaluated."

## Human-layer changes

- **Known-signers list removed.** The manually confirmed signer list was the
  weakest link, not a feature: social-engineering your way onto the list beat
  every cryptographic check downstream, and 8-hex-prefix fingerprint
  comparison is grindable (~4 billion tries). Identity is now honestly
  "this device / org credential / unknown", with the full 64-character
  fingerprint shown for out-of-band comparison. Key-continuity trust is the
  roadmap replacement.
- **Transcription honesty.** Audio transcription is gated on hardware support
  *and* Speech authorization; the app states why it's off (unsupported /
  denied / restricted) instead of silently skipping it. Recordings are signed
  and sealed regardless.
- **One Face ID scan per capture.** A 15-second `LAContext` session primed at
  the shutter replaces up to three per-signature prompts per photo.
- **Audio file creation fix.** `FileSystem.documentDirectory` is a `file://`
  URI; the Swift side treated it as a literal path and AVAudioFile failed.
  Fixed.

## Validation

- `test-verification.mts`: **25 passed, 0 failed** (18 prior + the stall TLV,
  a 4000-buffer fuzz over every DER walker, NaN dates, strict base64, and the
  two-manifest active-chain test).
- `test-070-final.mts`: **19 passed, 0 failed**; `test-bmff-deid.mts`:
  **18 passed, 0 failed** — unchanged.
- TypeScript clean (`tsc --noEmit`).

## Upgrade notes

- App: no schema or settings migration; the known-signers store key is simply
  no longer read.
- Server: **redeploy required** — the `/attest` DoS fix is server-side.
