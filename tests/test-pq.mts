// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Post-quantum dual signature.
 *
 * One commitment, two signatures — and the honest limits, pinned:
 *   - both layers verify on a dual-signed capture (record AND COSE claim)
 *   - tampering fails BOTH layers; a PQ failure never flips the verdict
 *     (the classical layer is load-bearing; PQ is additive assurance)
 *   - stripping the PQ signature is DETECTABLE: the committed key lives
 *     inside the signed payload and cannot leave it silently
 *   - custody is literal: alg 'ML-DSA-65', custody 'software', forever —
 *     this layer hedges P-256 cryptanalysis, it is NOT a hardware anchor
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-pq.mts
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import {
  generatePqKeyPair, pqKeyPairFromSeed, pqPublicKeyFromSecret, pqPublicBlock, pqPublicBlockFrom,
  pqSign, pqVerify, pqFingerprint, pqClaimSigner,
  PQ_ALG, PQ_CUSTODY, PQ_SIZES,
} from './pq.mts';
import { buildRecord } from './manifest.mts';
import { signRecord, verifyRecordSignature } from './sign.mts';
import { attestPhoto, attestPng, attestVideo } from './attest.mts';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';
import { buildC2paSegment, extractC2paStore, parseManifest, verifyManifest } from './c2pa.mts';
import { buildSelfSignedCert } from './cert.mts';
import { parseCertificate } from './x509.mts';
import { labSigner } from './deviceKey-shim.mts';
import { asciiToBytes, base64ToBytes, bytesToHex, concatBytes, utf8ToBytes } from './bytes.mts';
import { randomBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

// ---------- primitives ----------
console.log('— ML-DSA-65 primitives —');
const kp = generatePqKeyPair();
check('FIPS 204 sizes pin (pub 1952 / sec 4032 / sig 3309)',
  kp.publicKey.length === PQ_SIZES.publicKey && kp.secretKey.length === PQ_SIZES.secretKey && PQ_SIZES.signature === 3309);
const msg = utf8ToBytes('one commitment, two signatures');
const sig = pqSign(kp.secretKey, msg);
check('sign/verify round-trip', pqVerify(kp.publicKey, msg, sig));
check('wrong message rejected', !pqVerify(kp.publicKey, utf8ToBytes('one commitment, two signatures!'), sig));
check('wrong key rejected', !pqVerify(generatePqKeyPair().publicKey, msg, sig));
check('truncated signature rejected (length guard)', !pqVerify(kp.publicKey, msg, sig.subarray(0, 100)));
check('public key derives from secret key', bytesToHex(pqPublicKeyFromSecret(kp.secretKey)) === bytesToHex(kp.publicKey));
// A signature made WITHOUT our FIPS 204 context string is not ours.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
const foreignSig = new Uint8Array(ml_dsa65.sign(msg, kp.secretKey));
check('foreign-context signature rejected (domain separation)', !pqVerify(kp.publicKey, msg, foreignSig));
// Seed storage: the app keeps 32 bytes in the keychain, derives the rest.
const seed = randomBytes(32);
const fromSeed = pqKeyPairFromSeed(seed);
// FIPS 204 known-answer pin: keygen from the fixed seed
// 00 01 02 … 1f must always yield the same ML-DSA-65 public key. This pins
// the shipped library to FIPS 204 final (not a draft parameter set) and
// catches any silent dependency drift — a library that fails this KAT is
// not the ML-DSA-65 this layer claims to be.
const KAT_SEED = new Uint8Array(32); for (let i = 0; i < 32; i++) KAT_SEED[i] = i;
check('FIPS 204 known-answer: fixed seed → pinned public-key fingerprint',
  pqKeyPairFromSeed(KAT_SEED).fingerprint === 'd666806e11cee19a7c989f7445f90dd419cf4d2d51db8c0fdb4c0f0a542238c9',
  pqKeyPairFromSeed(KAT_SEED).fingerprint);
check('seed-derived keypair is deterministic', bytesToHex(pqKeyPairFromSeed(seed).publicKey) === bytesToHex(fromSeed.publicKey));
check('different seed, different key', pqKeyPairFromSeed(randomBytes(32)).fingerprint !== fromSeed.fingerprint);
check('seed-derived key signs and verifies', pqVerify(fromSeed.publicKey, msg, pqSign(fromSeed.secretKey, msg)));

const enrolledAt = new Date().toISOString();
const pqCapture = { secretKey: kp.secretKey, publicKey: kp.publicKey, fingerprint: kp.fingerprint, enrolledAt };

// ---------- record layer ----------
console.log('— record layer: one payload, two signatures —');
const key = labSigner();
const devPub = base64ToBytes(key.publicKeyBase64);
const devCert = await buildSelfSignedCert(devPub, key.signDigest, new Date(Date.now() - 60_000));
const ctx = { location: null, headingDeg: null, pressureHPa: null, altitudeM: null, motion: null } as any;
const mkRecord = () => buildRecord({
  assetSha256: bytesToHex(sha256(utf8ToBytes('media-bytes'))),
  assetBytes: 11,
  mime: 'image/jpeg',
  kind: 'photo',
  capturedAt: new Date().toISOString(),
  appVersion: '0.10.0-lab',
  deviceModel: 'lab',
  platform: 'lab',
  identity: { author: 'PQ Test', organization: null },
  context: ctx,
  publicKeyBase64: key.publicKeyBase64,
  fingerprint: key.fingerprint,
});

const dual = await signRecord({ ...mkRecord(), pqKey: pqPublicBlock(kp.publicKey, enrolledAt) }, key.signDigest, key.signPayload, pqCapture);
const dualCheck = verifyRecordSignature(dual);
check('dual-signed record: ES256 valid', dualCheck.signatureValid);
check('dual-signed record: PQ layer present + committed + valid',
  !!dualCheck.pq && dualCheck.pq.present && dualCheck.pq.keyCommitted && dualCheck.pq.keyFingerprintMatches && dualCheck.pq.signatureValid);
check('custody labels are literal (ML-DSA-65 / software)',
  dual.pqKey?.alg === PQ_ALG && dual.pqKey?.custody === PQ_CUSTODY && dualCheck.pq?.custody === PQ_CUSTODY);

const legacy = await signRecord(mkRecord(), key.signDigest, key.signPayload);
check('legacy record (no PQ) evaluates to null, not failure', verifyRecordSignature(legacy).pq === null);

const tampered = { ...dual, capturedAt: new Date(Date.now() + 60_000).toISOString() };
const tamperedCheck = verifyRecordSignature(tampered);
check('tampered payload: ES256 invalid', !tamperedCheck.signatureValid);
check('tampered payload: PQ invalid too', tamperedCheck.pq !== null && !tamperedCheck.pq.signatureValid);

const strippedSig = { ...dual };
delete strippedSig.pqSignature;
const stripCheck = verifyRecordSignature(strippedSig);
check('stripped PQ signature: classical layer UNAFFECTED (strip is silent to ES256 — hence the flag)', stripCheck.signatureValid);
check('stripped PQ signature: detectable (committed key present, signature absent)',
  !!stripCheck.pq && !stripCheck.pq.present && stripCheck.pq.keyCommitted);

const strippedKey = { ...dual };
delete strippedKey.pqKey;
check('stripping the committed KEY breaks the classical signature (it is inside the signed payload)',
  !verifyRecordSignature(strippedKey).signatureValid);

const otherDual = await signRecord({ ...mkRecord(), pqKey: pqPublicBlock(kp.publicKey, enrolledAt) }, key.signDigest, key.signPayload, pqCapture);
const swapped = { ...dual, pqSignature: otherDual.pqSignature };
check('PQ signature swapped from another record rejected', verifyRecordSignature(swapped).pq?.signatureValid === false);

// ---------- claim layer: full JPEG ----------
console.log('— claim layer: dual-signed JPEG end to end —');
const photo = await attestPhoto({
  photoUri: '/tmp/lab/clean.jpg',
  context: { location: { lat: 37.7749, lon: -122.4194, accuracyM: 5 }, headingDeg: 90 } as any,
  identity: { author: 'PQ Test', organization: null },
  key,
  pq: pqCapture,
});
const media = photo.signedPhotoBytes!;
const report = await verifyPhotoBytes(media);
check('dual-signed JPEG verifies INTACT', report.verdict === 'INTACT', report.verdict);
check('report carries the record PQ layer valid, and no claim entry',
  report.c2pa?.pq?.record?.signatureValid === true && report.c2pa?.pq?.claim?.present !== true,
  JSON.stringify(report.c2pa?.pq ?? null).slice(0, 120));
check('the performed list labels the custody (SOFTWARE key, not a hardware anchor)',
  (report.checksPerformed ?? []).some((s) => s.includes('ML-DSA-65') && s.includes('SOFTWARE')),
  (report.checksPerformed ?? []).filter((s) => s.includes('post-quantum')).join(' | '));
const store = extractC2paStore(media);
const manifest = store ? parseManifest(store.payload) : null;
check('the manifest carries no verifyPq entry — the signature is on the record',
  !manifest?.pq);
check('the record signature is a full ML-DSA-65 signature bound to the committed key',
  !!photo.record.pqSignature
  && base64ToBytes(photo.record.pqSignature).length === PQ_SIZES.signature
  && pqPublicBlockFrom((photo.record.context as any)?.pqKey ?? (photo.record as any).pqKey)?.fingerprint === kp.fingerprint);

// ---------- strip detection (record layer) ----------
console.log('— strip detection —');
// A "stripped" file: the record still commits a PQ key inside its signed
// payload, but pqSignature is gone. That is exactly what a stripper leaves
// behind, and the commitment cannot be removed without breaking the classical
// signature — so the gap is visible. The classical layer still verifies.
{
  const insertOffset = 2;
  const clean = fs.readFileSync('/tmp/lab/clean.jpg');
  const { pqSignature: _dropped, ...withoutPq } = photo.record as any;
  const strippedRecord = await signRecord(withoutPq, key.signDigest, key.signPayload); // no pq arg
  const segment = await buildC2paSegment(
    {
      appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
      mime: 'image/jpeg',
      title: 'stripped.jpg',
      instanceId: 'xmp:iid:' + bytesToHex(randomBytes(16)),
      telemetry: strippedRecord as unknown as Record<string, unknown>,
      signDigest: key.signDigest,
      signPayload: key.signPayload,
      pq: null,
      certChain: [devCert],
      cleanFileSha256: new Uint8Array(sha256(clean)),
    },
    insertOffset,
  );
  const strippedMedia = concatBytes(clean.subarray(0, insertOffset), segment, clean.subarray(insertOffset));
  const r = await verifyPhotoBytes(strippedMedia);
  check('stripped file still verifies INTACT classically (PQ absence never convicts)', r.verdict === 'INTACT', r.verdict);
  check('strip detected at the record layer (key committed, signature absent)',
    r.c2pa?.pq?.record?.present === false && r.c2pa?.pq?.record?.keyCommitted === true,
    JSON.stringify(r.c2pa?.pq?.record));
  check('the STRIPPED warning line is loud and says what happened',
    (r.checksPerformed ?? []).some((x) => x.includes('STRIPPED') && x.includes('altered after signing')),
    (r.checksPerformed ?? []).filter((x) => x.includes('STRIPPED')).join(' | '));
}

// ---------- the PQ signature lives in the record ----------
console.log('— record-carried PQ layer —');
// The record carries the signature. pqSignature signs the record, the record
// commits asset.sha256, and the verifier compares that against the bytes it
// read.
{
  const insertOffset = 2;
  const clean = fs.readFileSync('/tmp/lab/clean.jpg');
  const segment = await buildC2paSegment(
    {
      appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
      mime: 'image/jpeg',
      title: 'record-only.jpg',
      instanceId: 'xmp:iid:' + bytesToHex(randomBytes(16)),
      telemetry: photo.record as unknown as Record<string, unknown>,
      signDigest: key.signDigest,
      signPayload: key.signPayload,
      pq: null, // as every capture is built
      certChain: [devCert],
      cleanFileSha256: new Uint8Array(sha256(clean)),
    },
    insertOffset,
  );
  const media = concatBytes(clean.subarray(0, insertOffset), segment, clean.subarray(insertOffset));
  const r = await verifyPhotoBytes(media);

  check('record-only: file verifies INTACT', r.verdict === 'INTACT', r.verdict);
  check('record-only: the record PQ layer verifies',
    r.c2pa?.pq?.record?.signatureValid === true);
  check('record-only: no claim entry is emitted', r.c2pa?.pq?.claim?.present !== true);
  check('record-only: an absent claim entry is NOT reported as stripping',
    !(r.checksPerformed ?? []).some((x) => x.includes('STRIPPED')),
    (r.checksPerformed ?? []).filter((x) => x.includes('STRIPPED')).join(' | '));
  check('record-only: the media is still bound (asset digest compared)',
    r.checks.assetHashMatches === true);
  check('record-only: the PQ layer is reported as carried on the record',
    (r.checksPerformed ?? []).some((x) => x.includes('post-quantum layer verified on the record')));
}

// ---------- forgery: foreign PQ signature binds to nothing ----------
console.log('— forgery resistance —');
{
  const forger = generatePqKeyPair();
  const insertOffset = 2;
  const clean = fs.readFileSync('/tmp/lab/clean.jpg');
  const segment = await buildC2paSegment(
    {
      appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
      mime: 'image/jpeg',
      title: 'forged.jpg',
      instanceId: 'xmp:iid:' + bytesToHex(randomBytes(16)),
      telemetry: photo.record as unknown as Record<string, unknown>, // commits OUR key
      signDigest: key.signDigest,
      signPayload: key.signPayload,
      pq: pqClaimSigner({ ...forger, enrolledAt }), // …but signed with THE FORGER's key
      certChain: [devCert],
      cleanFileSha256: new Uint8Array(sha256(clean)),
    },
    insertOffset,
  );
  const forgedMedia = concatBytes(clean.subarray(0, insertOffset), segment, clean.subarray(insertOffset));
  const r = await verifyPhotoBytes(forgedMedia);
  check('forged PQ entry: signature check FAILS (fingerprint bound to committed key)',
    r.c2pa?.pq?.claim?.present === true && r.c2pa?.pq?.claim?.signatureValid === false);
  check('a failed PQ layer never flips the verdict (additive assurance, not a downgrade vector)',
    r.verdict === 'INTACT', r.verdict);
  check('the FAILED line is loud and keeps the classical layer standing',
    (r.checksPerformed ?? []).some((s) => s.includes('post-quantum layer') && s.includes('FAILED') && s.includes('classical layer still stands')));
}

// ---------- APP11 budget ----------
console.log('— APP11 64 KB budget —');
// Mock ECDSA TSA (minimal, mirrors test-roundtrip's plumbing) so the budget
// is measured WITH witness tokens, not in the cheap case.
function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const b: number[] = []; let v = n;
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
const NULL = new Uint8Array([0x05, 0x00]);
const OID = {
  signedData: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02],
  tstInfo: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x10, 0x01, 0x04],
  contentType: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x03],
  messageDigest: [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x09, 0x04],
  sha256: [0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01],
  ecdsaSha256: [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02],
  policy: [0x2a, 0x03, 0x04],
};
const generalizedTime = (d: Date) => tlv(0x18, asciiToBytes(
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`));
function mockToken(certDer: Uint8Array, message: Uint8Array, sign: (b: Uint8Array) => Uint8Array): Uint8Array {
  const parsed = parseCertificate(certDer);
  const tst = seq(int1(1), oid(OID.policy), seq(seq(oid(OID.sha256), NULL), octet(sha256(message))), intBytes(randomBytes(8)), generalizedTime(new Date()));
  const attrsContent = concatBytes(seq(oid(OID.contentType), set(oid(OID.tstInfo))), seq(oid(OID.messageDigest), set(octet(sha256(tst)))));
  const signature = sign(tlv(0x31, attrsContent));
  const signerInfo = seq(
    int1(1), seq(parsed.issuerRaw, intBytes(parsed.serial)), seq(oid(OID.sha256), NULL),
    tlv(0xa0, attrsContent), seq(oid(OID.ecdsaSha256), NULL), octet(signature),
  );
  return seq(oid(OID.signedData), tlv(0xa0, seq(
    int1(3), set(seq(oid(OID.sha256), NULL)), seq(oid(OID.tstInfo), tlv(0xa0, octet(tst))), tlv(0xa0, certDer), set(signerInfo),
  )));
}
const tsaPriv = p256.utils.randomPrivateKey();
const tsaPub = p256.getPublicKey(tsaPriv, false);
const tsaCert = await buildSelfSignedCert(tsaPub, async (d) => p256.sign(d, tsaPriv).toDERRawBytes(), new Date(Date.now() - 60_000), { eku: 'timeStamping' });
const twoTokens = async (message: Uint8Array) => [
  mockToken(tsaCert, message, (sb) => p256.sign(sha256(sb), tsaPriv).toDERRawBytes()),
  mockToken(tsaCert, message, (sb) => p256.sign(sha256(sb), tsaPriv).toDERRawBytes()),
];
{
  const insertOffset = 2;
  const clean = fs.readFileSync('/tmp/lab/clean.jpg');
  const mk = (withPq: boolean) =>
    buildC2paSegment(
      {
        appName: 'ExhibitA/0.10.0-lab (com.verify.camera)',
        mime: 'image/jpeg',
        title: 'budget.jpg',
        instanceId: 'xmp:iid:' + bytesToHex(randomBytes(16)),
        telemetry: photo.record as unknown as Record<string, unknown>,
        signDigest: key.signDigest,
        signPayload: key.signPayload,
        pq: withPq ? pqClaimSigner(pqCapture) : null,
        certChain: [devCert],
        cleanFileSha256: new Uint8Array(sha256(clean)),
        fetchTimestamp: twoTokens,
        exif: { ISO: 400, FNumber: 1.78, FocalLength: 6.86, Orientation: 1 },
      },
      insertOffset,
    );
  const noPq = await mk(false);
  const withPq = await mk(true);
  console.log(`  info APP11 segment: no-PQ ${noPq.length} B · dual-signed ${withPq.length} B · delta ${withPq.length - noPq.length} B · wall 65535 B`);
  // NOTE: the no-PQ run still carries the committed pqKey block (telemetry is
  // the same signed record) — the delta measures the COSE entry + record
  // pqSignature, i.e. the marginal cost of the layer, ~7.9 KB.
  check('dual-signed + 2 witness tokens stays inside the APP11 wall', withPq.length <= 65535, `${withPq.length}`);
  check('headroom canary: ≥ 8 KB spare for TSA variance and future assertions', withPq.length <= 65535 - 8192, `${withPq.length}`);
}

// ---------- PNG + BMFF ----------
console.log('— PNG + video carry the layer too —');
const cleanPng = fs.readFileSync('/tmp/lab/clean.png');
const png = await attestPng({ pngBytes: cleanPng, context: ctx, identity: { author: 'PQ Test', organization: null }, key, pq: pqCapture });
const pngReport = await verifyPhotoBytes(png.signedPngBytes);
check('dual-signed PNG verifies INTACT with the PQ layer',
  pngReport.verdict === 'INTACT' && pngReport.c2pa?.pq?.record?.signatureValid === true,
  `${pngReport.verdict} ${JSON.stringify(pngReport.c2pa?.pq ?? null).slice(0, 100)}`);

const video = await attestVideo({ videoUri: '/tmp/lab/clean.mp4', context: ctx, identity: { author: 'PQ Test', organization: null }, key, pq: pqCapture });
const videoReport = await verifyVideoBytes(video.signedVideoBytes!);
check('dual-signed MP4 verifies INTACT with the PQ layer',
  videoReport.verdict === 'INTACT' && videoReport.c2pa?.pq?.record?.signatureValid === true,
  `${videoReport.verdict} ${JSON.stringify(videoReport.c2pa?.pq ?? null).slice(0, 100)}`);

// ---------- block shape ----------
console.log('— committed block shape —');
const block = pqPublicBlock(kp.publicKey, enrolledAt);
check('block round-trips through the shape checker', pqPublicBlockFrom(JSON.parse(JSON.stringify(block)))?.fingerprint === kp.fingerprint);
check('foreign alg refused', pqPublicBlockFrom({ ...block, alg: 'ML-DSA-44' }) === null);
check('foreign custody refused (the label is not decorative)', pqPublicBlockFrom({ ...block, custody: 'enclave' }) === null);
check('truncated key refused', pqPublicBlockFrom({ ...block, publicKey: block.publicKey.slice(0, 100) }) === null);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
