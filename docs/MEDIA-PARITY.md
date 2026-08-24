# Media parity — the named exceptions

The parity principle: the SAME assertion set is emitted for
photo, video, and audio captures — `com.verify.streamedChunks`,
`com.verify.contextTree`, `com.verify.poseTrace`, `com.verify.captureIntegrity` —
with the same schema and the same verification math. Anything that diverges by
media kind outside the list below is a bug.

This document is the canonical exception list —
the exceptions must exist in docs, not only in code comments. The emission
sites (src/provenance/manifest.ts, src/provenance/attest.ts) name the same
list and point here.

## Stills (photo)

- **No ENF trace.** No ambient-audio track is recorded for a still, so there
  is no mains-hum signal to extract.
- **No streamed chunks beyond the still's own track semantics as
  implemented.** A JPEG has no elementary streams; the v2 streamedChunks
  assertion is emitted with **zero tracks** — a structural fact stated in the
  assertion's note, never an absent assertion
  (`buildStreamedChunksV2ForStill` in src/provenance/trackChunks.ts).
  Whole-file integrity is the `c2pa.hash.data` hard binding.
- **No A/V desync.** A single elementary medium has no inter-track clock to
  drift.

## Audio

- **No ring-buffer frames.** The ring buffer is a stills sink; audio
  recordings have no frame ring to commit.
- **No A/V desync.** A single-track medium has no second stream to desync
  against.
- **poseTrace is present whenever the device provides motion data.** The
  audio recorder runs a gyro IMU sink during every take
  (modules/audio-capture: CoreMotion at a 100 Hz target, CaptureKit
  SensorLogger JSONL line format, anchor line first, covering exactly the
  recorded window). The seal commits the trimmed line bytes under the same
  `com.verify.poseTrace` Merkle assertion as video, with
  `gyroPriorAuthenticated: false` locked — the device's motion claims
  remain self-reported. The assertion is missing only when the device could
  not provide motion data (no gyro
  hardware, or the capture-evidence sensors toggle off) or the sink
  failed — and the exhibit record's three-state
  `captureEvidence.sensorLogPath` (path / enabled-but-failed `null` /
  `'never-recorded'`) states exactly which case it is. The declared sample
  rate is measured from the trace's own intervals, never from the 100 Hz
  target.
- **Signed by this app's own builder.** Photos and videos are signed by
  c2pa-swift; audio is signed by the COSE/JUMBF builder in archive/handrolled-verifier. The
  assertion set, the schema and the verification math are identical either
  way — the divergence is which code writes the container.

## Video

No exceptions — video is the reference implementation of the full set.
