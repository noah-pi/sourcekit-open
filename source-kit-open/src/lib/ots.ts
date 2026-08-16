/**
 * OpenTimestamps (OTS) — ledger-anchored time, separate from authority time.
 *
 * RFC 3161 (src/lib/timestamp.ts, rfc3161.ts) binds a signature to an
 * authority's clock. OTS binds a digest to the Bitcoin blockchain: a free
 * public calendar aggregates many digests into a Merkle tree and embeds the
 * root in a Bitcoin transaction. No account, no cost, no keys held by us.
 *
 * What an OTS receipt proves: the digest existed no later than the block it
 * is anchored in. What it does NOT prove: the exact moment (block time is
 * coarse, ~10 minutes, and miner-set within consensus limits), or anything
 * about the TSA quorum — the two are independent claims and the UI must
 * never merge them.
 *
 * Receipt lifecycle:
 *   1. submit  — POST digest to public calendars; each returns a receipt
 *                whose attestation is "pending" (a calendar URI promise).
 *   2. upgrade — later, GET the same calendar for the digest; once the
 *                calendar's tree is confirmed in a block, the receipt's
 *                attestation becomes a Bitcoin block height. We replace the
 *                pending receipt with the upgraded one.
 *   3. verify  — walk the receipt's op chain from the digest, then check the
 *                final message equals the Merkle-root field of the block
 *                header at the attested height (bytes 36..68). Fetching that
 *                header requires network; without it we verify the receipt's
 *                internal consistency only and say so.
 *
 * Format reference: opentimestamps.org — DetachedTimestampFile:
 *   MAGIC || version(0x01) || hash-op tag (0x08 = sha256) || raw file_digest
 *   || Timestamp
 * Timestamp node: (0x00 attestation)* (op (sub)...)* — an attestation is
 *   tag(8 raw bytes) || varbytes(payload); binary ops are tag || varbytes(arg).
 * Ops used by calendars: 0xf0 append, 0xf1 prepend, 0x08 sha256.
 * Attestation tags (8 raw bytes): pending = 83dfe30d2ef90c8e (payload:
 *   varbytes calendar URI), bitcoin = 0588960d73d71901 (payload: varuint
 *   block height).
 * Calendar endpoints (opentimestamps-server): POST /digest and
 *   GET /timestamp/{commitment} both return a BARE Timestamp (no MAGIC
 *   header) — the caller wraps it. The GET is keyed by the commitment the
 *   pending attestation sits on (the msg after walking the receipt's ops),
 *   not by the originally submitted digest.
 * Forked trees (0xff sibling marker) are never produced by calendars; we
 * refuse them rather than guess.
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, equalBytes, bytesToHex, bytesToUtf8, utf8ToBytes, base64ToBytes, bytesToBase64 } from './bytes';

// Reference wire constants (python-opentimestamps op.py / notary.py /
// timestamp.py — checked against live calendar responses, 0.18.1):
//   MAGIC tail is bf89e2e884e89294 (a wrong tail rejects every real .ots).
export const OTS_MAGIC = concatBytes(
  new Uint8Array([0x00]),
  utf8ToBytes('OpenTimestamps'),
  new Uint8Array([0x00, 0x00]),
  utf8ToBytes('Proof'),
  new Uint8Array([0x00, 0xbf, 0x89, 0xe2, 0xe8, 0x84, 0xe8, 0x92, 0x94])
);
const OTS_VERSION = 1;

// Op tags: 0xf0 APPEND, 0xf1 PREPEND (reference OpAppend.TAG / OpPrepend.TAG
// — the two are easy to swap, and a swapped walk yields a wrong Merkle root).
const OP_SHA256 = 0x08;
const OP_APPEND = 0xf0;
const OP_PREPEND = 0xf1;

// Attestation tags are 8 RAW bytes on the wire (TimeAttestation.TAG_SIZE =
// 8, written verbatim — NOT varuint-encoded).
const ATTEST_PENDING = new Uint8Array([0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e]);
const ATTEST_BITCOIN = new Uint8Array([0x05, 0x88, 0x96, 0x0d, 0x73, 0xd7, 0x19, 0x01]);

/** Free public calendars — no signup, no key, no bill. Order = preference;
 * all are asked to witness every digest; one success is enough to anchor. */
export const OTS_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
];

export interface OtsAttestation {
  kind: 'pending' | 'bitcoin' | 'unknown';
  /** pending: calendar URI that promised to anchor. */
  uri?: string;
  /** bitcoin: block height the digest tree is anchored in. */
  blockHeight?: number;
  /** The message state this attestation commits to (hex). */
  msgHex: string;
}

export interface OtsReceipt {
  /** The digest the receipt commits to (hex) — SHA-256 of whatever we timestamped. */
  digestHex: string;
  attestations: OtsAttestation[];
  /** True when the op chain could be walked to completion. */
  chainComplete: boolean;
  /** Final message after walking all ops (hex) — the would-be Merkle root. */
  finalMsgHex: string;
  /** Raw receipt bytes (base64) for storage/sharing. */
  rawBase64: string;
}

/** Minimal byte cursor with varuint/varbytes support. */
class Cursor {
  pos = 0;
  constructor(public buf: Uint8Array) {}
  get eof(): boolean { return this.pos >= this.buf.length; }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('ots: truncated');
    return this.buf[this.pos++];
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('ots: truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  /** LEB128 unsigned varint (BigInt — tags are 64-bit). */
  varuint(): bigint {
    let v = 0n;
    let shift = 0n;
    for (;;) {
      const b = this.byte();
      v |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return v;
      shift += 7n;
      if (shift > 70n) throw new Error('ots: varuint overflow');
    }
  }
  varbytes(): Uint8Array {
    const n = Number(this.varuint());
    if (n > 16 * 1024 * 1024) throw new Error('ots: absurd varbytes length');
    return this.take(n);
  }
}

/**
 * Reads one attestation from the main cursor: tag(8 raw bytes) ||
 * varbytes(payload). Payloads are self-delimiting and read strictly —
 * trailing bytes inside the payload mean an altered/corrupt receipt.
 */
function parseAttestation(c: Cursor, msgHex: string): OtsAttestation {
  const tag = c.take(8);
  const payload = new Cursor(c.varbytes());
  let out: OtsAttestation;
  if (equalBytes(tag, ATTEST_PENDING)) {
    out = { kind: 'pending', uri: bytesToUtf8(payload.varbytes()), msgHex };
  } else if (equalBytes(tag, ATTEST_BITCOIN)) {
    out = { kind: 'bitcoin', blockHeight: Number(payload.varuint()), msgHex };
  } else {
    return { kind: 'unknown', msgHex };
  }
  if (!payload.eof) throw new Error('ots: attestation has trailing bytes');
  return out;
}

/**
 * Parses a DetachedTimestampFile receipt. Never throws on malformed input —
 * returns null. Throws only programmer errors. Forked trees are refused:
 * no public calendar produces them, and guessing would be worse than failing.
 */
export function parseOtsReceipt(raw: Uint8Array): OtsReceipt | null {
  try {
    const c = new Cursor(raw);
    const magic = c.take(OTS_MAGIC.length);
    if (!equalBytes(magic, OTS_MAGIC)) return null;
    if (c.byte() !== OTS_VERSION) return null;
    // Header: hash-op tag (1 byte) || raw digest — NOT varbytes. Only sha256
    // digests are produced or accepted here.
    if (c.byte() !== OP_SHA256) return null;
    const digest = c.take(32);

    let msg = digest;
    const attestations: OtsAttestation[] = [];
    let chainComplete = false;

    for (;;) {
      if (c.eof) { chainComplete = true; break; }
      const tag = c.byte();
      if (tag === 0x00) {
        attestations.push(parseAttestation(c, bytesToHex(msg)));
      } else if (tag === OP_APPEND) {
        msg = concatBytes(msg, c.varbytes());
      } else if (tag === OP_PREPEND) {
        msg = concatBytes(c.varbytes(), msg);
      } else if (tag === OP_SHA256) {
        msg = sha256(msg);
      } else if (tag === 0xff) {
        // Fork marker — calendars never emit this. Refuse, don't guess.
        return null;
      } else {
        // Unknown op (ripemd160, sha1, keccak, reverse, hexlify...) —
        // not produced by the calendars we use.
        return null;
      }
    }

    return {
      digestHex: bytesToHex(digest),
      attestations,
      chainComplete,
      finalMsgHex: bytesToHex(msg),
      rawBase64: bytesToBase64(raw),
    };
  } catch {
    return null;
  }
}

function detachedHeader(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error('ots: digest must be 32 bytes (sha256)');
  return concatBytes(OTS_MAGIC, new Uint8Array([OTS_VERSION, OP_SHA256]), digest);
}

/**
 * Wraps a calendar's BARE Timestamp response (what POST /digest and
 * GET /timestamp/{commitment} return on the wire) into a full
 * DetachedTimestampFile for `digest` — the shape we store, share, and parse.
 */
export function wrapBareTimestamp(digest: Uint8Array, timestamp: Uint8Array): Uint8Array {
  return concatBytes(detachedHeader(digest), timestamp);
}

/**
 * Normalizes a calendar response body to a DetachedTimestampFile: bodies
 * that already carry the MAGIC pass through; bare Timestamps get wrapped.
 * Returns null when the result does not parse or commits to another digest.
 */
export function ensureDetachedReceipt(digest: Uint8Array, body: Uint8Array): Uint8Array | null {
  const hasMagic =
    body.length >= OTS_MAGIC.length && equalBytes(body.subarray(0, OTS_MAGIC.length), OTS_MAGIC);
  const detached = hasMagic ? body : wrapBareTimestamp(digest, body);
  const parsed = parseOtsReceipt(detached);
  if (!parsed || parsed.digestHex !== bytesToHex(digest)) return null;
  return detached;
}

/**
 * Splits a stored (linear, fork-free) detached receipt into the op-chain
 * prefix — everything up to the first attestation marker — and the rest.
 * Used to splice a calendar's upgraded continuation onto our receipt.
 * Returns null when the receipt isn't the linear shape calendars produce.
 */
function splitLinearOpsPrefix(detached: Uint8Array): { headerOps: Uint8Array } | null {
  try {
    const headerLen = OTS_MAGIC.length + 2 + 32;
    const c = new Cursor(detached);
    c.pos = headerLen;
    for (;;) {
      const tagPos = c.pos;
      const tag = c.byte();
      if (tag === 0x00) {
        return { headerOps: detached.subarray(0, tagPos) };
      } else if (tag === OP_APPEND || tag === OP_PREPEND) {
        c.varbytes();
      } else if (tag === OP_SHA256) {
        // no payload
      } else {
        return null; // fork or unknown op — not the linear calendar shape
      }
    }
  } catch {
    return null;
  }
}

/**
 * Merges a calendar's upgraded continuation (bare Timestamp whose initial
 * msg is the commitment the pending attestation sits on) into our stored
 * detached receipt: our op chain (digest → commitment) spliced onto the
 * upgraded chain (commitment → Bitcoin attestation). The merged file is
 * re-parsed and must commit to `digest` and carry a Bitcoin attestation,
 * or null comes back and the stored pending receipt stays.
 */
export function mergeUpgradedTimestamp(
  storedDetached: Uint8Array,
  upgradedBareTimestamp: Uint8Array,
  digest: Uint8Array
): Uint8Array | null {
  const split = splitLinearOpsPrefix(storedDetached);
  if (!split) return null;
  const merged = concatBytes(split.headerOps, upgradedBareTimestamp);
  const parsed = parseOtsReceipt(merged);
  if (!parsed || parsed.digestHex !== bytesToHex(digest)) return null;
  if (!parsed.attestations.some((a) => a.kind === 'bitcoin')) return null;
  return merged;
}

/**
 * Builds a minimal receipt for `digest` carrying a pending attestation for
 * `calendarUri` — the shape calendars return at submit time (wrapped as a
 * DetachedTimestampFile, the way we store it). Used by tests and as a
 * documented model of the wire format; real receipts always come from the
 * calendars themselves.
 */
export function buildPendingReceipt(digest: Uint8Array, calendarUri: string): Uint8Array {
  // attestation node: 0x00 || tag(8 raw bytes) || varbytes(varbytes(uri))
  const uriBytes = utf8ToBytes(calendarUri);
  const payload = concatBytes(varuint(BigInt(uriBytes.length)), uriBytes);
  const node = concatBytes(new Uint8Array([0x00]), ATTEST_PENDING, varuint(BigInt(payload.length)), payload);
  return concatBytes(detachedHeader(digest), node);
}

function varuint(v: bigint): Uint8Array {
  const out: number[] = [];
  let x = v;
  do {
    let b = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) b |= 0x80;
    out.push(b);
  } while (x > 0n);
  return new Uint8Array(out);
}

/**
 * Verifies a receipt against the digest it should commit to. Internal checks
 * always run; the block-header binding check runs only when a header is
 * provided (it requires network to fetch — see otsClient.fetchBlockHeader).
 */
export interface OtsVerification {
  /** Receipt parses and its op chain starts at our digest. */
  receiptValid: boolean;
  reason: string | null;
  state: 'pending' | 'confirmed' | 'unverifiable';
  blockHeight: number | null;
  /** Only set when a block header was supplied and matched. */
  blockBindingChecked: boolean;
  blockBindingValid: boolean | null;
}

export function verifyOtsReceipt(
  raw: Uint8Array,
  expectedDigest: Uint8Array,
  blockHeader?: Uint8Array | null
): OtsVerification {
  const fail = (reason: string): OtsVerification =>
    ({ receiptValid: false, reason, state: 'unverifiable', blockHeight: null, blockBindingChecked: false, blockBindingValid: null });

  const parsed = parseOtsReceipt(raw);
  if (!parsed) return fail('receipt is malformed or uses an unsupported op');
  if (!parsed.chainComplete) return fail('receipt op chain is truncated');
  if (!equalBytes(base64ToBytes(parsed.rawBase64), raw)) return fail('receipt round-trip mismatch');
  const digestBytes = expectedDigest;
  if (parsed.digestHex !== bytesToHex(digestBytes)) {
    return fail('receipt commits to a different digest than this signature');
  }

  const btc = parsed.attestations.find(a => a.kind === 'bitcoin');
  const pending = parsed.attestations.find(a => a.kind === 'pending');
  if (!btc && !pending) return fail('receipt carries no usable attestation');

  if (!btc) {
    return {
      receiptValid: true,
      reason: null,
      state: 'pending',
      blockHeight: null,
      blockBindingChecked: false,
      blockBindingValid: null,
    };
  }

  const height = btc.blockHeight!;
  if (blockHeader == null) {
    return {
      receiptValid: true,
      reason: null,
      state: 'confirmed',
      blockHeight: height,
      blockBindingChecked: false,
      blockBindingValid: null,
    };
  }
  if (blockHeader.length !== 80) return fail('block header must be exactly 80 bytes');
  // The header arrives in Bitcoin WIRE format (esplora /block/{hash}/header),
  // and its Merkle-root field (bytes 36..68) equals the receipt's final msg
  // byte-for-byte — verified empirically against the OTS docs' receipt and
  // real block 428648 (0.18.1). (The reference JS library reverses the msg
  // only because its parsed header object stores the root pre-reversed.)
  const merkleRoot = blockHeader.subarray(36, 68);
  const ok = bytesToHex(merkleRoot) === btc.msgHex;
  return {
    receiptValid: true,
    reason: ok ? null : 'receipt Merkle root does not match the block header',
    state: ok ? 'confirmed' : 'unverifiable',
    blockHeight: height,
    blockBindingChecked: true,
    blockBindingValid: ok,
  };
}
