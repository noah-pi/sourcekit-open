/**
 * Self-signed X.509 certificate (DER) for the device signing key, built with
 * a minimal hand-rolled ASN.1 writer — no native PKI dependency.
 *
 * The extension profile follows the C2PA certificate profile (spec §14.5.1,
 * as enforced by c2pa-rs): X.509 v3, EC P-256 SPKI, critical keyUsage
 * (digitalSignature + nonRepudiation), critical EKU (emailProtection — the
 * EKU C2PA's own test certs carry; `opts.eku: 'timeStamping'` swaps in the
 * RFC 3161 §2.3 TSA purpose for lab TSA fixtures), SubjectKeyIdentifier, and
 * AuthorityKeyIdentifier (required). The subject carries an Organization —
 * c2pa-rs surfaces the signer org and errors if absent.
 *
 * The certificate is self-signed: third-party verifiers will report it as
 * "untrusted" (not on the C2PA trust list) — expected and displayed
 * honestly — while the signature itself cryptographically validates.
 *
 * Pure module — no React Native dependencies.
 */

import { sha1 } from '@noble/hashes/sha1';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, asciiToBytes } from './bytes';

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
const utf8 = (s: string) => tlv(0x0c, asciiToBytes(s));
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
 * Takes the public key and a digest-signing function (rather than the private
 * key) so Secure Enclave keys — which never leave the chip — can certify
 * themselves.
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

/**
 * Extracts the 65-byte uncompressed P-256 public key from an EC certificate's
 * SPKI. Locates the prime256v1 OID and reads the BIT STRING that follows it.
 * Returns null for non-EC / non-P-256 certificates.
 */
export function ecPublicKeyFromCert(certDer: Uint8Array): Uint8Array | null {
  const curveOid = tlv(0x06, new Uint8Array(OID.prime256v1));
  outer: for (let i = 0; i + curveOid.length + 4 < certDer.length; i++) {
    for (let j = 0; j < curveOid.length; j++) {
      if (certDer[i + j] !== curveOid[j]) continue outer;
    }
    // BIT STRING follows within a few bytes (curve OID is the last SPKI alg item)
    for (let k = i + curveOid.length; k + 4 < certDer.length && k < i + curveOid.length + 8; k++) {
      if (certDer[k] === 0x03 && certDer[k + 1] === 0x42 && certDer[k + 2] === 0x00 && certDer[k + 3] === 0x04) {
        return certDer.subarray(k + 3, k + 3 + 65);
      }
    }
    return null;
  }
  return null;
}
