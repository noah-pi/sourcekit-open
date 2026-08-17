// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * .exhibitcase v1 — the desk's portable case file.
 *
 * A case file is the desk's session made durable: which items were examined
 * (by path and SHA-256), the verdict snapshot and report the desk produced
 * for each, the trust configuration in force, the notices shown, the
 * analyst's notes, and an audit trail of what the desk did and when.
 * Everything runs in this browser tab; serializing a case file moves bytes
 * only when the user explicitly saves one. Nothing leaves this tab.
 *
 * FORMAT (canonical JSON — recursively sorted keys, no whitespace; the same
 * rules as src/lib/canonical.ts, so one byte stream always means one case):
 *
 *   {
 *     "format": "exhibitcase",
 *     "version": 1,
 *     "createdAt": string,                  // ISO 8601
 *     "modifiedAt": string,                 // ISO 8601
 *     "items": [
 *       {
 *         "path": string,                   // non-empty
 *         "sha256": string,                 // 64 lowercase/uppercase hex
 *         "verdictSnapshot": unknown,       // required key, any JSON value
 *         "report": unknown                 // optional
 *       }
 *     ],
 *     "trustConfigSnapshot": unknown,       // required key, may be null
 *     "notices": unknown[],
 *     "notes": [{ "ts": string, "text": string }],
 *     "auditTrail": [
 *       {
 *         "ts": string,                     // ISO 8601
 *         "action": string,                 // non-empty
 *         "detail": string,                 // optional
 *         "prevHash": string,               // 64 hex
 *         "hash": string                    // 64 hex
 *       }
 *     ]
 *   }
 *
 * AUDIT-TRAIL HASH CHAIN (v1 — a chain, not yet a signature). Each entry's
 * hash covers exactly its own content and its predecessor:
 *
 *   hash     = sha256-hex( canonicalize({ action, detail, prevHash, ts }) )
 *   detail   = the entry's detail string, or null when absent
 *   prevHash = the previous entry's hash; the FIRST entry uses the genesis
 *              value GENESIS_PREVHASH (64 ASCII '0' characters)
 *
 * The chain makes the trail tamper-evident: deleting, reordering, or
 * editing an entry breaks every link after it. It does NOT prove the
 * recorded actions were honestly chosen — an operator could write a fresh
 * chain from scratch. Signing (a later tier) binds the head of the chain to
 * a desk key; until then the chain is a measurement of internal
 * consistency — characterization, never a verdict.
 *
 * VERIFICATION RECIPE (how a stranger checks a case file, no desk needed):
 *   1. Parse the file as JSON. Require format === 'exhibitcase' and
 *      version === 1. Anything else: stop, unknown.
 *   2. Re-serialize with recursively sorted keys and no whitespace; a
 *      canonical file byte-matches its own serialization.
 *   3. Walk auditTrail in order. Entry 0 must carry prevHash of 64 zeros;
 *      every later entry's prevHash must equal the previous entry's hash.
 *   4. Recompute each entry's hash as sha256 over the UTF-8 of the
 *      canonical JSON of { action, detail-or-null, prevHash, ts } (keys
 *      sorted) and compare to the recorded hash. Any mismatch: the trail
 *      was altered after writing — say exactly that, nothing more.
 *   parseCase() below performs steps 1, 3, and 4 and fails closed with a
 *   named error; auditEntryHash() is exported so an independent verifier
 *   can recompute step 4 without trusting this module.
 *
 * Parsing FAILS CLOSED: unknown format, wrong version, malformed items,
 * malformed entries, or a broken chain each raise a CaseFileError with a
 * named code. There is no "best effort" parse.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@exhibit/lib/bytes';
import { canonicalize, type JsonValue } from '@exhibit/lib/canonical';

// ---------------------------------------------------------------------------
// Public types.
// ---------------------------------------------------------------------------

export interface ExhibitCaseItem {
  path: string;
  sha256: string;
  verdictSnapshot: unknown;
  report?: unknown;
}

export interface CaseNote {
  ts: string;
  text: string;
}

export interface AuditEntry {
  ts: string;
  action: string;
  detail?: string;
  prevHash: string;
  hash: string;
}

export interface ExhibitCase {
  format: 'exhibitcase';
  version: 1;
  createdAt: string;
  modifiedAt: string;
  items: ExhibitCaseItem[];
  trustConfigSnapshot: unknown;
  notices: unknown[];
  notes: CaseNote[];
  auditTrail: AuditEntry[];
}

// ---------------------------------------------------------------------------
// Errors — named, so a caller can say WHY a case file was refused.
// ---------------------------------------------------------------------------

export type CaseFileErrorCode =
  | 'NOT_JSON'
  | 'UNKNOWN_FORMAT'
  | 'UNSUPPORTED_VERSION'
  | 'MALFORMED_CASE'
  | 'MALFORMED_ITEM'
  | 'MALFORMED_NOTE'
  | 'MALFORMED_AUDIT_ENTRY'
  | 'BROKEN_CHAIN'
  | 'NON_JSON_VALUE';

export class CaseFileError extends Error {
  readonly code: CaseFileErrorCode;
  constructor(code: CaseFileErrorCode, message: string) {
    super(message);
    this.name = 'CaseFileError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

export const CASE_FORMAT = 'exhibitcase' as const;
export const CASE_VERSION = 1 as const;

/** prevHash of the first audit-trail entry: 64 ASCII zeros. */
export const GENESIS_PREVHASH = '0'.repeat(64);

// ---------------------------------------------------------------------------
// The audit-trail hash.
// ---------------------------------------------------------------------------

/**
 * The hash of one audit-trail entry: sha256-hex over the UTF-8 of the
 * canonical JSON of { action, detail, prevHash, ts } with keys sorted and
 * detail === null when the entry carries none. Exported so any independent
 * verifier can recompute the chain without this module.
 */
export function auditEntryHash(
  ts: string,
  action: string,
  detail: string | null | undefined,
  prevHash: string,
): string {
  return bytesToHex(
    sha256(utf8ToBytes(canonicalize({ action, detail: detail ?? null, prevHash, ts }))),
  );
}

// ---------------------------------------------------------------------------
// Builders. createCase/appendAudit/addItem MUTATE the case and stamp
// modifiedAt; the optional `now` parameter exists for deterministic tests,
// never for backdating a real trail.
// ---------------------------------------------------------------------------

export function createCase(now?: string): ExhibitCase {
  const ts = now ?? new Date().toISOString();
  return {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    createdAt: ts,
    modifiedAt: ts,
    items: [],
    trustConfigSnapshot: null,
    notices: [],
    notes: [],
    auditTrail: [],
  };
}

export function appendAudit(
  c: ExhibitCase,
  action: string,
  detail?: string,
  now?: string,
): AuditEntry {
  if (typeof action !== 'string' || action.length === 0) {
    throw new CaseFileError('MALFORMED_AUDIT_ENTRY', 'audit action must be a non-empty string');
  }
  if (detail !== undefined && typeof detail !== 'string') {
    throw new CaseFileError('MALFORMED_AUDIT_ENTRY', 'audit detail must be a string when present');
  }
  const ts = now ?? new Date().toISOString();
  const prevHash = c.auditTrail.length > 0 ? c.auditTrail[c.auditTrail.length - 1].hash : GENESIS_PREVHASH;
  const entry: AuditEntry = {
    ts,
    action,
    ...(detail !== undefined ? { detail } : {}),
    prevHash,
    hash: auditEntryHash(ts, action, detail, prevHash),
  };
  c.auditTrail.push(entry);
  c.modifiedAt = ts;
  return entry;
}

export function addItem(c: ExhibitCase, item: ExhibitCaseItem, now?: string): void {
  validateItem(item, 0); // index is cosmetic in the error message here
  c.items.push(item);
  c.modifiedAt = now ?? new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Serialization — canonical JSON: sorted keys, no whitespace ambiguity.
// ---------------------------------------------------------------------------

/**
 * Convert to a plain JSON value. `undefined` follows JSON.stringify
 * semantics (object members dropped, array members nulled) so optional
 * fields behave as expected; anything else JSON cannot represent —
 * functions, symbols, bigints, circular references — fails closed with
 * NON_JSON_VALUE rather than being silently dropped. canonicalize then
 * rejects non-finite numbers.
 */
function toJsonValue(v: unknown, seen: Set<object>): JsonValue {
  if (v === null) return null;
  switch (typeof v) {
    case 'boolean':
    case 'string':
      return v;
    case 'number':
      return v;
    case 'object': {
      if (seen.has(v as object)) {
        throw new CaseFileError('NON_JSON_VALUE', 'circular reference cannot be serialized into a case file');
      }
      seen.add(v as object);
      try {
        if (Array.isArray(v)) {
          return v.map((x) => (x === undefined ? null : toJsonValue(x, seen)));
        }
        const out: Record<string, JsonValue> = {};
        for (const k of Object.keys(v as Record<string, unknown>)) {
          const val = (v as Record<string, unknown>)[k];
          if (val === undefined) continue;
          out[k] = toJsonValue(val, seen);
        }
        return out;
      } finally {
        seen.delete(v as object);
      }
    }
    default:
      throw new CaseFileError(
        'NON_JSON_VALUE',
        `value of type '${typeof v}' is not representable in a case file`,
      );
  }
}

/** Canonical JSON of a case file: recursively sorted keys, no whitespace. */
export function serializeCase(c: ExhibitCase): string {
  return canonicalize(toJsonValue(c, new Set()));
}

// ---------------------------------------------------------------------------
// Parsing — full validation, fail closed with named errors.
// ---------------------------------------------------------------------------

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const isHex64 = (x: unknown): x is string =>
  typeof x === 'string' && /^[0-9a-fA-F]{64}$/.test(x);

const isIsoTs = (x: unknown): x is string =>
  typeof x === 'string' && !Number.isNaN(Date.parse(x));

function validateItem(item: unknown, index: number): asserts item is ExhibitCaseItem {
  const where = `items[${index}]`;
  if (!isRec(item)) throw new CaseFileError('MALFORMED_ITEM', `${where} is not an object`);
  if (typeof item.path !== 'string' || item.path.length === 0) {
    throw new CaseFileError('MALFORMED_ITEM', `${where}.path must be a non-empty string`);
  }
  if (!isHex64(item.sha256)) {
    throw new CaseFileError('MALFORMED_ITEM', `${where}.sha256 must be 64 hex characters`);
  }
  if (!('verdictSnapshot' in item)) {
    throw new CaseFileError('MALFORMED_ITEM', `${where}.verdictSnapshot is required (use null when absent)`);
  }
}

function validateNote(note: unknown, index: number): asserts note is CaseNote {
  const where = `notes[${index}]`;
  if (!isRec(note) || typeof note.ts !== 'string' || typeof note.text !== 'string') {
    throw new CaseFileError('MALFORMED_NOTE', `${where} must be { ts: string, text: string }`);
  }
}

function validateAuditEntry(entry: unknown, index: number): asserts entry is AuditEntry {
  const where = `auditTrail[${index}]`;
  if (!isRec(entry)) throw new CaseFileError('MALFORMED_AUDIT_ENTRY', `${where} is not an object`);
  if (!isIsoTs(entry.ts)) {
    throw new CaseFileError('MALFORMED_AUDIT_ENTRY', `${where}.ts must be an ISO 8601 timestamp string`);
  }
  if (typeof entry.action !== 'string' || entry.action.length === 0) {
    throw new CaseFileError('MALFORMED_AUDIT_ENTRY', `${where}.action must be a non-empty string`);
  }
  if (entry.detail !== undefined && typeof entry.detail !== 'string') {
    throw new CaseFileError('MALFORMED_AUDIT_ENTRY', `${where}.detail must be a string when present`);
  }
  if (!isHex64(entry.prevHash) || !isHex64(entry.hash)) {
    throw new CaseFileError('MALFORMED_AUDIT_ENTRY', `${where}.prevHash and .hash must be 64 hex characters`);
  }
}

/**
 * Parse and FULLY validate a case file. Unknown extra keys are tolerated
 * (ignored, not copied) so a newer writer's additions never make a v1 file
 * unreadable here; everything the format defines is enforced. Throws
 * CaseFileError on any violation — never returns a partial case.
 */
export function parseCase(json: string): ExhibitCase {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new CaseFileError('NOT_JSON', `case file is not valid JSON: ${(e as Error).message}`);
  }
  if (!isRec(raw)) throw new CaseFileError('MALFORMED_CASE', 'case file root is not an object');

  if (raw.format !== CASE_FORMAT) {
    throw new CaseFileError(
      'UNKNOWN_FORMAT',
      `format must be '${CASE_FORMAT}', got ${JSON.stringify(raw.format ?? null)}`,
    );
  }
  if (raw.version !== CASE_VERSION) {
    throw new CaseFileError(
      'UNSUPPORTED_VERSION',
      `version must be ${CASE_VERSION}, got ${JSON.stringify(raw.version ?? null)}`,
    );
  }
  if (!isIsoTs(raw.createdAt) || !isIsoTs(raw.modifiedAt)) {
    throw new CaseFileError('MALFORMED_CASE', 'createdAt and modifiedAt must be ISO 8601 timestamp strings');
  }
  if (!Array.isArray(raw.items)) throw new CaseFileError('MALFORMED_CASE', 'items must be an array');
  if (!('trustConfigSnapshot' in raw)) {
    throw new CaseFileError('MALFORMED_CASE', 'trustConfigSnapshot is required (use null when absent)');
  }
  if (!Array.isArray(raw.notices)) throw new CaseFileError('MALFORMED_CASE', 'notices must be an array');
  if (!Array.isArray(raw.notes)) throw new CaseFileError('MALFORMED_CASE', 'notes must be an array');
  if (!Array.isArray(raw.auditTrail)) throw new CaseFileError('MALFORMED_CASE', 'auditTrail must be an array');

  raw.items.forEach((it, i) => validateItem(it, i));
  raw.notes.forEach((n, i) => validateNote(n, i));
  raw.auditTrail.forEach((e, i) => validateAuditEntry(e, i));

  // Hash chain: genesis linkage, then link-by-link prevHash and content hash.
  const trail = raw.auditTrail as AuditEntry[];
  for (let i = 0; i < trail.length; i++) {
    const e = trail[i];
    const expectedPrev = i === 0 ? GENESIS_PREVHASH : trail[i - 1].hash;
    if (e.prevHash !== expectedPrev) {
      throw new CaseFileError(
        'BROKEN_CHAIN',
        `auditTrail[${i}].prevHash does not ${i === 0 ? 'equal the genesis value' : `match auditTrail[${i - 1}].hash`} — the trail was altered after writing`,
      );
    }
    const recomputed = auditEntryHash(e.ts, e.action, e.detail, e.prevHash);
    if (e.hash !== recomputed) {
      throw new CaseFileError(
        'BROKEN_CHAIN',
        `auditTrail[${i}].hash does not match its recomputed content hash — the trail was altered after writing`,
      );
    }
  }

  // Rebuild from validated fields only — the returned object is exactly the
  // v1 shape, with the parsed JSON values carried by reference.
  return {
    format: CASE_FORMAT,
    version: CASE_VERSION,
    createdAt: raw.createdAt,
    modifiedAt: raw.modifiedAt,
    items: raw.items as ExhibitCaseItem[],
    trustConfigSnapshot: raw.trustConfigSnapshot,
    notices: raw.notices,
    notes: raw.notes as CaseNote[],
    auditTrail: trail,
  };
}
