// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture-time identity resolution (CAWG-aligned).
 *
 * Maps the user's disclosure setting to the record's identity claim. The
 * mapping is deliberately dumb and honest:
 *   named        → personal byline (self-asserted — a name, never proof),
 *                  ONLY when the Name toggle (`includeByline`) is
 *                  on — the camera HUD shows that state before the shutter,
 *                  so an embedded byline is never a surprise
 *   organization → no byline; the org credential's X.509 chain (embedded in
 *                  the signature when installed) is the org claim. With no
 *                  org credential installed this is effectively anonymous —
 *                  the record shows an empty identity, not a fake org.
 *   anonymous    → 'redacted'
 */

import type { Settings } from '../store/useStore';

export type CaptureIdentity = { author: string | null; organization: string | null } | 'redacted';

// `includeByline` postdates the open-source mirror's Settings type, so it
// is read tolerantly here (absent = byline off — the safe direction for an
// identifying claim).
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
