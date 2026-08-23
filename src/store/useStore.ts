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
 * CAWG-aligned identity disclosure, per capture:
 *   anonymous     — no byline, no org claim ('redacted' in the record)
 *   organization  — the installed org credential vouches for the org, with no
 *                   personal byline; with no credential installed the record
 *                   reads as anonymous
 *   named         — personal byline plus org credential when installed
 */
export type IdentityMode = 'anonymous' | 'organization' | 'named';

export interface Settings {
  author: string;
  includeLocation: boolean;
  includeSensors: boolean;
  /**
   * Byline inclusion: with this on and identityMode 'named', the self-declared
   * alias is embedded as the byline. Default off, and mirrored on the camera
   * HUD, because an embedded name identifies the author.
   */
  includeByline: boolean;
  /**
   * Audio transcript embedding: voice notes carry the on-device transcript
   * inside the signed file. Off keeps the words audio-only.
   */
  includeTranscript: boolean;
  /**
   * Runs an OS Face ID check at capture start and records only the boolean
   * outcome (`captureIntegrity.biometricGatePassed`). No face geometry or
   * template is stored.
   */
  faceCheckEnabled: boolean;
  /**
   * Records the SSID/BSSID the phone reports at capture. Off by default;
   * self-reported and spoofable, so it is a lead, not proof of place. Always
   * stripped from de-identified copies, and empty unless the build carries the
   * Wi-Fi Information entitlement and location permission.
   */
  includeWifi: boolean;
  identityMode: IdentityMode;
  saveToCameraRoll: boolean;
  biometricsEnabled: boolean;
  biometricSigning: boolean;
  /**
   * Submits each capture's payload digest to the public OpenTimestamps
   * calendars. Hash only — no media, no account. On by default. When off,
   * captures carry RFC 3161 time only and the record says nothing about OTS.
   */
  otsEnabled: boolean;
  /** Custom OTS calendar base URLs; null = the free public defaults. */
  otsCalendars: string[] | null;
  /** Custom RFC 3161 TSA URLs; null = the built-in witness pool. */
  tsaUrls: string[] | null;
  /**
   * One pinned Esplora base URL; null uses the public pool. Tips are fetched
   * on a jittered schedule, never per capture.
   */
  beaconEndpoint: string | null;
  /**
   * Which evidence sinks the native capture session runs. All on by default.
   * Off means the files are never written and the record says
   * 'never-recorded', distinct from the null an enabled-but-failed sink
   * leaves. Files stay on-device and are not analyzed here.
   *
   * loadSettings strips the retired `sensors` and `secondaryLens` keys from
   * stored settings: the sensor log follows includeSensors, and the stereo
   * partner is always the native 'auto' pairing.
   */
  captureEvidence: {
    ring: boolean;
    rawPcm: boolean;
    altView: boolean;
  };
  /**
   * Light preferences, one per capture mode; the modes share no light state.
   *  - photoFlash: photo capture light (auto/on/off, bolt glyph + state
   *    badge). The bridge exposes no photo-strobe API, so the camera screen
   *    drives it through the torch setter via setPhotoFlashPreference, the
   *    single plug point for a native flashMode contract.
   *  - videoTorch: video continuous light (flashlight glyph, on/off).
   */
  photoFlash: 'auto' | 'on' | 'off';
  videoTorch: boolean;
  /**
   * Appearance: 'device' follows the iPhone's dark-mode setting; 'dark' and
   * 'light' pin the in-app palette. Default 'device'. Cosmetic only; records
   * are unaffected.
   */
  appearance: AppearancePreference;
  /**
   * Migration marker, persisted so the migration runs exactly once. Absent on
   * fresh installs and older stores, which migrate on next load.
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
        // Pre-migration: includeIdentity (boolean) → identityMode.
        if (stored.identityMode === undefined) {
          stored.identityMode = stored.includeIdentity === true ? 'named' : 'anonymous';
        }
        delete stored.includeIdentity;
        // Retired CaptureKit toggle key: dropped from stored settings.
        delete stored.captureKitEnabled;
        delete stored.assignmentId;
        // One-time migration:
        //   • named identity with a non-empty alias keeps includeByline on.
        //   • otsEnabled forced true to match the always-on Bitcoin anchor.
        const needsMigration_0_11_1 = stored.migrated_0_11_1 !== true;
        if (needsMigration_0_11_1) {
          if (
            stored.identityMode === 'named' &&
            typeof stored.author === 'string' &&
            stored.author.trim() !== ''
          ) {
            stored.includeByline = true;
          }
          stored.otsEnabled = true;
          stored.migrated_0_11_1 = true;
        }
        // Anything outside the three choices falls back to the default.
        if (stored.appearance !== undefined && !['device', 'dark', 'light'].includes(stored.appearance)) {
          delete stored.appearance;
        }
        const merged = { ...DEFAULT_SETTINGS, ...stored };
        // Strip retired captureEvidence keys before the merge; the spread
        // below would otherwise carry them forward indefinitely.
        if (stored.captureEvidence && typeof stored.captureEvidence === 'object') {
          delete stored.captureEvidence.sensors;
          delete stored.captureEvidence.secondaryLens;
        }
        // A shallow merge drops nested keys the stored object predates, so
        // rebuild the evidence object over the defaults: new sinks default on
        // and existing choices survive verbatim.
        merged.captureEvidence = { ...DEFAULT_SETTINGS.captureEvidence, ...(stored.captureEvidence ?? {}) };
        setTsaUrls(merged.tsaUrls);
        // Push the persisted appearance into the theme before first paint.
        setAppearancePreference(merged.appearance);
        set({
          settings: merged,
          onboarded: parsed.onboarded === true,
          settingsLoaded: true,
        });
        // Persist the marker immediately so the migration runs once; without
        // it a later includeByline opt-out would be migrated back on.
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
