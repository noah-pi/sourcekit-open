// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Round-trip: BUILD → VERIFY, with timestamps on.
 *
 * Builder and verifier tested against SEPARATE fixtures, never against
 * each other, let whole bug classes through — a countersign message
 * reconstructed 3 bytes off (every genuine TSA token fails), RSA TSAs
 * rejected outright. This suite closes that loop permanently: it builds a
 * real manifest through the real builder (buildC2paSegment), countersigned
 * by real TimeStampTokens from mock TSAs (one ECDSA, one RSA — the RSA one
 * exercises the rsaEncryption→digestAlgorithm mapping), embeds it
 * in a real JPEG, and runs the real verifier (verifyPhotoBytes) over the
 * bytes. Any drift between the two sides fails here, loudly.
 *
 * The mock TSAs are full CMS/RFC-3161 producers — TSTInfo, signed
 * attributes, messageDigest binding, chain — not stubs. They are NOT on the
 * pinned TSA trust list, so the report must show valid-but-unpinned:
 * trusted time does not anchor (earliestTrustedUtc null) while display time
 * still surfaces (earliestValidUtc set).
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-roundtrip.mts
 */
import * as crypto from 'node:crypto';
import { sha256 } from '@noble/hashes/sha256';
import { p256 } from '@noble/curves/p256';
import { buildC2paSegment, extractC2paStore, parseManifest } from './c2pa.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { buildSelfSignedCert } from './cert.mts';
import { parseCertificate } from './x509.mts';
import { buildRecord } from './manifest.mts';
import { signRecord } from './sign.mts';
import { concatBytes, asciiToBytes, bytesToHex, bytesToBase64, utf8ToBytes } from './bytes.mts';

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------
// Tiny DER writer (mirrors src/lib/cert.ts — duplicated here so the lab owns
// its mock-TSA plumbing and the app code stays untouched)
// ---------------------------------------------------------------------------

function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const b: number[] = [];
  let v = n;
  while (v > 0) { b.unshift(v & 0xff); v >>= 8; }
  return new Uint8Array([0x80 | b.length, ...b]);
}
const tlv = (tag: number, content: Uint8Array) => concatBytes(new Uint8Array([tag]), derLen(content.length), content);
const seq = (...c: Uint8Array[]) => tlv(0x30, concatBytes(...c));
const set = (...c: Uint8Array[]) => tlv(0x31, concatBytes(...c));
const oid = (bytes: number[]) => tlv(0x06, new Uint8Array(bytes));
const intBytes = (b: Uint8Array) => tlv(0x02, b[0] & 0x80 ? concatBytes(new Uint8Array([0]), b) : b);
const int1 = (n: number) => tlv(0x02, new Uint8Array([n]));
const octet = (b: Uint8Array) => tlv(0x04, b);
const bitString = (b: Uint8Array) => tlv(0x03, concatBytes(new Uint8Array([0]), b));
const utf8 = (s: string) => tlv(0x0c, asciiToBytes(s));
const NULL = new Uint8Array([0x05, 0x00]);
const p2 = (x: number) => String(x).padStart(2, '0');
const utcTime = (d: Date) =>
  tlv(0x17, asciiToBytes(`${String(d.getUTCFullYear()).slice(2)}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`));
const generalizedTime = (d: Date) =>
  tlv(0x18, asciiToBytes(`${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`));

const OID = {
  signedData: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02],      // 1.2.840.113549.1.7.2
  tstInfo: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04], // 1.2.840.113549.1.9.16.1.4
  contentType: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03],    // 1.2.840.113549.1.9.3
  messageDigest: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04],  // 1.2.840.113549.1.9.4
  sha256: [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01],         // 2.16.840.1.101.3.4.2.1
  ecdsaSha256: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02],          // 1.2.840.10045.4.3.2
  rsaEncryption: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01],  // 1.2.840.113549.1.1.1
  rsaSha256: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b],      // 1.2.840.113549.1.1.11
  policy: [0x2a, 0x03, 0x04],                                             // 1.2.3.4 (lab policy)
  commonName: [0x55, 0x04, 0x03],
  organizationName: [0x55, 0x04, 0x0a],
  extKeyUsage: [0x55, 0x1d, 0x25],                                       // 2.5.29.37
  kpTimeStamping: [0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x08],      // 1.3.6.1.5.5.7.3.8 (RFC 3161 §2.3)
};
const name = (org: string, cn: string) =>
  seq(set(seq(oid(OID.organizationName), utf8(org))), set(seq(oid(OID.commonName), utf8(cn))));

// ---------------------------------------------------------------------------
// Mock TSAs — full RFC 3161 producers over lab keys
// ---------------------------------------------------------------------------

interface MockTsa {
  certDer: Uint8Array;
  /** Given the countersign message, returns a genuine TimeStampToken (CMS). */
  answer: (message: Uint8Array) => Uint8Array;
}

function buildToken(
  certDer: Uint8Array,
  message: Uint8Array,
  sign: (signedBytes: Uint8Array) => Uint8Array,
  sigAlgId: Uint8Array,
): Uint8Array {
  const parsed = parseCertificate(certDer);
  const tst = seq(
    int1(1),                                            // version
    oid(OID.policy),                                    // policy
    seq(seq(oid(OID.sha256), NULL), octet(sha256(message))), // messageImprint
    intBytes(crypto.randomBytes(8)),                    // serialNumber
    generalizedTime(new Date()),                        // genTime
  );
  const attrsContent = concatBytes(
    seq(oid(OID.contentType), set(oid(OID.tstInfo))),
    seq(oid(OID.messageDigest), set(octet(sha256(tst)))),
  );
  // The signed bytes are the SET OF Attributes (universal 0x31 tag) — the
  // implicit [0] in the SignerInfo carries the same content with the
  // context tag (RFC 5652 §5.4).
  const signature = sign(tlv(0x31, attrsContent));
  const signerInfo = seq(
    int1(1),                                            // version
    seq(parsed.issuerRaw, intBytes(parsed.serial)),     // issuerAndSerialNumber
    seq(oid(OID.sha256), NULL),                         // digestAlgorithm
    tlv(0xa0, attrsContent),                            // [0] signed attributes
    sigAlgId,                                           // signatureAlgorithm
    octet(signature),                                   // signature
  );
  const signedData = seq(
    int1(3),                                            // version (certs present)
    set(seq(oid(OID.sha256), NULL)),                    // digestAlgorithms
    seq(oid(OID.tstInfo), tlv(0xa0, octet(tst))),       // encapContentInfo
    tlv(0xa0, certDer),                                 // [0] certificates
    set(signerInfo),                                    // signerInfos
  );
  return seq(oid(OID.signedData), tlv(0xa0, signedData));
}

/** Self-signed RSA-2048 TSA cert (SPKI exported by Node, TBS hand-assembled). */
function makeRsaTsa(): MockTsa {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  const spki = new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }));
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600 * 1000);
  const tbs = seq(
    tlv(0xa0, int1(2)),                                 // version v3
    intBytes(crypto.randomBytes(16)),                   // serial
    seq(oid(OID.rsaSha256), NULL),                      // signature alg
    name('Exhibit Lab', 'Test TSA RSA'),                 // issuer
    seq(utcTime(notBefore), utcTime(notAfter)),         // validity
    name('Exhibit Lab', 'Test TSA RSA'),                 // subject
    spki,
    // RFC 3161 §2.3: a TSA cert MUST carry critical
    // EKU id-kp-timeStamping — the verifier enforces it.
    tlv(0xa3, seq(
      seq(oid(OID.extKeyUsage), tlv(0x01, new Uint8Array([0xff])), tlv(0x04, seq(oid(OID.kpTimeStamping)))),
    )),
  );
  const certSig = new Uint8Array(crypto.sign('sha256', Buffer.from(tbs), privateKey));
  const certDer = seq(tbs, seq(oid(OID.rsaSha256), NULL), bitString(certSig));
  return {
    certDer,
    answer(message) {
      return buildToken(
        certDer,
        message,
        (signedBytes) => new Uint8Array(crypto.sign('sha256', Buffer.from(signedBytes), privateKey)),
        // The RSA shape's whole point: real RSA TSAs announce rsaEncryption here —
        // the digest lives in the SignerInfo digestAlgorithm field above.
        seq(oid(OID.rsaEncryption), NULL),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The round trip
// ---------------------------------------------------------------------------

const JPEG_1PX = new Uint8Array(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQBAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhADEAAAAc//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAs//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/As//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64',
));

console.log('— Build → verify round trip —');

// Lab device signer.
const devPriv = p256.utils.randomPrivateKey();
const devPub = p256.getPublicKey(devPriv, false);
// Mirror production exactly: every app signer emits canonical low-S
// (deviceKey.ts et al. pass { lowS: true }); the record/COSE verifiers
// enforce it — the harness mirrors the real signing discipline.
const devSignDigest = async (d: Uint8Array) => p256.sign(d, devPriv, { lowS: true }).toDERRawBytes();
const devCert = await buildSelfSignedCert(devPub, devSignDigest, new Date(Date.now() - 60_000));

// Mock TSAs: ECDSA (buildSelfSignedCert path) and RSA (the rsaEncryption shape).
const ecTsaPriv = p256.utils.randomPrivateKey();
const ecTsaPub = p256.getPublicKey(ecTsaPriv, false);
const ecTsaCert = await buildSelfSignedCert(ecTsaPub, async (d) => p256.sign(d, ecTsaPriv).toDERRawBytes(), new Date(Date.now() - 60_000), { eku: 'timeStamping' });
const ecTsa: MockTsa = {
  certDer: ecTsaCert,
  answer: (message) => buildToken(ecTsaCert, message, (sb) => p256.sign(sha256(sb), ecTsaPriv).toDERRawBytes(), seq(oid(OID.ecdsaSha256), NULL)),
};
const rsaTsa = makeRsaTsa();
check('mock RSA TSA cert parses as RSA', (() => { try { return parseCertificate(rsaTsa.certDer).keyAlg.kind === 'rsa'; } catch { return false; } })());

// A realistic signed telemetry record (same builder the app uses).
const record = buildRecord({
  assetSha256: bytesToHex(sha256(JPEG_1PX)),
  assetBytes: JPEG_1PX.length,
  mime: 'image/jpeg',
  kind: 'photo',
  capturedAt: new Date().toISOString(),
  appVersion: '0.10.0-lab',
  deviceModel: 'lab',
  platform: 'lab',
  identity: { author: 'Round Trip', organization: null },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context: {
    location: null, headingDeg: null, pressureHPa: null, altitudeM: null, motion: null,
    poseTrace: {
      hz: 20, anchor: 3, samples: 7,
      rotRate: Array.from({ length: 21 }, (_, i) => i - 10),
      attitude: Array.from({ length: 21 }, () => 450),
      accel: Array.from({ length: 21 }, () => 1),
    },
  } as any,
  publicKeyBase64: bytesToBase64(devPub),
  fingerprint: bytesToHex(sha256(devPub)),
});
// Signed time lower bound: the cached Bitcoin tip rides the
// record — inside the signed payload, like every other self-reported signal.
record.beacon = {
  chain: 'bitcoin',
  blockHash: 'ab'.repeat(32),
  blockHeight: 840001,
  observedAt: new Date().toISOString(),
  source: 'mempool.space',
  note: 'lower-bound: signing happened after this block existed; observation time self-reported',
};
const signedRecord = await signRecord(record, devSignDigest);

const insertOffset = 2; // APP11 immediately after SOI, as in attest.ts
const segment = await buildC2paSegment(
  {
    appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
    mime: 'image/jpeg',
    title: 'roundtrip.jpg',
    instanceId: 'xmp:iid:' + bytesToHex(crypto.randomBytes(16)),
    telemetry: signedRecord as unknown as Record<string, unknown>,
    signDigest: devSignDigest,
    certChain: [devCert],
    cleanFileSha256: sha256(JPEG_1PX),
    // Two witness tokens: one ECDSA, one RSA. The builder asks, the mock
    // TSAs answer — exactly the shape fetchTimestampTokens produces online.
    fetchTimestamp: async (message) => [ecTsa.answer(message), rsaTsa.answer(message)],
    // The signed camera-reported assertion (sanitized upstream).
    exif: { ISO: 400, FNumber: 1.78, FocalLength: 6.86, Orientation: 1 },
  },
  insertOffset,
);
const signedJpeg = concatBytes(JPEG_1PX.subarray(0, insertOffset), segment, JPEG_1PX.subarray(insertOffset));

const report = await verifyPhotoBytes(signedJpeg);

check('built file verifies INTACT through the real verifier',
  report.verdict === 'INTACT',
  `verdict=${report.verdict} sig=${report.checks.signatureValid} hash=${report.checks.assetHashMatches} claims=${report.c2pa?.claimAssertionsMatch} fpMatch=${report.checks.fingerprintMatches} hasRecord=${report.record !== null}`);
check('both witness tokens were embedded', (report.c2pa?.timestamps.present ?? -1) === 2);
check('BOTH tokens verify against the builder message',
  (report.c2pa?.timestamps.valid ?? -1) === 2,
  `valid=${report.c2pa?.timestamps.valid} failures=${report.c2pa?.timestamps.failures.join(';')}`);
check('the RSA TSA token verifies (rsaEncryption mapping)',
  (report.c2pa?.timestamps.tsaNames ?? []).some((n) => n.includes('Test TSA RSA')),
  (report.c2pa?.timestamps.tsaNames ?? []).join(','));
check('lab TSAs are NOT pinned: valid-but-untrusted, time does not anchor',
  (report.c2pa?.timestamps.trusted ?? -1) === 0 && report.c2pa?.timestamps.earliestTrustedUtc === null);
check('display time still surfaces from the unpinned tokens',
  report.c2pa?.timestamps.earliestValidUtc !== null);
check('unpinned authorities are disclosed in the not-performed list',
  (report.checksNotPerformed ?? []).some((s) => s.includes('UNPINNED')));
check('the signed pose trace survives the round trip into the report',
  report.record?.context?.poseTrace?.samples === 7 &&
  (report.checksPerformed ?? []).some((s) => s.includes('pose trace')));
check('the EXIF assertion signs in and parses back out',
  (report.checksPerformed ?? []).some((s) => s.includes('EXIF')));
check('the Bitcoin beacon signs in and is reported as a time lower bound',
  report.record?.beacon?.blockHeight === 840001 &&
  (report.checksPerformed ?? []).some((s) => s.includes('Bitcoin beacon')),
  `beacon=${JSON.stringify(report.record?.beacon ?? null).slice(0, 80)}`);

console.log('\n— one signature per claim, native-seal hop —');

// The two-phase fixpoint must burn EXACTLY ONE claim signature no matter how
// many size iterations it runs. Biometric-bound keys prompt per signature —
// per-iteration signing would prompt Face ID again and again, and a
// reusable signing session would be a silent-forgery window.
{
  let claimSigs = 0;
  const countedSegment = await buildC2paSegment(
    {
      appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
      mime: 'image/jpeg',
      title: 'roundtrip.jpg',
      instanceId: 'xmp:iid:' + bytesToHex(crypto.randomBytes(16)),
      telemetry: signedRecord as unknown as Record<string, unknown>,
      signDigest: async (d) => { claimSigs++; return devSignDigest(d); },
      certChain: [devCert],
      cleanFileSha256: sha256(JPEG_1PX),
      fetchTimestamp: async (message) => [ecTsa.answer(message), rsaTsa.answer(message)],
    },
    insertOffset,
  );
  check('the fixpoint signs the claim EXACTLY once', claimSigs === 1, `signatures=${claimSigs}`);
  const countedJpeg = concatBytes(JPEG_1PX.subarray(0, insertOffset), countedSegment, JPEG_1PX.subarray(insertOffset));
  const countedReport = await verifyPhotoBytes(countedJpeg);
  check('the two-phase build verifies INTACT with both witness tokens valid',
    countedReport.verdict === 'INTACT' && (countedReport.c2pa?.timestamps.valid ?? -1) === 2,
    `verdict=${countedReport.verdict} valid=${countedReport.c2pa?.timestamps.valid}`);
}

// signPayload (the native-seal hop): digest+sign in ONE call, and the
// builder never touches the digest path when the hop is available.
{
  let payloadCalls = 0;
  let digestCalls = 0;
  const sealedSegment = await buildC2paSegment(
    {
      appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
      mime: 'image/jpeg',
      title: 'roundtrip.jpg',
      instanceId: 'xmp:iid:' + bytesToHex(crypto.randomBytes(16)),
      telemetry: signedRecord as unknown as Record<string, unknown>,
      signDigest: async (d) => { digestCalls++; return devSignDigest(d); },
      signPayload: async (p) => { payloadCalls++; return devSignDigest(sha256(p)); },
      certChain: [devCert],
      cleanFileSha256: sha256(JPEG_1PX),
      fetchTimestamp: async (message) => [ecTsa.answer(message), rsaTsa.answer(message)],
    },
    insertOffset,
  );
  check('signPayload seals the claim in one hop (no digest-path call)',
    payloadCalls === 1 && digestCalls === 0, `payload=${payloadCalls} digest=${digestCalls}`);
  const sealedJpeg = concatBytes(JPEG_1PX.subarray(0, insertOffset), sealedSegment, JPEG_1PX.subarray(insertOffset));
  check('the native-seal-built file verifies INTACT',
    (await verifyPhotoBytes(sealedJpeg)).verdict === 'INTACT');
}

// Tamper control: one flipped pixel byte must flip the verdict.
const tampered = new Uint8Array(signedJpeg);
tampered[tampered.length - 4] ^= 0x01;
const tamperedReport = await verifyPhotoBytes(tampered);
check('one flipped byte after signing → CONTENT_MODIFIED',
  tamperedReport.verdict === 'CONTENT_MODIFIED', `verdict=${tamperedReport.verdict}`);

// Drift control: a token over the WRONG message must fail messageImprint even
// when everything else is genuine (the countersign-message drift class, injected deliberately).
const wrongMessage = new Uint8Array(sha256(signedJpeg)); // any wrong bytes
const driftToken = ecTsa.answer(wrongMessage);
const driftSegment = await buildC2paSegment(
  {
    appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
    mime: 'image/jpeg',
    title: 'roundtrip.jpg',
    instanceId: 'xmp:iid:' + bytesToHex(crypto.randomBytes(16)),
    telemetry: signedRecord as unknown as Record<string, unknown>,
    signDigest: devSignDigest,
    certChain: [devCert],
    cleanFileSha256: sha256(JPEG_1PX),
    fetchTimestamp: async () => [driftToken],
  },
  insertOffset,
);
const driftJpeg = concatBytes(JPEG_1PX.subarray(0, insertOffset), driftSegment, JPEG_1PX.subarray(insertOffset));
const driftReport = await verifyPhotoBytes(driftJpeg);
check('a token countersigning the wrong message is REJECTED',
  (driftReport.c2pa?.timestamps.valid ?? -1) === 0 && (driftReport.c2pa?.timestamps.failures[0] ?? '').includes('messageImprint'),
  driftReport.c2pa?.timestamps.failures[0] ?? '');
check('...while the file itself still verifies INTACT (time is not integrity)',
  driftReport.verdict === 'INTACT');

console.log('\n— box surgery: an unreferenced box carries no weight —');

// A com.verify.exif box spliced into the assertion store AFTER signing must
// parse as UNREFERENCED and report honestly — never the claim-bound string
// "signed as self-reported metadata, hash cross-checked against the claim".
{
  const bareSegment = await buildC2paSegment(
    {
      appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
      mime: 'image/jpeg',
      title: 'roundtrip.jpg',
      instanceId: 'xmp:iid:' + bytesToHex(crypto.randomBytes(16)),
      telemetry: signedRecord as unknown as Record<string, unknown>,
      signDigest: devSignDigest,
      certChain: [devCert],
      cleanFileSha256: sha256(JPEG_1PX),
      fetchTimestamp: async (message) => [ecTsa.answer(message), rsaTsa.answer(message)],
    },
    insertOffset,
  );
  const baseJpeg = concatBytes(JPEG_1PX.subarray(0, insertOffset), bareSegment, JPEG_1PX.subarray(insertOffset));

  // The surgical box: a com.verify.exif assertion the signed claim never names.
  const u32be = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
  const bx = (type: string, content: Uint8Array) => concatBytes(u32be(content.length + 8), asciiToBytes(type), content);
  const uuidJson = concatBytes(asciiToBytes('json'), new Uint8Array([0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71]));
  const surgeryBox = bx('jumb', concatBytes(
    bx('jumd', concatBytes(uuidJson, new Uint8Array([0x03]), asciiToBytes('com.verify.exif'), new Uint8Array([0]))),
    bx('json', utf8ToBytes(JSON.stringify({ ISO: 3200, FNumber: 2.8 }))),
  ));

  // Walk the fixed layout: APP11 at 2 → store jumb → manifest jumb → claim,
  // assertions jumbs. Splice the box in as the assertions box's last child.
  const rd32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const segAt = 2;
  const storeAt = segAt + 4 + 8; // marker+length (4) + APP11 JUMBF header (8)
  const manifestAt = storeAt + 8 + rd32(baseJpeg, storeAt + 8); // past the store's jumd
  const claimAt = manifestAt + 8 + rd32(baseJpeg, manifestAt + 8); // past the manifest's jumd
  const assertionsAt = claimAt + rd32(baseJpeg, claimAt);
  const spliceAt = assertionsAt + rd32(baseJpeg, assertionsAt);

  const n = surgeryBox.length;
  const surgical = new Uint8Array(baseJpeg.length + n);
  surgical.set(baseJpeg.subarray(0, spliceAt), 0);
  surgical.set(surgeryBox, spliceAt);
  surgical.set(baseJpeg.subarray(spliceAt), spliceAt + n);
  const wr32 = (o: number, v: number) => {
    surgical[o] = (v >>> 24) & 0xff; surgical[o + 1] = (v >>> 16) & 0xff; surgical[o + 2] = (v >>> 8) & 0xff; surgical[o + 3] = v & 0xff;
  };
  wr32(assertionsAt, rd32(baseJpeg, assertionsAt) + n);
  wr32(manifestAt, rd32(baseJpeg, manifestAt) + n);
  wr32(storeAt, rd32(baseJpeg, storeAt) + n);
  const segLen = (baseJpeg[segAt + 2] << 8) | baseJpeg[segAt + 3];
  surgical[segAt + 2] = ((segLen + n) >> 8) & 0xff;
  surgical[segAt + 3] = (segLen + n) & 0xff;

  const sm = parseManifest(extractC2paStore(surgical)!.payload)!;
  check('the spliced box parses as UNREFERENCED (not claim-bound)',
    sm.exif !== null && sm.exif.referenced === false && sm.exif.data.ISO === 3200 &&
    !sm.referencedAssertionLabels.includes('com.verify.exif'),
    JSON.stringify({ exif: sm.exif, refs: sm.referencedAssertionLabels }));
  const sReport = await verifyPhotoBytes(surgical);
  check('the signature + claim binding survive the surgery (no false red on unreferenced boxes)',
    sReport.checks.signatureValid === true && sReport.c2pa?.claimAssertionsMatch === true,
    `verdict=${sReport.verdict} claims=${sReport.c2pa?.claimAssertionsMatch}`);
  check('the honest string: present but NOT referenced by the signed claim — no cryptographic weight',
    (sReport.checksNotPerformed ?? []).some((s) => s.includes('NOT referenced by the signed claim') && s.includes('no cryptographic weight')),
    JSON.stringify(sReport.checksNotPerformed ?? []));
  check('the claim-bound string is NOT shown for the unreferenced box',
    !(sReport.checksPerformed ?? []).some((s) => s.includes('hash cross-checked against the claim')),
    JSON.stringify((sReport.checksPerformed ?? []).filter((s) => s.includes('EXIF'))));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ROUND TRIP CLOSED — builder and verifier cannot drift apart silently');
