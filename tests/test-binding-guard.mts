// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The signed-claim binding guard. A c2pa.hash.* assertion binds media only when
 * the signed claim references it. Three defective-credential shapes:
 *
 *  1. Foreign claim with no binding assertion.
 *  2. Malformed exclusion set (overlapping ranges).
 *  3. Attach attack: a genuinely signed telemetry-only claim plus a
 *     self-consistent binding box added post-signing over different media.
 *
 * All three must land SIGNATURE_INVALID with assetHashFailure 'void-binding'
 * (integrity unproven, not proven tamper), and the disclosure line must say the
 * binding is void. Control: a normal Source Kit manifest verifies INTACT.
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { Encoder } from 'cbor-x';
import { bytesToHex, concatBytes, asciiToBytes, utf8ToBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { buildC2paSegment, extractC2paStore } from './c2pa.mts';
import { attestPhoto } from './attest.mts';
import { derToP1363LowS } from './der.mts';
import { verifyPhotoBytes } from './verifyAsset.mts';
import { labSigner } from './deviceKey-shim.mts';

const encoder = new Encoder({ tagUint8Array: false, useRecords: false });
const encode = (v: unknown): Uint8Array => encoder.encode(v);

const UUID_SUFFIX = [0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
const c2paUuid = (p: string) => concatBytes(asciiToBytes(p), new Uint8Array(UUID_SUFFIX));
const u32be = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const box = (t: string, c: Uint8Array) => concatBytes(u32be(c.length + 8), asciiToBytes(t), c);
const jumbBox = (uuid: Uint8Array, label: string, ...contents: Uint8Array[]) =>
  box('jumb', concatBytes(box('jumd', concatBytes(uuid, new Uint8Array([0x03]), asciiToBytes(label), new Uint8Array([0]))), ...contents));
const hashJumbContent = (j: Uint8Array) => sha256(j.subarray(8));
function bstr(x: Uint8Array): Uint8Array {
  const n = x.length;
  const head = n < 24 ? new Uint8Array([0x40 | n]) : n < 256 ? new Uint8Array([0x58, n]) : new Uint8Array([0x59, (n >> 8) & 0xff, n & 0xff]);
  return concatBytes(head, x);
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const key = labSigner();
const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const clean = new Uint8Array(fs.readFileSync(new URL('./clean.jpg', import.meta.url).pathname));

/** Hand-assembled foreign-style manifest: the claim references exactly the given assertion boxes. */
async function foreignSegment(assertionBoxes: Uint8Array[], labels: string[]): Promise<Uint8Array> {
  const uuid = bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const claimBytes = encode({
    claim_generator: 'ForeignTool/1.0', 'dc:format': 'image/jpeg', 'dc:title': 'guard.jpg',
    instanceID: uuid,
    assertions: assertionBoxes.map((b, i) => ({ url: 'self#jumbf=c2pa.assertions/' + labels[i], alg: 'sha256', hash: hashJumbContent(b) })),
    signature: 'self#jumbf=c2pa.signature', alg: 'sha256',
  });
  const protectedBstr = bstr(concatBytes(new Uint8Array([0xa2, 0x01, 0x26, 0x18, 0x21, 0x81]), bstr(devCert)));
  const sigPayload = concatBytes(new Uint8Array([0x84, 0x6a]), asciiToBytes('Signature1'), protectedBstr, new Uint8Array([0x40]), bstr(claimBytes));
  const rawSig = derToP1363LowS(await key.signDigest(sha256(sigPayload)));
  const cose = concatBytes(new Uint8Array([0xd2, 0x84]), protectedBstr, new Uint8Array([0xa0, 0xf6]), bstr(rawSig));
  const store = jumbBox(c2paUuid('c2pa'), 'c2pa', jumbBox(c2paUuid('c2ma'), 'foreign:urn:uuid:' + uuid,
    jumbBox(c2paUuid('c2cl'), 'c2pa.claim', box('cbor', claimBytes)),
    jumbBox(c2paUuid('c2as'), 'c2pa.assertions', ...assertionBoxes),
    jumbBox(c2paUuid('c2cs'), 'c2pa.signature', box('cbor', cose))));
  const payload = concatBytes(new Uint8Array([0x4a, 0x50, 0x02, 0x11, 0x00, 0x00, 0x00, 0x01]), store);
  const length = payload.length + 2;
  return concatBytes(new Uint8Array([0xff, 0xeb, (length >> 8) & 0xff, length & 0xff]), payload);
}

const telemetryBox = jumbBox(c2paUuid('json'), 'com.verify.telemetry', box('json', utf8ToBytes(JSON.stringify({ format: 'lab' }))));
const hashDataBox = (exclusions: unknown, hash: Uint8Array) =>
  jumbBox(c2paUuid('cbor'), 'c2pa.hash.data', box('cbor', encode({ exclusions, alg: 'sha256', hash, name: 'jumbf manifest', pad: new Uint8Array(10) })));

// ---------- control: a normal Source Kit manifest still verifies INTACT ----------
const controlSeg = await buildC2paSegment({
  appName: 'ExhibitA/0.11.0-lab', mime: 'image/jpeg', title: 'guard-control.jpg',
  instanceId: 'xmp:iid:' + bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16)),
  telemetry: { format: 'lab', note: 'binding guard control' },
  signDigest: key.signDigest, signPayload: key.signPayload,
  certChain: [devCert], cleanFileSha256: sha256(clean),
}, 2);
const control = await verifyPhotoBytes(concatBytes(clean.subarray(0, 2), controlSeg, clean.subarray(2)));
check('control: genuine Source Kit manifest still INTACT', control.verdict === 'INTACT', control.verdict);

// ---------- 1. no binding assertion referenced by the claim ----------
const segA = await foreignSegment([telemetryBox], ['com.verify.telemetry']);
const rA = await verifyPhotoBytes(concatBytes(clean.subarray(0, 2), segA, clean.subarray(2)));
check('no binding assertion: NOT mislabeled CONTENT_MODIFIED', rA.verdict !== 'CONTENT_MODIFIED', rA.verdict);
check('no binding assertion: SIGNATURE_INVALID (defective credentials)', rA.verdict === 'SIGNATURE_INVALID', rA.verdict);
check('no binding assertion: void-binding disclosed', rA.c2pa?.assetHashFailure === 'void-binding');
check('no binding assertion: UNPROVEN stated in performed lines',
  (rA.checksPerformed ?? []).some((l) => /VOID|UNPROVEN/.test(l)));
check('no binding assertion: assetHashMatches null (UNPROVEN, not false)', rA.checks.assetHashMatches === null);

// ---------- 2. malformed exclusion set (overlapping ranges covering the manifest) ----------
// Build once to learn the segment length, then declare two identical ranges.
const probeSeg = await foreignSegment([hashDataBox([{ start: 2, length: 1 }], sha256(clean)), telemetryBox], ['c2pa.hash.data', 'com.verify.telemetry']);
const segLen = probeSeg.length;
const segB = await foreignSegment(
  [hashDataBox([{ start: 2, length: segLen }, { start: 2, length: segLen }], sha256(clean)), telemetryBox],
  ['c2pa.hash.data', 'com.verify.telemetry']);
const rB = await verifyPhotoBytes(concatBytes(clean.subarray(0, 2), segB, clean.subarray(2)));
check('overlapping exclusions: SIGNATURE_INVALID, never "media altered"', rB.verdict === 'SIGNATURE_INVALID', rB.verdict);
check('overlapping exclusions: void-binding (malformed set, not mismatch)', rB.c2pa?.assetHashFailure === 'void-binding', String(rB.c2pa?.assetHashFailure));

// ---------- 3. the attach attack: binding box added post-signing over DIFFERENT media ----------
// The victim is a genuinely signed capture: the attacker flips one media byte,
// strips the legit APP11 chain, and splices in a telemetry-only claim whose
// binding box rides unreferenced in the assertions set while its hash.data
// covers the modified media. Self-consistent except that the signed claim never
// declares the binding. The victim must be the signed fixture: splicing into
// the unsigned clean.jpg (which opens with a 16-byte APP0) corrupts the JPEG
// mid-stream and the scanner bails before the guard runs.
const labCtx = { location: null, headingDeg: null, pressureHPa: null, altitudeM: null, motion: null } as never;
const signedClean = (await attestPhoto({
  photoUri: new URL('./clean.jpg', import.meta.url).pathname,
  context: labCtx, identity: { author: 'Guard Lab', organization: null }, key,
})).signedPhotoBytes!;
const legitStore = extractC2paStore(signedClean);
if (!legitStore) throw new Error('attach-attack setup: signed fixture carries no extractable C2PA store');
const other = new Uint8Array(signedClean);
other[other.length - 500] ^= 0xff; // attacker media (past the manifest, inside the scan data)
// Attacker's self-consistent binding: the exclusion covers their own segment
// slot and the hash covers the modified media. The span is solved by
// fixed-point iteration since the CBOR width of `length` changes the segment
// size.
const strippedOther = concatBytes(other.subarray(0, 2), other.subarray(2 + legitStore.segmentLength));
const attackerHash = sha256(strippedOther);
const uuidC = bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
// The claim signs only telemetry; the assertions box carries the attacker's binding.
const claimC = encode({
  claim_generator: 'ForeignTool/1.0', 'dc:format': 'image/jpeg', 'dc:title': 'guard.jpg',
  instanceID: uuidC,
  assertions: [{ url: 'self#jumbf=c2pa.assertions/com.verify.telemetry', alg: 'sha256', hash: hashJumbContent(telemetryBox) }],
  signature: 'self#jumbf=c2pa.signature', alg: 'sha256',
});
const protC = bstr(concatBytes(new Uint8Array([0xa2, 0x01, 0x26, 0x18, 0x21, 0x81]), bstr(devCert)));
const sigC = derToP1363LowS(await key.signDigest(sha256(concatBytes(new Uint8Array([0x84, 0x6a]), asciiToBytes('Signature1'), protC, new Uint8Array([0x40]), bstr(claimC)))));
const coseC = concatBytes(new Uint8Array([0xd2, 0x84]), protC, new Uint8Array([0xa0, 0xf6]), bstr(sigC));
const assembleSegC = (span: number): Uint8Array => {
  const attackerBox = hashDataBox([{ start: 2, length: span }], attackerHash);
  const storeC = jumbBox(c2paUuid('c2pa'), 'c2pa', jumbBox(c2paUuid('c2ma'), 'foreign:urn:uuid:' + uuidC,
    jumbBox(c2paUuid('c2cl'), 'c2pa.claim', box('cbor', claimC)),
    jumbBox(c2paUuid('c2as'), 'c2pa.assertions', attackerBox, telemetryBox),
    jumbBox(c2paUuid('c2cs'), 'c2pa.signature', box('cbor', coseC))));
  const payloadC = concatBytes(new Uint8Array([0x4a, 0x50, 0x02, 0x11, 0x00, 0x00, 0x00, 0x01]), storeC);
  const lenC = payloadC.length + 2;
  return concatBytes(new Uint8Array([0xff, 0xeb, (lenC >> 8) & 0xff, lenC & 0xff]), payloadC);
};
let spanC = 1;
for (let i = 0; i < 4; i++) {
  const lenC = assembleSegC(spanC).length;
  if (lenC === spanC) break;
  spanC = lenC;
}
const segC = assembleSegC(spanC);
const fileC = concatBytes(other.subarray(0, 2), segC, other.subarray(2 + legitStore.segmentLength));
const rC = await verifyPhotoBytes(fileC);
check('attach attack: NEVER INTACT (the false green is closed)', rC.verdict !== 'INTACT', rC.verdict);
check('attach attack: SIGNATURE_INVALID (unreferenced binding = defective credentials)', rC.verdict === 'SIGNATURE_INVALID', rC.verdict);
check('attach attack: void-binding disclosed', rC.c2pa?.assetHashFailure === 'void-binding');

console.log(`=== binding-guard: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
