<!-- Source Kit 0.1.0 — every setting and what it changes -->
# Settings, in full

The Settings screen keeps every row short. This is the long-form version of
what each row does, in the order the screen shows them.

## Device key

Every capture is signed with an ECDSA P-256 key generated on and never
leaving this device. Three backends, in order of strength: the Secure
Enclave with Apple's attestation bound to the key, the Secure Enclave
alone, and the OS keychain as a software fallback that says so. The card
shows the fingerprint; publish it so recipients can confirm your signatures.

Attestation runs on first launch with a locally generated challenge and
needs no network. An organization that runs its own registry can enter its
URL under "Use an organization registry instead"; nothing is bundled and
nothing is contacted until a URL is typed.

**Rotate key** generates a new device identity and destroys the old private
key. Past captures stay verifiable against the old fingerprint; new
captures sign with the new key, and any credential issued for the old key
stops being used until re-issued.

**Face ID on every seal** switches to a separate hardware key that needs
Face ID for each capture, so a record says a recognized person approved
that capture and not only that the phone was unlocked. The trade-off is on
the switch: Apple's attestation binds one key, the everyday one, so files
then read *Face ID approved* instead of *Attested*, and a certificate
issued for the everyday key is not used.

Every capture is also signed with ML-DSA-65, a post-quantum algorithm, with
a software key in the keychain. It signs alongside the device key, never
instead, and de-identified copies skip it so a long-lived key cannot
re-link them.

## Signer Information

Every name on a capture comes from a credential the device holds. There is
nowhere to type one, because a typed name is not something a verifier can
check.

- **Website** — publish one file at `/.well-known/sourcekit-site.json` on a
  domain you control, listing the phones allowed to sign as you. It rests
  on the certificate already on your website, so nothing else has to be
  configured. It shows control of an address, not who owns it, and the
  label reads *Domain verified*. One file lists every phone; creating the
  file on a second phone keeps the first phone's entry.
- **Identity via certificate authority** — a certificate in your name, from
  a public authority or from your organization, issued for the key already
  in this phone. The app builds the certification request and signs it
  with the Enclave key; you send that out and import what comes back, from
  a file or from the issuer's own domain over TLS. The private key never
  leaves the Enclave. An organization's certificate reads *Certified*; a
  person's reads *Verified*; a chain that holds but reaches no list this
  device carries reads *Certificate*. The anchor lists refresh at most
  weekly, when this screen or an import opens, never at launch.

## What gets recorded

Identifying rows first, evidence rows after. Each is a switch, and an off
switch means the thing is not collected at all: the signed record says
`never-recorded`, which is never indistinguishable from a failure.

- **Location** — exact GPS coordinates at the shutter. Off is a sealed
  statement that no location was recorded.
- **Identity** — on means a name rides along, from whichever credential is
  installed; off means anonymous. With no credential installed the switch
  is off and says so. Which mode is active is cycled on the viewfinder
  pill, which skips modes with nothing behind them.
- **Wi-Fi** — the router's hardware address the phone reports. Anyone can
  name a network anything, so a verifier reads it as a lead. Needs
  location permission and a signed build. Off by default.
- **Multiple lenses** — two rear cameras shoot at once, and a downsampled
  second view is sealed into the file as a C2PA ingredient.
- **Motion log** — full-rate 100 Hz accelerometer and gyroscope, barometer,
  and location fixes, as JSONL, beside the delivery file.
- **Shutter burst** — the frames around the shutter, 3 before and 4 after.
  Photos only.
- **Transcript** — speech-to-text on device. Video and audio only. Sealed
  inside the signed file.
- **Raw audio** — an uncompressed 16 kHz mono LPCM master during video,
  converted on device from the same buffers that feed the delivery track.

Every evidence file's digest is committed under the record signature, so a
reader that finds no digest says the sidecar is uncommitted rather than
assuming it matches.

## Blockchain timestamping

A hash of each capture goes to the public OpenTimestamps calendars, which
place it in a Bitcoin block within a few hours. A hash only, never media, no
account, no cost. Pending and queued states are shown as such. Every record
also carries the latest cached Bitcoin block, fetched on a jittered timer
that never coincides with a shutter, as a lower bound on when the seal was
made.

Countersigning by an RFC 3161 timestamp authority is not a setting. It
happens on every seal, against a built-in pool of public authorities, and
the record says which one answered or that none did.

## Privacy and Security

- **Set passcode**, **Remove** — the passcode locks the app. It is not the
  key: media is encrypted under a key that never leaves the device.
  Repeated wrong attempts lock the keypad with escalating delays.
- **Unlock with Face ID** — unlocks the app instead of the passcode when the
  device has it set up.
- **Save to Photos** — keeps a signed copy of each photo in the camera roll,
  outside the encrypted vault. Off by default.
- **Erase all Source Kit data** — the vault, the records, the keys.

## Appearance

Light, dark, or the system setting.

## Diagnostics

Photos and video seal with c2pa-swift, the Content Authenticity
Initiative's SDK. Audio seals with the Source Kit signer, as does any
capture where the SDK fails, with the reason logged. The event log names
the engine that sealed each capture.

- **12 MP photo clamp** — on by default. Off reserves the full 48 MP stream
  on a live dual-camera graph, which costs the pipeline real bandwidth.
- **Event log** — what sealed, what failed, and why. Clear empties it.
- **SDK quarantine** — shown only when the SDK produced bytes that failed
  their own self-check. Export a copy for forensics, or clear.

## Beta

The cryptography is real and verifiable today, and this is early software.
Keep your own backups. Files you sign now will remain verifiable as the
format evolves.
