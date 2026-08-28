// Source Kit 0.1.0 — a personal certificate for the device signing key
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Personal certificate — an authority certifies a person, for this key.
 *
 * The freelancer's route, and the sibling of orgCert: the same shape of
 * exchange, with an authority in place of an employer.
 *
 *   1. The device builds a PKCS#10 request and signs it with the Enclave key
 *      (src/lib/cert.ts → buildCsr). Nothing exportable leaves the phone.
 *   2. A certificate authority checks the person's identity and issues a
 *      certificate FOR THAT PUBLIC KEY.
 *   3. The device imports it here, and the C2PA x5chain names a person a
 *      third party has actually checked.
 *
 * The certificate belongs to the person, not to this app: it is issued
 * against their own subscription and any tool that writes CAWG identity
 * assertions can use it. What cannot move is the key, since a Secure Enclave
 * key is not exportable, so a second device needs its own certificate for
 * its own key.
 *
 * Trust is evaluated, never assumed. A certificate carrying the document-
 * signing purpose is recognized outright, as CAWG requires. One carrying
 * email protection is recognized only when its chain reaches an anchor list
 * the device actually holds — otherwise it is stored and used, and reported
 * as self-asserted. Being unrecognized here is not the same as being
 * unrecognized everywhere: this device carries the lists it carries, and a
 * recipient's tool may hold more.
 *
 * What we deliberately do NOT do: accept private keys. Any "credential" that
 * ships a key is a liability, not an upgrade.
 */

import * as SecureStore from 'expo-secure-store';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64, bytesToHex, equalBytes } from './bytes';
import { parseCertInfo } from './orgCert';
import { parseCertificate, hasKeyPurpose, verifyChain } from './x509';
import {
  anchorListFor,
  OID_KP_DOCUMENT_SIGNING,
  OID_KP_EMAIL_PROTECTION,
} from './identityTrustList';

const STORE_KEY = 'verify_personal_credential_v1';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * How a recipient's verifier will report the identity signature. The two
 * outcomes are the specification's own: recognized against a trust list, or
 * structurally valid but vouched for by nobody.
 */
export type IdentityTrust =
  | { level: 'trusted'; recognizedBy: string }
  | { level: 'self-asserted'; reason: string };

export interface PersonalCredential {
  leafDerB64: string;
  caDerB64: string | null;
  info: {
    subjectCN: string | null;
    subjectOrg: string | null;
    issuerOrg: string | null;
    issuerCN: string | null;
    serialHex: string;
    notBefore: string;
    notAfter: string;
  };
  /** Evaluated at import. Re-evaluated on demand as anchor lists change. */
  trust: IdentityTrust;
  importedAt: string;
}

/** The issuer's display name: organization first, common name as fallback. */
export function issuerLabel(info: PersonalCredential['info']): string {
  return info.issuerOrg ?? info.issuerCN ?? 'an unnamed authority';
}

/**
 * Reads the trust outcome for a certificate and its chain.
 *
 * Document signing short-circuits: the specification requires that purpose
 * to be accepted and names no trust anchors for it, so a chain check would
 * be inventing a requirement.
 */
export async function evaluateIdentityTrust(
  leafDer: Uint8Array,
  caDer: Uint8Array | null,
): Promise<IdentityTrust> {
  const leaf = parseCertificate(leafDer);
  if (hasKeyPurpose(leaf, OID_KP_DOCUMENT_SIGNING)) {
    return { level: 'trusted', recognizedBy: 'the document-signing purpose, which needs no trust anchor' };
  }
  const chain = caDer ? [leafDer, caDer] : [leafDer];
  const list = await anchorListFor(chain.map((d) => bytesToHex(sha256(d))));
  if (list) return { level: 'trusted', recognizedBy: list.name };
  return {
    level: 'self-asserted',
    reason: 'This device does not carry a list naming that issuer. A recipient whose tool carries one will still see it as verified.',
  };
}

export async function getPersonalCredential(): Promise<PersonalCredential | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersonalCredential;
  } catch {
    return null;
  }
}

/**
 * Validates and stores a personal certificate.
 *   leafDer — the authority's certificate for THIS device's public key
 *   caDer   — the issuing CA, optional but needed for the chain to be shown
 * Throws with a plain-English reason on any mismatch.
 */
export async function setPersonalCredential(
  leafDer: Uint8Array,
  caDer: Uint8Array | null,
  devicePublicKey: Uint8Array,
): Promise<PersonalCredential> {
  const info = parseCertInfo(leafDer);
  if (!equalBytes(info.publicKey, devicePublicKey)) {
    throw new Error(
      "This certificate is for a different key. It has to be issued for THIS iPhone's key — send the signing request this app generated, and import what comes back.",
    );
  }
  const now = Date.now();
  if (Date.parse(info.notBefore) > now) throw new Error(`This certificate is not valid until ${info.notBefore}.`);
  if (Date.parse(info.notAfter) <= now) throw new Error(`This certificate expired ${info.notAfter}. Ask the authority to reissue it.`);

  // CAWG reads an identity signature only when the certificate carries a key
  // purpose it recognizes. Storing one it will ignore would put a name on the
  // Settings screen that never reaches a single capture.
  const leaf = parseCertificate(leafDer);
  const usable =
    hasKeyPurpose(leaf, OID_KP_EMAIL_PROTECTION) || hasKeyPurpose(leaf, OID_KP_DOCUMENT_SIGNING);
  if (!usable) {
    throw new Error(
      'This certificate is not marked for email protection or document signing, so verification tools will ignore it. Ask the authority for a personal S/MIME certificate.',
    );
  }

  if (caDer) {
    // parseCertificate, not parseCertInfo: an issuing CA is read only to
    // check it signed this leaf, and public S/MIME authorities are RSA.
    // Requiring P-256 here would reject nearly every real issuer.
    parseCertificate(caDer);
    const chain = verifyChain([leafDer, caDer], [], now);
    if (!chain.linksValid) {
      throw new Error(
        `That CA certificate did not issue this one (${chain.reason ?? 'chain broken'}). Import the issuing CA the authority published.`,
      );
    }
  }

  const cred: PersonalCredential = {
    leafDerB64: bytesToBase64(leafDer),
    caDerB64: caDer ? bytesToBase64(caDer) : null,
    info: {
      subjectCN: info.subjectCN,
      subjectOrg: info.subjectOrg,
      issuerOrg: info.issuerOrg,
      issuerCN: info.issuerCN,
      serialHex: info.serialHex,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
    },
    trust: await evaluateIdentityTrust(leafDer, caDer),
    importedAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(cred), OPTIONS);
  return cred;
}

export async function clearPersonalCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY, OPTIONS);
}

/**
 * Re-reads trust against the anchor lists the device holds now, and stores
 * the result. An anchor list fetched after the certificate was imported
 * should promote it without the person reimporting anything.
 */
export async function refreshPersonalTrust(): Promise<PersonalCredential | null> {
  const cred = await getPersonalCredential();
  if (!cred) return null;
  const updated: PersonalCredential = {
    ...cred,
    trust: await evaluateIdentityTrust(
      base64ToBytes(cred.leafDerB64),
      cred.caDerB64 ? base64ToBytes(cred.caDerB64) : null,
    ),
  };
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(updated), OPTIONS);
  return updated;
}

/**
 * The x5chain to sign with: [personal leaf, issuing CA] when a valid
 * certificate for the CURRENT device key exists, else null. A certificate
 * left behind by a key rotation is reported as stale, not used.
 */
export async function personalCertChainForKey(
  devicePublicKey: Uint8Array,
): Promise<{ chain: Uint8Array[]; info: PersonalCredential['info']; trust: IdentityTrust } | 'stale' | null> {
  const cred = await getPersonalCredential();
  if (!cred) return null;
  const leaf = base64ToBytes(cred.leafDerB64);
  const info = parseCertInfo(leaf);
  if (!equalBytes(info.publicKey, devicePublicKey)) return 'stale';
  if (Date.parse(info.notAfter) <= Date.now()) return 'stale';
  return {
    chain: cred.caDerB64 ? [leaf, base64ToBytes(cred.caDerB64)] : [leaf],
    info: cred.info,
    trust: cred.trust,
  };
}
