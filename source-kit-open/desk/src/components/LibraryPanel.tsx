// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * LibraryPanel — the main-pane media library (0.15.1).
 *
 * Grid/list views, sort, kind filters, text search, multi-select (checkboxes
 * and shift-range) with a single bulk action (remove), and per-item "Keep in
 * this browser" pins. Selecting a card opens that asset's dashboard; the
 * per-item "how we know this" export lives there — multi-select deliberately
 * offers remove only.
 *
 * Honesty discipline:
 *  - The state chip NEVER goes green here. Green means "intact AND signed by
 *    a key on your trust roster", and the roster lives in App state — this
 *    panel doesn't receive it, so an intact item reads "Integrity intact"
 *    in neutral gray and the dashboard says the rest.
 *  - An ordinary unsigned file is neutral, never red. Red/brick is reserved
 *    for "the bytes changed" or "the signature is invalid".
 *  - Kept (pinned) items persist in this browser's IndexedDB only — the copy
 *    next to the pin says so, every time.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type DeskItem, fmtBytes, isVideoBytes, videoMime } from '../core/deskItem';
import type { LibraryPanelProps } from '../contracts';
import '../library.css';

const KIND_LABEL: Record<DeskItem['kind'], string> = {
  media: 'Media',
  'proof-bundle': 'Proof bundle',
  'hash-claim': 'Hash claim',
  roster: 'Roster file',
  unknown: 'Unrecognized',
};

type SortKey = 'newest' | 'oldest' | 'name' | 'size' | 'kind' | 'state';
type KindFilter = 'all' | DeskItem['kind'];
type ViewMode = 'grid' | 'list';

/**
 * The panel's view/sort/filter/search state, liftable to App (ARCHITECTURE
 * §3.2) so "← Library" returns to the same view after an asset is opened.
 * When the host passes `viewState` + `onViewStateChange` the panel is
 * controlled; without them it falls back to its own state (unchanged
 * standalone behavior).
 */
export interface LibraryViewState {
  view: ViewMode;
  sort: SortKey;
  kindFilter: KindFilter;
  query: string;
}

export const DEFAULT_LIBRARY_VIEW: LibraryViewState = { view: 'grid', sort: 'newest', kindFilter: 'all', query: '' };

interface StateChip {
  tone: 'neutral' | 'warn' | 'danger';
  text: string;
}

/** Tri-state chip: attention (danger/warn) / neutral only — never green (see header). */
function stateChip(item: DeskItem): StateChip | null {
  if (item.kind === 'media' && item.report) {
    switch (item.report.verdict) {
      case 'INTACT': return { tone: 'neutral', text: 'Integrity intact' };
      case 'CONTENT_MODIFIED': return { tone: 'danger', text: 'Bytes changed' };
      case 'SIGNATURE_INVALID': return { tone: 'danger', text: 'Signature invalid' };
      case 'NO_ATTESTATION': return { tone: 'neutral', text: 'No credentials' };
      case 'UNSUPPORTED':
      case 'NOT_JPEG':
      case 'NOT_BMFF': return { tone: 'neutral', text: 'Unchecked' };
      case 'UNREADABLE': return { tone: 'warn', text: 'Unreadable' };
      default: return null;
    }
  }
  if (item.kind === 'unknown') return { tone: 'neutral', text: 'Unchecked' };
  // Proof bundles and hash claims are checked in App and reported on the
  // dashboard; the library shows their kind, not a state it doesn't have.
  return null;
}

/** Sort rank for "state": things that need a person first. */
function stateRank(item: DeskItem): number {
  const chip = stateChip(item);
  if (chip?.tone === 'danger' || chip?.tone === 'warn') return 0;
  if (item.kind === 'media' && item.report?.verdict === 'INTACT') return 1;
  if (chip) return 2;
  return 3;
}

const KIND_ORDER: Record<DeskItem['kind'], number> = {
  media: 0,
  'proof-bundle': 1,
  'hash-claim': 2,
  roster: 3,
  unknown: 4,
};

/** Byte size when the bytes are held; large videos / references say "—". */
function sizeOf(item: DeskItem): number | null {
  return item.bytes ? item.bytes.length : null;
}

function formatAdded(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const delta = Date.now() - ms;
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} h ago`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} d ago`;
  return new Date(ms).toLocaleDateString();
}

/**
 * Thumbnail: photos and held bytes get a per-card object URL (created lazily,
 * revoked on unmount); large videos play from their session object URL;
 * everything else gets a plain glyph tile. Object URLs are created ONLY for
 * cards on screen — never eagerly for the whole library.
 */
function Thumb({ item }: { item: DeskItem }) {
  const made = useMemo(() => {
    if (item.kind !== 'media') return null;
    if (item.objectUrl) return { url: item.objectUrl, mime: item.objectMime ?? 'video/mp4', owned: false };
    if (!item.bytes) return null;
    const mime = isVideoBytes(item.bytes)
      ? videoMime(item.bytes)
      : item.bytes[0] === 0xff ? 'image/jpeg' : 'image/png';
    return { url: URL.createObjectURL(new Blob([item.bytes as unknown as BlobPart], { type: mime })), mime, owned: true };
  }, [item]);

  useEffect(() => {
    return () => {
      if (made?.owned) URL.revokeObjectURL(made.url);
    };
  }, [made]);

  if (made) {
    return made.mime.startsWith('video/')
      ? <video className="lib-thumb-media" src={made.url} muted preload="metadata" />
      : <img className="lib-thumb-media" src={made.url} alt="" loading="lazy" />;
  }
  const glyph = item.kind === 'proof-bundle' ? '▤' : item.kind === 'hash-claim' ? '#' : '?';
  return <span className="lib-thumb-glyph" aria-hidden="true">{glyph}</span>;
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M9.5 1.8 14.2 6.5l-1.7.4-2 .8-1.5 3.1-1.1 2.7-1.4-1.4.9-2.5-3.9-3.9 1.4-2.6L7.6 2l1.9-.2zM3 12.5l3-3"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LibraryPanel(props: LibraryPanelProps & {
  viewState?: LibraryViewState;
  onViewStateChange?: (patch: Partial<LibraryViewState>) => void;
}) {
  const { items, selectedId, onSelect, onRemove, remembered, onToggleRemember } = props;
  const [inner, setInner] = useState<LibraryViewState>(DEFAULT_LIBRARY_VIEW);
  const { view, sort, kindFilter, query } = props.viewState ?? inner;
  const patchView = (patch: Partial<LibraryViewState>) => {
    setInner((prev) => ({ ...prev, ...patch }));
    props.onViewStateChange?.(patch);
  };
  const setView = (view: ViewMode) => patchView({ view });
  const setSort = (sort: SortKey) => patchView({ sort });
  const setKindFilter = (kindFilter: KindFilter) => patchView({ kindFilter });
  const setQuery = (query: string) => patchView({ query });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<number | null>(null);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // G39: names match by substring; hashes/fingerprints match by PREFIX —
    // you paste what you have, and a prefix never over-matches a digest.
    const prefixMatch = (v: string | null | undefined): boolean =>
      !!v && q.length >= 4 && v.toLowerCase().startsWith(q);
    const filtered = items.filter((i) =>
      (kindFilter === 'all' || i.kind === kindFilter) &&
      (q === '' || i.name.toLowerCase().includes(q) ||
        prefixMatch(i.sha256Hex) || prefixMatch(i.pHash) ||
        prefixMatch(i.report?.c2pa?.signerFingerprint) ||
        prefixMatch(i.bundle?.record?.signer?.fingerprint) ||
        prefixMatch(i.claim?.signerFingerprint)),
    );
    const byName = (a: DeskItem, b: DeskItem) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const sorted = [...filtered];
    switch (sort) {
      case 'newest': sorted.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)); break;
      case 'oldest': sorted.sort((a, b) => (a.addedAt ?? 0) - (b.addedAt ?? 0)); break;
      case 'name': sorted.sort(byName); break;
      case 'size': sorted.sort((a, b) => (sizeOf(b) ?? -1) - (sizeOf(a) ?? -1)); break;
      case 'kind': sorted.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || byName(a, b)); break;
      case 'state': sorted.sort((a, b) => stateRank(a) - stateRank(b) || byName(a, b)); break;
    }
    return sorted;
  }, [items, kindFilter, query, sort]);

  // Selection never outlives the items it points at.
  const livePicked = useMemo(() => {
    const ids = new Set(items.map((i) => i.id));
    return new Set([...picked].filter((id) => ids.has(id)));
  }, [picked, items]);

  /* F35 (§6/§7): the one-shot amber-hex dissolve when a newly-intaken item
     lands in the grid — brand identity only, never a signal. Fired item ids
     are tracked in a ref, so re-renders, sorts, filters, and restores never
     re-trigger it; the class is removed after the 400ms animation. */
  const seenIdsRef = useRef<Set<string> | null>(null);
  const [landing, setLanding] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const ids = items.map((i) => i.id);
    if (seenIdsRef.current === null) {
      // First paint: everything already here (including kept items restored
      // from storage) is not "landing" — no dissolve on load.
      seenIdsRef.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seenIdsRef.current!.has(id));
    for (const id of ids) seenIdsRef.current.add(id);
    if (fresh.length === 0) return;
    setLanding((prev) => new Set([...prev, ...fresh]));
    // No cleanup on re-run: each batch's timeout must still fire so its ids
    // leave the set even when the next intake lands mid-animation. On unmount
    // the trailing setState is a no-op.
    window.setTimeout(() => {
      setLanding((prev) => {
        const next = new Set(prev);
        for (const id of fresh) next.delete(id);
        return next;
      });
    }, 450);
  }, [items]);

  function togglePick(id: string, index: number, shiftKey: boolean) {
    const next = new Set(livePicked);
    if (shiftKey && anchorRef.current !== null && anchorRef.current !== index) {
      const [lo, hi] = [Math.min(anchorRef.current, index), Math.max(anchorRef.current, index)];
      for (let i = lo; i <= hi; i++) next.add(visible[i].id);
    } else if (next.has(id)) {
      next.delete(id);
      anchorRef.current = index;
    } else {
      next.add(id);
      anchorRef.current = index;
    }
    setPicked(next);
  }

  function removePicked() {
    onRemove([...livePicked]);
    setPicked(new Set());
    anchorRef.current = null;
  }

  // ---------------------------------------------------------------
  // Empty library: teach, and show what a check looks like (example only).
  // ---------------------------------------------------------------
  const kindCounts = useMemo(() => {
    const counts = new Map<DeskItem['kind'], number>();
    for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
    return counts;
  }, [items]);

  if (items.length === 0) {
    return (
      <div className="lib-empty">
        <p className="lib-empty-lead">
          Drop a photo, clip, proof bundle, or hash claim. Everything is checked
          here, in this tab — the files never go anywhere.
        </p>
        <div className="lib-sample">
          <div className="lib-sample-label">Example — what a check looks like</div>
          <div className="lib-sample-row">
            <span className="lib-chip info">Declared</span>
            <span>“Captured 2025-07-14 09:31, device key 4f2a…9c” — declared by the sealing software</span>
          </div>
          <div className="lib-sample-row">
            <span className="lib-chip neutral">Integrity intact</span>
            <span>The bytes match what was signed — the signer is not on your trusted roster</span>
          </div>
          <div className="lib-sample-row">
            <span className="lib-chip warn">Not checked</span>
            <span>Countersigned time — can’t be checked while offline</span>
          </div>
          <div className="honest-note">An illustration of the layout — not a result about any file of yours.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="lib-panel">
      <div className="lib-toolbar">
        <input
          type="text"
          className="lib-search"
          placeholder="Search by name, or paste a hash/fingerprint prefix…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search the library by file name or hash prefix"
        />
        <select
          className="lib-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
          aria-label="Sort the library"
        >
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
          <option value="name">Name</option>
          <option value="size">Size</option>
          <option value="kind">Kind</option>
          <option value="state">State</option>
        </select>
        <div className="lib-viewtoggle" role="group" aria-label="View">
          <button className={view === 'grid' ? 'active' : ''} aria-pressed={view === 'grid'} onClick={() => setView('grid')}>Grid</button>
          <button className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        </div>
      </div>

      <div className="lib-filters" role="group" aria-label="Filter by kind">
        <button className={`lib-filter${kindFilter === 'all' ? ' active' : ''}`} onClick={() => setKindFilter('all')}>
          All · {items.length}
        </button>
        {(['media', 'proof-bundle', 'hash-claim', 'unknown'] as const).map((k) => {
          const n = kindCounts.get(k) ?? 0;
          if (n === 0) return null;
          return (
            <button key={k} className={`lib-filter${kindFilter === k ? ' active' : ''}`} onClick={() => setKindFilter(k)}>
              {KIND_LABEL[k]} · {n}
            </button>
          );
        })}
      </div>

      {livePicked.size > 0 && (
        <div className="lib-selection" role="status">
          <span>{livePicked.size} selected</span>
          <button className="btn secondary" onClick={() => { setPicked(new Set()); anchorRef.current = null; }}>
            Clear selection
          </button>
          <button className="btn danger" onClick={removePicked}>
            Remove from session
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="lib-empty-filtered">
          <p>Nothing matches this view.</p>
          <button
            className="btn secondary"
            onClick={() => { setQuery(''); setKindFilter('all'); }}
          >
            Clear search and filters
          </button>
        </div>
      ) : (
        <div className={view === 'grid' ? 'lib-grid' : 'lib-list'}>
          {visible.map((item, index) => {
            const chip = stateChip(item);
            const size = sizeOf(item);
            const isPicked = livePicked.has(item.id);
            const isKept = remembered.has(item.id);
            return (
              <div
                key={item.id}
                className={`lib-card${item.id === selectedId ? ' selected' : ''}${isPicked ? ' picked' : ''}${landing.has(item.id) ? ' lib-land' : ''}`}
                onClick={(e) => {
                  if (e.shiftKey) togglePick(item.id, index, true);
                  else onSelect(item.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(item.id);
                  }
                }}
              >
                <label className="lib-check" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={isPicked}
                    aria-label={`Select ${item.name}`}
                    onChange={(e) => togglePick(item.id, index, (e.nativeEvent as MouseEvent).shiftKey)}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <div className="lib-thumb"><Thumb item={item} /></div>
                <div className="lib-card-body">
                  <div className="lib-name" title={item.name}>{item.name}</div>
                  <div className="lib-meta">
                    <span className="lib-chip kind">{KIND_LABEL[item.kind]}</span>
                    <span>{size !== null ? fmtBytes(size) : '—'}</span>
                    <span title={new Date(item.addedAt ?? 0).toLocaleString()}>{formatAdded(item.addedAt)}</span>
                  </div>
                  <div className="lib-state">
                    {chip && <span className={`lib-chip ${chip.tone}`}>{chip.text}</span>}
                    {isKept && <span className="lib-dot" title="Kept in this browser" aria-label="Kept in this browser" />}
                  </div>
                </div>
                <button
                  className={`lib-pin${isKept ? ' kept' : ''}`}
                  aria-pressed={isKept}
                  title={isKept ? 'Kept in this browser — click to stop keeping' : 'Keep in this browser'}
                  aria-label={isKept ? `${item.name} is kept in this browser` : `Keep ${item.name} in this browser`}
                  onClick={(e) => { e.stopPropagation(); onToggleRemember(item.id); }}
                >
                  <PinIcon filled={isKept} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {remembered.size > 0 && (
        <p className="honest-note lib-kept-note">
          Kept items live only in this browser’s storage. Nothing is uploaded — ever.
        </p>
      )}
    </div>
  );
}
