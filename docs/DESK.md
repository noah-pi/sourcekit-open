# Exhibit — the newsroom verification tool

Exhibit is the second half of the trust model: the camera proves custody
at capture, the desk checks custody at the newsroom. It is a local web app
(`desk/` in this repo) that runs **entirely in the browser tab that opens
it** — no server, no upload, no accounts, no analytics. The only network
call it can make at all is an explicitly opt-in Bitcoin block-header check
(Trust tab), and the UI states at all times whether the desk is offline.

```
cd desk
npm install
npm run dev      # or: npm run build && npm run preview
```

## The CLI

The same shared core, scriptable — for batch intake, conformance runs, and
reports that travel:

```
cd desk
npm install
npm run cli -- <paths...> [options]
    --trust roster.json    trust list (repeatable; an invalid roster is
                           REFUSED loudly, never silently ignored)
    --online               bind OTS receipts to Bitcoin block headers
                           (default offline; the report says which ran)
    --json out.json        machine-readable report
    --sign                 sign the JSON with this desk's software key
                           (~/ .exhibit-desk — proves the REPORT's custody,
                           never the truth of any capture)
    --pdf out.pdf          human-readable rendering of the same report
    --corpus labels.csv    regression mode: per-file verdicts + rephoto
                           signal distributions by class (characterization,
                           not thresholds — thresholds wait for the ROC)
```

The CLI rasterizes with ffmpeg (photo pHash/rephoto, video IMU↔flow) and
feeds the SAME shared DSP the browser desk uses — parity by construction;
if ffmpeg is absent the measurements are reported "not performed", never
faked. The same display invariants hold: unsigned is neutral, every sensor
signal is evidence for a person, pHash matches are leads, "custody, not
reality" is printed in every report.

## One implementation, two hosts

The desk does not re-implement verification. It imports the same source
tree the app ships (`@verify` → `../src`), so a file the app calls INTACT
is a file the desk calls INTACT, byte for byte. If the two ever disagree,
that is a bug — report it, don't adjudicate it.

## What a dossier shows

Drop any mix of photos, clips, proof bundles, and hash claims onto the
intake. Each gets a dossier:

- **Verdict banner** — with the display invariants the app enforces:
  unsigned files are *neutral* (absence of proof is not evidence of
  fraud); tampered files are red; and **valid-but-untrusted is never
  green** — green requires integrity *and* a signer on a trusted roster.
- **Who signed it** — trust tier *and* its basis, always together. A tier
  without its reason would be a claim, and this tool doesn't make claims
  it can't support. Byline text is shown as "claimed, not verified".
- **Time — three separate claims, never merged**: device clock (a claim),
  authority time (RFC 3161 tokens, cryptographically verified), ledger
  time (Bitcoin via OpenTimestamps, with binding state: verified / failed /
  unchecked — all three stated plainly).
- **Checks performed / checks NOT performed** — the absence of a check is
  disclosed, never hidden.
- **Capture-integrity signals** — self-reported, labelled as such.
- **Proof ↔ media recovery** — two grades, never merged (docs/RECOVERY.md):
  exact SHA-256 matches are certain; pHash matches are *leads* ("confirm
  visually"), never verdicts. Hash-only claims are exact-match only by
  construction — if the media was re-encoded in transit, the desk says it
  can never match rather than approximating.
- **"How we know this" export** — a standalone HTML file stating every
  check, every non-check, and the basis of every trust statement. Attach
  it to the story's methodology note or the evidence archive.

## Trust configuration

- **Trusted rosters** — a roster enters the list only if its editor
  signature verifies. Membership is evaluated at each capture's *verified*
  signing time, never at "now": the departed photographer's past captures
  stay genuine, and a capture signed *after* a revocation is a red flag,
  surfaced as one.
- **Online checks** — off by default. When on, confirmed OTS receipts are
  bound to Bitcoin block headers fetched from mempool.space (which learns
  that someone asked about a block height, nothing more). When off,
  confirmed receipts display "binding unchecked" — an honest state.
- **pHash thresholds** — likely ≤ 6, possible ≤ 10 by default. Tuning
  parameters, stated as such, not science.

Trusted rosters and thresholds persist in the browser's local storage
only. Dossiers are session-only. Editor private keys are never persisted
anywhere — the roster editor holds them in memory for the duration of an
edit, and says so.

## The roster editor (newsroom side)

The Roster editor tab creates and maintains `verify-roster/1` documents:

- **Create** — generates a fresh P-256 editor key in the tab. The private
  key is shown **once**, never stored, never transmitted. Losing it means
  the roster can no longer be edited.
- **Add / revoke** — each edit re-signs the whole roster with a fresh
  `issuedAt`; the old signature never contaminates the new payload.
  Revocation is timestamped "as of now" — past captures stay genuine.
- **Rotate** — deliberately two explicit steps (add the new key, revoke
  the old) so nothing happens silently.
- **Export** — the roster JSON is what you distribute to desks and ingest
  into Exhibit instances. Fingerprints are 64 hex characters, never
  prefixes, and members read theirs from their own Source Kit app out of band.

## Publishing without breaking the proof

CMS pipelines are the enemy of custody: they re-compress, resize, and
strip metadata — all of which break the hash binding by design.

- **Serve the original file at full size.** On WordPress, that means
  embedding "Full Size" and understanding that every resized derivative
  is a new, unsigned file. Consider hosting originals outside the
  `uploads` processing pipeline entirely.
- **Publish the proof alongside.** Attach the proof bundle or the "how we
  know this" export to the story. If you must serve re-compressed media,
  say so — a reader with the original can still verify it; a reader with
  only the derivative gets an honest "re-encoded in transit", and a pHash
  lead if the original is also at hand.
- **Social platforms strip everything.** A platform copy is never
  evidence; recover against the original via exact hash or a visual lead.
- **Say what it proves.** "Cryptographically unchanged since capture by a
  device on our roster" — custody, not reality. The scene itself remains
  journalism's job.

## Identity claims, stated honestly

Source Kit's identity model mirrors the C2PA Creator Assertions Working Group
direction without claiming CAWG conformance: a byline is a *claim*
self-asserted by the device at capture; the roster entry is the *check* —
membership at the verified signing time under an editor key you chose to
trust. The desk never renders claimed text with the weight of a verified
fact. When a capture is de-identified, that is stated as a deliberate act
of the signer, not an absence.
