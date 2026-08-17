// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RFC 3161 TimeStampToken verification — real CMS/PKCS#7 checks.
 *
 * For each embedded token we prove:
 *   1. The TSTInfo's messageImprint is exactly SHA-256 of the bytes we
 *      timestamped (the C2PA CounterSignature structure over the COSE
 *      signature) — so the token really countersigns THIS signature, not
 *      some other blob.
 *   2. The CMS signedAttributes' messageDigest equals SHA-256 of the
 *      TSTInfo — so the TSA's signature covers THIS TSTInfo.
 *   3. The TSA's signature verifies under the TSA certificate's key
 *      (ECDSA P-256/P-384 or RSA PKCS#1 v1.5 — FreeTSA is RSA).
 *   4. genTime comes from the parsed TSTInfo, and the TSA cert was valid
 *      AT that genTime.
 *
 * What we deliberately do NOT claim: that the TSA's root is on a curated
 * trust list. The ecosystem's TSA trust list is still forming, so the
 * report names the TSA from its certificate and states plainly that root
 * anchoring is not performed. A token that passes 1–4 is cryptographically
 * genuine; whether you trust the named authority is a separate, stated
 * question.
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

/** CMS digestAlgorithm → hash. FreeTSA's CMS layer uses SHA-512 even when the
 * requested imprint is SHA-256 — hardcoding SHA-256 here would fail every
 * genuine FreeTSA token. */
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
}

const FAIL = (reason: string, tsaFingerprints: string[] = []): TimestampVerification =>
  ({ tokenValid: false, reason, genTimeUtc: null, tsaName: null, tsaChainLinksValid: null, tsaFingerprints });

/**
 * Verifies one TimeStampToken (CMS ContentInfo) against the exact message it
 * should imprint. Never throws — a bad token is evidence, not an exception.
 */
export function verifyTimestampToken(token: Uint8Array, expectedMessage: Uint8Array): TimestampVerification {
  try {
    // ContentInfo → [0] SignedData
    const ci = readTlv(token, 0);
    const ciOid = readTlv(ci.content, 0);
    if (bytesToHex(ciOid.content) !== OID_SIGNED_DATA) return FAIL('not a CMS SignedData');
    const sdWrap = readTlv(ci.content, ciOid.next);
    const sd = readTlv(sdWrap.content, 0);

    // SignedData fields
    let o = 0;
    o = readTlv(sd.content, o).next; // version
    o = readTlv(sd.content, o).next; // digestAlgorithms
    const encap = readTlv(sd.content, o); o = encap.next;
    const encapOid = readTlv(encap.content, 0);
    if (bytesToHex(encapOid.content) !== OID_TST_INFO) return FAIL('CMS content is not a TSTInfo');
    const encapContent = readTlv(encap.content, encapOid.next); // [0] EXPLICIT OCTET STRING
    const tstOctets = readTlv(encapContent.content, 0);
    if (tstOctets.tag !== 0x04) return FAIL('TSTInfo missing');

    // TSTInfo ::= SEQUENCE { version, policy, messageImprint, serial, genTime, … }
    const tst = readTlv(tstOctets.content, 0);
    let t = 0;
    t = readTlv(tst.content, t).next; // version
    t = readTlv(tst.content, t).next; // policy OID
    const imprint = readTlv(tst.content, t); t = imprint.next;
    const imprintAlg = readTlv(imprint.content, 0);
    const imprintAlgOid = readTlv(imprintAlg.content, 0);
    const imprintHash = readTlv(imprint.content, imprintAlg.next);
    if (bytesToHex(imprintAlgOid.content) !== OID_SHA256) return FAIL('messageImprint is not SHA-256');
    const serialTlv = readTlv(tst.content, t); t = serialTlv.next; // serialNumber
    const genTimeTlv = readTlv(tst.content, t);
    if (genTimeTlv.tag !== 0x18) return FAIL('genTime missing');
    const g = bytesToUtf8(genTimeTlv.content);
    const genTimeUtc = `${g.slice(0, 4)}-${g.slice(4, 6)}-${g.slice(6, 8)}T${g.slice(8, 10)}:${g.slice(10, 12)}:${g.slice(12, 14)}Z`;
    const genTimeMs = Date.parse(genTimeUtc);
    // A garbage genTime parses to NaN, and every window comparison against
    // NaN is false — i.e. silently "valid". Fail loud instead.
    if (!Number.isFinite(genTimeMs)) return FAIL('genTime is not a parseable GeneralizedTime');

    // Check 1: the imprint binds THIS signature's timestamp message.
    if (!equalBytes(imprintHash.content, sha256(expectedMessage))) {
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
          // Drop only the unparseable cert, never the whole set: one exotic
          // cert (e.g. an RSA-PSS CA we don't verify yet) must not blind us
          // to the certs we CAN read. But if EVERY cert drops, the reason is
          // the single most useful diagnostic we have — carry it: a bare
          // "no TSA certificates in token" would hide an unsupported-alg
          // throw and turn a parser gap into false red rungs.
          try { parsed.push(parseCertificate(c.full)); }
          catch (e) { firstDrop ??= (e as Error).message; }
        }
        certs = parsed;
        if (certs.length === 0 && firstDrop) certDropReason = firstDrop;
      } else if (f.tag === 0x31) {
        signerInfosSet = f; // SET OF SignerInfo
      }
    }
    if (!signerInfosSet) return FAIL('no signerInfos');
    if (certs.length === 0) {
      return FAIL(certDropReason
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
    if (signedAttrs.tag !== 0xa0) return FAIL('no signed attributes');
    const sigAlgTlv = readTlv(si.content, s); s = sigAlgTlv.next;
    let sigAlgOid = bytesToHex(readTlv(sigAlgTlv.content, 0).content);
    // CMS quirk (RFC 5754): for RSA the SignerInfo.signatureAlgorithm is the
    // KEY algorithm rsaEncryption — the digest lives one field earlier, in
    // digestAlgorithm. Map the pair to the concrete rsaSha* OID our verifier
    // understands. Without this every RSA TSA (e.g. FreeTSA) failed its own
    // genuine token.
    if (sigAlgOid === OID_RSA_ENCRYPTION) {
      if (digestAlgOid === OID_SHA256) sigAlgOid = OID_RSA_SHA256;
      else if (digestAlgOid === OID_SHA384) sigAlgOid = OID_RSA_SHA384;
      else if (digestAlgOid === OID_SHA512) sigAlgOid = OID_RSA_SHA512;
      else return FAIL(`unsupported digest algorithm with RSA signature (${digestAlgOid})`);
    }
    const sigTlv = readTlv(si.content, s);
    if (sigTlv.tag !== 0x04) return FAIL('signature missing');

    // Find the signer cert by issuer + serial. The `?? certs[0]` fallback is
    // deliberate leniency for TSAs whose sid doesn't byte-match an embedded
    // cert: it CANNOT mint a false green (the CMS signature must still verify
    // against that cert's key), and strictness here would reject genuine
    // tokens. Do not "harden" this away.
    const signer = certs.find(
      (c) => equalBytes(c.issuerRaw, sidIssuer.full) && equalBytes(c.serial, sidSerial.content),
    ) ?? certs[0];
    const tsaName = signer.subjectCN ?? signer.subjectOrg;
    // Fingerprints for trust pinning — signer first, then the rest of the
    // embedded chain. Computed once, carried through every outcome below.
    const tsaFingerprints = [signer, ...certs.filter((c) => c !== signer)].map((c) =>
      bytesToHex(sha256(c.der)),
    );

    // Check (F7b, docs/SECURITY.md — RFC 3161 §2.3): the signer cert MUST
    // carry the id-kp-timeStamping extended key usage. Without it a general
    // -purpose cert (TLS, email) could mint timestamps we would report as
    // genuine — the EKU is what makes a cert a TSA cert.
    if (!hasKeyPurpose(signer, OID_KP_TIME_STAMPING)) {
      return FAIL(`TSA certificate lacks the id-kp-timeStamping extended key usage (RFC 3161 §2.3)${tsaName ? ` (${tsaName})` : ''}`, tsaFingerprints);
    }

    // Check 2: messageDigest attribute == H(TSTInfo DER) under the CMS
    // digestAlgorithm declared in this SignerInfo (NOT hardcoded SHA-256 —
    // FreeTSA uses SHA-512 here).
    const cmsHash = CMS_DIGEST[digestAlgOid];
    if (!cmsHash) return FAIL(`unsupported CMS digest algorithm (${digestAlgOid})`, tsaFingerprints);
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

    // Check 3: the CMS signature over the signed attributes. The signed bytes
    // are the SET OF Attributes with the universal SET OF tag (0x31) in place
    // of the implicit [0] tag (RFC 5652 §5.4). The regression suite covers
    // this: 0x30 (SEQUENCE) silently rejects every genuine token.
    const signedBytes = new Uint8Array(signedAttrs.full.length);
    signedBytes.set(signedAttrs.full);
    signedBytes[0] = 0x31;
    if (!verifySignatureWithKey(signer.keyAlg, sigAlgOid, signedBytes, sigTlv.content)) {
      return FAIL(`TSA signature does not verify${tsaName ? ` (${tsaName})` : ''}`, tsaFingerprints);
    }

    // Check 4: TSA chain links + the signer cert was valid AT genTime. The
    // required timestamping EKU is enforced inside verifyChain too, so a
    // critical extKeyUsage on the TSA leaf is honored, not merely parsed.
    const chain = verifyChain(certs.map((c) => c.der), [], genTimeMs, OID_KP_TIME_STAMPING);
    if (!chain.linksValid) return FAIL(`TSA certificate chain broken: ${chain.reason}`, tsaFingerprints);
    if (genTimeMs < signer.notBeforeMs || genTimeMs > signer.notAfterMs) {
      return FAIL('TSA certificate was not valid at the timestamp time', tsaFingerprints);
    }

    return { tokenValid: true, reason: null, genTimeUtc, tsaName, tsaChainLinksValid: true, tsaFingerprints };
  } catch (e) {
    return FAIL(`token failed to parse: ${(e as Error).message}`);
  }
}
