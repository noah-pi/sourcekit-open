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

Free. No account. Your photos never leave the phone — see
[NETWORK.md](docs/NETWORK.md) for every call the app can make.

Secure Enclave and App Attest need real hardware. The simulator falls back to a software key
and says so.

## Which C2PA code this actually runs

Signing is my own COSE/JUMBF builder, and so is verification in the app. The c2pa-swift binding
is written for both — sign and verify, including Secure Enclave signing — and is not wired into
any screen ([`upstreamEngineIos.ts`](src/provenance/engine/upstreamEngineIos.ts)).

What checks that code is a differential oracle in CI: every corpus asset runs through my verifier
and the official c2pa-rs, and the build fails on any disagreement that isn't whitelisted with a
written reason. See [`docs/PROVENANCE.md`](docs/PROVENANCE.md) and
[`tests/test-oracle.mts`](tests/test-oracle.mts).

## An open source proof-of-concept

All of Source Kit's code is published under Apache-2.0. I'm a journalist turned product
designer, not a cryptographer or a career engineer. Everything is here: camera, cryptography,
native modules, interface, test suite.

## A photograph has never been proof

It has only ever been expensive to fake.

In July 1917 two girls in the Yorkshire village of Cottingley photographed some fairies at the
bottom of the garden. The images were examined by Arthur Conan Doyle, who found them persuasive,
and by Kodak, which declined to certify them but conceded it could not prove them fake. The
fairies were cardboard, copied from a children's book and held up with hatpins. What is striking
about the Cottingley affair is not that anyone was fooled but that the question was already
understood to be a technical one, a matter for Kodak, rather than a question about two girls and
a hatpin.

Retouching is as old as the negative. At Gettysburg in 1863, Alexander Gardner's team [moved a
dead soldier forty yards](https://www.loc.gov/static/collections/civil-war-glass-negatives/articles-and-essays/does-the-camera-ever-lie/the-case-of-the-moved-body.html) into a
rocky niche and leaned a rifle beside him. Soviet censors [airbrushed the disgraced out of group
portraits](https://en.wikipedia.org/wiki/The_Commissar_Vanishes) for fifty years before
Photoshop shipped in 1990. Back then a convincing lie took a darkroom, a skill and an afternoon,
and picture desks, wire services and libel law made the attempt more expensive still.

Generative models did not make images forgeable. They made forgery fast and essentially free.

### Every one of these laws leans on one of two technologies

So far in 2026, U.S. state legislatures have introduced 1,143 artificial-intelligence measures.
Of those, 319 concern deepfakes, provenance, or transparency. Forty-four have already become law
— more than any other subject except the rules states are writing for their own agencies.

**State AI legislation by subject, 2026**

| Subject | Bills introduced | Laws enacted |
|---|---:|---:|
| Commercial AI and consumer protection | 473 | 41 |
| **Deepfakes, provenance, transparency** | **319** | **44** |
| Government and court use of AI | 267 | 53 |
| Risk management, audits, governance | 203 | 14 |
| Schools and AI workforce training | 199 | 24 |
| Health care and insurance | 152 | 19 |
| Task forces and studies | 141 | 21 |
| Jobs, hiring, the workplace | 119 | 11 |
| Budgets and tax incentives | 118 | 28 |
| Housing and rent-setting | 69 | 0 |
| Energy and data centers | 35 | 3 |

Source: [NCSL, *Artificial Intelligence 2026 Legislation*](https://www.ncsl.org/technology-and-communication/artificial-intelligence-2026-legislation), as of August 20, 2026. Categories
collapse NCSL's 24 subject tags; a bill can carry several, so the counts sum past 1,143.

The impulse is not confined to the United States. The [EU AI Act's Article
50](https://artificialintelligenceact.eu/article/50/) became applicable on August 2, 2026,
requiring machine-readable marking of AI output and a visible label on deepfakes, with penalties
up to €15 million or 3% of global turnover. [California's AI Transparency
Act](https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240SB942) took
effect the same day, China has required labeling of synthetic media since its deep synthesis
rules, South Korea criminalized sexual deepfakes without an intent-to-distribute test, and
Denmark has moved to treat a person's face and voice as their property. The mechanisms diverge;
the two technical demands underneath them do not.

### 1 / Requiring invisible watermarks on generated media

A watermark rides inside what a model generates, and it holds up against ordinary handling. It
does not hold up against effort. Regenerating an image through a diffusion model [strips the
mark and keeps the picture](https://arxiv.org/abs/2408.10446), one watermark can [overwrite
another](https://arxiv.org/abs/2605.16796), and the [tools to do it are
published](https://github.com/guillaumemeyer/watermarks-remover). Open-weight models emit
nothing to strip in the first place. Detection has the same shape of problem: a classifier
chasing a generator gets worse exactly as the generator improves.

A watermark can only speak for what a machine made. It says nothing about a photograph, which
leaves the person holding real footage with nothing to show. Once everyone knows video can be
faked, real video gets dismissed as fake, a move already run in court by [Tesla's lawyers over
recordings of Elon Musk](https://fortune.com/2023/04/27/elon-musk-lawyers-argue-recordings-of-him-touting-tesla-autopilot-safety-could-be-deepfakes/) and by [January 6th defendants over
footage from inside the Capitol](https://btlj.org/2025/06/deepfaked-evidence-what-case-law-tells-us-about-how-the-rules-of-authenticity-needs-to-change/).

### 2 / Requiring all media to carry tamper-proof data about its provenance

Provenance is a word borrowed from the art trade, where it means the paper trail of a painting's
owners — the chain of receipts, bills of sale and catalog entries that says where a canvas has
been since it left the studio. It was never a claim about the painting. A perfect provenance on
a forgery is a well-documented forgery, and the trade has bought plenty of those. What the paper
trail does is make lying laborious, because the liar has to manufacture a history rather than an
object.

The digital version is the same idea with a cryptographic signature instead of a filing cabinet.
Adobe, Arm, the BBC, Intel, Microsoft and Truepic founded the [Coalition for Content Provenance
and Authenticity](https://c2pa.org/) in February 2021, and the first specification followed a
year later. Instead of examining a file for signs of forgery, seal it at the source so any later
change reads as a change. A watermark says a machine was involved. A manifest says which device,
which moment, and what has happened since.

## From bytes to photons

Between the sensor and the signature there is a stretch of code. How long it is decides what the
signature is worth.

A photograph starts as charge on a grid of sensor wells and ends as a file. Everything in
between — demosaic, lens correction, noise reduction, tone-map, encode — is code that could hand
the next stage a different picture. What a signature proves has less to do with the key than
with how much of that chain stands between the photons and the signing.

[C2PA grades signers on two levels](https://github.com/c2pa-org/conformance-public): keys
protected in software, or keys in hardware with a live attestation from the silicon. The [Pixel
10](https://blog.google/security/pixel-android-trusted-images-c2pa-content-credentials/) is the
first phone to reach the second, signing inside the imaging pipeline with the key in the Titan
M2. The frame never passes through general-purpose code, so there is no seam where another image
could be substituted. Qualcomm has the same idea in the Snapdragon secure environment. Dedicated
cameras got there first, starting with Leica in 2023.

Source Kit sits at the far end. It signs the bytes the operating system hands it, with a key in
the Secure Enclave, and can attest to nothing upstream of that hand-off. That is the ceiling for
a third-party app on iOS, which is why it commits more *around* the frame instead of claiming
more about it.

## Where it still comes up short

Six ways a file can carry a perfect signature and still mislead you. The first independent
security review of the specification, [Golaszewski et al. at
UMBC](https://eprint.iacr.org/2026/804), found implementation problems on top of these —
disagreeing validators, weak revocation, an exclusion range that hides edits. Those are fixable.
The six below are structural.

`REPHOTOGRAPHY` · *partially addressable*

**The lens can be pointed at a screen.** Photograph a good monitor and every guarantee holds,
because all of them are true: the sensor did see those photons. No signature reaches past the
front of the lens.

`SENSOR SPOOFING` · *partially addressable*

**A signature binds a claim without checking it.** Civilian GPS is unauthenticated and spoofers
cost less than a phone. The scene is real, the signature is valid, and the place is wrong —
sealed just as faithfully as a true one.

`METADATA STRIPPING` · *addressable*

**Most platforms strip the credential on upload.** The manifest disappears the moment a picture
starts to travel, and a stripped file is indistinguishable from one that was never signed. The
answer is a fingerprint plus a lookup service. The fingerprint exists here; the lookup does not.

`SOFTWARE INJECTION` · *addressed in new devices*

**Below Level 2, a picture can be handed to the signer.** If the frame reaches the signer
through code nobody attested to, whatever arrives gets signed correctly. A researcher did this
to the Nikon Z6III through its multiple-exposure mode; Nikon invalidated every certificate it
had issued.

`STAGED REALITY` · *no viable solution*

**A staged scene is a true photograph of a lie.** Everything here would have sealed the
Cottingley fairies without complaint. Real camera, real garden, real light, real distance — two
lenses would measure genuine depth, because there was genuine depth. Every check passes, and
every one is telling the truth.

`REDACTION` · *addressable*

**Protecting someone in the frame breaks the proof.** Blur a bystander's face or crop a landmark
and the signature fails, giving the same verdict a forgery gets. Selective disclosure covers the
metadata, so fields can be withheld and still verify. Nothing yet covers the pixels.

Most of what Source Kit commits is aimed at rephotography, the one failure that stays open
however good the hardware gets.

## What Source Kit commits

Each of these exists because of a gap named above. All of it optional, and all of it switchable
in the viewfinder.

<details>
<summary><b>Hardware attestation</b> — proof the key is held somewhere you cannot reach into</summary>

On Apple the strongest available primitive is App Attest, which certifies that a genuine iPhone
is running an unmodified build of this app, and then hands it no access to the key it just
attested.

The two get tied together with a commitment. The attestation's `clientDataHash` is set to
`SHA256(challenge ‖ signingPublicKey)`, which pins Apple's certificate to this exact key rather
than to some key on some genuine device. The binding travels inside every manifest, and anyone
can recompute it offline years later. [appAttest.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/appAttest.ts)

</details>

<details>
<summary><b>Independent timestamping</b> — time runs one way, which is what makes it provable</summary>

Time is the rare claim that can be proved rather than asserted, because it only moves forward.
Nobody can place a digest in a Bitcoin block mined before the file existed, and no timestamp
authority will countersign something it has not yet been shown.

So a capture carries an RFC 3161 countersignature, verified cryptographically on device instead
of read off the token, and an OpenTimestamps receipt that lands the record's digest in a block.
Some newer hardware runs a timestamp authority on the device itself, so a capture made in
airplane mode still carries trusted time. [timestamp.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/timestamp.ts) · [ots.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/ots.ts)

</details>

<details>
<summary><b>Organizational credentials</b> — optional. the only thing that can attach a name to a key</summary>

A self-signed device key proves consistency and nothing about who you are. An organization can
supply the missing half by issuing a certificate for the device's public key, which never
requires the private key to leave the Secure Enclave. Every signature then chains into the
newsroom instead of into itself.

There is a hands-off version: an organization publishes a static document at `/.well-
known/sourcekit-org.json` listing member fingerprints and their certificates, and a member
enters the domain rather than passing files around.

Revocation stays with the organization's CA, over the OCSP and CRL endpoints in the certificates
it issues, so any verifier can ask. A credential that no longer matches the active device key is
ignored and flagged. [orgCert.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/orgCert.ts)

</details>

<details>
<summary><b>A verdict that refuses to be a badge</b> — four questions, four answers, no checkmark</summary>

A checkmark borrows the authority of whoever did the checking, and there is nobody here to
borrow from. So the result is four questions, each answered on its own evidence, and each one a
rung the file either reaches or does not:

Each rung reads *reached*, *not reached*, *failed*, or *not applicable*, and the unreached ones
say why. Unsigned renders neutral grey rather than red, because the absence of a credential is
not evidence of tampering. *Verified*, *authentic* and *trusted* all name a conclusion somebody
reached, so none of them appear in a verdict position anywhere in the app.
[trustLadder.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/trustLadder.ts)

- **Media unchanged since signing.** The signature verifies and the bytes match what was signed.
- **Signer identified.** Something outside the file vouches for the key — a signed roster or a curated trust list.
- **Key attested by Apple hardware.** Apple certifies the key is Enclave-resident on genuine hardware.
- **Time bracketed by an independent anchor.** A pinned-authority countersignature or a verified Bitcoin anchor.

</details>

<details>
<summary><b>Privacy and data redaction</b> — a record of the photograph is also a record of the photographer</summary>

Because the record is sealed at the shutter, it documents where the photographer was standing,
when, on which device, and sometimes under what name. For most work that is a credential. For
someone photographing a police stop, a picket line or a border crossing, the same file is a
piece of evidence about them, carried in voluntarily and impossible to recall once shared.

So the choosing happens before the shutter, not on export. Every field is committed under its
own salt into a signed Merkle tree, which lets a verifier tell three states apart. **Disclosed**
is what it sounds like. **Withheld** means committed but absent, with no ciphertext for anyone
to attack. **Never-recorded** is declared at capture and bound into the root, so a field you
withheld cannot later be passed off as one you never collected.

Reveal a field later and it still verifies against the original signature. Destroy the seed and
the withheld fields become permanently underivable by anyone, including me.
[src/disclosure](https://github.com/noah-pi/sourcekit-open/tree/main/src/disclosure)

</details>

<details>
<summary><b>A second lens</b> — a second viewpoint, sealed in the same file</summary>

Because the second camera is already there and already running, it costs almost nothing to seal.
Source Kit seals a simultaneous downsampled ultra-wide frame into the same file, as a C2PA
ingredient with relationship `componentOf`. Open the photo in any C2PA reader and the second
viewpoint is there.

An ultra-wide sees far more of the room than the frame you composed. A monitor bezel, the edge
of a laptop, the glow off an OLED panel — all of it lands in the second view.

Past that, the geometry. Two lenses a known distance apart see a flat plane identically and a
scene with real depth differently, and no homography removes the difference. On an iPhone Pro
they sit [about 19.2 mm apart](https://arxiv.org/pdf/2506.06037). How far that reaches depends
entirely on the resolution you measure at: the quick card inside the app decodes both views at
96 px and runs out around 1.3 m, while the 640 px frame sealed into the file reaches roughly 9
m. Rephotography sits at the easy end of both. A monitor filling the frame is about 60 cm from
the lens, where the two views disagree by enough to be unmistakable at either resolution.

Parallax range calculator

19.2 mm 0.6 m SUBJECT DISTANCE

Disparity = focal length in pixels × baseline ÷ distance, with focal length taken from a 70°
horizontal field of view at the analysed width. A patch has to shift by at least one pixel to be
measurable, so that is the range floor. Below roughly 9 cm the shift exceeds the ±14 px search
window and matching fails outright.

The card reports the matched-patch count and the median disparity.
[MultipleLensCard.tsx](https://github.com/noah-pi/sourcekit-open/blob/main/src/components/forensic/MultipleLensCard.tsx)

There is an interactive range calculator for this on the [page](https://noah-pi.github.io/sourcekit-open/#glance-sec).

</details>

<details>
<summary><b>The motion of your hand</b> — nobody holds a phone still, and the wobble is specific</summary>

A window of gyroscope and accelerometer samples from around the shutter rides in the record. Not
every photograph is handheld: a tripod or a copy stand reads as still, which is its own kind of
answer. But for the ones that are, hand tremor over a second or two is unglamorous and highly
particular, and a generator does not produce it by accident.

On a video or a burst — an option in the viewfinder — that trace is drawn against the optical
flow of the frames themselves, so the movement the device felt is checked against the movement
it saw. [poseTrace.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/provenance/poseTrace.ts)

</details>

<details>
<summary><b>Which way the phone was pointing</b> — sensor readings the picture itself can contradict</summary>

The device knows which way is down from gravity, and roughly where north is from the
magnetometer. Read together at the instant of the shutter, they give the direction
the camera was actually pointing. Each of those predicts something visible in the frame: where
the horizon should sit, and, with the signed time and place, which way shadows should fall.

None of this reads the content of the picture. It looks for agreement between what the sensors
claimed and what the frame shows. A recapture of a screen inherits the screen's horizon rather
than the phone's.

Any one of these values can be spoofed alone. They are useful together: a forgery has to satisfy
all of them at once, which is a much harder thing to arrange than any single one. That is a cost
rather than a wall, and the kind of cost that falls as generative systems get better at physical
consistency. [context.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/sensors/context.ts)

</details>

<details>
<summary><b>A raw audio master</b> — compression discards exactly what makes audio checkable</summary>

Because delivery codecs throw away whatever the ear will not miss, they also throw away what
forensic work needs. So alongside the compressed track, a PCM master is converted from the same
native buffers at 16 kHz: not perceptually coded, and resampled low enough to keep the room and
the mains band while discarding everything above 8 kHz and its hash signed into the record.

The best-known use is the mains hum. Grids run at 50 or 60 Hz and drift in a pattern shared
across an entire synchronous interconnection, distinctive enough over a long enough window to
place a recording in time, so indoor audio carries a rough timestamp nobody can forge without
the grid's own history. Matching against a grid database conventionally wants [ten minutes or
more](https://www.sciencedirect.com/science/article/pii/S2352864823000226) of continuous audio;
getting there on shorter clips is an open research problem.

The more interesting direction is agreement between channels. The same grid frequency that
modulates the hum also modulates the light: fluorescent tubes, and LED fixtures with unfiltered
drivers, flicker at twice the mains rate, so the flicker measured in the picture and the hum
measured in the sound are two readings of one physical quantity. A track dubbed in later has no
particular reason to agree with the room it is supposed to have been recorded in. The comparison
is still a research problem. Source Kit seals the raw audio; it does not yet check the two
channels against each other. [exhibit-camera](https://github.com/noah-pi/sourcekit-open/tree/main/modules/exhibit-camera)

</details>

<details>
<summary><b>Forensic checks any person can run</b> — physics the signed record has to agree with</summary>

A signed timestamp constrains what the scene is allowed to look like. The sun's elevation and
azimuth are deterministic from a time and a place, so a low sun and a noon timestamp do not add
up. The card draws where shadows should fall and lets you compare.

Nothing here returns a score. The signed claims are rendered against independent physical
expectations, and a check that could not run says so.
[src/components/forensic](https://github.com/noah-pi/sourcekit-open/tree/main/src/components/forensic)

</details>

<details>
<summary><b>A post-quantum signature</b> — cheap now, and photographs get read decades later</summary>

Every record carries an ML-DSA-65 signature over the same commitment as the ECDSA one. It signs
the record's canonical JSON, which contains the digest of the media — so a future break of P-256
still leaves a signature nobody can forge standing between the file and the bytes it claims to
be. The key is committed inside that same signed payload, which is what makes a stripped layer
visible: the commitment cannot be removed without breaking the classical signature.

It is a bank vault door on a garden shed, and worth fitting anyway. The elliptic-curve signature
is nowhere near the weakest thing here, and anyone with a quantum computer would still find it
easier to point a camera at a screen. But the cost is a few kilobytes and a library that already
exists, and a photograph taken this week might be read in a hearing or an archive in twenty
years — by which time the signature protecting it could be the one part that has quietly stopped
meaning anything. Nobody gets to re-sign the archive later. [pq.ts](https://github.com/noah-pi/sourcekit-open/blob/main/src/lib/pq.ts)

</details>

<details>
<summary><b>Works without a network</b> — sealing and verifying both, with the radio off</summary>

No accounts, no analytics, no launch-time network calls, and no registry address bundled in the
app. Three optional calls exist: a timestamp authority, a Bitcoin anchor, and an organization
directory you host. Each is named in the docs, and a capture made offline signs anyway and says
which anchors are missing.

Apple's Reference Image sends the raw image, sensor signatures and hardware identifiers to
Private Cloud Compute and returns an authenticated copy. That is a reasonable trade for most
people, and not available to someone who cannot afford to be seen talking to a server.
[NETWORK.md](https://github.com/noah-pi/sourcekit-open/blob/main/docs/NETWORK.md)

</details>

## The danger in a permanent record of everything

A file that can prove where it came from can also prove where you were.

A wedding photographer wants every field filled in. A photographer at a protest wants the frame
and nothing else, because the GPS fix that corroborates a story for a picture desk also places a
named person at a named corner on a named afternoon. There is no setting that is right for both,
so the choice gets made twice: once at the shutter, and again at export.

Both are the same mechanism. Every field is committed under its own salt into a Merkle tree, and
the signature covers the root rather than the values — which is what makes three states
distinguishable to a verifier instead of a matter of trust. A field can be **disclosed**,
present and checkable. It can be **withheld**: committed at capture, absent from the file, with
no ciphertext for anyone to attack later. Or it can be **never-recorded**, declared at capture
and bound into the root, so the file carries proof that the sensor was off.

That last state is the one that matters under pressure. A file with the location redacted
invites the question of what was removed and why. A file that never recorded a location can
demonstrate as much to anyone who asks, cryptographically, without asking to be believed. And a
field withheld today can be revealed years later and still verify against the original signature
— or the seed can be destroyed, and it becomes permanently underivable by anyone, including me.

## Things I have not built yet

- **Android.** StrongBox gets closer to the sensor than the Secure Enclave allows, and the
platform exposes sensors iOS keeps to itself — raw barometric pressure, per-frame camera
timestamps, a real multi-camera API. Anything committed there would be stronger than the same
claim made here.
- **LiDAR.** Pro iPhones ship a depth scanner and nothing uses it for provenance. A sealed depth
map answers the flat-screen question directly rather than inferring it from disparity, and it
works in the dark.
- **Altitude against terrain.** Every capture already seals a barometric altitude, and nothing
  checks it against the ground elevation of the coordinate it claims. A GPS spoofer does not
  reach the barometer, so the two disagree by however far the lie moved you. Arithmetic rather
  than image interpretation.
- **Wi-Fi networks against a public location database.** The network the phone was joined to is
  already sealed, and access point identifiers are broadly mapped by public wardriving projects.
  A sealed network four thousand miles from the sealed coordinate is a contradiction in plain
  sight. Today it is a lead a desk follows by hand.
- **Authenticated satellite positioning.** Galileo began signing its navigation messages in 2025,
  making a position something a receiver can check rather than merely believe. Phones do not
  expose that to apps yet, and iOS hands over a finished coordinate with none of the raw material
  behind it. Waiting on the platform, not on the idea.
- **Optional face blurring that survives the signature.** A redaction committed at capture — the
blur applied before signing, the original never written — would let someone publish a crowd
without publishing the crowd's faces. The Guardian Project and WITNESS worked this out years ago
in [ObscuraCam](https://guardianproject.info/apps/org.witness.sscphase1/), which finds faces
automatically, lets you obscure them, and strips the metadata on the way out. The concept is
theirs and it is the right one; what a signature adds is that the obscured version becomes the
original rather than a copy of it. Their [ProofMode](https://proofmode.org) remains the option to
reach for on iOS today — fully C2PA-compliant, in the field with the people who need it, and the
project this one keeps learning from.
- **Asking the scene a question.** Every check here reads what the camera happened to see.
Firing the flash in a pattern the phone picks at the shutter — seeded from the beacon nonce, so
it cannot be known in advance — turns that around. A real scene answers with inverse-square
falloff: near surfaces brighten hard, far ones barely at all, and the shading follows the
geometry the depth map already commits. A display answers with a specular hotspot and little
else, because it has no depth to fall off through. Sealing the pattern beside the frames makes
the answer checkable. Beating it means relighting a three-dimensional scene in real time against
a sequence nobody could have known, which is a harder problem than holding up a screen. It
reaches only as far as the flash does, only works in light the flash can compete with, and the
shutter visibly flickers — so it belongs behind a toggle, for the captures that will be argued
over.
- **More ways to catch rephotography.** Moiré from a display's pixel grid, the refresh beat of a
panel against a rolling shutter, the polarization signature of an LCD.
- **PRNU checks.** Every sensor leaves a fixed noise fingerprint. The useful signals are blunt
ones: a frame carrying *two* fingerprints has been composited from two cameras, and a frame
carrying *none* never came off a sensor at all. Neither needs a reference corpus to flag.
- **Soft binding, and formats that outlive the file.** The perceptual fingerprint is already
committed. What is missing is somewhere to look it up.

## Limits

- **Two checks aren't performed:** TSA root anchoring and certificate revocation. Both
  are named on every verification rather than skipped quietly.
- **Sensors are claims.** Time, GPS, heading, altitude are what the device reported,
  bound into the signature. The binding is real; whether the device told the truth is a
  separate question.
- **No conformance certification.** Files carry standard C2PA manifests and `c2patool`
  reads them on every CI run, but nothing here has been through the conformance program.
- **Beta software, written by one person with AI assistance**, and held to account by the
  test lab, an independent reference verifier and the differential oracle — see
  [`docs/PROVENANCE.md`](docs/PROVENANCE.md). Don't keep your only copy of anything
  important in it, and please don't stake anything serious on it without reading the code
  yourself.

## Building it

If you just want to use it, the beta is on
[TestFlight](https://testflight.apple.com/join/cRuRw2MN). Free, no account, and no flow sends
capture bytes off the device.

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
[Recovery](docs/RECOVERY.md) ·
[Provenance](docs/PROVENANCE.md)

## Acknowledgements

This was built on other people's work, and in a few cases on other people's example.

- **[ProofMode](https://proofmode.org), by the Guardian Project.** The first tool I saw
  that treated a phone as an evidence device and shipped it to the people who actually
  needed it, and still the one to reach for on iOS today — fully C2PA-compliant and in
  real use. Their [ObscuraCam](https://guardianproject.info/apps/org.witness.sscphase1/),
  built with WITNESS, worked out obscuring faces at capture long before I thought about
  it. Source Kit takes a different approach, but the question it is answering is
  ProofMode's question.
- **The [C2PA](https://c2pa.org) specification and its conformance test suite.** An open
  standard meant it was possible to write a camera that anything else can read, and the
  public test material set the bar for what a verifier has to survive.
- **Adobe and the Content Authenticity Initiative**, for
  [c2patool and c2pa-rs](https://github.com/contentauth/c2pa-rs). Every CI run reads this
  project's output with c2patool, so an independent implementation gets a vote on whether
  the files are correct. Being able to check yourself against someone else's verifier is
  worth more than any test I could write alone.

Also [Paul Miller](https://paulmillr.com/noble/), whose @noble libraries do the
cryptography here.

## Disclaimer

This is a personal project. It is not affiliated with or endorsed by my employer. I work
at Google Cloud; nothing here represents Google's views, and everything in this
repository is my own opinion.

## License

Apache-2.0 ([LICENSE](LICENSE), with [NOTICE](NOTICE) for attribution that travels).
Apache-2.0 covers the code, not the name — fork it, ship it under your own name.

If you build something with this, or find something I got wrong, I'd really like to hear
about it.

— Noah Bassetti-Blum
