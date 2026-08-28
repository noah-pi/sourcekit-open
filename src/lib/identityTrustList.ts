// Source Kit 0.1.0 — anchors CAWG recognizes for identity signatures
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * identityTrustList — the anchors CAWG recognizes for an identity signature.
 *
 * CAWG evaluates identity against its own trust configuration, separate from
 * the trust list used for the claim signature. Under the interim model in
 * force until 31 March 2027 an X.509 identity signature is recognized when
 * its issuer chains to either:
 *
 *   • the Mozilla root store with the Email (S/MIME) trust bit, or
 *   • the IPTC Origin Verified News Publishers List.
 *
 * A certificate carrying the document-signing purpose needs no anchor at
 * all: the specification requires that purpose to be accepted and names no
 * trust anchors for it.
 *
 * Anchors are pinned by SHA-256 over the certificate DER, the same shape as
 * tsaTrustList. The pinned array below ships EMPTY on purpose: a fingerprint
 * is only ever computed from a published list, never written by hand, and
 * the published lists are fetched at runtime by refreshIdentityAnchors.
 * Until one is fetched, every issuer reads as self-asserted — which is the
 * honest report, not a failure.
 *
 * Mozilla's S/MIME roots are not fetched here. The list is large, it is not
 * published as one file, and iOS already carries an equivalent store; the
 * system evaluation is the right source for it and needs a native call this
 * module deliberately does not fake.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha256';
import { base64ToBytes, bytesToHex } from './bytes';

const CACHE_FILE = `${FileSystem.documentDirectory}identity-anchors.json`;
const FETCH_TIMEOUT_MS = 15_000;

/** Extended key purposes CAWG names for an X.509 identity signature. */
export const OID_KP_EMAIL_PROTECTION = '2b06010505070304'; // 1.3.6.1.5.5.7.3.4
export const OID_KP_DOCUMENT_SIGNING = '2b06010505070324'; // 1.3.6.1.5.5.7.3.36

export interface AnchorList {
  id: string;
  /** Shown to a person as the reason a certificate is recognized. */
  name: string;
  url: string;
}

export const ANCHOR_LISTS: AnchorList[] = [
  {
    id: 'iptc-publishers',
    name: 'IPTC Origin Verified News Publishers List',
    url: 'https://trust.iptc.org/anchor-list.pem',
  },
];

export interface PinnedAnchor {
  /** SHA-256 of the certificate DER, lowercase hex. */
  certSha256: string;
  /** The list it came from. */
  listId: string;
}

/**
 * Anchors compiled into the app. Empty: see the header — fingerprints come
 * from a published list, and no list is bundled.
 */
export const PINNED_IDENTITY_ANCHORS: PinnedAnchor[] = [];

interface AnchorCache {
  listId: string;
  fetchedAt: string;
  fingerprints: string[];
}

let cached: AnchorCache[] | null = null;

async function readCache(): Promise<AnchorCache[]> {
  if (cached) return cached;
  try {
    const info = await FileSystem.getInfoAsync(CACHE_FILE);
    if (info.exists) {
      const parsed = JSON.parse(await FileSystem.readAsStringAsync(CACHE_FILE)) as unknown;
      if (Array.isArray(parsed)) {
        cached = parsed.filter(
          (e): e is AnchorCache =>
            !!e &&
            typeof (e as AnchorCache).listId === 'string' &&
            typeof (e as AnchorCache).fetchedAt === 'string' &&
            Array.isArray((e as AnchorCache).fingerprints),
        );
        return cached;
      }
    }
  } catch {
    // A damaged cache is the same as no cache: nothing is recognized, which
    // fails toward self-asserted rather than toward a false Trusted.
  }
  cached = [];
  return cached;
}

/** Splits a PEM bundle into DER certificates. Ignores anything else in it. */
export function pemBundleToDer(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+?)-----END CERTIFICATE-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    try {
      out.push(base64ToBytes(m[1].replace(/\s+/g, '')));
    } catch {
      // One unreadable block does not spoil the list.
    }
  }
  return out;
}

export interface AnchorListState {
  list: AnchorList;
  count: number;
  /** ISO-8601, or null when the list has never been fetched on this device. */
  fetchedAt: string | null;
}

/** What Settings shows: which lists are carried, and how old each one is. */
export async function identityAnchorState(): Promise<AnchorListState[]> {
  const entries = await readCache();
  return ANCHOR_LISTS.map((list) => {
    const hit = entries.find((e) => e.listId === list.id);
    const pinned = PINNED_IDENTITY_ANCHORS.filter((a) => a.listId === list.id).length;
    return {
      list,
      count: (hit?.fingerprints.length ?? 0) + pinned,
      fetchedAt: hit?.fetchedAt ?? null,
    };
  });
}

/**
 * Fetches a published anchor list and caches the fingerprints it yields.
 * Returns how many anchors the list carried. Throws with a plain-English
 * reason: this runs behind a button, never silently.
 */
export async function refreshIdentityAnchors(listId = 'iptc-publishers'): Promise<AnchorListState> {
  const list = ANCHOR_LISTS.find((l) => l.id === listId);
  if (!list) throw new Error(`No anchor list called ${listId}.`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let text: string;
  try {
    const res = await fetch(list.url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${list.name} answered HTTP ${res.status}.`);
    text = await res.text();
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${list.name} did not answer in time.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const ders = pemBundleToDer(text);
  if (ders.length === 0) throw new Error(`${list.name} returned no certificates.`);
  const entry: AnchorCache = {
    listId: list.id,
    fetchedAt: new Date().toISOString(),
    fingerprints: ders.map((d) => bytesToHex(sha256(d))),
  };
  const entries = (await readCache()).filter((e) => e.listId !== list.id);
  entries.push(entry);
  cached = entries;
  await FileSystem.writeAsStringAsync(CACHE_FILE, JSON.stringify(entries));
  return { list, count: entry.fingerprints.length, fetchedAt: entry.fetchedAt };
}

/**
 * The list recognizing any certificate in `chainFingerprints`, or null.
 * Fingerprints are SHA-256 over each certificate's DER, signer first.
 */
export async function anchorListFor(chainFingerprints: string[]): Promise<AnchorList | null> {
  if (chainFingerprints.length === 0) return null;
  const seen = new Set(chainFingerprints.map((f) => f.toLowerCase()));
  const pinned = PINNED_IDENTITY_ANCHORS.find((a) => seen.has(a.certSha256));
  if (pinned) return ANCHOR_LISTS.find((l) => l.id === pinned.listId) ?? null;
  for (const entry of await readCache()) {
    if (entry.fingerprints.some((f) => seen.has(f.toLowerCase()))) {
      return ANCHOR_LISTS.find((l) => l.id === entry.listId) ?? null;
    }
  }
  return null;
}
