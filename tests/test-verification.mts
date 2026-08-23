// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Verification + forgery-regression suite. Run: npm run test:verify
 *
 * Mirror of the app tree's scripts/test-verification.mts; imports resolve
 * against the staged flat modules. Identical to the app suite except for
 * the import paths (stage.mjs generates the media fixtures).
 *
 * Forgery attacks, encoded as regression tests:
 *   - a junk x5chain must not produce a green chain badge
 *   - a junk or forged attestation must not produce a green attestation badge
 *   - junk or tampered RFC 3161 tokens must not count as trusted time
 * Every negative case uses well-formed cryptography (real certs, real CMS) so
 * the verifiers do the rejecting, not the parser's error handling.
 *
 * Fixtures (scripts/fixtures/) were generated once with openssl:
 *   ca.crt.der            P-256 test root CA
 *   leaf.crt.der          device leaf signed by that CA
 *   leaf-tampered.crt.der same leaf with one signature bit flipped
 *   evil.crt.der          self-issued "O=Reuters" cert — a forgery attack
 *   token.der             genuine RFC 3161 token over message.bin (test TSA)
 *   token-tampered.der    same token with one byte flipped
 */
import * as fs from 'fs';
import { encode, decode } from 'cbor-x';
import {
  parseCertificate, verifyChain, readTlv, tlvChildren,
} from './x509.mts';
import { verifyTimestampToken } from './rfc3161.mts';
import { pinnedTsaFor, PINNED_TSAS } from './tsaTrustList.mts';
import { sanitizeExif, hasExifSignal } from './exif.mts';
import {
  isValidTip, nextRefreshDelayMs, setBeaconEndpoint, currentBeacon, refreshBeacon,
  resetBeaconForTests, BEACON_REFRESH_BASE_MS, BEACON_REFRESH_JITTER_MS, BEACON_NOTE,
} from './beacon.mts';
import { pHashFromGray32, hammingDistanceHex } from './phash.mts';
import {
  analyzeBanding, analyzeMoire, analyzeBlackFloor, analyzeGamut, snrStrength,
} from './rephoto.mts';
import { rocCurve, auc, operatingPoint, buildRocReport, type LabeledScore } from './roc.mts';
import { estimateGlobalMotion } from './opticalflow.mts';
import { analyzeImuFlowConsistency, type FlowSample } from './imuflow.mts';
import { verifyAppAttestAssertion } from './verifyAppAttest.mts';
import { buildC2paSegment, parseManifest, parseManifestChain, verifyManifest, extractC2paStore, hashBmffV2, sha256ExcludingRanges } from './c2pa.mts';
import { PNG_SIGNATURE, caBxChunk, extractCaBx } from './png.mts';
import { parseRootBoxes, extractC2paStoreBmff, buildC2paUuidBox } from './bmff.mts';
import { buildSelfSignedCert } from './cert.mts';
import { createRoster, resignRoster, resolveInRoster, rotateEntry, revokeEntry, verifyRosterSignature, type Roster } from './roster.mts';
import { OTS_MAGIC, buildPendingReceipt, parseOtsReceipt, verifyOtsReceipt } from './ots.mts';
import { buildHashClaim, buildProofBundle, isHashClaim, isProofBundle,
  exportEntriesToCsv, exportEntriesToGeoJson, exportEntriesToKml, type ExportEntry } from './proofBundle.mts';
import { analyzeTiming, buildPoseTrace, type PoseSample } from './motion.mts';
import { buildRecord } from './manifest.mts';
import { signRecord, payloadDigest, verifyRecordSignature } from './sign.mts';
import { APPLE_ATTEST_ROOT_DER } from './appleAttestRoot.mts';
import { base64ToBytes, bytesToBase64, bytesToHex, utf8ToBytes, concatBytes } from './bytes.mts';
import { sha256 } from '@noble/hashes/sha256';
import { p256 } from '@noble/curves/p256';

const fx = (name: string): Uint8Array =>
  new Uint8Array(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));


const caDer = fx('ca.crt.der');
const leafDer = fx('leaf.crt.der');
const leafTamperedDer = fx('leaf-tampered.crt.der');
const evilDer = fx('evil.crt.der');
const tokenDer = fx('token.der');
const tokenTamperedDer = fx('token-tampered.der');
const message = fx('message.bin');

/** Fixed reference time inside every fixture's validity window. */
const AT = Date.parse('2026-08-01T12:00:00Z');

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}

console.log('\n— X.509 chain verification —');

const good = verifyChain([leafDer, caDer], [caDer], AT);
check('real chain verifies and anchors to its pinned CA', good.linksValid && good.anchored, good.reason ?? '');

const unanchored = verifyChain([leafDer, caDer], [], AT);
check('same chain without a pinned root is honest: links valid, NOT anchored',
  unanchored.linksValid && !unanchored.anchored);

const tampered = verifyChain([leafTamperedDer, caDer], [caDer], AT);
check('one flipped signature bit breaks the chain', !tampered.linksValid && (tampered.reason ?? '').includes('signature'), tampered.reason ?? '');

const reuters = verifyChain([evilDer], [APPLE_ATTEST_ROOT_DER], AT);
check('self-issued "O=Reuters" cert does not anchor to the Apple root', !reuters.anchored, reuters.reason ?? '');

const apple = verifyChain([APPLE_ATTEST_ROOT_DER], [APPLE_ATTEST_ROOT_DER], AT);
check('pinned Apple root anchors to itself', apple.linksValid && apple.anchored, apple.reason ?? '');

const expired = verifyChain([leafDer, caDer], [caDer], Date.parse('2040-01-01T00:00:00Z'));
check('signing time outside validity window is rejected', !expired.linksValid && (expired.reason ?? '').includes('valid at signing time'), expired.reason ?? '');

const junk = verifyChain([new Uint8Array([0x30, 0x03, 0x01, 0x01, 0xff])], [], AT);
check('malformed cert is rejected, never trusted', !junk.linksValid && (junk.reason ?? '').includes('parse'), junk.reason ?? '');

const appleParsed = parseCertificate(APPLE_ATTEST_ROOT_DER);
check('pinned Apple root parses (P-384, CA)', appleParsed.keyAlg.kind === 'ec' && appleParsed.keyAlg.curve === 'p384' && appleParsed.subjectCN !== null && appleParsed.subjectCN.includes('Apple'));

console.log('\n— RFC 3161 timestamp verification —');

const tsGood = verifyTimestampToken(tokenDer, message);
check('genuine token verifies', tsGood.tokenValid, tsGood.reason ?? '');
check('genuine token yields a usable genTime', tsGood.genTimeUtc !== null && !Number.isNaN(Date.parse(tsGood.genTimeUtc)));
check('TSA name surfaced for display', tsGood.tsaName !== null && tsGood.tsaName.includes('Test TSA'), tsGood.tsaName ?? 'null');

const wrongMsg = new Uint8Array(message); wrongMsg[0] ^= 1;
const tsWrong = verifyTimestampToken(tokenDer, wrongMsg);
check('token does not countersign a different message', !tsWrong.tokenValid, tsWrong.reason ?? '');

const tsTampered = verifyTimestampToken(tokenTamperedDer, message);
check('one flipped byte in the SIGNER cert invalidates the token', !tsTampered.tokenValid, tsTampered.reason ?? '');
// A flip in a non-signer embedded chain cert does not invalidate: the
// corrupted cert is dropped and validity comes from the cryptography over the
// surviving signer cert (CMS signature, EKU, genTime). The chain is not
// anchored to a root, so nothing the verifier reports used the dropped cert.
{
  const tam = new Uint8Array(tokenDer);
  tam[200] ^= 0x01; // inside the embedded CA cert, which the fixture token does not sign with
  const r = verifyTimestampToken(tam, message);
  check('flip in a non-signer chain cert leaves crypto-decided validity intact (documented, deliberate)',
    r.tokenValid, r.reason ?? '');
}

const tsJunk = verifyTimestampToken(new Uint8Array([1, 2, 3, 4, 5]), message);
check('junk bytes fail cleanly (no throw, no green)', !tsJunk.tokenValid && tsJunk.reason !== null);

console.log('\n— TSA trust pinning —');

// The lab fixture TSA is self-made: the token is cryptographically genuine
// but the authority is on no trust list, which is the valid-but-unpinned
// state the UI must render without green.
check('genuine token surfaces chain fingerprints (signer first)',
  tsGood.tsaFingerprints.length > 0 && /^[0-9a-f]{64}$/.test(tsGood.tsaFingerprints[0]));
check('valid token from an unpinned authority is NOT trusted',
  tsGood.tokenValid && pinnedTsaFor(tsGood.tsaFingerprints) === null);

// Matching hits anywhere in the chain (leaf rotation under a pinned root
// must not silently downgrade to "unpinned").
const FREETSA_ROOT_FP = 'a6379e7cecc05faa3cbf076013d745e327bbbaa38c0b9af22469d4701d18aabc';
const GOOGLE_ROOT_FP = 'e383a91825ff2a0944857f2e0c1bebb3bdf84a3e430bb505fef8e4023ed8a3c7';
const pinViaRoot = pinnedTsaFor(['ff'.repeat(32), FREETSA_ROOT_FP]);
check('pin matches via a chain root, not only the leaf',
  pinViaRoot !== null && pinViaRoot.name.includes('FreeTSA'));
check('C2PA trust-list anchor matches (Google root)',
  (pinnedTsaFor([GOOGLE_ROOT_FP])?.name ?? '').includes('Google'));
check('unrelated fingerprints match nothing',
  pinnedTsaFor(['ab'.repeat(32), 'cd'.repeat(32)]) === null);
check('every pin is a unique 64-hex fingerprint with provenance',
  PINNED_TSAS.length >= 20 &&
  new Set(PINNED_TSAS.map((p) => p.certSha256)).size === PINNED_TSAS.length &&
  PINNED_TSAS.every((p) => /^[0-9a-f]{64}$/.test(p.certSha256) && p.source.length > 0 && p.name.length > 0));

console.log('\n— Apple App Attest assertion verification —');

const signerPub = p256.getPublicKey(p256.utils.randomPrivateKey(), false);

const absent = verifyAppAttestAssertion(null, signerPub);
check('absent attestation reports absent (not present, not green)', !absent.present && !absent.valid);

const forgedAttObj = encode({
  fmt: 'apple-appattest',
  attStmt: { x5c: [evilDer, APPLE_ATTEST_ROOT_DER] },
  authData: new Uint8Array(37),
});
const forgedPayload = utf8ToBytes(JSON.stringify({
  format: 'exhibit-app-attest/2',
  attestationBase64: bytesToBase64(new Uint8Array(forgedAttObj)),
  challengeBase64: bytesToBase64(new Uint8Array(32)),
  boundFingerprint: 'aa'.repeat(32),
}));
const forged = verifyAppAttestAssertion(forgedPayload, signerPub);
check('attestation with forged leaf does not anchor to Apple root',
  forged.present && !forged.valid && (forged.reason ?? '').toLowerCase().includes('chain'), forged.reason ?? '');

const junkAttPayload = utf8ToBytes(JSON.stringify({
  format: 'exhibit-app-attest/2',
  attestationBase64: bytesToBase64(new Uint8Array([0xff, 0x00, 0xff])),
  challengeBase64: bytesToBase64(new Uint8Array(32)),
  boundFingerprint: 'aa'.repeat(32),
}));
const junkAtt = verifyAppAttestAssertion(junkAttPayload, signerPub);
check('junk attestation object fails cleanly', junkAtt.present && !junkAtt.valid && junkAtt.reason !== null, junkAtt.reason ?? '');

const wrongFmt = verifyAppAttestAssertion(utf8ToBytes('{"format":"verify-app-attest/1"}'), signerPub);
check('old attestation format is not grandfathered into green', wrongFmt.present && !wrongFmt.valid);

// Only 'exhibit-app-attest/2' passes the format gate.
const legacyTagPayload = utf8ToBytes(JSON.stringify({
  format: 'verify-app-attest/2',
  attestationBase64: bytesToBase64(new Uint8Array([0xff, 0x00, 0xff])),
  challengeBase64: bytesToBase64(new Uint8Array(32)),
  boundFingerprint: 'aa'.repeat(32),
}));
const legacyTag = verifyAppAttestAssertion(legacyTagPayload, signerPub);
check('pre-rename attestation tag is rejected at the format gate',
  legacyTag.present && !legacyTag.valid && (legacyTag.reason ?? '').includes('unrecognized format'), legacyTag.reason ?? '');

// Apple issues App Attest credential certificates with windows measured in
// days, so validating at the media's TSA-anchored signing time false-fails
// files captured more than a few days after enrollment. Chain validity is
// evaluated at attestation-mint time (non-empty intersection of the chain's
// windows), so a genuine chain anchoring to the pinned Apple root must pass
// the chain stage regardless of "now" and fail later, here on junk authData.
const rootOnlyPayload = utf8ToBytes(JSON.stringify({
  format: 'exhibit-app-attest/2',
  attestationBase64: bytesToBase64(new Uint8Array(encode({
    fmt: 'apple-appattest',
    attStmt: { x5c: [APPLE_ATTEST_ROOT_DER, APPLE_ATTEST_ROOT_DER] },
    authData: new Uint8Array(37),
  }))),
  challengeBase64: bytesToBase64(new Uint8Array(32)),
  boundFingerprint: 'aa'.repeat(32),
}));
const rootOnly = verifyAppAttestAssertion(rootOnlyPayload, signerPub);
check('genuine-cert chain is never failed on signing-time validity (mint-time semantics)',
  rootOnly.present && !rootOnly.valid &&
  !(rootOnly.reason ?? '').includes('not valid at signing time') &&
  !(rootOnly.reason ?? '').includes('certificate chain broken') &&
  rootOnly.mintWindow !== null,
  rootOnly.reason ?? '');

console.log('\n— parser hardening: parser DoS, NaN dates, strict base64 —');

// 32-bit signed-shift length overflow: a 4-byte length of 0xFFFFFFFA wraps to
// -6, the overrun guard passes, and `next` points backwards, hanging every
// while-walker. These buffers must throw.
const stallTlv = new Uint8Array([0x30, 0x84, 0xff, 0xff, 0xff, 0xfa, 0x05, 0x00]);
let stallThrew = false;
try { readTlv(stallTlv, 0); } catch { stallThrew = true; }
check('stall TLV (0xFFFFFFFA length) throws instead of hanging', stallThrew);

let walkThrew = false;
try { tlvChildren(stallTlv); } catch { walkThrew = true; }
check('walker over a stall TLV terminates (throws), never wedges', walkThrew);

// Fuzz: thousands of random mutations of real DER must terminate, parsing or
// rejecting. A non-advancing walker wedges the suite here.
{
  const corpus = [leafDer, caDer, tokenDer, evilDer, APPLE_ATTEST_ROOT_DER];
  let rng = 0x12345678;
  const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 4000; i++) {
    const mut = new Uint8Array(corpus[i % corpus.length]);
    const edits = 1 + Math.floor(rnd() * 8);
    for (let j = 0; j < edits; j++) mut[Math.floor(rnd() * mut.length)] = Math.floor(rnd() * 256);
    try { parseCertificate(mut); } catch { /* rejection is a pass */ }
    try { verifyTimestampToken(mut, message); } catch { /* rejection is a pass */ }
    try { tlvChildren(mut.subarray(0, 64)); } catch { /* rejection is a pass */ }
  }
  check('4000 mutated DER buffers always terminate (parse or reject)', true);
}

// The same fuzz treatment for the container and CBOR entry points: parseJumb
// (via parseManifest/parseManifestChain), extractC2paStore, parseRootBoxes,
// extractC2paStoreBmff, extractCaBx, and raw cbor-x decode. Seeds are genuine
// signed structures so mutations explore real parse paths.
{
  const fzPriv = p256.utils.randomPrivateKey();
  const fzSign = async (d: Uint8Array) => p256.sign(d, fzPriv, { lowS: true }).toDERRawBytes();
  const fzCert = await buildSelfSignedCert(p256.getPublicKey(fzPriv, false), fzSign, new Date(Date.now() - 60_000));
  const fzSegment = await buildC2paSegment({
    appName: 'ExhibitA/fuzz', mime: 'image/jpeg', title: 'fuzz.jpg',
    instanceId: 'xmp:iid:' + 'cf'.repeat(16), telemetry: {},
    signDigest: fzSign, certChain: [fzCert], cleanFileSha256: sha256(message),
  }, 2);
  const jpegSeed = concatBytes(new Uint8Array([0xff, 0xd8]), fzSegment, new Uint8Array([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]));
  const storeSeed = extractC2paStore(jpegSeed)!.payload;
  const pngSeed = concatBytes(
    PNG_SIGNATURE,
    caBxChunk(storeSeed),
    new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
  );
  const ftyp = concatBytes(
    new Uint8Array([0, 0, 0, 0x18]), utf8ToBytes('ftyp'), utf8ToBytes('isom'),
    new Uint8Array([0, 0, 0, 0]), utf8ToBytes('isom'), utf8ToBytes('iso2'),
  );
  const bmffSeed = concatBytes(ftyp, buildC2paUuidBox(storeSeed), new Uint8Array([0, 0, 0, 0x10]), utf8ToBytes('mdat'), new Uint8Array(8));

  // Sanity: every seed exercises its intended happy path before mutation.
  check('fuzz seeds are genuine (store extractable from JPEG, PNG, and BMFF)',
    extractC2paStore(jpegSeed) !== null && extractCaBx(pngSeed) !== null && extractC2paStoreBmff(bmffSeed) !== null);

  const seeds = [jpegSeed, storeSeed, pngSeed, bmffSeed];
  let rng = 0x5eed1234;
  const rnd = () => (rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 4000; i++) {
    const mut = new Uint8Array(seeds[i % seeds.length]);
    const edits = 1 + Math.floor(rnd() * 8);
    for (let j = 0; j < edits; j++) mut[Math.floor(rnd() * mut.length)] = Math.floor(rnd() * 256);
    try { extractC2paStore(mut); } catch { /* rejection is a pass */ }
    try { const s = extractC2paStore(mut); if (s) parseManifest(s.payload); } catch { /* rejection is a pass */ }
    try { parseManifest(mut); parseManifestChain(mut); } catch { /* hostile store bytes, directly */ }
    try { extractCaBx(mut); } catch { /* rejection is a pass */ }
    try { parseRootBoxes(mut); } catch { /* rejection is a pass */ }
    try { extractC2paStoreBmff(mut); } catch { /* rejection is a pass */ }
    try { decode(mut); } catch { /* rejection is a pass */ }
  }
  check('4000 mutated container/CBOR buffers always terminate (parse or reject)', true);
}

// Garbage validity dates parse to NaN and every NaN comparison is false, so
// the validity window would pass. Corrupt both time fields in the real leaf
// (UTCTime 0x17 len-13, GeneralizedTime 0x18 len-15): the cert must be
// refused as malformed.
{
  const nanCert = new Uint8Array(leafDer);
  let patched = 0;
  for (let i = 0; i + 17 < nanCert.length; i++) {
    if (nanCert[i] === 0x17 && nanCert[i + 1] === 0x0d) {
      for (let j = 0; j < 13; j++) nanCert[i + 2 + j] = 0x2a;
      patched++;
    } else if (nanCert[i] === 0x18 && nanCert[i + 1] === 0x0f) {
      for (let j = 0; j < 15; j++) nanCert[i + 2 + j] = 0x2a;
      patched++;
    }
  }
  let nanMsg: string | null = null;
  try { parseCertificate(nanCert); } catch (e) { nanMsg = (e as Error).message; }
  check('unparseable validity dates are rejected (NaN window bypass closed)',
    patched > 0 && nanMsg !== null && nanMsg.includes('validity'), nanMsg ?? 'parsed(!)');
}

// Invalid base64 must not decode silently as 'A' bytes.
{
  let b64Threw = false;
  try { base64ToBytes('Zm9v!!!!'); } catch { b64Threw = true; }
  check('invalid base64 throws instead of decoding to garbage', b64Threw);
  check('valid base64 still round-trips',
    bytesToBase64(base64ToBytes('AAECAwQFBgc=')) === 'AAECAwQFBgc=');
}

console.log('\n— Multi-manifest stores (the "two verifiers, two verdicts" probe) —');

const readU32be = (b: Uint8Array, o: number) =>
  ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
const storeOf = (segment: Uint8Array): Uint8Array => {
  for (let i = 4; i + 8 < segment.length; i++) {
    if (segment[i] === 0x6a && segment[i + 1] === 0x75 && segment[i + 2] === 0x6d && segment[i + 3] === 0x62) {
      const len = readU32be(segment, i - 4);
      return segment.subarray(i - 4, i - 4 + len);
    }
  }
  throw new Error('no store box in segment');
};
const spliceStore = (segA: Uint8Array, segB: Uint8Array): Uint8Array => {
  const storeA = storeOf(segA);
  const storeB = storeOf(segB);
  const offA = 8 + readU32be(storeA, 8); // store header + its jumd box
  const offB = 8 + readU32be(storeB, 8);
  const childA = storeA.subarray(offA);
  const childB = storeB.subarray(offB);
  const total = offA + childA.length + childB.length;
  const head = new Uint8Array(storeA.subarray(0, offA));
  head.set([total >>> 24, (total >>> 16) & 0xff, (total >>> 8) & 0xff, total & 0xff], 0);
  return concatBytes(head, childA, childB);
};

// C2PA rule: the active manifest is the last in the store. Build two real
// manifests, splice both children into one store; the verifier must read the
// last.
{
  const priv = p256.utils.randomPrivateKey();
  const signDigest = async (d: Uint8Array) => p256.sign(d, priv, { lowS: true }).toDERRawBytes();
  const params = (appName: string) => ({
    appName,
    mime: 'image/jpeg',
    title: 'multi-manifest test',
    instanceId: 'xmp:iid:' + 'ab'.repeat(16),
    telemetry: {},
    signDigest,
    certChain: [leafDer],
    cleanFileSha256: sha256(message),
  });
  const segA = await buildC2paSegment(params('ExhibitA/test-A'), 0);
  const segB = await buildC2paSegment(params('ExhibitA/test-B'), 0);
  const doubleStore = spliceStore(segA, segB);

  const m = parseManifest(doubleStore);
  check('two-manifest store verifies the ACTIVE (last) manifest, per spec',
    m !== null && m.manifestCount === 2 && m.claim['claim_generator'] === 'ExhibitA/test-B',
    m ? `generator=${String(m.claim['claim_generator'])} count=${m.manifestCount}` : 'null manifest');
}

console.log('\n— update-chain evaluation + multi-exclusion hash.data —');

// Every manifest in an update chain is parsed and verified individually, and
// earlier manifests are reported. The in-test self-signed cert makes the
// signatures verifiable; a random key against leaf.crt.der would only exercise
// the reject path.
{
  const privC = p256.utils.randomPrivateKey();
  const pubC = p256.getPublicKey(privC, false);
  const signC = async (d: Uint8Array) => p256.sign(d, privC, { lowS: true }).toDERRawBytes();
  const certC = await buildSelfSignedCert(pubC, signC, new Date(Date.now() - 60_000));
  const paramsC = (appName: string, idByte: string) => ({
    appName,
    mime: 'image/jpeg',
    title: 'chain test',
    instanceId: 'xmp:iid:' + idByte.repeat(16),
    telemetry: {},
    signDigest: signC,
    certChain: [certC],
    cleanFileSha256: sha256(message),
  });
  const segA = await buildC2paSegment(paramsC('ExhibitA/chain-A', 'cd'), 0);
  const segB = await buildC2paSegment(paramsC('ExhibitA/chain-B', 'ce'), 0);
  const doubleStore = spliceStore(segA, segB);

  const chain = parseManifestChain(doubleStore);
  check('chain parse returns EVERY manifest in store order',
    chain !== null && chain.manifests.length === 2 &&
    chain.manifests[0]?.claim['claim_generator'] === 'ExhibitA/chain-A' &&
    chain.manifests[1]?.claim['claim_generator'] === 'ExhibitA/chain-B');

  // Each manifest's exclusion covers its own segment at offset 0, so the
  // file it binds is segment ++ message.
  const fileA = concatBytes(segA, message);
  const fileB = concatBytes(segB, message);
  const vA = chain?.manifests[0] ? verifyManifest(fileA, chain.manifests[0]) : null;
  const vB = chain?.manifests[1] ? verifyManifest(fileB, chain.manifests[1]) : null;
  check('both chain manifests verify (signature + asset hash) against their bound files',
    !!vA && vA.signatureValid && vA.assetHashMatches && !!vB && vB.signatureValid && vB.assetHashMatches,
    `A=${JSON.stringify(vA)} B=${JSON.stringify(vB)}`);

  // Update-chain semantics: media edited after manifest A no longer matches
  // A's asset hash, and the report states that.
  const edited = new Uint8Array(message); edited[0] ^= 0xff;
  const vAedited = chain?.manifests[0] ? verifyManifest(concatBytes(segA, edited), chain.manifests[0]) : null;
  check('earlier manifest honestly reports an asset edited after it',
    !!vAedited && vAedited.signatureValid && !vAedited.assetHashMatches);
}

// Multi-exclusion c2pa.hash.data: foreign signers (Leica, Adobe) emit several
// exclusion ranges, and verifying only the first false-reds genuine media.
// Crafted manifests exercise the range math directly; signatures fail here, as
// only the hash path is under test.
{
  const file = new Uint8Array(1000);
  for (let i = 0; i < file.length; i++) file[i] = (i * 7) & 0xff;
  // The claim must reference the binding assertion; an unreferenced binding
  // proves nothing (attach attack).
  const fakeManifest = (exclusions: { start: number; length: number }[], hash: Uint8Array) => ({
    claim: { assertions: [{ url: 'self#jumbf=c2pa.assertions/c2pa.hash.data' }] },
    claimBytes: new Uint8Array(0),
    protectedHeader: encode({ 1: -7 }),
    signature: new Uint8Array(64),
    certDer: leafDer,
    certChain: [leafDer],
    certChainLength: 1,
    hashData: { exclusions, alg: 'sha256', hash },
    hashBmff: null,
    telemetry: null,
    manifestLabel: 'test:multi-exclusion',
    assertionHashes: {},
    timestampTokens: [],
    appAttestAssertion: null,
    transcript: null,
    exif: null,
    manifestCount: 1,
  });
  const ranges = [
    { start: 100, length: 50 },
    { start: 600, length: 100 },
  ];
  const expected = sha256(concatBytes(file.subarray(0, 100), file.subarray(150, 600), file.subarray(700)));

  check('two exclusions verify (Leica/Adobe-style manifest)',
    verifyManifest(file, fakeManifest(ranges, expected) as never).assetHashMatches);
  check('unsorted exclusions still verify (ranges are sorted internally)',
    verifyManifest(file, fakeManifest([ranges[1], ranges[0]], expected) as never).assetHashMatches);

  const tamperedOutside = new Uint8Array(file); tamperedOutside[400] ^= 0xff;
  check('tamper OUTSIDE the exclusions fails the asset hash',
    !verifyManifest(tamperedOutside, fakeManifest(ranges, expected) as never).assetHashMatches);

  const tamperedInside = new Uint8Array(file); tamperedInside[120] ^= 0xff;
  check('bytes inside an exclusion range are NOT bound (C2PA semantics, pinned)',
    verifyManifest(tamperedInside, fakeManifest(ranges, expected) as never).assetHashMatches);

  check('overlapping ranges fail closed',
    !verifyManifest(file, fakeManifest([{ start: 100, length: 600 }, ranges[1]], expected) as never).assetHashMatches);
  check('out-of-bounds range fails closed',
    !verifyManifest(file, fakeManifest([{ start: 900, length: 500 }], expected) as never).assetHashMatches);

  check('a zero-length-only exclusion hashes the whole file',
    verifyManifest(file, fakeManifest([{ start: 0, length: 0 }], sha256(file)) as never).assetHashMatches);
  check('zero-length entries mixed with real ranges are ignored',
    verifyManifest(file, fakeManifest([{ start: 0, length: 0 }, ...ranges], expected) as never).assetHashMatches);
}


// ---------------------------------------------------------------------------
// Signed newsroom roster (portable trust). The editor signature is
// load-bearing and membership is evaluated at the verified signing time, which
// is what the departed-photographer case depends on.
// ---------------------------------------------------------------------------
{
  const { roster, editorPrivateKeyHex } = await createRoster({
    newsroom: 'The Examples Gazette',
    editorName: 'Ed Itor',
    entries: [
      { fingerprint: 'a'.repeat(64), name: 'Mo Raph', role: 'staff photographer', validFrom: '2026-01-01T00:00:00Z', validTo: null, revokedAt: null },
      { fingerprint: 'b'.repeat(64), name: 'De Parted', role: 'stringer', validFrom: '2026-01-01T00:00:00Z', validTo: null, revokedAt: '2026-06-01T00:00:00Z' },
      { fingerprint: 'c'.repeat(64), name: 'Ex Pired', role: 'stringer', validFrom: '2026-01-01T00:00:00Z', validTo: '2026-03-01T00:00:00Z', revokedAt: null },
      { fingerprint: 'd'.repeat(64), name: 'Fu Ture', role: 'intern', validFrom: '2027-01-01T00:00:00Z', validTo: null, revokedAt: null },
    ],
  });
  const sig = verifyRosterSignature(roster);
  check('roster: editor signature verifies + fingerprint binds', sig.valid && sig.fingerprintMatches);

  const tampered = { ...roster, entries: roster.entries.map((e, i) => i === 0 ? { ...e, name: 'Im Poster' } : e) };
  check('roster: a renamed member breaks the editor signature', !verifyRosterSignature(tampered as Roster).valid);

  const AT_ACTIVE = Date.parse('2026-04-01T00:00:00Z');
  const hit = resolveInRoster(roster, 'a'.repeat(64), AT_ACTIVE);
  check('roster: listed member resolves active at a valid time', hit?.state === 'active' && hit.entry.name === 'Mo Raph');
  check('roster: unlisted key stays unknown', resolveInRoster(roster, 'e'.repeat(64), AT_ACTIVE) === null);

  const preRevocation = Date.parse('2026-05-01T00:00:00Z');
  const postRevocation = Date.parse('2026-07-01T00:00:00Z');
  check('roster: capture before a later revocation stays genuine (departed-photographer case)',
    resolveInRoster(roster, 'b'.repeat(64), preRevocation)?.state === 'active-then-revoked');
  check('roster: capture AFTER revocation is a red flag',
    resolveInRoster(roster, 'b'.repeat(64), postRevocation)?.state === 'revoked');
  check('roster: capture after membership expiry reads expired',
    resolveInRoster(roster, 'c'.repeat(64), AT_ACTIVE)?.state === 'expired');
  check('roster: capture before validity begins reads not-yet-valid',
    resolveInRoster(roster, 'd'.repeat(64), AT_ACTIVE)?.state === 'not-yet-valid');
  check('roster: no verified time → honestly unevaluable',
    resolveInRoster(roster, 'a'.repeat(64), null)?.state === 'unknown-time');

  // Rotation: old fingerprint revoked, new one valid from now.
  const rotated = rotateEntry(roster.entries, 'a'.repeat(64), {
    fingerprint: 'f'.repeat(64), name: 'Mo Raph', role: 'staff photographer', validFrom: '', validTo: null, revokedAt: null,
  });
  const rotatedRoster = await resignRoster(roster, editorPrivateKeyHex, rotated);
  check('roster: rotation re-signs and old key reads revoked after rotation',
    verifyRosterSignature(rotatedRoster).valid &&
    resolveInRoster(rotatedRoster, 'a'.repeat(64), Date.now() + 60_000)?.state === 'revoked' &&
    resolveInRoster(rotatedRoster, 'f'.repeat(64), Date.now() + 60_000)?.state === 'active');

  let wrongKeyThrew = false;
  try { await resignRoster(roster, '00'.repeat(32), roster.entries); } catch { wrongKeyThrew = true; }
  check('roster: re-signing with the wrong editor key is refused', wrongKeyThrew);

  // Revocation, end to end: revoke marks the entry as of now, the re-signed
  // roster verifies, past captures stay genuine, and anything signed after the
  // revocation reads as a red flag.
  const revokedEntries = revokeEntry(roster.entries, 'a'.repeat(64));
  check('roster: revocation marks only the named member',
    revokedEntries.find((e) => e.fingerprint === 'a'.repeat(64))?.revokedAt !== null &&
    revokedEntries.filter((e) => e.revokedAt !== null).length === 2); // 'a' now + 'b' from the fixture
  const revokedRoster = await resignRoster(roster, editorPrivateKeyHex, revokedEntries);
  check('roster: revoked roster re-signs and verifies', verifyRosterSignature(revokedRoster).valid);
  const revokeAt = Date.parse(revokedEntries[0].revokedAt!);
  check('roster: a capture signed BEFORE the revocation stays genuine',
    resolveInRoster(revokedRoster, 'a'.repeat(64), revokeAt - 60_000)?.state === 'active-then-revoked');
  check('roster: a capture signed AFTER the revocation reads revoked',
    resolveInRoster(revokedRoster, 'a'.repeat(64), revokeAt + 60_000)?.state === 'revoked');
  check('roster: other members are untouched by the revocation',
    resolveInRoster(revokedRoster, 'd'.repeat(64), revokeAt + 60_000)?.state === 'not-yet-valid');
}


// ---------------------------------------------------------------------------
// OpenTimestamps receipts (ledger time, separate from authority time).
// ---------------------------------------------------------------------------
{
  const digest = sha256(utf8ToBytes('the signature bytes being anchored'));

  // Pending receipt: parse + verify state, wrong digest refused.
  const pending = buildPendingReceipt(digest, 'https://alice.btc.calendar.opentimestamps.org');
  const parsedPending = parseOtsReceipt(pending);
  check('ots: pending receipt parses with calendar attestation',
    !!parsedPending && parsedPending.digestHex === bytesToHex(digest) &&
    parsedPending.attestations[0]?.kind === 'pending' &&
    parsedPending.attestations[0]?.uri === 'https://alice.btc.calendar.opentimestamps.org');
  const vPending = verifyOtsReceipt(pending, digest);
  check('ots: pending receipt verifies as pending (not yet confirmed)',
    vPending.receiptValid && vPending.state === 'pending' && vPending.blockHeight === null);
  check('ots: receipt for a different digest is refused',
    !verifyOtsReceipt(pending, sha256(utf8ToBytes('some other signature'))).receiptValid);

  // Confirmed receipt, hand-built in the real wire format: header is
  // MAGIC || version(0x01) || hash-op tag(0x08) || raw 32-byte digest; ops are
  // 0xf0 append / 0xf1 prepend; an attestation is 0x00 || tag(8 raw bytes) ||
  // varbytes(payload). Chain: digest → append 0xAA×4 → sha256 → root.
  const vu = (v: number | bigint) => { const o = []; let x = BigInt(v); do { let b = Number(x & 0x7fn); x >>= 7n; if (x > 0n) b |= 0x80; o.push(b); } while (x > 0n); return new Uint8Array(o); };
  const vb = (b: Uint8Array) => concatBytes(vu(b.length), b);
  const arg = new Uint8Array([0xaa, 0xaa, 0xaa, 0xaa]);
  const root = sha256(concatBytes(digest, arg)); // append then sha256
  const ATTEST_BITCOIN_TAG = new Uint8Array([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);
  const attestPayload = vu(800000n); // bitcoin payload: varuint block height
  const confirmed = concatBytes(
    OTS_MAGIC, new Uint8Array([1, 0x08]), digest,
    new Uint8Array([0xf0]), vb(arg),   // append
    new Uint8Array([0x08]),            // sha256
    new Uint8Array([0x00]), ATTEST_BITCOIN_TAG, vb(attestPayload), // bitcoin attestation
  );
  const parsedConfirmed = parseOtsReceipt(confirmed);
  check('ots: confirmed receipt walks op chain to the Merkle root',
    !!parsedConfirmed && parsedConfirmed.finalMsgHex === bytesToHex(root) &&
    parsedConfirmed.attestations[0]?.kind === 'bitcoin' &&
    parsedConfirmed.attestations[0]?.blockHeight === 800000);

  // Block-header binding: header carries the root at bytes 36..68.
  const header = new Uint8Array(80);
  header.set(root, 36);
  const vBound = verifyOtsReceipt(confirmed, digest, header);
  check('ots: binding to the block header verifies (root at 36..68)',
    vBound.receiptValid && vBound.state === 'confirmed' && vBound.blockHeight === 800000 &&
    vBound.blockBindingChecked && vBound.blockBindingValid === true);
  const wrongHeader = new Uint8Array(80); // zero root
  const vWrong = verifyOtsReceipt(confirmed, digest, wrongHeader);
  check('ots: wrong block header breaks the binding — honestly unverifiable',
    vWrong.blockBindingChecked && vWrong.blockBindingValid === false && vWrong.state === 'unverifiable');
  const vNoHeader = verifyOtsReceipt(confirmed, digest, null);
  check('ots: without network the binding is stated as unchecked, not assumed',
    vNoHeader.receiptValid && vNoHeader.state === 'confirmed' && !vNoHeader.blockBindingChecked && vNoHeader.blockBindingValid === null);

  // Hostile inputs.
  const tamperedDigest = confirmed.slice(); tamperedDigest[OTS_MAGIC.length + 2] ^= 0xff;
  check('ots: a receipt pointing at different bytes is rejected',
    !verifyOtsReceipt(tamperedDigest, digest).receiptValid);
  // Flip one byte of the 8-byte attestation tag: unknown attestation, refused
  // rather than read as a plausible height.
  const tamperedAtt = confirmed.slice(); tamperedAtt[tamperedAtt.length - 13] ^= 0xff;
  check('ots: a tampered attestation is refused, never misread',
    !verifyOtsReceipt(tamperedAtt, digest).receiptValid);
  check('ots: garbage bytes are not a receipt', parseOtsReceipt(new Uint8Array([1, 2, 3, 4])) === null);
  const unsupportedOp = concatBytes(OTS_MAGIC, new Uint8Array([1, 0x08]), digest, new Uint8Array([0x02]));
  check('ots: unsupported ops are refused, not guessed', parseOtsReceipt(unsupportedOp) === null);
}


// ---------------------------------------------------------------------------
// Detachable proof: hash-only (source protection), proof bundle, desk index
// export. Covers disclosure discipline as well as structure.
// ---------------------------------------------------------------------------
{
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  const rec = buildRecord({
    assetSha256: 'ab'.repeat(32), assetBytes: 1234, mime: 'image/jpeg', kind: 'photo',
    capturedAt: '2026-08-01T12:00:00Z', appVersion: '0.9.2-test', deviceModel: 'TestPhone', platform: 'ios',
    identity: { author: 'Jane Source', organization: null },
    context: { location: { lat: 40.7, lon: -74.0, accuracyM: 5 }, headingDeg: null, pressureHPa: null, altitudeM: null, motion: null },
    publicKeyBase64: bytesToBase64(pub), fingerprint: bytesToHex(sha256(pub)),
  });
  const signed = await signRecord(rec, async (d) => p256.sign(d, priv, { lowS: true }).toDERRawBytes());

  const claim = buildHashClaim(signed);
  const claimJson = JSON.stringify(claim);
  check('proof: hash claim round-trips its format gate', isHashClaim(JSON.parse(claimJson)));
  check('proof: hash claim binds media + payload digests',
    claim.mediaSha256 === signed.asset.sha256 && claim.payloadDigestHex === bytesToHex(payloadDigest(signed)));
  check('proof: hash claim discloses NOTHING else — no byline, no location, no signature',
    !claimJson.includes('Jane') && !claimJson.includes('signature') && !claimJson.includes('40.7') && !claimJson.includes('location'));

  const bundle = buildProofBundle(signed, null);
  check('proof: bundle round-trips with the record intact',
    isProofBundle(JSON.parse(JSON.stringify(bundle))) && bundle.payloadDigestHex === bytesToHex(payloadDigest(signed)));
  check('proof: bundled record signature still verifies after the round trip',
    verifyRecordSignature(JSON.parse(JSON.stringify(bundle)).record).signatureValid);

  // Desk export: injection guards and location handling.
  const entries: ExportEntry[] = [
    { id: 'a', createdAt: '2026-08-01T12:00:00Z', kind: 'photo', sha256: 'ab'.repeat(32), bytes: 1,
      fingerprint: 'cd'.repeat(32), motionVerdict: 'handheld', lat: 40.7, lon: -74.0,
      locationState: 'present', otsState: 'confirmed', otsBlockHeight: 800000,
      assignment: '=HYPERLINK("https://evil.example","x")' },
    { id: 'b', createdAt: '2026-08-01T13:00:00Z', kind: 'photo', sha256: 'ef'.repeat(32), bytes: 2,
      fingerprint: 'cd'.repeat(32), motionVerdict: null, lat: null, lon: null,
      locationState: 'redacted', otsState: 'pending', otsBlockHeight: null, assignment: null },
  ];
  const csv = exportEntriesToCsv(entries);
  check('proof: CSV neutralizes spreadsheet formula injection',
    csv.includes("'=HYPERLINK") && !csv.includes(',=HYPERLINK'));
  check('proof: CSV keeps redacted location empty — no fabricated coordinates',
    csv.split('\n')[2].split(',').slice(7, 9).every((c) => c === ''));
  const geo = JSON.parse(exportEntriesToGeoJson(entries));
  check('proof: GeoJSON carries only located items, [lon, lat] order',
    geo.features.length === 1 && geo.features[0].geometry.coordinates[0] === -74.0 && geo.features[0].geometry.coordinates[1] === 40.7);
  const kml = exportEntriesToKml([{ ...entries[0], assignment: 'R&D <unit> "A"' }]);
  check('proof: KML escapes XML-hostile labels', kml.includes('R&amp;D') && kml.includes('&lt;unit&gt;'));
}


// ---------------------------------------------------------------------------
// Capture integrity: sensor-frame timing as a bounded signal.
// ---------------------------------------------------------------------------
{
  const regular = Array.from({ length: 32 }, (_, i) => ({ x: 0, y: 0, z: 0, t: i * 10 }));
  const t1 = analyzeTiming(regular);
  check('integrity: a regular feed reports near-zero timing variation',
    !!t1 && t1.samples === 32 && t1.intervalCv < 0.01);
  let tt = 0;
  const bursty = Array.from({ length: 33 }, (_, i) => { const s = { x: 0, y: 0, z: 0, t: tt }; tt += i % 2 === 0 ? 5 : 95; return s; });
  const t2 = analyzeTiming(bursty);
  check('integrity: a bursty feed reports high timing variation', !!t2 && t2.intervalCv > 0.5);
  check('integrity: too few samples honestly reports no signal', analyzeTiming(regular.slice(0, 4)) === null);
}

// ---------------------------------------------------------------------------
// The signed pose trace (gyro evidence replacing the parallax clip).
// ---------------------------------------------------------------------------
{
  // 4 s of synthetic 100 Hz DeviceMotion; shutter at t=3500.
  const mk = (): PoseSample[] =>
    Array.from({ length: 401 }, (_, i) => ({
      t: i * 10,
      ax: 0.001 * Math.sin(i / 5), ay: 0.002 * Math.cos(i / 7), az: 0.0015,
      rx: 0.01 * Math.sin(i / 3), ry: 0.02, rz: -0.015,
      roll: 2.5 + 0.1 * Math.sin(i / 9), pitch: -45.2, yaw: 178.9,
    }));

  const trace = buildPoseTrace(mk(), 3500);
  check('pose: a 4 s buffer decimates to the capped 20 Hz window',
    !!trace && trace.hz === 20 && trace.samples <= 70 && trace.samples >= 60, `samples=${trace?.samples}`);
  check('pose: flat arrays are exactly 3× samples, all integers',
    !!trace &&
      trace.rotRate.length === 3 * trace.samples &&
      trace.attitude.length === 3 * trace.samples &&
      trace.accel.length === 3 * trace.samples &&
      [...trace.rotRate, ...trace.attitude, ...trace.accel].every((v) => Number.isInteger(v)));
  check('pose: quantization is millirad / decidegree / milli-g as signed',
    !!trace &&
      Math.abs(trace.rotRate[1] - 20) <= 2 &&      // ry = 0.02 rad/s → 20 mrad/s
      trace.attitude[2] === 1789 &&                // yaw = 178.9° → 1789 decidegrees
      Math.abs(trace.accel[2] - 2) <= 1);          // az = 0.0015 g → ~2 milli-g
  check('pose: the anchor is the sample nearest the shutter',
    !!trace && trace.anchor >= trace.samples - 12 && trace.anchor <= trace.samples - 1,
    `anchor=${trace?.anchor}/${trace?.samples}`);

  const clamped = buildPoseTrace(mk().map((s) => ({ ...s, rx: 100 })), 3500);
  check('pose: extreme gyro values clamp to int16, never wrap',
    !!clamped && clamped.rotRate.every((_, i) => i % 3 !== 0 || clamped.rotRate[i] === 32767));

  check('pose: too little data honestly returns null',
    buildPoseTrace(mk().slice(0, 5), 3500) === null && buildPoseTrace([], 3500) === null);
  check('pose: samples outside the shutter window are excluded',
    (() => {
      const t2 = buildPoseTrace(mk(), 500); // shutter at 0.5 s — only ±window counts
      return !!t2 && t2.samples > 0 && t2.anchor <= 10;
    })());
  check('pose: deterministic — same buffer, same trace',
    JSON.stringify(buildPoseTrace(mk(), 3500)) === JSON.stringify(buildPoseTrace(mk(), 3500)));
  check('pose: video profile — long clip, adaptive rate, ≤ cap',
    (() => {
      const long = Array.from({ length: 6001 }, (_, i) => ({
        t: i * 10, ax: 0, ay: 0, az: 0, rx: 0.01, ry: 0, rz: 0, roll: 0, pitch: 0, yaw: 0,
      }));
      const v = buildPoseTrace(long, 1000, { beforeMs: 1000, afterMs: 59_500, hz: 4, maxSamples: 240 });
      return !!v && v.samples <= 240 && v.samples >= 200 && v.hz === 4;
    })());
  check('pose: survives the signed-JSON round trip intact',
    (() => {
      const t3 = buildPoseTrace(mk(), 3500)!;
      return JSON.stringify(JSON.parse(JSON.stringify(t3))) === JSON.stringify(t3);
    })());
}

// ---------------------------------------------------------------------------
// EXIF sanitization for the signed camera-reported assertion.
// ---------------------------------------------------------------------------
{
  const raw = {
    ISO: 400, FNumber: 1.78, FocalLength: 6.86, ExposureTime: 0.008,
    LensModel: 'iPhone 15 Pro back triple camera 6.86mm f/1.78',
    Orientation: 1, PixelXDimension: 4032, PixelYDimension: 3024,
    DateTimeOriginal: '2026:08:03 14:22:10',
    // --- everything below must not be signed ---
    GPSLatitude: 37.7749, GPSLongitude: -122.4194, GPSAltitude: 15,
    MakerNote: { secret: 'stuff' },
    UserComment: 'safehouse visit with source',
    ImageDescription: 'meet at the usual place',
    SerialNumber: 'FVFX123ABC',
    Software: 'anything',
    ISOInfinite: Infinity,
    ISONaN: NaN,
  };
  const clean = sanitizeExif(raw);
  check('exif: allowlisted exposure/optics fields survive',
    clean.ISO === 400 && clean.FNumber === 1.78 && clean.FocalLength === 6.86 &&
    clean.LensModel === 'iPhone 15 Pro back triple camera 6.86mm f/1.78' && clean.Orientation === 1);
  check('exif: GPS can never enter a signed assertion',
    !('GPSLatitude' in clean) && !('GPSLongitude' in clean) && !('GPSAltitude' in clean) &&
    Object.keys(clean).every((k) => !k.startsWith('GPS')));
  check('exif: free text and identifiers are dropped',
    !('UserComment' in clean) && !('ImageDescription' in clean) && !('SerialNumber' in clean) &&
    !('MakerNote' in clean) && !('Software' in clean));
  check('exif: non-finite numbers are dropped',
    !('ISOInfinite' in clean) && !('ISONaN' in clean));
  check('exif: overlong or control-byte strings are refused',
    (() => {
      const c2 = sanitizeExif({ LensModel: 'x'.repeat(200), Make: 'ok\nevil', Model: 'Fine' });
      return !('LensModel' in c2) && !('Make' in c2) && c2.Model === 'Fine';
    })());
  check('exif: garbage input yields an empty, signal-free object',
    !hasExifSignal(sanitizeExif(null)) && !hasExifSignal(sanitizeExif('junk')) && !hasExifSignal(sanitizeExif({ Zebra: 1 })));
}

// --- Bitcoin beacon: cached-tip time lower bound ---
{
  resetBeaconForTests();
  const TIP_HASH = 'cd'.repeat(32);
  check('beacon: tip shape validation accepts a real-looking tip',
    isValidTip(TIP_HASH, 840001));
  check('beacon: malformed tips are refused (uppercase, short hash, float/negative height)',
    !isValidTip(TIP_HASH.toUpperCase(), 840001) && !isValidTip('abcd', 840001) &&
    !isValidTip(TIP_HASH, 1.5) && !isValidTip(TIP_HASH, -1) && !isValidTip(TIP_HASH, '840001'));
  check('beacon: refresh delay stays inside base..base+jitter',
    (() => {
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const d = nextRefreshDelayMs(() => r);
        if (d < BEACON_REFRESH_BASE_MS || d >= BEACON_REFRESH_BASE_MS + BEACON_REFRESH_JITTER_MS) return false;
      }
      return true;
    })());
  const okFetch = (async (url: string) => ({
    ok: true,
    text: async () => (url.endsWith('/tip/hash') ? TIP_HASH : '840001'),
  })) as unknown as typeof fetch;
  check('beacon: no cache → currentBeacon is null (absent, never fabricated)',
    currentBeacon() === null);
  const got = await refreshBeacon(okFetch, 1_700_000_000_000);
  check('beacon: refresh caches the tip and reports it (hash, height, honesty note)',
    got?.blockHash === TIP_HASH && got.blockHeight === 840001 && got.note === BEACON_NOTE &&
    got.source === 'mempool.space');
  const regressingFetch = (async (url: string) => ({
    ok: true,
    text: async () => (url.endsWith('/tip/hash') ? 'ef'.repeat(32) : '840000'),
  })) as unknown as typeof fetch;
  const reg = await refreshBeacon(regressingFetch);
  check('beacon: a height regression never moves the lower bound backwards',
    reg === null && currentBeacon()?.blockHeight === 840001 && currentBeacon()?.blockHash === TIP_HASH);
  const garbageFetch = (async () => ({ ok: true, text: async () => 'not-a-tip' })) as unknown as typeof fetch;
  const gar = await refreshBeacon(garbageFetch);
  check('beacon: shape-invalid responses are refused, cache preserved',
    gar === null && currentBeacon()?.blockHash === TIP_HASH);
  const deadFetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  setBeaconEndpoint('https://node.newsroom.example');
  const dead = await refreshBeacon(deadFetch);
  check('beacon: total fetch failure returns null and keeps the last good tip',
    dead === null && currentBeacon()?.blockHeight === 840001);
  check('beacon: pinning overrides the endpoint pool',
    (await (async () => {
      let hit = '';
      const spyFetch = (async (url: string) => { hit = url; return { ok: true, text: async () => (url.endsWith('/tip/hash') ? 'ab'.repeat(32) : '840002') }; }) as unknown as typeof fetch;
      await refreshBeacon(spyFetch);
      return hit.startsWith('https://node.newsroom.example/') && currentBeacon()?.blockHeight === 840002;
    })()));
  resetBeaconForTests();
}

// --- DCT pHash: near-duplicate leads ---
{
  // Image-like synthetic texture (smoothed noise). A pure gradient clusters
  // its coefficients at the median; natural images spread them wide.
  const texture = (seed: number): Uint8Array => {
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const g = new Uint8Array(32 * 32);
    for (let i = 0; i < g.length; i++) g[i] = Math.floor(rnd() * 256);
    const out = new Uint8Array(g);
    for (let y = 1; y < 31; y++) for (let x = 1; x < 31; x++) {
      out[y * 32 + x] = (g[y * 32 + x] + g[y * 32 + x - 1] + g[y * 32 + x + 1] + g[(y - 1) * 32 + x] + g[(y + 1) * 32 + x]) / 5;
    }
    return out;
  };
  const h = texture(42);
  const noisy = texture(42);
  for (let i = 0; i < noisy.length; i += 7) noisy[i] = Math.min(255, noisy[i] + 12); // mild perturbation
  const other = texture(777);
  const hHash = pHashFromGray32(h)!;
  check('phash: 16 lowercase hex chars (8 bytes)',
    /^[0-9a-f]{16}$/.test(hHash));
  check('phash: deterministic — same pixels, same hash',
    pHashFromGray32(h) === hHash);
  check('phash: malformed input returns null, never throws',
    pHashFromGray32(new Uint8Array(100)) === null && pHashFromGray32(null as unknown as Uint8Array) === null);
  const dNear = hammingDistanceHex(hHash, pHashFromGray32(noisy)!)!;
  check('phash: a slightly perturbed image stays close (≤6 bits)',
    dNear <= 6, `distance=${dNear}`);
  const dFar = hammingDistanceHex(hHash, pHashFromGray32(other)!)!;
  check('phash: an unrelated image sits far apart (≥16 bits)',
    dFar >= 16, `distance=${dFar}`);
  check('phash: hamming distance is exact on known pairs and null-safe',
    hammingDistanceHex(hHash, hHash) === 0 &&
    hammingDistanceHex('ffffffffffffffff', '0000000000000000') === 64 &&
    hammingDistanceHex('nothex', hHash) === null);
}

// --- Screen re-photography analyzers ---
{
  const W = 128;
  const H = 128;
  const flat = new Float64Array(W * H).fill(128);

  // Flat-subject guard: no residual energy, no detection.
  check('rephoto: a flat image yields insufficient-signal from every spectral analyzer',
    analyzeBanding(flat, W, H).strength === 'insufficient-signal' &&
    analyzeMoire(flat, W, H).strength === 'insufficient-signal');

  // Synthetic rolling-shutter banding: row sinusoid, amplitude 30, 9 cycles
  // over 128 rows, tiny noise → must fire with the injected frequency.
  const striped = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = 128 + 30 * Math.sin((2 * Math.PI * 9 * y) / H) + (y % 3) * 0.2;
    for (let x = 0; x < W; x++) striped[y * W + x] = v;
  }
  const band = analyzeBanding(striped, W, H);
  check('rephoto: injected row banding is detected at the injected frequency',
    band.strength === 'strong' && Math.abs(band.peakFreq - 9 / 128) < 2 / 128,
    `strength=${band.strength} peakFreq=${band.peakFreq.toFixed(4)} snr=${band.snrDb.toFixed(1)}dB`);

  // A smooth luminance gradient is not banding; it is detrended out.
  const gradient = new Float64Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gradient[y * W + x] = 64 + y;
  check('rephoto: a smooth gradient is not flagged as banding',
    ['insufficient-signal', 'none'].includes(analyzeBanding(gradient, W, H).strength));

  // Synthetic moiré: isolated high-frequency 2D sinusoid.
  const moire = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      moire[y * W + x] = 128 + 25 * Math.sin(2 * Math.PI * (0.31 * x + 0.22 * y)) + ((x * y) % 5) * 0.3;
    }
  }
  const mo = analyzeMoire(moire, W, H);
  check('rephoto: injected moiré peak is found near the injected frequency',
    mo.strength !== 'insufficient-signal' && mo.strength !== 'none' &&
    Math.hypot(mo.peakU - 0.31, mo.peakV - 0.22) < 0.05,
    `strength=${mo.strength} peak=(${mo.peakU.toFixed(3)},${mo.peakV.toFixed(3)}) snr=${mo.snrDb.toFixed(1)}dB`);

  // Black floor: lifted (screen-like) vs reaching near-zero (natural dark).
  const lifted = new Float64Array(W * H);
  for (let i = 0; i < lifted.length; i++) lifted[i] = 100 + (i % 41);
  const dark = new Float64Array(W * H);
  for (let i = 0; i < dark.length; i++) dark[i] = i % 20 === 0 ? (i % 3) : 40 + (i % 37);
  const bfLifted = analyzeBlackFloor(lifted, W, H);
  const bfDark = analyzeBlackFloor(dark, W, H);
  check('rephoto: black floor distinguishes lifted blacks from true blacks',
    bfLifted.trueBlackFraction === 0 && bfLifted.p005 >= 100 &&
    bfDark.trueBlackFraction > 0.03 && bfDark.p005 <= 2,
    `lifted p005=${bfLifted.p005} frac=${bfLifted.trueBlackFraction} | dark p005=${bfDark.p005} frac=${bfDark.trueBlackFraction.toFixed(3)}`);

  // Gamut: railed saturated pixels vs neutral content.
  const sat = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    if (i % 5 === 0) { sat[o] = 255; sat[o + 1] = 0; sat[o + 2] = 0; }
    else { sat[o] = 120; sat[o + 1] = 122; sat[o + 2] = 118; }
    sat[o + 3] = 255;
  }
  const neutral = new Uint8Array(W * H * 4).fill(128);
  const gm = analyzeGamut(sat, W * H);
  check('rephoto: gamut analyzer counts railed pixels, none in neutral content',
    Math.abs(gm.hardSaturatedFraction - 0.2) < 0.001 &&
    analyzeGamut(neutral, W * H).hardSaturatedFraction === 0);

  check('rephoto: analyzers are deterministic',
    analyzeBanding(striped, W, H).snrDb === band.snrDb &&
    analyzeMoire(moire, W, H).snrDb === mo.snrDb);
  check('rephoto: strength bands are ordered and finite-safe',
    snrStrength(Number.NEGATIVE_INFINITY) === 'insufficient-signal' &&
    snrStrength(0) === 'none' && snrStrength(7) === 'weak' &&
    snrStrength(12) === 'moderate' && snrStrength(20) === 'strong');
}

// --- ROC tooling: measured error rates ---
{
  // Deterministic gaussian-ish samples (sum of uniforms) around two means.
  const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const sample = (seed: number, mean: number, spread: number, n: number): number[] => {
    const r = lcg(seed);
    return Array.from({ length: n }, () => mean + spread * ((r() + r() + r() + r() - 2) * 3));
  };
  const separated: LabeledScore[] = [
    ...sample(1, 20, 2, 60).map((score, i) => ({ id: `p${i}`, label: 'positive' as const, score })),
    ...sample(2, 5, 2, 60).map((score, i) => ({ id: `n${i}`, label: 'negative' as const, score })),
  ];
  const identical: LabeledScore[] = [
    ...sample(3, 10, 3, 60).map((score, i) => ({ id: `p${i}`, label: 'positive' as const, score })),
    ...sample(4, 10, 3, 60).map((score, i) => ({ id: `n${i}`, label: 'negative' as const, score })),
  ];
  const sepPoints = rocCurve(separated);
  const sepAuc = auc(sepPoints);
  check('roc: well-separated distributions give near-perfect AUC',
    sepAuc > 0.95, `auc=${sepAuc.toFixed(4)}`);
  const idAuc = auc(rocCurve(identical));
  check('roc: identical distributions give coin-flip AUC (0.35..0.65)',
    idAuc > 0.35 && idAuc < 0.65, `auc=${idAuc.toFixed(4)}`);
  const op = operatingPoint(sepPoints, 0.01);
  check('roc: operating point respects the max-FPR constraint with real recall',
    op !== null && op.falsePositiveRate <= 0.01 && op.truePositiveRate > 0.8,
    `op=${op ? `fpr=${op.falsePositiveRate.toFixed(3)} tpr=${op.truePositiveRate.toFixed(3)}` : 'null'}`);
  check('roc: an unsatisfiable constraint returns null, never a violation',
    operatingPoint(rocCurve(identical), 0.0) === null ||
    (operatingPoint(rocCurve(identical), 0.0)?.falsePositiveRate ?? 1) <= 0.0);
  check('roc: empty/one-sided corpora yield no curve and zero AUC, not NaN',
    rocCurve([]).length === 0 && auc([]) === 0 &&
    rocCurve(identical.filter((s) => s.label === 'positive')).length === 0);
  const report = buildRocReport('banding.snrDb', separated, 'test-manifest');
  check('roc: report carries corpus sizes and provenance manifest',
    report.corpus.positives === 60 && report.corpus.negatives === 60 &&
    report.corpus.manifest === 'test-manifest' && report.auc === sepAuc);
}

// --- Global motion estimation: block matching + similarity fit ---
{
  const FW = 96;
  const FH = 64;
  const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  // Textured base frame; block matching needs real texture.
  const base = new Float64Array(FW * FH);
  const r0 = lcg(11);
  for (let i = 0; i < base.length; i++) base[i] = r0() * 255;
  for (let y = 1; y < FH - 1; y++) for (let x = 1; x < FW - 1; x++) {
    base[y * FW + x] = (base[y * FW + x] * 2 + base[y * FW + x - 1] + base[y * FW + x + 1] + base[(y - 1) * FW + x] + base[(y + 1) * FW + x]) / 6;
  }
  // Content displaced by (dx, dy): b[y][x] = a[y-dy][x-dx], fresh noise at borders.
  const shifted = (dx: number, dy: number, seed: number): Float64Array => {
    const out = new Float64Array(FW * FH);
    const rr = lcg(seed);
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const sx = x - dx;
      const sy = y - dy;
      out[y * FW + x] = sx >= 0 && sx < FW && sy >= 0 && sy < FH ? base[sy * FW + sx] : rr() * 255;
    }
    return out;
  };
  // Content rotated by theta about the frame center (nearest-neighbor).
  const rotated = (theta: number, seed: number): Float64Array => {
    const out = new Float64Array(FW * FH);
    const rr = lcg(seed);
    const cx0 = FW / 2;
    const cy0 = FH / 2;
    for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
      const px = x - cx0;
      const py = y - cy0;
      const sx = Math.round(cx0 + px * Math.cos(theta) + py * Math.sin(theta));
      const sy = Math.round(cy0 - px * Math.sin(theta) + py * Math.cos(theta));
      out[y * FW + x] = sx >= 0 && sx < FW && sy >= 0 && sy < FH ? base[sy * FW + sx] : rr() * 255;
    }
    return out;
  };

  const pan = estimateGlobalMotion(base, shifted(3, -2, 21), FW, FH)!;
  check('flow: injected pan (3,-2) px is recovered within 1px',
    pan !== null && Math.abs(pan.tx - 3) <= 1 && Math.abs(pan.ty + 2) <= 1,
    pan ? `tx=${pan.tx.toFixed(2)} ty=${pan.ty.toFixed(2)}` : 'null');
  const rot = estimateGlobalMotion(base, rotated(0.03, 22), FW, FH)!;
  check('flow: injected roll (0.03 rad) is recovered within 0.01 rad',
    rot !== null && Math.abs(Math.abs(rot.rotRad) - 0.03) <= 0.01,
    rot ? `rot=${rot.rotRad.toFixed(4)}` : 'null');
  const still = estimateGlobalMotion(base, base.slice(), FW, FH)!;
  check('flow: identical frames give ~zero motion, not garbage',
    still !== null && Math.abs(still.tx) <= 1 && Math.abs(still.ty) <= 1 && Math.abs(still.rotRad) <= 0.005,
    still ? `tx=${still.tx.toFixed(2)} ty=${still.ty.toFixed(2)} rot=${still.rotRad.toFixed(4)}` : 'null');
  check('flow: flat frames yield null — no fabricated motion',
    estimateGlobalMotion(new Float64Array(FW * FH).fill(128), new Float64Array(FW * FH).fill(128), FW, FH) === null);

  // --- IMU ↔ flow consistency: synthetic trace vs matching/mismatched flow ---
  const HZ = 20;
  const SAMPLES = 60;
  const CAPT = 1_700_000_000_000;
  // Roll rate oscillates (sinusoid, 0.05..0.15 rad/s) so correlation is defined.
  const rotRate: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const rollRate = 100 + 50 * Math.sin(i / 6); // mrad/s
    rotRate.push(0, Math.round(rollRate), 0); // rx, ry(roll), rz — interleaved
  }
  const trace = { hz: HZ, anchor: 10, samples: SAMPLES, rotRate, attitude: new Array(SAMPLES * 3).fill(0), accel: new Array(SAMPLES * 3).fill(0) };
  // Matching flow: content roll each pair = -gyro roll (fixed handedness) + noise.
  const rf = lcg(31);
  const mkFlow = (consistent: boolean): FlowSample[] =>
    Array.from({ length: 8 }, (_, k) => {
      const t0 = CAPT + (k * 5 - 10) * (1000 / HZ) + 50;
      const dtMs = 250;
      const midIdx = Math.round(((t0 + dtMs / 2 - CAPT) * HZ) / 1000 + 10);
      const gyroRoll = ((100 + 50 * Math.sin(midIdx / 6)) / 1000) * (dtMs / 1000);
      return {
        tMs: t0 + dtMs / 2,
        dtMs,
        motion: {
          tx: 0, ty: 0,
          rotRad: consistent ? -gyroRoll + (rf() - 0.5) * 0.004 : (rf() - 0.5) * 0.1,
          matches: 20, coverage: 0.8, vectors: [],
        },
      };
    });
  const good = analyzeImuFlowConsistency(trace, CAPT, mkFlow(true));
  check('imuflow: a matching trace/flow pair correlates strongly',
    good.strength === 'strong' && Math.abs(good.rollCorrelation ?? 0) > 0.9,
    `r=${good.rollCorrelation?.toFixed(3)} strength=${good.strength}`);
  const bad = analyzeImuFlowConsistency(trace, CAPT, mkFlow(false));
  check('imuflow: a mismatched flow series correlates weakly',
    bad.strength === 'weak' && Math.abs(bad.rollCorrelation ?? 1) < 0.8,
    `r=${bad.rollCorrelation?.toFixed(3)} strength=${bad.strength}`);
  check('imuflow: no pose trace → insufficient-data, stated',
    analyzeImuFlowConsistency(null, CAPT, mkFlow(true)).strength === 'insufficient-data');
  check('imuflow: too few frame pairs → insufficient-data, stated',
    analyzeImuFlowConsistency(trace, CAPT, mkFlow(true).slice(0, 3)).strength === 'insufficient-data');
}

console.log('\n— void-binding guards (the exclusion attack) —');

// The attack: a manifest whose hash.data exclusions exempt the hash input
// itself. The byte-range walk alone would match such a hash; the guards prove
// the input is the media. Void means absence of proof, not 'modified'.
{
  const privV = p256.utils.randomPrivateKey();
  const signV = async (d: Uint8Array) => p256.sign(d, privV, { lowS: true }).toDERRawBytes();
  const certV = await buildSelfSignedCert(p256.getPublicKey(privV, false), signV, new Date(Date.now() - 60_000));
  const cleanJpg = new Uint8Array(fs.readFileSync('/tmp/lab/clean.jpg'));
  const segV = await buildC2paSegment({
    appName: 'ExhibitA/void-test', mime: 'image/jpeg', title: 'void.jpg',
    instanceId: 'xmp:iid:' + 'f0'.repeat(16), telemetry: {},
    signDigest: signV, certChain: [certV], cleanFileSha256: sha256(cleanJpg),
  }, 2);
  const fileV = concatBytes(cleanJpg.subarray(0, 2), segV, cleanJpg.subarray(2));
  const storeV = extractC2paStore(fileV)!;
  const mV = parseManifest(storeV.payload)!;
  const rangeV = { start: storeV.segmentStart, length: storeV.segmentLength };

  const genuine = verifyManifest(fileV, mV, rangeV);
  check('genuine manifest passes the binding guards',
    genuine.assetHashMatches === true && genuine.assetHashFailure === null);

  // Whole-file exclusion: the hash input is sha256(nothing), which matches by
  // construction and binds no media.
  const hostileWhole = {
    ...mV,
    hashData: { exclusions: [{ start: 0, length: fileV.length }], alg: 'sha256', hash: sha256(new Uint8Array(0)) },
  };
  const vWhole = verifyManifest(fileV, hostileWhole, rangeV);
  check('whole-file exclusion is VOID, not a match',
    vWhole.assetHashMatches === false && vWhole.assetHashFailure === 'void-binding');

  // Exclusion omitting the manifest's own range: the walk matches a real hash
  // (file minus a tail slice), but the credentials sit inside the hash input,
  // so the binding is circular and void.
  const tailRange = { start: fileV.length - 32, length: 32 };
  const tailHash = sha256ExcludingRanges(fileV, [tailRange])!;
  const hostileTail = { ...mV, hashData: { exclusions: [tailRange], alg: 'sha256', hash: tailHash } };
  const vTail = verifyManifest(fileV, hostileTail, rangeV);
  check('exclusion omitting the manifest range is VOID even when the walk matches',
    vTail.assetHashMatches === false && vTail.assetHashFailure === 'void-binding');

  // Unknown manifest range (detached/legacy caller): coverage guard skipped
  // by contract, remainder guard still enforced, walk honored.
  const vTailNoRange = verifyManifest(fileV, hostileTail);
  check('unknown manifest range: coverage guard skipped, walk honored',
    vTailNoRange.assetHashMatches === true && vTailNoRange.assetHashFailure === null);

  // A real tamper reads 'mismatch', not 'void-binding'.
  const editedV = new Uint8Array(fileV); editedV[editedV.length - 1] ^= 0xff;
  const vEdit = verifyManifest(editedV, mV, rangeV);
  check('genuine tamper is mismatch (proven tamper), never void',
    vEdit.assetHashMatches === false && vEdit.assetHashFailure === 'mismatch');

  // BMFF shapes of the same attack (guard unit-tests against the real
  // walker): exempt the media box, or exempt every box.
  const mp4 = new Uint8Array(fs.readFileSync('/tmp/lab/clean.mp4'));
  const bmffBase = {
    protectedHeader: new Uint8Array([0xa0]), claimBytes: new Uint8Array(0),
    signature: new Uint8Array(0), certDer: new Uint8Array(0), certChain: [], claim: {},
    hashData: null, telemetry: null, manifestLabel: 'lab', assertionHashes: {},
    timestampTokens: [], pq: null, appAttestAssertion: null, transcript: null,
    exif: null, identity: null, manifestCount: 1, certChainLength: 0, hashBmff: null,
  } as any;
  const mdatExclusions = [{ xpath: '/mdat' }];
  const vMdat = verifyManifest(mp4, {
    ...bmffBase,
    hashBmff: { exclusions: mdatExclusions, alg: 'sha256', hash: hashBmffV2(mp4, mdatExclusions) },
  });
  check('BMFF: excluding mdat is VOID even when the walk matches',
    vMdat.assetHashMatches === false && vMdat.assetHashFailure === 'void-binding');

  const everyType = [...new Set(parseRootBoxes(mp4).map((b) => b.type))].map((t) => ({ xpath: '/' + t }));
  const vAll = verifyManifest(mp4, {
    ...bmffBase,
    hashBmff: { exclusions: everyType, alg: 'sha256', hash: hashBmffV2(mp4, everyType) },
  });
  check('BMFF: excluding every box is VOID (hash of nothing)',
    vAll.assetHashMatches === false && vAll.assetHashFailure === 'void-binding');
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log('FAILURES:', failures.join(' | '));
  process.exit(1);
}
console.log('ALL VERIFICATION TESTS PASSED');
