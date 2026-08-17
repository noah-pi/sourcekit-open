/**
 * libraryStore — opt-in, per-item persistence for the library ("Keep in this
 * browser"). IndexedDB only; nothing here ever touches the network.
 *
 * Standing rules:
 *  - DEFAULT IS SESSION-ONLY. This module is called only for items the user
 *    explicitly pinned; everything else lives and dies with the tab.
 *  - FAIL CLOSED. Every method rejects on any storage failure — the caller
 *    (App) turns that into a plain-language notice. A half-restored library
 *    is never presented as complete.
 *  - HONEST SNAPSHOTS. The stored item is the DeskItem minus session-only
 *    fields: `bytes` (stored separately as the Blob the contract passes in)
 *    and `objectUrl` (a blob: URL dies with its session — persisting it
 *    would restore a dead preview and pretend otherwise).
 *
 * Schema: database `exhibit-c-library`, one object store `items`, key = the
 * item's id (via keyPath 'id'). Records: { id, item, bytes }.
 */
import type { DeskItem } from './deskItem';
import type { LibraryStore } from '../contracts';

const DB_NAME = 'exhibit-c-library';
const DB_VERSION = 1;
const STORE = 'items';

interface StoredRecord {
  id: string;
  item: DeskItem;
  bytes: Blob;
}

/** Plain-language error so every failure surfaces honestly, never silently. */
function fail(what: string, cause?: unknown): Error {
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : 'unknown reason';
  return new Error(`${what} (${detail})`);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(fail('This browser has no IndexedDB — kept items cannot be stored here'));
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      reject(fail('Could not open the kept-items store', e));
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(fail('Could not open the kept-items store', req.error));
    req.onblocked = () => reject(fail('The kept-items store is blocked by another tab'));
  });
}

/**
 * Run one transaction; resolve with the value `run` hands to `done`, and
 * reject (fail closed) unless the transaction commits cleanly. Individual
 * request errors abort the transaction, which onabort/onerror turns into a
 * rejection — no per-request handlers needed.
 */
function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, done: (value: T) => void) => void,
  what: string,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let value: T;
        let hasValue = false;
        const done = (v: T) => {
          value = v;
          hasValue = true;
        };
        let tx: IDBTransaction;
        try {
          tx = db.transaction(STORE, mode);
        } catch (e) {
          db.close();
          reject(fail(what, e));
          return;
        }
        tx.oncomplete = () => {
          db.close();
          if (hasValue) resolve(value);
          else reject(fail(what, 'the transaction finished without a result'));
        };
        tx.onerror = () => {
          db.close();
          reject(fail(what, tx.error));
        };
        tx.onabort = () => {
          db.close();
          reject(fail(what, tx.error ?? 'the transaction was aborted'));
        };
        try {
          run(tx.objectStore(STORE), done);
        } catch (e) {
          try { tx.abort(); } catch { /* already finished — oncomplete settles */ }
          reject(fail(what, e));
        }
      }),
  );
}

/**
 * The persistable snapshot: everything except session-only fields. `bytes`
 * travels separately (the contract's Blob parameter); `objectUrl` is a
 * per-session blob: URL and is dropped rather than restored dead;
 * `tier2Fx` is dropped too — those results carry big raster payloads and
 * are recomputable by design (the Forensics tab re-runs them on your
 * say-so), so pinning never multiplies storage with derived data.
 */
function snapshotOf(item: DeskItem): DeskItem {
  const { bytes: _bytes, objectUrl: _objectUrl, tier2Fx: _tier2Fx, ...rest } = item;
  return rest;
}

export const libraryStore: LibraryStore = {
  /** Every remembered entry. Throws unless the FULL set loads — fail closed. */
  loadAll(): Promise<Array<{ item: DeskItem; bytes: Blob }>> {
    return transact<Array<{ item: DeskItem; bytes: Blob }>>(
      'readonly',
      (store, done) => {
        const req = store.getAll();
        req.onsuccess = () =>
          done(((req.result as StoredRecord[] | undefined) ?? []).map((r) => ({ item: r.item, bytes: r.bytes })));
      },
      'Could not read the kept items',
    );
  },

  put(item: DeskItem, bytes: Blob): Promise<void> {
    const record: StoredRecord = { id: item.id, item: snapshotOf(item), bytes };
    return transact<void>(
      'readwrite',
      (store, done) => {
        store.put(record).onsuccess = () => done(undefined);
      },
      `Could not keep “${item.name}” in this browser`,
    );
  },

  remove(id: string): Promise<void> {
    return transact<void>(
      'readwrite',
      (store, done) => {
        store.delete(id).onsuccess = () => done(undefined);
      },
      'Could not forget a kept item',
    );
  },

  clear(): Promise<void> {
    return transact<void>(
      'readwrite',
      (store, done) => {
        store.clear().onsuccess = () => done(undefined);
      },
      'Could not forget the kept items',
    );
  },

  count(): Promise<number> {
    return transact<number>(
      'readonly',
      (store, done) => {
        store.count().onsuccess = (e) => done((e.target as IDBRequest<number>).result);
      },
      'Could not count the kept items',
    );
  },
};
