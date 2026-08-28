// Source Kit 0.1.0 — capture-time identity resolution
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture-time identity resolution (CAWG-aligned). Maps the disclosure
 * setting to the record's identity claim:
 *   personal     → the personal certificate's subject, or the website
 *                  credential's label when no certificate is installed.
 *                  With neither, the identity is empty
 *   organization → no personal name; the org credential's X.509 chain
 *                  carries the claim. Without one the identity is empty
 *   anonymous    → 'redacted'
 *
 * Every name here comes from a credential the device holds. Nothing a user
 * typed reaches a capture, so a name in a record is always something a
 * verifier can go and check.
 */

import { base64ToBytes } from './bytes';
import { getDeviceKey } from './deviceKey';
import { personalCertChainForKey } from './personalCert';
import { siteCredentialForKey } from './siteCredential';
import { orgCertChainForKey } from './orgCert';

/**
 * CAWG-aligned identity disclosure, chosen per capture. Lives here rather
 * than with the settings that persist it: what a mode MEANS is this
 * module's business, and the store only remembers which one is on.
 */
export type IdentityMode = 'anonymous' | 'organization' | 'personal';

/** The slice of settings this module reads. */
export interface IdentitySettings {
  identityMode: IdentityMode;
}

export type CaptureIdentity = { author: string | null; organization: string | null } | 'redacted';

/**
 * The credentials installed for the CURRENT signing key, resolved to display
 * names. Callers pass nulls for anything absent or stale — a credential that
 * no longer matches the active key is not installed as far as this is
 * concerned.
 */
export interface InstalledIdentities {
  /** Subject of the personal certificate (S/MIME, read as a CAWG identity). */
  personalName: string | null;
  /** Organization label from the connected website credential. */
  siteName: string | null;
  /** Subject organization of the org credential. */
  organization: string | null;
}

export const NO_IDENTITIES: InstalledIdentities = {
  personalName: null,
  siteName: null,
  organization: null,
};

export function identityForCapture(
  settings: IdentitySettings,
  installed: InstalledIdentities = NO_IDENTITIES,
): CaptureIdentity {
  switch (settings.identityMode) {
    case 'personal':
      // The certificate wins over the website: it is the stronger claim, and
      // a holder of both means the same person either way.
      return { author: installed.personalName ?? installed.siteName, organization: null };
    case 'organization':
      return { author: null, organization: installed.organization };
    default:
      return 'redacted';
  }
}

/**
 * Reads the credentials installed for the CURRENT signing key. A credential
 * that no longer matches the active key resolves to null rather than to a
 * name: a rotated key is not the key anybody certified.
 */
export async function installedIdentities(): Promise<InstalledIdentities> {
  const key = await getDeviceKey();
  const publicKey = base64ToBytes(key.publicKeyBase64);
  const [personal, site, org] = await Promise.all([
    personalCertChainForKey(publicKey),
    siteCredentialForKey(key.publicKeyBase64),
    orgCertChainForKey(publicKey),
  ]);
  return {
    personalName:
      personal && personal !== 'stale' ? personal.info.subjectCN ?? personal.info.subjectOrg : null,
    siteName: site && site !== 'stale' ? site.organization : null,
    organization: org && org !== 'stale' ? org.info.subjectOrg ?? org.info.subjectCN : null,
  };
}
