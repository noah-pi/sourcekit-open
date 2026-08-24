// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * RFC 3161 trusted-timestamp client.
 *
 * A Time Stamp Authority countersigns the COSE signature (message imprint =
 * SHA-256 of the CBOR-encoded signature bytes, per the C2PA V1 timestamp
 * storage spec). The TimeStampToken is embedded in the COSE unprotected
 * header under "sigTst", bounding the signature's time independently of the
 * device clock.
 *
 * If the TSA is unreachable the photo is signed without a timestamp and the
 * record says so (see telemetry).
 */

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from './bytes';

/** Witness pool: independent TSAs asked to countersign every signature, so a
 * single TSA being down or distrusted still leaves the time bounded. Override
 * with setTsaUrls for organization-run authorities. */
export const TSA_URLS = ['https://timestamp.digicert.com', 'https://freetsa.org/tsr'];
const TIMEOUT_MS = 8000;

/** TSA pool override. Settings injects it at load; TSA_URLS is the default. */
let tsaUrlsOverride: string[] | null = null;
export function setTsaUrls(urls: string[] | null): void {
  tsaUrlsOverride = urls && urls.length > 0 ? urls : null;
}
function activeTsaUrls(): string[] {
  return tsaUrlsOverride ?? TSA_URLS;
}

/**
 * The active witness pool in fallback order, for signers that try more than
 * one endpoint per capture. The hand-rolled path has always iterated it; the
 * SDK arm loops the same pool through its loopback relay, so one authority
 * being unreachable from a given network cannot cost the countersignature
 * while another answers.
 */
export function configuredTsaUrls(): string[] {
  return activeTsaUrls();
}

function derLen(n: number): Uint8Array {
  if (n < 128) return new Uint8Array([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLen(content.length), content);
}
const seq = (...c: Uint8Array[]) => tlv(0x30, concatBytes(...c));

const OID_SHA256 = new Uint8Array([0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01]);
const NULL = new Uint8Array([0x05, 0x00]);

/** TimeStampReq::= SEQUENCE { version 1, messageImprint, certReq TRUE }. */
export function buildTimestampRequest(message: Uint8Array): Uint8Array {
  return seq(
    tlv(0x02, new Uint8Array([1])),
    seq(seq(tlv(0x06, OID_SHA256), NULL), tlv(0x04, sha256(message))),
    tlv(0x01, new Uint8Array([0xff]))
  );
}

/** Extracts the TimeStampToken ContentInfo from a TimeStampResp. */
export function extractTimestampToken(resp: Uint8Array): Uint8Array {
  if (resp[0] !== 0x30) throw new Error('bad TimeStampResp');
  let i = 1;
  if (resp[i] & 0x80) i += (resp[i] & 0x7f) + 1; else i += 1;
  const lenAt = (o: number): number => {
    if (resp[o] & 0x80) {
      const n = resp[o] & 0x7f;
      let len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | resp[o + 1 + k];
      return 1 + n + len; // length-field bytes + content bytes
    }
    return 1 + resp[o];
  };
  const tokenStart = i + 1 + lenAt(i + 1); // skip status SEQUENCE (tag + len + content)
  return resp.subarray(tokenStart, tokenStart + 1 + lenAt(tokenStart + 1));
}

/** Fetches a TimeStampToken for `message`, trying each TSA in order. Returns null if all fail (offline). */
export async function fetchTimestampToken(message: Uint8Array): Promise<Uint8Array | null> {
  for (const tsaUrl of activeTsaUrls()) {
    const token = await fetchFromTsa(message, tsaUrl);
    if (token) return token;
  }
  return null;
}

/**
 * Witness cosigning: asks every TSA in the pool concurrently and keeps every
 * token returned. All are embedded in the C2PA tstTokens array. Returns []
 * when fully offline.
 */
export async function fetchTimestampTokens(message: Uint8Array): Promise<Uint8Array[]> {
  const results = await Promise.all(activeTsaUrls().map((u) => fetchFromTsa(message, u)));
  return results.filter((t): t is Uint8Array => t !== null && t.length > 0);
}

// --- Seal-latency machinery ---------------------------------------
//
// Token size is TSA-fixed (same signer chain, same 32-byte imprint), so the
// manifest builder sizes its layout from the last token length each TSA sent
// instead of probing the network. The first-run estimate is generous so drift
// runs downward into padding; upward drift would overflow after signing.
const DEFAULT_TOKEN_ESTIMATE = 6144;
const tokenSizes = new Map<string, number>();

/** Last observed token length per active TSA (session-scoped). */
export function estimatedTsaTokenSizes(): number[] {
  return activeTsaUrls().map((u) => tokenSizes.get(u) ?? DEFAULT_TOKEN_ESTIMATE);
}

/**
 * The seal path's fetcher: same witness pool as fetchTimestampTokens, bounded
 * by a deadline so a slow TSA cannot delay the shutter. The deadline caps the
 * wait, not the harvest: tokens arriving before it are kept. On a full miss
 * the seal ships without a TSA countersign; in-flight fetches finish, update
 * the size cache, and are discarded.
 */
export async function fetchTimestampTokensBounded(
  message: Uint8Array,
  deadlineMs = 1500,
): Promise<Uint8Array[]> {
  const urls = activeTsaUrls();
  const tokens: Uint8Array[] = [];
  let settled = 0;
  const allSettled = new Promise<void>((resolve) => {
    if (urls.length === 0) resolve();
    for (const url of urls) {
      fetchFromTsa(message, url)
        .then((t) => { if (t && t.length > 0) tokens.push(t); })
        .catch(() => { /* fetchFromTsa already swallows; belt-and-braces */ })
        .finally(() => { if (++settled === urls.length) resolve(); });
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  await Promise.race([allSettled, deadline]);
  if (timer) clearTimeout(timer);
  return tokens;
}

async function fetchFromTsa(message: Uint8Array, tsaUrl: string): Promise<Uint8Array | null> {
  try {
    const body = buildTimestampRequest(message);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(tsaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/timestamp-query' },
        body: body.buffer as ArrayBuffer,
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const resp = new Uint8Array(await res.arrayBuffer());
      const token = extractTimestampToken(resp);
      if (token.length > 0) tokenSizes.set(tsaUrl, token.length); // feeds estimatedTsaTokenSizes
      return token.length > 0 ? token : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null; // offline, TSA down, or timeout; capture proceeds without it
  }
}
