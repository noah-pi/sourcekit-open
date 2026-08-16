/**
 * WS2 Phase 2 §3: the signed gyro trace (com.verify.poseTrace).
 *
 * Source: the CaptureKit sensor JSONL (SPEC-WS1 §5.2) — one sample per
 * line, `{"t":<bootSec>,"kind":"gyro","x":..,"y":..,"z":..}` at ~100 Hz.
 * This module commits the trace under a Merkle root (reusing the
 * disclosure tree builder, so capture-side and desk-side speak one
 * Merkle language) and reports the nominal rate derived from the
 * trace's own intervals. It performs NO motion analysis and no verdicts.
 *
 * Leaf format (reproducible by any desk holding the exported trace):
 *
 *   leafDigest = SHA-256( 'pose-trace-v1' ‖ <trimmed JSONL line bytes,
 *                                             without the newline> )
 *
 * Committing the TRIMMED line BYTES (not a re-serialization) means the
 * desk's recomputation needs no canonical-JSON agreement — the exported
 * JSONL, whitespace-trimmed per line, is the commitment, byte for byte.
 *
 * HONESTY INVARIANT (locked by G1, docs/INTEGRITY.md): the assertion declares
 * `gyroPriorAuthenticated: false` — the trace is committed (existence +
 * content bound at seal) but the device's motion claims remain
 * self-reported until a hardware-attested IMU path exists.
 */

import { sha256 } from '@noble/hashes/sha256';
import { asciiToBytes, bytesToHex, concatBytes, utf8ToBytes } from '../lib/bytes';
import { buildTree } from '../disclosure/tree';
import {
  POSE_TRACE_LABEL,
  POSE_TRACE_NOTE,
  type PoseTraceAssertion,
} from './manifest';

export const POSE_TRACE_LEAF_DOMAIN = 'pose-trace-v1';

/** One parsed gyro sample (times are boot-relative seconds, rates rad/s). */
export interface GyroSample {
  t: number;
  x: number;
  y: number;
  z: number;
}

/** A gyro sample plus the exact JSONL line it was parsed from. */
export interface GyroLine {
  sample: GyroSample;
  /** The trimmed line bytes (whitespace + newline stripped) — the commitment unit. */
  line: string;
}

/**
 * Parse the gyro lines out of a CaptureKit sensor JSONL document.
 * Malformed lines are SKIPPED and counted — a truncated tail line (the
 * common case when a sink was killed mid-write) must not sink the whole
 * trace, but the skip is reported, never silent.
 */
export function parseGyroJsonl(jsonl: string): { gyro: GyroLine[]; skippedLines: number } {
  const gyro: GyroLine[] = [];
  let skippedLines = 0;
  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedLines++;
      continue;
    }
    const s = parsed as Record<string, unknown> | null;
    if (
      s && s.kind === 'gyro' &&
      typeof s.t === 'number' && typeof s.x === 'number' &&
      typeof s.y === 'number' && typeof s.z === 'number'
    ) {
      gyro.push({ sample: { t: s.t, x: s.x, y: s.y, z: s.z }, line });
    }
    // Non-gyro lines (accel/baro/loc) are not skipped — they are simply
    // not this trace. Only UNPARSEABLE lines count as skipped.
  }
  return { gyro, skippedLines };
}

/** The committed leaf digest for one trace line. */
export function poseTraceLeafDigest(line: string): Uint8Array {
  return sha256(concatBytes(asciiToBytes(POSE_TRACE_LEAF_DOMAIN), utf8ToBytes(line)));
}

/**
 * Nominal sample rate from the trace's own intervals (median Δt). Falls
 * back to the CaptureKit nominal 100 Hz for traces too short to measure —
 * stated, never measured, in that case.
 */
export function nominalHz(gyro: GyroLine[]): number {
  if (gyro.length < 3) return 100;
  const deltas: number[] = [];
  for (let i = 1; i < gyro.length; i++) {
    const d = gyro[i].sample.t - gyro[i - 1].sample.t;
    if (d > 0 && Number.isFinite(d)) deltas.push(d);
  }
  if (deltas.length === 0) return 100;
  deltas.sort((a, b) => a - b);
  const median = deltas[Math.floor(deltas.length / 2)];
  return Math.round(1 / median);
}

/**
 * Build the com.verify.poseTrace assertion over a sensor JSONL document.
 * Returns null (honest absence) when the document holds no gyro samples —
 * the assertion is never emitted empty.
 */
export function buildPoseTraceAssertion(jsonl: string): PoseTraceAssertion | null {
  const { gyro } = parseGyroJsonl(jsonl);
  if (gyro.length === 0) return null;
  const tree = buildTree(gyro.map((g) => poseTraceLeafDigest(g.line)));
  return {
    label: POSE_TRACE_LABEL,
    v: 1,
    alg: 'sha256-merkle',
    hz: nominalHz(gyro),
    sampleCount: gyro.length,
    root: tree.root,
    gyroPriorAuthenticated: false,
    note: POSE_TRACE_NOTE,
  };
}

/**
 * Verify a poseTrace assertion against a trace (the vault record's full
 * JSONL, or the proof-bundle export). Every failure is named.
 */
export function verifyPoseTraceAssertion(
  assertion: PoseTraceAssertion,
  jsonl: string
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (assertion.gyroPriorAuthenticated !== false) {
    failures.push('gyroPriorAuthenticated must be declared false — the trace is self-reported by design');
  }
  const { gyro } = parseGyroJsonl(jsonl);
  if (gyro.length !== assertion.sampleCount) {
    failures.push(
      `sampleCount mismatch: assertion declares ${assertion.sampleCount}, the trace holds ${gyro.length} gyro samples`
    );
  } else {
    const tree = buildTree(gyro.map((g) => poseTraceLeafDigest(g.line)));
    if (tree.root !== assertion.root) {
      failures.push(
        'pose-trace root mismatch: the trace does not recompute to the committed root — ' +
        'the trace was altered after seal'
      );
    }
    if (assertion.hz !== nominalHz(gyro)) {
      failures.push(`hz mismatch: assertion declares ${assertion.hz}, the trace intervals give ${nominalHz(gyro)}`);
    }
  }
  return { ok: failures.length === 0, failures };
}
