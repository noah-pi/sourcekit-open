// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Trust ladder — projects the verification evidence into four named rungs:
 *
 *   bytes unchanged → signer identified → hardware-attested →
 *   time-bounded by an independent anchor
 *
 * Presentation logic only: it computes nothing new, it maps what verifyAsset,
 * trustProvider, and the OTS checker already concluded. Mapping rules, tested
 * in tests/test-ladder.mts:
 *
 * - Four states per rung. `reached` means the evidence verified. `unreached`
 *   is neutral. `failed` means a check ran and came back false.
 *   `not-applicable` means the rung is structurally unavailable for this file
 *   (de-identified copies carry no attestation) or unevaluable.
 * - Integrity failure splits: a broken signature makes the credentials
 *   unreliable, so every rung above is not-applicable; changed media leaves
 *   the credentials intact, so signer, attestation, and time still evaluate.
 * - Rung 2 is earned only by vouching outside the file — a signed newsroom
 *   roster with timing evaluated, or a curated trust list. A self-asserted org
 *   root is unreached with the out-of-band caveat. Roster timing red flags
 *   (signed after revocation, or before membership began) are its one failure.
 * - Rung 3 names the attestation environment. A genuine development
 *   attestation is stated as such and leaves the rung unreached.
 * - Rung 4 is earned only by a pinned-authority countersignature or a Bitcoin
 *   anchor whose block binding verified. Device clock, unpinned TSAs, and
 *   unchecked ledger bindings are unreached with their reasons stated.
 * - projectTrustLadder returns null for files with no manifest; absence gets
 *   its own card.
 */

import type { VerdictCode } from '../c2pa/verifyAsset';
import type { TrustTier } from './trustProvider';

export type RungState = 'reached' | 'unreached' | 'failed' | 'not-applicable';

export type RungId = 'bytes' | 'known-key' | 'hardware' | 'time';

/** VoiceOver value vocabulary — one phrase per rung state. */
export type RungStateA11yValue = 'reached' | 'not reached' | 'failed' | 'not applicable';

export const RUNG_STATE_A11Y_VALUE: Record<RungState, RungStateA11yValue> = {
  reached: 'reached',
  unreached: 'not reached',
  failed: 'failed',
  'not-applicable': 'not applicable',
};

/** The rung as assistive technology speaks it. */
export interface LadderRungA11y {
  /** accessibilityRole — plain text; a rung is not a button. */
  role: 'text';
  /** accessibilityLabel — the rung's name plus its detail clause. */
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
   * One clause naming what was compared, or why the rung is unreached or
   * unavailable. Not a verdict word.
   */
  detail: string;
  /** VoiceOver copy for the rung row, derived from label and detail. */
  a11y: LadderRungA11y;
}

/** A rung under construction — a11y is attached by finishLadder. */
type RungDraft = Omit<LadderRung, 'a11y'>;

/** Derives the VoiceOver copy from the rung's own label and detail. */
export function rungA11y(rung: RungDraft): LadderRungA11y {
  return {
    role: 'text',
    label: `${rung.label}. ${rung.detail}`,
    value: RUNG_STATE_A11Y_VALUE[rung.state],
  };
}

/** Attaches VoiceOver copy to every rung and computes the summary fields. */
function finishLadder(drafts: [RungDraft, RungDraft, RungDraft, RungDraft]): TrustLadder {
  const rungs = drafts.map((r) => ({ ...r, a11y: rungA11y(r) })) as TrustLadder['rungs'];
  let highestReached = -1;
  rungs.forEach((r, i) => { if (r.state === 'reached') highestReached = i; });
  return { rungs, highestReached, anyFailed: rungs.some((r) => r.state === 'failed') };
}

export interface TrustLadder {
  rungs: [LadderRung, LadderRung, LadderRung, LadderRung];
  /** Index of the highest reached rung (ringed in the UI), or -1. */
  highestReached: number;
  /** True when any rung failed; the card then reads as tamper, not progress. */
  anyFailed: boolean;
}

/** Roster membership state at the verified signing time (trustProvider). */
export type LadderRosterState =
  | 'active' | 'active-then-revoked' | 'expired'
  | 'revoked' | 'not-yet-valid' | 'unknown-time';

/** Ledger-anchor state as far as this screen has checked it. */
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
  /** Names quoted into the detail lines. */
  rosterNewsroom: string | null;
  trustListName: string | null;
  /** Org credential chain when present (multi-cert, links already judged). */
  orgChain: { linksValid: boolean; topSubject: string | null } | null;

  appAttest: {
    present: boolean;
    valid: boolean;
    /**
     * App Attest environment from the aaguid, when the verifier could tell;
     * absent means it did not surface one. A genuine 'development'
     * attestation is named as such on rung 3 and leaves it unreached.
     */
    attestationEnv?: 'production' | 'development' | null;
  };
  /**
   * Why rung 3 cannot apply: 'deidentified' (fresh one-time key). Null when an
   * attestation could be expected.
   */
  hardwareNotApplicable: 'deidentified' | null;

  timestamps: {
    present: number;
    valid: number;
    trusted: number;
    /**
     * Tokens the verifier could not evaluate (parse/coverage gap); absent
     * means zero. Disclosed on the rung but never failing it.
     */
    unchecked?: number;
  };
  ots: LadderOtsState;
  /**
   * The manifest's hash binding is void: declared exclusions exempt the hash
   * input. Rung 1 is then unreached with the reason stated, not failed.
   */
  bindingVoid?: boolean | null;

  /**
   * Prior exhibits in this device's collection by the same fingerprint. Only
   * enriches rung 2's detail at the unidentified floor; it never promotes the
   * rung. Field name is `localHand` for stored-data compatibility; the display
   * term is "signer".
   */
  localHand?: { priorCaptures: number; firstSeen: string } | null;
}

export function projectTrustLadder(input: LadderInput): TrustLadder | null {
  if (!input.manifestFound) return null; // no manifest: absence gets its own card

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

  // Credentials failed: the key, chain, attestation, and tokens all arrive
  // through the same broken envelope, so every rung above is not-applicable.
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
      blocked('hardware', 'Key attested by Apple hardware'),
      blocked('time', 'Time bracketed by an independent anchor'),
    ]);
  }

  // --- Rung 2: signer identified -------------------------------------------
  // Only vouching outside the file identifies a signer: a roster with timing
  // evaluated, or a curated trust list. A self-asserted org root does not.
  // Roster timing red flags are the rung's one failure.
  let knownKey: RungDraft;
  if (input.tier === 'roster' && (input.rosterState === 'revoked' || input.rosterState === 'not-yet-valid')) {
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'failed',
      detail: input.rosterState === 'revoked'
        ? `Signed after this key was revoked from the ${input.rosterNewsroom ?? 'newsroom'} roster.`
        : "Signed before this key's roster membership began.",
    };
  } else if (input.tier === 'roster' && (input.rosterState === 'active' || input.rosterState === 'active-then-revoked')) {
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'reached',
      detail: input.rosterState === 'active-then-revoked'
        ? `Vouched for by the ${input.rosterNewsroom ?? 'newsroom'} roster — membership was valid at signing and revoked later; this capture predates the revocation.`
        : `Vouched for by the ${input.rosterNewsroom ?? 'newsroom'} roster — membership valid at the verified signing time.`,
    };
  } else if (input.tier === 'roster' && input.rosterState === 'expired') {
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'unreached',
      detail: `On the ${input.rosterNewsroom ?? 'newsroom'} roster, but membership had expired before the verified signing time.`,
    };
  } else if (input.tier === 'roster' && input.rosterState === 'unknown-time') {
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'unreached',
      detail: `On the ${input.rosterNewsroom ?? 'newsroom'} roster, but with no pinned-authority time, membership at signing cannot be evaluated.`,
    };
  } else if (input.tier === 'trust-list') {
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'reached',
      detail: `Accessioned by the ${input.trustListName ?? 'curated'} trust list.`,
    };
  } else if (input.tier === 'org') {
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'unreached',
      detail: `The chain names ${input.orgChain?.topSubject ?? 'an organization'}, but that root vouches for itself — a self-named organization identifies no one. Confirm the CA fingerprint out of band.`,
    };
  } else if (input.tier === 'this-device') {
    // Recognizing this device's own key is not identification; local history
    // is stated as local history.
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'unreached',
      detail: input.localHand
        ? `Signed by this device's own key · seen on ${input.localHand.priorCaptures} exhibits here since ${input.localHand.firstSeen.slice(0, 10)}. Local history, not vouching.`
        : "Signed by this device's own key. Nothing outside the file vouches for the signer; anyone can mint a key in milliseconds.",
    };
  } else {
    // Unknown is neutral, never a failure. Local history, when present, is
    // stated as local history.
    knownKey = {
      id: 'known-key', label: 'Signer identified', state: 'unreached',
      detail: input.localHand
        ? `Seen on ${input.localHand.priorCaptures} exhibits on this device since ${input.localHand.firstSeen.slice(0, 10)} · local history, not vouching.`
        : 'Nothing outside the file vouches for this signer; anyone can mint a key in milliseconds.',
    };
  }

  // --- Rung 3: hardware-attested -------------------------------------------
  let hardware: RungDraft;
  if (input.hardwareNotApplicable === 'deidentified') {
    hardware = {
      id: 'hardware', label: 'Key attested by Apple hardware', state: 'not-applicable',
      detail: 'Not applicable to de-identified copies: they are signed with a fresh one-time key by design.',
    };
  } else if (input.appAttest.valid && input.appAttest.attestationEnv === 'development') {
    // A genuine development attestation is not a failure and is not
    // production, so the rung stays unreached with the fact stated.
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

  // --- Rung 4: time-bounded --------------------------------------------------
  // Independent anchors only. A failed attached token fails the rung; unpinned
  // tokens and unchecked bindings are unreached with their reasons stated.
  // Tokens the verifier could not evaluate are disclosed but never fail it.
  const t = input.timestamps;
  const uncheckedTokens = t.unchecked ?? 0;
  const checkedFailures = t.present - t.valid - uncheckedTokens;
  const uncheckedNote = uncheckedTokens > 0
    ? ` ${uncheckedTokens} attached token(s) could not be evaluated by this verifier; that is not counted against the file.`
    : '';
  let time: RungDraft;
  if (checkedFailures > 0 || input.ots === 'invalid') {
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
      detail: 'The token is genuine, but its authority is not pinned; it does not anchor time.' + uncheckedNote,
    };
  } else if (input.ots === 'confirmed-unchecked') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: 'Bitcoin anchor confirmed on-chain; the block binding was not checked here.' + uncheckedNote,
    };
  } else if (input.ots === 'pending') {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: 'Submitted to the Bitcoin calendars, awaiting confirmation. Device clock only for now.' + uncheckedNote,
    };
  } else {
    time = {
      id: 'time', label: 'Time bracketed by an independent anchor', state: 'unreached',
      detail: (uncheckedTokens > 0
        ? `${uncheckedTokens} attached timestamp token(s) could not be evaluated by this verifier; device clock only until an anchor verifies.`
        : 'Device clock only · no independent anchor.'),
    };
  }

  return finishLadder([bytes, knownKey, hardware, time]);
}

/** The sentence rendered under the card, including in screenshots. */
export const LADDER_LIMITS_SENTENCE =
  'Custody is not reality. Judgment stays with the reader.';
