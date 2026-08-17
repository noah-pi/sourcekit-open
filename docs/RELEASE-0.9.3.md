# 0.9.3 — capture integrity (the parallax shutter)

Signals that bound what happened between the shutter and the signature.
Every one is self-reported by the device and signed into the record — the
rule, stated everywhere they appear: **commitment, not detection**. See
`docs/INTEGRITY.md` for the full "what this misses" list.

## The 1-second proof clip

A third camera mode: CLIP. One tap records exactly one second. Natural
hand movement over a real 3D scene produces parallax — near detail shifts
against far detail; a photo of a screen does not. The clip and its motion
telemetry window are signed evidence.

The design is deliberately honest about who judges: **review is done by a
person.** There is no "parallax verified" badge and there won't be until
automated analysis (homography residual) exists and earns it. The camera
hint, the attestation view, and the docs all say so. A static scene
legitimately shows no parallax; a video replay can fake it — both are in
the documented limits.

## Signed capture-integrity signals (all capture types)

- `captureToSignatureMs` — the shutter→signature gap, signed. Bytes altered
  between capture and seal live in this gap, so the gap is bounded and
  bound.
- `sensorTiming.intervalCv` — regularity of the raw sensor-frame feed
  during capture. Synthetic feeds are too regular or too bursty; a bounded
  consistency signal, deliberately never rendered as a verdict.
- `proofClip` — marks deliberate 1-second clips in the record.

## Desk-side heuristics, assigned honestly

Moiré, specular/flat-field, and focus-consistency checks need pixel access
the phone doesn't spend at capture time; they are desk-tool features
(0.9.4), each with its own bounded-signal framing. LiDAR depth is designed
but not shipped — hardware code that can't be device-validated doesn't
ship; `docs/INTEGRITY.md` carries the status, not a promise.

## Repo boundary note

`src/sensors/motion.ts` (pure sample analysis — no device APIs) is now
public; the sensor-collection glue stays app-side. This keeps the desk
tool and the engine-swap oracle able to evaluate the same signals.

## Verification

59 checks in `test-verification` (56 prior + 3 timing), corpus 11/11
including a sealed proof clip verifying INTACT with its flag signed into
the record, `tsc --noEmit` clean.
