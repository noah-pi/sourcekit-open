// Source Kit 0.1.0 — Signed newsroom roster: staff signing-key fingerprints with names
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Signed newsroom roster: staff signing-key fingerprints with names, roles,
 * and validity dates, signed by an editor key and distributed out of band
 * (AirDrop, QR, a published file whose fingerprint is confirmed in person).
 *
 * Membership is evaluated at the verified signing time, never at the
 * verifier's clock, so revoking a key leaves past captures genuine and
 * reported as revoked later. With no verified signing time, membership
 * cannot be evaluated and the display says so. A roster hit puts identity
 * on the ROSTER trust tier, shown with who vouched and when.
 *
 * Format: canonical JSON plus one ES256 signature over SHA-256 of the
 * canonical payload, the same construction as attestation records. The desk
 * tool issues rosters; the app consumes them.
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
  /** Free text: "staff photographer", "stringer, northern desk". */
  role: string;
  /** ISO-8601 date/timestamp; membership valid from. */
  validFrom: string;
  /** ISO-8601 or null for open-ended. */
  validTo: string | null;
  /** ISO-8601 timestamp of revocation, or null while the entry stands. */
  revokedAt: string | null;
  note?: string;
}

/**
 * Optional desk encryption key. Member devices seal captures to it, opened
 * only by the desk's key-share holders (seal.ts). It rides the roster so the
 * editor signature covers it, making a swapped desk key a forged roster.
 */
export interface RosterEncryption {
  /** X25519 public key (32 bytes, base64) captures are sealed to. */
  deskPublicKeyBase64: string;
  /** SHA-256 of the desk public key bytes, hex; for display and confirmation. */
  fingerprint: string;
  /** ISO-8601: when the editor attached this key. */
  addedAt: string;
}

export interface Roster {
  format: typeof ROSTER_FORMAT;
  /** Display name of the organization, e.g. "The Examples Gazette". */
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

/** Structural validation: types, required fields, fingerprint shapes. */
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
    // Duplicate fingerprints would make resolveInRoster's .find resolve to
    // the first entry (an expired one could shadow a valid one). Rejecting
    // them here is what makes that .find safe.
    if (seenFingerprints.has(e.fingerprint)) return false;
    seenFingerprints.add(e.fingerprint);
    if (typeof e.name !== 'string' || typeof e.role !== 'string' || typeof e.validFrom !== 'string') return false;
    if (e.validTo !== null && typeof e.validTo !== 'string') return false;
    if (e.revokedAt !== null && typeof e.revokedAt !== 'string') return false;
    // Dates fail closed: an unparseable validFrom/validTo/revokedAt would
    // slip past membershipState's Number.isFinite guards and resolve as
    // 'active'.
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
 * must not be stored or consulted.
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

/** Membership state of one entry at one signing time. */
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
 * Evaluates one entry at one signing time. `atMs` must come from a verified
 * RFC 3161 token, or be null. Never the verifier's clock.
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
 * fingerprint is not listed.
 */
export function resolveInRoster(roster: Roster, fingerprint: string, atMs: number | null): RosterResolution | null {
  // .find takes the first match; unambiguous because isRoster rejects any
  // roster carrying a duplicate fingerprint.
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
 * Builds a fresh roster signed by a new editor key. Returns the roster and
 * the editor private key; custody of that key is the caller's (the desk
 * tool's). The app never generates editor keys.
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
  // Strip the old signature first: signRoster signs the object as passed,
  // and a payload containing the old signature verifies against nothing.
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

/** Revoke a member as of now. */
export function revokeEntry(entries: RosterEntry[], fingerprint: string): RosterEntry[] {
  const now = new Date().toISOString();
  return entries.map((e) => (e.fingerprint === fingerprint ? { ...e, revokedAt: now } : e));
}
