// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Foreign manifests — files this app did not produce.
 *
 * Every other suite verifies media this code signed, which cannot show that
 * the reader handles another producer's output. These fixtures were signed by
 * c2patool 0.14.0, the C2PA reference implementation, using its own sample
 * ES256 certificate chain and its own claim generator. Nothing in this
 * repository touched them after signing except the deliberate tamper.
 *
 * Rebuild (c2patool on PATH or at $C2PATOOL, ffmpeg for the source frames):
 *   node tests/build-foreign-corpus.mjs
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-foreign.mts
 */
import * as fs from 'node:fs';
import { verifyPhotoBytes, verifyVideoBytes } from './verifyAsset.mts';

const CORPUS = new URL('../corpus/foreign/', import.meta.url).pathname;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

type Report = Awaited<ReturnType<typeof verifyPhotoBytes>>;
const read = (f: string): Promise<Report> =>
  verifyPhotoBytes(new Uint8Array(fs.readFileSync(CORPUS + f)));
const readBmff = (f: string): Promise<Report> =>
  verifyVideoBytes(new Uint8Array(fs.readFileSync(CORPUS + f)));

console.log('— a foreign v1 claim reads intact —');
{
  const r = await read('c2patool-v1.jpg');
  check('verdict INTACT', r.verdict === 'INTACT', r.verdict);
  check('COSE signature verifies against the foreign chain', r.checks.signatureValid);
  check('c2pa.hash.data recomputes over the file bytes', r.checks.assetHashMatches);
  check('assertion hashes cross-check against the claim', r.c2pa?.claimAssertionsMatch === true);
  check('the two-cert chain verifies', r.c2pa?.certChain?.linksValid === true);
  // The signer is a stranger. A verdict that also asserted trust would be
  // claiming something no offline check can establish.
  check('signer trust is left unresolved, not assumed', r.signerTrust === null);
  check('no Source Kit record is invented for a foreign file', r.record === null);
}

console.log('— a foreign v2 claim binds, in JPEG and PNG —');
// c2pa.claim.v2 splits assertion references into created_assertions and
// gathered_assertions. Reading only the v1 `assertions` key leaves the
// referenced set empty, every binding unreferenced, and the verdict at
// void-binding. These two fixtures are the reference implementation's own v2
// output, so that regression cannot pass unnoticed.
for (const f of ['c2patool-v2.jpg', 'c2patool-v2.png']) {
  const r = await read(f);
  check(`${f}: verdict INTACT`, r.verdict === 'INTACT', r.verdict);
  check(`${f}: hard binding is referenced by the v2 claim`,
    r.c2pa?.assetHashFailure === null && r.checks.assetHashMatches === true,
    `assetHashFailure=${r.c2pa?.assetHashFailure}`);
  check(`${f}: assertion hashes cross-check`, r.c2pa?.claimAssertionsMatch === true);
}

console.log('— a foreign BMFF binding recomputes, in video and audio —');
// c2pa-rs writes an absent exclusion length as CBOR null rather than omitting
// the key. Treating null as a length constraint skips every exclusion the
// manifest declares, which voids the binding on any foreign BMFF file — the
// app's own writer omits the key, so only foreign media exposes it.
for (const f of ['c2patool-v1.mp4', 'c2patool-v1.m4a']) {
  const r = await readBmff(f);
  check(`${f}: verdict INTACT`, r.verdict === 'INTACT', r.verdict);
  check(`${f}: c2pa.hash.bmff recomputes over the file bytes`,
    r.checks.assetHashMatches === true && r.c2pa?.assetHashFailure === null,
    `assetHashFailure=${r.c2pa?.assetHashFailure}`);
  check(`${f}: the foreign chain's signature verifies`, r.checks.signatureValid);
}

console.log('— tamper in a foreign file is caught —');
{
  const r = await read('c2patool-v2-tampered.jpg');
  check('verdict CONTENT_MODIFIED', r.verdict === 'CONTENT_MODIFIED', r.verdict);
  // The signature still verifies: the claim was not touched, the pixels were.
  // Reporting SIGNATURE_INVALID here would name the wrong failure.
  check('the signature still verifies — the claim was not touched', r.checks.signatureValid);
  check('the media re-hash is what fails', r.checks.assetHashMatches === false);
  check('stated as a binding mismatch', r.c2pa?.assetHashFailure === 'mismatch',
    String(r.c2pa?.assetHashFailure));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
