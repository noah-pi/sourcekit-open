// Source Kit 0.1.0 — "sourcekit-site/1". A website vouches for its own devices
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Website credential — "sourcekit-site/1".
 *
 * The certificate-free sibling of sourcekit-org/1. A person publishes one
 * static file on a domain they control:
 *
 *   https://<domain>/.well-known/sourcekit-site.json
 *
 *   {
 *     "format": "sourcekit-site/1",
 *     "organization": "Becky's Bakery",
 *     "members": [
 *       {
 *         "fingerprint": "<sha256-hex of the signing public key>",
 *         "label": "Becky's iPhone",
 *         "publicKey": "<base64 uncompressed P-256 point>"
 *       }
 *     ]
 *   }
 *
 * Who vouches for what:
 *   - TLS vouches for the domain. There is no certificate authority in the
 *     document and nothing in it is signed, so the web server's own
 *     certificate is the whole of the evidence.
 *   - The file vouches for a list of keys. A verifier that finds a capture's
 *     signing key in it learns that whoever controls the domain published
 *     that key, and nothing more.
 *
 * That ceiling is why this is a SEPARATE type from OrgCredential rather than
 * a flag on it. An org credential is checkable arithmetic; a site credential
 * is a claim resting on DNS and TLS. Callers that must not confuse the two
 * cannot, because the compiler will not let them.
 *
 * Membership is edited by editing the file. Adding a device is pasting a
 * line; removing one is deleting it. There is no roster service because
 * there is nothing for one to do.
 */

import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToHex } from './bytes';
import { getDeviceKey } from './deviceKey';

export const SITE_FORMAT = 'sourcekit-site/1';
export const SITE_WELL_KNOWN_PATH = '/.well-known/sourcekit-site.json';
const FETCH_TIMEOUT_MS = 10_000;

const STORE_KEY = 'verify_site_credential_v1';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface SiteMember {
  /** sha256 hex of the uncompressed public key point. */
  fingerprint: string;
  /** Free text, for the site owner's benefit. Never used as identity. */
  label?: string;
  /** Base64 uncompressed P-256 point. */
  publicKey: string;
}

export interface SiteDocument {
  format: typeof SITE_FORMAT;
  organization: string;
  members: SiteMember[];
}

export interface SiteCredential {
  domain: string;
  organization: string;
  /** The device fingerprint that was found in the document. */
  fingerprint: string;
  /** How many devices the document listed when it was last read. */
  memberCount: number;
  /** ISO-8601, device clock. */
  verifiedAt: string;
}

// ---------------------------------------------------------------------------
// Domain and document shape
// ---------------------------------------------------------------------------

/** Strips scheme, path, and case — the user types a domain, nothing more. */
export function normalizeSiteDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) {
    throw new Error('Enter just the website address, for example beckysbakery.com');
  }
  return d;
}

/** sha256 hex of a base64 public key point — the fingerprint the file lists. */
export function fingerprintForPublicKey(publicKeyBase64: string): string {
  return bytesToHex(sha256(base64ToBytes(publicKeyBase64)));
}

function isMember(value: unknown): value is SiteMember {
  const m = value as { fingerprint?: unknown; publicKey?: unknown; label?: unknown } | null;
  return (
    !!m &&
    typeof m.fingerprint === 'string' &&
    typeof m.publicKey === 'string' &&
    (m.label === undefined || typeof m.label === 'string')
  );
}

/**
 * Parses and validates a document. Every member's fingerprint must be the
 * hash of its own published key: a mismatch means the file is inconsistent
 * with itself, which no verifier should be asked to interpret.
 */
export function parseSiteDocument(text: string): SiteDocument {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  const doc = raw as { format?: unknown; organization?: unknown; members?: unknown };
  if (doc.format !== SITE_FORMAT) {
    throw new Error(`That file is not a ${SITE_FORMAT} document (found format: ${String(doc.format ?? 'none')}).`);
  }
  if (typeof doc.organization !== 'string' || doc.organization.trim() === '') {
    throw new Error('The file has no organization name.');
  }
  const members = Array.isArray(doc.members) ? doc.members : [];
  if (members.length === 0) throw new Error('The file lists no devices.');
  const parsed: SiteMember[] = [];
  for (const m of members) {
    if (!isMember(m)) throw new Error('One of the listed devices is missing a fingerprint or a public key.');
    const fp = m.fingerprint.trim().toLowerCase();
    let expected: string;
    try {
      expected = fingerprintForPublicKey(m.publicKey);
    } catch {
      throw new Error(`The public key listed for ${m.label ?? fp.slice(0, 8)} is not readable.`);
    }
    if (fp !== expected) {
      throw new Error(`The fingerprint listed for ${m.label ?? fp.slice(0, 8)} does not match its own public key.`);
    }
    parsed.push({ fingerprint: fp, label: m.label, publicKey: m.publicKey });
  }
  return { format: SITE_FORMAT, organization: doc.organization.trim(), members: parsed };
}

/** The document text to publish. Pretty-printed: a person edits this by hand. */
export function serializeSiteDocument(doc: SiteDocument): string {
  return JSON.stringify(doc, null, 2) + '\n';
}

/**
 * The document to publish for `organization`, carrying this device.
 *
 * `existing` is a document already published at the domain: this device is
 * added to it, replacing any entry that already carries the same
 * fingerprint, so generating a file for a second phone never drops the
 * first. Passing null starts a new list.
 */
export async function siteDocumentForThisDevice(
  organization: string,
  label: string,
  existing: SiteDocument | null = null,
): Promise<SiteDocument> {
  const key = await getDeviceKey();
  const mine: SiteMember = {
    fingerprint: fingerprintForPublicKey(key.publicKeyBase64),
    label: label.trim() || 'This iPhone',
    publicKey: key.publicKeyBase64,
  };
  const others = (existing?.members ?? []).filter((m) => m.fingerprint !== mine.fingerprint);
  return {
    format: SITE_FORMAT,
    organization: organization.trim(),
    members: [...others, mine],
  };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Reads the document a domain publishes. Over HTTPS, no cache, exactly as a
 * stranger's verifier would: an upload that never went live is the failure
 * this exists to catch, and a local shortcut would hide it.
 */
export async function fetchSiteDocument(domainInput: string): Promise<SiteDocument> {
  const domain = normalizeSiteDomain(domainInput);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://${domain}${SITE_WELL_KNOWN_PATH}`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      throw new Error(
        `Nothing published at ${domain}${SITE_WELL_KNOWN_PATH}. Upload the file to the top level of the site and try again.`,
      );
    }
    if (!res.ok) throw new Error(`${domain} answered HTTP ${res.status}.`);
    return parseSiteDocument(await res.text());
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${domain} did not answer in time. Check the address and your connection.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export interface SiteTestResult {
  domain: string;
  organization: string;
  /** This device's fingerprint appears in the published list. */
  listed: boolean;
  memberCount: number;
  fingerprint: string;
}

/** Fetches the document and reports whether THIS device is in it. */
export async function testSite(domainInput: string): Promise<SiteTestResult> {
  const domain = normalizeSiteDomain(domainInput);
  const doc = await fetchSiteDocument(domain);
  const key = await getDeviceKey();
  const fingerprint = fingerprintForPublicKey(key.publicKeyBase64);
  return {
    domain,
    organization: doc.organization,
    listed: doc.members.some((m) => m.fingerprint === fingerprint),
    memberCount: doc.members.length,
    fingerprint,
  };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function getSiteCredential(): Promise<SiteCredential | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SiteCredential;
  } catch {
    return null;
  }
}

/**
 * Tests the domain and stores the result. Throws with a plain-English reason
 * when the file is missing, malformed, or does not list this device — a
 * credential is never stored on a claim that has not just been checked.
 */
export async function connectSite(domainInput: string): Promise<SiteCredential> {
  const result = await testSite(domainInput);
  if (!result.listed) {
    throw new Error(
      `${result.domain} publishes a list, but this iPhone is not in it. Add the file this app generated, or paste this device's line into the file already there.`,
    );
  }
  const cred: SiteCredential = {
    domain: result.domain,
    organization: result.organization,
    fingerprint: result.fingerprint,
    memberCount: result.memberCount,
    verifiedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(cred), OPTIONS);
  return cred;
}

export async function clearSiteCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY, OPTIONS);
}

/**
 * The stored credential, or 'stale' when it was connected under a different
 * signing key. A rotated key is not the key the website published, so the
 * credential goes unused rather than quietly naming the wrong device.
 */
export async function siteCredentialForKey(publicKeyBase64: string): Promise<SiteCredential | 'stale' | null> {
  const cred = await getSiteCredential();
  if (!cred) return null;
  return cred.fingerprint === fingerprintForPublicKey(publicKeyBase64) ? cred : 'stale';
}
