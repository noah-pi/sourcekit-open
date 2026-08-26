// Source Kit 0.1.0 — Minimal, strict X.509 certificate verification
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Minimal, strict X.509 certificate verification. Three callers:
 *
 *   1. App Attest chains (leaf → intermediate → pinned Apple root; ECDSA
 *      P-256 and P-384, SHA-256/384).
 *   2. TSA certificate inspection inside RFC 3161 tokens (ECDSA and RSA;
 *      FreeTSA's TSA is RSA, DigiCert's chains include RSA links).
 *   3. Org-credential chains, where anchoring is reported as self-asserted
 *      when no pinned root matches.
 *
 * "Verified" means all of:
 *   - every link's signature verifies with the next cert's public key,
 *   - issuer/subject names chain byte-for-byte,
 *   - every non-leaf has basicConstraints CA:TRUE,
 *   - no cert carries a critical extension this verifier does not consume,
 *   - a CA cert with a keyUsage extension includes keyCertSign, and a leaf
 *     never carries keyCertSign,
 *   - a basicConstraints pathLenConstraint, when present, is honored,
 *   - every cert was inside its validity window at the given time,
 *   - and the chain terminates at a pinned root when roots are supplied
 *     (anchored=false is reported, not hidden).
 *
 * Exemption: a pinned root's own validity window is not checked, since it is
 * trusted by byte-exact configuration; captures anchored during its validity
 * keep verifying after it expires.
 *
 * No network, no WebCrypto: pure parsing plus @noble and BigInt RSA.
 */

import { p256 } from '@noble/curves/p256';
import { p384 } from '@noble/curves/p384';
import { sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha2';
import { bytesToHex, bytesToUtf8, concatBytes, equalBytes, hexToBytes } from './bytes';

// ---------------------------------------------------------------------------
// TLV reader
// ---------------------------------------------------------------------------

export interface Tlv {
  tag: number;
  /** Content bytes only. */
  content: Uint8Array;
  /** Offset just past this TLV. */
  next: number;
  /** Full TLV including tag and length header: the bytes a signature covers. */
  full: Uint8Array;
}

export function readTlv(b: Uint8Array, o: number): Tlv {
  if (!Number.isInteger(o) || o < 0 || o + 2 > b.length) throw new Error('DER: truncated');
  const tag = b[o];
  let len = b[o + 1];
  let p = o + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error('DER: indefinite or oversized length');
    len = 0;
    // Multiply-accumulate, not (len << 8) | byte: JS bitwise ops are 32-bit
    // signed, so a 4-byte length >= 0x80000000 wraps negative, passes the
    // overrun guard, and points `next` backwards into an infinite walker
    // loop. Number math is exact to 2^53 and cannot wrap at n <= 4.
    for (let i = 0; i < n; i++) len = len * 256 + b[p + i];
    p += n;
  }
  if (p + len > b.length) throw new Error('DER: length overruns buffer');
  const next = p + len;
  // Unreachable with correct length math (next >= o + 2 always). Kept so a
  // parser regression fails loudly instead of hanging a walker's loop.
  if (next <= o) throw new Error('DER: non-advancing TLV');
  return { tag, content: b.subarray(p, next), next, full: b.subarray(o, next) };
}

/** Iterates the TLV children of a constructed value. */
export function tlvChildren(b: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  let o = 0;
  while (o < b.length) {
    const t = readTlv(b, o);
    out.push(t);
    o = t.next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// OIDs (content bytes, without tag/len)
// ---------------------------------------------------------------------------

const OID = {
  ecPublicKey: '2a8648ce3d0201',       // 1.2.840.10045.2.1
  p256: '2a8648ce3d030107',            // 1.2.840.10045.3.1.7 secp256r1
  p384: '2b81040022',                  // 1.3.132.0.34 secp384r1
  rsaEncryption: '2a864886f70d010101', // 1.2.840.113549.1.1.1
  rsassaPss: '2a864886f70d01010a',     // 1.2.840.113549.1.1.10 — RSA key typed for PSS (RFC 4056); same RSAPublicKey material
  ecdsaSha256: '2a8648ce3d040302',     // 1.2.840.10045.4.3.2
  ecdsaSha384: '2a8648ce3d040303',     // 1.2.840.10045.4.3.3
  ecdsaSha512: '2a8648ce3d040304',     // 1.2.840.10045.4.3.4
  rsaSha256: '2a864886f70d01010b',     // 1.2.840.113549.1.1.11
  rsaSha384: '2a864886f70d01010c',     // 1.2.840.113549.1.1.12
  rsaSha512: '2a864886f70d01010d',     // 1.2.840.113549.1.1.13
  basicConstraints: '551d13',          // 2.5.29.19
  keyUsage: '551d0f',                  // 2.5.29.15
  extKeyUsage: '551d25',               // 2.5.29.37
  org: '55040a',                       // 2.5.4.10 organizationName
  cn: '550403',                        // 2.5.4.3 commonName
} as const;

/** Apple's App Attest nonce extension: 1.2.840.113635.100.8.2 */
export const OID_APPLE_ATTEST_NONCE = '2a864886f763640802';

// ---------------------------------------------------------------------------
// Certificate parsing
// ---------------------------------------------------------------------------

export interface ParsedCert {
  der: Uint8Array;
  /** TBSCertificate TLV including header: the exact signed bytes. */
  tbsFull: Uint8Array;
  serial: Uint8Array;
  issuerRaw: Uint8Array;
  subjectRaw: Uint8Array;
  issuerOrg: string | null;
  issuerCN: string | null;
  subjectOrg: string | null;
  subjectCN: string | null;
  notBeforeMs: number;
  notAfterMs: number;
  /** Signature algorithm OID hex (ecdsaSha256/384/512, rsaSha256/384/512, rsassaPss). */
  sigAlgOid: string;
  /**
   * When sigAlgOid is RSASSA-PSS: the hash from the AlgorithmIdentifier
   * parameters (RFC 4055 §3.1). Null otherwise. SHA-1-parameterized PSS is
   * refused at parse time; SHA-1 is not evaluated.
   */
  pssHash: 'sha256' | 'sha384' | 'sha512' | null;
  /** Signature value (BIT STRING payload, unused-bits byte stripped). */
  signature: Uint8Array;
  keyAlg:
    | { kind: 'ec'; curve: 'p256' | 'p384'; point: Uint8Array }
    | { kind: 'rsa'; n: bigint; e: bigint };
  /** Extensions: OID hex to extnValue content (the OCTET STRING's payload). */
  extensions: Map<string, { critical: boolean; value: Uint8Array }>;
}

function readName(b: Uint8Array): { org: string | null; cn: string | null } {
  let org: string | null = null;
  let cn: string | null = null;
  let o = 0;
  while (o < b.length) {
    const set = readTlv(b, o);
    o = set.next;
    const seq = readTlv(set.content, 0);
    const oidTlv = readTlv(seq.content, 0);
    const valTlv = readTlv(seq.content, oidTlv.next);
    const hex = bytesToHex(oidTlv.content);
    const text = bytesToUtf8(valTlv.content);
    if (hex === OID.org) org = text;
    if (hex === OID.cn) cn = text;
  }
  return { org, cn };
}

function readTimeMs(b: Uint8Array): number {
  const tlv = readTlv(b, 0);
  const s = bytesToUtf8(tlv.content);
  if (tlv.tag === 0x18) {
    // GeneralizedTime YYYYMMDDHHMMSSZ
    return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`);
  }
  // UTCTime YYMMDDHHMMSSZ
  const yy = parseInt(s.slice(0, 2), 10);
  const yyyy = yy < 50 ? 2000 + yy : 1900 + yy;
  return Date.parse(`${yyyy}-${s.slice(2, 4)}-${s.slice(4, 6)}T${s.slice(6, 8)}:${s.slice(8, 10)}:${s.slice(10, 12)}Z`);
}

function parseSpki(spki: Uint8Array): ParsedCert['keyAlg'] {
  const algId = readTlv(spki, 0);
  const algOid = readTlv(algId.content, 0);
  const algHex = bytesToHex(algOid.content);
  const bitString = readTlv(spki, algId.next);
  if (bitString.tag !== 0x03) throw new Error('DER: SPKI missing BIT STRING');
  const keyBytes = bitString.content.subarray(1); // strip unused-bits byte

  if (algHex === OID.ecPublicKey) {
    const curveTlv = readTlv(algId.content, algOid.next);
    const curveHex = bytesToHex(curveTlv.content);
    const curve = curveHex === OID.p256 ? 'p256' : curveHex === OID.p384 ? 'p384' : null;
    if (!curve) throw new Error(`unsupported EC curve OID ${curveHex}`);
    const expectedLen = curve === 'p256' ? 65 : 97;
    if (keyBytes.length !== expectedLen || keyBytes[0] !== 0x04) {
      throw new Error('EC key is not an uncompressed point');
    }
    return { kind: 'ec', curve, point: keyBytes };
  }
  // id-RSASSA-PSS as the key type (Adobe's C2PA certs) carries the same
  // RSAPublicKey (n, e) as rsaEncryption, per RFC 4056 §1.2. Its params only
  // restrict which PSS variant the key is for; the COSE alg header governs
  // here and a mismatch fails the signature check.
  if (algHex === OID.rsaEncryption || algHex === OID.rsassaPss) {
    const seq = readTlv(keyBytes, 0);
    const nTlv = readTlv(seq.content, 0);
    const eTlv = readTlv(seq.content, nTlv.next);
    const toBigInt = (v: Uint8Array) => BigInt('0x' + (bytesToHex(v) || '0'));
    const n = toBigInt(nTlv.content);
    const e = toBigInt(eTlv.content);
    // Parameter sanity: e=1 makes RSA verification a no-op and toy moduli
    // are factorable. Reachable only through unanchored chains, but fails
    // closed here so a future trust list cannot inherit the hole.
    if (e < 3n || (e & 1n) === 0n) throw new Error(`RSA public exponent ${e} is not acceptable`);
    if (n < (1n << 2047n)) throw new Error('RSA modulus is smaller than 2048 bits');
    return { kind: 'rsa', n, e };
  }
  throw new Error(`unsupported public key algorithm OID ${algHex}`);
}

/**
 * Extracts only the SubjectPublicKeyInfo from a DER certificate: no chain
 * semantics, no critical-extension policy, no validity windows. Use it when
 * the certificate merely names a key (a COSE x5chain leaf), since strict
 * parseCertificate rejects certs signed with algorithms not chain-verified
 * here even when the key is readable. Trust decisions still need the strict
 * path.
 */
export function publicKeyFromCert(der: Uint8Array): ParsedCert['keyAlg'] | null {
  try {
    const cert = readTlv(der, 0);
    if (cert.tag !== 0x30) return null;
    const tbs = readTlv(cert.content, 0);
    if (tbs.tag !== 0x30) return null;
    // TBSCertificate fields in order: [0]-explicit version (optional), then
    // serialNumber, signature, issuer, validity, subject, subjectPublicKeyInfo.
    let cur = readTlv(tbs.content, 0);
    if (cur.tag === 0xa0) cur = readTlv(tbs.content, cur.next); // skip version
    for (let i = 0; i < 5; i++) cur = readTlv(tbs.content, cur.next); // serial…subject
    if (cur.tag !== 0x30) return null;
    return parseSpki(cur.content);
  } catch {
    return null;
  }
}

/** Parses one DER certificate. Throws on anything malformed or unsupported. */
export function parseCertificate(der: Uint8Array): ParsedCert {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error('not a certificate');
  const tbs = readTlv(cert.content, 0);
  if (tbs.tag !== 0x30) throw new Error('bad TBSCertificate');
  const outerSigAlg = readTlv(cert.content, tbs.next);
  const outerSig = readTlv(cert.content, outerSigAlg.next);
  if (outerSig.tag !== 0x03) throw new Error('bad signature BIT STRING');
  const sigAlgOid = bytesToHex(readTlv(outerSigAlg.content, 0).content);
  // SHA-512 is required: FreeTSA signs its TSA certs with
  // sha512WithRSAEncryption, and rejecting the OID here drops every FreeTSA
  // certificate, red-rungging genuine FreeTSA-stamped assets.
  const SUPPORTED: string[] = [
    OID.ecdsaSha256, OID.ecdsaSha384, OID.ecdsaSha512,
    OID.rsaSha256, OID.rsaSha384, OID.rsaSha512,
    // RSASSA-PSS: Adobe's 2022-era C2PA chains are signed PSS-4096, and
    // c2pa-rs verifies them.
    OID.rsassaPss,
  ];
  if (!SUPPORTED.includes(sigAlgOid)) {
    throw new Error(`unsupported signature algorithm OID ${sigAlgOid}`);
  }

  // RSASSA-PSS parameters (RFC 4055 §3.1): RSASSA-PSS-params ::= SEQUENCE {
  //   hashAlgorithm      [0] AlgorithmIdentifier DEFAULT sha1,
  //   maskGenAlgorithm   [1] AlgorithmIdentifier DEFAULT mgf1SHA1,
  //   saltLength         [2] INTEGER DEFAULT 20,
  //   trailerField       [3] INTEGER DEFAULT 1 }
  // The declared hash is extracted here; salt length is recovered at verify
  // time (verifyRsaPss) and MGF1 must pair with the same hash. The RFC
  // default is SHA-1, which is refused at parse rather than downgraded.
  let pssHash: ParsedCert['pssHash'] = null;
  if (sigAlgOid === OID.rsassaPss) {
    const PSS_HASH: Record<string, 'sha256' | 'sha384' | 'sha512'> = {
      '608648016503040201': 'sha256',
      '608648016503040202': 'sha384',
      '608648016503040203': 'sha512',
    };
    const oidAfter = readTlv(outerSigAlg.content, 0).next;
    if (oidAfter >= outerSigAlg.content.length) {
      throw new Error('RSASSA-PSS parameters absent (defaults are SHA-1, unsupported here)');
    }
    const params = readTlv(outerSigAlg.content, oidAfter);
    if (params.tag !== 0x30) throw new Error('RSASSA-PSS parameters are not a SEQUENCE');
    let hashOid: string | null = null;
    let mgfHashOid: string | null = null;
    let po = 0;
    while (po < params.content.length) {
      const f = readTlv(params.content, po);
      po = f.next;
      if (f.tag === 0xa0) {
        const alg = readTlv(f.content, 0);
        hashOid = bytesToHex(readTlv(alg.content, 0).content);
      } else if (f.tag === 0xa1) {
        const alg = readTlv(f.content, 0);
        const mgfOid = bytesToHex(readTlv(alg.content, 0).content);
        if (mgfOid !== '2a864886f70d010108') { // id-mgf1
          throw new Error(`RSASSA-PSS mask generation function is not MGF1 (${mgfOid})`);
        }
        const inner = readTlv(alg.content, readTlv(alg.content, 0).next);
        if (inner.tag === 0x30) mgfHashOid = bytesToHex(readTlv(inner.content, 0).content);
      }
    }
    if (!hashOid) throw new Error('RSASSA-PSS hashAlgorithm absent (default is SHA-1, unsupported here)');
    if (mgfHashOid && mgfHashOid !== hashOid) {
      throw new Error(`RSASSA-PSS MGF1 hash (${mgfHashOid}) differs from the signature hash (${hashOid})`);
    }
    pssHash = PSS_HASH[hashOid] ?? null;
    if (!pssHash) throw new Error(`unsupported RSASSA-PSS hash OID ${hashOid}`);
  }

  // TBSCertificate fields, in order.
  let o = 0;
  let tlv = readTlv(tbs.content, o);
  if (tlv.tag === 0xa0) { o = tlv.next; tlv = readTlv(tbs.content, o); } // [0] version
  const serial = tlv.content; o = tlv.next;
  o = readTlv(tbs.content, o).next; // signature algid (redundant with outer)
  const issuerTlv = readTlv(tbs.content, o); o = issuerTlv.next;
  const validity = readTlv(tbs.content, o); o = validity.next;
  const notBeforeMs = readTimeMs(validity.content);
  const notAfterMs = readTimeMs(validity.content.subarray(readTlv(validity.content, 0).next));
  // Date.parse yields NaN for garbage dates, and every NaN comparison is
  // false, so verifyChain's validity window would pass. Refuse to parse.
  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(notAfterMs)) {
    throw new Error('DER: unparseable validity dates');
  }
  const subjectTlv = readTlv(tbs.content, o); o = subjectTlv.next;
  const spkiTlv = readTlv(tbs.content, o); o = spkiTlv.next;

  // Optional [1] issuerUniqueID, [2] subjectUniqueID, then [3] extensions.
  const extensions = new Map<string, { critical: boolean; value: Uint8Array }>();
  while (o < tbs.content.length) {
    const opt = readTlv(tbs.content, o);
    o = opt.next;
    if (opt.tag === 0xa3) {
      const seq = readTlv(opt.content, 0);
      let eo = 0;
      while (eo < seq.content.length) {
        const ext = readTlv(seq.content, eo);
        eo = ext.next;
        const oidTlv = readTlv(ext.content, 0);
        let valOff = oidTlv.next;
        let critical = false;
        const maybeBool = readTlv(ext.content, valOff);
        if (maybeBool.tag === 0x01) {
          critical = maybeBool.content[0] !== 0;
          valOff = maybeBool.next;
        }
        const valTlv = readTlv(ext.content, valOff);
        if (valTlv.tag !== 0x04) throw new Error('extnValue is not an OCTET STRING');
        extensions.set(bytesToHex(oidTlv.content), { critical, value: valTlv.content });
      }
    }
  }

  const issuer = readName(issuerTlv.content);
  const subject = readName(subjectTlv.content);
  return {
    der,
    tbsFull: tbs.full,
    serial,
    issuerRaw: issuerTlv.full,
    subjectRaw: subjectTlv.full,
    issuerOrg: issuer.org,
    issuerCN: issuer.cn,
    subjectOrg: subject.org,
    subjectCN: subject.cn,
    notBeforeMs,
    notAfterMs,
    sigAlgOid,
    pssHash,
    signature: outerSig.content.subarray(1),
    keyAlg: parseSpki(spkiTlv.content),
    extensions,
  };
}

// ---------------------------------------------------------------------------
// Signature verification (ECDSA P-256/P-384, RSA PKCS#1 v1.5)
// ---------------------------------------------------------------------------

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** EMSA-PKCS1-v1_5 DigestInfo prefixes. */
const DIGEST_INFO_PREFIX: Record<string, string> = {
  [OID.rsaSha256]: '3031300d060960864801650304020105000420',
  [OID.rsaSha384]: '3041300d060960864801650304020205000430',
  [OID.rsaSha512]: '3051300d060960864801650304020305000440',
};

const RSA_DIGEST: Record<string, (m: Uint8Array) => Uint8Array> = {
  [OID.rsaSha256]: sha256,
  [OID.rsaSha384]: sha384,
  [OID.rsaSha512]: sha512,
};

/**
 * Verifies a signature over `message` with the given key. Used for both
 * certificate chains (message = child TBS) and CMS signerInfos. Low-S is not
 * enforced; CAs are not bound by this codebase's canonicalization.
 */
export function verifySignatureWithKey(
  key: ParsedCert['keyAlg'],
  sigAlgOid: string,
  message: Uint8Array,
  signature: Uint8Array,
  pssHash: 'sha256' | 'sha384' | 'sha512' | null = null,
): boolean {
  try {
    // RSASSA-PSS: verified by EMSA-PSS-VERIFY with salt-length recovery;
    // the hash comes from the certificate's algorithm parameters.
    if (sigAlgOid === OID.rsassaPss) {
      if (key.kind !== 'rsa' || !pssHash) return false;
      return verifyRsaPss(key, pssHash, message, signature);
    }
    if (key.kind === 'ec') {
      const curve = key.curve === 'p256' ? p256 : p384;
      if (sigAlgOid === OID.ecdsaSha256) {
        return curve.verify(signature, sha256(message), key.point, { format: 'der', lowS: false });
      }
      if (sigAlgOid === OID.ecdsaSha384) {
        return curve.verify(signature, sha384(message), key.point, { format: 'der', lowS: false });
      }
      if (sigAlgOid === OID.ecdsaSha512) {
        return curve.verify(signature, sha512(message), key.point, { format: 'der', lowS: false });
      }
      return false;
    }
    // RSA PKCS#1 v1.5: EM = 0x00 01 FF…FF 00 DigestInfo‖H
    const prefix = DIGEST_INFO_PREFIX[sigAlgOid];
    const hashFn = RSA_DIGEST[sigAlgOid];
    if (!prefix || !hashFn) return false;
    const digest = hashFn(message);
    const k = Math.ceil(key.n.toString(2).length / 8); // modulus length in bytes
    if (signature.length !== k) return false;
    const s = BigInt('0x' + bytesToHex(signature));
    if (s >= key.n) return false;
    const m = modpow(s, key.e, key.n);
    const emHex = m.toString(16).padStart(k * 2, '0');
    const tHex = prefix + bytesToHex(digest);
    const psLen = k - tHex.length / 2 - 3;
    if (psLen < 8) return false;
    const expected = '0001' + 'ff'.repeat(psLen) + '00' + tHex;
    return emHex === expected;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// RSASSA-PSS (RFC 8017 §9.1.2): COSE PS256/PS384/PS512, used by foreign C2PA
// signers. Pure BigInt, no WebCrypto.
// ---------------------------------------------------------------------------

const PSS_DIGEST: Record<string, (m: Uint8Array) => Uint8Array> = {
  sha256,
  sha384,
  sha512,
};

/** MGF1 (RFC 8017 §B.2.1) over the given hash. */
function mgf1(seed: Uint8Array, maskLen: number, hashFn: (m: Uint8Array) => Uint8Array): Uint8Array {
  const hLen = hashFn(new Uint8Array(0)).length;
  const out = new Uint8Array(maskLen);
  let done = 0;
  for (let counter = 0; done < maskLen; counter++) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, counter, false);
    const h = hashFn(concatBytes(seed, c));
    out.set(h.subarray(0, Math.min(hLen, maskLen - done)), done);
    done += hLen;
  }
  return out;
}

/**
 * RSASSA-PSS verify (EMSA-PSS-VERIFY) with salt-length recovery: the salt
 * length is read back from the encoding (OpenSSL RSA_PSS_SALTLEN_AUTO
 * semantics) rather than assumed. The final H === H′ comparison binds the
 * recovered salt, so a wrong split fails.
 */
export function verifyRsaPss(
  key: { n: bigint; e: bigint },
  hashName: 'sha256' | 'sha384' | 'sha512',
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const hashFn = PSS_DIGEST[hashName];
    const hLen = hashFn(new Uint8Array(0)).length;
    const modBits = key.n.toString(2).length;
    const k = Math.ceil(modBits / 8);
    if (signature.length !== k) return false;
    const s = BigInt('0x' + bytesToHex(signature));
    if (s >= key.n) return false;
    const m = modpow(s, key.e, key.n);
    const emBits = modBits - 1;
    const emLen = Math.ceil(emBits / 8);
    if (emLen < hLen + 2) return false;
    const em = hexToBytes(m.toString(16).padStart(k * 2, '0')).subarray(k - emLen); // I2OSP(m, emLen)
    if (em[emLen - 1] !== 0xbc) return false;
    const maskedDB = em.subarray(0, emLen - hLen - 1);
    const H = em.subarray(emLen - hLen - 1, emLen - 1);
    const unusedBits = 8 * emLen - emBits;
    if (unusedBits > 0 && (maskedDB[0] & (0xff << (8 - unusedBits))) !== 0) return false;
    const dbMask = mgf1(H, emLen - hLen - 1, hashFn);
    const DB = new Uint8Array(maskedDB.length);
    for (let i = 0; i < DB.length; i++) DB[i] = maskedDB[i] ^ dbMask[i];
    if (unusedBits > 0) DB[0] &= 0xff >>> unusedBits;
    // Zero padding, then a single 0x01 separator, then the salt (recovered length).
    let sep = -1;
    for (let i = 0; i < DB.length; i++) {
      if (DB[i] === 0x00) continue;
      if (DB[i] === 0x01) sep = i;
      break;
    }
    if (sep < 0 || sep + 1 >= DB.length) return false;
    const salt = DB.subarray(sep + 1);
    const mHash = hashFn(message);
    const hPrime = hashFn(concatBytes(new Uint8Array(8), mHash, salt));
    return equalBytes(hPrime, H);
  } catch {
    return false;
  }
}

/** Verifies that `parent` signed `child`. */
export function verifyCertSignature(child: ParsedCert, parent: ParsedCert): boolean {
  return verifySignatureWithKey(parent.keyAlg, child.sigAlgOid, child.tbsFull, child.signature, child.pssHash);
}

/** id-kp-timeStamping. RFC 3161 §2.3 requires this EKU on TSA certs. */
export const OID_KP_TIME_STAMPING = '2b06010505070308';

/**
 * True when the cert's Extended Key Usage includes the given KeyPurposeId
 * (hex OID content). Missing or malformed EKU returns false.
 */
export function hasKeyPurpose(cert: ParsedCert, purposeOidHex: string): boolean {
  const ext = cert.extensions.get(OID.extKeyUsage);
  if (!ext) return false;
  try {
    const seq = readTlv(ext.value, 0);
    if (seq.tag !== 0x30) return false;
    let o = 0;
    while (o < seq.content.length) {
      const oidTlv = readTlv(seq.content, o);
      o = oidTlv.next;
      if (bytesToHex(oidTlv.content) === purposeOidHex) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Parses basicConstraints: { cA BOOLEAN DEFAULT FALSE, pathLenConstraint
 * INTEGER OPTIONAL }. Returns null when the extension is absent or
 * malformed; callers treat null as "not a CA".
 */
export function basicConstraints(cert: ParsedCert): { ca: boolean; pathLen: number | null } | null {
  const ext = cert.extensions.get(OID.basicConstraints);
  if (!ext) return null;
  try {
    const seq = readTlv(ext.value, 0);
    if (seq.content.length === 0) return { ca: false, pathLen: null };
    const first = readTlv(seq.content, 0);
    let ca = false;
    let o = 0;
    if (first.tag === 0x01) { ca = first.content[0] === 0xff; o = first.next; }
    let pathLen: number | null = null;
    if (o < seq.content.length) {
      const pl = readTlv(seq.content, o);
      if (pl.tag === 0x02) {
        pathLen = 0;
        for (const byte of pl.content) pathLen = pathLen * 256 + byte;
      }
    }
    return { ca, pathLen };
  } catch {
    return null;
  }
}

/** True when basicConstraints marks this cert a CA (critical or not). */
export function isCa(cert: ParsedCert): boolean {
  return basicConstraints(cert)?.ca ?? false;
}

/**
 * The keyUsage bits of a cert (first content byte of the BIT STRING, where
 * every bit this verifier reads lives), or null when the extension is
 * absent or malformed. Absent keyUsage is unrestricted per RFC 5280, so
 * callers must distinguish null from 0.
 */
export function keyUsageBits(cert: ParsedCert): number | null {
  const ext = cert.extensions.get(OID.keyUsage);
  if (!ext) return null;
  try {
    const bs = readTlv(ext.value, 0);
    if (bs.tag !== 0x03 || bs.content.length < 2) return null;
    return bs.content[1];
  } catch {
    return null;
  }
}

/** keyCertSign: KeyUsage bit 5 (RFC 5280 §4.2.1.3). */
const KEY_CERT_SIGN = 0x04;

/**
 * Critical extensions this verifier accepts. basicConstraints and keyUsage
 * are enforced during chain verification. extKeyUsage is accepted without
 * enforcement, so a future constraining critical EKU would pass unhonored.
 * Any other critical extension fails the chain (RFC 5280 §4.2), including
 * critical subjectKeyIdentifier/authorityKeyIdentifier, which RFC 5280
 * requires to be non-critical.
 */
const RECOGNIZED_CRITICAL_EXTENSIONS: Set<string> = new Set([
  OID.basicConstraints,
  OID.keyUsage,
  OID.extKeyUsage,
]);

/** Renders an OID's content bytes in dotted form for reason strings. */
function oidHexToDotted(hex: string): string {
  try {
    const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
    const first = Math.min(bytes[0] / 40 | 0, 2);
    const parts: number[] = [first, first === 2 ? bytes[0] - 80 : bytes[0] % 40];
    let acc = 0;
    for (const b of bytes.slice(1)) {
      acc = acc * 128 + (b & 0x7f);
      if (!(b & 0x80)) { parts.push(acc); acc = 0; }
    }
    return parts.join('.');
  } catch {
    return hex;
  }
}

// ---------------------------------------------------------------------------
// Chain verification
// ---------------------------------------------------------------------------

export interface ChainResult {
  /** Every link sound: signatures, name chaining, CA flags, validity. */
  linksValid: boolean;
  /** Terminated at one of the supplied pinned roots. */
  anchored: boolean;
  /** Subject of the topmost cert in the presented chain (display). */
  topSubject: string | null;
  /** Failure reason, null when linksValid. */
  reason: string | null;
  linkCount: number;
  /**
   * Whether the chain was actually evaluated. False when a certificate could
   * not be parsed or uses an unimplemented algorithm: a verifier limitation,
   * not tamper evidence, so the UI renders checked:false neutral.
   */
  checked: boolean;
}

function displayName(c: { subjectOrg: string | null; subjectCN: string | null }): string | null {
  return c.subjectOrg ?? c.subjectCN;
}

/**
 * Orders a certificate set leaf-to-top by issuer/subject matching. The leaf
 * is the unique cert no other cert in the set names as its issuer (ties go
 * to the non-CA). The walk stops at a self-signed cert or when the issuer is
 * not in the set; partial chains are allowed, anchoring is the caller's
 * question. Returns null when the set is ambiguous.
 */
function orderByIssuer(certs: ParsedCert[]): ParsedCert[] | null {
  const leaves = certs.filter((c) => !certs.some((p) => p !== c && equalBytes(p.issuerRaw, c.subjectRaw)));
  let leaf: ParsedCert | undefined;
  if (leaves.length === 1) leaf = leaves[0];
  else {
    const nonCa = leaves.filter((c) => !isCa(c));
    if (nonCa.length === 1) leaf = nonCa[0];
  }
  if (!leaf) return null;

  const ordered: ParsedCert[] = [leaf];
  const used = new Set<ParsedCert>([leaf]);
  for (;;) {
    const cur = ordered[ordered.length - 1];
    if (equalBytes(cur.issuerRaw, cur.subjectRaw)) break; // self-signed top
    const nexts = certs.filter((c) => !used.has(c) && equalBytes(c.subjectRaw, cur.issuerRaw));
    if (nexts.length > 1) return null; // ambiguous — refuse to guess
    if (nexts.length === 0) break;     // partial chain ends here
    ordered.push(nexts[0]);
    used.add(nexts[0]);
    if (used.size === certs.length) break;
  }
  // Any cert the walk never reached is unrelated baggage; extras would skip
  // validity checks.
  return used.size === certs.length ? ordered : null;
}

/**
 * Verifies a presented chain: chain[0] is the leaf, each cert signed by the
 * next. When `pinnedRoots` is non-empty, the last presented cert must be
 * signed by (or be) one of them. `atMs` is the validity reference time: pass
 * the verified signing time when one exists, never the verifier's clock, or
 * null to skip validity and report it as not performed.
 */
export function verifyChain(
  chainDer: Uint8Array[],
  pinnedRoots: Uint8Array[] = [],
  atMs: number | null = null,
): ChainResult {
  let certs: ParsedCert[];
  try {
    certs = chainDer.map(parseCertificate);
  } catch (e) {
    return { linksValid: false, anchored: false, topSubject: null, reason: `certificate failed to parse: ${(e as Error).message}`, linkCount: 0, checked: false };
  }
  if (certs.length === 0) return { linksValid: false, anchored: false, topSubject: null, reason: 'empty chain', linkCount: 0, checked: false };

  // Senders sometimes include the same cert twice (a TSA sending its cert as
  // both signer and chain). Dedupe so a duplicated self-signed end-entity
  // cert is not mistaken for a two-cert chain needing a CA flag on itself.
  certs = certs.filter((c, i) => certs.findIndex((p) => equalBytes(p.der, c.der)) === i);

  // CMS `certificates` is a SET OF and unordered (DigiCert tokens arrive
  // that way), so rebuild leaf-to-top by issuer/subject lookup.
  {
    const ordered = orderByIssuer(certs);
    if (!ordered) {
      return { linksValid: false, anchored: false, topSubject: null, reason: 'certificate set could not be ordered by issuer/subject', linkCount: certs.length, checked: true };
    }
    certs = ordered;
  }

  for (let i = 0; i < certs.length; i++) {
    const c = certs[i];
    const fail = (reason: string): ChainResult => ({ linksValid: false, anchored: false, topSubject: displayName(certs[certs.length - 1]), reason, linkCount: certs.length, checked: true });
    if (atMs !== null && (atMs < c.notBeforeMs || atMs > c.notAfterMs)) {
      return fail(`${displayName(c) ?? 'a certificate'} was not valid at signing time`);
    }
    // Fail closed on unrecognized critical extensions (RFC 5280 §4.2). The
    // leaf additionally allows the Apple App Attest nonce extension, which
    // is consumed during attestation checks.
    for (const [oidHex, ext] of c.extensions) {
      if (!ext.critical) continue;
      if (RECOGNIZED_CRITICAL_EXTENSIONS.has(oidHex)) continue;
      if (i === 0 && oidHex === OID_APPLE_ATTEST_NONCE) continue;
      return fail(`${displayName(c) ?? 'a certificate'} carries a critical extension (${oidHexToDotted(oidHex)}) this verifier does not recognize; refusing to guess its meaning`);
    }
    // Key-usage discipline (RFC 5280 §4.2.1.3): keyCertSign is forbidden on
    // leaves, and a CA with a keyUsage extension must include it.
    // Single-certificate chains are exempt from the leaf check, since a
    // presented pinned root legitimately carries keyCertSign.
    const ku = keyUsageBits(c);
    if (i === 0 && certs.length > 1 && ku !== null && (ku & KEY_CERT_SIGN) !== 0) {
      return fail(`the leaf certificate's key usage permits signing other certificates; a leaf must not`);
    }
    const parent: ParsedCert | undefined = certs[i + 1];
    if (parent) {
      if (!equalBytes(c.issuerRaw, parent.subjectRaw)) {
        return fail('issuer/subject names do not chain');
      }
      if (!isCa(parent)) {
        return fail(`${displayName(parent) ?? 'the issuing certificate'} is not marked as a CA`);
      }
      const parentKu = keyUsageBits(parent);
      if (parentKu !== null && (parentKu & KEY_CERT_SIGN) === 0) {
        return fail(`${displayName(parent) ?? 'the issuing certificate'} is a CA but its key usage does not permit certificate signing`);
      }
      // pathLenConstraint: a CA at depth i has i-1 subordinate CAs below
      // it in this chain; the constraint caps exactly that count.
      const pl = basicConstraints(parent)?.pathLen ?? null;
      if (pl !== null && i > pl) {
        return fail(`${displayName(parent) ?? 'a CA certificate'} allows at most ${pl} subordinate CA certificate(s); this chain presents ${i}`);
      }
      if (!verifyCertSignature(c, parent)) {
        return fail(`signature on ${displayName(c) ?? 'certificate'} does not verify`);
      }
    }
  }

  const last = certs[certs.length - 1];
  let anchored = pinnedRoots.length === 0 ? false : equalBytes(last.issuerRaw, last.subjectRaw) && pinnedRoots.some((r) => equalBytes(r, last.der));
  if (!anchored) {
    for (const rootDer of pinnedRoots) {
      try {
        const root = parseCertificate(rootDer);
        if (equalBytes(last.issuerRaw, root.subjectRaw) && verifyCertSignature(last, root)) {
          anchored = true;
          break;
        }
      } catch { /* try next root */ }
    }
  }
  if (pinnedRoots.length > 0 && !anchored) {
    return { linksValid: true, anchored: false, topSubject: displayName(last), reason: 'chain does not reach a trusted root', linkCount: certs.length, checked: true };
  }
  return { linksValid: true, anchored, topSubject: displayName(last), reason: null, linkCount: certs.length, checked: true };
}
