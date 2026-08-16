/**
 * Trust ladder — a pure projection of the verification
 * evidence into five named rungs:
 *
 *   bytes unchanged → known key → org-vouched → hardware-attested →
 *   time-bounded by an independent anchor
 *
 * This module is presentation logic, NOT a verdict engine: it computes
 * nothing new, it maps what verifyAsset / trustProvider / the OTS checker
 * already concluded into a fixed, always-visible shape. The mapping rules
 * are where honesty lives, so they are stated here and tested in the lab
 * (exhibit-open tests/test-ladder.mts):
 *
 * - Four states per rung. `reached` means the evidence actually verified —
 *   never "present", never "claimed". `unreached` is neutral (absence of
 *   proof is not suspicion). `failed` is reserved for proven tamper — a
 *   check that ran and came back false. `not-applicable` means the rung is
 *   structurally unavailable for this file (de-identified copies carry no
 *   attestation) or unevaluable (credentials failed, so everything above
 *   integrity is moot) — said out loud, never hidden.
 * - Integrity failure splits honestly: a broken SIGNATURE makes the
 *   credentials themselves unreliable, so every rung above is
 *   not-applicable; changed MEDIA leaves the credentials intact, so
 *   signer, attestation, and time still evaluate.
 * - Rung 3 (org-vouched) is earned only by anchors OUTSIDE the file that
 *   vouch — a signed newsroom roster or a curated trust list. A
 *   self-asserted org root names an organization without vouching for it:
 *   that is rung-2 territory with the out-of-band caveat attached.
 * - Rung 4 names the attestation environment: a genuine production
 *   attestation says "production"; a genuine DEVELOPMENT attestation is
 *   stated as a development build and leaves the rung unreached — never
 *   red (nothing failed), never silent (the fact is on the card).
 * - Rung 5 is earned only by INDEPENDENT time: a pinned-authority
 *   countersignature or a Bitcoin anchor whose block binding verified.
 *   The device clock, unpinned TSAs, and unchecked ledger bindings are
 *   unreached — each with its reason stated.
 * - The ladder never renders for files with no manifest (absence is
 *   neutral and gets its own card) — projectTrustLadder returns null.
 */

import type { VerdictCode } from '../../archive/handrolled-verifier/verifyAsset';
import type { TrustTier } from './trustProvider';

export type RungState = 'reached' | 'unreached' | 'failed' | 'not-applicable';

export type RungId = 'bytes' | 'known-key' | 'org-vouched' | 'hardware' | 'time';

/**
 * VoiceOver value vocabulary — one honest phrase per rung state, matching
 * the mapping rules above: "reached" only when evidence actually verified,
 * "not reached" neutral, "failed" reserved for proven tamper,
 * "not applicable" said out loud.
 */
export type RungStateA11yValue = 'reached' | 'not reached' | 'failed' | 'not applicable';

export const RUNG_STATE_A11Y_VALUE: Record<RungState, RungStateA11yValue> = {
  reached: 'reached',
  unreached: 'not reached',
  failed: 'failed',
  'not-applicable': 'not applicable',
};

/**
 * The rung as assistive technology speaks it. The five rungs are the app's
 * most important UI; without this they read as bare text fragments.
 */
export interface LadderRungA11y {
  /** accessibilityRole — plain text: a rung conveys state, it is not a button. */
  role: 'text';
  /** accessibilityLabel — the rung's name plus its honest detail clause. */
  label: string;
  /** accessibilityValue — the state vocabulary above. */
  value: RungStateA11yValue;
}

export interface LadderRung {
  id: RungId;
  /** Short, checkable label — the rung's name, not its status. */
  label: string;
  state: RungState;
  /**
   * One honest clause naming WHAT was compared or WHY the rung is
   * unreached/unavailable. Never a verdict word ("secure", "trusted ✓").
   */
  detail: string;
  /** VoiceOver copy for the rung row — derived, never freehand. */
  a11y: LadderRungA11y;
}

/** A rung under construction — a11y is attached by finishLadder. */
type RungDraft = Omit<LadderRung, 'a11y'>;

/** Derives the VoiceOver copy from the rung's own words — never invented. */
export function rungA11y(rung: RungDraft): LadderRungA11y {
  return {
    role: 'text',
    label: `${rung.label}. ${rung.detail}`,
    value: RUNG_STATE_A11Y_VALUE[rung.state],
  };
}

/** Attaches VoiceOver copy to every rung and computes the summary fields. */
function finishLadder(drafts: [RungDraft, RungDraft, RungDraft, RungDraft, RungDraft]): TrustLadder {
  const rungs = drafts.map((r) => ({ ...r, a11y: rungA11y(r) })) as TrustLadder['rungs'];
  let highestReached = -1;
  rungs.forEach((r, i) => { if (r.state === 'reached') highestReached = i; });
  return { rungs, highestReached, anyFailed: rungs.some((r) => r.state === 'failed') };
}

export interface TrustLadder {
  rungs: [LadderRung, LadderRung, LadderRung, LadderRung, LadderRung];
  /** Index of the highest reached rung (ringed in the UI), or -1. */
  highestReached: number;
  /** True when any rung failed — the card must read as tamper, not progress. */
  anyFailed: boolean;
}

/** Roster membership state at the verified signing time (trustProvider). */
export type LadderRosterState =
  | 'active' | 'active-then-revoked' | 'expired'
  | 'revoked' | 'not-yet-valid' | 'unknown-time';

/** Ledger-anchor state as far as THIS screen has checked it. */
export type LadderOtsState =
  | 'none' | 'pending' | 'confirmed-unchecked' | 'confirmed-verified' | 'invalid';

export interface LadderInput {
  manifestFound: boolean;
  verdict: VerdictCode;
  signatureValid: boolean | null;
  fingerprintMatches: boolean | null;
  assetHashMatches: boolean | null;

  /** External trust resolution for the signer key. */
  tier: TrustTier;
  /** Roster membership at verified signing time, when tier === 'roster'. */
  rosterState: LadderRosterState | null;
  /** Names for the detail lines — the projection quotes, never invents. */
  rosterNewsroom: string | null;
  trustListName: string | null;
  /** Org credential chain when present (multi-cert, links already judged). */
  orgChain: { linksValid: boolean; topSubject: string | null } | null;

  appAttest: {
    present: boolean;
    valid: boolean;
    /**
     * Which App Attest environment the attestation came from, when the
     * verifier could tell (aaguid). Optional and backward compatible:
     * absent means the verifier did not surface it. A genuine
     * 'development' attestation is named as such on rung 4 — never red,
     * never silent, and never dressed up as production.
     */
    attestationEnv?: 'production' | 'development' | null;
  };
  /**
   * Why rung 4 cannot apply, when it can't — 'deidentified' (fresh one-time
   * key by design) or 'assignment' (deliberately unlinkable key). Null when
   * an attestation could legitimately be expected.
   */
  hardwareNotApplicable: 'deidentified' | 'assignment' | null;

  timestamps: { present: number; valid: number; trusted: number };
  ots: LadderOtsState;
  /**
   * The manifest's hash binding is void (declared exclusions exempt the hash
   * input). Rung 1 is then UNREACHED with a precise reason — a void binding
   * is absence of proof, never proven tamper.
   */
  bindingVoid?: boolean | null;

  /**
   * Local signer history — prior exhibits in THIS device's collection by
   * the same fingerprint. Enriches rung 2's detail at the unidentified
   * floor; NEVER promotes the rung to reached — local history is not
   * vouching. The FIELD name stays `localHand` for stored-data
   * compatibility (string values only); the display term is "signer".
   */
  localHand?: { priorCaptures: number; firstSeen: string } | null;
}

export function projectTrustLadder(input: LadderInput): TrustLadder | null {
  if (!input.manifestFound) return null; // absence is neutral — its own card

  // --- Rung 1: bytes unchanged -------------------------------------------
  const credentialsFailed =
    input.signatureValid === false || input.fingerprintMatches === false;
  const mediaFailed = input.assetHashMatches === false;
  let bytes: RungDraft;
  if (credentialsFailed) {
    bytes = {
      id: 'bytes',
      label: 'Media unchanged since signing',
      state: 'failed',
      detail: 'The signature itself does not check out; the credentials were altered.',
    };
  } else if (mediaFailed) {
    bytes = {
      id: 'bytes',
      label: 'Media unchanged since signing',
      state: 'failed',
      detail: 'The credentials verify, but the media no longer matches what was signed.',
    };
  } else if (input.bindingVoid === true) {
    bytes = {
      id: 'bytes',
      label: 'Media unchanged since signing',
      state: 'unreached',
      detail: "The manifest's own exclusion rules exempt the media from the signed hash, so it proves nothing about the media.",
    };
  } else if (input.signatureValid === true && input.fingerprintMatches === true && input.assetHashMatches === true) {
    bytes = {
      id: 'bytes',
      label: 'Media unchanged since signing',
      state: 'reached',
      detail: 'Signature valid; media bit-for-bit identical to what was signed.',
    };
  } else {
    bytes = {
      id: 'bytes',
      label: 'Media unchanged since signing',
      state: 'unreached',
      detail: 'Not fully checked; verification did not complete.',
    };
  }

  // When the credentials themselves failed, nothing above can be evaluated:
  // the key, the chain, the attestation, and the tokens all arrive through
  // the same broken envelope. Marked not-applicable and said out loud.
  if (credentialsFailed) {
    const blocked = (id: RungId, label: string): RungDraft => ({
      id,
      label,
      state: 'not-applicable',
      detail: 'Cannot be evaluated: the credentials carrying it failed verification.',
    });
    return finishLadder([
      bytes,
      blocked('known-key', 'Signer identified'),
      blocked('org-vouched', 'Accessioned by an organization'),
      blocked('hardware', 'Key attested by Apple hardware'),
      blocked('time', 'Time bracketed by an independent anchor'),
    ]);
  }

  // --- Rung 2: known key ---------------------------------------------------
  let knownKey: RungDraft;
  switch (input.tier) {
    case 'this-device':
      // Recognizing our own key is NOT identification — the device telling
      // itself "this is mine" vouches for nothing. Local history is stated as
      // local history (a fact about this device's collection), never as
      // vouching. The rung stays unreached until something OUTSIDE the file
      // (org credential, roster, trust list) vouches for the signer.
      knownKey = {
        id: 'known-key', label: 'Signer identified', state: 'unreached',
        detail: input.localHand
          ? `Signed by this device's own key · seen on ${input.localHand.priorCaptures} exhibits here since ${input.localHand.firstSeen.slice(0, 10)}. Local history, not vouching.`
          : "Signed by this device's own key. Nothing outside the file vouches for the signer; anyone can mint a key in milliseconds.",
      };
      break;
    case 'roster':
      knownKey = {
        id: 'known-key', label: 'Signer identified', state: 'reached',
        detail: `Vouched for by the ${input.rosterNewsroom ?? 'newsroom'} roster.`,
      };
      break;
    case 'trust-list':
      knownKey = {
        id: 'known-key', label: 'Signer identified', state: 'reached',
        detail: `On the ${input.trustListName ?? 'curated'} trust list.`,
      };
      break;
    case 'org':
      knownKey = {
        id: 'known-key', label: 'Signer identified', state: 'reached',
        detail: `Chains to ${input.orgChain?.topSubject ?? 'an organization'}, but that root vouches for itself.`,
      };
      break;
    default:
      // Unknown is neutral: anyone can mint a key, so an unidentified key
      // says nothing in either direction. Never a failure. Local history,
      // when present, is stated as local history — a fact about this
      // device's collection, not vouching.
      knownKey = {
        id: 'known-key', label: 'Signer identified', state: 'unreached',
        detail: input.localHand
          ? `Seen on ${input.localHand.priorCaptures} exhibits on this device since ${input.localHand.firstSeen.slice(0, 10)} · local history, not vouching.`
          : 'Nothing outside the file vouches for this signer; anyone can mint a key in milliseconds.',
      };
  }

  // --- Rung 3: org-vouched -------------------------------------------------
  // Earned by outside vouching only. A self-asserted org root is rung 2 with
  // a caveat, NOT vouching. Roster timing red flags are the one failure here.
  let orgVouched: RungDraft;
  if (input.tier === 'roster' && (input.rosterState === 'revoked' || input.rosterState === 'not-yet-valid')) {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'failed',
      detail: input.rosterState === 'revoked'
        ? `Signed after this key was revoked from the ${input.rosterNewsroom ?? 'newsroom'} roster.`
        : "Signed before this key's roster membership began.",
    };
  } else if (input.tier === 'roster' && (input.rosterState === 'active' || input.rosterState === 'active-then-revoked')) {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'reached',
      detail: input.rosterState === 'active-then-revoked'
        ? `${input.rosterNewsroom ?? 'newsroom'} membership was valid at signing and revoked later; this capture predates the revocation.`
        : `${input.rosterNewsroom ?? 'newsroom'} roster membership was valid at the verified signing time.`,
    };
  } else if (input.tier === 'roster' && input.rosterState === 'expired') {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'unreached',
      detail: 'Roster membership had expired before the verified signing time.',
    };
  } else if (input.tier === 'roster' && input.rosterState === 'unknown-time') {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'unreached',
      detail: 'No pinned-authority time, so membership at signing cannot be evaluated.',
    };
  } else if (input.tier === 'trust-list') {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'reached',
      detail: `The ${input.trustListName ?? 'curated'} trust list has accessioned this signer.`,
    };
  } else if (input.tier === 'org') {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'unreached',
      detail: 'The chain names an organization, but its root vouches for itself. Confirm the CA fingerprint out of band.',
    };
  } else {
    orgVouched = {
      id: 'org-vouched', label: 'Accessioned by an organization', state: 'unreached',
      detail: input.tier === 'this-device'
        ? 'Your own key · no organization involved.'
        : 'No organization has accessioned an unidentified signer.',
    };
  }

  // --- Rung 4: hardware-attested -------------------------------------------
  let hardware: RungDraft;
  if (input.hardwareNotApplicable === 'deidentified') {
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'not-applicable',
      detail: 'Not applicable to de-identified copies: they are signed with a fresh one-time key by design.',
    };
  } else if (input.hardwareNotApplicable === 'assignment') {
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'not-applicable',
      detail: 'Not applicable to assignment keys: deliberately unlinkable.',
    };
  } else if (input.appAttest.valid && input.appAttest.attestationEnv === 'development') {
    // A genuine DEVELOPMENT attestation is not a failure (never red) and
    // must not pass silently as production: Apple vouches for genuine
    // hardware and the key, but a development build is not the shipping
    // app — the rung stays unreached with the fact stated.
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'unreached',
      detail: "Checked against Apple's root, offline · minted by a DEVELOPMENT build authenticator.",
    };
  } else if (input.appAttest.valid) {
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'reached',
      detail: input.appAttest.attestationEnv === 'production'
        ? "App Attest checked against Apple's root, offline · production environment."
        : "App Attest checked against Apple's root, offline.",
    };
  } else if (input.appAttest.present) {
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'failed',
      detail: 'An attestation is present but failed verification; a genuine one verifies offline.',
    };
  } else {
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'unreached',
      detail: "No attestation in this file; capture didn't request one or predates it.",
    };
  }

  // --- Rung 5: time-bounded --------------------------------------------------
  // Independent anchors only. A FAILED attached token is tamper evidence and
  // fails the rung; unpinned tokens and unchecked bindings are unreached
  // with their reasons stated.
  const t = input.timestamps;
  let time: RungDraft;
  if (t.present > t.valid || input.ots === 'invalid') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'failed',
      detail: input.ots === 'invalid'
        ? 'A ledger receipt failed verification.'
        : 'An attached timestamp token failed verification.',
    };
  } else if (t.trusted > 0 && input.ots === 'confirmed-verified') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'reached',
      detail: 'Pinned-authority countersign and a verified Bitcoin anchor.',
    };
  } else if (t.trusted > 0) {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'reached',
      detail: 'Countersigned by a pinned time authority.',
    };
  } else if (input.ots === 'confirmed-verified') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'reached',
      detail: 'Anchored in a Bitcoin block; binding verified.',
    };
  } else if (t.valid > 0) {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: 'The token is genuine, but its authority is not pinned; it does not anchor time.',
    };
  } else if (input.ots === 'confirmed-unchecked') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: 'Bitcoin anchor confirmed on-chain; the block binding was not checked here.',
    };
  } else if (input.ots === 'pending') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: 'Submitted to the Bitcoin calendars, awaiting confirmation. Device clock only for now.',
    };
  } else {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: 'Device clock only · no independent anchor.',
    };
  }

  return finishLadder([bytes, knownKey, orgVouched, hardware, time]);
}

/** The sentence that travels with the card in every cropped screenshot. */
export const LADDER_LIMITS_SENTENCE =
  'Custody is not reality. A person still weighs the evidence.';
