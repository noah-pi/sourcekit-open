// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Filesystem wrappers around the pure byte verifiers (app-side only).
 *
 * verifyAsset.ts is deliberately free of file IO so the desk tool and any
 * browser environment can import the same verification core — these are the
 * three one-liners that read a vault/cache URI and delegate.
 */

import { readFileBytes } from '../lib/fileHash';
import type { AttestationRecord } from './manifest';
import {
  verifyPhotoBytes,
  verifyVideoBytes,
  verifyWithSidecarBytes,
  type VerificationReport,
  type VerifyOptions,
} from '../../archive/handrolled-verifier/verifyAsset';

export async function verifyPhoto(photoUri: string, opts?: VerifyOptions): Promise<VerificationReport> {
  try {
    return await verifyPhotoBytes(await readFileBytes(photoUri), opts);
  } catch {
    return {
      verdict: 'UNREADABLE',
      record: null,
      checks: {
        manifestFound: false,
        signatureValid: false,
        fingerprintMatches: false,
        assetHashMatches: false,
        recomputedSha256: null,
      },
      checksPerformed: [],
      checksNotPerformed: [],
    };
  }
}

export async function verifyVideo(videoUri: string, opts?: VerifyOptions): Promise<VerificationReport> {
  try {
    return await verifyVideoBytes(await readFileBytes(videoUri), opts);
  } catch {
    return {
      verdict: 'UNREADABLE',
      record: null,
      checks: {
        manifestFound: false,
        signatureValid: false,
        fingerprintMatches: false,
        assetHashMatches: false,
        recomputedSha256: null,
      },
      checksPerformed: [],
      checksNotPerformed: [],
    };
  }
}

export async function verifyWithSidecar(
  mediaUri: string,
  record: AttestationRecord,
  opts?: VerifyOptions
): Promise<VerificationReport> {
  try {
    return await verifyWithSidecarBytes(await readFileBytes(mediaUri), record, opts);
  } catch {
    return {
      verdict: 'UNREADABLE',
      record,
      checks: {
        manifestFound: true,
        signatureValid: false,
        fingerprintMatches: false,
        assetHashMatches: false,
        recomputedSha256: null,
      },
      checksPerformed: [],
      checksNotPerformed: [],
    };
  }
}
