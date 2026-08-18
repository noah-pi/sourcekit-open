// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Signed newsroom roster — the honest answer to "who took this?" for an
 * organization of twelve people.
 *
 * A roster is a small file listing staff signing-key fingerprints with
 * names, roles, and validity dates, signed by an EDITOR key and distributed
 * out of band (AirDrop, QR code, a published file whose fingerprint is
 * confirmed once in person). It requires no CA, no conformance program, and
 * no money — and unlike the removed tap-to-trust "known signers" list, it is
 * revocable, expiring, and vouched for by someone accountable.
 *
 * Semantics that matter (the departed-photographer case):
 *   - Membership is evaluated AT THE VERIFIED SIGNING TIME, never at the
 *     verifier's clock. Revoking a departed stringer's key does NOT
 *     invalidate their genuine past captures — a capture signed before the
 *     revocation is reported as "membership later revoked", honestly.
 *   - Without a verified signing time, membership-at-signing-time cannot be
 *     evaluated and the display says exactly that.
 *   - A roster hit upgrades identity to the ROSTER trust tier — below an org
 *     credential chain, above bare self-signed, and always displayed with
 *     who vouched (editor + newsroom) and when.
 *
 * The roster format is canonical JSON + one ES256 signature over SHA-256 of
 * the canonical payload — the same construction as attestation records, so
 * any desk tooling can produce it. The desk tool issues rosters;
 * the app consumes them.
 */

import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes, utf8ToBytes } from './bytes';
import { canonicalize, type JsonValue } from './canonical';

export const ROSTER_FORMAT = 'verify-roster/1';

export interface RosterEntry {
  /** Full 64-hex SHA-256 of the member's signing public key. Never a prefix. */
  fingerprint: string;
  name: string;
  /** Free text — "staff photographer", "stringer, northern desk". */
  role: string;
  /** ISO-8601 date/timestamp — membership valid from. */
  validFrom: string;
  /** ISO-8601 or null for open-ended. */
  validTo: string | null;
  /** ISO-8601 timestamp of revocation, or null while the entry stands. */
  revokedAt: string | null;
  note?: string;
}

/**
 * Optional desk encryption key. When present, member devices
 * can seal captures TO this key — ciphertext only the desk's key-share
 * holders can open (see seal.ts). It rides the roster so the editor
 * signature covers it: a swapped desk key is a forged roster, rejected at
 * the door like any other tamper.
 */
export interface RosterEncryption {
  /** X25519 public key (32 bytes, base64) captures are sealed to. */
  deskPublicKeyBase64: string;
  /** SHA-256 of the desk public key bytes, hex — display/confirmation. */
  fingerprint: string;
  /** ISO-8601 — when the editor attached this key. */
  addedAt: string;
}

export interface Roster {
  format: typeof ROSTER_FORMAT;
  /** Display name of the organization — "The Examples Gazette". */
  newsroom: string;
  issuedAt: string;
  /** The editor key that vouches for this roster. */
  editor: {
    name: string;
    /** Uncompressed 65-byte P-256 point, base64. */
    publicKeyBase64: string;
    /** SHA-256 of the public key bytes, hex. */
    fingerprint: string;
  };
  entries: RosterEntry[];
  /** Absent unless the newsroom runs seal-to-desk. Signed like everything else. */
  encryption?: RosterEncryption;
  /** Base64 DER ECDSA signature over SHA-256(canonical payload minus this field). */
  signature: string;
}

/** The signed payload is the whole roster except the signature itself. */
export function rosterPayload(roster: Roster): JsonValue {
  const { signature: _sig, ...rest } = roster;
  return rest as unknown as JsonValue;
}

export function rosterDigest(roster: Roster): Uint8Array {
  return sha256(utf8ToBytes(canonicalize(rosterPayload(roster))));
}

export async function signRoster(
  roster: Omit<Roster, 'signature'>,
  signDigest: (digest: Uint8Array) => Promise<Uint8Array>
): Promise<Roster> {
  const digest = sha256(utf8ToBytes(canonicalize(roster as unknown as JsonValue)));
  const sig = await signDigest(digest);
  return { ...roster, signature: bytesToBase64(sig) };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Structural validation — types, required fields, fingerprint shapes. */
export function isRoster(x: unknown): x is Roster {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  const editor = r.editor as Record<string, unknown> | undefined;
  if (r.format !== ROSTER_FORMAT) return false;
  if (typeof r.newsroom !== 'string' || typeof r.issuedAt !== 'string') return false;
  if (!editor || typeof editor.name !== 'string' || typeof editor.publicKeyBase64 !== 'string') return false;
  if (typeof editor.fingerprint !== 'string' || !HEX64.test(editor.fingerprint)) return false;
  if (!Array.isArray(r.entries)) return false;
  const seenFingerprints = new Set<string>();
  for (const e of r.entries as Record<string, unknown>[]) {
    if (!e || typeof e.fingerprint !== 'string' || !HEX64.test(e.fingerprint)) return false;
    // Duplicate fingerprints make membership ambiguous — resolveInRoster's
    // .find would silently resolve to the FIRST entry (e.g. an expired
    // one shadowing a valid one). Rejection here is what makes that .find
    // safe; fail closed, never ambiguous.
    if (seenFingerprints.has(e.fingerprint)) return false;
    seenFingerprints.add(e.fingerprint);
    if (typeof e.name !== 'string' || typeof e.role !== 'string' || typeof e.validFrom !== 'string') return false;
    if (e.validTo !== null && typeof e.validTo !== 'string') return false;
    if (e.revokedAt !== null && typeof e.revokedAt !== 'string') return false;
    // Dates fail closed: an unparseable validFrom/validTo/revokedAt would
    // slip past membershipState's Number.isFinite guards and resolve
    // 'active' — a roster whose dates cannot be evaluated is not a roster.
    if (!Number.isFinite(Date.parse(e.validFrom))) return false;
    if (typeof e.validTo === 'string' && !Number.isFinite(Date.parse(e.validTo))) return false;
    if (typeof e.revokedAt === 'string' && !Number.isFinite(Date.parse(e.revokedAt))) return false;
  }
  if (r.encryption !== undefined) {
    const enc = r.encryption as Record<string, unknown>;
    if (!enc || typeof enc.deskPublicKeyBase64 !== 'string') return false;
    if (typeof enc.fingerprint !== 'string' || !HEX64.test(enc.fingerprint)) return false;
    if (typeof enc.addedAt !== 'string') return false;
  }
  return typeof r.signature === 'string';
}

export interface RosterSignatureCheck {
  valid: boolean;
  /** Editor fingerprint recomputed from the embedded key matches the declared one. */
  fingerprintMatches: boolean;
  reason: string | null;
}

/**
 * Verifies the editor's signature over the roster. A roster that fails this
 * is not a roster — it must never be stored or consulted.
 */
export function verifyRosterSignature(roster: Roster): RosterSignatureCheck {
  try {
    const pub = base64ToBytes(roster.editor.publicKeyBase64);
    if (pub.length !== 65 || pub[0] !== 0x04) {
      return { valid: false, fingerprintMatches: false, reason: 'editor key is not an uncompressed P-256 point' };
    }
    const fingerprintMatches = bytesToHex(sha256(pub)) === roster.editor.fingerprint;
    if (!fingerprintMatches) {
      return { valid: false, fingerprintMatches: false, reason: 'editor fingerprint does not match the editor key' };
    }
    const valid = p256.verify(base64ToBytes(roster.signature), rosterDigest(roster), pub, {
      format: 'der',
      lowS: true,
    });
    return { valid, fingerprintMatches: true, reason: valid ? null : 'editor signature invalid; roster was altered after signing' };
  } catch {
    return { valid: false, fingerprintMatches: false, reason: 'roster signature could not be evaluated' };
  }
}

/** Membership state of ONE entry at ONE signing time. */
export type MembershipState =
  | 'active'                // valid at the signing time, and still standing
  | 'active-then-revoked'   // genuine: signed before a later revocation
  | 'revoked'               // signed AFTER revocation — a real red flag
  | 'not-yet-valid'         // signed before validFrom — suspicious
  | 'expired'               // signed after validTo — membership had ended
  | 'unknown-time';         // no verified signing time — cannot evaluate

export interface RosterResolution {
  entry: RosterEntry;
  roster: {
    newsroom: string;
    issuedAt: string;
    editorName: string;
    editorFingerprint: string;
  };
  state: MembershipState;
}

/**
 * Evaluates one entry at one signing time. `atMs` MUST come from a verified
 * RFC 3161 token (or null) — never the verifier's clock.
 */
export function membershipState(entry: RosterEntry, atMs: number | null): MembershipState {
  if (atMs === null) return 'unknown-time';
  const from = Date.parse(entry.validFrom);
  if (Number.isFinite(from) && atMs < from) return 'not-yet-valid';
  if (entry.validTo) {
    const to = Date.parse(entry.validTo);
    if (Number.isFinite(to) && atMs > to) return 'expired';
  }
  if (entry.revokedAt) {
    const revoked = Date.parse(entry.revokedAt);
    if (Number.isFinite(revoked)) return atMs > revoked ? 'revoked' : 'active-then-revoked';
  }
  return 'active';
}

/**
 * Resolves a signer fingerprint against one roster. Returns null when the
 * fingerprint is not listed (unknown signers stay unknown — a roster can
 * never vouch for an unlisted key).
 */
export function resolveInRoster(roster: Roster, fingerprint: string, atMs: number | null): RosterResolution | null {
  // .find takes the first match — unambiguous because isRoster rejects
  // any roster carrying a duplicate fingerprint.
  const entry = roster.entries.find((e) => e.fingerprint === fingerprint);
  if (!entry) return null;
  return {
    entry,
    roster: {
      newsroom: roster.newsroom,
      issuedAt: roster.issuedAt,
      editorName: roster.editor.name,
      editorFingerprint: roster.editor.fingerprint,
    },
    state: membershipState(entry, atMs),
  };
}

/**
 * Builds a fresh roster signed by a new editor key. Returns the roster AND
 * the editor private key — the caller (desk tool) is responsible for the
 * key's custody from this moment on. The app never generates editor keys.
 */
export async function createRoster(params: {
  newsroom: string;
  editorName: string;
  entries?: RosterEntry[];
}): Promise<{ roster: Roster; editorPrivateKeyHex: string }> {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false);
  const unsigned: Omit<Roster, 'signature'> = {
    format: ROSTER_FORMAT,
    newsroom: params.newsroom,
    issuedAt: new Date().toISOString(),
    editor: {
      name: params.editorName,
      publicKeyBase64: bytesToBase64(pub),
      fingerprint: bytesToHex(sha256(pub)),
    },
    entries: params.entries ?? [],
  };
  const roster = await signRoster(unsigned, async (d) =>
    p256.sign(d, priv, { lowS: true }).toDERRawBytes()
  );
  return { roster, editorPrivateKeyHex: bytesToHex(priv) };
}

/** Re-signs a roster after an edit (add / rotate / revoke), editor key in hand. */
export async function resignRoster(
  roster: Roster,
  editorPrivateKeyHex: string,
  entries: RosterEntry[],
  patch?: { encryption?: RosterEncryption | null }
): Promise<Roster> {
  const priv = hexToBytes(editorPrivateKeyHex);
  const pub = p256.getPublicKey(priv, false);
  if (bytesToHex(sha256(pub)) !== roster.editor.fingerprint) {
    throw new Error('this editor key does not match the roster; refusing to re-sign');
  }
  // Strip the OLD signature before re-signing: signRoster signs the object
  // as passed, and a payload containing the old signature would verify
  // against nothing (caught by the rotation regression test).
  const { signature: _old, ...rest } = roster;
  const unsigned: Omit<Roster, 'signature'> = {
    ...rest,
    issuedAt: new Date().toISOString(),
    entries,
  };
  if (patch && 'encryption' in patch) {
    if (patch.encryption === null || patch.encryption === undefined) delete unsigned.encryption;
    else unsigned.encryption = patch.encryption;
  }
  return signRoster(unsigned, async (d) => p256.sign(d, priv, { lowS: true }).toDERRawBytes());
}

/**
 * Rotate a member key: the old fingerprint is revoked as of now, the new one
 * is added valid from now. Past captures stay genuine (evaluated at their
 * own signing times).
 */
export function rotateEntry(entries: RosterEntry[], oldFingerprint: string, next: RosterEntry): RosterEntry[] {
  const now = new Date().toISOString();
  return [
    ...entries.map((e) => (e.fingerprint === oldFingerprint ? { ...e, revokedAt: now } : e)),
    { ...next, validFrom: now },
  ];
}

/** Revoke a member as of now (the departed-photographer case). */
export function revokeEntry(entries: RosterEntry[], fingerprint: string): RosterEntry[] {
  const now = new Date().toISOString();
  return entries.map((e) => (e.fingerprint === fingerprint ? { ...e, revokedAt: now } : e));
}
