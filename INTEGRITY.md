# What we will not build, and why

The Reader's contract is short: **the camera commits, it never concludes.**
Every check that ships is a measurement with a stated error bound — the
per-signal bounds live in [`docs/INTEGRITY.md`](docs/INTEGRITY.md). Anything
that cannot meet that bar does not ship, however impressive it looks in a
demo.

This file records the analyses we examined and rejected on principle. A
rejection belongs on the record: a check that is silently absent looks like
an oversight, and a future contributor will re-propose it. A check that is
refused, with reasons, is a design decision the reader can weigh.

None of this claims more than it should: forging a sealed exhibit is
exceptionally hard, and it stays that way because the record is checkable.
What this file claims is narrower — these seven methods cannot say what
they would need to say to stand beside the ones that ship.

## The seven rejections

1. **Error level analysis (ELA).** Re-saves a JPEG and reads the resave
   error as a tamper map. Its own author discredits it as a forensic
   method: the pattern tracks save history, not edit history, and one
   re-save flattens it. A heat map that glows on command is theatre, not
   measurement.

2. **AI-detector classifiers.** A model that reports "87% AI-generated"
   emits an unverifiable probability in verdict clothing. The number cannot
   be re-derived by the reader, drifts with the training distribution, and
   fails silently on generators the model has never seen. We will not print
   a confidence figure we cannot bound.

3. **Any fused score.** Collapsing independent signals into one number
   discards the only thing that makes them checkable — their disagreement.
   A fused score is a verdict wearing a lab coat. Instead: **the agreement
   matrix is the summary.** Every pair of signals is shown as agree,
   disagree, or unmeasured; the reader sees the structure, not a number
   that hides it.

4. **Reverse image search as a finding.** A match is a lead, never
   evidence — it means "a person should look at this," not "this file is
   derivative." It also breaks the privacy model: it requires sending media
   off the device, which is why the Google Vision lookup was removed in
. Instead: pHash matches are computed against local material and
   surface as **LEADS a human must pursue, never as findings** (see
   `docs/RECOVERY.md`).

5. **Metadata-statistical scoring.** Flagging a file because its metadata
   is unusual for the population — photos at 3 AM are rare, this lens
   pairing is uncommon — confuses a prior with a measurement. Population
   statistics are not measurements of this file; the distribution of honest
   captures contains every outlier such a score would flag.

6. **LensFun lens profiles.** LensFun ships per-model average distortion
   profiles. Apple hands us the per-device, factory-measured distortion
   LUT for the actual unit in the reader's hand. A model average is
   strictly worse than a factory measurement, so the desk corrects with
   Apple's per-device LUT and no second source is offered.

7. **Face/subject-detection metadata.** Recording who was in frame, or how
   many, is a privacy hazard in exactly the population we build for —
   sources, bystanders, protesters. It also earns nothing the pixels don't
   already carry: a desk that needs a face count can count faces in the
   media it holds. A claim we would have to redact out of every share mode
   is a claim we do not record.

## The standing rule

Anything new must clear the same bar, stated before it ships: **the
prediction the check makes, the measurement it performs, the gap between
them, and the error bound on that gap.** A check that cannot state all
four does not enter the Reader. A check that could not run on a given file
renders as a card saying so, never as an absence — an unrun check is a
fact about the examination, not silence. And nothing fuses into a single
number: signals stand side by side, disagreements visible, and the
conclusion, if there is one, belongs to the person reading — not to this
software.
