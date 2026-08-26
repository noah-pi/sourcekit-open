// Source Kit 0.1.0 — Capture-time identity resolution
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture-time identity resolution (CAWG-aligned). Maps the disclosure
 * setting to the record's identity claim:
 *   named        → self-asserted byline, only when the Name toggle
 *                  (`includeByline`) is on
 *   organization → no byline; the org credential's X.509 chain carries the
 *                  claim. Without one installed the identity is empty.
 *   anonymous    → 'redacted'
 */

import type { Settings } from '../store/useStore';

export type CaptureIdentity = { author: string | null; organization: string | null } | 'redacted';

// `includeByline` is optional in the mirror's Settings type; absent means
// byline off.
export function identityForCapture(settings: Settings & { includeByline?: boolean }): CaptureIdentity {
  switch (settings.identityMode) {
    case 'named':
      return { author: settings.includeByline === true ? settings.author.trim() || null : null, organization: null };
    case 'organization':
      return { author: null, organization: null };
    default:
      return 'redacted';
  }
}
