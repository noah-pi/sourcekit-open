<!-- Source Kit 0.1.0 — every setting and what it changes -->
# Settings, in full

The Settings screen keeps every row short. This is the long-form version of
what each row does.

## Capture

### Byline

A byline is self-asserted — it records what you wanted to be called, not proof
of who you are. Organization affiliation belongs to a real credential (see
*Trust* below), which your organization signs and verifiers can check — never a
typed-in claim.

### Identity on each capture

Per-capture disclosure, aligned with CAWG guidance. The cryptography is
identical either way — this chooses what the signed record *says* about you.

- **Anonymous** — no name, no organization.
- **Organization only** — your org credential identifies the organization,
  never your name. The setting a stringer in a hostile country wants. Without
  an org credential installed this is effectively anonymous.
- **Named** — your byline, plus org credential when installed.

### Privacy at capture

- **Record location** — GPS coordinates (and GPS-based compass heading) are
  written into the attestation.
- **Record sensor context** — barometric pressure/altitude and the motion
  signal around the shutter moment.
- **Record Wi-Fi network** — the Wi-Fi name and router address your phone
  reports at capture. Self-reported — anyone can name a network anything — so a
  verifier reads it as a lead to weigh, never proof of place. Needs location
  permission and a signed build with the Wi-Fi entitlement; without them the
  record says "unavailable". Always removed from de-identified copies. Off by
  default.
- **Save signed photos to camera roll** — copies leave the encrypted vault
  (still signed). Off by default.

### Capture evidence

Three toggles — **parallax ring**, **raw audio master**, **full-rate sensor
log** — all on by default. They control which evidence files the native
capture session writes beside the delivery photo or video. The files stay on
this device for later analysis. The phone does not analyze them.
Turning a toggle off means the evidence is **not collected at all**: future
captures carry no such evidence and their signed record says so explicitly
(`never-recorded`) — an off toggle is never indistinguishable from a failure.

What each captures:

- **Parallax ring (stills only)** — about 8 JPEG frames straddling the
  shutter, for depth review. Video keeps no ring.
- **Raw audio master (video)** — an uncompressed LPCM track (16 kHz mono
  `.caf`) converted on-device from the same native audio buffers that feed
  the delivery file, for later analysis such as mains-hum work. Recording
  mode disables voice processing as far as the public API allows.
- **Full-rate sensor log** — accelerometer/gyroscope at 100 Hz, barometer,
  and location fixes, as JSONL. Location is the fused `CLLocation` kind iOS
  provides — raw GNSS is not available on iOS and is never faked.

Alongside the evidence files, CaptureKit video also carries a **streamed
hash commitment**: the bytes are SHA-256-hashed in fixed 1 MiB chunks as
they are written, with constant memory, and the record's
`camera.streamedChunks` assertion carries the Merkle root fixed the moment
recording stopped. Byte equality of the finished file is still verified
separately by the existing hard binding. And the record carries the
**anti-banding state**: mains frequency derived from the device region
(50/60 Hz), never measured — iOS exposes no anti-banding API, so the record
says `region-derived` — plus the last known exposure duration.

Every evidence sink is recorded in exactly one of three states: the file's path
when collected, an explicit `null` when the sink was on but failed, or
`never-recorded` when the toggle was off, the sink doesn't apply to the
media kind (PCM on a still, ring on a video), or the CaptureKit module is
unavailable (simulators and older builds use the previous camera path).
Evidence failures never destroy the delivery capture — photo and video
always land.

## Time evidence

- **Bitcoin-anchored timestamps** — each capture's fingerprint is submitted to
  the free public OpenTimestamps calendars: a hash only, never media, no
  account, no cost. Confirmation takes about two hours; pending and queued
  states are shown as pending and queued.
- **Custom timestamp authorities (advanced)** — every trust claim is swappable.
  Leave blank to use the built-in RFC 3161 witness pool; enter one URL per line
  to use your organization's own authorities.
- **Custom OpenTimestamps calendars (advanced)** — same idea for the Bitcoin
  anchoring step.
- **Bitcoin block endpoint (advanced)** — every record also embeds the latest
  cached Bitcoin block: proof the signature is no older than that block. Tips
  are fetched on a jittered schedule, never when you shoot. Leave blank for the
  public defaults; pin your own Esplora server here.

## Which code seals a capture

Not a setting. Photos and videos are signed by
[c2pa-swift](https://github.com/contentauth/c2pa-swift); audio and PNG are
signed by this app's own COSE/JUMBF builder, which is also what verifies every
file. Diagnostics names the path for each capture.

## Trust

### Newsroom rosters

A roster is your newsroom's signed list of staff keys: names, roles, validity
dates, vouched for by an editor's signature. Check a colleague's exhibit and
their name shows — with who vouched and when. Revoking a departed member never
erases their genuine past captures; signing after a revocation is a red flag.
Roster files come from your newsroom, out of band — never from inside a file you're
checking. When you install one, confirm the editor fingerprint out of band
against what your newsroom actually distributed. A roster carrying a newsroom key
also unlocks sealed-to-newsroom capture; only that key's share holders can open
that ciphertext.

### Organization credential

Optional. Without one, photos are signed by this device's self-issued
certificate — cryptographically valid, but flagged "untrusted issuer" by public
C2PA tools. With one, your organization's CA vouches for this device's key, and
external verifiers can validate the credential — and its revocation status —
against the org.

How it works: export this device's public key → your organization signs that
key with its CA (offline, e.g. openssl) → import the certificate here. The
private key never leaves the Secure Enclave, and Source Kit never accepts one.
Revocation is handled by your org's standard OCSP/CRL endpoints, checked by
verifiers. If the device key rotates, the installed credential no longer
matches and stops being used until re-issued.

## Safety

### App lock and the vault

Only this phone can open your vault — media is encrypted under a key that never
leaves the device. The passcode locks the door; it is not the key. Repeated
wrong attempts lock the keypad with escalating delays. Face ID, when enabled,
unlocks the app instead of the passcode.

## This device

### Signing identity

Every capture is signed with an ECDSA P-256 key generated on and never leaving
this device. Three backends, in order of strength:

1. **Secure Enclave · Apple-attested** — Apple has certified this device and
   app (App Attest), and that certificate is cryptographically bound to the
   Secure Enclave signing key. The binding rides inside every photo's C2PA
   manifest, verifiable offline against Apple's root.
2. **Secure Enclave (non-extractable)** — the private key cannot leave the
   chip; signing happens on the silicon, and no process (including this app)
   can ever read the key.
3. **OS keychain (software fallback)** — device-bound, not hardware-anchored.

Publish the fingerprint so recipients can confirm your signatures.

### Post-quantum seal

Every capture is also signed with ML-DSA-65, a post-quantum algorithm —
insurance against a future break of P-256. This key is software in the OS
keychain, not Secure Enclave: it signs alongside the device key, never instead,
and it is not a hardware anchor. De-identified copies skip it: a long-lived
device key would re-link them.

### Biometric-bound signing

Optional extra assurance: fresh Face ID approval seals every capture — proof
that a recognized person approved that capture, not just that the phone was
unlocked. The trade-off, also shown when you enable it: biometric
signing uses a separate Secure Enclave key, and Apple's hardware attestation
can only bind one key — your everyday signing key. New signatures carry
"Face ID–approved" instead of the Apple hardware attestation, and any
organization credential must be re-issued for the new key.

### Hardware attestation (App Attest)

On demand, and off by default. Source Kit ships with no registry address and never
contacts one at launch. If you point it at a registry you choose — self-hosted
with the open server in the Source Kit repo, or a public one you trust — Apple
certifies that this is genuine hardware running a genuine Source Kit build, and
that certificate is cryptographically bound to this device's signing key.
Signing works regardless; attestation lets anyone check your media came from
genuine hardware.

## How verification works

Verification is offline math, not a service: strip the credentials, re-hash,
check the signature against the embedded public key. A signature proves
integrity and which key signed — never who holds that key, that a scene was
real, or that a clock told the truth.

| Piece | What it is |
| --- | --- |
| Hash | SHA-256 of the exact signed bytes |
| Signature | ECDSA P-256 (ES256) · COSE_Sign1 |
| Standard | C2PA manifest embedded in the file (JPEG / MP4 / MOV / M4A) |
| Trusted time | RFC 3161 tokens, cryptographically verified on-device |
| Key storage | Secure Enclave, non-extractable (when available) |
| Hardware proof | Apple App Attest, verified offline against Apple's pinned root |
| Org credential | X.509 chain into your org's CA (optional) |
| Transcription | On-device Apple Speech, sealed inside the signed file |
| Vault | AES-256-GCM, keychain-held key |

## Beta

The cryptography is real and verifiable today — but this is early software.
Expect rough edges, and don't rely on Source Kit as the only copy of anything
important: keep your own backups. Files you sign now will remain verifiable
even as the format evolves. If something breaks or feels off, that's useful —
tell us.
