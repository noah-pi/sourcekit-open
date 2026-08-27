// Source Kit 0.1.0 — RFC 3161 TimeStampToken verification over CMS/PKCS#7
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RFC 3161 TimeStampToken verification over CMS/PKCS#7. Four checks per
 * token, numbered in the code below:
 *   1. TSTInfo messageImprint matches the hash of the timestamped bytes
 *      (the C2PA CounterSignature over the COSE signature).
 *   2. CMS signedAttributes messageDigest matches the TSTInfo hash.
 *   3. The TSA signature verifies under the TSA certificate's key
 *      (ECDSA P-256/P-384 or RSA PKCS#1 v1.5).
 *   4. genTime comes from the parsed TSTInfo and the TSA cert was valid at
 *      that genTime.
 *
 * Root anchoring is not performed here; the report names the TSA from its
 * certificate. Pinning lives in src/lib/tsaTrustList.ts.
 */

import { sha256 } from '@noble/hashes/sha256';
import { sha384, sha512 } from '@noble/hashes/sha2';
import { bytesToHex, bytesToUtf8, equalBytes } from './bytes';
import { hasKeyPurpose, OID_KP_TIME_STAMPING, parseCertificate, readTlv, verifyChain, verifySignatureWithKey, type ParsedCert } from './x509';

const OID_SIGNED_DATA = '2a864886f70d010702';     // 1.2.840.113549.1.7.2
const OID_TST_INFO = '2a864886f70d0109100104';    // 1.2.840.113549.1.9.16.1.4
const OID_MESSAGE_DIGEST = '2a864886f70d010904';  // 1.2.840.113549.1.9.4
const OID_RSA_ENCRYPTION = '2a864886f70d010101';  // 1.2.840.113549.1.1.1
const OID_RSA_SHA256 = '2a864886f70d01010b';      // 1.2.840.113549.1.1.11
const OID_RSA_SHA384 = '2a864886f70d01010c';      // 1.2.840.113549.1.1.12
const OID_RSA_SHA512 = '2a864886f70d01010d';      // 1.2.840.113549.1.1.13
const OID_SHA256 = '608648016503040201';          // 2.16.840.1.101.3.4.2.1
const OID_SHA384 = '608648016503040202';          // 2.16.840.1.101.3.4.2.2
const OID_SHA512 = '608648016503040203';          // 2.16.840.1.101.3.4.2.3

/** CMS digestAlgorithm → hash. The CMS layer's digest can differ from the
 * imprint digest (FreeTSA uses SHA-512 with a SHA-256 imprint), so it is
 * always read from the token. */
const CMS_DIGEST: Record<string, (m: Uint8Array) => Uint8Array> = {
  [OID_SHA256]: sha256,
  [OID_SHA384]: sha384,
  [OID_SHA512]: sha512,
};

export interface TimestampVerification {
  /** All cryptographic checks passed. */
  tokenValid: boolean;
  /** Failure reason in plain English (null when valid). */
  reason: string | null;
  /** genTime from the verified TSTInfo, ISO — null unless tokenValid. */
  genTimeUtc: string | null;
  /** TSA display name from the signing certificate. */
  tsaName: string | null;
  /** Whether the TSA certificate chain's links verify (anchoring NOT claimed). */
  tsaChainLinksValid: boolean | null;
  /**
   * SHA-256 (hex) of every certificate DER embedded in the token, signer
   * first — the input to TSA trust pinning (src/lib/tsaTrustList.ts). Empty
   * when no certificates parsed. Present even on late failures, for forensics.
   */
  tsaFingerprints: string[];
  /**
   * Whether this verifier actually EVALUATED the token. False when the blob
   * could not be parsed or uses a structure/algorithm we do not implement —
   * that is a limitation of this verifier, never tamper evidence. Only a
   * token we fully parsed and cryptographically failed (checked=true,
   * tokenValid=false) may turn a rung red.
   */
  checked: boolean;
}

const FAIL = (reason: string, tsaFingerprints: string[] = []): TimestampVerification =>
  ({ tokenValid: false, reason, genTimeUtc: null, tsaName: null, tsaChainLinksValid: null, tsaFingerprints, checked: true });

/** A gap in this parser's coverage. Neutral, not a red rung. */
const UNCHECKED = (reason: string): TimestampVerification =>
  ({ tokenValid: false, reason, genTimeUtc: null, tsaName: null, tsaChainLinksValid: null, tsaFingerprints: [], checked: false });

/**
 * Unwraps the RFC 3161 §2.4.2 TimeStampResp envelope
 * (SEQUENCE { status PKIStatusInfo, timeStampToken ContentInfo }); a bare
 * ContentInfo passes straight through. The wrapper is detected by a leading
 * SEQUENCE carrying a status INTEGER, and the status must be granted or
 * grantedWithMods.
 *
 * Returns the ContentInfo bytes, or null with `reason` when the status is a
 * rejection or waiting state, which is unchecked rather than a failure.
 */
export function unwrapTimestampResponse(
  token: Uint8Array,
): { contentInfo: Uint8Array } | { contentInfo: null; reason: string } {
  try {
    const outer = readTlv(token, 0);
    const first = readTlv(outer.content, 0);
    if (first.tag === 0x06) return { contentInfo: token }; // bare ContentInfo
    if (first.tag !== 0x30) return { contentInfo: token }; // let the parser below report it
    // PKIStatusInfo ::= SEQUENCE { status INTEGER, ... }
    const statusTlv = readTlv(first.content, 0);
    if (statusTlv.tag !== 0x02) return { contentInfo: token };
    const status = statusTlv.content.length === 1 ? statusTlv.content[0] : -1;
    if (status === 0 || status === 1) {
      const inner = readTlv(outer.content, first.next);
      if (inner.tag !== 0x30) return { contentInfo: null, reason: 'TimeStampResp grants a token but none is attached' };
      return { contentInfo: inner.full };
    }
    const STATUS_NAMES: Record<number, string> = {
      2: 'rejection', 3: 'waiting', 4: 'revocationWarning', 5: 'revocationNotification',
    };
    return {
      contentInfo: null,
      reason: `the TSA response carries status "${STATUS_NAMES[status] ?? status}", not a timestamp`,
    };
  } catch {
    return { contentInfo: token }; // malformed here → the parser below reports it
  }
}

/**
 * Verifies one TimeStampToken (CMS ContentInfo) against the exact message it
 * should imprint. Never throws; a bad token is returned as a result.
 */
export function verifyTimestampToken(token: Uint8Array, expectedMessage: Uint8Array): TimestampVerification {
  try {
    const unwrapped = unwrapTimestampResponse(token);
    if (!unwrapped.contentInfo) return UNCHECKED(unwrapped.reason);
    // ContentInfo → [0] SignedData
    const ci = readTlv(unwrapped.contentInfo, 0);
    const ciOid = readTlv(ci.content, 0);
    if (bytesToHex(ciOid.content) !== OID_SIGNED_DATA) return UNCHECKED('not a CMS SignedData');
    const sdWrap = readTlv(ci.content, ciOid.next);
    const sd = readTlv(sdWrap.content, 0);

    // SignedData fields
    let o = 0;
    o = readTlv(sd.content, o).next; // version
    o = readTlv(sd.content, o).next; // digestAlgorithms
    const encap = readTlv(sd.content, o); o = encap.next;
    const encapOid = readTlv(encap.content, 0);
    if (bytesToHex(encapOid.content) !== OID_TST_INFO) return UNCHECKED('CMS content is not a TSTInfo');
    const encapContent = readTlv(encap.content, encapOid.next); // [0] EXPLICIT OCTET STRING
    const tstOctets = readTlv(encapContent.content, 0);
    if (tstOctets.tag !== 0x04) return UNCHECKED('TSTInfo missing');

    // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serial, genTime, … }
    const tst = readTlv(tstOctets.content, 0);
    let t = 0;
    t = readTlv(tst.content, t).next; // version
    t = readTlv(tst.content, t).next; // policy OID
    const imprint = readTlv(tst.content, t); t = imprint.next;
    const imprintAlg = readTlv(imprint.content, 0);
    const imprintAlgOid = readTlv(imprintAlg.content, 0);
    const imprintHash = readTlv(imprint.content, imprintAlg.next);
    // The imprint hash is whatever the requester asked the TSA for. The SHA-2
    // family is supported; anything else is unchecked, not a failure.
    const imprintHashFn = CMS_DIGEST[bytesToHex(imprintAlgOid.content)];
    if (!imprintHashFn) return UNCHECKED(`messageImprint uses an unsupported hash (${bytesToHex(imprintAlgOid.content)})`);
    const serialTlv = readTlv(tst.content, t); t = serialTlv.next; // serialNumber
    const genTimeTlv = readTlv(tst.content, t);
    if (genTimeTlv.tag !== 0x18) return UNCHECKED('genTime missing');
    const g = bytesToUtf8(genTimeTlv.content);
    const genTimeUtc = `${g.slice(0, 4)}-${g.slice(4, 6)}-${g.slice(6, 8)}T${g.slice(8, 10)}:${g.slice(10, 12)}:${g.slice(12, 14)}Z`;
    const genTimeMs = Date.parse(genTimeUtc);
    // NaN compares false against every validity window, which would read as
    // valid, so reject an unparseable genTime here.
    if (!Number.isFinite(genTimeMs)) return UNCHECKED('genTime is not a parseable GeneralizedTime');

    // Check 1: the imprint binds this timestamp message, under the hash the
    // imprint declares.
    if (!equalBytes(imprintHash.content, imprintHashFn(expectedMessage))) {
      return FAIL('token does not countersign this signature (messageImprint mismatch)');
    }

    // certificates [0] IMPLICIT — concatenated DER certs
    let certs: ParsedCert[] = [];
    let certDropReason: string | null = null;
    let signerInfosSet: ReturnType<typeof readTlv> | null = null;
    while (o < sd.content.length) {
      const f = readTlv(sd.content, o);
      o = f.next;
      if (f.tag === 0xa0) {
        let co = 0;
        const parsed: ParsedCert[] = [];
        let firstDrop: string | null = null;
        while (co < f.content.length) {
          const c = readTlv(f.content, co);
          co = c.next;
          // Drop only the unparseable cert, keeping the readable ones. If
          // every cert drops, carry the first failure reason: without it an
          // unsupported algorithm reads as "no certificates" and turns a
          // parser gap into a red rung.
          try { parsed.push(parseCertificate(c.full)); }
          catch (e) { firstDrop ??= (e as Error).message; }
        }
        certs = parsed;
        if (certs.length === 0 && firstDrop) certDropReason = firstDrop;
      } else if (f.tag === 0x31) {
        signerInfosSet = f; // SET OF SignerInfo
      }
    }
    if (!signerInfosSet) return UNCHECKED('no signerInfos');
    if (certs.length === 0) {
      return UNCHECKED(certDropReason
        ? `no parseable TSA certificates in token (first failure: ${certDropReason})`
        : 'no TSA certificates in token');
    }

    // SignerInfo (take the first — TSAs produce exactly one)
    const si = readTlv(signerInfosSet.content, 0);
    let s = 0;
    s = readTlv(si.content, s).next; // version
    const sid = readTlv(si.content, s); s = sid.next; // issuerAndSerialNumber
    const sidIssuer = readTlv(sid.content, 0);
    const sidSerial = readTlv(sid.content, sidIssuer.next);
    const digestAlgTlv = readTlv(si.content, s); s = digestAlgTlv.next; // digestAlgorithm
    const digestAlgOid = bytesToHex(readTlv(digestAlgTlv.content, 0).content);
    const signedAttrs = readTlv(si.content, s); s = signedAttrs.next;
    if (signedAttrs.tag !== 0xa0) return UNCHECKED('no signed attributes');
    const sigAlgTlv = readTlv(si.content, s); s = sigAlgTlv.next;
    let sigAlgOid = bytesToHex(readTlv(sigAlgTlv.content, 0).content);
    // RFC 5754: for RSA, SignerInfo.signatureAlgorithm is the key algorithm
    // rsaEncryption and the digest lives in digestAlgorithm. Map the pair to
    // a concrete rsaSha* OID.
    if (sigAlgOid === OID_RSA_ENCRYPTION) {
      if (digestAlgOid === OID_SHA256) sigAlgOid = OID_RSA_SHA256;
      else if (digestAlgOid === OID_SHA384) sigAlgOid = OID_RSA_SHA384;
      else if (digestAlgOid === OID_SHA512) sigAlgOid = OID_RSA_SHA512;
      else return UNCHECKED(`unsupported digest algorithm with RSA signature (${digestAlgOid})`);
    }
    const sigTlv = readTlv(si.content, s);
    if (sigTlv.tag !== 0x04) return UNCHECKED('signature missing');

    // Find the signer cert by issuer + serial. The `?? certs[0]` fallback
    // covers TSAs whose sid does not byte-match an embedded cert; it cannot
    // mint a false pass, since the CMS signature must still verify against
    // that cert's key.
    const signer = certs.find(
      (c) => equalBytes(c.issuerRaw, sidIssuer.full) && equalBytes(c.serial, sidSerial.content),
    ) ?? certs[0];
    const tsaName = signer.subjectCN ?? signer.subjectOrg;
    // Fingerprints for trust pinning, signer first, then the rest of the
    // embedded chain. Carried through every outcome below.
    const tsaFingerprints = [signer, ...certs.filter((c) => c !== signer)].map((c) =>
      bytesToHex(sha256(c.der)),
    );

    // RFC 3161 §2.3: the signer cert must carry the
    // id-kp-timeStamping EKU, otherwise a general-purpose TLS or email cert
    // could mint timestamps.
    if (!hasKeyPurpose(signer, OID_KP_TIME_STAMPING)) {
      return FAIL(`TSA certificate lacks the id-kp-timeStamping extended key usage (RFC 3161 §2.3)${tsaName ? ` (${tsaName})` : ''}`, tsaFingerprints);
    }

    // Check 2: messageDigest attribute == H(TSTInfo DER) under the CMS
    // digestAlgorithm this SignerInfo declares.
    const cmsHash = CMS_DIGEST[digestAlgOid];
    if (!cmsHash) return UNCHECKED(`unsupported CMS digest algorithm (${digestAlgOid})`);
    let messageDigestOk = false;
    let ao = 0;
    while (ao < signedAttrs.content.length) {
      const attr = readTlv(signedAttrs.content, ao);
      ao = attr.next;
      const attrOid = readTlv(attr.content, 0);
      if (bytesToHex(attrOid.content) === OID_MESSAGE_DIGEST) {
        const values = readTlv(attr.content, attrOid.next);
        const v = readTlv(values.content, 0);
        messageDigestOk = equalBytes(v.content, cmsHash(tst.full));
      }
    }
    if (!messageDigestOk) return FAIL('TSTInfo digest does not match the signed attributes', tsaFingerprints);

    // Check 3: the CMS signature over the signed attributes. Per RFC 5652
    // §5.4 the signed bytes carry the universal SET OF tag (0x31) in place of
    // the implicit [0] tag; 0x31, not 0x30.
    const signedBytes = new Uint8Array(signedAttrs.full.length);
    signedBytes.set(signedAttrs.full);
    signedBytes[0] = 0x31;
    if (!verifySignatureWithKey(signer.keyAlg, sigAlgOid, signedBytes, sigTlv.content)) {
      return FAIL(`TSA signature does not verify${tsaName ? ` (${tsaName})` : ''}`, tsaFingerprints);
    }

    // Check 4: TSA chain links + the signer cert was valid AT genTime.
    const chain = verifyChain(certs.map((c) => c.der), [], genTimeMs);
    if (!chain.linksValid) return FAIL(`TSA certificate chain broken: ${chain.reason}`, tsaFingerprints);
    if (genTimeMs < signer.notBeforeMs || genTimeMs > signer.notAfterMs) {
      return FAIL('TSA certificate was not valid at the timestamp time', tsaFingerprints);
    }

    return { tokenValid: true, reason: null, genTimeUtc, tsaName, tsaChainLinksValid: true, tsaFingerprints, checked: true };
  } catch (e) {
    return UNCHECKED(`token failed to parse: ${(e as Error).message}`);
  }
}
