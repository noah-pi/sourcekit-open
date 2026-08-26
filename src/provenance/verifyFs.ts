// Source Kit 0.1.0 — Filesystem wrappers around the pure byte verifiers
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Filesystem wrappers around the pure byte verifiers (app-side only).
 *
 * verifyAsset.ts is deliberately free of file IO so the desk tool and any
 * browser environment can import the same verification core — these are the
 * three one-liners that read a vault/cache URI and delegate.
 */

import { readFileBytes } from '../lib/fileHash';
import { logDiagnostic } from '../lib/diagnosticsLog';
import type { AttestationRecord } from './manifest';
import {
  verifyPhotoBytes,
  verifyVideoBytes,
  verifyWithSidecarBytes,
  type VerificationReport,
  type VerifyOptions,
} from '../../archive/handrolled-verifier/verifyAsset';

/**
 * 0.20.1 audit (Patch 5): a bare `catch` made an SDK throw, an OOM on a
 * large video, a missing file, and a genuinely corrupt asset
 * indistinguishable — exactly the signal a migration needs. UNREADABLE
 * stays the verdict (right for the user), but the reason is logged and the
 * report no longer claims checks that never ran.
 */
function unreadable(kind: 'photo' | 'video' | 'audio', record: AttestationRecord | null, manifestFound: boolean, e: unknown): VerificationReport {
  const reason = e instanceof Error ? e.message : String(e);
  logDiagnostic({ t: Date.now(), kind, outcome: 'info', message: `verify threw, reported UNREADABLE (${reason})` });
  return {
    verdict: 'UNREADABLE',
    record,
    checks: {
      manifestFound,
      signatureValid: false,
      fingerprintMatches: false,
      assetHashMatches: false,
      recomputedSha256: null,
    },
    checksPerformed: [],
    checksNotPerformed: [`verification threw before any check ran: ${reason}`],
  };
}

export async function verifyPhoto(photoUri: string, opts?: VerifyOptions): Promise<VerificationReport> {
  try {
    return await verifyPhotoBytes(await readFileBytes(photoUri), opts);
  } catch (e) {
    return unreadable('photo', null, false, e);
  }
}

export async function verifyVideo(videoUri: string, opts?: VerifyOptions): Promise<VerificationReport> {
  try {
    return await verifyVideoBytes(await readFileBytes(videoUri), opts);
  } catch (e) {
    return unreadable('video', null, false, e);
  }
}

export async function verifyWithSidecar(
  mediaUri: string,
  record: AttestationRecord,
  opts?: VerifyOptions
): Promise<VerificationReport> {
  try {
    return await verifyWithSidecarBytes(await readFileBytes(mediaUri), record, opts);
  } catch (e) {
    // manifestFound stays TRUE here, deliberately (diverging from the
    // audit's Patch 5): the sidecar record is already in hand — the caller
    // parsed it — so the manifest WAS found; what failed is the media read
    // or the verification run, which checksNotPerformed now names.
    return unreadable(record.asset.kind, record, true, e);
  }
}
