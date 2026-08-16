/**
 * contracts.ts — Source Kit Desk 0.15.1 cross-agent interface lock.
 *
 * ORCHESTRATOR-OWNED. READ-ONLY for all implementation agents.
 * Types only (no runtime code) — safe to import from anywhere, no cycles.
 * If you think this file needs to change, stop and flag it in your report
 * instead of editing it.
 */
import type { Roster } from '@exhibit/lib/roster';
import type { DeskItem } from './core/deskItem';
import type {
  DeskTrust,
  ArtifactCheck,
  RecoveryMatch,
  ManifestCustodyMatch,
} from './core/deskCore';

/** pHash lead thresholds (was an anonymous object in App state). */
export interface Thresholds {
  likely: number;
  possible: number;
}

/** A roster the user has chosen to trust on this machine. */
export type TrustedRoster = Roster;

/* ------------------------------------------------------------------ */
/* Agent B — Library                                                   */
/* ------------------------------------------------------------------ */

/**
 * LibraryPanel: the main-pane media library (grid/list, sort, filter,
 * search, multi-select). Intake is NOT inside it — App composes the
 * sidebar (Intake + CasePanel) and LibraryPanel separately.
 */
export interface LibraryPanelProps {
  items: DeskItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (ids: string[]) => void;
  /** Ids the user pinned to persist in this browser (single source of truth). */
  remembered: ReadonlySet<string>;
  onToggleRemember: (id: string) => void;
}

/**
 * Intake (reworked): sidebar dropzone + ingest queue with progress/cancel.
 * The old item-list rendering moves OUT of Intake into LibraryPanel.
 * Props are narrowed accordingly — App's pipeline callbacks are unchanged.
 */
export interface IntakeProps {
  onAdd: (items: DeskItem[]) => void;
  onRosterFile: (item: DeskItem) => void;
  onOpenCase: (file: File) => void;
}

/**
 * libraryStore (src/core/libraryStore.ts, Agent B): opt-in per-item
 * persistence in IndexedDB (`exhibit-c-library`). Default session-only
 * behavior is unchanged; these are called only for remembered items.
 */
export interface LibraryStore {
  /** All remembered entries (bytes + serialized item). Fail closed: throws. */
  loadAll(): Promise<Array<{ item: DeskItem; bytes: Blob }>>;
  put(item: DeskItem, bytes: Blob): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
}
export declare const libraryStore: LibraryStore;

/* ------------------------------------------------------------------ */
/* Agent C — Asset dashboard                                           */
/* ------------------------------------------------------------------ */

/**
 * AssetDashboard: per-asset forensic dashboard with sub-tabs
 * Overview / Signals / Forensics / AI Forensics.
 * App keeps computing trust/artifact/matches/custodyMatches exactly as it
 * does for DossierView today and passes them through.
 */
export interface AssetDashboardProps {
  item: DeskItem;
  trust: DeskTrust | null;
  artifact: ArtifactCheck | null;
  matches: RecoveryMatch[];
  custodyMatches: ManifestCustodyMatch[];
  /**
   * Optional: patch the item back into App state (e.g. to cache an
   * expensive ad hoc analyzer's result on the item). The patch is a MERGE
   * function — App applies it to the CURRENT item inside its items-setter,
   * so concurrent analyzer completions can never overwrite each other's
   * cached results with a stale render-closure snapshot.
   */
  onItemPatched?: (id: string, patch: (current: DeskItem) => DeskItem) => void;
}

/* ------------------------------------------------------------------ */
/* CSS partition (class-prefix discipline)                             */
/* ------------------------------------------------------------------
 * styles.css (Agent A): tokens + shared primitives ONLY — .card, .pill,
 * .btn*, .honest-note, .warn-box, .topbar, .tabs, .layout, inputs.
 * library.css (Agent B, imported by LibraryPanel.tsx): classes prefixed
 * .lib-* — covers ALL markup B authors, including the reworked Intake.
 * dashboard.css (Agent C, imported by AssetDashboard.tsx): classes
 * prefixed .dash-* / .fx-* — covers ALL markup C authors, including the
 * restructured Overview (ex-DossierView), Signals, Forensics, AI tab.
 */
