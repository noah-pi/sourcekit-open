// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The TSA signer cert must carry the id-kp-timeStamping extended key usage
 * (RFC 3161 §2.3); without the check, a general-purpose cert (TLS, email)
 * could mint timestamps reported as genuine.
 *
 *  1. Token signed by a cert with critical EKU timeStamping → tokenValid.
 *  2. Same token shape, cert EKU is emailProtection (C2PA device profile) →
 *     fail, naming the missing EKU.
 *  3. Same again, cert carries no extensions → same failure.
 *  4. The EKU failure fires even when every other check passes; the tokens in
 *     2 and 3 are cryptographically genuine.
 *  5. hasKeyPurpose: wrong purpose or missing EKU → false (fails closed).
 */
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, asciiToBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { verifyTimestampToken } from './rfc3161.mts';
import { hasKeyPurpose, OID_KP_TIME_STAMPING, parseCertificate } from './x509.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

// --- tiny DER writer (same shape as test-roundtrip's) ---
function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, content: Uint8Array) => concatBytes(new Uint8Array([tag]), derLen(content.length), content);
const seq = (...c: Uint8Array[]) => tlv(0x30, concatBytes(...c));
const set = (...c: Uint8Array[]) => tlv(0x31, concatBytes(...c));
const oid = (bytes: number[]) => tlv(0x06, new Uint8Array(bytes));
const int1 = (n: number) => tlv(0x02, new Uint8Array([n]));
const intBytes = (b: Uint8Array) => tlv(0x02, b[0] & 0x80 ? concatBytes(new Uint8Array([0]), b) : b);
const octet = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array) => tlv(0x03, concatBytes(new Uint8Array([0]), b));
const utf8s = (s: string) => tlv(0x0c, asciiToBytes(s));
const NULL = new Uint8Array([0x05, 0x00]);
const OID = {
  signedData: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02],
  tstInfo: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04],
  contentType: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03],
  messageDigest: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04],
  sha256: [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01],
  ecdsaSha256: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02],
  ecPublicKey: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01],
  prime256v1: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07],
  policy: [0x2a, 0x03, 0x04],
  commonName: [0x55, 0x04, 0x03],
  organizationName: [0x55, 0x04, 0x0a],
};
const name = (org: string, cn: string) => seq(
  tlv(0x31, seq(oid(OID.organizationName), utf8s(org))),
  tlv(0x31, seq(oid(OID.commonName), utf8s(cn))),
);
const utcTime = (d: Date) => {
  const p = (x: number) => String(x).padStart(2, '0');
  return tlv(0x17, asciiToBytes(`${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};
const genTime = () => {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return tlv(0x18, asciiToBytes(`${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`));
};

/** Minimal RFC 3161 token over `message`, ECDSA P-256, one embedded cert. */
function buildToken(certDer: Uint8Array, message: Uint8Array, sign: (signedBytes: Uint8Array) => Uint8Array): Uint8Array {
  const imprint = seq(seq(oid(OID.sha256), NULL), octet(sha256(message)));
  const tst = seq(int1(1), oid(OID.policy), imprint, int1(1), genTime());
  const attrsContent = concatBytes(
    seq(oid(OID.contentType), set(oid(OID.tstInfo))),
    seq(oid(OID.messageDigest), set(octet(sha256(tst)))),
  );
  // IMPLICIT [0] carries the attributes without the SET OF tag; the CMS
  // signature covers the same bytes with the universal 0x31 (RFC 5652 §5.4).
  const signerInfo = seq(
    int1(1),
    (() => {
      const cert = parseCertificate(certDer);
      return seq(cert.issuerRaw, tlv(0x02, cert.serial));
    })(),
    seq(oid(OID.sha256), NULL),
    tlv(0xa0, attrsContent),
    seq(oid(OID.ecdsaSha256), NULL),
    octet(sign(tlv(0x31, attrsContent))),
  );
  const signedData = seq(
    int1(3), set(seq(oid(OID.sha256), NULL)), seq(oid(OID.tstInfo), tlv(0xa0, octet(tst))), tlv(0xa0, certDer), set(signerInfo),
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}

const priv = p256.utils.randomPrivateKey();
const pub = p256.getPublicKey(priv, false);
const signDigest = async (d: Uint8Array) => p256.sign(d, priv, { lowS: true }).toDERRawBytes();
const signRaw = (sb: Uint8Array) => p256.sign(sha256(sb), priv, { lowS: true }).toDERRawBytes();
const notBefore = new Date(Date.now() - 60_000);

// (a) RFC-conformant TSA cert: critical EKU id-kp-timeStamping.
const tsaCert = await buildSelfSignedCert(pub, signDigest, notBefore, { eku: 'timeStamping' });
// (b) C2PA device profile: critical EKU emailProtection, the wrong purpose.
const emailCert = await buildSelfSignedCert(pub, signDigest, notBefore, { eku: 'emailProtection' });
// (c) Same key, hand-rolled cert with no extensions.
const later = new Date(notBefore.getTime() + 5 * 365 * 24 * 3600 * 1000);
const bareTbs = seq(
  tlv(0xa0, int1(2)),
  intBytes(sha256(pub).subarray(0, 16)),
  seq(oid(OID.ecdsaSha256)),
  name('Exhibit Lab', 'Bare TSA'),
  seq(utcTime(notBefore), utcTime(later)),
  name('Exhibit Lab', 'Bare TSA'),
  seq(seq(oid(OID.ecPublicKey), oid(OID.prime256v1)), bitString(pub)),
);
const bareCert = seq(bareTbs, seq(oid(OID.ecdsaSha256)), bitString(await signDigest(sha256(bareTbs))));

const message = sha256(asciiToBytes('the cose countersign structure'));

// ---------- 1. conformant cert → valid ----------
const good = verifyTimestampToken(buildToken(tsaCert, message, signRaw), message);
check('token from EKU timeStamping cert validates', good.tokenValid, good.reason ?? '');
check('validated token names the TSA', (good.tsaName ?? '').length > 0, String(good.tsaName));

// ---------- 2. wrong-purpose EKU → rejected ----------
const wrong = verifyTimestampToken(buildToken(emailCert, message, signRaw), message);
check('same token from emailProtection cert REJECTED', !wrong.tokenValid, 'unexpectedly valid');
check('rejection names the missing EKU (RFC 3161 §2.3)', (wrong.reason ?? '').includes('id-kp-timeStamping'), String(wrong.reason));

// ---------- 3. no extensions → rejected ----------
let bareParsedOk = true;
try { parseCertificate(bareCert); } catch { bareParsedOk = false; }
check('extension-less cert still parses (so the EKU check is what fires)', bareParsedOk);
const bare = verifyTimestampToken(buildToken(bareCert, message, signRaw), message);
check('token from extension-less cert REJECTED on EKU', !bare.tokenValid && (bare.reason ?? '').includes('id-kp-timeStamping'), String(bare.reason));

// ---------- 5. hasKeyPurpose units ----------
const parsedTsa = parseCertificate(tsaCert);
check('hasKeyPurpose finds timeStamping', hasKeyPurpose(parsedTsa, OID_KP_TIME_STAMPING));
check('hasKeyPurpose rejects a wrong purpose', !hasKeyPurpose(parsedTsa, '2b06010505070304'));
check('hasKeyPurpose fails closed on extension-less cert', !hasKeyPurpose(parseCertificate(bareCert), OID_KP_TIME_STAMPING));

console.log(`\ntsa-eku: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
