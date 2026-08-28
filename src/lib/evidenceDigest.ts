// Source Kit 0.1.0 — hashes the capture-evidence sidecars at seal time
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Evidence digests — hashes the capture-evidence sidecars at seal time.
 *
 * The C2PA seal covers the delivered media file. It does not reach the
 * sidecars a CaptureKit session writes beside it: the raw LPCM master, the
 * full-rate sensor log, and the ring-buffer frames. The record named those
 * by PATH, which says where a file was and nothing about what it held.
 *
 * That gap sat exactly where it hurts. A desk arguing about a video reaches
 * for the raw audio and the IMU log first, and those were the two things
 * nothing bound. Swapping either one left every signature valid.
 *
 * So each sink gets a digest, committed inside the signed record:
 *
 *   file sink       SHA-256 over the bytes.
 *   directory sink  SHA-256 over the listing — each file's own digest and
 *                   its name, sorted by name, hashed together. Order is
 *                   fixed by the sort, so the same directory always yields
 *                   the same digest on any device.
 *
 * Failure is stated, never guessed. A sink that reports 'never-recorded'
 * has no digest by construction; a sink whose file cannot be read yields
 * null, which a reader shows as uncommitted rather than as a mismatch.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from './bytes';
import { hashFileSha256 } from './fileHash';
import type { CaptureEvidencePaths, EvidencePath } from '../provenance/manifest';

/** A path that names a real file or directory, as opposed to a stated absence. */
function isRealPath(p: EvidencePath | undefined): p is string {
  return typeof p === 'string' && p !== 'never-recorded' && p !== '';
}

function toUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

/** SHA-256 over a single sidecar. Null when it cannot be read. */
export async function digestFile(path: EvidencePath | undefined): Promise<string | null> {
  if (!isRealPath(path)) return null;
  try {
    return (await hashFileSha256(toUri(path))).hex;
  } catch {
    return null;
  }
}

/**
 * SHA-256 over a directory's listing: `name:digest` per entry, newline
 * separated, sorted by name. Sorting is what makes this reproducible —
 * readDirectoryAsync makes no ordering promise, and an unsorted digest
 * would differ between two readers holding identical frames.
 */
export async function digestDirectory(path: EvidencePath | undefined): Promise<string | null> {
  if (!isRealPath(path)) return null;
  try {
    const dir = toUri(path);
    const names = (await FileSystem.readDirectoryAsync(dir)).slice().sort();
    if (names.length === 0) return null;
    const lines: string[] = [];
    for (const name of names) {
      const { hex } = await hashFileSha256(`${dir.replace(/\/$/, '')}/${name}`);
      lines.push(`${name}:${hex}`);
    }
    return bytesToHex(sha256(utf8ToBytes(lines.join('\n'))));
  } catch {
    return null;
  }
}

/**
 * Returns the evidence block with a digest beside every sink that produced
 * one. Never throws: a capture must seal even when a sidecar has already
 * been moved or deleted, and an absent digest is the honest report of that.
 */
export async function digestCaptureEvidence(
  evidence: CaptureEvidencePaths | null | undefined,
): Promise<CaptureEvidencePaths | null> {
  if (!evidence) return null;
  const [rawPcmSha256, sensorLogSha256, ringBufferSha256] = await Promise.all([
    digestFile(evidence.rawPcmPath),
    digestFile(evidence.sensorLogPath),
    digestDirectory(evidence.ringBufferDir),
  ]);
  return { ...evidence, rawPcmSha256, sensorLogSha256, ringBufferSha256 };
}
