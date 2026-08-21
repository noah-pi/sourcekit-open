// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Org credential over HTTPS — "sourcekit-org/1".
 *
 * The SSL integration: instead of hand-importing a credential file, a member
 * enters their organization's domain and the app fetches a STATIC document
 * the org publishes at:
 *
 *   https://<domain>/.well-known/sourcekit-org.json
 *
 *   {
 *     "format": "sourcekit-org/1",
 *     "organization": "Acme News",
 *     "caPem": "-----BEGIN CERTIFICATE----- …",   // the org CA
 *     "members": [
 *       {
 *         "fingerprint": "<sha256-hex of the member device's signing public key>",
 *         "leafPem": "-----BEGIN CERTIFICATE----- …"  // org-issued cert FOR that key
 *       }
 *     ]
 *   }
 *
 * Who vouches for what, precisely:
 *   - TLS vouches for the DOMAIN: the document could only come from whoever
 *     controls the domain's certificate. That is the entire role of SSL here.
 *   - The org CA's signature vouches for the CONTENT: setOrgCredential
 *     re-verifies that the leaf chains to the published CA, is in validity,
 *     and is issued for THIS device's public key. A forged, swapped, or
 *     mis-issued document fails that check and is rejected — the transport
 *     can deliver a lie, it cannot make one verify.
 *   - The domain itself is a LOCAL provenance fact (how the credential
 *     arrived). It is stored alongside the credential and shown in Settings;
 *     it is NOT embedded in any signed claim — the manifest carries the
 *     X.509 chain, exactly as with a file import.
 *
 * Org-side tooling needs no server code: the document is a static file any
 * web host (or object store behind the domain) can serve, regenerated when
 * membership changes. Member fingerprints come from the app's Copy key /
 * export — the public key never leaves the device in any other form.
 */

import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToHex } from './bytes';
import { getDeviceKey } from './deviceKey';
import { pemOrDerToDer, setOrgCredential, type OrgCredential } from './orgCert';

/** The one path an organization publishes, and the one format string it carries. */
const WELL_KNOWN_PATHS = ['/.well-known/sourcekit-org.json'] as const;
const ACCEPTED_FORMATS = ['sourcekit-org/1'] as const;
const FETCH_TIMEOUT_MS = 10_000;

interface OrgDirectoryDoc {
  format?: unknown;
  organization?: unknown;
  caPem?: unknown;
  members?: unknown;
}

/** Strips scheme/path/case — the user types a domain, nothing more. */
export function normalizeOrgDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    throw new Error('Enter just the organization’s domain, e.g. example-news.com');
  }
  return d;
}

/**
 * Fetches the org's well-known document over TLS, finds the member entry for
 * THIS device's signing key, verifies the chain cryptographically, and
 * installs the credential. Throws with a plain-English reason on any failure.
 */
export async function fetchOrgCredentialFromDomain(domainInput: string): Promise<OrgCredential> {
  const domain = normalizeOrgDomain(domainInput);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let doc: OrgDirectoryDoc;
  try {
    // Try the current path first, then the legacy one. A 404 on the first is
    // not an error yet — only a 404 on both means the org has published nothing.
    let res: Response | null = null;
    for (const path of WELL_KNOWN_PATHS) {
      const attempt = await fetch(`https://${domain}${path}`, {
        headers: { accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (attempt.ok) { res = attempt; break; }
      if (attempt.status !== 404) {
        throw new Error(`Fetching ${domain} failed: HTTP ${attempt.status}`);
      }
    }
    if (!res) {
      throw new Error(
        `No Source Kit credential document at ${domain}${WELL_KNOWN_PATHS[0]}. Ask your organization to publish it there.`,
      );
    }
    doc = (await res.json()) as OrgDirectoryDoc;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${domain} did not answer in time. Check the domain and your connection.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (!ACCEPTED_FORMATS.includes(doc.format as (typeof ACCEPTED_FORMATS)[number])) {
    throw new Error(`That document is not a sourcekit-org/1 credential directory (found format: ${String(doc.format ?? 'none')}).`);
  }
  const caPem = typeof doc.caPem === 'string' ? doc.caPem : null;
  if (!caPem) throw new Error('The document has no CA certificate (caPem).');
  const members = Array.isArray(doc.members) ? doc.members : [];
  if (members.length === 0) throw new Error('The document lists no member devices.');

  const key = await getDeviceKey();
  const fingerprint = bytesToHex(sha256(base64ToBytes(key.publicKeyBase64)));
  const entry = members.find((m): m is { fingerprint?: unknown; leafPem?: unknown } => {
    const fp = (m as { fingerprint?: unknown })?.fingerprint;
    return typeof fp === 'string' && fp.trim().toLowerCase() === fingerprint;
  }) as { fingerprint: string; leafPem?: unknown } | undefined;
  if (!entry || typeof entry.leafPem !== 'string') {
    throw new Error(
      `This device’s fingerprint is not listed at ${domain}. Export the device key (Device ID → Copy key) and ask your organization to add it to the document.`,
    );
  }

  // The cryptographic gate — domain delivery changes nothing about WHAT is
  // accepted: leaf must chain to the published CA and name this device's key.
  const cred = await setOrgCredential(
    pemOrDerToDer(entry.leafPem),
    pemOrDerToDer(caPem),
    base64ToBytes(key.publicKeyBase64),
    domain,
  );
  return cred;
}
