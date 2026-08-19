// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Trust ladder projection.
 *
 * The ladder is presentation logic, not a verdict engine — but the mapping
 * rules are where honesty lives, so they are pinned here against drift:
 *
 *  1. Four states only. reached = evidence VERIFIED (never "present"),
 *     unreached = neutral absence, failed = proven tamper only,
 *     not-applicable = structurally unavailable/unevaluable, said out loud.
 *  2. Integrity failure splits: broken CREDENTIALS block every rung above;
 *     changed MEDIA fails rung 1 but leaves signer/attestation/time live.
 *  3. Org-vouching is earned only OUTSIDE the file (roster, trust list);
 *     a self-asserted org root is rung-2 with an out-of-band caveat.
 *  4. Time rungs count INDEPENDENT anchors only — unpinned TSAs, unchecked
 *     ledger bindings, and the device clock are all unreached, each named.
 *  5. No manifest → no ladder at all (absence is neutral, its own card).
 */
import { projectTrustLadder, LADDER_LIMITS_SENTENCE, type LadderInput } from './trustLadder.mts';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/** All-five-reached fixture: INTACT, roster-active, attested, double-anchored. */
const base: LadderInput = {
  manifestFound: true,
  verdict: 'INTACT',
  signatureValid: true,
  fingerprintMatches: true,
  assetHashMatches: true,
  tier: 'roster',
  rosterState: 'active',
  rosterNewsroom: 'The Lab Gazette',
  trustListName: null,
  orgChain: { linksValid: true, topSubject: 'The Lab Gazette' },
  appAttest: { present: true, valid: true },
  hardwareNotApplicable: null,
  timestamps: { present: 1, valid: 1, trusted: 1 },
  ots: 'confirmed-verified',
};
const over = (patch: Partial<LadderInput>): LadderInput => ({ ...base, ...patch });

// --- 1. the full ladder ---------------------------------------------------
{
  const l = projectTrustLadder(base)!;
  check('base: all five rungs reached', l.rungs.every((r) => r.state === 'reached'));
  check('base: highest reached is rung 5 (ring target)', l.highestReached === 4);
  check('base: nothing failed', l.anyFailed === false);
  check('base: rung order matches the plan vocabulary',
    l.rungs.map((r) => r.id).join(',') === 'bytes,known-key,org-vouched,hardware,time');
  check('base: rung labels are the short checkable names',
    l.rungs.map((r) => r.label).join(' | ') ===
    // Vocabulary note: rung 1 ships as 'Media unchanged since signing' in the
    // app (onward); the open tree's copy had drifted to 'Bytes…' and
    // the trees were unified on the shipped string in (audit E4).
    'Media unchanged since signing | Signer identified | Accessioned by an organization | Key attested by Apple hardware | Time bracketed by an independent anchor');
  check('base: double anchor says "both sides"', l.rungs[4].detail.includes('Pinned-authority countersign') && l.rungs[4].detail.includes('Bitcoin anchor'));
}

// --- 4. time rung: independent anchors only --------------------------------
{
  const trustedOnly = projectTrustLadder(over({ ots: 'none' }))!;
  check('time: pinned TSA alone reaches', trustedOnly.rungs[4].state === 'reached');
  check('time: single anchor does NOT claim both sides', !trustedOnly.rungs[4].detail.includes('Bitcoin'));

  const ledgerOnly = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 } }))!;
  check('time: verified Bitcoin anchor alone reaches', ledgerOnly.rungs[4].state === 'reached' && ledgerOnly.rungs[4].detail.includes('Bitcoin'));

  const unpinned = projectTrustLadder(over({ timestamps: { present: 1, valid: 1, trusted: 0 }, ots: 'none' }))!;
  check('time: unpinned TSA is unreached, named', unpinned.rungs[4].state === 'unreached' && unpinned.rungs[4].detail.includes('not pinned'));

  const failedToken = projectTrustLadder(over({ timestamps: { present: 2, valid: 1, trusted: 1 }, ots: 'none' }))!;
  check('time: a FAILED attached token fails the rung', failedToken.rungs[4].state === 'failed' && failedToken.anyFailed);

  const badLedger = projectTrustLadder(over({ ots: 'invalid' }))!;
  check('time: invalid ledger receipt fails the rung', badLedger.rungs[4].state === 'failed');

  const pending = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 }, ots: 'pending' }))!;
  check('time: pending ledger is unreached ("awaiting confirmation")', pending.rungs[4].state === 'unreached' && pending.rungs[4].detail.includes('awaiting confirmation'));

  const unchecked = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 }, ots: 'confirmed-unchecked' }))!;
  check('time: confirmed-but-unchecked ledger is unreached, says so', unchecked.rungs[4].state === 'unreached' && unchecked.rungs[4].detail.includes('not checked'));

  const clockOnly = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 }, ots: 'none' }))!;
  check('time: device clock only is unreached', clockOnly.rungs[4].state === 'unreached' && clockOnly.rungs[4].detail.includes('Device clock'));
}

// --- 3. signer rungs: outside vouching only --------------------------------
{
  const unknown = projectTrustLadder(over({ tier: 'unknown', rosterState: null, rosterNewsroom: null, orgChain: null }))!;
  check('signer: unknown key is unreached, NEVER failed', unknown.rungs[1].state === 'unreached' && unknown.rungs[1].detail.includes('Nothing outside the file'));
  check('signer: unknown key leaves org-vouching unreached', unknown.rungs[2].state === 'unreached');

  const own = projectTrustLadder(over({ tier: 'this-device', rosterState: null, rosterNewsroom: null, orgChain: null }))!;
  // Deliberate: recognizing our own key is NOT identification — the device
  // telling itself "this is mine" vouches for nothing, so rung 2 stays
  // unreached until something OUTSIDE the file vouches for the signer.
  check('signer: this-device never reaches rung 2 (self-recognition is not vouching)',
    own.rungs[1].state === 'unreached' && own.rungs[1].detail.includes("this device's own key"));
  check('signer: this-device honestly skips org vouching', own.rungs[2].state === 'unreached' && own.rungs[2].detail.includes('no organization'));

  const org = projectTrustLadder(over({ tier: 'org', rosterState: null, rosterNewsroom: null }))!;
  check('signer: self-asserted org root reaches rung 2 only', org.rungs[1].state === 'reached' && org.rungs[2].state === 'unreached');
  check('signer: org root carries the out-of-band caveat', org.rungs[2].detail.includes('out of band'));

  const list = projectTrustLadder(over({ tier: 'trust-list', rosterState: null, rosterNewsroom: null, trustListName: 'C2PA curated list' }))!;
  check('signer: trust list reaches rungs 2+3', list.rungs[1].state === 'reached' && list.rungs[2].state === 'reached');

  const revoked = projectTrustLadder(over({ rosterState: 'revoked' }))!;
  check('signer: signed-after-revocation FAILS rung 3', revoked.rungs[2].state === 'failed' && revoked.rungs[2].detail.includes('revoked') && revoked.anyFailed);

  const tooEarly = projectTrustLadder(over({ rosterState: 'not-yet-valid' }))!;
  check('signer: signed-before-membership FAILS rung 3', tooEarly.rungs[2].state === 'failed' && tooEarly.rungs[2].detail.includes('before'));

  const laterRevoked = projectTrustLadder(over({ rosterState: 'active-then-revoked' }))!;
  check('signer: capture predating a later revocation stays reached', laterRevoked.rungs[2].state === 'reached' && laterRevoked.rungs[2].detail.includes('predates'));

  const expired = projectTrustLadder(over({ rosterState: 'expired' }))!;
  check('signer: expired membership is unreached, named', expired.rungs[2].state === 'unreached' && expired.rungs[2].detail.includes('expired'));

  const unknownTime = projectTrustLadder(over({ rosterState: 'unknown-time' }))!;
  check('signer: unevaluable membership is unreached, named', unknownTime.rungs[2].state === 'unreached' && unknownTime.rungs[2].detail.includes('cannot be evaluated'));
}

// --- 2. integrity failure splits honestly ----------------------------------
{
  const creds = projectTrustLadder(over({ verdict: 'SIGNATURE_INVALID', signatureValid: false }))!;
  check('integrity: broken signature fails rung 1', creds.rungs[0].state === 'failed');
  check('integrity: broken credentials block ALL rungs above',
    creds.rungs.slice(1).every((r) => r.state === 'not-applicable'));
  check('integrity: blocked rungs say why', creds.rungs[1].detail.includes('failed verification'));
  check('integrity: nothing rings when credentials fail', creds.highestReached === -1 && creds.anyFailed);

  const fpBad = projectTrustLadder(over({ fingerprintMatches: false }))!;
  check('integrity: fingerprint mismatch blocks the same way',
    fpBad.rungs[0].state === 'failed' && fpBad.rungs.slice(1).every((r) => r.state === 'not-applicable'));

  const media = projectTrustLadder(over({ verdict: 'CONTENT_MODIFIED', assetHashMatches: false }))!;
  check('integrity: changed media fails rung 1 with its own detail',
    media.rungs[0].state === 'failed' && media.rungs[0].detail.includes('no longer matches'));
  check('integrity: changed media leaves the signer rungs LIVE',
    media.rungs[1].state === 'reached' && media.rungs[2].state === 'reached');

  const partial = projectTrustLadder(over({ signatureValid: null, fingerprintMatches: null, assetHashMatches: null }))!;
  check('integrity: incomplete verification is unreached, not failed',
    partial.rungs[0].state === 'unreached' && partial.rungs[0].detail.includes('Not fully checked') && !partial.anyFailed);
}

// --- 1. hardware rung states ------------------------------------------------
{
  const badAttest = projectTrustLadder(over({ appAttest: { present: true, valid: false } }))!;
  check('hardware: attestation present-but-invalid FAILS', badAttest.rungs[3].state === 'failed');

  const deid = projectTrustLadder(over({ appAttest: { present: false, valid: false }, hardwareNotApplicable: 'deidentified' }))!;
  check('hardware: de-identified copy is not-applicable, reason named',
    deid.rungs[3].state === 'not-applicable' && deid.rungs[3].detail.includes('one-time key'));

  const assignment = projectTrustLadder(over({ appAttest: { present: false, valid: false }, hardwareNotApplicable: 'assignment' }))!;
  // The detail must explain why the HARDWARE rung doesn't apply — the key is
  // software-backed — not why someone would choose an assignment key. The copy
  // used to say 'deliberately unlinkable', which is a different claim and an
  // overstated one: captures within an assignment share a key fingerprint.
  check('hardware: assignment key is not-applicable, reason named',
    assignment.rungs[3].state === 'not-applicable'
    && assignment.rungs[3].detail.includes('assignment keys')
    && /hardware attestation/i.test(assignment.rungs[3].detail));

  const none = projectTrustLadder(over({ appAttest: { present: false, valid: false } }))!;
  check('hardware: absent attestation is unreached, neutral', none.rungs[3].state === 'unreached');

  // Attestation environment is NAMED (a genuine dev attestation is
  // never red, never silent, and never dressed up as production).
  const prod = projectTrustLadder(over({ appAttest: { present: true, valid: true, attestationEnv: 'production' } }))!;
  check('hardware: production attestation reaches and names production',
    prod.rungs[3].state === 'reached' && prod.rungs[3].detail.includes('production'));

  const dev = projectTrustLadder(over({ appAttest: { present: true, valid: true, attestationEnv: 'development' } }))!;
  check('hardware: genuine DEVELOPMENT attestation is never red, never silent',
    dev.rungs[3].state !== 'failed' && dev.rungs[3].detail.includes('DEVELOPMENT'));
  check('hardware: development attestation does not reach the production rung',
    dev.rungs[3].state === 'unreached');

  const envUnknown = projectTrustLadder(over({ appAttest: { present: true, valid: true, attestationEnv: null } }))!;
  // Wording note: 'verified' is on the project's own ban list in status
  // positions (audit B8, applied to settings.tsx there and here in),
  // so the classic wording pin now tracks the banned-word-free string.
  check('hardware: unknown environment stays backward compatible (reached, ban-list wording)',
    envUnknown.rungs[3].state === 'reached' && envUnknown.rungs[3].detail.includes("App Attest checked against Apple's root, offline"));
}

// --- 5. absence + the limits sentence ---------------------------------------
{
  check('absence: no manifest → no ladder at all',
    projectTrustLadder(over({ manifestFound: false, verdict: 'NO_ATTESTATION' })) === null);
  check('the limits sentence travels with the card',
    LADDER_LIMITS_SENTENCE.includes('Custody is not reality'));
}


// A void binding is absence of proof, never proven
// tamper — rung 1 unreached with the precise reason, upper rungs stay live.
{
  const l = projectTrustLadder(over({ assetHashMatches: null, bindingVoid: true }));
  const b = l!.rungs[0];
  check('void binding: rung 1 unreached, not failed',
    b.state === 'unreached' && !!b.detail && b.detail.includes('exclusion rules exempt'));
  check('void binding: rungs above still evaluate',
    l!.rungs[1].state === 'reached' && l!.rungs[4].state === 'reached');
}

// "Known hand": local collection history enriches rung 2's detail
// at the unidentified floor — it NEVER promotes the rung to reached,
// because local history is not vouching.
{
  const hist = { priorCaptures: 5, firstSeen: '2026-03-02T10:00:00Z' };
  const l = projectTrustLadder(over({
    tier: 'unknown', rosterState: null, rosterNewsroom: null, orgChain: null, localHand: hist,
  }))!;
  check('known hand: rung 2 stays UNREACHED (local history is not vouching)',
    l.rungs[1].state === 'unreached');
  check('known hand: detail states the count and the device-local scope',
    l.rungs[1].detail.includes('5 exhibits') && l.rungs[1].detail.includes('on this device'));
  check('known hand: detail still says local history is not vouching',
    l.rungs[1].detail.includes('local history, not vouching'));

  const noHist = projectTrustLadder(over({
    tier: 'unknown', rosterState: null, rosterNewsroom: null, orgChain: null, localHand: null,
  }))!;
  check('no history: the mint-a-key caveat stands alone',
    noHist.rungs[1].detail.includes('anyone can mint a key in milliseconds') && !noHist.rungs[1].detail.includes('known signer'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
