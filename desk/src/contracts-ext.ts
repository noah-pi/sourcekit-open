/**
 * contracts-ext.ts — Source Kit Desk W2 extension types.
 *
 * Same discipline as contracts.ts: TYPES ONLY (no runtime code), safe to
 * import from anywhere. This file EXTENDS the orchestrator-owned interface
 * lock (ARCHITECTURE.md §1/§12) rather than modifying it; contracts.ts wins
 * wherever the two could drift.
 *
 * W2 scope (ARCHITECTURE §3.3/§4): the Tier-0 IntakeReport, the SignalStatus
 * quad-state every dashboard row may occupy, the C2PA summary copied out of
 * the verification path, dashboard tab identifiers, and the serializable
 * cached Tier-1 signal row (results cached on the item via onItemPatched).
 */
import type { DeskItem } from './core/deskItem';
import type { ByteReads, JpegStructure } from './core/byteReads';
import type { CloneDetectionResult, ElaDiffResult, NoiseAnalysisResult } from './core/imageFx';
import type { ParallaxEvidence } from './core/parallax';

/* ------------------------------------------------------------------ */
/* Signal states (DESIGN §5.3, law L3)                                 */
/* ------------------------------------------------------------------ */

/**
 * Every measured or computed signal on the dashboard occupies exactly one
 * of these states. N/A and not-run are first-class, always carry a reason,
 * and are never silently omitted, never counted as pass or fail (L3/L12).
 */
export type SignalStatus =
  | { state: 'observed'; note?: string }
  | { state: 'not-applicable'; reason: string } // L3 — reason mandatory
  | { state: 'not-run'; reason: string }
  | { state: 'error'; reason: string };

/* ------------------------------------------------------------------ */
/* C2PA summary (declarations, attributed — L7/L8/L9)                  */
/* ------------------------------------------------------------------ */

/** One declared C2PA action (edit-history entry). */
export interface C2paAction {
  /** e.g. 'c2pa.edited', 'c2pa.cropped' — or a vendor-specific name. */
  action: string;
  softwareAgent?: string;
  when?: string;
  description?: string;
  /**
   * True only when the SIGNED CLAIM references the actions box. An
   * unreferenced box was attached after signing and proves nothing — the
   * UI must say so, not just render the list.
   */
  referenced: boolean;
}

/** One declared C2PA ingredient (what the file was made from). */
export interface C2paIngredient {
  title?: string;
  format?: string;
  relationship?: string;
  referenced: boolean;
}

/**
 * What the embedded credentials DECLARE, copied out of the parse once at
 * intake. Data, not verdicts: every entry is attributed to the sealing
 * software, and the fixed L8 line rides under every actions list.
 */
export interface C2paSummary {
  /** claim_generator — the software that sealed the active manifest. */
  claimGenerator: string | null;
  manifestLabel: string | null;
  /** >1 means an update chain; only the active manifest is checked. */
  manifestCount: number;
  /** Declared actions — null when the manifest carries no actions box. */
  actions: C2paAction[] | null;
  /** Declared ingredients (may be empty). */
  ingredients: C2paIngredient[];
  /** SHA-256 of the signing key, hex — the signer's public identity. */
  signerFingerprint: string | null;
  /**
   * Declared digital source type (e.g. a trained-algorithm media flag),
   * when a manifest declares one. This build does not parse a
   * digitalSourceType assertion of its own — null means "nothing parsed",
   * which the AI tab renders honestly (L9: self-declarations only, never
   * our detection).
   */
  digitalSourceType: string | null;
}

/* ------------------------------------------------------------------ */
/* Embedded thumbnail result (Tier-0 step 5)                            */
/* ------------------------------------------------------------------ */

/** Pixel-diff stats vs the main image, computed on the main thread. */
export interface ThumbnailDiff {
  /** Mean absolute per-channel difference on the comparison raster, 0–255. */
  meanAbsDiff: number;
  /** Difference share as a 0–1 fraction of the 0–255 range. */
  fraction: number;
  /** The raster the comparison ran on (long side), for transparency. */
  comparedAt: number;
  /**
   * True when the preview differs beyond the comparison floor. A difference
   * is a custody observation, never an accusation (fx.thumb.diff.note).
   */
  differs: boolean;
}

/**
 * The embedded-preview row's final state. Extraction runs in the intake
 * worker (pure bytes); the diff runs on the main thread (canvas — see the
 * OffscreenCanvas risk note, ARCHITECTURE §11).
 */
export type ThumbnailResult =
  | {
      state: 'observed';
      /** The embedded preview bytes as stored (structured-clone safe). */
      bytes: Uint8Array;
      /** Byte length of the embedded preview as stored. */
      byteLength: number;
      /** Decoded preview dimensions when the browser could decode it. */
      width: number | null;
      height: number | null;
      /** Diff vs the main image — or an explicit not-run/error with reason. */
      diff: ThumbnailDiff | SignalStatus | null;
    }
  | { state: 'not-applicable'; reason: string }
  | { state: 'not-run'; reason: string }
  | { state: 'error'; reason: string };

/* ------------------------------------------------------------------ */
/* IntakeReport — the Tier-0 per-asset record (ARCHITECTURE §3.3)       */
/* ------------------------------------------------------------------ */

/**
 * Computed once at intake, cached on the item. The report is DATA, not
 * verdicts: every field is a measurement, a declaration attributed to its
 * source, or an explicit N/A/not-run with reason. `computedAt` is when the
 * computation ran — never "capture time".
 */
export interface IntakeReport {
  itemId: string;
  /** ISO — when the computation ran. */
  computedAt: string;
  /** From the intake hash (worker). */
  sha256Hex: string;
  classification: DeskItem['kind'];
  /** EXIF/XMP/strings layer (§5.1) — null when the item carries no bytes. */
  byteReads: ByteReads | null;
  /** JPEG structure + quantization (JPEG only — N/A with reason otherwise). */
  jpegStructure: JpegStructure | SignalStatus | null;
  /** Embedded thumbnail extraction + diff. */
  thumbnail: ThumbnailResult | SignalStatus | null;
  /** Declared C2PA summary from the intake verification path. */
  c2paSummary: C2paSummary | SignalStatus | null;
  /** Perceptual fingerprint hex — a similarity signal, never a verdict. */
  pHashHex: string | null;
  /**
   * Cross-library custody counts at last render. Counts only — the detail
   * stays in the deskCore match types; App patches these as matches change.
   */
  custody: { recoveryMatches: number; exactAfterStrip: number };
}

/* ------------------------------------------------------------------ */
/* Dashboard tabs (DESIGN §4.2 — always rendered, never hidden)         */
/* ------------------------------------------------------------------ */

export type DashboardTabId = 'overview' | 'signals' | 'forensics' | 'ai';

export const DASHBOARD_TABS: readonly { id: DashboardTabId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'signals', label: 'Signals' },
  { id: 'forensics', label: 'Forensics' },
  { id: 'ai', label: 'AI Forensics' },
] as const;

/* ------------------------------------------------------------------ */
/* Cached Tier-1 signal row (Signals tab — cached on the item)          */
/* ------------------------------------------------------------------ */

/**
 * One analyzer row as rendered by the Signals tab, in serializable form so
 * a completed run can be cached on the item via onItemPatched and a
 * re-opened tab shows the same numbers without re-decoding anything.
 */
export interface CachedSignalRow {
  /** Analyzer id from the desk registry (deskAnalyzer). */
  id: string;
  title: string;
  /** Method version that produced the measurement — reports are re-checkable. */
  version: string;
  /** The measured value(s), or 'insufficient — <reason>'. */
  measurement: string;
  /** The stated range/bound the measurement lives inside. */
  bound: string;
  /** The analyzer's own honesty note. */
  note: string;
  limitations: string[];
  /** True only when the analyzer itself failed to run — the one warn case. */
  failed?: boolean;
  /** ISO — when this run completed. */
  computedAt: string;
}

/* ------------------------------------------------------------------ */
/* W4 — cached Tier-2 results (Forensics tab, ARCHITECTURE §5.3)        */
/* ------------------------------------------------------------------ */

/**
 * Completed Tier-2 runs cached on the item via onItemPatched, so a
 * re-opened Forensics tab shows the same results without recomputing
 * (ARCHITECTURE §5.3: "Results cache via onItemPatched"). All plain,
 * structured-clone-safe data — rasters are typed arrays at the stated
 * analysis caps (≤512px clone, ≤1024px noise/ELA). Absent fields simply
 * mean "not run yet" — the tab renders the not-run row, never a gap.
 * SESSION-ONLY: kept-item (IndexedDB) snapshots strip this cache — the
 * results are recomputable by design and pinning must not multiply
 * storage with derived rasters (libraryStore.snapshotOf).
 *
 * `parallax` caches the evidence from the last ring the user provided in
 * the tab; its inputs are EXTERNAL files (not the item's bytes), so the UI
 * labels it as such and never treats it as an intake fact.
 */
export interface Tier2FxCache {
  clone?: CloneDetectionResult | null;
  noise?: NoiseAnalysisResult | null;
  ela?: ElaDiffResult | null;
  parallax?: ParallaxEvidence | null;
}

/* ------------------------------------------------------------------ */
/* W3 — Tier-3 connectors (ARCHITECTURE §5.4/§6.1, DESIGN §5.8)         */
/* ------------------------------------------------------------------ */

/**
 * A record of ONE consent decision (DESIGN §5.8 — consent is per action;
 * nothing like "don't ask again" exists). Written to the case-file audit
 * trail on BOTH outcomes — a refusal is itself honesty evidence.
 */
export interface ConnectorConsent {
  connectorId: string;
  /** Exact: "the image bytes (4.2 MiB)" — never "data". */
  payloadDescription: string;
  /** "Example Search (images.example.com)" — provider + host. */
  destination: string;
  /** ISO. */
  decidedAt: string;
  accepted: boolean;
}

/**
 * What a connector returns. `summary` is the provider's statement and is
 * always rendered attributed ("[provider] reports: … — their statement,
 * shown as received", L9); `raw` is expandable, labeled "as received".
 */
export interface ConnectorResult {
  ok: boolean;
  /** The provider's statement, rendered attributed — never our detection. */
  summary: string;
  /** Expandable, labeled "as received". */
  raw?: unknown;
  error?: string;
}

/**
 * A Tier-3 connector (ARCHITECTURE §6.1). Everything about the boundary
 * crossing is DECLARED up front: name, provider, and exactly what would be
 * sent (hash vs bytes vs URL). `run` is NEVER called without a recorded
 * consent — the consent flow (core/connectors/connector.ts) is the only
 * caller, and it refuses to invoke `run` from any state but `previewing`.
 *
 * The two shipped connectors are honest stubs: no endpoint ships, no fetch
 * appears anywhere, and `run` reports plainly that no request
 * implementation exists in this build. The shape admits a real endpoint
 * later — including, eventually, an LLM summarizer whose payload would be
 * an AssistantSummary, never the media bytes by default (§6.3).
 */
export interface Connector {
  id: string;
  /** "Reverse image search" (ai.connector.ris.name). */
  name: string;
  /** Shown in the consent dialog and in result attribution (L9). */
  provider: string;
  /** The payload category, declared before any consent: what WOULD leave. */
  payloadKind: 'hash' | 'bytes' | 'url';
  /** What WOULD be sent, pre-consent — exact, never "data" (L10). */
  describesPayload: (item: DeskItem) => string;
  /** N/A states with mandatory reasons (L3): no bytes, no endpoint, … */
  canRun: (item: DeskItem) => { ok: true } | { ok: false; reason: string };
  /** Only ever invoked by the consent flow after a recorded consent. */
  run: (item: DeskItem, signal: AbortSignal) => Promise<ConnectorResult>;
}

/**
 * User-declared connector endpoints (Settings → connectors card), persisted
 * under `exhibitC.connectors.v1` and wiped by Clear. Empty by default —
 * no connector ships configured, and nothing is ever automatic (L10).
 */
export type ConnectorPrefs = Record<string, { endpoint: string } | undefined>;

/* ------------------------------------------------------------------ */
/* W3 — the Assistant (ARCHITECTURE §6.3)                               */
/* ------------------------------------------------------------------ */

/**
 * Where a sentence's evidence lives on the dashboard. The UI deep-links
 * every Assistant sentence to its basis — the Assistant may say nothing
 * that isn't already on the dashboard (L1/L7).
 */
export interface BasisRef {
  tab: DashboardTabId;
  /** Stable card id within the tab (rendered as the card's DOM id). */
  card: string;
}

/** One plain-language sentence (or two) plus its evidence basis. */
export interface AssistantParagraph {
  text: string;
  basis: BasisRef;
}

/**
 * The Assistant's output: template-based, deterministic, a restatement of
 * computed evidence — never a detection, never a score (L1/L2/L7). The
 * fixed deck disclaimer (ai.assistant.disclaimer) renders under it.
 */
export interface AssistantSummary {
  paragraphs: AssistantParagraph[];
  /**
   * The memo key of the inputs this summary was generated from
   * (assistantInputKey) — regeneration is keyed on input ids + method
   * versions, so a changed evidence base always regenerates.
   */
  inputKey: string;
}

/** Everything the Assistant may read — the same evidence the tabs show. */
export interface AssistantInput {
  item: DeskItem;
  trust: import('./core/deskCore').DeskTrust | null;
  artifact: import('./core/deskCore').ArtifactCheck | null;
  matches: import('./core/deskCore').RecoveryMatch[];
  custodyMatches: import('./core/deskCore').ManifestCustodyMatch[];
}
