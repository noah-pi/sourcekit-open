// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * assistant.ts — the Assistant (ARCHITECTURE §6.3). A PURE function over
 * the item's computed evidence: verification result, Tier-0 IntakeReport,
 * Tier-1 signal rows (if run), custody matches, declared flags. No I/O, no
 * network, no LLM — an ordered rule list over the exact evidence the
 * dashboard already shows.
 *
 * Laws this module is built to satisfy:
 *  - L1/L7: it RESTATES computed checks — every emitted sentence carries a
 *    BasisRef (tab + card id) so a tap scrolls to its evidence. It says
 *    nothing that isn't on the dashboard.
 *  - L2: no scores, nothing fused — signals are restated one at a time.
 *  - L12: "what was not checked" is always the last paragraph, always
 *    present, even when the answer is "nothing was left undisclosed".
 *  - §1.3: no banned words in this summary position (copy.test.ts sweeps
 *    every template and every golden output).
 *
 * Determinism: same input → same output, byte for byte. Regeneration is
 * keyed on assistantInputKey (input ids + method versions); the UI memos
 * on that key, so changed evidence always regenerates the summary.
 */

import type {
  AssistantInput,
  AssistantParagraph,
  AssistantSummary,
  BasisRef,
  CachedSignalRow,
  C2paSummary,
  SignalStatus,
  ThumbnailDiff,
} from '../contracts-ext';
import type { JpegStructure } from './byteReads';
import { isVideoBytes, type DeskItem } from './deskItem';

/** Method version — stamped into the memo key, so template edits regenerate. */
export const ASSISTANT_METHOD_VERSION = 'assistant-templates/1';

/** The Signals-tab analyzer ids, same order the tab renders them. */
const TIER1_IDS = ['displaybeat', 'rolling-shutter', 'avsync', 'enf-extract'] as const;

/* ------------------------------------------------------------------ */
/* Basis refs — one per dashboard card the Assistant may point at.      */
/* The card ids match the DOM ids rendered by the tab components.       */
/* ------------------------------------------------------------------ */

const B = {
  banner: { tab: 'overview', card: 'banner' },
  trust: { tab: 'overview', card: 'trust' },
  time: { tab: 'overview', card: 'time' },
  recovery: { tab: 'overview', card: 'recovery' },
  hashes: { tab: 'overview', card: 'hashes' },
  claim: { tab: 'overview', card: 'claim' },
  actions: { tab: 'overview', card: 'c2pa-actions' },
  checks: { tab: 'overview', card: 'checks' },
  thumbnail: { tab: 'overview', card: 'thumbnail' },
  jpeg: { tab: 'overview', card: 'jpeg-structure' },
  declaredFlags: { tab: 'ai', card: 'declared-flags' },
  signal: (id: string): BasisRef => ({ tab: 'signals', card: `signal-${id}` }),
  fxClone: { tab: 'forensics', card: 'fx-clone' },
  fxNoise: { tab: 'forensics', card: 'fx-noise' },
  fxEla: { tab: 'forensics', card: 'fx-ela' },
  fxParallax: { tab: 'forensics', card: 'fx-parallax' },
  fxRephoto: { tab: 'forensics', card: 'fx-rephoto' },
} as const;

/* ------------------------------------------------------------------ */
/* The memo key — input ids + method versions.                          */
/* ------------------------------------------------------------------ */

/**
 * A stable key over everything the Assistant reads. Any change to the
 * evidence base — a re-verified verdict, a newly run signal, a shifted
 * match set, a template version bump — changes the key and regenerates.
 */
export function assistantInputKey(input: AssistantInput): string {
  const { item, trust, artifact, matches, custodyMatches } = input;
  const ir = item.intakeReport ?? null;
  const c2pa = ir?.c2paSummary ?? null;
  const c2paObserved = c2pa && !('state' in c2pa) ? c2pa : null;
  return JSON.stringify([
    ASSISTANT_METHOD_VERSION,
    item.id,
    item.kind,
    item.report?.verdict ?? null,
    item.sha256Hex ?? null,
    trust ? [trust.tier, trust.membershipState ?? null, trust.warning ?? null] : null,
    artifact ? [artifact.performed.length, artifact.notPerformed.length, artifact.ots.length] : null,
    ir
      ? [
          ir.computedAt,
          c2paObserved
            ? [c2paObserved.actions?.length ?? -1, c2paObserved.ingredients.length, c2paObserved.digitalSourceType]
            : null,
          ir.custody.recoveryMatches,
          ir.custody.exactAfterStrip,
        ]
      : null,
    (item.tier1Signals ?? []).map((r: CachedSignalRow) => [r.id, r.version, r.computedAt, r.measurement]),
    // Tier-2 ad-hoc results and the intake re-photo signals are restated
    // too, so a fresh run (or a wiped cache) must regenerate the summary.
    item.tier2Fx
      ? [
          item.tier2Fx.clone
            ? [item.tier2Fx.clone.state, item.tier2Fx.clone.computedAt,
               item.tier2Fx.clone.state === 'measured' ? item.tier2Fx.clone.clusters.length : null]
            : null,
          item.tier2Fx.noise ? [item.tier2Fx.noise.state, item.tier2Fx.noise.computedAt] : null,
          item.tier2Fx.ela ? [item.tier2Fx.ela.state, item.tier2Fx.ela.computedAt] : null,
          item.tier2Fx.parallax
            ? [item.tier2Fx.parallax.insufficient === false, item.tier2Fx.parallax.computedAt]
            : null,
        ]
      : null,
    item.rephoto
      ? [item.rephoto.banding.snrDb, item.rephoto.moire.snrDb,
         item.rephoto.blackFloor.liftEstimate, item.rephoto.gamut.hardSaturatedFraction]
      : null,
    matches.map((m) => [m.proofItemId, m.mediaItemId, m.grade, m.distance]),
    custodyMatches.map((m) => [m.mediaItemId, m.bundleItemId, m.how]),
  ]);
}

/* ------------------------------------------------------------------ */
/* Templates — sentence builders, one per evidence family, in the       */
/* fixed order: custody → identity → time → declared → measured →       */
/* leads → not-checked (last, always).                                  */
/* ------------------------------------------------------------------ */

function custodyParagraphs(input: AssistantInput): AssistantParagraph[] {
  const { item, trust, artifact, matches } = input;
  const rostered = trust?.tier === 'roster' && !trust.warning;

  if (item.kind === 'hash-claim') {
    const exact = matches.filter((m) => m.proofItemId === item.id && m.grade === 'exact');
    if (exact.length > 0) {
      return [{
        text: `${exact[0].mediaName} has the exact SHA-256 this claim commits to. The match itself is cryptographic.`,
        basis: B.recovery,
      }];
    }
    return [{
      text:
        'This is a hash-only claim — hashes and a signer fingerprint, no media and no signature, by design. ' +
        'It can only be matched exactly; re-encoded media can never match.',
      basis: B.claim,
    }];
  }

  if (item.kind === 'proof-bundle') {
    const ok = artifact && artifact.signatureValid && artifact.fingerprintMatches && artifact.payloadDigestMatches;
    return [ok
      ? {
          text:
            'Signature, signer fingerprint, and payload digest all check out — this proof bundle is internally ' +
            'consistent. Media is not included; matching it to bytes happens through recovery below.',
          basis: B.checks,
        }
      : {
          text:
            'Something in this proof bundle does not check out. Treat every claim in it as unchecked.',
          basis: B.checks,
        }];
  }

  if (item.kind === 'roster') {
    return [{
      text:
        'This is a roster file. Checking its signature and choosing to trust it happens on the Trust Roster ' +
        'surface — nothing here trusts it on your behalf.',
      basis: B.hashes,
    }];
  }

  if (item.kind === 'unknown') {
    // No digest and nothing parsed: there is genuinely nothing to restate —
    // the empty summary renders the deck's ai.assistant.empty state.
    if (!item.sha256Hex) return [];
    return [{
      text: 'This is not a checkable file type. It was hashed and listed so nothing is hidden; its SHA-256 is on the Hashes card.',
      basis: B.hashes,
    }];
  }

  // Media.
  if (!item.report) {
    return [{
      text:
        'This file was hashed but not fully checked here — the full check needs the whole file in memory, ' +
        'and this build says so rather than guessing.',
      basis: B.hashes,
    }];
  }
  switch (item.report.verdict) {
    case 'INTACT':
      return [rostered
        ? {
            text:
              'The bytes match exactly what the signing key sealed, the signature checks out, and the signer ' +
              'was on your trusted roster at the countersigned signing time. That is a custody fact; what the ' +
              'content shows is yours to judge.',
            basis: B.banner,
          }
        : {
            text:
              'The bytes match exactly what the signing key sealed, and the signature checks out. Who signed ' +
              'is not established — the signer is not on your trusted roster.',
            basis: B.banner,
          }];
    case 'CONTENT_MODIFIED':
      return [{
        text:
          'The signature checks out, but the media bytes no longer match what it sealed — the bytes changed ' +
          'after signing. Something altered this file.',
        basis: B.banner,
      }];
    case 'SIGNATURE_INVALID':
      return [{
        text:
          'The embedded credentials do not check out — they are malformed or tampered with. Treat every ' +
          'claim in this file as unchecked.',
        basis: B.banner,
      }];
    case 'NO_ATTESTATION':
      return [{
        text:
          'No credentials were found in this file. That is normal — most files today carry none, and an ' +
          'unsigned file is just an unsigned file.',
        basis: B.banner,
      }];
    case 'UNSUPPORTED':
    case 'NOT_JPEG':
    case 'NOT_BMFF':
      return [{
        text:
          'This file carries credentials in a structure this build cannot check. It is unchecked — neither ' +
          'condemned nor endorsed.',
        basis: B.banner,
      }];
    case 'UNREADABLE':
      return [{
        text: 'This file could not be read, so nothing else about it is established here.',
        basis: B.banner,
      }];
    default:
      return [];
  }
}

function identityParagraphs(input: AssistantInput): AssistantParagraph[] {
  const { trust } = input;
  // No signer, no signer story: unsigned media (trust resolves to null)
  // and NO_ATTESTATION items get no identity paragraph at all — absence of
  // a signer is not suspicion, it is simply nothing to say.
  if (!trust || input.item.kind === 'unknown' || input.item.kind === 'roster') return [];
  if (input.item.report?.verdict === 'NO_ATTESTATION') return [];
  const text =
    trust.tier === 'roster'
      ? trust.membershipState === 'unknown-time'
        ? 'The signer is on your trusted roster — but no countersigned time exists, so membership at the signing time could not be evaluated. Stated, not assumed.'
        : trust.membershipState === 'active-then-revoked'
          ? 'The signer was on your trusted roster at the countersigned signing time; the membership ended later, and captures from before the key left the roster keep their custody.'
          : trust.warning
            ? `The signer appears on a trusted roster with a flag: ${trust.warning}`
            : 'The signer is on your trusted roster.'
      : trust.tier === 'org'
        ? 'The signing key chains to an organization credential whose links check out. Whether you trust that organization is your call.'
        : trust.warning
          ? `The signer is not established, and the check raised a flag: ${trust.warning}`
          : 'The signer is not on any of your trusted rosters. Integrity can be established; who the key belongs to cannot.';
  return [{ text, basis: B.trust }];
}

function timeParagraphs(input: AssistantInput): AssistantParagraph[] {
  const { item, artifact } = input;
  const record = item.report?.record ?? item.bundle?.record ?? null;
  if (!record) return [];
  const out: AssistantParagraph[] = [{
    text: `The device clock claims capture at ${record.capturedAt} — a claim by the device, not independently confirmed.`,
    basis: B.time,
  }];
  const ts = item.report?.c2pa?.timestamps;
  if (ts && ts.present > 0) {
    out.push({
      text:
        `Authority time (RFC 3161): ${ts.valid} of ${ts.present} token${ts.present === 1 ? '' : 's'} ` +
        `cryptographically check out${ts.earliestValidUtc ? `; the earliest valid countersigned time is ${ts.earliestValidUtc}` : ''}` +
        `${ts.trusted > 0 ? `, and ${ts.trusted} come${ts.trusted === 1 ? 's' : ''} from a pinned authority` : '; none from a pinned authority, so that time stays a claim'}.`,
      basis: B.time,
    });
  }
  const ots = artifact?.ots ?? [];
  if (ots.length > 0) {
    // Deck copy decision (a): the enum value `verified` renders as
    // "checks out"; `failed` reads "inconsistent" (§5.3 warn), and the
    // offline state is plainly "not checked" — never "verified".
    const bindingWord = (b: 'verified' | 'failed' | 'unchecked'): string =>
      b === 'verified' ? 'checks out' : b === 'failed' ? 'inconsistent' : 'not checked';
    out.push({
      text:
        `Ledger time (Bitcoin): ${ots.map((o) =>
          `${o.state}${o.blockHeight !== null ? ` in block #${o.blockHeight}` : ''} via ${o.calendar} — block binding ${bindingWord(o.binding)}`,
        ).join('; ')}.`,
      basis: B.time,
    });
  }
  return out;
}

function declaredParagraphs(input: AssistantInput): AssistantParagraph[] {
  const summary: C2paSummary | SignalStatus | null = input.item.intakeReport?.c2paSummary ?? null;
  if (!summary || 'state' in summary) return [];
  const out: AssistantParagraph[] = [];
  const generator = summary.claimGenerator ?? 'the sealing software';
  if (summary.actions && summary.actions.length > 0) {
    const listed = summary.actions.slice(0, 3).map((a) => a.action).join(', ');
    out.push({
      text:
        `The sealing software (${generator}) declared ${summary.actions.length} action${summary.actions.length === 1 ? '' : 's'}: ` +
        `${listed}${summary.actions.length > 3 ? `, and ${summary.actions.length - 3} more` : ''}. These are the software's own ` +
        'declarations — a valid seal cannot show that nothing else happened.',
      basis: B.actions,
    });
  }
  if (summary.ingredients.length > 0) {
    out.push({
      text:
        `${generator} also declared ${summary.ingredients.length} ingredient${summary.ingredients.length === 1 ? '' : 's'} — ` +
        'what the file was made from, as declared.',
      basis: B.actions,
    });
  }
  if (summary.digitalSourceType) {
    out.push({
      text:
        `The sealing tool declared a digital source type: “${summary.digitalSourceType}” — a self-declaration, ` +
        'not our detection. Source Kit Desk ships no AI-content detector and never infers one.',
      basis: B.declaredFlags,
    });
  }
  return out;
}

function measuredParagraphs(input: AssistantInput): AssistantParagraph[] {
  const { item } = input;
  const out: AssistantParagraph[] = [];
  for (const row of item.tier1Signals ?? []) {
    out.push({
      text: `${row.title} (method ${row.version}): ${row.measurement}`,
      basis: B.signal(row.id),
    });
  }
  const t = item.intakeReport?.thumbnail ?? null;
  const diff: ThumbnailDiff | SignalStatus | null =
    t && 'byteLength' in t ? t.diff : null;
  if (diff && !('state' in diff) && diff.differs) {
    out.push({
      text:
        `The embedded preview differs from the current image (mean per-channel difference ${diff.meanAbsDiff} ` +
        'of 255) — a custody observation, not an accusation; the preview can predate the last edit.',
      basis: B.thumbnail,
    });
  }
  const js: JpegStructure | SignalStatus | null = item.intakeReport?.jpegStructure ?? null;
  if (js && !('state' in js) && js.quantization) {
    const q = js.quantization;
    out.push({
      text:
        `The JPEG quantization tables read as ${q.class} — the family of software that last saved this file` +
        `${q.closestQuality !== null ? `; the closest-quality figure (≈${q.closestQuality}) is an estimate, not a measurement` : ''}.`,
      basis: B.jpeg,
    });
  }
  // Tier-2 ad-hoc results — restated one at a time, each deep-linked to the
  // fx card it came from. Leads, never verdicts; nothing fuses.
  const fx = item.tier2Fx ?? null;
  if (fx?.clone) {
    const c = fx.clone;
    out.push({
      text:
        c.state === 'measured'
          ? `Clone detection at these settings found ${c.clusters.length} shared-offset cluster${c.clusters.length === 1 ? '' : 's'} ` +
            `(${c.blocksConsidered} blocks considered${c.pairsTruncated > 0 ? `; matching was truncated — ${c.pairsTruncated.toLocaleString('en-US')} candidate pairs skipped by the safety cap` : ''}) — ` +
            'a lead, not a verdict; settings and resizing hide things.'
          : `Clone detection abstained: ${c.reason} Stated, not hidden.`,
      basis: B.fxClone,
    });
  }
  if (fx?.noise) {
    const n = fx.noise;
    out.push({
      text:
        n.state === 'measured'
          ? `Noise analysis (median residual, p95 ≈ ${n.p95AbsResidual.toFixed(2)} of 255) is on the Noise card — ` +
            'oddly smooth or oddly noisy patches are leads for your eyes, never findings.'
          : `Noise analysis abstained: ${n.reason} Stated, not hidden.`,
      basis: B.fxNoise,
    });
  }
  if (fx?.ela) {
    out.push({
      text:
        `ELA at re-save quality ${fx.ela.quality} (mean difference ${fx.ela.meanAbsDiff.toFixed(2)} of 255) is on the ELA card — ` +
        'it responds to recompression history, not to honesty; a viewing aid, never evidence of manipulation.',
      basis: B.fxEla,
    });
  }
  if (fx?.parallax) {
    const p = fx.parallax;
    out.push({
      text:
        p.insufficient === false
          ? `Parallax flatness from the ring frames you provided: ${p.tracksUsed} tracks, ` +
            `${Math.round(p.inlierRatio * 100)}% consistent with one plane — the ring is an outside input you supplied, ` +
            'and a genuinely flat scene fits a plane honestly.'
          : `Parallax measurement could not run on the provided ring: ${p.insufficient} Stated, not hidden.`,
      basis: B.fxParallax,
    });
  }
  const rephoto = item.rephoto ?? null;
  if (rephoto) {
    out.push({
      text:
        `Screen re-photography signals (banding ${rephoto.banding.snrDb.toFixed(1)} dB, moiré ${rephoto.moire.snrDb.toFixed(1)} dB, ` +
        `black lift ≈ ${rephoto.blackFloor.liftEstimate.toFixed(1)}) are on the re-photo card — statistical traces a ` +
        'photo-of-a-screen often leaves, evidence for you to weigh; a photo of a screen can be entirely legitimate.',
      basis: B.fxRephoto,
    });
  }
  return out;
}

function leadParagraphs(input: AssistantInput): AssistantParagraph[] {
  const { item, matches, custodyMatches } = input;
  const out: AssistantParagraph[] = [];
  for (const m of custodyMatches) {
    if (m.mediaItemId !== item.id && m.bundleItemId !== item.id) continue;
    out.push({
      text:
        m.mediaItemId === item.id
          ? `The detached manifest in ${m.bundleName} commits to this file’s exact bytes with the manifest’s own ` +
            'bytes excluded — credentials were stripped in transit, and the custody chain is intact.'
          : `This bundle’s manifest commits to ${m.mediaName}’s exact bytes with its own bytes excluded — ` +
            'credentials were stripped in transit; custody is intact.',
      basis: B.recovery,
    });
  }
  // Exact matches already told as the custody story for hash-claims; for
  // media they are leads to proofs. Skip restating the claim's own match.
  if (item.kind !== 'hash-claim') {
    for (const m of matches) {
      if (m.proofItemId !== item.id && m.mediaItemId !== item.id) continue;
      const other = m.proofItemId === item.id ? m.mediaName : m.proofName;
      out.push({
        text:
          m.grade === 'exact'
            ? `${other} matches this item’s signed bytes exactly — SHA-256 identical, a cryptographic match.`
            : `${other} is a visual lead only (pHash distance ${m.distance}${m.viaMediaName ? ` via ${m.viaMediaName}` : ''}) — ` +
              'the file was likely re-encoded in transit and the hash binding is broken by design. Confirm visually before use.',
        basis: B.recovery,
      });
    }
  }
  return out;
}

function notCheckedParagraph(input: AssistantInput): AssistantParagraph {
  const { item, artifact } = input;
  const notPerformed = item.report?.checksNotPerformed ?? artifact?.notPerformed ?? [];
  const parts: string[] = [];
  if (notPerformed.length > 0) {
    const listed = notPerformed.slice(0, 3).join('; ');
    parts.push(`${listed}${notPerformed.length > 3 ? `; and ${notPerformed.length - 3} more on the Checks card` : ''}`);
  }
  // Tier-1 analyzers that could run but have not. Video only: on a still
  // they are not-applicable (the Signals tab says so), never "not run";
  // and without bytes in the tab they cannot run at all.
  if (item.kind === 'media' && item.bytes && item.report && isVideoBytes(item.bytes)) {
    const ran = new Set((item.tier1Signals ?? []).map((r) => r.id));
    const missing = TIER1_IDS.filter((id) => !ran.has(id));
    if (missing.length > 0) {
      parts.push(
        `${missing.length} Signals-tab analyzer${missing.length === 1 ? '' : 's'} not run — they run only when you ask`,
      );
    }
  }
  return {
    text:
      parts.length > 0
        ? `Not performed — disclosed, not hidden: ${parts.join('; ')}.`
        : 'Nothing was left undisclosed — no check applicable to this item is listed as not performed.',
    basis: B.checks,
  };
}

/* ------------------------------------------------------------------ */
/* The pure function.                                                   */
/* ------------------------------------------------------------------ */

/**
 * Restate the item's computed evidence in plain language. Deterministic;
 * the same input always produces the same paragraphs in the same order.
 * The empty summary (no paragraphs) renders the deck's ai.assistant.empty
 * state — it means there was genuinely nothing computed to restate.
 */
export function summarizeAsset(input: AssistantInput): AssistantSummary {
  const paragraphs: AssistantParagraph[] = [
    ...custodyParagraphs(input),
    ...identityParagraphs(input),
    ...timeParagraphs(input),
    ...declaredParagraphs(input),
    ...measuredParagraphs(input),
    ...leadParagraphs(input),
    notCheckedParagraph(input),
  ];
  // The not-checked paragraph is only meaningful once there is something
  // to summarize; an item with no evidence at all gets the empty state.
  if (paragraphs.length === 1) return { paragraphs: [], inputKey: assistantInputKey(input) };
  return { paragraphs, inputKey: assistantInputKey(input) };
}
