// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Global app state (zustand) + settings persistence.
 *
 * Settings live in a plain JSON file in the app sandbox — nothing in them is
 * secret. Secrets (device key, vault key, passcode hash) live exclusively in
 * the OS keychain via their own modules.
 */

import { create } from 'zustand';
import * as FileSystem from 'expo-file-system/legacy';
import { setTsaUrls } from '../lib/timestamp';
import { setAppearancePreference, type AppearancePreference } from '../theme';

const SETTINGS_FILE = `${FileSystem.documentDirectory}settings.json`;

/**
 * CAWG-aligned identity disclosure, per capture (0.9.0):
 *   anonymous     — no byline, no org claim ('redacted' in the record)
 *   organization  — the installed org credential vouches for the org, no
 *                   personal byline (the stringer-in-a-hostile-country
 *                   setting; without an org credential it is effectively
 *                   anonymous, and the record shows exactly that)
 *   named         — personal byline + org credential when installed
 */
export type IdentityMode = 'anonymous' | 'organization' | 'named';

export interface Settings {
  author: string;
  includeLocation: boolean;
  includeSensors: boolean;
  /**
   * Byline inclusion (0.11.1, the camera "Name" HUD toggle): when on AND
   * identityMode is 'named', the self-declared alias is embedded as the
   * byline. Default OFF — an embedded name is identifying by design, so it
   * is a deliberate, visible-at-a-glance choice, mirrored on the camera HUD.
   */
  includeByline: boolean;
  /**
   * Audio transcript embedding (0.11.1 toggle board): when on, voice notes
   * carry the on-device transcript inside the signed file. Off = the words
   * stay audio-only.
   */
  includeTranscript: boolean;
  /**
   * Face check (0.11.1): when on, capture runs an OS Face ID check at
   * capture start and the seal records ONLY the boolean outcome in the
   * record telemetry (`captureIntegrity.biometricGatePassed`). An event
   * record, not an identity — no face geometry or template is ever stored.
   */
  faceCheckEnabled: boolean;
  /**
   * Wi-Fi network claim: record the SSID/BSSID the phone
   * reports at capture. STRICTLY OPT-IN — default off. Self-reported and
   * spoofable, so it is a lead for a desk, never proof of place. Always
   * stripped from de-identified copies. On iOS it returns nothing unless the
   * build carries the Wi-Fi Information entitlement and location permission.
   */
  includeWifi: boolean;
  identityMode: IdentityMode;
  saveToCameraRoll: boolean;
  biometricsEnabled: boolean;
  biometricSigning: boolean;
  /**
   * Assignment mode (0.9.0 source protection): when non-empty, captures sign
   * with a dedicated assignment key instead of the device key — assignments
   * are unlinkable to each other and to the device. Honest cost, stated in
   * the UI: software-backed key, no hardware attestation.
   */
  assignmentId: string;
  /**
   * Ledger anchoring (0.9.1): submit each capture's payload digest to the
   * free public OpenTimestamps calendars (Bitcoin-anchored time). Hash-only —
   * no media, no account, no cost. Default on. When off, captures carry
   * RFC 3161 authority time only and the record says nothing about OTS.
   */
  otsEnabled: boolean;
  /** Custom OTS calendar base URLs; null = the free public defaults. */
  otsCalendars: string[] | null;
  /** Custom RFC 3161 TSA URLs; null = the built-in witness pool. */
  tsaUrls: string[] | null;
  /**
   * Bitcoin beacon endpoint (0.10.0): one Esplora base URL pinned by the
   * user/newsroom; null = the default public pool. Tips are fetched on a
   * jittered schedule decoupled from shutter events — never per capture.
   */
  beaconEndpoint: string | null;
  /**
   * Capture evidence collection (1.0.0, WS1 CaptureKit; E.04 three-state):
   * which evidence sinks the native capture session runs — the stills
   * parallax ring, the raw audio master. Default all on. OFF means DO NOT
   * COLLECT: the evidence files are never written, and future captures say
   * so explicitly in the record ('never-recorded' — distinct from an
   * enabled-but-failed null). The evidence is on-device input for later
   * desk-side analysis; the phone never analyzes it.
   *
   * 0.18.1: two fields retired —
   *   • sensors: the full-rate (100 Hz) sensor log now follows the single
   *     Motion log toggle (includeSensors); there is no 10 Hz option.
   *   • secondaryLens: the stereo partner is always the native 'auto'
   *     pairing; the picker is gone.
   * Both are coerced out of stored settings on load (see loadSettings).
   */
  captureEvidence: {
    ring: boolean;
    rawPcm: boolean;
    altView: boolean;
  };
  /**
   * Light preferences, per capture mode (0.15.0 Drop 2) — the two modes
   * never share a light state, and their icons never conflate:
   *  - photoFlash: the PHOTO capture-light preference (auto/on/off, bolt
   *    glyph + state badge). INTERIM: the bridge has no photo-strobe API
   *    yet, so the camera screen drives it through the torch setter via
   *    setPhotoFlashPreference (the single plug point for the native
   *    flashMode contract when that wave lands).
   *  - videoTorch: the VIDEO continuous light (flashlight glyph, on/off).
   */
  photoFlash: 'auto' | 'on' | 'off';
  videoTorch: boolean;
  /**
   * Appearance (0.15.x, Track E): 'device' follows the iPhone's dark-mode
   * setting; 'dark'/'light' pin the in-app palette regardless of the OS.
   * Default 'device'. Purely cosmetic — nothing about a record changes.
   */
  appearance: AppearancePreference;
  /**
   * One-time 0.11.0 → 0.11.1 migration marker.
   * Persisted so the migration runs exactly once; absent on fresh installs
   * and pre-0.11.1 stores (which then migrate on next load).
   */
  migrated_0_11_1?: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  author: '',
  includeLocation: true,
  includeSensors: true,
  includeByline: false, // identifying by design — opt-in, HUD-visible
  includeTranscript: true,
  faceCheckEnabled: false,
  includeWifi: false, // opt-in by design — a network name is identifying
  identityMode: 'anonymous',
  saveToCameraRoll: false,
  biometricsEnabled: false,
  biometricSigning: false,
  assignmentId: '',
  otsEnabled: true,
  otsCalendars: null,
  tsaUrls: null,
  beaconEndpoint: null,
  captureEvidence: { ring: true, rawPcm: true, altView: true },
  photoFlash: 'auto', // no light unless asked
  videoTorch: false,
  appearance: 'device', // follow the iPhone unless the user says otherwise
};

interface AppState {
  settings: Settings;
  settingsLoaded: boolean;
  onboarded: boolean;
  unlocked: boolean;
  /** Bumped whenever the vault changes so lists re-fetch. */
  vaultVersion: number;
  passcodeSet: boolean;

  loadSettings: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  setOnboarded: (v: boolean) => Promise<void>;
  setUnlocked: (v: boolean) => void;
  setPasscodeSet: (v: boolean) => void;
  bumpVault: () => void;
}

async function persist(settings: Settings, onboarded: boolean): Promise<void> {
  try {
    await FileSystem.writeAsStringAsync(SETTINGS_FILE, JSON.stringify({ settings, onboarded }));
  } catch {
    // Non-fatal: settings simply won't survive a reinstall.
  }
}

export const useStore = create<AppState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  settingsLoaded: false,
  onboarded: false,
  unlocked: false,
  vaultVersion: 0,
  passcodeSet: false,

  loadSettings: async () => {
    try {
      const info = await FileSystem.getInfoAsync(SETTINGS_FILE);
      if (info.exists) {
        const raw = await FileSystem.readAsStringAsync(SETTINGS_FILE);
        const parsed = JSON.parse(raw);
        const stored = parsed.settings ?? {};
        // Pre-0.9.0 migration: includeIdentity (boolean) → identityMode.
        if (stored.identityMode === undefined) {
          stored.identityMode = stored.includeIdentity === true ? 'named' : 'anonymous';
        }
        delete stored.includeIdentity;
        // 0.13.0: CaptureKit retired (the 0.12.x two-session-owners lesson)
        // — the experimental toggle key is dropped from stored settings.
        delete stored.captureKitEnabled;
        // 0.11.0 → 0.11.1 migration — one-time, guarded:
        //   • named identity with a non-empty alias keeps its 0.11.0 behavior:
        //     the byline was embedded then, so includeByline stays ON.
        //   • a stale assignmentId is cleared — the assignment UI is gone and
        //     a leftover id must not silently keep signing assignment-mode.
        //   • otsEnabled forced true — the Bitcoin anchor is default-always-on
        //     now; the Settings display must stay honest about it.
        const needsMigration_0_11_1 = stored.migrated_0_11_1 !== true;
        if (needsMigration_0_11_1) {
          if (
            stored.identityMode === 'named' &&
            typeof stored.author === 'string' &&
            stored.author.trim() !== ''
          ) {
            stored.includeByline = true;
          }
          if (typeof stored.assignmentId === 'string' && stored.assignmentId !== '') {
            stored.assignmentId = '';
          }
          stored.otsEnabled = true;
          stored.migrated_0_11_1 = true;
        }
        // Guard against a corrupted/unknown stored value — anything outside
        // the three choices falls back to the default.
        if (stored.appearance !== undefined && !['device', 'dark', 'light'].includes(stored.appearance)) {
          delete stored.appearance;
        }
        const merged = { ...DEFAULT_SETTINGS, ...stored };
        // 0.18.1: coerce retired captureEvidence keys out of the stored
        // object BEFORE the merge — otherwise the spread below would carry
        // them forward forever (full-rate is now implied by includeSensors;
        // the stereo partner is always the native 'auto' pairing).
        if (stored.captureEvidence && typeof stored.captureEvidence === 'object') {
          delete stored.captureEvidence.sensors;
          delete stored.captureEvidence.secondaryLens;
        }
        // Shallow merge would DROP keys added to nested objects after the
        // user's store was written (0.14.0: captureEvidence.altView). Rebuild
        // the nested evidence object over the defaults so new sinks default
        // ON and existing choices survive verbatim.
        merged.captureEvidence = { ...DEFAULT_SETTINGS.captureEvidence, ...(stored.captureEvidence ?? {}) };
        setTsaUrls(merged.tsaUrls);
        // Push the persisted appearance into the theme before first paint.
        setAppearancePreference(merged.appearance);
        set({
          settings: merged,
          onboarded: parsed.onboarded === true,
          settingsLoaded: true,
        });
        // Persist the migration marker immediately so it runs exactly once —
        // otherwise a later includeByline opt-out would be re-migrated back on.
        if (needsMigration_0_11_1) await persist(merged, parsed.onboarded === true);
        return;
      }
    } catch {
      // Fall through to defaults.
    }
    set({ settingsLoaded: true });
  },

  saveSettings: async (patch) => {
    const settings = { ...get().settings, ...patch };
    if (patch.tsaUrls !== undefined) setTsaUrls(settings.tsaUrls);
    if (patch.appearance !== undefined) setAppearancePreference(settings.appearance);
    set({ settings });
    await persist(settings, get().onboarded);
  },

  setOnboarded: async (v) => {
    set({ onboarded: v });
    await persist(get().settings, v);
  },

  setUnlocked: (v) => set({ unlocked: v }),
  setPasscodeSet: (v) => set({ passcodeSet: v }),
  bumpVault: () => set((s) => ({ vaultVersion: s.vaultVersion + 1 })),
}));
