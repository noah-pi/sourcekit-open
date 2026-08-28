// Source Kit 0.1.0 — self-signed X.509 certificate for the device signing key
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Self-signed X.509 certificate (DER) for the device signing key, built with
 * a minimal hand-rolled ASN.1 writer. No native PKI dependency.
 *
 * Extension profile per the C2PA certificate profile (spec §14.5.1, as
 * enforced by c2pa-rs): X.509 v3, EC P-256 SPKI, critical keyUsage
 * (digitalSignature + nonRepudiation), critical EKU (emailProtection;
 * `opts.eku: 'timeStamping'` swaps in the RFC 3161 §2.3 TSA purpose for lab
 * TSA fixtures), SubjectKeyIdentifier, and AuthorityKeyIdentifier. The
 * subject must carry an Organization or c2pa-rs errors.
 *
 * Self-signed, so third-party verifiers report it as untrusted (not on the
 * C2PA trust list) while the signature itself validates.
 *
 * Pure module, no React Native dependencies.
 */

import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, asciiToBytes, utf8ToBytes, bytesToBase64 } from './bytes';

// --- tiny DER writer ---
function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLen(content.length), content);
}
const seq = (...c: Uint8Array[]) => tlv(0x30, concatBytes(...c));
const oid = (bytes: number[]) => tlv(0x06, new Uint8Array(bytes));
const int = (n: number) => {
  const b: number[] = [];
  let v = n;
  do { b.unshift(v & 0xff); v >>= 8; } while (v > 0);
  if (b[0] & 0x80) b.unshift(0);
  return tlv(0x02, new Uint8Array(b));
};
const intBytes = (b: Uint8Array) => tlv(0x02, b[0] & 0x80 ? concatBytes(new Uint8Array([0]), b) : b);
const utf8 = (s: string) => tlv(0x0c, utf8ToBytes(s));
const ia5 = (s: string) => tlv(0x16, asciiToBytes(s));
const utcTime = (d: Date) => {
  const p = (x: number) => String(x).padStart(2, '0');
  const y = String(d.getUTCFullYear()).slice(2);
  return tlv(0x17, asciiToBytes(`${y}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const bitString = (b: Uint8Array) => tlv(0x03, concatBytes(new Uint8Array([0]), b));
const explicit0 = (c: Uint8Array) => tlv(0xa0, c);
const explicit3 = (c: Uint8Array) => tlv(0xa3, c); // X.509 v3 extensions field

const OID = {
  ecPublicKey: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01],            // 1.2.840.10045.2.1
  prime256v1: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],       // 1.2.840.10045.3.1.7
  ecdsaWithSHA256: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02],  // 1.2.840.10045.4.3.2
  commonName: [0x55, 0x04, 0x03],                                     // 2.5.4.3
  organizationName: [0x55, 0x04, 0x0a],                               // 2.5.4.10
  keyUsage: [0x55, 0x1d, 0x0f],                                       // 2.5.29.15
  extKeyUsage: [0x55, 0x1d, 0x25],                                    // 2.5.29.37
  subjectKeyId: [0x55, 0x1d, 0x0e],                                   // 2.5.29.14
  authorityKeyId: [0x55, 0x1d, 0x23],                                 // 2.5.29.35
  emailProtection: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x04],  // 1.3.6.1.5.5.7.3.4
  timeStamping: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08],     // 1.3.6.1.5.5.7.3.8
  // PKCS#9 emailAddress. Legacy, and still what S/MIME authorities read out
  // of a request to seed the certificate's subject alternative name.
  emailAddress: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x01],
};

function algIdEcdsa(): Uint8Array {
  return seq(oid(OID.ecdsaWithSHA256));
}

function name(org: string, cn: string): Uint8Array {
  return seq(
    tlv(0x31, seq(oid(OID.organizationName), utf8(org))),
    tlv(0x31, seq(oid(OID.commonName), utf8(cn)))
  );
}

export const CERT_ORGANIZATION = 'Source Kit';
export const CERT_COMMON_NAME = 'Source Kit Device';

/**
 * Builds a self-signed P-256 certificate valid from `notBefore` for 5 years.
 * Takes a digest-signing function rather than the private key so Secure
 * Enclave keys, which never leave the chip, can certify themselves.
 */
export async function buildSelfSignedCert(
  publicKey: Uint8Array,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
  notBefore: Date = new Date(),
  opts?: { eku?: 'emailProtection' | 'timeStamping' }
): Promise<Uint8Array> {
  const pub = publicKey; // 65-byte uncompressed

  const spki = seq(
    seq(oid(OID.ecPublicKey), oid(OID.prime256v1)),
    bitString(pub)
  );

  // Key identifier per RFC 5280 §4.2.1.2 method 1: SHA-1 of the
  // subjectPublicKey BIT STRING contents (the uncompressed point).
  const keyId = sha1(pub); // 20 bytes

  const critical = tlv(0x01, new Uint8Array([0xff]));
  const extensions = explicit3(seq(
    seq(oid(OID.keyUsage), critical, tlv(0x04, bitString(new Uint8Array([0xc0])))),
    seq(oid(OID.extKeyUsage), critical, tlv(0x04, seq(oid(OID[opts?.eku ?? 'emailProtection'])))),
    seq(oid(OID.subjectKeyId), tlv(0x04, tlv(0x04, keyId))),
    seq(oid(OID.authorityKeyId), tlv(0x04, seq(tlv(0x80, keyId))))
  ));

  const later = new Date(notBefore.getTime() + 5 * 365 * 24 * 3600 * 1000);

  const tbs = seq(
    explicit0(int(2)),                    // version v3
    intBytes(sha256(pub).subarray(0, 16)), // deterministic serial from the key
    algIdEcdsa(),
    name(CERT_ORGANIZATION, CERT_COMMON_NAME),
    seq(utcTime(notBefore), utcTime(later)),
    name(CERT_ORGANIZATION, CERT_COMMON_NAME),
    spki,
    extensions
  );

  const sigDer = await signDigest(sha256(tbs));
  return seq(tbs, algIdEcdsa(), bitString(sigDer));
}


// ---------------------------------------------------------------------------
// PKCS#10 certification request
// ---------------------------------------------------------------------------

export interface CsrSubject {
  /** The name the certificate should carry. */
  commonName: string;
  /** Mailbox the authority will validate. S/MIME authorities require one. */
  email?: string | null;
  organization?: string | null;
}

/**
 * A PKCS#10 certification request (RFC 2986) for `publicKey`.
 *
 * The request is signed by the key it names, which is the whole point of the
 * format: it proves the requester holds the private half without ever
 * revealing it. A Secure Enclave key can therefore ask for a certificate
 * exactly like any other, and nothing exportable leaves the device.
 *
 * No extension request is attached. Key usage and extended key usage are the
 * authority's to set, and a request that dictates them is one more thing for
 * an authority to reject.
 */
export async function buildCsr(
  publicKey: Uint8Array,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>,
  subject: CsrSubject
): Promise<Uint8Array> {
  const cn = subject.commonName.trim();
  if (cn === '') throw new Error('A certification request needs a name.');

  const rdns: Uint8Array[] = [];
  const org = subject.organization?.trim();
  if (org) rdns.push(tlv(0x31, seq(oid(OID.organizationName), utf8(org))));
  rdns.push(tlv(0x31, seq(oid(OID.commonName), utf8(cn))));
  const email = subject.email?.trim();
  if (email) rdns.push(tlv(0x31, seq(oid(OID.emailAddress), ia5(email))));

  const spki = seq(
    seq(oid(OID.ecPublicKey), oid(OID.prime256v1)),
    bitString(publicKey)
  );

  // attributes is [0] IMPLICIT and NOT OPTIONAL: an absent field, rather than
  // an empty one, is rejected by strict parsers including OpenSSL.
  const info = seq(int(0), seq(...rdns), spki, explicit0(new Uint8Array(0)));

  const sigDer = await signDigest(sha256(info));
  return seq(info, algIdEcdsa(), bitString(sigDer));
}

/** DER to PEM, wrapped at 64 characters the way every authority expects. */
function toPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** The request as a person will paste it into an authority's order form. */
export function csrToPem(der: Uint8Array): string {
  return toPem(der, 'CERTIFICATE REQUEST');
}
