// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Organization credentials.
 *
 * An organization can elevate a device's self-signed identity to an
 * org-issued one — without the private key ever leaving the Secure Enclave:
 *
 *   1. Device exports its public key + fingerprint (Settings → Export).
 *   2. The org's CA issues a certificate FOR THAT PUBLIC KEY (offline,
 *      e.g. openssl) and hands back the cert (+ CA cert).
 *   3. The device imports it here. From then on, every C2PA signature's
 *      x5chain is [org-issued device cert, org CA cert] — verifiers see the
 *      signature chain into the organization instead of a self-signed cert.
 *
 * Revocation is intentionally verifier-side and standard: the org CA puts
 * OCSP/CRL endpoints (AIA / CRL Distribution Points) in the certs it
 * issues, and any verifier can check status against the org. We surface
 * the cert's serial + expiry so a desk can ask "is this cert still good?"
 * An org credential that no longer matches the active device key (after a
 * key rotation) is ignored and flagged, never silently used.
 *
 * What we deliberately do NOT do: accept private keys. Any "credential"
 * that ships a key is a liability, not an upgrade.
 */

import * as SecureStore from 'expo-secure-store';
import { publicKeyFromCert, verifyChain } from './x509';
import { base64ToBytes, bytesToBase64, bytesToHex, equalBytes, utf8ToBytes, bytesToUtf8 } from './bytes';

const STORE_KEY = 'verify_org_credential_v1';
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export interface CertInfo {
  subjectOrg: string | null;
  subjectCN: string | null;
  issuerOrg: string | null;
  issuerCN: string | null;
  serialHex: string;
  notBefore: string; // ISO
  notAfter: string;  // ISO
  publicKey: Uint8Array;
}

export interface OrgCredential {
  leafDerB64: string;
  caDerB64: string | null;
  info: {
    subjectOrg: string | null;
    subjectCN: string | null;
    issuerOrg: string | null;
    issuerCN: string | null;
    serialHex: string;
    notBefore: string;
    notAfter: string;
  };
  importedAt: string;
  /**
   * How the credential arrived: the domain it was fetched from over TLS
   * (sourcekit-org/1, src/lib/orgDirectory.ts). Absent for file imports. A
   * LOCAL provenance fact — never embedded in signed claims.
   */
  sourceDomain?: string;
}

// ---------------------------------------------------------------------------
// Minimal DER reader (just enough for X.509 field extraction)
// ---------------------------------------------------------------------------

interface Tlv { tag: number; content: Uint8Array; next: number }

function readTlv(b: Uint8Array, o: number): Tlv {
  if (!Number.isInteger(o) || o < 0 || o + 2 > b.length) throw new Error('DER: truncated');
  const tag = b[o];
  let len = b[o + 1];
  let p = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: indefinite or oversized length');
    len = 0;
    // Multiply-accumulate, never (len << 8) | byte: 32-bit signed shift
    // wraps lengths ≥ 0x80000000 negative and walkers hang.
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i];
    p += n;
  }
  if (p + len > b.length) throw new Error('DER: length overruns buffer');
  const next = p + len;
  if (next <= o) throw new Error('DER: non-advancing TLV'); // hard anti-hang invariant
  return { tag, content: b.subarray(p, next), next };
}

const OID_ORG = [0x55, 0x04, 0x0a]; // 2.5.4.10 organizationName
const OID_CN = [0x55, 0x04, 0x03];  // 2.5.4.3 commonName

function readName(b: Uint8Array): { org: string | null; cn: string | null } {
  let org: string | null = null;
  let cn: string | null = null;
  let o = 0;
  while (o < b.length) {
    const set = readTlv(b, o); // SET
    o = set.next;
    const seq = readTlv(set.content, 0); // AttributeTypeAndValue SEQUENCE
    const oidTlv = readTlv(seq.content, 0);
    const valTlv = readTlv(seq.content, oidTlv.next);
    const oid = Array.from(oidTlv.content);
    const text = bytesToUtf8(valTlv.content);
    if (oid.length === 3 && oid[0] === OID_ORG[0] && oid[1] === OID_ORG[1] && oid[2] === OID_ORG[2]) org = text;
    if (oid.length === 3 && oid[0] === OID_CN[0] && oid[1] === OID_CN[1] && oid[2] === OID_CN[2]) cn = text;
  }
  return { org, cn };
}

function readTime(b: Uint8Array): string {
  // UTCTime (0x17, YYMMDDHHMMSSZ) or GeneralizedTime (0x18, YYYYMMDDHHMMSSZ)
  const tlv = readTlv(b, 0);
  const s = bytesToUtf8(tlv.content);
  if (tlv.tag === 0x18) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;
  }
  const yy = parseInt(s.slice(0, 2), 10);
  const yyyy = yy < 50 ? 2000 + yy : 1900 + yy;
  return `${yyyy}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}Z`;
}

/** Extracts the fields the UI and verifiers care about. Throws on garbage. */
export function parseCertInfo(certDer: Uint8Array): CertInfo {
  const cert = readTlv(certDer, 0); // Certificate SEQUENCE
  const tbs = readTlv(cert.content, 0); // TBSCertificate SEQUENCE
  let o = 0;
  let tlv = readTlv(tbs.content, o);
  if (tlv.tag === 0xa0) { o = tlv.next; tlv = readTlv(tbs.content, o); } // skip [0] version
  const serial = tlv.content; o = tlv.next; // serialNumber INTEGER
  const sigAlg = readTlv(tbs.content, o); o = sigAlg.next; // signature algid
  const issuerTlv = readTlv(tbs.content, o); o = issuerTlv.next;
  const issuer = readName(issuerTlv.content);
  const validity = readTlv(tbs.content, o); o = validity.next;
  const notBefore = readTime(validity.content);
  const notAfter = readTime(validity.content.subarray(readTlv(validity.content, 0).next));
  const subjectTlv = readTlv(tbs.content, o);
  const subject = readName(subjectTlv.content);

  // Positional SPKI walk, not a byte scan (0.20.5 key-confusion patch):
  // the point of this check is that the credential names THIS device's key,
  // so it has to read the key the certificate actually binds — the first
  // P-256 point in the DER need not be it.
  const certKey = publicKeyFromCert(certDer);
  const publicKey = certKey?.kind === 'ec' ? certKey.point : null;
  if (!publicKey) throw new Error('Not a P-256 ECDSA certificate (no supported public key found)');

  return {
    subjectOrg: subject.org,
    subjectCN: subject.cn,
    issuerOrg: issuer.org,
    issuerCN: issuer.cn,
    serialHex: bytesToHex(serial[0] === 0 ? serial.subarray(1) : serial),
    notBefore,
    notAfter,
    publicKey,
  };
}

/** PEM ("-----BEGIN CERTIFICATE-----") or raw base64 DER → DER bytes. */
export function pemOrDerToDer(text: string): Uint8Array {
  const m = text.match(/-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END CERTIFICATE-----/);
  if (m) return base64ToBytes(m[1].replace(/\s+/g, ''));
  if (/^[A-Za-z0-9+/=\s]+$/.test(text.trim()) && text.trim().length > 100) {
    return base64ToBytes(text.replace(/\s+/g, ''));
  }
  return utf8ToBytes(text); // will fail parse with a clear error
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function getOrgCredential(): Promise<OrgCredential | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY, OPTIONS);
  if (!raw) return null;
  try { return JSON.parse(raw) as OrgCredential; } catch { return null; }
}

/**
 * Validates and stores an org-issued credential.
 *   leafDer — org-issued cert for THIS device's public key (required)
 *   caDer   — the org CA cert (optional but strongly recommended: without
 *             it the x5chain can't show who issued the credential)
 * Throws with a plain-English reason on any mismatch.
 */
export async function setOrgCredential(leafDer: Uint8Array, caDer: Uint8Array | null, devicePublicKey: Uint8Array, sourceDomain?: string): Promise<OrgCredential> {
  const info = parseCertInfo(leafDer);
  if (!equalBytes(info.publicKey, devicePublicKey)) {
    throw new Error('This certificate is for a different public key. An org credential must be issued for THIS device\'s key. Export the device public key first and have your organization sign that.');
  }
  const now = Date.now();
  if (Date.parse(info.notBefore) > now) throw new Error(`Certificate is not valid until ${info.notBefore}.`);
  if (Date.parse(info.notAfter) <= now) throw new Error(`Certificate expired ${info.notAfter}. Ask your organization to re-issue.`);
  if (caDer) {
    parseCertInfo(caDer); // sanity: must at least be a parseable cert
    // Real validation: the CA must actually have signed this leaf (signature,
    // name chaining, CA flag, validity). Without this check anyone could
    // self-issue a "credential" claiming any organization.
    const chain = verifyChain([leafDer, caDer], [], now);
    if (!chain.linksValid) {
      throw new Error(`The CA certificate did not issue this device certificate (${chain.reason ?? 'chain broken'}). Ask your organization for the correct CA file.`);
    }
  }

  const cred: OrgCredential = {
    leafDerB64: bytesToBase64(leafDer),
    caDerB64: caDer ? bytesToBase64(caDer) : null,
    info: {
      subjectOrg: info.subjectOrg,
      subjectCN: info.subjectCN,
      issuerOrg: info.issuerOrg,
      issuerCN: info.issuerCN,
      serialHex: info.serialHex,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
    },
    importedAt: new Date().toISOString(),
    ...(sourceDomain ? { sourceDomain } : {}),
  };
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify(cred), OPTIONS);
  return cred;
}

export async function clearOrgCredential(): Promise<void> {
  await SecureStore.deleteItemAsync(STORE_KEY, OPTIONS);
}

/**
 * The x5chain to sign with: [org leaf, org CA] when a valid credential for
 * the CURRENT device key exists, else null (caller falls back to self-signed).
 * A credential left behind by a key rotation is reported as stale, not used.
 */
export async function orgCertChainForKey(devicePublicKey: Uint8Array): Promise<{ chain: Uint8Array[]; info: OrgCredential['info'] } | 'stale' | null> {
  const cred = await getOrgCredential();
  if (!cred) return null;
  const leaf = base64ToBytes(cred.leafDerB64);
  const info = parseCertInfo(leaf);
  if (!equalBytes(info.publicKey, devicePublicKey)) return 'stale';
  if (Date.parse(info.notAfter) <= Date.now()) return 'stale';
  return { chain: cred.caDerB64 ? [leaf, base64ToBytes(cred.caDerB64)] : [leaf], info: cred.info };
}
