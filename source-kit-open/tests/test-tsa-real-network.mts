/**
 * Regression — REAL production FreeTSA token.
 *
 * A genuine FreeTSA token stresses three parser paths that SHA-256-only
 * mock TSAs never reach — each a verifier failure mode when unhandled:
 *
 *   1. parseCertificate must accept sha512WithRSAEncryption (1.2.840.113549.1.1.13)
 *      — FreeTSA signs ALL its certs with SHA-512 — or every cert is
 *      silently dropped and the verifier reports "no TSA certificates in
 *      token". (x509.ts)
 *   2. The SignerInfo rsaEncryption→digest mapping must cover SHA-512, not
 *      just SHA-256/384. (rfc3161.ts)
 *   3. The messageDigest attribute check must not hardcode SHA-256:
 *      FreeTSA's CMS layer digests the TSTInfo with SHA-512. (rfc3161.ts)
 *
 * Every local test TSA issues SHA-256-only tokens, so this fixture is a
 * REAL token fetched from freetsa.org/tsr (genTime 2026-08-06T00:54:49Z)
 * over the pinned message in freetsa-real-message.hex. The cert chain's validity is
 * evaluated AT the embedded genTime, so this test is time-stable.
 *
 * Cases:
 *  1. TimeStampResp wrapper extraction yields exactly the stored token.
 *  2. The real token verifies: imprint, messageDigest, CMS signature, EKU,
 *     chain links, validity-at-genTime — tokenValid === true.
 *  3. Both embedded certs are on the pinned TSA trust list (root + leaf) —
 *     i.e. this token would anchor a GREEN time rung, not a neutral one.
 *  4. Vacuity guard: one flipped byte in the token MUST fail verification.
 *  5. Wrong message MUST fail on the imprint check specifically.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractTimestampToken } from './timestamp.mts';
import { verifyTimestampToken } from './rfc3161.mts';
import { pinnedTsaFor } from './tsaTrustList.mts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => path.join(here, 'fixtures', n);

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
};

const resp = new Uint8Array(fs.readFileSync(fx('freetsa-real-resp.der')));
const token = new Uint8Array(fs.readFileSync(fx('freetsa-real-token.der')));
const message = new Uint8Array(Buffer.from(fs.readFileSync(fx('freetsa-real-message.hex'), 'utf8').trim(), 'hex'));

// 1. wrapper extraction
const extracted = extractTimestampToken(resp);
check('TimeStampResp wrapper extraction yields the stored token',
  extracted.length === token.length && extracted.every((b, i) => b === token[i]));

// 2. full verification
const result = verifyTimestampToken(token, message);
check('real FreeTSA token verifies', result.tokenValid, result.reason ?? '');
check('genTime parsed from TSTInfo', result.genTimeUtc === '2026-08-06T00:54:49Z', String(result.genTimeUtc));
check('chain links valid', result.tsaChainLinksValid === true);
check('TSA named from its certificate', result.tsaName === 'www.freetsa.org', String(result.tsaName));

// 3. trust pinning (root or leaf match anchors the time rung)
const pin = pinnedTsaFor(result.tsaFingerprints);
check('token chain matches a pinned TSA', pin !== null);

// 4. vacuity guard — a corrupted token must NOT pass
const tampered = new Uint8Array(token);
tampered[tampered.length - 12] ^= 0x01;
const tamperedResult = verifyTimestampToken(tampered, message);
check('bit-flipped token fails verification', !tamperedResult.tokenValid);

// 5. wrong message → imprint mismatch
const wrong = new Uint8Array(message);
wrong[0] ^= 0xff;
const wrongResult = verifyTimestampToken(token, wrong);
check('wrong message fails on messageImprint', !wrongResult.tokenValid &&
  (wrongResult.reason ?? '').includes('messageImprint'), wrongResult.reason ?? '');

console.log(`\ntsa-real-network: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
