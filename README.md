<p align="center">
  <img src=".github/banner.svg" alt="Source Kit — an open cryptographic camera" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-1F6B45?style=flat-square"></a>
  <a href=".github/workflows/ci.yml"><img alt="CI" src="https://github.com/noah-pi/sourcekit-open/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Opens in c2patool" src="https://img.shields.io/badge/C2PA-opens%20in%20c2patool-1F6B45?style=flat-square">
  <img alt="Platform iOS" src="https://img.shields.io/badge/platform-iOS-6E6E73?style=flat-square">
  &nbsp;<a href="https://testflight.apple.com/join/cRuRw2MN"><b>Try it on TestFlight →</b></a>
  &nbsp;<a href="https://noah-pi.github.io/sourcekit-open/"><b>Deep dive →</b></a>
</p>

---

# Fuck deepfakes. Prove your work.

**Source Kit is a cryptographic camera app that embeds each photo and video with a signed
record of how it was made** — which device, which instant, what the sensors read, what a
second lens saw — so anyone can check later where a file came from and what has happened to
it since.

The record is signed and sealed into the file at the moment of capture, as a standard C2PA
manifest. It works without a network, and it can be checked with any C2PA tool.

**Download the beta:
[testflight.apple.com/join/cRuRw2MN](https://testflight.apple.com/join/cRuRw2MN)** ·
[Deep dive →](https://noah-pi.github.io/sourcekit-open/)

Secure Enclave and App Attest need real hardware. The simulator falls back to a software key
and says so.

## An open source proof-of-concept

All of Source Kit's code is published under Apache-2.0. I'm a journalist turned product
designer, not a cryptographer or a career engineer. Everything is here — camera,
cryptography, native modules, interface, test suite.

## What it commits

All of it optional, all of it switchable in the viewfinder, all of it readable by any C2PA tool.

<details>
<summary><b>Hardware attestation, bound to the key</b> — not just a real phone — this key, on this phone</summary>

Signing keys are generated inside the Secure Enclave and cannot be extracted. Apple's App Attest
certifies the device and the app, but gives applications no access to the attested key, so there
is no direct way to say "and this is the key I sign with."

The workaround is a commitment: set the App Attest `clientDataHash` to `SHA256(challenge ‖
signingPublicKey)`. Apple's certificate then vouches for exactly that key, in the nonce
extension at OID `1.2.840.113635.100.8.2`. An attestation cannot be lifted off a real phone and
pointed at someone else's key. The binding rides inside every manifest, so it can be re-checked
offline years later.

This is the strongest thing an app can assert about itself, and it is still weaker than what the
phone's own camera could assert. A signature made inside the imaging pipeline covers the pixels
on their way out of the sensor; this one covers a key and an app, and starts after the image has
already been handed over. That difference, and who has closed it, is further down the page.
[appAttest.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/appAttest.ts)

</details>

<details>
<summary><b>Independent timestamping</b> — the only claim that does not come from your phone</summary>

Every other field in the record is the device describing itself. The clock is the easiest of
those to move, so it gets outside corroboration. An RFC 3161 countersignature from a timestamp
authority is verified cryptographically on-device rather than read off the token, and an
OpenTimestamps receipt lands the record's digest in a Bitcoin block, which gives a lower bound
nobody controls.

Offline, the capture signs without either and the report says the anchor is missing rather than
implying one. An anchor queued for later records its own delay instead of backdating.
[timestamp.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/timestamp.ts) ·
[ots.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/ots.ts)

</details>

<details>
<summary><b>Organizational credentials</b> — optional. the only thing that can identify a signer</summary>

By default a capture is signed with a self-signed device key, which proves consistency and
nothing about who you are — and nothing inside the file can fix that. An organization can raise
that without the private key ever leaving the Secure Enclave: the device exports its public key,
the organization's CA issues a certificate for that key, and the device imports it. From then on
the signature chains into the organization instead of into itself.

There is also a hands-off version. A newsroom publishes a static document at `/.well-
known/signet-org.json` listing member fingerprints and their certificates, and a member enters
the domain rather than passing files around.

Revocation stays where it belongs: the organization's CA publishes OCSP and CRL endpoints, and
any verifier can ask. A credential that no longer matches the active device key — after a key
rotation, say — is ignored and flagged, never quietly used. The app will not accept a credential
that ships a private key. [orgCert.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/orgCert.ts) · [orgDirectory.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/orgDirectory.ts)

</details>

<details>
<summary><b>A verdict that refuses to be a badge</b> — four questions, four answers, no checkmark</summary>

A checkmark borrows the authority of a body that supposedly did the checking. No such body
exists here. So the result is a ladder of four separate questions, each answered on its own
evidence:

Rung two used to be two rungs — "signer identified" and "accessioned by an organization" — until
it became clear they were the same question. Identity is not knowable from the file at all
unless something outside it vouches for the key, and an organization that signs its own root
names an organization without identifying anyone. Two rungs were pretending at a distinction
that does not exist.

Each rung is *reached*, *not reached*, *failed*, or *not applicable*, and the unreached ones say
why. Unsigned renders neutral grey, never red: the absence of a credential is not evidence of
tampering. *Verified*, *authentic* and *trusted* name a conclusion somebody reached, and nothing
here reaches conclusions — a test fails the build if one of those words appears in a verdict
position. [trustLadder.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/trustLadder.ts)

- **Media unchanged since signing.** The signature verifies and the bytes match what was signed.
- **Signer identified.** Something outside the file vouches for the key — a signed newsroom roster or a curated trust list.
- **Key attested by Apple hardware.** Apple certifies the key is Enclave-resident on genuine hardware.
- **Time bracketed by an independent anchor.** A pinned-authority countersignature or a verified Bitcoin anchor.

</details>

<details>
<summary><b>Privacy and data redaction controls</b> — the same record that proves your work can expose you</summary>

Say this plainly, because the provenance industry mostly does not. A manifest that establishes
where a photograph came from is, by construction, a record of where its photographer was, when,
on which device, and often under what name. C2PA is dual-use. For a wedding photographer that is
a credential. For someone documenting a police stop, a strike, or a border crossing, the same
file is a surveillance artefact they carried in voluntarily and cannot take back once it is
shared.

So the control has to sit at the shutter, not at export. Every field is committed under its own
salt into a signed Merkle tree, which lets a verifier tell three states apart: **disclosed**,
**withheld** — committed but absent, with no ciphertext to attack — and **never-recorded**,
declared at capture and bound into the root, so a withheld field cannot later be passed off as
one that was never collected.

Reveal a field later and it still verifies against the original signature. Or destroy the seed,
and the withheld fields become permanently underivable by anyone, including me. What this does
not cover is the picture itself: blur a face and the signature breaks, which is the sixth gap
below. [src/disclosure](https://github.com/noah-pi/sourcekit-open/tree/main/src/disclosure)

</details>

<details>
<summary><b>Forensic checks any person can run</b> — no model, no upload, no probability</summary>

Inspect renders the signed claims against independent physical expectations and leaves the
inference to you. The sun's elevation and azimuth are deterministic from the signed time and
place, so the card shows which way shadows should fall. The committed gyro predicts where level
sits in frame. The motion trace is drawn against the optical flow.

A detector returns a number nobody can audit, and it gets worse exactly as generators improve.
This inverts that. A check that could not run says so.

handheld — unmistakable synthetic — too clean Faking both consistently is hard. A detector takes
an image and returns a number nobody can audit. Inspect renders a signed claim against an
independent expectation and leaves the inference to the reader.
[src/components/forensic](https://github.com/noah-pi/sourcekit-open/tree/main/src/components/forensic)

</details>

<details>
<summary><b>A second lens</b> — the cheapest counter to photographing a screen</summary>

Nearly every flagship smartphone ships a multi-camera array, and almost nothing uses the second
one for provenance. Source Kit seals a simultaneous downsampled ultra-wide frame into the same
file, as a C2PA ingredient with relationship `componentOf`. Open the photo in any C2PA reader
and the second viewpoint is there.

An ultra-wide sees far more of the room than the frame you composed. A monitor bezel, the edge
of a laptop, the glow off an OLED panel — all of it lands in the second view.

Past that, the geometry. Two lenses a known distance apart see a flat plane identically and a
scene with real depth differently, and no homography removes the difference. On an iPhone Pro
they sit [about 19.2 mm apart](https://arxiv.org/pdf/2506.06037), which is enough to measure
depth out to roughly nine metres from the sealed frame. That is a lot of room, and rephotography
lives at the near end of it: a monitor filling the frame sits about 60 cm away, nowhere near the
limit.

Parallax range calculator

19.2 mm 0.6 m SUBJECT DISTANCE

Disparity = focal length in pixels × baseline ÷ distance, with focal length taken from a 70°
horizontal field of view at the analysed width. A patch has to shift by at least one pixel to be
measurable, so that is the range floor. Below roughly 9 cm the shift exceeds the ±14 px search
window and matching fails outright.

**It does not currently flag its own limit.** The card reports the matched-patch count and the
median disparity and stops there — no verdict, no range warning. Someone reading a distant
subject sees a small number and has to know for themselves that small means *out of range*
rather than *flat*. That is a real gap in the interface, not the geometry, and it should say so
on the card. [MultipleLensCard.tsx](https://github.com/noah-pi/sourcekit-open/blob/main/src/components/forensic/MultipleLensCard.tsx)

There is an interactive range calculator for this on the [page](https://noah-pi.github.io/sourcekit-open/#glance-sec).

</details>

<details>
<summary><b>The motion of the phone</b> — two independent signals a forgery has to satisfy at once</summary>

This is really two things, and they fail differently.

**The first is the hand.** A window of gyroscope and accelerometer samples from around the
shutter is signed into the record. Nobody holds a phone still, and the particular tremor of a
hand over a second or two is not a thing a generator produces by accident. On a video or a short
burst — an option in the viewfinder — that trace can be drawn against the optical flow of the
frames themselves, so the movement the device felt is checked against the movement it saw. Those
are two sensors on two physical principles, and they have to tell the same story.

**The second is orientation.** The device knows which way is down from gravity, which way is
north from the magnetometer, and where the sun should be from the signed time and place. Each of
those predicts something visible in the frame: where the horizon should sit, which way shadows
should fall. None of it is a check on the picture's content — it is a check for *agreement*
between what the sensors claimed and what the image shows. A recapture of a screen, for
instance, inherits the screen's horizon rather than the phone's.

Every one of these values is spoofable on its own. The point is that they are only useful
together, and consistency across all of them is a much harder thing to fabricate than any one of
them. That said: this is a cost, not a wall, and it is the kind of cost that falls as generative
systems get better at physical consistency. It raises the price of a convincing forgery; it does
not make one impossible. [poseTrace.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/provenance/poseTrace.ts)

</details>

<details>
<summary><b>A raw audio master</b> — delivery codecs destroy what forensic work needs</summary>

Alongside the compressed track, an uncompressed 16 kHz master is converted from the same native
buffers and its hash signed into the record.

The reason is a technique called ENF analysis. Mains hum at 50 or 60 Hz leaks into almost any
indoor recording, and the grid's frequency wanders in a pattern that is the same across a whole
region and never repeats — so a recording carries a rough timestamp you cannot forge without the
grid's own history. Delivery codecs filter that band out as inaudible, which is exactly right
for listening and destroys the evidence.

Be honest about what this buys. ENF matching is real forensic practice but it is not a party
trick: the literature has conventionally wanted [ten minutes or more of continuous
audio](https://www.sciencedirect.com/science/article/pii/S2352864823000226) for a confident
match against a grid database, and work on shorter clips — tens of seconds to a few minutes — is
an active research problem rather than settled method. A ten-second video will not be dated this
way. What the master does is keep the option open for the recordings long enough to use it, at a
cost of a few megabytes. [capture-kit](https://github.com/noah-pi/sourcekit-open/tree/main/modules/capture-kit)

</details>

<details>
<summary><b>A post-quantum signature</b> — cheap now, and photographs are read decades later</summary>

Every record carries an ML-DSA-65 signature over the same commitment as the ECDSA one.

The obvious objection is that this is a bank vault door on a garden shed — the elliptic-curve
signature is nowhere near the weakest thing here, and an attacker with a quantum computer would
still find it easier to point a camera at a screen. That is fair, and it is not a reason to skip
it. The cost is a few kilobytes per file and a library that already exists. The benefit is that
a photograph taken this week might be evidence in a hearing, an archive or a history in twenty
years, by which time the signature protecting it could be the one thing that has quietly stopped
meaning anything. Nobody gets to re-sign the archive later. [pq.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/pq.ts)

</details>

<details>
<summary><b>Works without a network</b> — sealing and verifying both, with the radio off</summary>

No accounts, no analytics, no launch-time network calls, and no registry address bundled in the
app. The optional calls that exist — a timestamp authority, a Bitcoin anchor, an organization
directory you host — are named individually in the docs, and a capture made offline signs anyway
and says which anchors are missing.

Apple's Reference Image sends the raw image, sensor signatures and hardware identifiers to
Private Cloud Compute and returns an authenticated copy. That is a reasonable trade for most
people. It is not available to someone who cannot afford to be seen talking to a server.
[NETWORK.md](https://github.com/noah-pi/sourcekit-open/blob/main/docs/NETWORK.md)

</details>

## Chasing instruments of truth

A photograph has never been proof. It has only ever been expensive to fake.

In July 1917 two girls in the Yorkshire village of Cottingley photographed some fairies at the
bottom of the garden. The images were examined by
Arthur Conan Doyle, who found them persuasive, and by Kodak, which declined to certify them
but conceded it could not prove them fake. The fairies were cardboard, copied from a
children's book and held up with hatpins. What is striking is not that anyone was fooled but that the question was already understood to be a technical
one, a matter for Kodak, rather than a question about two girls and a hatpin.

Retouching is as old as the negative, and Soviet censors
[airbrushed the disgraced out of group portraits](https://en.wikipedia.org/wiki/The_Commissar_Vanishes)
for fifty years before Photoshop shipped in 1990. A convincing lie took a darkroom, a skill
and an afternoon, and picture desks, wire services and libel law made it expensive to
attempt.

Generative models did not make images forgeable. They made forgery fast and essentially
free, which is lighter fluid on an already smouldering sense of reality.

### Deepfakes are the most legislated subject in artificial intelligence

The volume is worth stating precisely, because it is the reason any of this exists. American
state legislatures introduced [635 AI bills in 2024 and more than 1,200 in
2025](https://www.multistate.ai/artificial-intelligence-ai-legislation), the first year in which
every state filed at least one, and 2026 passed both totals before most sessions closed. Inside
that pile, synthetic media is the largest single category and the one that actually becomes law:
[49 states have now passed at least one deepfake
statute](https://news.ballotpedia.org/2026/07/30/49-states-have-passed-at-least-one-deepfake-law-since-2019/) — 244 of them enacted since 2019, 58 in 2026 alone. Forty-eight states cover
sexually explicit deepfakes; thirty-three now cover political ones, up from twenty-eight in
January.

The pattern is not American. The [EU AI Act's Article
50](https://artificialintelligenceact.eu/article/50/) became applicable on 2 August 2026,
requiring machine-readable marking of AI output and a visible label on deepfakes, with penalties
up to €15 million or 3% of global turnover. [California's AI Transparency
Act](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB942) took
effect the same day. China has required labelling of synthetic text, image, audio and video
since its deep synthesis rules, South Korea criminalised sexual deepfakes without an intent-to-
distribute test, and Denmark has moved to treat a person's face and voice as their property. The
mechanisms diverge; the two technical demands underneath them do not.

### 1 Requiring invisible watermarks on generated media

A watermark rides inside what a model generates, and it holds up against ordinary handling. It
does not hold up against effort. Regenerating an image through a diffusion model [strips the
mark and keeps the picture](https://arxiv.org/abs/2408.10446), one watermark can [overwrite
another](https://arxiv.org/abs/2605.16796), and there is [tooling for it on
GitHub](https://github.com/guillaumemeyer/watermarks-remover). Open-weight models emit nothing
to strip in the first place.

The deeper limit is that a watermark can only speak for what a machine made. It says nothing
about a photograph, which leaves the person holding real footage with nothing to show. Once
everyone knows video can be faked, real video gets dismissed as fake — a move already run in
court by [Tesla's lawyers over recordings of Elon Musk](https://fortune.com/2023/04/27/elon-musk-lawyers-argue-recordings-of-him-touting-tesla-autopilot-safety-could-be-deepfakes/) and by
[January 6th defendants over footage from inside the
Capitol](https://btlj.org/2025/06/deepfaked-evidence-what-case-law-tells-us-about-how-the-rules-of-authenticity-needs-to-change/).

### 2 Requiring all media to carry tamper-proof data about its provenance

Provenance is a word borrowed from the art trade, where it means the paper trail of a painting's
owners — the chain of receipts, bills of sale and catalogue entries that says where a canvas has
been since it left the studio. It was never a claim about the painting. A perfect provenance on
a forgery is a well-documented forgery, and the trade has bought plenty of those. What the paper
trail does is make lying laborious, because the liar has to manufacture a history rather than an
object.

The digital version is the same idea with a signature instead of a filing cabinet. Adobe, Arm,
the BBC, Intel, Microsoft and Truepic founded the [Coalition for Content Provenance and
Authenticity](https://c2pa.org/) in February 2021, and the first specification followed a year
later. Instead of examining a file for signs of forgery, seal it at the source so any later
change reads as a change. A watermark says a machine was involved. A manifest says which device,
which moment, and what has happened since.

## From bytes to photons

Between the sensor and the signature there is a stretch of code. How long it is decides what the
signature is worth.

A digital photograph begins as electrical charge on a grid of sensor wells and ends as a
compressed file. Something has to turn one into the other: read the wells, interpolate colour
across the filter mosaic, correct the lens, reduce noise, tone-map, encode. That chain runs for
tens of milliseconds, and every stage of it is code that could in principle hand the next stage
a different picture. So the question that decides what a provenance signature actually proves is
not how strong the key is. Everyone keeps the key in hardware. The question is how much of that
chain sits between the photons and the signing, and whether any of it can be replaced.

There is a formal answer to that question. C2PA's [conformance program](https://github.com/c2pa-org/conformance-public) grades the signer and writes the grade into the certificate, and there
are two grades. Both cover the same six objectives: certificate enrolment, key confidentiality,
protecting the claim generator from misuse, protecting the asset and assertions at generation,
protecting traffic between components, and the hosting environment. **Level 1** can meet them in
software — the signing key encrypted at rest, a shared secret to authenticate at enrolment.
**Level 2** adds two requirements: the key must be generated, stored and used at a higher
privilege level than the code asking for the signature, and the device must present a hardware-
rooted attestation of the signing binary when it enrols.

The [Pixel 10](https://blog.google/security/pixel-android-trusted-images-c2pa-content-credentials/) is the first phone to reach Level 2, and the way it does so is instructive. Google
signs inside the imaging pipeline on the Tensor G5; the claim key lives in Android StrongBox on
the Titan M2 security chip; a timestamp authority runs on the device, so a capture made with the
radio off still carries trusted time. The frame is never handed to general-purpose code between
the sensor and the signature, which means there is no seam at which a different image could be
substituted. Photograph something with a Pixel 10 and the file supports a claim almost nothing
else can: that these are the photons that struck the sensor.

Qualcomm took the same idea to the rest of the Android market, putting a signer inside the
Snapdragon trusted execution environment. Apple's Reference Image, visible in the iOS 27 beta,
captures sensor signatures and hardware identifiers with the frame — but it sends them to
Private Cloud Compute and returns an authenticated copy, and it is not built on C2PA.

Source Kit sits at the far end of that chain. It receives a finished image from the operating
system and signs the bytes it was handed, in its own process, with a key in the Secure Enclave.
Everything upstream of that hand-off is code it cannot attest to — the ceiling for a third-party
app on iOS, not a design preference, since Level 2 for a mobile app is currently reachable only
on Android. What it can do instead is commit far more *around* the frame, so that a forger has
to keep several signals consistent rather than one.

### Cameras got there first, and California is about to switch the lights on

Phones are the late arrivals. Leica shipped the [first camera with Content
Credentials](https://leica-camera.com/en-US/photography/content-credentials), the M11-P, in
October 2023. Sony added capture-time signing across the Alpha 1 II and Alpha 9 III, Canon
launched its [Authenticity Imaging System](https://c2paviewer.com/articles/canon-authenticity-imaging-system) for newsrooms in May 2026, and Nikon [added C2PA to the
Z6III](https://www.nikonusa.com/press-room/nikon-develops-firmware-that-adds-function-compliant-with-cp2a-standards-to-z6iii) in firmware — then withdrew it within a week, when a researcher
used the camera's multiple-exposure mode to make it sign a composite it had not photographed.
Every certificate the programme had issued was invalidated, so credentials from that window no
longer verify. That is the standard working as designed, and a fair measure of how new all of
this is.

Then the law arrives, in two dates. From **1 January 2028**, California's [AB
853](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB853)
requires every capture device sold in the state — the statute names cameras, phones with built-
in cameras or microphones, and voice recorders — to embed a latent disclosure of manufacturer,
device and capture time, by default.

The date to watch is the earlier one. From **1 January 2027**, every platform above two million
monthly users must detect provenance data in what its users post and give them an interface to
inspect it. Until now Content Credentials have been something you could go and check, if you
knew they existed, had a tool, and cared enough to use it. After that date they are something
the platform has to show you. Whatever fraction of the internet is carrying a manifest by then
becomes visible on a single day — not gradually, and not because anyone went looking. It is the
closest thing this field has to switching the lights on in a room nobody has seen properly, and
there is no way to know in advance whether the room turns out to be mostly furnished or mostly
bare.

## Where it still comes up short

Six ways a file can carry a perfect signature and still mislead you. The first independent
security review of the specification,
[Golaszewski et al. at UMBC](https://eprint.iacr.org/2026/804), found implementation problems
on top of these — disagreeing validators, weak revocation, an exclusion range that hides
edits. Those are fixable. The six below are structural.

**The lens can be pointed at a screen.** Photograph a good monitor and every guarantee holds,
because they are all true: that sensor really did see those photons. No signature, from any
device, reaches past the front of the lens.

**A signature binds a claim without checking it.** Civilian GPS is unauthenticated and
spoofers cost less than a phone. The scene can be entirely real while the time and place
sealed beside it are not, and the seal makes a forged fix look exactly as solid as a true one.

**Most platforms strip the credential on upload.** The manifest disappears at the exact moment
a picture starts to travel, and an unsigned file is indistinguishable from one that never had
a signature. The industry answer is a fingerprint plus a lookup service. The fingerprint
exists here; the lookup does not.

**Below Level 2, a picture can be handed to the signer.** If the frame reaches the signing
step through code that isn't attested, whatever arrives gets signed correctly. In 2025 a
researcher used the Nikon Z6III's multiple-exposure mode to do exactly this; Nikon invalidated
every certificate it had issued.

**A staged scene is a true photograph of a lie.** Everything here would have sealed the
Cottingley fairies without complaint. Real camera, real plate, real garden, real light, real
distance — two lenses would even measure genuine depth, because there was genuine depth. Every
check passes and every one of them is telling the truth.

**Protecting someone in the frame breaks the proof.** Blur a bystander's face, crop a
landmark, drop the coordinates, and the signature fails — the file now reads as modified,
which is the same verdict a forgery gets. Selective disclosure here covers the metadata, so
fields can be withheld and still verify. Nothing yet covers the pixels.

None of this is fixed by detection. You cannot out-classify a generator — it improves as the
classifier does. What you can do is raise what a forger has to keep consistent at once:
geometry, motion, shadows, time. Everything this app commits is aimed at the first gap, the
one that stays open however good the hardware gets.

[Diagrams for each of these are on the page.](https://noah-pi.github.io/sourcekit-open/#holes)

## The shutter path

Six things happen on the device before the file exists.

| | | |
|---|---|---|
| 1 | **Hash the exact bytes.** SHA-256, chunked, so verifying a video never loads it whole. | `src/lib/fileHash.ts` |
| 2 | **Record what the sensors said.** Time, GPS (opt-in), heading, barometric altitude, a motion signal. | `src/sensors/` |
| 3 | **Sign in the Secure Enclave.** ECDSA P-256. The key is generated on the chip and can't leave it; signing happens there, not in app memory. | `src/lib/deviceKey.ts`, `modules/secure-enclave/` |
| 4 | **Write Content Credentials into the file.** A real C2PA manifest — CBOR claim, hard binding, COSE_Sign1 — inside the JPEG, PNG, MP4, MOV or M4A. CI checks on every run that `c2patool` reads it. | `src/c2pa/` |
| 5 | **Sign it again, post-quantum.** ML-DSA-65 over the same commitment, so a future break of P-256 doesn't quietly invalidate an archive. | `src/lib/pq.ts` |
| 6 | **Anchor the time.** RFC 3161 when there's a network, OpenTimestamps for independent proof-of-existence. Offline it signs without, and says so. | `src/lib/timestamp.ts`, `src/lib/ots.ts` |

Sealing and verifying both work with the radio off. No accounts, no analytics, no
launch-time network calls. Every optional network event is named in
[`docs/NETWORK.md`](docs/NETWORK.md).

## What you can take

Most of it is platform-neutral TypeScript with no build step.

| Path | What it is |
|---|---|
| `src/c2pa/` | A complete, dependency-light C2PA implementation: CBOR claims, COSE_Sign1, JPEG APP11/JUMBF, PNG `caBX`, BMFF/MP4 embedding with chunk-offset repair, and the verifier. Cross-checked against `c2patool` on every CI run. Probably the most reusable thing here. |
| `src/lib/` | Crypto plumbing, pure TS: a strict X.509 chain verifier, RFC 3161 tokens, COSE/DER, ECDSA, the ML-DSA-65 layer, AES-256-GCM, canonical JSON. No WebCrypto, no network. |
| `src/provenance/` | Capture → sealed record: orchestration, schema, background seal queue, detached manifests, and a differential oracle that runs two independent engines against each other and flags disagreement. |
| `src/disclosure/` | Commit every field at capture, reveal them individually later, without breaking the original signature. |
| `src/vault/` | Encrypted storage. Media, records and thumbnails all sealed; plaintext exists only in a cache folder shredded on lock. |
| `src/theme.ts`, `src/components/`, `app/` | The whole interface — tokens, UI kit, screens. |
| `modules/` | The Swift: Secure Enclave keygen and signing, App Attest, the AVFoundation capture engine, the raw-audio sink, the C2PA Rust binding. |
| `server/` | An App Attest relay in one dependency-free file. Run your own or skip it — offline devices sign unattested and say so. |
| `tests/` | 27 suites, 769 checks, run against the real shipping code. |

## Run the lab

```sh
node tests/stage.mjs
cd tests/.staged && npm install
./node_modules/.bin/tsx test-verification.mts     # → 146 passed, 0 failed
```

Staging rewires only device services — keychain, filesystem, device model — to small
shims. Every cryptographic operation is the code that runs on the phone. The suites
sign fresh media with a random key each run, then attack it: flipped bits, transplanted
manifests, a self-issued "O=Reuters" certificate, truncated files, hostile parsers.

With `c2patool` on your path the independent-verifier checks run too. Without it they
report `SKIP` and are counted separately.

## Worth building next

No coordination needed, no permission to ask.

- **An Android port.** The core is platform-neutral; what's missing is the equivalent of
  `modules/secure-enclave` against Keystore and Play Integrity. The record format and
  verifier carry over unchanged.
- **A standalone verifier CLI.** `src/c2pa/verifyAsset.ts` has no platform dependencies.
  Someone should make `npx` check a file.
- **A TSA trust list.** Timestamping has no mature public root store the way the web PKI
  does. That's a gap for everyone in this space, not just me.
- **Rephotography geometry.** Chromatic-aberration radial physics, JPEG grid artifacts
  surviving into RAW, homography residual across a known baseline. Real signals with
  real error rates, which is the bar — anything that can't publish a false-positive rate
  on a named corpus shouldn't ship a number.
- **Break it.** Make a forged file verify and I'd genuinely like to see it. `tests/`
  shows the shape of a good repro.

## Limits

- **Two checks aren't performed:** TSA root anchoring and certificate revocation. Both
  are named on every verification rather than skipped quietly.
- **Sensors are claims.** Time, GPS, heading, altitude are what the device reported,
  bound into the signature. The binding is real; whether the device told the truth is a
  separate question.
- **Stereo capture is unvalidated on iPhone 17 / iOS 26.** The verification side is
  lab-tested. The capture side moved to Apple's virtual dual-wide device graph and I
  haven't confirmed it in the field yet.
- **No conformance certification.** Files carry standard C2PA manifests and `c2patool`
  reads them on every CI run, but nothing here has been through the conformance program.
- **Beta software, written by one person with AI assistance**, and held to account by the
  test lab, an independent reference verifier and the differential oracle — see
  [`docs/PROVENANCE.md`](docs/PROVENANCE.md). Don't keep your only copy of anything
  important in it, and please don't stake anything serious on it without reading the code
  yourself.

## Building it

If you just want to use it, the beta is on
[TestFlight](https://testflight.apple.com/join/cRuRw2MN).

To build it yourself:
[`docs/BUILDING.md`](docs/BUILDING.md). It's an Expo app: `npm install`, then
`npx expo run:ios` on a Mac with Xcode. Secure Enclave and App Attest need a real
device; the simulator falls back to a software key and labels itself as such. Forking
for your own build means replacing the EAS project id in `app.json` and the App Attest
app id in `src/lib/appleAttestRoot.ts`.

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Threat model](docs/THREAT-MODEL.md) ·
[Security](docs/SECURITY.md) · [Integrity](docs/INTEGRITY.md) ·
[Network](docs/NETWORK.md) · [Settings](docs/SETTINGS.md) ·
[Decisions](docs/DECISIONS.md) · [Recovery](docs/RECOVERY.md) ·
[Provenance](docs/PROVENANCE.md)

## License

Apache-2.0 ([LICENSE](LICENSE), with [NOTICE](NOTICE) for attribution that travels).
"Source Kit" is a trademark and isn't licensed for derivative use
([TRADEMARK.md](TRADEMARK.md)) — fork it, ship it under your own name.

If you build something with this, or find something I got wrong, I'd really like to hear
about it.

— Noah Bassetti-Blum
