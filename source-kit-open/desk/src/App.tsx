/**
 * Source Kit Desk — custody checking, entirely in this tab.
 * No server, no upload, no analytics. The only possible network call is the
 * opt-in Bitcoin block-header check, and the topbar boundary indicator says
 * at all times whether the app is offline (DESIGN §5.9).
 *
 * Trust hygiene rules enforced here:
 *  - A roster REPLACES a trusted roster from the same owner only when it is
 *    not older. Stale rosters never replace fresh ones — rejected with plain
 *    language, and a roster's age is surfaced on accept.
 *  - localStorage holds only 'exhibitC.*' keys (migrated once from the
 *    legacy 'verifyDesk.*' prefix, §7), and Settings carries a wipe control
 *    that removes exactly those, with a confirmation.
 *  - Proof-bundle online checks are cached by bundle content hash + online
 *    state: toggling the switch never re-verifies identical bytes.
 *  - The session keeps a hash-chained .exhibitcase audit trail (tamper-
 *    evidence, not honesty — the format header says so and so does the UI).
 *
 * Shell (DESIGN §4.1): Library is home — Intake sidebar + LibraryPanel
 * (grid/list, sort, filter, search, multi-select, pins backed by the
 * IndexedDB libraryStore). Selecting an asset opens its AssetDashboard
 * (custody banner + Overview/Signals/Forensics/AI Forensics tabs, W2);
 * "← Library" returns with the library view state intact (it is lifted
 * into App — ARCHITECTURE §3.2).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Roster } from '@exhibit/lib/roster';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@exhibit/lib/bytes';
import { canonicalize, type JsonValue } from '@exhibit/lib/canonical';
import type { ProofBundle } from '@exhibit/lib/proofBundle';
import {
  checkHashClaim, checkProofBundle, checkRoster, findRecoveryMatches, findManifestCustodyMatches,
  resolveDeskTrust, resolveSignerTrust, DESK_VERSION,
  type ArtifactCheck, type DeskTrust,
} from './core/deskCore';
import type { DeskItem } from './core/deskItem';
import {
  createCase, appendAudit, serializeCase, parseCase, CaseFileError,
  type ExhibitCase, type CaseNote,
} from './core/caseFile';
import { buildCaseSnapshot, restoreCaseItems, readTrustSnapshot } from './core/caseSession';
import { libraryStore } from './core/libraryStore';
import { LS_KEYS, LS_PREFIX, migrateLocalStorage } from './core/storageMigration';
import { ageLine } from './core/util';
import type { Thresholds } from './contracts';
import type { ConnectorPrefs } from './contracts-ext';
import { Intake } from './components/Intake';
import { LibraryPanel, DEFAULT_LIBRARY_VIEW, type LibraryViewState } from './components/LibraryPanel';
import { AssetDashboard } from './components/AssetDashboard';
import { RosterManager } from './components/RosterManager';
import { SettingsPanel } from './components/SettingsPanel';
import { CasePanel } from './components/CasePanel';

type Surface = { name: 'library' } | { name: 'asset'; id: string }
             | { name: 'roster' } | { name: 'settings' } | { name: 'about' };

/**
 * Persisted-state restore (F4): every value read back from localStorage is
 * validated for SHAPE before it is used — storage is user-writable, never
 * trusted input. Anything malformed falls back to the default AND produces
 * a plain-language notice (reusing the readTrustSnapshot pattern from
 * caseSession.ts): silent fallback would hide corruption; trusting the
 * bytes blindly would be worse.
 */
interface RestoreNote { action: string; detail: string }

function isStoredRoster(r: unknown): r is Roster {
  if (!r || typeof r !== 'object') return false;
  const o = r as Partial<Roster>;
  return (
    typeof o.newsroom === 'string' &&
    typeof o.issuedAt === 'string' &&
    !!o.editor && typeof o.editor.fingerprint === 'string' &&
    Array.isArray(o.entries)
  );
}

/**
 * Trusted rosters from storage: array shape, per-element guard, and —
 * because trust is re-proven, never inherited — every roster's editor
 * signature is re-checked with the SAME bar as the intake path
 * (handleRosterFile). Failures drop loudly: audit + notice, never silent.
 */
function restoreRosters(): { rosters: Roster[]; notes: RestoreNote[] } {
  const notes: RestoreNote[] = [];
  let raw: unknown = null;
  try {
    const s = localStorage.getItem(LS_KEYS.rosters);
    raw = s ? JSON.parse(s) : null;
  } catch {
    notes.push({ action: 'roster-rejected', detail: 'Stored trusted rosters were unreadable (malformed JSON) — dropped; your trusted roster list starts empty.' });
    return { rosters: [], notes };
  }
  if (raw === null) return { rosters: [], notes };
  if (!Array.isArray(raw)) {
    notes.push({ action: 'roster-rejected', detail: 'Stored trusted rosters had an unexpected shape — dropped; your trusted roster list starts empty.' });
    return { rosters: [], notes };
  }
  const rosters: Roster[] = [];
  for (const r of raw) {
    if (!isStoredRoster(r)) {
      notes.push({ action: 'roster-rejected', detail: 'A stored roster had an unexpected shape — dropped, not trusted.' });
      continue;
    }
    const check = checkRoster(r);
    if (!check.ok) {
      notes.push({ action: 'roster-rejected', detail: `Stored roster "${r.newsroom}" refused — signature does not check out (${check.reason ?? 'unknown'}); it was dropped from your trusted rosters.` });
      continue;
    }
    rosters.push(r);
  }
  return { rosters, notes };
}

function restoreThresholds(): { thresholds: Thresholds; note: string | null } {
  const fallback: Thresholds = { likely: 6, possible: 10 };
  try {
    const s = localStorage.getItem(LS_KEYS.thresholds);
    if (!s) return { thresholds: fallback, note: null };
    const v = JSON.parse(s) as Partial<Thresholds> | null;
    if (v && typeof v === 'object' && typeof v.likely === 'number' && typeof v.possible === 'number' &&
        Number.isFinite(v.likely) && Number.isFinite(v.possible)) {
      return { thresholds: { likely: v.likely, possible: v.possible }, note: null };
    }
  } catch { /* falls through to the notice path */ }
  return { thresholds: fallback, note: 'Stored similarity thresholds were unreadable — the defaults are back. Nothing else was touched.' };
}

function restoreConnectorPrefs(): { prefs: ConnectorPrefs; note: string | null } {
  try {
    const s = localStorage.getItem(LS_KEYS.connectors);
    if (!s) return { prefs: {}, note: null };
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        Object.values(v as Record<string, unknown>).every(
          (e) => !!e && typeof e === 'object' &&
            (typeof (e as { endpoint?: unknown }).endpoint === 'undefined' || typeof (e as { endpoint?: unknown }).endpoint === 'string'),
        )) {
      return { prefs: v as ConnectorPrefs, note: null };
    }
  } catch { /* falls through to the notice path */ }
  return { prefs: {}, note: 'Stored connector endpoints were unreadable — none were restored; every connector stays unconfigured.' };
}

/**
 * F14: a quota/security failure on localStorage.setItem must never escape
 * into the ErrorBoundary — persist is best-effort, the session is the truth.
 */
function persistKey(key: string, value: unknown, what: string, onFail: (msg: string) => void) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    onFail(`${what} could not be saved in this browser (${e instanceof Error ? e.message : String(e)}). The change holds for this session only — nothing was uploaded.`);
  }
}

/** Cache key for proof-bundle checks: identical bytes + same online state never re-verify (C9). */
function bundleCheckKey(bundle: ProofBundle, online: boolean): string {
  try {
    return `${bytesToHex(sha256(utf8ToBytes(canonicalize(bundle as unknown as JsonValue))))}:${online ? 'on' : 'off'}`;
  } catch {
    // Canonicalization failing is not a verification result — fall back to the media digest identity.
    return `${bundle.media?.sha256 ?? 'unknown'}:${online ? 'on' : 'off'}`;
  }
}

const STALE_MSG = 'This roster is older than the one already trusted — stale rosters never replace fresh ones.';

export function App() {
  // One-time legacy storage migration (§7): copy verifyDesk.* values onto
  // the exhibitC.* keys, then remove the legacy keys. It must run BEFORE the
  // persisted useState initializers below read localStorage for the first
  // time, so it lives at the top of the first render. Idempotent — a second
  // run (StrictMode double-render) finds nothing to do.
  const migratedKeysRef = useRef<string[] | null>(null);
  if (migratedKeysRef.current === null) {
    migratedKeysRef.current = migrateLocalStorage(localStorage);
  }

  const [surface, setSurface] = useState<Surface>({ name: 'library' });
  const [items, setItems] = useState<DeskItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, ArtifactCheck>>({});
  const [remembered, setRemembered] = useState<ReadonlySet<string>>(new Set());
  const [libView, setLibView] = useState<LibraryViewState>(DEFAULT_LIBRARY_VIEW);
  // Validated restore (F4 + roster re-verification): computed once per mount,
  // before the persisted useState initializers read their values.
  const restoreRef = useRef<{
    rosters: { rosters: Roster[]; notes: RestoreNote[] };
    thresholds: { thresholds: Thresholds; note: string | null };
    connectors: { prefs: ConnectorPrefs; note: string | null };
  } | null>(null);
  if (restoreRef.current === null) {
    restoreRef.current = {
      rosters: restoreRosters(),
      thresholds: restoreThresholds(),
      connectors: restoreConnectorPrefs(),
    };
  }
  const [trustedRosters, setTrustedRosters] = useState<Roster[]>(() => restoreRef.current!.rosters.rosters);
  // Online checks are SESSION-ONLY by design: the network opt-in is never
  // persisted anywhere (not localStorage, not case files) — every session
  // starts offline and turning it on is always a fresh, deliberate act.
  const [onlineChecks, setOnlineChecks] = useState<boolean>(false);
  const [thresholds, setThresholds] = useState<Thresholds>(() => restoreRef.current!.thresholds.thresholds);
  // W3: declared connector endpoints — empty by default, always opt-in (L10).
  const [connectorPrefs, setConnectorPrefs] = useState<ConnectorPrefs>(() => restoreRef.current!.connectors.prefs);
  // W3: the topbar boundary indicator's sending state (DESIGN §5.9) — set by
  // the AI tab's consent flow for exactly the duration of a request.
  const [sendingHost, setSendingHost] = useState<string | null>(null);
  // Notices carry a TONE (F31): warn (amber, something needs attention) vs
  // info (neutral slate, a success or neutral fact). A success must never
  // render in the amber warn-box — amber means caution, not "done".
  const [noticeState, setNoticeState] = useState<{ text: string; tone: 'warn' | 'info' } | null>(null);
  function setNotice(text: string | null, tone: 'warn' | 'info' = 'warn') {
    setNoticeState(text === null ? null : { text, tone });
  }
  const notice = noticeState?.text ?? null;
  const [notes, setNotes] = useState<CaseNote[]>([]);

  // The session case: audit trail maintained incrementally, the rest
  // snapshotted from live state at save time (caseSession.ts).
  const caseRef = useRef<ExhibitCase | null>(null);
  if (!caseRef.current) caseRef.current = createCase();
  const [auditCount, setAuditCount] = useState(0);

  // C9: bundle checks keyed by content hash + online state.
  const bundleCheckCache = useRef(new Map<string, ArtifactCheck>());

  function audit(action: string, detail?: string) {
    try {
      if (caseRef.current) {
        appendAudit(caseRef.current, action, detail);
        setAuditCount(caseRef.current.auditTrail.length);
      }
    } catch {
      // The audit trail must never break the workspace it observes.
    }
  }

  // The migration's audit entry (written once, after the case exists).
  useEffect(() => {
    const moved = migratedKeysRef.current ?? [];
    if (moved.length > 0) {
      audit('storage-migrated', `legacy localStorage keys migrated to exhibitC.*: ${moved.join(', ')}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The restore report's loud drops (F4/roster re-verification): every
  // rejected stored roster is audited like the intake path, and every
  // fallback becomes a notice — corruption is never absorbed silently.
  useEffect(() => {
    const r = restoreRef.current;
    if (!r) return;
    for (const n of r.rosters.notes) audit(n.action, n.detail);
    const msgs = [
      ...r.rosters.notes.map((n) => n.detail),
      r.thresholds.note,
      r.connectors.note,
    ].filter((m): m is string => m !== null);
    if (msgs.length > 0) setNotice(msgs.join(' '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restore kept (pinned) items from this browser's IndexedDB. Fail closed
  // but never blocking: a storage failure becomes a notice, the session
  // continues session-only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stored = await libraryStore.loadAll();
        if (cancelled || stored.length === 0) return;
        const restored: DeskItem[] = [];
        for (const { item, bytes } of stored) {
          restored.push({ ...item, bytes: new Uint8Array(await bytes.arrayBuffer()) });
        }
        if (cancelled) return;
        setItems((prev) => {
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...restored.filter((r) => !seen.has(r.id))];
        });
        setRemembered((prev) => new Set([...prev, ...restored.map((r) => r.id)]));
        audit('kept-items-restored', `${restored.length} kept item(s) restored from this browser's storage`);
      } catch (e) {
        if (!cancelled) {
          setNotice(`Kept items could not be restored (${e instanceof Error ? e.message : String(e)}). The session continues without them — nothing was uploaded.`);
        }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist trust configuration locally (browser-only, stated). Best-effort:
  // a quota/security failure becomes a notice, never an ErrorBoundary (F14).
  // onlineChecks is deliberately NOT persisted — the network opt-in is
  // session-only; every session starts offline.
  useEffect(() => { persistKey(LS_KEYS.rosters, trustedRosters, 'Trusted rosters', setNotice); }, [trustedRosters]);
  useEffect(() => { persistKey(LS_KEYS.thresholds, thresholds, 'Similarity thresholds', setNotice); }, [thresholds]);
  useEffect(() => { persistKey(LS_KEYS.connectors, connectorPrefs, 'Connector endpoints', setNotice); }, [connectorPrefs]);

  // Compute artifact checks for bundles/claims that lack them. Bundle checks
  // are cached by content hash + online state, so toggling the online switch
  // back and forth never re-verifies (or re-fetches for) identical bytes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const item of items) {
        if (item.kind === 'hash-claim' && !artifacts[item.id]) {
          const check = checkHashClaim(item.claim!);
          if (!cancelled) {
            setArtifacts((prev) => ({ ...prev, [item.id]: check }));
            audit('verdict-rendered', `${item.name} — hash claim (structural checks only, by design)`);
          }
        }
        if (item.kind === 'proof-bundle') {
          const key = bundleCheckKey(item.bundle!, onlineChecks);
          const cached = bundleCheckCache.current.get(key);
          if (cached) {
            if (artifacts[item.id] !== cached && !cancelled) {
              setArtifacts((prev) => ({ ...prev, [item.id]: cached }));
            }
            continue;
          }
          const check = await checkProofBundle(item.bundle!, onlineChecks, (blockHeight) =>
            // The audit entry lands BEFORE the network request is made.
            audit('external-check', `Bitcoin block header fetch for block ${blockHeight} from mempool.space (online checks — session-only opt-in)`),
          );
          bundleCheckCache.current.set(key, check);
          if (!cancelled) {
            setArtifacts((prev) => ({ ...prev, [item.id]: check }));
            audit(
              'verdict-rendered',
              `${item.name} — proof bundle: signature ${check.signatureValid ? 'valid' : 'INVALID'}, digest ${check.payloadDigestMatches ? 'matches' : 'MISMATCH'} (${onlineChecks ? 'online' : 'offline'} checks)`,
            );
          }
        }
      }
    })();
    return () => { cancelled = true; };
    // artifacts intentionally read-only inside; keyed by items/onlineChecks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, onlineChecks]);

  const matches = useMemo(
    () => findRecoveryMatches(items, thresholds.likely, thresholds.possible),
    [items, thresholds]
  );

  // Detached-manifest custody matches: exact-after-strip — a platform
  // removed the credentials in transit, the bundle's manifest still commits
  // to these exact bytes. Cryptographic, never similarity.
  const custodyMatches = useMemo(() => findManifestCustodyMatches(items), [items]);

  // Keep the Tier-0 report's custody COUNTS current as the library changes
  // (contracts-ext §3.3: counts only; the detail stays in the match types).
  // Guarded by strict inequality — the effect settles after one pass.
  useEffect(() => {
    setItems((prev) => {
      let changed = false;
      const next = prev.map((i) => {
        if (!i.intakeReport) return i;
        const r = matches.filter((m) => m.proofItemId === i.id || m.mediaItemId === i.id).length;
        const c = custodyMatches.filter((m) => m.mediaItemId === i.id || m.bundleItemId === i.id).length;
        if (i.intakeReport.custody.recoveryMatches === r && i.intakeReport.custody.exactAfterStrip === c) return i;
        changed = true;
        return { ...i, intakeReport: { ...i.intakeReport, custody: { recoveryMatches: r, exactAfterStrip: c } } };
      });
      return changed ? next : prev;
    });
  }, [matches, custodyMatches]);

  /**
   * contracts.ts onItemPatched: tabs cache expensive Tier-1/2 results on the
   * item object so re-opened tabs render without recompute. The patch is a
   * MERGE function applied to the CURRENT item inside setItems (F1): two
   * analyses finishing back-to-back (clone + noise, say) each see the other's
   * committed result — a stale render closure can never wipe a fresh cache.
   */
  function patchItem(id: string, patch: (current: DeskItem) => DeskItem) {
    setItems((prev) => prev.map((i) => (i.id === id ? patch(i) : i)));
  }

  const selected = items.find((i) => i.id === selectedId) ?? null;

  const selectedTrust: DeskTrust | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'media' && selected.report) return resolveDeskTrust(selected.report, trustedRosters);
    if (selected.kind === 'proof-bundle') {
      // No verified time travels in a proof bundle — membership timing is
      // evaluated as unknown-time, stated not assumed.
      return resolveSignerTrust(selected.bundle!.record.signer?.fingerprint ?? null, null, trustedRosters, null);
    }
    if (selected.kind === 'hash-claim') {
      return resolveSignerTrust(selected.claim!.signerFingerprint, null, trustedRosters, null);
    }
    return null;
  }, [selected, trustedRosters]);

  // Kept-item storage usage, surfaced in Settings → Local data.
  const keptBytes = useMemo(() => {
    let total = 0;
    for (const i of items) if (remembered.has(i.id)) total += i.bytes?.length ?? 0;
    return total;
  }, [items, remembered]);

  // W3: Settings → Local data → "what left this browser" (DESIGN §5.9) —
  // every boundary-crossing decision from the session audit trail, both
  // directions of consent included (a refusal is honesty evidence too).
  const boundaryLog = useMemo(
    () =>
      (caseRef.current?.auditTrail ?? []).filter(
        (e) => e.action === 'consent-granted' || e.action === 'consent-refused' || e.action === 'external-check',
      ),
    // auditCount increments on every append — the memo's effective key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [auditCount],
  );

  function addItems(added: DeskItem[]) {
    setItems((prev) => [...prev, ...added]);
    for (const i of added) {
      audit(
        'item-added',
        `${i.name} — ${i.kind}${i.report ? `, verdict ${i.report.verdict}` : ''}${i.sha256Hex ? `, sha256 ${i.sha256Hex.slice(0, 16)}…` : ''}${i.error ? ` (${i.error.slice(0, 120)})` : ''}`,
      );
      if (i.report) audit('verdict-rendered', `${i.name} — ${i.report.verdict}`);
    }
  }

  function openAsset(id: string) {
    setSelectedId(id);
    setSurface({ name: 'asset', id });
  }

  function removeItems(ids: string[]) {
    const gone = new Set(ids);
    for (const i of items) {
      if (gone.has(i.id) && i.objectUrl) URL.revokeObjectURL(i.objectUrl);
    }
    audit('items-removed', `${ids.length} item(s) removed from the session`);
    setItems((prev) => prev.filter((i) => !gone.has(i.id)));
    setArtifacts((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    // A removed item is also forgotten from browser storage — removing must
    // not resurrect it on the next visit.
    const kept = ids.filter((id) => remembered.has(id));
    if (kept.length > 0) {
      setRemembered((prev) => {
        const next = new Set(prev);
        for (const id of kept) next.delete(id);
        return next;
      });
      for (const id of kept) {
        libraryStore.remove(id).catch((e) => {
          setNotice(`A kept item could not be forgotten from this browser's storage (${e instanceof Error ? e.message : String(e)}).`);
        });
      }
    }
    if (selectedId && gone.has(selectedId)) {
      setSelectedId(null);
      if (surface.name === 'asset') setSurface({ name: 'library' });
    }
  }

  function clearAll() {
    for (const i of items) {
      if (i.objectUrl) URL.revokeObjectURL(i.objectUrl);
    }
    audit('items-cleared', `${items.length} item(s) removed from the session; ${remembered.size} kept item(s) forgotten`);
    for (const id of remembered) {
      libraryStore.remove(id).catch(() => { /* best effort — the wipe notice in Settings covers storage hygiene */ });
    }
    setRemembered(new Set());
    setItems([]);
    setSelectedId(null);
    setArtifacts({});
    if (surface.name === 'asset') setSurface({ name: 'library' });
  }

  /**
   * Pin / unpin ("Keep in this browser"). The remembered set only updates on
   * storage success; failures become notices, never silent state drift.
   */
  function toggleRemember(id: string) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (remembered.has(id)) {
      libraryStore.remove(id)
        .then(() => {
          setRemembered((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          audit('item-unkept', `${item.name} — no longer kept in this browser`);
        })
        .catch((e) => setNotice(`“${item.name}” could not be forgotten (${e instanceof Error ? e.message : String(e)}). It is still kept in this browser.`));
      return;
    }
    if (!item.bytes) {
      setNotice(`“${item.name}” can't be kept — its bytes are not in this tab (a large video or a reference item). Re-drop the file, then pin it.`);
      return;
    }
    const blob = new Blob([item.bytes.slice().buffer as ArrayBuffer]);
    libraryStore.put(item, blob)
      .then(() => {
        setRemembered((prev) => new Set([...prev, id]));
        audit('item-kept', `${item.name} — kept in this browser's storage (IndexedDB only)`);
      })
      .catch((e) => setNotice(`“${item.name}” could not be kept (${e instanceof Error ? e.message : String(e)}). It stays session-only.`));
  }

  /**
   * C3 — the stale-roster guard. A roster from an owner already trusted
   * replaces the trusted one ONLY if it is not older. Returns the outcome so
   * every caller can say plainly what happened.
   */
  function addTrustedRoster(roster: Roster): 'added' | 'stale-rejected' {
    const existing = trustedRosters.find((r) => r.editor.fingerprint === roster.editor.fingerprint);
    if (existing) {
      const incomingMs = Date.parse(roster.issuedAt);
      const currentMs = Date.parse(existing.issuedAt);
      if (Number.isFinite(incomingMs) && Number.isFinite(currentMs) && incomingMs < currentMs) {
        audit('roster-rejected', `"${roster.newsroom}" — stale (issued ${roster.issuedAt}, trusted one issued ${existing.issuedAt})`);
        return 'stale-rejected';
      }
    }
    setTrustedRosters((prev) => {
      const rest = prev.filter((r) => r.editor.fingerprint !== roster.editor.fingerprint);
      return [...rest, roster];
    });
    audit('roster-accepted', `"${roster.newsroom}" — ${ageLine(roster.issuedAt)}, owner ${roster.editor.fingerprint.slice(0, 16)}…`);
    return 'added';
  }

  function handleRosterFile(item: DeskItem) {
    const check = checkRoster(item.roster!);
    if (check.ok) {
      if (addTrustedRoster(item.roster!) === 'stale-rejected') {
        setNotice(`Roster “${item.roster!.newsroom}” refused — ${STALE_MSG}`);
      } else {
        setNotice(`Roster “${item.roster!.newsroom}” signature checked and added to your trusted rosters — ${ageLine(item.roster!.issuedAt)}.`, 'info');
      }
    } else {
      audit('roster-rejected', `"${item.name}" — signature does not check out (${check.reason ?? 'unknown'})`);
      setNotice(`Roster “${item.name}” refused — signature does not check out (${check.reason ?? 'unknown'}).`);
    }
    setSurface({ name: 'settings' });
  }

  /**
   * C7 — wipe exactly Source Kit Desk's local data, with a confirmation that says
   * exactly what goes: the exhibitC.* localStorage keys AND the kept
   * ("pinned") items in this browser's IndexedDB. Nothing else is touched.
   */
  function clearLocalData() {
    const kept = remembered.size;
    const ok = window.confirm(
      'Wipe Source Kit Desk’s local data in this browser? This removes trusted rosters, thresholds, and preferences ' +
      '(the exhibitC.* keys only — nothing else in the browser is touched)' +
      (kept > 0 ? `, and forgets the ${kept} item(s) you chose to keep in this browser’s storage` : '') +
      '. Items open in the session stay open until you clear them.',
    );
    if (!ok) return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
    setTrustedRosters([]);
    setOnlineChecks(false);
    setThresholds({ likely: 6, possible: 10 });
    setConnectorPrefs({});
    // Kept items live in IndexedDB — a wipe that left them behind would lie.
    if (kept > 0) {
      setRemembered(new Set());
      libraryStore.clear().catch((e) => {
        setNotice(`Kept items could not all be forgotten from this browser's storage (${e instanceof Error ? e.message : String(e)}). The rest of the wipe stands.`);
      });
    }
    audit('local-data-cleared', `${keys.length} exhibitC.* localStorage key(s) and ${kept} kept item(s) wiped at the user's request`);
    setNotice(
      `Local data wiped (${keys.length} keys${kept > 0 ? `, ${kept} kept item(s)` : ''}) — trusted rosters, thresholds, preferences` +
      `${kept > 0 ? ', kept items' : ''}. Nothing else in this browser was touched.`,
      'info',
    );
  }

  // -------------------------------------------------------------------------
  // Case files (.exhibitcase) — the session made durable.
  // -------------------------------------------------------------------------

  function saveCase() {
    audit('case-saved', `${items.length} item(s), ${notes.length} note(s), ${trustedRosters.length} trusted roster(s)`);
    const snapshot = buildCaseSnapshot(caseRef.current!, {
      items, trustedRosters, thresholds, notes, notice,
    });
    let json: string;
    try {
      json = serializeCase(snapshot);
    } catch (e) {
      // serializeCase fails closed on non-JSON values — say so, write nothing.
      setNotice(`The case could not be saved: ${e instanceof Error ? e.message : String(e)}. Nothing was written.`);
      return;
    }
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `exhibit-case-${new Date().toISOString().replace(/[:.]/g, '-')}.exhibitcase`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    setNotice('Case saved. It holds item references (path + SHA-256 + snapshots), your notes, the trust configuration, and the audit trail — never the media bytes.', 'info');
  }

  function openCase(file: File) {
    file.text().then((text) => {
      let c: ExhibitCase;
      try {
        c = parseCase(text); // fail closed: broken chain, wrong format, malformed — all throw
      } catch (e) {
        const msg = e instanceof CaseFileError ? `${e.message} [${e.code}]` : e instanceof Error ? e.message : String(e);
        audit('case-open-refused', `${file.name}: ${msg}`);
        setNotice(`Case file “${file.name}” refused — ${msg}. Source Kit Desk fails closed: nothing from it was restored.`);
        return;
      }
      // Adopt the opened case as the working case: its chain was checked,
      // and this session's entries keep chaining onto it.
      caseRef.current = c;
      setAuditCount(c.auditTrail.length);

      const restored = restoreCaseItems(c);
      setItems((prev) => [...prev, ...restored]);
      setNotes(c.notes);

      // Trust is re-proven, never inherited: every roster in the snapshot
      // must check out HERE, and the stale guard still applies. onlineChecks
      // is deliberately not restored — the network opt-in is per-session.
      const trust = readTrustSnapshot(c);
      let accepted = 0;
      let refused = 0;
      for (const r of trust.rosters) {
        const check = checkRoster(r);
        if (!check.ok) {
          refused++;
          audit('roster-rejected', `from case “${file.name}”: “${r.newsroom}” — signature does not check out (${check.reason ?? 'unknown'})`);
          continue;
        }
        if (addTrustedRoster(r) === 'added') accepted++;
        else refused++;
      }
      if (trust.thresholds) setThresholds(trust.thresholds);

      audit(
        'case-opened',
        `${file.name}: ${restored.length} item reference(s), ${c.notes.length} note(s), ${accepted} roster(s) trusted, ${refused} refused; audit trail of ${c.auditTrail.length} entries checked (chain intact)`,
      );
      setNotice(
        `Case “${file.name}” opened — audit trail checked (${c.auditTrail.length} entries, chain intact). ` +
        `Restored ${restored.length} item reference(s) and ${c.notes.length} note(s); ${accepted} roster(s) trusted after re-checking${refused ? `, ${refused} refused` : ''}. ` +
        'Items are references: re-drop a file to check its bytes again. Online checks stay as you set them — a case file never turns the network on.',
        'info',
      );
    }).catch(() => {
      setNotice(`Could not read “${file.name}” — the file never left this tab, and nothing was restored.`);
    });
  }

  function addNote(text: string) {
    const note: CaseNote = { ts: new Date().toISOString(), text };
    setNotes((prev) => [...prev, note]);
    audit('notes-edited', `note added (${text.length} chars)`);
  }

  const showAsset = surface.name === 'asset' && selected !== null;
  const navActive = surface.name === 'asset' ? 'library' : surface.name;

  return (
    <div>
      <div className="topbar">
        <span className="mark">
          {/* The hex glyph is identity only (DESIGN §6) — never a signal. */}
          <svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true" focusable="false">
            <path d="M10 1.5 18 6v10l-8 4.5L2 16V6l8-4.5z" fill="none" stroke="var(--text)" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <h1>Source Kit Desk</h1>
        </span>
        <span className="sub">Custody checking · v{DESK_VERSION}</span>
        <span className="spacer" />
        <span className={`boundary${sendingHost ? ' sending' : onlineChecks ? ' online' : ''}`} aria-live="polite">
          {sendingHost
            ? `Sending to ${sendingHost}…`
            : onlineChecks
              ? 'Network: Bitcoin block-header checks (opt-in)'
              : 'Offline — nothing leaves this tab'}
        </span>
      </div>
      <nav className="tabs" aria-label="Primary">
        <button className={navActive === 'library' ? 'active' : ''} aria-current={navActive === 'library' ? 'page' : undefined} onClick={() => setSurface({ name: 'library' })}>Library</button>
        <button className={navActive === 'roster' ? 'active' : ''} aria-current={navActive === 'roster' ? 'page' : undefined} onClick={() => setSurface({ name: 'roster' })}>Trust Roster</button>
        <button className={navActive === 'settings' ? 'active' : ''} aria-current={navActive === 'settings' ? 'page' : undefined} onClick={() => setSurface({ name: 'settings' })}>Settings</button>
        <button className={navActive === 'about' ? 'active' : ''} aria-current={navActive === 'about' ? 'page' : undefined} onClick={() => setSurface({ name: 'about' })}>About</button>
      </nav>

      {noticeState && (
        <div className={noticeState.tone === 'info' ? 'info-box' : 'warn-box'} style={{ margin: '12px 28px 0' }} role="status" aria-live="polite">
          {noticeState.text}{' '}
          <button className="btn secondary" style={{ padding: '2px 10px', marginLeft: 8 }} onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {showAsset && (
        <div className="main asset" style={{ maxWidth: 920, margin: '0 auto' }}>
          <div className="back-row">
            <button className="btn secondary" onClick={() => setSurface({ name: 'library' })}>← Library</button>
          </div>
          <AssetDashboard
            item={selected}
            trust={selectedTrust}
            artifact={artifacts[selected.id] ?? null}
            matches={matches}
            custodyMatches={custodyMatches}
            onItemPatched={patchItem}
            connectorPrefs={connectorPrefs}
            onAudit={audit}
            onBoundarySending={setSendingHost}
          />
        </div>
      )}

      {(surface.name === 'library' || (surface.name === 'asset' && !selected)) && (
        <div className="layout">
          <div className="sidebar">
            <Intake
              onAdd={addItems}
              onRosterFile={handleRosterFile}
              onOpenCase={openCase}
            />
            {items.length > 0 && (
              <div className="btn-row" style={{ marginTop: 14 }}>
                <button className="btn secondary" onClick={clearAll}>
                  Clear all
                </button>
              </div>
            )}
            <CasePanel
              auditEntries={auditCount}
              notes={notes}
              onAddNote={addNote}
              onSaveCase={saveCase}
              onOpenCase={openCase}
            />
          </div>
          <div className="main library">
            <LibraryPanel
              items={items}
              selectedId={selectedId}
              onSelect={openAsset}
              onRemove={removeItems}
              remembered={remembered}
              onToggleRemember={toggleRemember}
              viewState={libView}
              onViewStateChange={(patch) => setLibView((prev) => ({ ...prev, ...patch }))}
            />
          </div>
        </div>
      )}

      {surface.name === 'roster' && (
        <RosterManager
          onTrustRoster={(r) => {
            if (addTrustedRoster(r) === 'stale-rejected') {
              setNotice(`Roster “${r.newsroom}” refused — ${STALE_MSG}`);
            } else {
              setNotice(`Roster “${r.newsroom}” signature checked and added to your trusted rosters — ${ageLine(r.issuedAt)}.`, 'info');
            }
          }}
        />
      )}

      {surface.name === 'settings' && (
        <SettingsPanel
          trustedRosters={trustedRosters}
          onAddRoster={addTrustedRoster}
          onRemoveRoster={(fp) => setTrustedRosters((prev) => prev.filter((r) => r.editor.fingerprint !== fp))}
          onlineChecks={onlineChecks}
          onOnlineChecks={setOnlineChecks}
          likelyMax={thresholds.likely}
          possibleMax={thresholds.possible}
          onThresholds={(likely, possible) => setThresholds({ likely, possible })}
          keptCount={remembered.size}
          keptBytes={keptBytes}
          onClearLocalData={clearLocalData}
          connectorPrefs={connectorPrefs}
          onConnectorEndpoint={(id, endpoint) =>
            setConnectorPrefs((prev) => {
              const next = { ...prev };
              if (endpoint) next[id] = { endpoint };
              else delete next[id];
              return next;
            })
          }
          boundaryLog={boundaryLog}
        />
      )}

      {surface.name === 'about' && (
        <div style={{ maxWidth: 720, padding: '24px 32px' }}>
          <div className="card">
            <h2>What this tool checks — and what it does not</h2>
            <p style={{ fontSize: 14.5 }}>
              Source Kit Desk checks <strong>custody</strong>: that a file’s bytes are exactly what a particular signing key signed,
              when that signature was countersigned, and whether that key was on a roster you trust <em>at that time</em>.
              It does not prove the scene depicted is real. <strong>Custody, not reality.</strong>
            </p>
            <p style={{ fontSize: 14.5 }}>
              It uses the exact same verification core as the Source Kit capture app — imported from the same source tree,
              not a fork. If the app and Source Kit Desk ever disagree, that disagreement is a bug to report, not a judgment call.
            </p>
          </div>
          <div className="card">
            <h2>Where things run and live</h2>
            <ul style={{ fontSize: 14, paddingLeft: 20, margin: 0 }}>
              <li>All parsing and cryptography run in this browser tab. Files are never uploaded.</li>
              <li>Trusted rosters and thresholds persist in this browser’s local storage only (keys prefixed <code>exhibitC.</code>; Settings can wipe them).</li>
              <li>Case files (<code>.exhibitcase</code>) save the session only when you explicitly save one.</li>
              <li>Private keys are never stored anywhere by this tool — memory only, per use.</li>
              <li>Network calls happen only when you turn them on, one labeled action at a time — the top bar always says whether you are offline.</li>
            </ul>
          </div>
          <div className="card">
            <h2>Version</h2>
            <p style={{ fontSize: 13.5, color: 'var(--text-dim)', margin: 0 }}>
              Source Kit Desk {DESK_VERSION} — part of the Exhibit project. No telemetry, no accounts, no server.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
