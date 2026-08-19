# Threat model — Source Kit 

Who attacks this system, what we assume, what happens in each scenario, and
what we consciously accept. Every scenario gets
its honest status — **defended (lab-tested)**, **defended (by design)**,
**partial (stated honestly)**, **accepted risk**, or **out of scope** — and
"accepted" is always said out loud in the product, never buried here only.

Related: `SECURITY.md` (cryptographic design and threat cases), `INTEGRITY.md` (per-signal
bounds), `NETWORK.md` (every network event), `DECISIONS.md` (why the engine
is built the way it is).

## Named adversaries

- **The fabricator** — wants to create media that *reads as verified* without
  a genuine capture: forged manifests, transplanted credentials, forged
  certificates, forged rosters, forged timestamp tokens.
- **The tamperer** — takes a genuinely signed file and changes it: pixels,
  metadata, manifest surgery, truncation.
- **The impersonator** — wants one device's (or one person's) signatures to
  be read as another's: key substitution, fingerprint confusion, roster
  forgery, identity-assertion inconsistency.
- **The discrediter** — doesn't forge anything; attacks the *meaning* of
  verification in front of an audience: screenshot-the-green,
  strip-and-discredit, tamper-to-red, the liar's dividend ("that damning
  video could be fake — anything can be faked").
- **The surveillor** — wants identifying details: vault contents, shared
  copies that still leak PII, network observation.
- **The coercer** — compels the user directly: device seizure, forced
  unlock, forced check-ins, legal compulsion of infrastructure providers.
- **The cross-examiner** — the adversary the
  first five get *presented to*: opposing counsel, a hostile editor, a
  fact-checker's comment section. Forges nothing; attacks the *weight* of
  the evidence in front of a decision-maker. "The app signs its own
  telemetry — self-reported." "The framing bytes are malleable." "The phone
  was online; anything could have happened." "A screen replay defeats the
  sensors." This adversary is why every claim in the UI and these docs must
  be literally true with its error bounds attached: the design goal is not
  that the exhibit is unattackable (nothing is), but that every attack the
  cross-examiner raises is one we have already stated, precisely, first.
  Consequence for the queue: seal-queue drafts are plaintext in the app
  container for minutes — a subpoena of the device sees them, and
  docs/SECURITY.md says so rather than letting counsel discover it.
- **The AI-assisted attacker** — any of the above, aided by frontier AI
  models with **full knowledge of this codebase and its design docs**. This
  is a stated assumption, not a scenario: see its own section below.

## Assumptions

1. The Secure Enclave does what Apple documents: non-extractable keys, on-chip
   signing. The silicon can't be inspected from here; this is an assumption.
2. The iOS sandbox and Data Protection work as documented against
   non-privileged attackers.
3. Apple's App Attest root key is honest **at verification time** — see the
   Apple paragraph below for the compulsion case.
4. The user's device was not compromised *before* enrollment of its keys.
5. Humans confirm roster editor fingerprints and device fingerprints out of
   band when the stakes matter. Every surface that displays a fingerprint
   says to. If they skip this, identity rungs degrade to "unknown" — the UI
   shows exactly that, never a false green.
6. Public infrastructure (RFC 3161 TSAs, OpenTimestamps calendars, the
   Bitcoin network) is *available* but not necessarily *honest* — see
   scenarios 14–17.

## Where the signature sits

Every serious implementation protects the signing key in hardware. Source Kit
uses the Secure Enclave; the Pixel 10 uses Titan M2 through Android StrongBox;
Snapdragon devices use Qualcomm's TEE. Extracting the key is very hard in all
three cases, and that is not where they differ.

What differs is how much untrusted code touches the pixels before they reach
the signer.

| | Path from sensor to signature | What can interfere |
|---|---|---|
| Source Kit | sensor → kernel → AVFoundation → **the app's own process** → Enclave signs | anything with code execution in that process |
| Pixel 10 | sensor → image signal pipeline in Tensor G5 → Titan M2 signs | nothing in Android userspace |
| Snapdragon | sensor → TEE → TEE signs | nothing in Android userspace |

Source Kit signs in userspace. On a jailbroken device, an attacker can attach a
dynamic instrumentation tool, hook the path before the Enclave call, hand it
pixels of their choosing and get a valid signature. Apple does not expose
jailbreak status to apps, so this cannot be reliably detected from inside. On a
Pixel the equivalent attack means compromising the ISP or the Titan M2 — a
different order of difficulty.

**This is a real gap and it should be said plainly: in-pipeline hardware signing
is a genuine achievement, and it is better than what any third-party app on iOS
can do.** Google shipped signing inside the imaging pipeline with hardware-held
keys, per-image certificates and an on-device timestamp authority. Qualcomm put
a C2PA signer in the TEE. That closes the injection problem properly, in a way
no application-layer design can.

What the emulated key attestation still buys, and it is not nothing: an attacker
cannot take a genuine device's attestation and bind it to a key they control,
because the nonce covers `SHA256(challenge ‖ signingPublicKey)`. The attack is
therefore per-device — someone must compromise a real device running a real
build — rather than a break of the scheme. For iPhones today, and for the very
large number of Android devices that will never get in-pipeline signing, this
is about as far as an app can go.

### What the gap closing means

Two things do not improve when signing moves into the silicon.

**Rephotography.** Point any camera, hardware-signed or not, at a good monitor.
Every guarantee holds. The sensor really did see those photons. No amount of
key protection touches this, and as injection gets harder it becomes the main
road in.

**Spoofable assertions.** A signature binds the sensor readings into the file;
it does not make them true. Civilian GNSS is unauthenticated, spoofers are
commodity hardware, and a phone will report a confidently wrong position with no
idea anything is wrong. The same goes for the system clock and any
network-derived location. In-pipeline signing does not help here either — it
signs the false claim just as faithfully.

The Nikon Z6 III case is the proof that hardware custody is not the whole story.
That implementation was hardware-rooted, and Multiple Exposure mode still let a
researcher get the camera to sign an AI-generated image. The signature was
valid. The abuse happened upstream of the signing step, inside the trusted
pipeline.

So the work this project can usefully do sits in those two places, and the
approach is the same for both: rather than trying to detect a forgery, raise
what a spoofer has to keep consistent, and present the result so that a person
can judge it quickly and reasonably. Committing a second lens means the geometry
has to hold. Committing a motion trace means the movement has to match the
frames. Committing time and place means the shadows have to fall where the sun
actually put them. None of these is a verdict, and any one of them can be
defeated by someone who knows it is there. Together they turn a prompt into a
physical production that has to survive a reader looking at it for four seconds.

That is the design goal, stated plainly: not detection, but enough clearly
presented evidence that ordinary human judgment gets traction.

## The AI-assisted attacker (design assumption, noah-pi directive Aug 2026)

We assume the person attacking this app is aided by frontier AI models with
complete knowledge of this codebase, these docs, and every comment in the
source. Three consequences shape the whole design:

**(a) No guarantee may rest on attacker inconvenience, obscurity, or the
effort of reverse-engineering.** All detection logic is public and patchable.
Jailbreak path indicators, integrity heuristics, and anti-instrumentation
checks are priced honestly as *speed bumps against commodity tooling only*.
Against an AI-assisted attacker who can read the exact check and patch around
it, they are noise. They are therefore **never** load-bearing: no rung of the
trust ladder, no verdict, no green state depends on one.

**(b) The durable guarantees are ONLY the cryptographic ones that hold
independent of device honesty.** Signature math (an edited byte fails the
hash no matter how smart the attacker), time-anchoring (an RFC 3161 token or
Bitcoin binding verified against independent infrastructure), roster
revocation semantics (a signed roster resolves the same way for everyone),
and content analysis run elsewhere (a different machine, a different trust
domain). An AI that has read all of this repo cannot talk its way past
modular arithmetic.

**(c) Every on-device signal is evidence a person weighs — never a gate,
never a verdict.** Sensors, pose trace, timing regularity, device-integrity
self-reports, even enclave-backed claims when the enrolled device itself may
be compromised: all are *commitment under signature*, all are displayed with
their bounds attached, and none can produce or upgrade a green state. This
display invariant is what keeps an AI-assisted forgery from ever becoming a
false green: the forgery can be perfect, and the UI still says only what the
math proves. The attacker wins nothing by being clever — the surface never
claimed the thing they faked.

## The Apple paragraph (read before trusting rung 4)

Apple is the hardware root of every hardware-backed claim this app makes:
the Secure Enclave, App Attest, the pinned attestation root that ships in
the binary. Apple is a single, compellable point. A state actor with legal
or extralegal leverage over Apple could, in principle, obtain attestation
certificates for non-genuine devices or builds — and the offline verifier
would accept them, because its anchor *is* Apple's root. **Nothing in this
system addresses that, and we say so.** What partial mitigation exists is
structural, not cryptographic: hardware attestation is one rung of five,
never a gate; a forged attestation upgrades at most rung 4 and cannot repair
a broken hash, a wrong fingerprint, or a missing time anchor; and every
surface that displays attestation displays the four rungs it does *not*
cover beside it.

## The 25 scenarios

### A. Forgery & tamper

**1. Pixel/content edit after signing.** Any byte of the media changes → the
asset hash in the signed claim no longer matches → rung 1 failed, CONTENT
MODIFIED, red text and broken rail. *Defended (lab-tested — test-verification,
test-roundtrip).*

**2. Manifest transplant onto different media.** The credentials block is
copied byte-perfect onto a different photo → the hash covers the media, not
the container → fails exactly as scenario 1. *Defended (lab-tested — the
 red team's core attack, a permanent regression test).*

**3. Claim/metadata/manifest surgery.** Editing an assertion inside the
manifest (byline, timestamps, telemetry) invalidates the COSE signature over
the claim → credentials fail, and because credentials carry every rung above
integrity, rungs 2–5 show *cannot be evaluated* — never a partial green.
*Defended (lab-tested).*

**4. Signature malleability (high-S).** All signing paths normalize to low-S;
verifiers reject non-canonical signatures. *Defended (lab-tested).*

**5. Truncation and trailing garbage.** Short files, cut streams, bytes after
IEND → parse or hash failure, FAILED verdict, never a wedge: the DER-walker
invariant means a non-advancing parser throws. *Defended (lab-tested —
including the randomized fuzz over every DER walker).*

**6. Multi-manifest store confusion.** A file carrying several manifests (the
C2PA update-chain rule says the *last* is active) → Source Kit verifies the
active one and states that the earlier ones were not evaluated. Two verifiers
no longer produce two verdicts. *Defended (lab-tested since).*

**7. Credential stripping.** Anyone can delete the manifest from a file.
What remains is an ordinary unsigned file → the neutral card: "No signature
found — this means nothing either way." Absence is never rendered as
suspicion, and a stripped file can never be passed off *as verified*.
*Defended (by design — the inverse attacks live in scenario 25).*

### B. Identity & impersonation

**8. Forged self-issued "organization" certificate.** A self-made
`O=Reuters` cert → rejected at import (the chain verifier runs at the door);
in a file it verifies as a *self-asserted root* and is displayed as exactly
that — rung 2 at most, with the out-of-band caveat, never rung 3.
*Defended (lab-tested).*

**9. Org-assertion inconsistency.** The manifest's org identity assertion and
its certificate chain disagree (org assertion names one org, chain top names
another, or the telemetry hash doesn't match) → the verifier reports FAILED
on binding mismatch, or a loud MISMATCH naming both — never silently picks
one. If the cross-check can't run, the org is reported *unproven*, never
vouched. *Defended (lab-tested — test-identity, W7.2).*

**10. Junk certificate chains.** Random certs stuffed into x5chain → link
verification fails, the chain state is displayed as broken, and a broken
chain cannot produce green. A *valid* chain to a self-asserted root says so.
*Defended (lab-tested).*

**11. Fingerprint grinding and the stranger-trust ritual.** An attacker
grinds a key whose fingerprint shares an 8-hex prefix with a victim's, or
social-engineers their way onto a manual "trusted" list → there is no manual
list (removed in: the ritual was the attack surface), and identity
surfaces show the full 64-character fingerprint for out-of-band comparison.
*Defended (by design).*

**12. Forged roster / unknown editor key.** A roster is only as good as its
editor signature, and the editor fingerprint must be confirmed out of band —
the import flow instructs exactly that. A forged roster signed by an unknown
key installs, but it *vouches for nothing the user has any reason to believe*;
the trust decision happened at confirmation, not at import. *Partial (stated
honestly — the human step is the control, and the UI says so).*

**13. Roster rollback.** An attacker hands a verifier a stale roster (before
a revocation). The roster is genuinely signed, so it verifies — and the
capture resolves by *that* roster's contents. The deployed mitigation is
semantics, not versioning: revocations are dated, a capture signed before
the revocation stays *active-then-revoked* (genuine), and the practice is to
re-issue and redistribute rosters on every edit. A monotonic version counter
would close this properly and isn't built. *Partial (stated honestly).*

### C. Time

**14. Device-clock backdating.** The capture timestamp is the device clock
and is always labeled "device-reported". It can be set to anything — which is
why it is never a rung. Rung 5 requires an independent anchor.
*Defended (by design).*

**15. Forged RFC 3161 token.** Tokens are cryptographically verified
on-device (messageImprint binding, CMS over correctly re-tagged signedAttrs,
chain links, validity at genTime) → junk tokens read *invalid*, and an
invalid token is a failed rung, not an unreached one. *Defended (lab-tested —
genuine openssl fixtures).*

**16. Malicious or compromised custom TSA.** The user can pin their own TSA
pool. A malicious TSA can sign any genTime it likes — the token verifies
against *its* key, and the display says the trust is the TSA's reputation.
TSA chains are not anchored to a curated trust list (no mature public TSA
root store exists); revocation is not consulted. Both are listed under "not
checked" on every verification. *Accepted risk (stated in-product).*

**17. Anchoring delays and withheld confirmations (OTS).** Calendars are
public and free; confirmation takes ~2 hours and can be delayed or withheld
→ pending and queued states are shown honestly, an unconfirmed binding is
rung-5 *unreached* (never failed, never reached), and a *confirmed* binding
is only counted when the Bitcoin binding itself verifies. *Accepted risk
(stated in-product).*

### D. Hardware & platform

**18. Secure Enclave key extraction.** Out of scope — we assume the silicon
(assumption 1). What we control is honest labeling: the key-storage backend
is displayed per record, and the software fallback says "software".
*Out of scope (assumed hardware).*

**19. Forged or replayed App Attest.** Forged: full offline verification —
chain to the pinned Apple root, rpIdHash bound to this app, Apple's nonce
extension recomputed against exactly the manifest's signing key → FAILED.
Replayed: single-use 5-minute challenges, checked server-side; the Apple
root is pinned in the binary, never fetched at runtime. *Defended
(lab-tested — forged-attestation fixtures are permanent regression tests).*

**20. Compromised enrolled device (genuine key, dishonest device).** The
hardest case this side of the Enclave, and the one the userspace signing path
above makes possible: a jailbroken device with its own key can sign fabricated
pixels, fabricated sensor traces, fabricated timing and a fabricated clean
integrity report — all *validly signed*. Every one of those signals is
therefore displayed as self-reported commitment, with "a compromised device
can lie about being compromised" attached; none is a gate; the
anti-instrumentation checks that exist are priced as speed bumps (see the
AI-attacker section). Device-integrity *path indicators* are signed as
claims; they never downgrade a verdict either. *Accepted risk (stated in
product — this is the scenario the display invariant exists for).*

**21. Compelled Apple.** See the Apple paragraph above. A coerced or
compromised attestation root can mint rung-4 evidence for non-genuine
hardware. It cannot mint rungs 1–3 or 5, and no surface lets rung 4 stand
for them. *Accepted risk (out of scope to fix, in scope to say).*

### E. Privacy & coercion

**22. Vault extraction from a seized device.** Vault media, records, and the
seal queue are AES-256-GCM under a keychain-held key
(`WHEN_UNLOCKED_THIS_DEVICE_ONLY`), plus iOS Data Protection; the app
passcode adds an escalating lockout. Against forensic extraction of an
unlocked device, or compelled biometrics, protection degrades to whatever
iOS provides — the passcode locks the door, it is not the key (the app says
exactly this). *Partial (stated honestly).*

**23. De-identified-copy leakage.** Sharing strips byline, location, Wi-Fi,
sensors, transcript, and device identity, re-signs as a fresh de-identified
identity, and the copy *says* it is de-identified and which fields were
removed. EXIF survival is a permanent regression test (segment stripper;
pixels byte-identical). Face regions are never
persisted, never signed, and never leave the redaction path. *Defended
(lab-tested — test-bmff-deid, roundtrip de-id suites).*

**24. Network observation.** Timestamps, OTS submissions, and attestation
all touch the network — and nothing in this product
hides that a network event happened. Submissions are hashes, never media;
there is no Tor, no domain fronting, no anonymity claim anywhere. *Accepted
risk (stated in product — NETWORK.md enumerates every event).*

**25. Reader-layer attacks (the discrediter's toolkit).**
Screenshot-the-green (a photo of a green verdict, recirculated after the
file is tampered), tamper-to-red (deliberately corrupting a genuine file to
produce a scary verdict), strip-and-discredit, and the liar's dividend.
These attack *readers*, not cryptography, and no code can fix them. The
defense is claim discipline, engineered: green means only "these bytes are
unchanged since this key signed them"; red means only "these bytes changed";
unsigned means nothing either way; the ladder card carries its own title and
limits sentence so a cropped screenshot still tells the truth; and the full
report lists what was *not* checked on every verdict. *Defended (by design —
the defense is the copy, and the copy is tested).*

## Out of scope (named, not implied)

Scene authenticity (no software can check what the camera was pointed at —
AI-generated or staged content signed by a genuine device is *validly
signed*, and the app never calls content real); Secure Enclave extraction;
compelled platform vendors beyond the paragraph above; anonymity/traffic
analysis resistance; soft-binding watermarks (noted, outside scope); ENF
analysis beyond capture; face search; automated parallax/depth verdicts.

## The one-sentence version

A valid signature proves custody of bytes — integrity, a signing key, and
(optionally) hardware and time anchors — and every surface in this product
says exactly that much and never more, because the attacker we designed for
has read this file too.
