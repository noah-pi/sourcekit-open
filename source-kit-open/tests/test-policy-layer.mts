/**
 * Policy-layer unit coverage: every row of the verdict-mapping
 * table in policyLayer.ts is exercised with synthetic normalized facts. No
 * engine runs here — this pins the POLICY, the only verdict authority, so an
 * engine upgrade can never silently change what our verdicts mean.
 *
 * Run from tests/.staged:  ./node_modules/.bin/tsx test-policy-layer.mts
 */
import { baseResultLike, type NormalizedEngineResult } from './upstreamEngine.mts';
import { policyVerdict } from './policyLayer.mts';
import type { VerdictCode, VerificationReport } from './verifyAsset.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} :: ${detail}`); }
};

/** Facts for a manifest that was found and fully evaluated. */
function evaluated(): NormalizedEngineResult {
  const n = baseResultLike('upstream-c2pa-wasm', 'synthetic');
  n.manifestFound = true;
  n.signatureValid = true;
  n.claimAssertionsMatch = true;
  n.assetHashMatches = true;
  return n;
}

async function verdictOf(n: NormalizedEngineResult): Promise<VerdictCode> {
  return (await policyVerdict(n)).verdict;
}

// Row 1 — engine unavailable → UNSUPPORTED (unchecked, never condemned)
{
  const n = baseResultLike('unavailable', 'none');
  n.engineAvailable = false;
  n.unsupported = true;
  n.unsupportedReason = 'synthetic load failure';
  const r = await policyVerdict(n);
  check('row 1: engine unavailable → UNSUPPORTED', r.verdict === 'UNSUPPORTED', r.verdict);
  check('row 1: disclosed as not-performed, not a condemnation', r.checksNotPerformed.length > 0 && /not tamper|unchecked/i.test(r.checksNotPerformed[0]));
}

// Row 2 — container gates
{
  const n = baseResultLike('handrolled', 'synthetic');
  n.containerRejected = 'NOT_JPEG';
  check('row 2: photo flow rejects non-JPEG/PNG', (await verdictOf(n)) === 'NOT_JPEG');
  const m = baseResultLike('handrolled', 'synthetic');
  m.containerRejected = 'NOT_BMFF';
  check('row 2: video flow rejects non-BMFF', (await verdictOf(m)) === 'NOT_BMFF');
}

// Row 3 — no manifest → NO_ATTESTATION
{
  const n = baseResultLike('upstream-c2pa-wasm', 'synthetic');
  check('row 3: no manifest → NO_ATTESTATION', (await verdictOf(n)) === 'NO_ATTESTATION');
}

// Row 4 — unreadable container → UNREADABLE
{
  const n = baseResultLike('handrolled', 'synthetic');
  n.manifestFound = true;
  n.unreadable = true;
  check('row 4: corrupt parse → UNREADABLE', (await verdictOf(n)) === 'UNREADABLE');
}

// Row 5 — UNSUPPORTED tri-state (ours; upstream has none)
{
  const n = baseResultLike('upstream-c2pa-wasm', 'synthetic');
  n.manifestFound = true;
  n.unsupported = true;
  n.unsupportedReason = 'engine declined structure: algorithm.unsupported';
  const r = await policyVerdict(n);
  check('row 5: unsupported structure → UNSUPPORTED with reason', r.verdict === 'UNSUPPORTED' && /algorithm\.unsupported/.test(r.reason), r.verdict);
}
{
  // inconclusive evaluation (manifest found, all facts null) → UNSUPPORTED, never a green
  const n = baseResultLike('upstream-c2pa-wasm', 'synthetic');
  n.manifestFound = true;
  check('row 5b: inconclusive engine output → UNSUPPORTED (never INTACT by default)', (await verdictOf(n)) === 'UNSUPPORTED');
}

// Row 6 — signature invalid
{
  const n = evaluated();
  n.signatureValid = false;
  check('row 6: signatureValid=false → SIGNATURE_INVALID', (await verdictOf(n)) === 'SIGNATURE_INVALID');
}

// Row 7 — assertion hashes ≠ claim
{
  const n = evaluated();
  n.claimAssertionsMatch = false;
  check('row 7: claimAssertionsMatch=false → SIGNATURE_INVALID', (await verdictOf(n)) === 'SIGNATURE_INVALID');
}

// Row 8 — void binding → SIGNATURE_INVALID, UNPROVEN never proven tamper
{
  const n = evaluated();
  n.assetHashMatches = false;
  n.assetHashFailure = 'void-binding';
  const r = await policyVerdict(n);
  check('row 8: void-binding → SIGNATURE_INVALID', r.verdict === 'SIGNATURE_INVALID', r.verdict);
  check('row 8: reason says UNPROVEN, never "media altered"', /UNPROVEN/.test(r.reason) && !/media (was |bytes )?(altered|changed|differ)/i.test(r.reason));
  check('row 8: binding guard disclosed in checksNotPerformed', r.checksNotPerformed.some((l) => /VOID|A-1/.test(l)));
}

// Row 9 — media changed after signing → CONTENT_MODIFIED
{
  const n = evaluated();
  n.assetHashMatches = false;
  n.assetHashFailure = 'mismatch';
  check('row 9: real mismatch → CONTENT_MODIFIED', (await verdictOf(n)) === 'CONTENT_MODIFIED');
}

// Row 10 — everything checks → INTACT; trust codes never block it
{
  const n = evaluated();
  n.trustListHit = 'none'; // signer on neither pinned list — informational
  n.validationStatus = [{ code: 'signingCredential.untrusted', severity: 'informational', explanation: 'synthetic' }];
  const r = await policyVerdict(n);
  check('row 10: clean facts → INTACT even with untrusted signer (trust is a tier, not a verdict)', r.verdict === 'INTACT', r.verdict);
  check('row 10: unattributed signer disclosed', r.checksNotPerformed.some((l) => /NEITHER|unattributed/i.test(l)));
  check('row 10: trustListHit carried to the tier inputs', r.trust.trustListHit === 'none');
}

// Precedence: signature failure dominates a media mismatch
{
  const n = evaluated();
  n.signatureValid = false;
  n.assetHashMatches = false;
  n.assetHashFailure = 'mismatch';
  check('precedence: SIGNATURE_INVALID dominates CONTENT_MODIFIED', (await verdictOf(n)) === 'SIGNATURE_INVALID');
}

// Row 10 gate requires claimAssertionsMatch === true:
// an engine that never cross-checked the assertion store produced NO
// evidence either way — that is the UNSUPPORTED tri-state, never a green.
{
  const n = evaluated();
  n.claimAssertionsMatch = null;
  const r = await policyVerdict(n);
  check('row 10 gate: sig=true asset=true assertions=NULL → UNSUPPORTED, never INTACT (fail closed)',
    r.verdict === 'UNSUPPORTED' && r.mappingRow === 5, r.verdict);
  check('row 10 gate: the missing check is named in the facts line',
    r.checksNotPerformed.some((l) => l.includes('claimAssertionsMatch=null')), r.checksNotPerformed.join(' | '));
}

// Precedence: POSITIVE TAMPER FACTS outrank UNSUPPORTED — a failed rung
// is proven tamper, never absence-of-proof, even
// when the structure is also one this build cannot fully parse.
{
  const n = evaluated();
  n.unsupported = true;
  n.unsupportedReason = 'engine declined structure: assertion.bmffHash.malformed';
  n.signatureValid = false;
  const r = await policyVerdict(n);
  check('precedence: unsupported + signatureValid=false → SIGNATURE_INVALID (proven tamper outranks unchecked)',
    r.verdict === 'SIGNATURE_INVALID' && r.mappingRow === 6, r.verdict);
}
{
  const n = evaluated();
  n.unsupported = true;
  n.unsupportedReason = 'engine declined structure: assertion.boxesHash.unknownBox';
  n.assetHashMatches = false;
  n.assetHashFailure = 'mismatch';
  const r = await policyVerdict(n);
  check('precedence: unsupported + assetHash mismatch → CONTENT_MODIFIED (known media mismatch is not "unchecked")',
    r.verdict === 'CONTENT_MODIFIED' && r.mappingRow === 9, r.verdict);
}
{
  const n = evaluated();
  n.unsupported = true;
  n.unsupportedReason = 'engine declined structure: algorithm.unsupported';
  n.assetHashMatches = false;
  n.assetHashFailure = 'void-binding';
  check('precedence: unsupported + void-binding → SIGNATURE_INVALID (UNPROVEN, never proven tamper)',
    (await verdictOf(n)) === 'SIGNATURE_INVALID');
}
{
  // The other direction: unsupported with NO positive tamper fact stays
  // UNSUPPORTED — declining to evaluate is honest when nothing failed.
  const n = evaluated();
  n.unsupported = true;
  n.unsupportedReason = 'engine declined structure: algorithm.unsupported';
  n.signatureValid = null;
  n.claimAssertionsMatch = null;
  n.assetHashMatches = null;
  const r = await policyVerdict(n);
  check('precedence: unsupported with no positive tamper fact → UNSUPPORTED (unchecked, not condemned)',
    r.verdict === 'UNSUPPORTED' && r.mappingRow === 5, r.verdict);
}

// Trust-tier inputs: resolver result carried; resolver failure disclosed
{
  const n = evaluated();
  n.raw = { c2pa: { signerFingerprint: 'deadbeef' } } as unknown as VerificationReport;
  const r = await policyVerdict(n, {
    trustResolver: () => ({ tier: 'known-hand', label: 'Lab Key', evidence: ['synthetic'] } as never),
  });
  check('trust: resolver tier carried to policy output', r.trust.signerTrust?.tier === 'known-hand', JSON.stringify(r.trust.signerTrust));
  const r2 = await policyVerdict(n, {
    trustResolver: () => { throw new Error('synthetic resolver failure'); },
  });
  check('trust: resolver failure disclosed, never silently green',
    r2.verdict === 'INTACT' && r2.checksNotPerformed.some((l) => /resolver threw/.test(l)));
  const r3 = await policyVerdict(n);
  check('trust: no resolver → UNRESOLVED disclosed', r3.checksNotPerformed.some((l) => /UNRESOLVED/.test(l)));
}

// Parity: composed verdict MUST equal the archived verdict or THROW
{
  const n = evaluated();
  const fakeReport = { verdict: 'CONTENT_MODIFIED' } as VerificationReport;
  let threw = false;
  try {
    await policyVerdict(n, { handrolledReport: fakeReport });
  } catch (e) {
    threw = /parity failure/.test(e instanceof Error ? e.message : String(e));
  }
  check('parity: composed ≠ archived verdict throws loudly (never absorbed)', threw);
}

console.log(`=== policy-layer: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
