// Source Kit 0.1.0 — the label grammar: a record and a report into the words the screens state
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Turning a record and a verification report into the four things the
 * detail screens state.
 *
 * This is the only place the grammar is decided, so Inspect and an exhibit
 * cannot drift into describing the same file differently. Every value here
 * is a fact plus who established it, and the establisher is either a
 * nameable party or the standing phrase for nobody.
 *
 * Two rules the functions below keep:
 *
 *   Absence is not failure. A file with no seal, no anchor, or no
 *   countersignature says so in the neutral register. Only bytes that
 *   contradict a signature covering them are 'altered'.
 *
 *   Nothing is inferred from silence. An unattested app is reported as
 *   unattested, never as suspicious; an unrecognized authority is reported
 *   as unrecognized, never as invalid.
 */

import type { AttestationRecord } from '../../provenance/manifest';
import type { SealState, TimeState, PlaceState, SignerIdentityState, TimeCheck, LabelRow, LabelState, StripItem, StripState } from './DetailBody';
import type { Tone } from './DetailKit';
import type { ForeignFacts } from '../../reader/foreign';
import { wmmDeclination } from '../../reader/verify/geomag';
import { DEVICE_REPORTED } from './words';

/** The shape of the report fields this module reads. Deliberately narrow:
 *  a wider type would invite reaching for values that mean something else. */
export interface ReportView {
  c2pa?: {
    appAttest: { present: boolean; valid: boolean; reason?: string | null };
    assetHashFailure?: string | null;
    alg?: string | null;
    signerFingerprint?: string | null;
    timestamps?: { present: number; valid: number; trusted: number; earliestTrustedUtc?: string | null; earliestValidUtc?: string | null; tsaNames?: string[]; trustedNames?: string[] } | null;
    certChain?: { linksValid: boolean; checked?: boolean } | null;
  } | null;
  /** Whether the signature verifies over the bytes that were read. */
  signatureValid?: boolean | null;
  checks?: { recomputedSha256?: string | null } | null;
}

/** How the signer is described when something outside the file vouches. */
export interface SignerView {
  tier: string;
  org?: { subject?: string | null } | null;
  roster?: { roster: { newsroom: string } } | null;
}



export function deriveSeal(
  record: AttestationRecord | null,
  report: ReportView | null,
  signer: SignerView | null,
  /** What the manifest says when there is no record: any other signer's file. */
  foreign: ForeignFacts | null = null,
): SealState {
  if (!record && foreign) {
    // A foreign manifest names its maker and carries a signature over the
    // bytes, and that is all this device can establish from it. Custody and
    // app integrity rest on an attestation this verifier can check, and no
    // other signer's file carries one it can.
    const media: SealState['media'] =
      report?.c2pa?.assetHashFailure || report?.signatureValid === false ? 'altered' : 'intact';
    return {
      device: foreign.generator ?? 'Unnamed software',
      key: { value: 'Not established' },
      app: { value: 'Not attested' },
      establishedBy: 'No attestation this device can check',
      media,
      signer: null,
      attestation: 'none',
      reason: null,
      signedDigest: foreign.signedDigestHex,
      fileDigest: report?.checks?.recomputedSha256 ?? null,
      alg: report?.c2pa?.alg ?? null,
      keyFingerprint: report?.c2pa?.signerFingerprint ?? null,
    };
  }
  if (!record) {
    return {
      device: 'No seal in this file',
      key: { value: 'None' },
      app: { value: 'None' },
      establishedBy: DEVICE_REPORTED,
      media: 'unsigned',
      signer: null,
      attestation: 'none',
      reason: null,
      signedDigest: null,
      fileDigest: report?.checks?.recomputedSha256 ?? null,
      alg: null,
      keyFingerprint: null,
    };
  }

  const maker = `${record.app.name} on ${record.device.model ?? record.device.platform}`;

  /**
   * Custody and integrity both come from the attestation, because from a
   * FILE that is the only thing that establishes either.
   *
   * The capture path attaches an App Attest assertion only when the active
   * signer is `secure-enclave-attested` (src/provenance/attest.ts), so a
   * verified attestation proves the key is Enclave-resident. Nothing else in
   * a record does: biometricBound is about a Face ID gate, and a device
   * saying "my key is in hardware" is a device grading itself.
   *
   * So an attestation that does not verify takes the custody claim down with
   * it. Saying "held in hardware" on the strength of an assertion this
   * device just refused would be repeating a claim we declined to believe.
   */
  const attested = report?.c2pa?.appAttest;
  const proven = !!attested?.present && attested.valid;
  const key = { value: proven ? 'Held in hardware' : 'Not established' };
  const app = {
    value: attested?.present ? (attested.valid ? 'Attested' : 'Attestation did not verify') : 'Not attested',
  };
  const establishedBy = proven
    ? 'Both proven by Apple App Attest'
    : attested?.present
      ? attested.reason ?? 'Checked against Apple’s root and refused'
      : DEVICE_REPORTED;

  const media: SealState['media'] =
    report?.c2pa?.assetHashFailure || report?.signatureValid === false ? 'altered' : 'intact';

  let vouched: string | null = null;
  if (signer?.tier === 'org' && signer.org?.subject) vouched = signer.org.subject;
  else if (signer?.tier === 'roster' && signer.roster) vouched = signer.roster.roster.newsroom;
  else if (record.orgCredential?.subject) vouched = record.orgCredential.subject;

  return {
    device: maker,
    key,
    app,
    establishedBy,
    media,
    signer: vouched,
    attestation: proven ? 'proven' : attested?.present ? 'refused' : 'none',
    reason: attested?.present && !attested.valid ? attested.reason ?? null : null,
    signedDigest: record.asset.sha256,
    fileDigest: report?.checks?.recomputedSha256 ?? null,
    alg: record.signer.alg,
    keyFingerprint: record.signer.fingerprint,
  };
}

/**
 * The two bounds, and which mechanism produces which.
 *
 * Both ends can be a Bitcoin block, from opposite directions, and confusing
 * them is easy:
 *
 *   LOWER (not before) — the BEACON. The device fetched a recent block hash
 *   and committed it INSIDE the record before signing. A block hash cannot
 *   be known before the block exists, so the seal came after it.
 *
 *   UPPER (not after) — the OTS receipt and the RFC 3161 countersignature.
 *   OpenTimestamps puts the payload digest into a LATER block, which bounds
 *   the digest's existence to no later than that block (src/lib/ots.ts). A
 *   timestamp authority signs over the digest at a known moment and bounds
 *   it far more tightly.
 *
 * An end with no anchor stays open rather than being filled with the
 * device's own claim.
 */
export function deriveTime(
  record: AttestationRecord | null,
  report: ReportView | null,
  /** The OpenTimestamps view, once this device has checked the receipt. */
  ots?: { state: string; height?: number } | null,
  foreign: ForeignFacts | null = null,
): TimeState {
  // A foreign file has no device clock in the record's sense; the nearest
  // thing is the time its created action declares, which is the same kind
  // of claim: the signer's own clock, stated.
  const declared = record?.capturedAt ?? foreign?.createdAt ?? null;
  const signedAt = declared ? fmt(declared) : 'Not stated in the file';
  const checks: TimeCheck[] = [];
  let authority: TimeState['authority'] = null;
  let ledger: TimeState['ledger'] = null;

  // An authority signs over the digest within seconds of the capture, so it
  // is the tightest bound available and is named first.
  const ts = report?.c2pa?.timestamps ?? null;
  if (ts && ts.trusted > 0 && ts.earliestTrustedUtc) {
    // The pinned list's display name, not the certificate's common name:
    // "FreeTSA" rather than "www.freetsa.org".
    authority = { name: ts.trustedNames?.[0] ?? ts.tsaNames?.[0] ?? null, trusted: true, at: ts.earliestTrustedUtc };
    checks.push({
      name: 'Timestamp authority',
      detail: `Sealed before ${fmt(ts.earliestTrustedUtc)}, to the minute`,
      met: true,
    });
  } else if (ts && ts.valid > 0) {
    // A real countersignature from an authority on no list this device
    // carries. Named, so a reader can judge the name; not counted as an
    // anchor, because any authority can mint any time.
    const who = ts.tsaNames?.[0] ?? 'an authority';
    authority = { name: ts.tsaNames?.[0] ?? null, trusted: false, at: ts.earliestValidUtc ?? null };
    checks.push({
      name: 'Timestamp authority',
      detail: `Countersigned by ${who}, not on a trust list this device carries`,
      met: false,
    });
  }

  // Bitcoin is ONE check with two ends. The beacon block was already mined
  // when the shutter fired and its hash is sealed inside the record, so the
  // capture came after it. The OpenTimestamps receipt puts the capture's own
  // hash into a later block, so the capture came before that one. Splitting
  // these into two rows asks a reader to hold two opposite ideas about the
  // same ledger.
  const beacon = record?.beacon ?? null;
  const anchored = ots?.state === 'confirmed' && typeof ots.height === 'number' ? ots.height : null;
  const h = (n: number) => n.toLocaleString('en-US');
  if (beacon || anchored || record?.ots) {
    ledger = { beaconHeight: beacon?.blockHeight ?? null, anchoredHeight: anchored, pending: !anchored && !!record?.ots };
  }
  if (beacon && anchored) {
    checks.push({
      name: 'Bitcoin ledger',
      detail: `Sealed between blocks ${h(beacon.blockHeight)} and ${h(anchored)}`,
      met: true,
    });
  } else if (anchored) {
    checks.push({ name: 'Bitcoin ledger', detail: `Sealed before block ${h(anchored)}`, met: true });
  } else if (beacon) {
    checks.push({ name: 'Bitcoin ledger', detail: `Sealed after block ${h(beacon.blockHeight)}`, met: true });
  } else if (record?.ots) {
    checks.push({ name: 'Bitcoin ledger', detail: 'Submitted, not yet in a block', met: false });
  }

  if (checks.length === 0) {
    checks.push({
      name: 'No countersignature',
      detail: 'Nothing outside the phone confirms this time',
      met: false,
    });
  }

  const anyMet = checks.some((c) => c.met);
  return { signedAt, signedAtIso: declared, checks, tag: anyMet ? 'Countersigned' : 'Device reported', established: anyMet, authority, ledger };
}

/**
 * The label: five questions a reader asks, in the order they ask them.
 *
 * Each row is the question, the answer set large, one line under it, and
 * one word naming who says so. The word is the whole epistemics of the row.
 * A green word is a party outside the phone. A gray word is the phone, or
 * the software, alone. Amber is the one claim on the label that could
 * mislead if taken at face value, and red is bytes that contradict the
 * signature. A row with no word is a thing to look at, not a claim.
 *
 * A file never shows an accusing empty state: a question the file cannot
 * answer is absent, and a file with no seal has one row.
 */
export function deriveLabel(input: {
  record: AttestationRecord | null;
  foreign: ForeignFacts | null;
  seal: SealState;
  time: TimeState;
  place: PlaceState;
  identity: SignerIdentityState;
  edits: { by: string | null; list: string[] } | null;
}): LabelState {
  const { record, foreign, seal, time, place, identity, edits } = input;
  const altered = seal.media === 'altered';
  const unsigned = seal.media === 'unsigned';
  const rows: LabelRow[] = [];

  // Who is named on the seal row. Apple when the attestation proved the key
  // and the app; the signer's organization when a foreign chain reaches a
  // published root; this device when the only party checking is this one.
  const foreignName = foreign?.signer ? (foreign.signer.org ?? foreign.signer.name) : null;
  const sealWord: { word: string; tone: Tone | 'none' } = altered
    ? { word: 'This device', tone: 'broken' }
    : unsigned
      ? { word: '', tone: 'none' }
      : seal.attestation === 'proven'
        ? { word: 'Apple', tone: 'established' }
        : seal.attestation === 'refused'
          ? { word: 'This device', tone: 'attention' }
          : foreignName && identity.tag === 'Certified'
            ? { word: shortOrg(foreignName), tone: 'established' }
            : { word: 'This device', tone: 'neutral' };
  const sealCaption = altered
    ? `The file differs from what was signed.${seal.attestation === 'proven' ? ' Key in hardware, app attested.' : ''}`
    : unsigned
      ? 'No seal in this file'
      : seal.attestation === 'proven'
        ? 'Identical to what was signed. Key in hardware, app attested.'
        : seal.attestation === 'refused'
          ? 'Identical to what was signed. Attestation did not verify.'
          : foreign
            ? edits
              ? 'Identical to what was signed. Signed on export, whatever the file was before.'
              : 'Identical to what was signed. No attestation this device can check.'
            : 'Identical to what was signed. Not attested.';
  // Declared edits lead, because they change how every row under them is
  // read. Declared by the editor; an undeclared edit leaves no trace here.
  if (edits && !unsigned) {
    rows.push({
      id: 'edits',
      question: 'What was done to it?',
      answer: edits.list.join(', '),
      caption: `${edits.by ? `Declared by ${edits.by}.` : 'Declared in the file.'} Undeclared edits leave no trace here.`,
      word: 'Declared',
      tone: 'attention',
    });
  }
  rows.push({
    id: 'seal',
    question: 'Changed since it was sealed?',
    answer: altered ? 'Yes' : unsigned ? 'Nothing to check' : 'No',
    caption: sealCaption,
    ...sealWord,
  });

  if (!unsigned) {
    // Time. When an authority countersigned, its time is the answer, so the
    // green word vouches for the number a reader remembers; the phone's
    // clock moves to the caption. An authority on no list is named and
    // marked unlisted in words, never by color alone.
    const a = time.authority;
    const l = time.ledger;
    const trustedAt = a?.trusted && a.at ? a.at : null;
    const countersignedAt = a?.at ?? null;
    const bits: string[] = [];
    if (trustedAt) bits.push('countersigned to the minute');
    else if (countersignedAt) bits.push('countersigned to the minute by an authority on no list this device carries');
    if (l?.beaconHeight) bits.push(`after block ${l.beaconHeight.toLocaleString('en-US')}`);
    if (l?.anchoredHeight) bits.push(`before block ${l.anchoredHeight.toLocaleString('en-US')}`);
    if (countersignedAt && time.signedAtIso) bits.push(`${record ? 'phone clock' : 'declared'} ${fmtClock(time.signedAtIso)}`);
    if (foreign && edits) bits.push('the export, not a capture');
    const timeCaption = bits.length > 0
      ? cap(bits.join(' · '))
      : foreign
        ? 'Declared by the signer · nothing outside it confirms the time'
        : 'Phone clock only · nothing outside the phone confirms the time';
    const words: string[] = [];
    if (a) words.push((a.name ? shortOrg(a.name) : 'Authority') + (a.trusted ? '' : ' · unlisted'));
    if (l && (l.beaconHeight || l.anchoredHeight)) words.push('Bitcoin');
    const anchoredLedger = !!(l && (l.beaconHeight || l.anchoredHeight));
    rows.push({
      id: 'time',
      question: altered ? 'When was the original sealed?' : foreign && edits ? 'When was it made?' : 'When was it taken?',
      answer: countersignedAt ? fmtLong(countersignedAt) : time.signedAt,
      caption: timeCaption,
      word: words.length > 0 ? words.join(' · ') : foreign ? 'Signer' : 'Device-reported',
      tone: words.length > 0 ? (a?.trusted || anchoredLedger ? 'established' : 'neutral') : 'neutral',
    });

    if (place.coords || place.placeName) {
      const c = place.compass;
      const parts: string[] = [];
      if (place.placeName && place.coords) parts.push(place.coords);
      if (place.accuracy) parts.push(place.accuracy);
      if (c) parts.push(`compass ${c.sealed}, ${c.detail.replace(' expected declination', ' expected')}`);
      if (foreign && !c) parts.push('declared by the software · nothing to check it against');
      rows.push({
        id: 'place',
        question: 'Where was it taken?',
        answer: place.placeName ?? (place.coords as string),
        mono: !place.placeName,
        caption: parts.join(' · '),
        word: c && !c.agrees ? 'Inconsistent' : foreign ? 'Software' : 'Device-reported',
        tone: c && !c.agrees ? 'attention' : 'neutral',
        link: place.mapsUrl ? { label: 'Open in Maps', url: place.mapsUrl } : undefined,
      });
    }

    // Anonymous is two events: no name was attached, or a name was taken
    // out of this copy. The word says which. Certified is an organization's
    // certificate on a trust list; Verified is a person an authority checked.
    const who = identity.tag === 'Anonymous'
      ? { word: identity.name === 'Removed' ? 'Redacted' : 'Not provided', tone: 'neutral' as const }
      : identity.tag === 'Unverified'
        ? { word: 'Self reported', tone: 'attention' as const }
        : identity.tag === 'Domain verified'
          ? { word: 'Domain verified', tone: 'established' as const }
          : identity.tag === 'Verified'
            ? { word: 'Verified', tone: 'established' as const }
            : identity.tag === 'Certified'
              ? { word: 'Certified', tone: 'established' as const }
              : { word: 'Certificate', tone: 'neutral' as const };
    rows.push({
      id: 'who',
      question: 'Who sealed it?',
      answer: identity.name,
      caption: identity.by ?? (foreignName ? 'The certificate names the maker, not a person' : ''),
      ...who,
    });
  }

  return {
    strip: deriveStrip({ seal, time, identity, foreign, edits }),
    rows,
    unsigned,
    notice: altered ? 'The rows below describe the original.' : null,
  };
}

/**
 * The strip on the picture: the maker on the left, and stamps of one kind
 * on the right. A stamp is a state of the file, never a vendor. A foreign
 * file has fewer stamps; a file with no seal has no strip.
 */
export function deriveStrip(input: {
  seal: SealState;
  time: TimeState;
  identity: SignerIdentityState;
  foreign: ForeignFacts | null;
  edits: { by: string | null; list: string[] } | null;
}): StripState | null {
  const { seal, time, identity, foreign } = input;
  if (seal.media === 'unsigned') return null;
  const altered = seal.media === 'altered';
  // The app alone on the strip; the device is on the seal sheet. One line
  // has room for a name and four stamps, not for a name, a device and four.
  const maker = foreign ? makerName(foreign.generator) : seal.device.replace(/ on .*$/, '');
  const stamps: StripItem[] = [];
  stamps.push(altered ? { label: 'Changed', tone: 'broken' } : { label: 'Sealed', tone: 'established' });
  if (seal.attestation === 'proven') stamps.push({ label: 'Attested', tone: 'established' });
  else if (identity.tag === 'Certified') stamps.push({ label: 'Certified', tone: 'established' });
  if (time.authority?.trusted) stamps.push({ label: 'Countersigned', tone: 'established' });
  if (time.ledger && (time.ledger.beaconHeight || time.ledger.anchoredHeight)) stamps.push({ label: 'Anchored', tone: 'established' });
  return { maker, stamps };
}

function fmtLong(iso: string): string {
  return fmt(iso);
}

/**
 * The generator as a name for the strip: the part before any version, with
 * underscores as spaces. "make_test_images 0.16.1 c2pa-rs/0.16.1" becomes
 * "make test images"; "Truepic_Lens_SDK_libc2pa 2.5.1" becomes "Truepic
 * Lens SDK libc2pa". The full string stays on the seal sheet.
 */
function makerName(generator: string | null): string {
  if (!generator) return 'Unnamed software';
  const head = generator.split(/\s+\d/)[0] ?? generator;
  return head.replace(/[_]+/g, ' ').trim() || generator;
}

/** "DigiCert Trusted G4 TimeStamping…" → "DigiCert"; "Google LLC" → "Google". */
function shortOrg(name: string): string {
  const first = name.trim().split(/[\s(,]/)[0] ?? name;
  return first.replace(/[.,]+$/, '') || name;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fmtClock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * Where the file says it was, and the one check available on it.
 *
 * The compass row is not a compass reading. `context.declinationDeg` is
 * trueHeading minus magHeading, which is the geomagnetic model IOS ITSELF
 * applied — the magnetometer's own error cancels in the subtraction
 * (src/sensors/context.ts). So comparing it against WMM2025 at the sealed
 * coordinate sets one model against another, and a disagreement means the
 * coordinate does not match where the device thought it was.
 *
 * That is why this one is allowed to flag. The threshold is a full degree:
 * WMM's own uncertainty is around half of one, and declination moves by
 * roughly a degree per hundred kilometres in mid-latitudes, so a degree of
 * disagreement is a coordinate moved far enough to matter.
 */
const DECLINATION_TOLERANCE_DEG = 1.0;

export function derivePlace(record: AttestationRecord | null, foreign: ForeignFacts | null = null): PlaceState {
  if (!record && foreign?.location) {
    // Declared by the software in c2pa.metadata. No accuracy, no compass:
    // the file carries a coordinate and nothing to check it against.
    const { lat, lon } = foreign.location;
    return {
      coords: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      accuracy: null,
      mapsUrl: `https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent('Declared location')}`,
      placeName: null,
      compass: null,
    };
  }
  const ctx = record?.context;
  const loc = ctx?.location;
  const hasLoc = !!loc && typeof loc === 'object';

  let compass: PlaceState['compass'] = null;
  const sealedDecl = ctx?.declinationDeg;
  if (typeof sealedDecl === 'number' && hasLoc && record?.capturedAt) {
    const at = new Date(record.capturedAt);
    const expected = isNaN(at.getTime()) ? null : wmmDeclination(loc.lat, loc.lon, at);
    if (expected != null) {
      const delta = Math.abs(sealedDecl - expected);
      const f = (d: number) => `${Math.abs(d).toFixed(1)}°${d >= 0 ? ' E' : ' W'}`;
      compass = {
        sealed: f(sealedDecl),
        detail: `${f(expected)} expected declination · Δ ${delta.toFixed(1)}°`,
        agrees: delta <= DECLINATION_TOLERANCE_DEG,
      };
    } else {
      const f = (d: number) => `${Math.abs(d).toFixed(1)}°${d >= 0 ? ' E' : ' W'}`;
      compass = { sealed: f(sealedDecl), detail: 'No model available for that place and date', agrees: true };
    }
  }

  return {
    coords: hasLoc ? `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}` : null,
    accuracy: hasLoc && typeof loc.accuracyM === 'number' ? `± ${Math.round(loc.accuracyM)} m` : null,
    mapsUrl: hasLoc ? `https://maps.apple.com/?ll=${loc.lat},${loc.lon}&q=${encodeURIComponent('Sealed location')}` : null,
    /** Some writers name a place instead of, or as well as, a coordinate. */
    placeName: null,
    compass,
  };
}

/**
 * Who the file says made it, and what stands behind the name.
 *
 * Five states, because they are five different facts. A name nobody checked
 * and a name a certificate authority checked are not the same claim, and
 * "no name was ever attached" is not the same event as "a name was removed".
 */
export function deriveSignerIdentity(
  record: AttestationRecord | null,
  site: { domain: string } | null,
  foreign: ForeignFacts | null = null,
  report: ReportView | null = null,
): SignerIdentityState {
  if (!record && foreign?.signer) {
    // The signing certificate names a subject. The verifier checks the
    // chain's links; the published trust lists say whether its root is one
    // anybody vouches for. Both together earn the plain word. Either alone
    // leaves the name a certificate's claim, and the tag says so.
    // The organization is the name a reader knows; a common name is often
    // a product string ("Truepic Lens SDK v1.1.3 in Vision Camera"), and
    // that belongs on the sheet, under Organization's opposite: Subject.
    const c = foreign.signer;
    const name = c.org ?? c.name ?? 'Named in the certificate';
    const org = c.name && c.name !== name ? c.name : null;
    if (c.chainLength <= 1) {
      return { tag: 'Unverified', tone: 'attention', name, by: 'Self-signed certificate', org, domain: null };
    }
    const issuer = c.issuer ?? c.issuerOrg;
    const linksHold = report?.c2pa?.certChain?.linksValid === true;
    if (c.anchor && linksHold) {
      return {
        tag: 'Certified',
        tone: 'established',
        name,
        by: `${issuer ? `Issued by ${issuer}, ` : ''}chains to ${c.anchor.name} on the C2PA trust list`,
        org,
        domain: null,
      };
    }
    return {
      tag: 'Certificate',
      tone: 'neutral',
      name,
      by: issuer ? `Issued by ${issuer}, not on a trust list this device carries` : 'Issued by an unnamed authority',
      org,
      domain: null,
    };
  }
  if (!record) return { tag: 'Anonymous', tone: 'neutral', name: 'Signer unknown', by: null, domain: null };

  // 'redacted' is what anonymous mode writes, whether or not a name ever
  // existed, so on its own it means the signer attached none. Only a copy
  // that was de-identified afterwards had something taken out, and the
  // record says so separately.
  if (record.identity === 'redacted') {
    return record.deidentified
      ? { tag: 'Anonymous', tone: 'neutral', name: 'Removed', by: 'Name taken out of this copy before sharing', domain: null }
      : { tag: 'Anonymous', tone: 'neutral', name: 'Signer unknown', by: 'No name attached', domain: null };
  }

  const name = record.identity?.author ?? null;
  const org = record.identity?.organization ?? record.orgCredential?.subject ?? null;

  if (!name && !org) {
    return { tag: 'Anonymous', tone: 'neutral', name: 'Signer unknown', by: 'No name attached', domain: null };
  }

  // A certificate names an issuer that checked somebody. That is the only
  // route in this app that earns the plain word.
  const issuer = record.orgCredential?.issuer ?? null;
  if (issuer) {
    return {
      tag: 'Verified',
      tone: 'established',
      name: name ?? org ?? 'Named in the certificate',
      by: `${issuer} issued the certificate`,
      org: name && org ? org : null,
      domain: null,
    };
  }

  // A domain publishing this key proves control of an address, which is more
  // than self-reporting and less than a checked identity. Its own tag keeps
  // it from being read as either.
  if (site) {
    return {
      tag: 'Domain verified',
      tone: 'established',
      name: name ?? org ?? site.domain,
      by: `${site.domain} publishes this key`,
      domain: site.domain,
    };
  }

  return {
    tag: 'Unverified',
    tone: 'attention',
    name: name ?? org ?? 'Named in the file',
    by: 'Self reported',
    domain: null,
  };
}

/**
 * Declared edits, and only declared ones. An empty list and no list are the
 * same thing here: the section does not appear, because a heading about
 * editing on a file nobody edited reads as a finding.
 */
export function deriveEdits(
  actions: { action?: string; softwareAgent?: string | null }[] | null | undefined,
): { by: string | null; list: string[] } | null {
  if (!actions || actions.length === 0) return null;
  const edits = actions.filter((a) => typeof a.action === 'string' && !/c2pa\.created$/.test(a.action));
  if (edits.length === 0) return null;
  const by = edits.find((a) => a.softwareAgent)?.softwareAgent ?? null;
  return { by, list: edits.map((a) => humanAction(a.action as string)) };
}

/** c2pa.color_adjustments → "Color adjustments". The label is the action,
 *  never a judgement about it. */
function humanAction(action: string): string {
  const leaf = action.replace(/^c2pa\./, '').replace(/_/g, ' ');
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}

function fmt(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
