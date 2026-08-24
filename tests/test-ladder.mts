// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Trust ladder projection.
 *
 * The ladder is presentation logic. The mapping rules pinned here:
 *
 *  1. Four states only: reached = evidence verified, unreached = absence,
 *     failed = proven tamper, not-applicable = structurally unevaluable.
 *  2. Integrity failure splits: broken credentials block every rung above;
 *     changed media fails rung 1 but leaves signer/attestation/time live.
 *  3. Org-vouching comes only from outside the file (roster, trust list); a
 *     self-asserted org root is rung 2 with an out-of-band caveat.
 *  4. Time rungs count independent anchors only; unpinned TSAs, unchecked
 *     ledger bindings, and the device clock are unreached, each named.
 *  5. No manifest, no ladder.
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

// Rungs are addressed by id, never by position: the ladder's ORDER is a
// presentation choice and has changed, but which evidence backs which rung
// is the thing these checks are about.
type Ladder = NonNullable<ReturnType<typeof projectTrustLadder>>;
const rung = (l: Ladder, id: string) => {
  const r = l.rungs.find((x) => x.id === id);
  if (!r) throw new Error(`no rung with id ${id}`);
  return r;
};
const bytes = (l: Ladder) => rung(l, 'bytes');
const signer = (l: Ladder) => rung(l, 'known-key');
const hardware = (l: Ladder) => rung(l, 'hardware');
const timeRung = (l: Ladder) => rung(l, 'time');

// --- 1. the full ladder ---------------------------------------------------
{
  const l = projectTrustLadder(base)!;
  check('base: all four rungs reached', l.rungs.every((r) => r.state === 'reached'));
  check('base: highest reached is rung 4 (ring target)', l.highestReached === 3);
  check('base: nothing failed', l.anyFailed === false);
  check('base: rung order matches the plan vocabulary',
    l.rungs.map((r) => r.id).join(',') === 'bytes,time,hardware,known-key');
  check('base: rung labels are the short checkable names',
    l.rungs.map((r) => r.label).join(' | ') ===
    // The signer rung merges known-key and org-vouched: a roster entry or
    // trust-list accession is the identification.
    'Media unchanged since signing | Time confirmed by independent anchor | Device integrity attested | Signer identified');
  check('base: double anchor says "both sides"', timeRung(l).detail.includes('Countersigned by a recognized authority') && timeRung(l).detail.includes('Bitcoin block'));
}

// --- 4. time rung: independent anchors only --------------------------------
{
  const trustedOnly = projectTrustLadder(over({ ots: 'none' }))!;
  check('time: pinned TSA alone reaches', timeRung(trustedOnly).state === 'reached');
  check('time: single anchor does NOT claim both sides', !timeRung(trustedOnly).detail.includes('Bitcoin'));

  const ledgerOnly = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 } }))!;
  check('time: verified Bitcoin anchor alone reaches', timeRung(ledgerOnly).state === 'reached' && timeRung(ledgerOnly).detail.includes('Bitcoin'));

  const unpinned = projectTrustLadder(over({ timestamps: { present: 1, valid: 1, trusted: 0 }, ots: 'none' }))!;
  check('time: unpinned TSA is unreached, named', timeRung(unpinned).state === 'unreached' && timeRung(unpinned).detail.includes('does not recognize the authority'));

  const failedToken = projectTrustLadder(over({ timestamps: { present: 2, valid: 1, trusted: 1 }, ots: 'none' }))!;
  check('time: a FAILED attached token fails the rung', timeRung(failedToken).state === 'failed' && failedToken.anyFailed);

  const badLedger = projectTrustLadder(over({ ots: 'invalid' }))!;
  check('time: invalid ledger receipt fails the rung', timeRung(badLedger).state === 'failed');

  const pending = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 }, ots: 'pending' }))!;
  check('time: pending ledger is unreached ("awaiting confirmation")', timeRung(pending).state === 'unreached' && timeRung(pending).detail.includes('awaiting confirmation'));

  const unchecked = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 }, ots: 'confirmed-unchecked' }))!;
  check('time: confirmed-but-unchecked ledger is unreached, says so', timeRung(unchecked).state === 'unreached' && timeRung(unchecked).detail.includes('not checked'));

  const clockOnly = projectTrustLadder(over({ timestamps: { present: 0, valid: 0, trusted: 0 }, ots: 'none' }))!;
  check('time: device clock only is unreached', timeRung(clockOnly).state === 'unreached' && timeRung(clockOnly).detail.includes('Device clock'));
}

// --- 3. signer rungs: outside vouching only --------------------------------
{
  const unknown = projectTrustLadder(over({ tier: 'unknown', rosterState: null, rosterNewsroom: null, orgChain: null }))!;
  check('signer: unknown key is unreached, NEVER failed', signer(unknown).state === 'unreached' && signer(unknown).detail.includes('vouches for itself and nothing else'));
  check('signer: unknown key leaves org-vouching unreached', signer(unknown).state === 'unreached');

  const own = projectTrustLadder(over({ tier: 'this-device', rosterState: null, rosterNewsroom: null, orgChain: null }))!;
  // Recognizing this device's own key is not identification, so rung 2 stays
  // unreached until something outside the file vouches for the signer.
  check('signer: this-device never reaches rung 2 (self-recognition is not vouching)',
    signer(own).state === 'unreached' && signer(own).detail.includes("this device's own key"));
  check('signer: this-device names what is missing', signer(own).detail.includes('Nothing outside the file vouches'));

  const org = projectTrustLadder(over({ tier: 'org', rosterState: null, rosterNewsroom: null }))!;
  // A self-asserted root names an organization without identifying anyone,
  // so the merged signer rung stays unreached with the reason.
  check('signer: self-asserted org root does NOT reach', signer(org).state === 'unreached' && signer(org).detail.includes('nobody outside the file confirms that name'));
  check('signer: org root names the out-of-band step', signer(org).detail.includes('Ask the organization for their fingerprint'));

  const list = projectTrustLadder(over({ tier: 'trust-list', rosterState: null, rosterNewsroom: null, trustListName: 'C2PA curated list' }))!;
  check('signer: a curated trust list reaches the signer rung', signer(list).state === 'reached' && signer(list).detail.includes('trust list'));

  const revoked = projectTrustLadder(over({ rosterState: 'revoked' }))!;
  check('signer: signed-after-revocation FAILS rung 3', signer(revoked).state === 'failed' && signer(revoked).detail.includes('revoked') && revoked.anyFailed);

  const tooEarly = projectTrustLadder(over({ rosterState: 'not-yet-valid' }))!;
  check('signer: signed-before-membership FAILS rung 3', signer(tooEarly).state === 'failed' && signer(tooEarly).detail.includes('before'));

  const laterRevoked = projectTrustLadder(over({ rosterState: 'active-then-revoked' }))!;
  check('signer: capture predating a later revocation stays reached', signer(laterRevoked).state === 'reached' && signer(laterRevoked).detail.includes('predates'));

  const expired = projectTrustLadder(over({ rosterState: 'expired' }))!;
  check('signer: expired membership is unreached, named', signer(expired).state === 'unreached' && signer(expired).detail.includes('expired'));

  const unknownTime = projectTrustLadder(over({ rosterState: 'unknown-time' }))!;
  check('signer: unevaluable membership is unreached, named', signer(unknownTime).state === 'unreached' && signer(unknownTime).detail.includes('cannot tell whether they were still a member'));
}

// --- 2. integrity failure splits -------------------------------------------
{
  const creds = projectTrustLadder(over({ verdict: 'SIGNATURE_INVALID', signatureValid: false }))!;
  check('integrity: broken signature fails rung 1', bytes(creds).state === 'failed');
  check('integrity: broken credentials block ALL rungs above',
    creds.rungs.slice(1).every((r) => r.state === 'not-applicable'));
  check('integrity: blocked rungs say why', signer(creds).detail.includes('the seal itself did not verify'));
  check('integrity: nothing rings when credentials fail', creds.highestReached === -1 && creds.anyFailed);

  const fpBad = projectTrustLadder(over({ fingerprintMatches: false }))!;
  check('integrity: fingerprint mismatch blocks the same way',
    fpBad.rungs[0].state === 'failed' && fpBad.rungs.slice(1).every((r) => r.state === 'not-applicable'));

  const media = projectTrustLadder(over({ verdict: 'CONTENT_MODIFIED', assetHashMatches: false }))!;
  check('integrity: changed media fails rung 1 with its own detail',
    bytes(media).state === 'failed' && bytes(media).detail.includes('no longer matches'));
  check('integrity: changed media leaves the signer rungs LIVE',
    signer(media).state === 'reached' && signer(media).state === 'reached');

  const partial = projectTrustLadder(over({ signatureValid: null, fingerprintMatches: null, assetHashMatches: null }))!;
  check('integrity: incomplete verification is unreached, not failed',
    bytes(partial).state === 'unreached' && bytes(partial).detail.includes('could not finish checking the seal') && !partial.anyFailed);
}

// --- 1. hardware rung states ------------------------------------------------
{
  const badAttest = projectTrustLadder(over({ appAttest: { present: true, valid: false } }))!;
  check('hardware: attestation present-but-invalid FAILS', hardware(badAttest).state === 'failed');

  const deid = projectTrustLadder(over({ appAttest: { present: false, valid: false }, hardwareNotApplicable: 'deidentified' }))!;
  check('hardware: de-identified copy is not-applicable, reason named',
    hardware(deid).state === 'not-applicable' && hardware(deid).detail.includes('one-time key'));

  const none = projectTrustLadder(over({ appAttest: { present: false, valid: false } }))!;
  check('hardware: absent attestation is unreached, neutral', hardware(none).state === 'unreached');

  // The attestation environment is named; a dev attestation is neither
  // failed nor shown as production.
  const prod = projectTrustLadder(over({ appAttest: { present: true, valid: true, attestationEnv: 'production' } }))!;
  check('hardware: production attestation reaches and names production',
    hardware(prod).state === 'reached' && hardware(prod).detail.includes('production'));

  const dev = projectTrustLadder(over({ appAttest: { present: true, valid: true, attestationEnv: 'development' } }))!;
  check('hardware: genuine DEVELOPMENT attestation is never red, never silent',
    hardware(dev).state !== 'failed' && hardware(dev).detail.includes('development build'));
  check('hardware: development attestation does not reach the production rung',
    hardware(dev).state === 'unreached');

  const envUnknown = projectTrustLadder(over({ appAttest: { present: true, valid: true, attestationEnv: null } }))!;
  // 'verified' is banned in status positions (audit B8), so this pin tracks
  // the replacement string.
  check('hardware: unknown environment stays backward compatible (reached, ban-list wording)',
    hardware(envUnknown).state === 'reached' && hardware(envUnknown).detail.includes("App Attest checked against Apple's root, offline"));
}

// --- 5. absence + the limits sentence ---------------------------------------
{
  check('absence: no manifest → no ladder at all',
    projectTrustLadder(over({ manifestFound: false, verdict: 'NO_ATTESTATION' })) === null);
  check('the limits sentence travels with the card',
    LADDER_LIMITS_SENTENCE.includes('Custody is not reality'));
}


// A void binding is absence of proof, not tamper: rung 1 unreached with the
// reason, upper rungs stay live.
{
  const l = projectTrustLadder(over({ assetHashMatches: null, bindingVoid: true }));
  const b = bytes(l!);
  check('void binding: rung 1 unreached, not failed',
    b.state === 'unreached' && !!b.detail && b.detail.includes('exclude the file from what it covers'));
  check('void binding: rungs above still evaluate',
    signer(l!).state === 'reached' && timeRung(l!).state === 'reached');
}

// "Known hand": local collection history adds detail to rung 2 at the
// unidentified floor and never promotes the rung.
{
  const hist = { priorCaptures: 5, firstSeen: '2026-03-02T10:00:00Z' };
  const l = projectTrustLadder(over({
    tier: 'unknown', rosterState: null, rosterNewsroom: null, orgChain: null, localHand: hist,
  }))!;
  check('known hand: rung 2 stays UNREACHED (local history is not vouching)',
    signer(l).state === 'unreached');
  check('known hand: detail states the count and the device-local scope',
    signer(l).detail.includes('5 exhibits') && signer(l).detail.includes('on this device'));
  check('known hand: detail still says local history is not vouching',
    signer(l).detail.includes('local history, not vouching'));

  const noHist = projectTrustLadder(over({
    tier: 'unknown', rosterState: null, rosterNewsroom: null, orgChain: null, localHand: null,
  }))!;
  check('no history: the mint-a-key caveat stands alone',
    signer(noHist).detail.includes('Anyone can make a key in a second') && !signer(noHist).detail.includes('known signer'));
}

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
