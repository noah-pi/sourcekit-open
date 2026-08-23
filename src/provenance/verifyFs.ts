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
} from '../c2pa/verifyAsset';

/**
 * UNREADABLE with the reason recorded. A throw here can be a missing file, a
 * corrupt asset, or an out-of-memory on a large video; the diagnostics log
 * gets the message and checksNotPerformed names the gap, so the report never
 * implies a check that did not run.
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
