/**
 * Differential oracle: every corpus asset runs through BOTH
 * engines — the archived hand-rolled verifier and the official C2PA engine
 * (c2pa-node on node>=22, wasm fallback on the node-20 harness) — with
 * verdicts composed ONLY by the policy layer. Agreement is required; a
 * divergence is allowed only when it is whitelisted in
 * tests/oracle-whitelist.json WITH A WRITTEN REASON. Unwhitelisted
 * divergences FAIL. Nothing is silently absorbed.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-oracle.mts
 */
import * as fs from 'node:fs';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { Encoder } from 'cbor-x';
import { bytesToHex, concatBytes, asciiToBytes, utf8ToBytes } from './bytes.mts';
import { buildSelfSignedCert } from './cert.mts';
import { derToP1363LowS } from './der.mts';
import { attestPhoto, attestPng, attestVideo } from './attest.mts';
import { labSigner } from './deviceKey-shim.mts';
import { extractC2paStoreBmff } from './bmff.mts';
import { extractC2paStore } from './c2pa.mts';
import { oracleVerify, diffOutcomes, type OracleResult } from './oracle.mts';
import { baseResultLike, readUpstreamAsset, UPSTREAM_ENGINE_PINS } from './upstreamEngine.mts';
import { policyVerdict } from './policyLayer.mts';

const STAGED = new URL('./', import.meta.url).pathname;
const CORPUS = new URL('../corpus/', import.meta.url).pathname;
const WHITELIST_PATH = new URL('../oracle-whitelist.json', import.meta.url).pathname;

interface WhitelistEntry {
  file: string;
  divergence: string;
  handrolled?: string;
  upstream?: string;
  reason: string;
}
const whitelist: WhitelistEntry[] = JSON.parse(fs.readFileSync(WHITELIST_PATH, 'utf8'));

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

/** Whitelist match: file + divergence aspect (+ optional exact postures). */
function whitelisted(file: string, d: { aspect: string; handrolled: string; upstream: string }): WhitelistEntry | null {
  for (const w of whitelist) {
    if (w.file !== file || w.divergence !== d.aspect) continue;
    if (w.handrolled !== undefined && w.handrolled !== d.handrolled) continue;
    if (w.upstream !== undefined && w.upstream !== d.upstream) continue;
    return w;
  }
  return null;
}

function oracleCase(name: string, r: OracleResult): void {
  if (r.agree) {
    check(`${name}: engines agree (${r.handrolled.policy.verdict})`, true);
    return;
  }
  for (const d of r.divergences) {
    const w = whitelisted(name, d);
    if (w) {
      check(`${name}: whitelisted divergence [${d.aspect}] — ${w.reason}`, true);
    } else {
      check(`${name}: UNWHITELISTED divergence [${d.aspect}]`, false,
        `handrolled=${d.handrolled} upstream=${d.upstream} — investigate or whitelist WITH a reason; never absorb silently`);
    }
  }
}

// ---------- 0. the upstream engine must actually be there -------------------
console.log('— upstream engine availability —');
{
  const probe = await readUpstreamAsset(new Uint8Array(fs.readFileSync(CORPUS + 'signed-valid.jpg')), 'photo');
  check('upstream engine available in this harness', probe.engineAvailable,
    probe.rawErrors.join('; ') || 'not available');
  console.log(`  engine: ${probe.engine} (pins: c2pa-node@${UPSTREAM_ENGINE_PINS.c2paNode} requires ${UPSTREAM_ENGINE_PINS.c2paNodeRequires}; wasm@${UPSTREAM_ENGINE_PINS.c2paWasm} fallback — ${UPSTREAM_ENGINE_PINS.c2paWasmFallbackReason})`);
  check('engine id disclosed (honesty: we know which binding ran)',
    probe.engine === 'upstream-c2pa-node' || probe.engine === 'upstream-c2pa-wasm', probe.engine);
}

// ---------- 0b. fact-level diffs surface ---
console.log('— fact-level oracle diffs (synthetic) —');
{
  // An assertion-check flip on one engine, verdict unchanged, MUST produce a
  // 'signatureFacts' divergence; an asset-hash flip an 'assetHashFacts' one.
  const mk = () => {
    const n = baseResultLike('upstream-c2pa-wasm', 'synthetic');
    n.manifestFound = true;
    n.signatureValid = true;
    n.claimAssertionsMatch = true;
    n.assetHashMatches = true;
    return n;
  };
  const a = mk();
  const flipAssertions = mk();
  flipAssertions.claimAssertionsMatch = false;
  const d1 = diffOutcomes(a, await policyVerdict(a), flipAssertions, await policyVerdict(flipAssertions));
  check('fact diffs: claimAssertionsMatch flip → signatureFacts divergence (verdict diff also caught)',
    d1.some((d) => d.aspect === 'signatureFacts' && d.upstream.includes('assertions=false')),
    JSON.stringify(d1));
  const b = mk();
  const flipAsset = mk();
  flipAsset.assetHashMatches = false;
  flipAsset.assetHashFailure = 'mismatch';
  const d2 = diffOutcomes(b, await policyVerdict(b), flipAsset, await policyVerdict(flipAsset));
  check('fact diffs: assetHash flip → assetHashFacts divergence',
    d2.some((d) => d.aspect === 'assetHashFacts' && d.upstream.includes('asset=false/mismatch')),
    JSON.stringify(d2));
  const c = mk();
  const same = mk();
  check('fact diffs: identical facts → NO divergences',
    diffOutcomes(c, await policyVerdict(c), same, await policyVerdict(same)).length === 0);
}

// ---------- 1. reference corpus (photo flow) --------------------------------
console.log('— reference corpus —');
for (const f of fs.readdirSync(CORPUS).filter((x) => x.endsWith('.jpg') || x.endsWith('.png'))) {
  oracleCase(f, await oracleVerify(new Uint8Array(fs.readFileSync(CORPUS + f)), 'photo'));
}

// ---------- 2. unsigned generated media (no manifest, both flows) -----------
console.log('— unsigned media —');
for (const f of ['clean.jpg', 'clean.png']) {
  oracleCase(f, await oracleVerify(new Uint8Array(fs.readFileSync(STAGED + f)), 'photo'));
}
for (const f of ['clean.mp4', 'clean.mov', 'clean.m4a']) {
  oracleCase(f, await oracleVerify(new Uint8Array(fs.readFileSync(STAGED + f)), 'video'));
}

// ---------- 3. freshly signed + tampered (photo, png, video) ----------------
console.log('— signed + tampered round trips —');
const key = labSigner();
const ctx = { headingDeg: 90, motion: { verdict: 'handheld', peakHz: 3.2 } } as never;
const identity = { author: 'Oracle Lab', organization: null };

const j = await attestPhoto({ photoUri: STAGED + 'clean.jpg', context: ctx, identity, key });
oracleCase('oracle-signed.jpg', await oracleVerify(j.signedPhotoBytes!, 'photo'));
{
  const t = Uint8Array.from(j.signedPhotoBytes!);
  t[t.length - 100] ^= 0xff;
  oracleCase('oracle-tampered.jpg', await oracleVerify(t, 'photo'));
}
const p = await attestPng({ pngBytes: new Uint8Array(fs.readFileSync(STAGED + 'clean.png')), context: ctx, identity, key });
oracleCase('oracle-signed.png', await oracleVerify(p.signedPngBytes!, 'photo'));

const v = await attestVideo({ videoUri: STAGED + 'clean.mp4', context: ctx, identity, key });
oracleCase('oracle-signed.mp4', await oracleVerify(v.signedVideoBytes!, 'video'));
{
  const t = Uint8Array.from(v.signedVideoBytes!);
  t[t.length - 100] ^= 0xff;
  oracleCase('oracle-tampered.mp4', await oracleVerify(t, 'video'));
}

// ---------- 4. binding-guard classes (void binding + attach attack) -----
console.log('— A-1 binding guard (upstream is stricter; policy must agree) —');
const encoder = new Encoder({ tagUint8Array: false, useRecords: false });
const encode = (x: unknown): Uint8Array => encoder.encode(x);
const UUID_SUFFIX = [0x00, 0x11, 0x00, 0x10, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
const c2paUuid = (s: string) => concatBytes(asciiToBytes(s), new Uint8Array(UUID_SUFFIX));
const u32be = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const box = (t: string, c: Uint8Array) => concatBytes(u32be(c.length + 8), asciiToBytes(t), c);
const jumbBox = (uuid: Uint8Array, label: string, ...contents: Uint8Array[]) =>
  box('jumb', concatBytes(box('jumd', concatBytes(uuid, new Uint8Array([0x03]), asciiToBytes(label), new Uint8Array([0]))), ...contents));
const hashJumbContent = (x: Uint8Array) => sha256(x.subarray(8));
function bstr(x: Uint8Array): Uint8Array {
  const n = x.length;
  const head = n < 24 ? new Uint8Array([0x40 | n]) : n < 256 ? new Uint8Array([0x58, n]) : new Uint8Array([0x59, (n >> 8) & 0xff, n & 0xff]);
  return concatBytes(head, x);
}
const devCert = await buildSelfSignedCert(
  Uint8Array.from(atob(key.publicKeyBase64), (c) => c.charCodeAt(0)),
  key.signDigest, new Date(Date.now() - 60_000));
const clean = new Uint8Array(fs.readFileSync(STAGED + 'clean.jpg'));

async function foreignSegment(assertionBoxes: Uint8Array[], labels: string[]): Promise<Uint8Array> {
  const uuid = bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const claimBytes = encode({
    claim_generator: 'ForeignTool/1.0', 'dc:format': 'image/jpeg', 'dc:title': 'oracle.jpg', instanceID: uuid,
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
const telemetryBox = jumbBox(c2paUuid('json'), 'com.verify.telemetry', box('json', utf8ToBytes(JSON.stringify({ format: 'oracle' }))));
const hashDataBox = (exclusions: unknown, hash: Uint8Array) =>
  jumbBox(c2paUuid('cbor'), 'c2pa.hash.data', box('cbor', encode({ exclusions, alg: 'sha256', hash, name: 'jumbf manifest', pad: new Uint8Array(10) })));

{
  // Claim references telemetry only — no hard binding honored (void).
  const seg = await foreignSegment([telemetryBox], ['com.verify.telemetry']);
  oracleCase('oracle-void-binding.jpg', await oracleVerify(concatBytes(clean.subarray(0, 2), seg, clean.subarray(2)), 'photo'));
}
{
  // The attach attack: self-consistent binding box the claim does NOT reference.
  // The victim is the SIGNED jpeg from §3: the attacker strips the legit C2PA
  // APP11 chain (our embedder places it immediately after SOI) and splices in
  // their own manifest whose hash.data honestly covers the result — only the
  // claim's refusal to declare that binding gives it away. (Building this from
  // the UNSIGNED clean.jpg deleted live image bytes mid-stream; the JPEG scan
  // then bailed before any manifest work and the case silently stopped
  // exercising the guard it exists to pin.)
  const signedClean = j.signedPhotoBytes!;
  const legit = extractC2paStore(signedClean);
  if (!legit) throw new Error('attach-attack setup: signed fixture carries no extractable C2PA store');
  const restAfterStrip = concatBytes(signedClean.subarray(0, 2), signedClean.subarray(2 + legit.segmentLength));
  const attackerHash = sha256(restAfterStrip); // hash.data semantics: everything EXCEPT the exclusion range
  // The claim/signature are independent of the hash.data box (the claim
  // declares telemetry only — that refusal IS the tell), so build them once…
  const uuidC = bytesToHex(p256.utils.randomPrivateKey().subarray(0, 16));
  const claimC = encode({
    claim_generator: 'ForeignTool/1.0', 'dc:format': 'image/jpeg', 'dc:title': 'oracle.jpg', instanceID: uuidC,
    assertions: [{ url: 'self#jumbf=c2pa.assertions/com.verify.telemetry', alg: 'sha256', hash: hashJumbContent(telemetryBox) }],
    signature: 'self#jumbf=c2pa.signature', alg: 'sha256',
  });
  const protC = bstr(concatBytes(new Uint8Array([0xa2, 0x01, 0x26, 0x18, 0x21, 0x81]), bstr(devCert)));
  const sigC = derToP1363LowS(await key.signDigest(sha256(concatBytes(new Uint8Array([0x84, 0x6a]), asciiToBytes('Signature1'), protC, new Uint8Array([0x40]), bstr(claimC)))));
  const coseC = concatBytes(new Uint8Array([0xd2, 0x84]), protC, new Uint8Array([0xa0, 0xf6]), bstr(sigC));
  // …then fixed-point the exclusion span: the CBOR width of `length` itself
  // changes the segment size, so iterate until the declared span equals the
  // actual span (converges in ≤ 4 steps — the width is monotone).
  const assembleSeg = (span: number): Uint8Array => {
    const attackerBox = hashDataBox([{ start: 2, length: span }], attackerHash);
    const storeC = jumbBox(c2paUuid('c2pa'), 'c2pa', jumbBox(c2paUuid('c2ma'), 'foreign:urn:uuid:' + uuidC,
      jumbBox(c2paUuid('c2cl'), 'c2pa.claim', box('cbor', claimC)),
      jumbBox(c2paUuid('c2as'), 'c2pa.assertions', attackerBox, telemetryBox),
      jumbBox(c2paUuid('c2cs'), 'c2pa.signature', box('cbor', coseC))));
    const payloadC = concatBytes(new Uint8Array([0x4a, 0x50, 0x02, 0x11, 0x00, 0x00, 0x00, 0x01]), storeC);
    return concatBytes(new Uint8Array([0xff, 0xeb, ((payloadC.length + 2) >> 8) & 0xff, (payloadC.length + 2) & 0xff]), payloadC);
  };
  let span = 1;
  for (let i = 0; i < 4; i++) {
    const len = assembleSeg(span).length;
    if (len === span) break;
    span = len;
  }
  const segC = assembleSeg(span);
  oracleCase('oracle-attach-attack.jpg', await oracleVerify(concatBytes(signedClean.subarray(0, 2), segC, signedClean.subarray(2 + legit.segmentLength)), 'photo'));
}

// ---------- 5. merkle-aux BMFF — the live UNSUPPORTED-tri-state case --------
console.log('— merkle-aux BMFF (UNSUPPORTED tri-state) —');
{
  // Flip the uuid box's merkle-offset field to nonzero: the manifest now
  // "references merkle aux boxes". Our build declines the whole structure
  // (BmffUnsupported → UNSUPPORTED: unchecked, not condemned); upstream
  // c2pa-rs tries to evaluate and fails its own way. That posture split is
  // THE intentional divergence class of the oracle design — whitelisted.
  const bytes = Uint8Array.from(v.signedVideoBytes!);
  const store = extractC2paStoreBmff(bytes)!;
  check('source store extracted for merkle-offset injection', !!store);
  if (store) {
    const base = store.boxStart + 8;
    let q = base + 20; // version/flags, then NUL-terminated purpose string
    while (bytes[q] !== 0) q++;
    bytes[q + 8] = 1; // merkle offset (u64 BE, last byte) → nonzero
    const r = await oracleVerify(bytes, 'video');
    check('merkle-aux mp4: hand-rolled declines (UNSUPPORTED, never condemns)',
      r.handrolled.policy.verdict === 'UNSUPPORTED', r.handrolled.policy.verdict);
    oracleCase('oracle-merkle-aux.mp4', r);
  }
}

console.log(`=== oracle: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
