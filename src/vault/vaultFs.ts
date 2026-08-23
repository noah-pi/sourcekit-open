// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The encrypted vault.
 *
 * Layout (app sandbox, additionally encrypted by iOS Data Protection):
 *   vault/
 *     index.json          item metadata (ids, kinds, hashes, signer fingerprint,
 *                         capture timestamps, hasLocation, phash; no media, no
 *                         coordinates). Plaintext: sealing it without atomic
 *                         writes risks an empty-read overwrite destroying the
 *                         index. A sealed, AAD-bound v2 format is the intended
 *                         successor.
 *     {id}.bin            AES-256-GCM encrypted media bytes
 *     {id}.att.json       attestation record, AES-256-GCM encrypted (it carries
 *                         location/byline, so it gets the same protection as media)
 *
 * The 256-bit vault key is random, lives only in the OS keychain, and is
 * unrelated to the passcode (see passcode.ts). Viewing an item decrypts it to
 * a cache folder wiped on lock and on background.
 *
 * Sibling store: documentDirectory/disclosure/ holds the per-item disclosure
 * state ({id}.json, sealed, master seed until burn) and chunk maps
 * ({id}.chunks.json, sealed). It sits outside vault/, so deleteItem and
 * destroyVault must clear it: a delete that strands the disclosure state
 * leaves behind the master seed that can open withheld rungs.
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as SecureStore from 'expo-secure-store';
import * as ImageManipulator from 'expo-image-manipulator';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { decode as jpegDecode } from 'jpeg-js';
import { pHashFromGray32 } from '../lib/phash';
import { randomBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { encryptBytes, decryptBytes } from '../lib/cipher';
import { readFileBytes, writeFileBytes } from '../lib/fileHash';
import { utf8ToBytes, bytesToUtf8, base64ToBytes, bytesToBase64, bytesToHex } from '../lib/bytes';
import type { AttestationRecord } from '../provenance/manifest';

const KEY_STORE = 'verify_vault_key_v1';
/**
 * With the app lock set, the vault key moves behind the OS keychain's access
 * control (requireAuthentication → kSecAccessControlUserPresence), so iOS
 * demands Face ID or the device passcode before any process can read it. The
 * app-layer PIN and escalating lockout are the first gate; this is the second.
 *
 * Two storage keys, not one: expo-secure-store cannot tell "no item" from
 * "user cancelled the prompt" (both read null), so a single-key design could
 * regenerate over a locked key and brick the vault. The ACL flag decides which
 * key is authoritative, and a missing ACL key is a hard lock.
 *
 * The presence prompt gates the keychain read only. After the first
 * authenticated read the key is cached in process memory (keyCache) so
 * background sealing can run in windows where no prompt can appear; the cache
 * is dropped on background/lock once no seal is mid-write
 * (releaseVaultKeyIfIdle and the in-flight counter below).
 */
const KEY_STORE_ACL = 'verify_vault_key_acl_v1';
const ACL_FLAG = 'verify_vault_key_aclflag_v1';

const VAULT_DIR = `${FileSystem.documentDirectory}vault/`;
const INDEX_FILE = `${VAULT_DIR}index.json`;
const PLAIN_CACHE = `${FileSystem.cacheDirectory}verify-plain/`;
// sealQueue.DISC_DIR, inlined to avoid a circular import (sealQueue imports
// us). The disclosure store's per-item state and chunk maps.
const DISCLOSURE_DIR = `${FileSystem.documentDirectory}disclosure/`;

const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const ACL_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: true,
  // A cold-cache ACL read can happen at any moment (a grid thumbnail decrypt,
  // the background seal pump), so the prompt carries a message: an unexplained
  // system Face ID prompt gets ignored or cancelled, wedging the read.
  authenticationPrompt: 'Unlock your Source Kit vault',
};

/**
 * The canonical vault-lock failure. expo-secure-store surfaces a cancelled or
 * system-cancelled presence prompt as either a null read or a rejection, so
 * both are normalized to this error at the single read site and callers (the
 * seal pump especially) match one stable signature.
 */
export const VAULT_LOCKED_MESSAGE =
  'Vault is locked; device authentication is required to read the vault key.';

export function isVaultLockedError(e: unknown): boolean {
  return e instanceof Error && e.message === VAULT_LOCKED_MESSAGE;
}

async function aclEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ACL_FLAG, KEY_OPTIONS)) === '1';
  } catch {
    return false;
  }
}

/**
 * Moves the vault key behind OS user-presence access control. Call right after
 * a successful unlock or passcode set, so the ACL write and read happen while
 * the user is present.
 */
export async function upgradeVaultKeyAcl(): Promise<void> {
  if (await aclEnabled()) return;
  const existing = await SecureStore.getItemAsync(KEY_STORE, KEY_OPTIONS);
  if (!existing) return; // no key yet — first creation honors the ACL path via hasPasscode()
  await SecureStore.setItemAsync(KEY_STORE_ACL, existing, ACL_OPTIONS);
  await SecureStore.deleteItemAsync(KEY_STORE, KEY_OPTIONS);
  await SecureStore.deleteItemAsync(KEY_STORE_ACL, KEY_OPTIONS);
  await SecureStore.deleteItemAsync(ACL_FLAG, KEY_OPTIONS);
  await SecureStore.setItemAsync(ACL_FLAG, '1', KEY_OPTIONS);
}

/** Removes the OS access-control requirement (app lock removed). */
export async function downgradeVaultKeyAcl(): Promise<void> {
  if (!(await aclEnabled())) return;
  const existing = await SecureStore.getItemAsync(KEY_STORE_ACL, ACL_OPTIONS);
  if (existing) {
    await SecureStore.setItemAsync(KEY_STORE, existing, KEY_OPTIONS);
  }
  await SecureStore.deleteItemAsync(KEY_STORE_ACL, KEY_OPTIONS);
  await SecureStore.deleteItemAsync(ACL_FLAG, KEY_OPTIONS);
}

export interface VaultIndexEntry {
  id: string;
  kind: 'photo' | 'video' | 'audio';
  createdAt: string;
  sha256: string;
  bytes: number;
  mime: string;
  fingerprint: string;
  motionVerdict: string | null;
  hasLocation: boolean;
  /**
   * Grid badge flags: what is embedded, shown on the exhibits grid. Computed at
   * seal time; older entries get them on first grid read via ensureEntryFlags,
   * backfilled from the record without decrypting media. Optional, for indexes
   * written before the field existed.
   *   sealed      — always true for vault items
   *   location    — GPS coordinates embedded
   *   identifying — byline, sensor log, transcript, face-check flag, or wifi claim
   */
  flags?: VaultFlags;
  /**
   * DCT perceptual hash, 16 hex chars. Stored only in the index (never signed,
   * never transmitted) for near-duplicate detection and sidecar
   * re-association; a match is a lead, not a verdict. Null for video and audio
   * and when the best-effort compute failed. The index is app-sandbox
   * plaintext, the same exposure class as the sha256 above.
   */
  phash: string | null;
}

/** Grid badge flags; see VaultIndexEntry.flags. */
export interface VaultFlags {
  sealed: true;
  location: boolean;
  identifying: boolean;
}

/**
 * Computes the badge flags from an attestation record: a projection of what
 * the record declares. `hints.transcript` carries the one fact the record does
 * not hold, since the transcript lives in the embedded manifest and badges
 * never decrypt media; a backfilled entry cannot see it and under-reports.
 */
export function computeFlags(record: AttestationRecord | null, hints?: { transcript?: boolean }): VaultFlags {
  const identity = record?.identity;
  const ctx = record?.context;
  const byline = !!(identity && identity !== 'redacted' && (identity.author || identity.organization));
  const evidence = ctx?.captureEvidence;
  // EvidencePath's third state is the string 'never-recorded', which the
  // typeof-string check would match, so exclude the sentinel explicitly.
  const sensorLog =
    (typeof evidence?.sensorLogPath === 'string' && evidence.sensorLogPath !== 'never-recorded') ||
    !!(ctx && (ctx.motion != null || ctx.poseTrace != null || ctx.pressureHPa != null || ctx.altitudeM != null || ctx.headingDeg != null));
  const faceCheck = record?.captureIntegrity?.biometricGatePassed != null;
  // Wifi counts only as an object claim: 'redacted', 'unavailable',
  // 'never-recorded', null and undefined all mean absent.
  const wifi = !!(ctx && typeof ctx.wifi === 'object' && ctx.wifi != null);
  return {
    sealed: true,
    location: !!(ctx && typeof ctx.location === 'object'),
    identifying: byline || sensorLog || faceCheck || wifi || hints?.transcript === true,
  };
}

/**
 * Index write mutex: index.json is rewritten whole by save/delete/backfill,
 * and concurrent read-modify-write cycles could lose an entry. Every mutation
 * funnels through this promise chain, so a read that feeds a write sees the
 * previous write.
 */
let indexQueue: Promise<unknown> = Promise.resolve();

function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexQueue.then(fn, fn);
  indexQueue = next.catch(() => {});
  return next;
}

/** In-memory backfill cache: one record read and one index write per entry. */
const flagsCache = new Map<string, VaultFlags>();

/**
 * Session-scope negative cache: ids whose record read failed or is missing or
 * corrupt, so a grid remount does not re-run the vault-key decrypt against a
 * record that cannot parse. Cleared by destroyVault and deleteItem.
 */
const recordMissCache = new Set<string>();

/**
 * Lazy backfill: an entry with no flags gets them computed once from the
 * record on grid render, persisted into the index and cached in memory. Media
 * is never decrypted for a badge.
 */
export async function ensureEntryFlags(entry: VaultIndexEntry): Promise<VaultFlags | null> {
  if (entry.flags) return entry.flags;
  const cached = flagsCache.get(entry.id);
  if (cached) return cached;
  if (recordMissCache.has(entry.id)) return null; // known-missing — don't re-decrypt on every remount
  const rec = await getRecord(entry.id).catch(() => null);
  if (!rec) {
    recordMissCache.add(entry.id);
    return null;
  }
  const flags = computeFlags(rec);
  flagsCache.set(entry.id, flags);
  try {
    // Read-modify-write inside the index lock: the merge must see the newest
    // index, and its write must land before the next mutation reads.
    await withIndexLock(async () => {
      const items = await readIndex();
      const i = items.findIndex((x) => x.id === entry.id);
      if (i >= 0 && !items[i].flags) {
        items[i] = { ...items[i], flags };
        await writeIndex(items);
      }
    });
  } catch {
    // Persisting is best-effort; the in-memory cache still serves this session.
  }
  return flags;
}

let keyCache: Uint8Array | null = null;

/**
 * In-flight seal counter: the cached vault key is dropped on
 * background/lock only when no seal is mid-write. Otherwise the seal queue's
 * next getVaultKey() would need a fresh keychain read, which under ACL is a
 * user-presence prompt, in a background window where no prompt can appear.
 * Incremented and decremented inside the seal entry points (sealVaultJson,
 * sealVaultBytes, saveItem).
 */
let inFlightSeals = 0;

/**
 * Drops the cached vault key when no seal is in flight. Called from the
 * lock/background path (app/_layout.tsx); with a seal running the key stays
 * until that work finishes, which the lock screen states.
 */
export function releaseVaultKeyIfIdle(): void {
  if (inFlightSeals === 0) keyCache = null;
}

/**
 * Primes keyCache under fresh user presence; call it from the unlock path,
 * where the user just authenticated. Otherwise the session's first vault read
 * lands wherever it happens — a grid thumbnail decrypt, a background seal job
 * — and the OS presence prompt appears at that arbitrary moment, where an
 * ignored prompt wedges the seal pump and a cancelled one burns seal attempts.
 * Best-effort: a cancelled warm leaves the vault cold and the next real read
 * prompts again.
 */
export async function warmVaultKey(): Promise<boolean> {
  try {
    await getVaultKey();
    return true;
  } catch {
    return false;
  }
}

async function getVaultKey(): Promise<Uint8Array> {
  if (keyCache) return keyCache;
  if (await aclEnabled()) {
    // Every failure of this read (user cancel, system cancel,
    // interaction-not-allowed in a background window) is the same state: the
    // key is unreadable now. All become VAULT_LOCKED_MESSAGE so the seal pump
    // can defer instead of dying on a raw keychain error string.
    let aclExisting: string | null = null;
    try {
      aclExisting = await SecureStore.getItemAsync(KEY_STORE_ACL, ACL_OPTIONS);
    } catch {
      aclExisting = null;
    }
    if (!aclExisting) {
      // Auth cancelled or item unreadable: a hard lock. Do not regenerate;
      // regenerating over a locked key bricks the existing vault.
      throw new Error(VAULT_LOCKED_MESSAGE);
    }
    const key = base64ToBytes(aclExisting);
    keyCache = key;
    return key;
  }
  const existing = await SecureStore.getItemAsync(KEY_STORE, KEY_OPTIONS);
  if (existing) {
    const key = base64ToBytes(existing);
    keyCache = key;
    return key;
  }
  const fresh = randomBytes(32);
  // Fresh vault on a device whose app lock is already set: create under ACL.
  const { hasPasscode } = await import('./passcode');
  if (await hasPasscode().catch(() => false)) {
    await SecureStore.setItemAsync(KEY_STORE_ACL, bytesToBase64(fresh), ACL_OPTIONS);
    await SecureStore.setItemAsync(ACL_FLAG, '1', KEY_OPTIONS);
  } else {
    await SecureStore.setItemAsync(KEY_STORE, bytesToBase64(fresh), KEY_OPTIONS);
  }
  keyCache = fresh;
  return fresh;
}

/**
 * At-rest privacy for metadata that identifies the signer: the sidecar JSON
 * (location, byline, transcript) is sealed with the same keychain-held vault
 * key as the media rather than sitting plaintext in a backup-able directory.
 * Reads fall back to plaintext for vaults written before sealing.
 */
export async function sealVaultJson(value: unknown): Promise<Uint8Array> {
  inFlightSeals++;
  try {
    return encryptBytes(await getVaultKey(), utf8ToBytes(JSON.stringify(value)));
  } finally {
    inFlightSeals--;
  }
}

/** Decrypts a value written by sealVaultJson. Returns null on any failure. */
export async function unsealVaultJson<T>(bytes: Uint8Array): Promise<T | null> {
  try {
    return JSON.parse(bytesToUtf8(decryptBytes(await getVaultKey(), bytes))) as T;
  } catch {
    return null;
  }
}

/** Raw-bytes variants, for media drafts (seal queue) where JSON is wrong. */
export async function sealVaultBytes(bytes: Uint8Array): Promise<Uint8Array> {
  inFlightSeals++;
  try {
    return encryptBytes(await getVaultKey(), bytes);
  } finally {
    inFlightSeals--;
  }
}

/** Decrypts a blob written by sealVaultBytes. Returns null on any failure. */
export async function unsealVaultBytes(blob: Uint8Array): Promise<Uint8Array | null> {
  try {
    return decryptBytes(await getVaultKey(), blob);
  } catch {
    return null;
  }
}

/**
 * A path inside the plain cache, the directory _layout wipes on lock,
 * background, and cold start. Transient working copies only.
 */
export function plainWorkUri(name: string): string {
  return `${PLAIN_CACHE}${name}`;
}

export async function ensureVaultDirs(): Promise<void> {
  for (const dir of [VAULT_DIR, PLAIN_CACHE]) {
    const info = await FileSystem.getInfoAsync(dir);
    if (!info.exists) await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  }
}

/**
 * Thrown when index.json exists but cannot be read or parsed (a torn write,
 * truncation, or an unknown format). Distinct from a missing index, which
 * reads as empty. Every save path funnels its read-modify-write through
 * readIndex, so this error refuses the write; persisting an empty-looking read
 * over a corrupted index would orphan every record in the vault. Recovery is
 * rebuildIndexFromRecords().
 */
export class VaultIndexCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultIndexCorruptedError';
  }
}

async function readIndex(): Promise<VaultIndexEntry[]> {
  const info = await FileSystem.getInfoAsync(INDEX_FILE);
  if (!info.exists) return []; // fresh vault — missing is empty, not an error
  let raw: string;
  try {
    raw = await FileSystem.readAsStringAsync(INDEX_FILE);
  } catch (e) {
    throw new VaultIndexCorruptedError(`vault index exists but could not be read: ${String(e)}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.items)) return parsed.items;
  } catch {
    // Fall through: an unparseable index is corruption, not emptiness.
  }
  throw new VaultIndexCorruptedError('vault index is corrupted; refusing to read it as empty');
}

async function writeIndex(items: VaultIndexEntry[]): Promise<void> {
  // Atomic write: serialize to a temp file, then rename. Rename is atomic on
  // APFS, so a crash mid-save strands a leftover .tmp, overwritten by the next
  // save, instead of tearing index.json.
  const tmp = `${INDEX_FILE}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify({ items }));
  await FileSystem.moveAsync({ from: tmp, to: INDEX_FILE });
}

/**
 * Brief-notice subscription: fires when the vault repaired itself, currently
 * only an automatic index rebuild after a VaultIndexCorruptedError. The tab
 * chrome renders it as a short banner.
 */
type VaultNoticeListener = (message: string) => void;
const vaultNoticeListeners = new Set<VaultNoticeListener>();
export function subscribeVaultNotices(cb: VaultNoticeListener): () => void {
  vaultNoticeListeners.add(cb);
  return () => {
    vaultNoticeListeners.delete(cb);
  };
}

export async function listItems(): Promise<VaultIndexEntry[]> {
  let items: VaultIndexEntry[];
  try {
    items = await readIndex();
  } catch (e) {
    if (!(e instanceof VaultIndexCorruptedError)) throw e;
    // Self-repair: a corrupted index fails the vault closed (reads throw,
    // writes refuse), so rebuild from the sealed records on disk and re-read.
    // If the rebuild fails, the original corruption error stands and nothing
    // is written over it.
    await rebuildIndexFromRecords();
    items = await readIndex();
    vaultNoticeListeners.forEach((l) => l('Collection index repaired from sealed records.'));
  }
  return items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export interface SaveItemParams {
  kind: 'photo' | 'video' | 'audio';
  /** Signed media bytes, or a URI to read them from. */
  photoBytes?: Uint8Array;
  videoBytes?: Uint8Array;
  audioBytes?: Uint8Array;
  videoUri?: string;
  audioUri?: string;
  record: AttestationRecord;
  /**
   * Seal-time hint for the badge flags: an audio transcript lives in the
   * embedded manifest, not the record, so the seal queue is the only place
   * that knows it exists. Not re-derived from media later.
   */
  transcriptPresent?: boolean;
  /**
   * Audio "thumbnail": the first ~140 chars of the on-device transcript,
   * sealed beside the media so the grid can show words instead of a mic icon.
   * Absent when transcription was off.
   */
  transcriptSnippet?: string;
  /**
   * The capture-side depth artifact, sealed beside the media as
   * `${id}.depth.bin` with the same vault key, so it carries the media's
   * privacy contract. Its sha256 is committed pre-signing in the record
   * (context.depth) and in c2pa.hash.collection.data; this is the storage half
   * of that commitment. Best-effort: a write failure degrades to no depth
   * artifact and the collection-hash entry reads 'missing' at verification.
   */
  depthArtifact?: { path: string; mime: 'image/jpeg' | 'image/png'; sha256: string } | null;
}

export async function saveItem(params: SaveItemParams): Promise<VaultIndexEntry> {
  // In-flight for the whole save: a background/lock arriving mid-save
  // must not drop the key out from under the writes below.
  inFlightSeals++;
  try {
    await ensureVaultDirs();
    // Fail closed before writing any bytes: with a corrupted index this save
    // cannot commit, so do not write media or record files for an entry the
    // index will refuse.
    await readIndex();
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const key = await getVaultKey();

    const uri = params.videoUri ?? params.audioUri;
    const mediaBytes =
      params.photoBytes ?? params.videoBytes ?? params.audioBytes ?? (uri ? await readFileBytes(uri) : null);
    if (!mediaBytes) throw new Error('Nothing to save');

    const sealed = encryptBytes(key, mediaBytes);
    await writeFileBytes(`${VAULT_DIR}${id}.bin`, sealed);
    // The attestation record carries location/byline, so encrypt it like the media.
    await writeFileBytes(`${VAULT_DIR}${id}.att.json`, await sealVaultJson(params.record));

    // Grid thumbnail: a small JPEG sealed with the same vault key, so a vault
    // cell does not decrypt a multi-MB frame to show a ~120 pt square. The
    // whole block is best-effort; a thumbnail failure must not fail a save.
    let phash: string | null = null;
    if (params.kind === 'video' && uri) {
      // Video grid thumbnail: a frame ~0.5 s in, resized small and sealed with
      // the same vault key as photos use. Extraction reads the still-on-disk
      // draft at seal time; a failure degrades to the placeholder icon.
      try {
        const frame = await VideoThumbnails.getThumbnailAsync(uri, { time: 500 });
        const thumb = await ImageManipulator.manipulateAsync(frame.uri, [{ resize: { width: 512 } }], {
          compress: 0.7,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        });
        if (thumb.base64) {
          const thumbBytes = base64ToBytes(thumb.base64);
          await writeFileBytes(`${VAULT_DIR}${id}.thumb.bin`, encryptBytes(key, thumbBytes));
        }
        await FileSystem.deleteAsync(frame.uri, { idempotent: true }).catch(() => {});
      } catch {
        // Placeholder icon in the grid; this path is an optimization.
      }
    }
    // Seal the depth artifact beside the media (same key, same contract).
    // Its claimed hash is cross-checked first, so the vault stores what the
    // signature describes or nothing.
    if (params.kind === 'photo' && params.depthArtifact) {
      try {
        const d = params.depthArtifact;
        const uri = d.path.startsWith('file://') ? d.path : `file://${d.path}`;
        const bytes = await readFileBytes(uri);
        if (bytesToHex(sha256(bytes)) !== d.sha256.toLowerCase()) {
          throw new Error('depth artifact sha256 mismatch');
        }
        await writeFileBytes(`${VAULT_DIR}${id}.depth.bin`, encryptBytes(key, bytes));
      } catch {
        // No depth artifact in the vault: the collection-hash entry for
        // 'depth.*' reads as missing at verification.
      }
    }
    if (params.kind === 'audio' && params.transcriptSnippet) {
      // The audio "thumbnail" is words, not pixels: the start of the on-device
      // transcript, sealed like the media. Best-effort; the grid falls back to
      // the mic icon.
      try {
        await writeFileBytes(
          `${VAULT_DIR}${id}.snippet.bin`,
          encryptBytes(key, utf8ToBytes(params.transcriptSnippet)),
        );
      } catch {
        // best-effort
      }
    }
    if (params.kind === 'photo') {
      // The working copy is full-resolution plaintext. The file round-trip is
      // required: expo-image-manipulator resizes only from a file URI, and the
      // in-memory decode path (jpeg-js) reads baseline JPEG only, not the
      // HEIC/PNG sources that arrive. The copy lives in the plain cache
      // (shredded on lock/background/cold start) and is deleted in `finally`,
      // so a throw mid-thumbnail cannot strand it.
      const tmp = plainWorkUri(`thumb-src-${id}.jpg`);
      try {
        await writeFileBytes(tmp, mediaBytes);
        const thumb = await ImageManipulator.manipulateAsync(tmp, [{ resize: { width: 512 } }], {
          compress: 0.7,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        });
        // pHash: a 32×32 grayscale reduction, DCT hash, 8 bytes in the index.
        // Best-effort, null on failure. The durable copy is the one computed
        // pre-signing in the attest path (attest.ts photoPhashHex) and
        // committed under the COSE claim as c2pa.soft-binding; this one is a
        // cross-check plus the vault index's near-duplicate key.
        const tiny = await ImageManipulator.manipulateAsync(tmp, [{ resize: { width: 32, height: 32 } }], {
          compress: 0.9,
          format: ImageManipulator.SaveFormat.JPEG,
          base64: true,
        });
        if (thumb.base64) {
          const thumbBytes = base64ToBytes(thumb.base64);
          await writeFileBytes(`${VAULT_DIR}${id}.thumb.bin`, encryptBytes(key, thumbBytes));
        }
        if (tiny.base64) {
          const tinyBytes = base64ToBytes(tiny.base64);
          // 32×32 RGBA is 4 KB, so 1 MB of decode headroom is ample and an
          // oversized JPEG dies here instead of ballooning memory mid-save.
          // useTArray: jpeg-js otherwise allocates via Buffer.alloc, which
          // does not exist under Hermes.
          const decoded = jpegDecode(tinyBytes, { maxMemoryUsageInMB: 1, useTArray: true });
          if (decoded.width === 32 && decoded.height === 32) {
            const rgba = decoded.data;
            const gray = new Uint8Array(32 * 32);
            for (let i = 0; i < gray.length; i++) {
              const o = i * 4;
              // ITU-R 601 luma, as the reference pHash implementations use.
              gray[i] = Math.round(rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114);
            }
            phash = pHashFromGray32(gray);
          }
        }
      } catch {
        // Thumbnail and pHash are optimizations: the grid falls back to the
        // full frame and the index records phash: null.
      } finally {
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      }
    }

    const entry: VaultIndexEntry = {
      id,
      kind: params.kind,
      createdAt: params.record.capturedAt,
      sha256: params.record.asset.sha256,
      bytes: params.record.asset.bytes,
      mime: params.record.asset.mime,
      fingerprint: params.record.signer.fingerprint,
      motionVerdict: params.record.context.motion?.verdict ?? null,
      hasLocation: typeof params.record.context.location === 'object',
      flags: computeFlags(params.record, { transcript: params.transcriptPresent === true }),
      phash,
    };
    // Index mutation serialized through the lock; the media/record/thumbnail
    // writes above are per-id files and race-free. On a corrupted index
    // readIndex throws VaultIndexCorruptedError and this save refuses.
    await withIndexLock(async () => {
      const items = await readIndex();
      items.push(entry);
      await writeIndex(items);
    });
    return entry;
  } finally {
    inFlightSeals--;
  }
}

export async function getRecord(id: string): Promise<AttestationRecord | null> {
  try {
    const bytes = await readFileBytes(`${VAULT_DIR}${id}.att.json`);
    // Sealed format first, plaintext fallback for older vaults.
    const sealed = await unsealVaultJson<AttestationRecord>(bytes);
    let parsed: unknown = sealed;
    if (!parsed) {
      try { parsed = JSON.parse(bytesToUtf8(bytes)); } catch { parsed = null; }
    }
    return (parsed as AttestationRecord | null)?.format === 'verify-attestation' ? (parsed as AttestationRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Re-writes an item's encrypted record through `mutate`. For data that arrives
 * after sealing, such as OTS receipt upgrades, which are excluded from the
 * signed payload so this cannot break the signature. Returns the updated
 * record, or null if the item is gone. Never throws.
 */
export async function updateRecord(
  id: string,
  mutate: (record: AttestationRecord) => AttestationRecord
): Promise<AttestationRecord | null> {
  try {
    const current = await getRecord(id);
    if (!current) return null;
    const next = mutate(current);
    await writeFileBytes(`${VAULT_DIR}${id}.att.json`, await sealVaultJson(next));
    return next;
  } catch {
    return null;
  }
}

/**
 * Rebuilds index.json from the vault's encrypted records: the recovery path
 * for a corrupted index (VaultIndexCorruptedError). Every `{id}.att.json` is
 * decrypted with the vault key and its entry re-derived from the record; one
 * that fails to decrypt or parse, or whose media file is gone, is skipped and
 * counted for the caller. Written atomically, like every index write. The
 * pHash lives only in the index, so rebuilt entries carry phash: null and lose
 * their near-duplicate leads.
 */
export async function rebuildIndexFromRecords(): Promise<{ rebuilt: number; skipped: number }> {
  await ensureVaultDirs();
  let names: string[] = [];
  try {
    names = await FileSystem.readDirectoryAsync(VAULT_DIR);
  } catch {
    // No vault dir at all: nothing to rebuild from, and the count says so.
  }
  const items: VaultIndexEntry[] = [];
  let skipped = 0;
  for (const name of names) {
    if (!name.endsWith('.att.json')) continue;
    const id = name.slice(0, -'.att.json'.length);
    try {
      const record = await getRecord(id);
      const media = await FileSystem.getInfoAsync(`${VAULT_DIR}${id}.bin`);
      const kind = record?.asset.kind;
      if (!record || !media.exists || (kind !== 'photo' && kind !== 'video' && kind !== 'audio')) {
        skipped++;
        continue;
      }
      items.push({
        id,
        kind,
        createdAt: record.capturedAt,
        sha256: record.asset.sha256,
        bytes: record.asset.bytes,
        mime: record.asset.mime,
        fingerprint: record.signer.fingerprint,
        motionVerdict: record.context.motion?.verdict ?? null,
        hasLocation: typeof record.context.location === 'object',
        flags: computeFlags(record),
        phash: null,
      });
    } catch {
      skipped++;
    }
  }
  await withIndexLock(async () => {
    await writeIndex(items);
  });
  return { rebuilt: items.length, skipped };
}

function extensionFor(entry: VaultIndexEntry): string {
  if (entry.kind === 'photo') return 'jpg';
  if (entry.kind === 'audio') return 'm4a';
  return 'mp4';
}

/** Decrypts an item into the ephemeral plain cache and returns its URI. */
export async function decryptItemToCache(id: string): Promise<string> {
  const items = await readIndex();
  const entry = items.find((i) => i.id === id);
  if (!entry) throw new Error('Item not found');
  const target = `${PLAIN_CACHE}${id}.${extensionFor(entry)}`;

  const info = await FileSystem.getInfoAsync(target);
  if (info.exists) return target;

  const sealed = await readFileBytes(`${VAULT_DIR}${id}.bin`);
  const plain = decryptBytes(await getVaultKey(), sealed);
  await writeFileBytes(target, plain);
  return target;
}

/**
 * In-memory map of id → decrypted thumbnail URI, so a cell remounting during a
 * scroll does not re-run the decrypt pipeline. A hit is validated against the
 * filesystem, since the plain cache is shredded on lock/background.
 */
const thumbUriCache = new Map<string, string>();

/**
 * Decrypts only the small sealed thumbnail (~25 KB) for grid display. An item
 * with no sealed thumbnail falls back to the full frame once, then caches like
 * any other.
 */
export async function decryptThumbToCache(id: string, opts?: { fallbackToFull?: boolean }): Promise<string> {
  const cached = thumbUriCache.get(id);
  if (cached) {
    const info = await FileSystem.getInfoAsync(cached);
    if (info.exists) return cached;
    thumbUriCache.delete(id);
  }

  const target = `${PLAIN_CACHE}${id}.thumb.jpg`;
  const onDisk = await FileSystem.getInfoAsync(target);
  if (onDisk.exists) {
    thumbUriCache.set(id, target);
    return target;
  }

  const sealedThumb = await FileSystem.getInfoAsync(`${VAULT_DIR}${id}.thumb.bin`);
  if (!sealedThumb.exists) {
    // The full-frame fallback is for photos only: a video has no
    // image-renderable full item, so video callers pass fallbackToFull:false
    // and take the placeholder icon rather than decrypt 200 MB.
    if (opts?.fallbackToFull === false) throw new Error('no sealed thumbnail');
    const full = await decryptItemToCache(id);
    thumbUriCache.set(id, full);
    return full;
  }

  const plain = decryptBytes(await getVaultKey(), await readFileBytes(`${VAULT_DIR}${id}.thumb.bin`));
  await writeFileBytes(target, plain);
  thumbUriCache.set(id, target);
  return target;
}

/**
 * Video thumbnail backfill: a video with no .thumb.bin gets one generated
 * lazily on first grid view. The media decrypts into the plain cache (shredded
 * on lock/background), one frame is grabbed ~0.5 s in, resized, and sealed
 * beside the media, becoming a normal sealed thumbnail. Returns the display
 * URI, or null when any step fails and the cell keeps its placeholder icon.
 * Never throws.
 */
export async function ensureVideoThumb(id: string): Promise<string | null> {
  try {
    const existing = await FileSystem.getInfoAsync(`${VAULT_DIR}${id}.thumb.bin`);
    if (existing.exists) return await decryptThumbToCache(id, { fallbackToFull: false });
    const media = await FileSystem.getInfoAsync(`${VAULT_DIR}${id}.bin`);
    if (!media.exists) return null;
    const key = await getVaultKey();
    const tmp = plainWorkUri(`thumb-vid-${id}.mp4`);
    try {
      await writeFileBytes(tmp, decryptBytes(key, await readFileBytes(`${VAULT_DIR}${id}.bin`)));
      const frame = await VideoThumbnails.getThumbnailAsync(tmp, { time: 500 });
      const thumb = await ImageManipulator.manipulateAsync(frame.uri, [{ resize: { width: 512 } }], {
        compress: 0.7,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      });
      await FileSystem.deleteAsync(frame.uri, { idempotent: true }).catch(() => {});
      if (!thumb.base64) return null;
      const thumbBytes = base64ToBytes(thumb.base64);
      await writeFileBytes(`${VAULT_DIR}${id}.thumb.bin`, encryptBytes(key, thumbBytes));
    } finally {
      // The plaintext video copy is deleted here even if the frame grab failed.
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    }
    return await decryptThumbToCache(id, { fallbackToFull: false });
  } catch {
    return null;
  }
}

/** In-memory snippet cache; same remount economics as the thumbnail cache. */
const snippetCache = new Map<string, string>();

/**
 * Decrypts the sealed audio transcript snippet for the grid. Null when the
 * item has none, and the cell renders the mic icon.
 */
export async function decryptAudioSnippet(id: string): Promise<string | null> {
  const cached = snippetCache.get(id);
  if (cached) return cached;
  const info = await FileSystem.getInfoAsync(`${VAULT_DIR}${id}.snippet.bin`);
  if (!info.exists) return null;
  try {
    const text = bytesToUtf8(decryptBytes(await getVaultKey(), await readFileBytes(`${VAULT_DIR}${id}.snippet.bin`)));
    snippetCache.set(id, text);
    return text;
  } catch {
    return null;
  }
}

/** Deletes every decrypted copy in the plain cache. Called on lock/background. */
export async function wipePlainCache(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(PLAIN_CACHE);
    if (info.exists) {
      await FileSystem.deleteAsync(PLAIN_CACHE, { idempotent: true });
      await FileSystem.makeDirectoryAsync(PLAIN_CACHE, { intermediates: true });
    }
  } catch {
    // Best effort; iOS clears cacheDirectory under pressure anyway.
  }
}

export async function deleteItem(id: string): Promise<void> {
  await withIndexLock(async () => {
    const items = await readIndex();
    await writeIndex(items.filter((i) => i.id !== id));
  });
  thumbUriCache.delete(id);
  snippetCache.delete(id);
  flagsCache.delete(id);
  recordMissCache.delete(id);
  await FileSystem.deleteAsync(`${VAULT_DIR}${id}.bin`, { idempotent: true });
  await FileSystem.deleteAsync(`${VAULT_DIR}${id}.att.json`, { idempotent: true });
  await FileSystem.deleteAsync(`${VAULT_DIR}${id}.thumb.bin`, { idempotent: true });
  await FileSystem.deleteAsync(`${VAULT_DIR}${id}.snippet.bin`, { idempotent: true });
  await FileSystem.deleteAsync(`${PLAIN_CACHE}${id}.thumb.jpg`, { idempotent: true });
  await FileSystem.deleteAsync(`${PLAIN_CACHE}${id}.jpg`, { idempotent: true });
  await FileSystem.deleteAsync(`${PLAIN_CACHE}${id}.mp4`, { idempotent: true });
  await FileSystem.deleteAsync(`${PLAIN_CACHE}${id}.m4a`, { idempotent: true });
  // Disclosure store: the item's disclosure state and chunk maps go with it.
  // Idempotent, since either may be absent.
  await FileSystem.deleteAsync(`${DISCLOSURE_DIR}${id}.json`, { idempotent: true });
  await FileSystem.deleteAsync(`${DISCLOSURE_DIR}${id}.chunks.json`, { idempotent: true });
}

/** Wipes vault contents, index, plain cache, seal-queue drafts, the disclosure store, and the vault key. */
export async function destroyVault(): Promise<void> {
  keyCache = null;
  thumbUriCache.clear();
  snippetCache.clear();
  flagsCache.clear();
  recordMissCache.clear();
  await FileSystem.deleteAsync(VAULT_DIR, { idempotent: true });
  await wipePlainCache();
  // sealQueue.DIR, inlined to avoid a circular import (sealQueue imports us).
  // Pending seal drafts are plaintext media and must not survive the wipe.
  await FileSystem.deleteAsync(`${FileSystem.documentDirectory}seal-queue/`, { idempotent: true });
  // Disclosure store: every item's disclosure state and chunk maps, including
  // any unburned master seeds, die with the vault.
  await FileSystem.deleteAsync(DISCLOSURE_DIR, { idempotent: true });
  await SecureStore.deleteItemAsync(KEY_STORE, KEY_OPTIONS);
  await SecureStore.deleteItemAsync(KEY_STORE_ACL, KEY_OPTIONS);
  await SecureStore.deleteItemAsync(ACL_FLAG, KEY_OPTIONS);
}
