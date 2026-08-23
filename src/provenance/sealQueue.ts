// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * The seal queue — capture and seal are separate steps. The shutter's critical
 * path is expose → write the raw file → enqueue; hashing, Secure Enclave
 * signing, the TSA countersign, C2PA embedding, and vault encryption all run
 * here in a serial background pump.
 *
 *   - Serial order: jobs seal in capture order.
 *   - Capture time is recorded at enqueue, not at seal.
 *   - The queue persists to disk, so sealing resumes after a crash or
 *     relaunch. Vault insertion is the last step, so nothing is half-written.
 *   - Offline, the TSA countersign degrades to device-clock time (attestPhoto
 *     handles a null token) and the seal still completes.
 *   - A job that keeps failing is marked failed and its draft kept.
 *   - Drafts are vault-sealed at enqueue, so no plaintext capture rests in the
 *     queue. Sealing resumes on unlock.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { attestPhoto, attestAudio, attestVideo, resolveDepthSealInput, resolveSecondarySealInput, type EvidenceEnabledSnapshot, type DepthCommitInput, type SecondaryCommitInput } from './attest';
import type { CaptureEvidencePaths, SensorContext, StreamedChunksTrackId, TrackChunkMap } from './manifest';
import {
  createItemState,
  runBurnScheduler,
  type CommittedCaptureForStore,
  type DisclosureItemState,
  type DisclosureStore,
} from '../disclosure/burn';
import type { SealedCaptureDisclosure } from '../disclosure/captureCommit';
import type { TranscriptAssertion } from '../c2pa/c2pa';
import { saveItem, updateRecord, sealVaultJson, unsealVaultJson, sealVaultBytes, unsealVaultBytes, plainWorkUri, ensureVaultDirs, isVaultLockedError } from '../vault/vaultFs';
import { concatBytes, bytesToHex } from '../lib/bytes';
import { sha256 } from '@noble/hashes/sha256';
import type { ContextClaim } from '../disclosure/inventory';
import { getDeviceKey } from '../lib/deviceKey';
import { getOrCreatePqKey } from '../lib/pqKeyStore';
import { collectIntegritySignals } from '../lib/integrity';
import { anchorRecordWithOts, drainOtsQueue } from './otsQueue';
import { currentBeacon } from '../lib/beacon';
import { useStore } from '../store/useStore';
import { writeFileBytes, readFileBytes, hashFileSha256 } from '../lib/fileHash';
import { logDiagnostic } from '../lib/diagnosticsLog';
import { describeEvidencePath, type CaptureResult, type EvidencePath as ExhibitEvidencePath } from '../lib/exhibitCamera';
import { commitStereoArtifacts, commitStereoVideoArtifacts, type StereoBundleSection, type VideoStereoBundleSection } from './stereoArtifacts';
import { buildStereoInputs, buildStereoVideoPairInputs, type CommittedStereoFile, type StereoVideoPairEvent } from './stereoGlue';
import * as MediaLibrary from 'expo-media-library/legacy';

const DIR = `${FileSystem.documentDirectory}seal-queue/`;
const QUEUE_FILE = `${DIR}jobs.json`;
const MAX_ATTEMPTS = 4;

type Identity = { author: string | null; organization: string | null } | 'redacted';

export interface SealJob {
  id: string;
  /** Absent means photo (legacy queue entries carry no kind). */
  kind?: 'photo' | 'audio' | 'video';
  draftUri: string;
  context: SensorContext;
  identity: Identity;
  capturedAt: string;
  /** On-device transcript captured at stop time (audio jobs). */
  transcript?: TranscriptAssertion | null;
  /** Sanitized camera EXIF captured at the shutter (photo jobs). */
  exif?: Record<string, number | string> | null;
  /**
   * CaptureKit evidence-file paths — raw PCM master, sensor log, stills ring
   * dump; merged into the record's context block at seal time. Audio jobs use
   * only the sensor-log slot (the recorder's gyro JSONL); PCM and ring stay
   * structural 'never-recorded'.
   */
  captureEvidence?: CaptureEvidencePaths | null;
  /**
   * The full ExhibitCamera CaptureResult: captureId, delivery path, stereo
   * session state, and the three-state EvidencePaths for secondary frame,
   * calibration, timestamps, metadata, and RAW DNG. The pump stores the
   * artifact files under the sealed record's evidence dir
   * (storeExhibitArtifacts).
   */
  exhibitCapture?: CaptureResult | null;
  /**
   * ExhibitCamera video session facts. audioTrack false means the delivery
   * file has no audio track; the pair counts and evidence dir locate the
   * periodic stereo pairs committed during recording.
   */
  exhibitVideo?: {
    audioTrack: boolean;
    pairsCommitted: number;
    pairsMissed: number;
    hardwareCost: number | null;
    evidenceDir: string;
    /** Session stereo availability as probed at configure time, verbatim. */
    stereo?: 'available' | 'unsupported' | 'unreached';
    /** The onStereoPairCaptured events collected during recording: per-pair
        enumeration plus PTS anchors. The module writes no per-pair timestamps
        file, so these events are the anchors. */
    pairEvents?: StereoVideoPairEvent[];
  } | null;
  /**
   * Result of the OS biometric check run at capture start when the toggle is
   * on; null when off. Signed into the record's captureIntegrity telemetry.
   * The boolean only — no face geometry, template, or image.
   */
  biometricGatePassed?: boolean | null;
  attempts: number;
  state: 'pending' | 'sealing' | 'failed';
  error?: string;
}

type Listener = (pending: number) => void;

let jobs: SealJob[] | null = null; // null = not yet loaded
let pumping = false;
const listeners = new Set<Listener>();

/**
 * Container rebasing: a reinstall moves Documents into a new app-container
 * UUID, so persisted paths name a container that no longer exists and intact
 * drafts read as "file does not exist". The layout under Documents/ is stable
 * across the move, so at load every persisted path's container prefix is
 * rewritten to this install's container.
 */
const CONTAINER_PREFIX = /^(file:\/\/?\/?)?\/?var\/mobile\/Containers\/Data\/Application\/[0-9A-Fa-f-]+\/Documents\//;
function rebaseContainerPath(p: string): string {
  const doc = FileSystem.documentDirectory;
  if (!doc || typeof p !== 'string') return p;
  return p.replace(CONTAINER_PREFIX, doc);
}

/** Deep-walks a freshly parsed persisted value, rebasing every container-prefixed string in place. */
function rebasePersistedPaths(v: unknown): void {
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] === 'string') v[i] = rebaseContainerPath(v[i] as string);
      else rebasePersistedPaths(v[i]);
    }
    return;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (typeof o[k] === 'string') o[k] = rebaseContainerPath(o[k] as string);
      else rebasePersistedPaths(o[k]);
    }
  }
}

async function ensureLoaded(): Promise<SealJob[]> {
  if (jobs) return jobs;
  try {
    // The queue holds GPS coords, byline, and transcripts, so it is sealed
    // with the vault key. The plaintext fallback covers older queue files.
    const bytes = await readFileBytes(QUEUE_FILE);
    const sealed = await unsealVaultJson<SealJob[]>(bytes);
    if (sealed) {
      jobs = sealed;
    } else {
      jobs = JSON.parse(new TextDecoder().decode(bytes)) as SealJob[];
    }
    for (const j of jobs) {
      // Anything interrupted mid-seal goes back to pending; the draft is intact.
      if (j.state === 'sealing') j.state = 'pending';
      // Rebase container-stale paths (draft, evidence paths, exhibitCapture)
      // to this install's container. See rebaseContainerPath.
      rebasePersistedPaths(j);
    }
  } catch {
    jobs = [];
  }
  return jobs;
}

async function persist(): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  await writeFileBytes(QUEUE_FILE, await sealVaultJson(jobs ?? []));
}

function notify(): void {
  const n = (jobs ?? []).filter((j) => j.state !== 'failed').length;
  listeners.forEach((l) => l(n));
  notifyJobs();
}

// ---------------------------------------------------------------------------
// Seal-job visibility. The queue keeps failed jobs and their verbatim error
// strings; since vault insertion is the last step, a failed seal never appears
// in Exhibits. This read API backs the Exhibits "needs attention" section.
// ---------------------------------------------------------------------------

/** UI-facing snapshot of one job; a copy, not the live job object. */
export interface SealJobSnapshot {
  id: string;
  kind: 'photo' | 'audio' | 'video';
  capturedAt: string;
  state: 'pending' | 'sealing' | 'failed';
  /** The verbatim error string when state === 'failed'. */
  error?: string;
  attempts: number;
}

type JobsListener = (jobs: SealJobSnapshot[]) => void;
const jobListeners = new Set<JobsListener>();

function snapshotJobs(): SealJobSnapshot[] {
  return (jobs ?? []).map((j) => ({
    id: j.id,
    kind: j.kind ?? 'photo',
    capturedAt: j.capturedAt,
    state: j.state,
    error: j.error,
    attempts: j.attempts,
  }));
}

function notifyJobs(): void {
  const s = snapshotJobs();
  jobListeners.forEach((l) => l(s));
}

/** Mirrors subscribeSeals: immediate snapshot on subscribe, then live updates. */
export function subscribeSealJobs(l: JobsListener): () => void {
  jobListeners.add(l);
  ensureLoaded().then(notifyJobs).catch(() => {});
  return () => jobListeners.delete(l);
}

/**
 * User-initiated retry of a failed job: resets the attempt budget, clears the
 * error, kicks the pump. No-op for jobs that are not failed.
 */
export async function retrySealJob(id: string): Promise<void> {
  const list = await ensureLoaded();
  const job = list.find((j) => j.id === id);
  if (!job || job.state !== 'failed') return;
  job.attempts = 0;
  job.state = 'pending';
  delete job.error;
  await persist();
  logDiagnostic({ t: Date.now(), kind: 'seal', outcome: 'retry', message: `${job.kind ?? 'photo'} captured ${job.capturedAt}` });
  notify();
  void pump();
}

/**
 * User-initiated discard of a failed job (Needs-attention card's Remove).
 * Deletes the armored draft, drops the job, persists, notifies. No-op for jobs
 * that are not failed.
 */
export async function discardSealJob(id: string): Promise<void> {
  const list = await ensureLoaded();
  const job = list.find((j) => j.id === id);
  if (!job || job.state !== 'failed') return;
  jobs = list.filter((j) => j.id !== id);
  await FileSystem.deleteAsync(job.draftUri, { idempotent: true }).catch(() => {});
  await persist();
  logDiagnostic({ t: Date.now(), kind: 'seal', outcome: 'discard', message: `${job.kind ?? 'photo'} captured ${job.capturedAt}` });
  notify();
}

/**
 * User-initiated cancel of a pending job: deletes the armored draft, drops the
 * job, persists, notifies.
 *
 * A cancel requested while the pump holds the job ('sealing') is cooperative —
 * the id is marked here and honored at the pump's checkpoints, all of which
 * sit before the vault insertion, so a cancel never lands mid-write. A seal
 * past the last checkpoint completes and lands as a sealed exhibit. No-op for
 * failed jobs; their path is discardSealJob.
 */
const cancelRequested = new Set<string>();

export async function cancelSealJob(id: string): Promise<void> {
  const list = await ensureLoaded();
  const job = list.find((j) => j.id === id);
  if (!job) return;
  if (job.state === 'sealing') {
    cancelRequested.add(id);
    return;
  }
  if (job.state !== 'pending') return;
  jobs = list.filter((j) => j.id !== id);
  await FileSystem.deleteAsync(job.draftUri, { idempotent: true }).catch(() => {});
  await persist();
  logDiagnostic({ t: Date.now(), kind: 'seal', outcome: 'discard', message: `${job.kind ?? 'photo'} captured ${job.capturedAt} · cancelled while queued` });
  notify();
}

/**
 * Pump checkpoint: honors a mid-seal cancel between major steps, never
 * mid-write. On abandon the work file and armored draft are deleted and the
 * job drops out of the queue. Returns true when the job was abandoned.
 */
async function abandonIfCancelled(job: SealJob, workCleanup: string | null): Promise<boolean> {
  if (!cancelRequested.has(job.id)) return false;
  cancelRequested.delete(job.id);
  if (workCleanup) await FileSystem.deleteAsync(workCleanup, { idempotent: true }).catch(() => {});
  jobs = (jobs ?? []).filter((j) => j.id !== job.id);
  await FileSystem.deleteAsync(job.draftUri, { idempotent: true }).catch(() => {});
  await persist();
  logDiagnostic({ t: Date.now(), kind: 'seal', outcome: 'discard', message: `${job.kind ?? 'photo'} captured ${job.capturedAt} · cancelled while sealing` });
  notify();
  return true;
}

/**
 * Draft armor: drafts are vault-sealed before they rest, so no plaintext
 * capture sits in the queue. Small drafts seal inline on the enqueue path; a
 * large video seals in a background pass to keep the shutter fast. The pump
 * unseals on read and falls back to plaintext, so unarmored drafts still work.
 * The magic prefix distinguishes the two formats.
 */
const DRAFT_MAGIC = new Uint8Array([0x56, 0x51, 0x31]); // 'VQ1'
const ARMOR_SYNC_MAX = 64 * 1024 * 1024;

async function armorDraft(draftUri: string, sync: boolean): Promise<void> {
  const work = async () => {
    try {
      const sealed = await sealVaultBytes(await readFileBytes(draftUri));
      const tmp = `${draftUri}.sealing`;
      await writeFileBytes(tmp, concatBytes(DRAFT_MAGIC, sealed));
      await FileSystem.deleteAsync(draftUri, { idempotent: true }).catch(() => {});
      await FileSystem.moveAsync({ from: tmp, to: draftUri });
    } catch {
      // Best-effort: the pump's plaintext fallback still seals the job.
    }
  };
  if (sync) await work();
  else void work();
}

/** Full queue wipe, called by destroyVault. */
export async function wipeSealQueue(): Promise<void> {
  jobs = [];
  notify();
  await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
}

export function subscribeSeals(l: Listener): () => void {
  listeners.add(l);
  ensureLoaded().then(notify).catch(() => {});
  return () => listeners.delete(l);
}

/**
 * Completion signal, fired only when a seal completes. The count listener
 * cannot distinguish drained from failed. UI-only; the engine ignores it.
 */
type CompletionListener = (info: { kind: 'photo' | 'video' | 'audio'; itemId: string }) => void;
const completionListeners = new Set<CompletionListener>();

export function subscribeSealCompletions(l: CompletionListener): () => void {
  completionListeners.add(l);
  return () => completionListeners.delete(l);
}

/** Capture-side entry point. Fast: copy the raw file, enqueue, kick the pump. */
export async function enqueuePhotoSeal(params: {
  photoUri: string;
  context: SensorContext;
  identity: Identity;
  /** Sanitized camera EXIF from the shutter. */
  exif?: Record<string, number | string> | null;
 /** CaptureKit ring/sensor-log evidence paths; native stills path only. */
  captureEvidence?: CaptureEvidencePaths | null;
 /** Full ExhibitCamera CaptureResult; stereo artifacts ride the job to the record's evidence dir. */
  exhibitCapture?: CaptureResult | null;
 /** Face check outcome — boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
}): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const draftUri = `${DIR}${id}.jpg`;
  await FileSystem.copyAsync({ from: params.photoUri, to: draftUri });
  // The camera-cache original is a second plaintext copy; delete it as soon as
  // our draft exists.
  await FileSystem.deleteAsync(params.photoUri, { idempotent: true }).catch(() => {});
  await armorDraft(draftUri, true); // photos are small — seal inline, no plaintext rest

  const list = await ensureLoaded();
  list.push({
    id,
    draftUri,
    context: params.context,
    identity: params.identity,
    capturedAt: new Date().toISOString(), // the moment that can't be recreated
    exif: params.exif ?? null,
    captureEvidence: params.captureEvidence ?? null,
    exhibitCapture: params.exhibitCapture ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    attempts: 0,
    state: 'pending',
  });
  await persist();
  notify();
  void pump();
}

/** Voice-note entry point: the .m4a draft + its on-device transcript get sealed in the background. */
export async function enqueueAudioSeal(params: {
  audioUri: string;
  context: SensorContext;
  identity: Identity;
  transcript: TranscriptAssertion | null;
 /** Face check outcome — boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
  /**
   * Audio IMU evidence path: the gyro JSONL the native recorder wrote during
   * the take, as a three-state EvidencePath (path / enabled-but-failed null /
   * 'never-recorded'). The other two CaptureKit sinks are structural
   * 'never-recorded' for audio. When the path is a string, the pump reads the
   * log and the seal carries a signed com.verify.poseTrace, as video does.
   */
  captureEvidence?: CaptureEvidencePaths | null;
}): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const draftUri = `${DIR}${id}.m4a`;
  await FileSystem.copyAsync({ from: params.audioUri, to: draftUri });
  await FileSystem.deleteAsync(params.audioUri, { idempotent: true }).catch(() => {}); // no plaintext twin
  await armorDraft(draftUri, true);

  const list = await ensureLoaded();
  list.push({
    id,
    kind: 'audio',
    draftUri,
    context: params.context,
    identity: params.identity,
    capturedAt: new Date().toISOString(),
    transcript: params.transcript,
    biometricGatePassed: params.biometricGatePassed ?? null,
    captureEvidence: params.captureEvidence ?? null,
    attempts: 0,
    state: 'pending',
  });
  await persist();
  notify();
  void pump();
}

/**
 * Video entry point. The draft copy is bigger (a 2-minute cap bounds it), so
 * the raw .mp4/.mov is deleted as soon as the copy lands and the rest runs in
 * the background pump. The extension is preserved; attestVideo reads the
 * container mime from it.
 */
export async function enqueueVideoSeal(params: {
  videoUri: string;
  context: SensorContext;
  identity: Identity;
 /** CaptureKit PCM/sensor-log evidence paths; native session path only. */
  captureEvidence?: CaptureEvidencePaths | null;
 /** ExhibitCamera video session facts: audio track presence, stereo pair counts, evidence dir. */
  exhibitVideo?: SealJob['exhibitVideo'];
 /** Face check outcome — boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
}): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = /\.mov($|\?)/i.test(params.videoUri) ? '.mov' : '.mp4';
  const draftUri = `${DIR}${id}${ext}`;
  await FileSystem.copyAsync({ from: params.videoUri, to: draftUri });
  await FileSystem.deleteAsync(params.videoUri, { idempotent: true }).catch(() => {}); // no plaintext twin
  {
    // Big videos encrypt too slowly for the shutter path, so armor them in
    // the background; the pump's plaintext fallback covers the window.
    const info = await FileSystem.getInfoAsync(draftUri);
    await armorDraft(draftUri, !info.exists || (info.size ?? 0) <= ARMOR_SYNC_MAX);
  }

  const list = await ensureLoaded();
  list.push({
    id,
    kind: 'video',
    draftUri,
    context: params.context,
    identity: params.identity,
    capturedAt: new Date().toISOString(), // the moment that can't be recreated
    captureEvidence: params.captureEvidence ?? null,
    exhibitVideo: params.exhibitVideo ?? null,
    biometricGatePassed: params.biometricGatePassed ?? null,
    attempts: 0,
    state: 'pending',
  });
  await persist();
  notify();
  void pump();
}

/** Called on app start / vault unlock: finish anything left over. */
export async function resumeSealQueue(): Promise<void> {
  await ensureLoaded();
  void pump();
  // Burn scheduler, foreground hook. Burns are recorded events in the vault
  // disclosure store. The outer catch only guards the void'd promise;
  // per-item containment lives inside the scheduler, so one failing item
  // cannot abort later items' burns.
  void runBurnScheduler(vaultDisclosureStore()).catch(() => {});
}

// ---------------------------------------------------------------------------
// The vault disclosure store, sealed at rest: per-item disclosure state
// (master seed until burn, Sealed bundle, claims) and the chunk maps behind
// the v2 streamedChunks assertion.
// ---------------------------------------------------------------------------

const DISC_DIR = `${FileSystem.documentDirectory}disclosure/`;

function disclosureUri(itemId: string): string {
  return `${DISC_DIR}${itemId}.json`;
}

/** The vault-sealed DisclosureStore used by the burn scheduler and the open/export paths. */
export function vaultDisclosureStore(): DisclosureStore {
  return {
    async listIds(): Promise<string[]> {
      try {
        const files = await FileSystem.readDirectoryAsync(DISC_DIR);
        return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
      } catch {
        return [];
      }
    },
    async load(itemId: string): Promise<DisclosureItemState | null> {
      try {
        const bytes = await readFileBytes(disclosureUri(itemId));
        return await unsealVaultJson<DisclosureItemState>(bytes);
      } catch {
        return null;
      }
    },
    async save(state: DisclosureItemState): Promise<void> {
      await FileSystem.makeDirectoryAsync(DISC_DIR, { intermediates: true }).catch(() => {});
      await writeFileBytes(disclosureUri(state.itemId), await sealVaultJson(state));
    },
  };
}

/**
 * Persist a freshly sealed item's disclosure state and chunk maps. The master
 * seed lands here and nowhere else, sealed with the vault key; it is never
 * written to a queue file, manifest, or export. Best-effort: a store failure
 * leaves the item with no disclosable context rather than failing the seal.
 */
async function saveDisclosureState(
  itemId: string,
  disclosure: SealedCaptureDisclosure | null | undefined,
  chunkMaps: Partial<Record<StreamedChunksTrackId, TrackChunkMap>> | null | undefined
): Promise<void> {
  try {
    const store = vaultDisclosureStore();
    if (disclosure) {
      const capture: CommittedCaptureForStore = {
        root: disclosure.root,
        claims: disclosure.claims,
        inventoryAssertion: disclosure.inventoryAssertion,
        sealedBundle: disclosure.sealedBundle,
        masterSeedHex: disclosure.masterSeedHex,
      };
      await store.save(createItemState(itemId, capture));
    }
    if (chunkMaps && Object.keys(chunkMaps).length > 0) {
      await FileSystem.makeDirectoryAsync(DISC_DIR, { intermediates: true }).catch(() => {});
      await writeFileBytes(`${DISC_DIR}${itemId}.chunks.json`, await sealVaultJson(chunkMaps));
    }
  } catch {
    // Best-effort, see above: a store failure never fails the seal.
  }
}

/**
 * ExhibitCamera stereo artifacts. After a still seals, the committed artifact
 * bytes (desk-shape JSON for calibration/timestamps/metadata — the exact bytes
 * the bundle hash binds — and raw sensor bytes for the frames) move into the
 * sealed record's evidence dir, vault-sealed at rest. A sealed
 * capture-summary.json states each artifact's three-state disposition, so
 * downstream ingestion can tell which case an absence is. Best-effort per
 * artifact: a storage failure is stated in the summary, not a seal failure.
 */
const EVIDENCE_DIR = `${FileSystem.documentDirectory}evidence/`;

/** A full-sensor artifact to vault-store alongside the stereo files; additive,
    not part of the frozen five-artifact stereo contract. */
export interface ExtraEvidenceFile {
  /** Summary key + plaintext-twin bookkeeping name ('fullResStill' | 'fullResSecondary'). */
  name: string;
  fileName: string;
  bytes: Uint8Array;
  /** The hash committed for these bytes (recomputed at seal time). */
  sha256: string;
  /** The native-reported hash from the capture result, when present; a
      mismatch is stated in the claim, not silently resolved. */
  nativeSha256: string | null;
}

async function storeExhibitArtifacts(
  itemId: string,
  result: CaptureResult,
  section: StereoBundleSection,
  files: CommittedStereoFile[],
  extras?: ExtraEvidenceFile[],
): Promise<void> {
  try {
    const dir = `${EVIDENCE_DIR}${itemId}/`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    const stored: Record<string, string> = {};
    for (const f of files) {
      try {
        const file = `${f.fileName}.sealed`;
        await writeFileBytes(`${dir}${file}`, await sealVaultBytes(f.bytes));
        stored[f.id] = file;
      } catch {
        // Stated below via the section entries, not a seal failure.
      }
    }
    // Vault-sealed like every other exhibit byte,
    // their committed hashes in the summary AND in the signed context
    // tree (context.fullres-* claims, built by buildFullResSealExtras).
    const extraSummary: Record<string, { sha256: string; bytes: number; stored: string | null; nativeSha256: string | null }> = {};
    for (const ex of extras ?? []) {
      let sealedName: string | null = null;
      try {
        sealedName = `${ex.fileName}.sealed`;
        await writeFileBytes(`${dir}${sealedName}`, await sealVaultBytes(ex.bytes));
        stored[ex.name] = sealedName;
      } catch {
        sealedName = null; // stated in the summary, not a seal failure
      }
      extraSummary[ex.name] = { sha256: ex.sha256, bytes: ex.bytes.length, stored: sealedName, nativeSha256: ex.nativeSha256 };
    }
    const summary = {
      captureId: result.captureId,
      stereo: result.stereo,
      capturedAtMs: result.capturedAtMs,
      synchronizedDeltaMs: result.synchronizedDeltaMs,
      droppedPairCount: result.droppedPairCount,
      hardwareCost: result.hardwareCost,
      physicalDevices: result.physicalDevices,
      primaryFrameSha256: section.primaryFrameSha256,
      // The committed three-state dispositions, verbatim from the bundle
      // section, plus where each artifact's vault-sealed bytes landed.
      artifacts: section.artifacts,
 // additive fields — absent on older captures.
      ...(Object.keys(extraSummary).length > 0 ? { fullRes: extraSummary } : {}),
      ...(result.captureSettings ? { captureSettings: result.captureSettings } : {}),
      stored,
    };
    await writeFileBytes(`${dir}capture-summary.json`, await sealVaultJson(summary));
    // Delete the plaintext twins in the capture evidence dir: the committed
    // bytes are vault-sealed above and ride the bundle inline. Raw DNG is
    // hash-only in the bundle and vault-held here.
    for (const ep of [result.secondaryFrame, result.calibration, result.timestamps, result.metadata, result.rawDng, result.fullResStill, result.fullResSecondary]) {
      if (!ep || ep.state !== 'path') continue;
      const uri = ep.path.startsWith('file://') ? ep.path : `file://${ep.path}`;
      await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
  } catch {
    // Disclosed above: artifact storage must never sink a completed seal.
  }
}

/**
 * Seal inputs from the capture result's additive fields: vault-storage entries
 * for the full-sensor stills, plus the context-tree claims committing their
 * hashes and the capture-settings block into the signed tree. The committed
 * hash is recomputed from the bytes read at seal time; a mismatch against the
 * native-reported hash is stated in the claim value, not resolved and not a
 * seal failure. 'error' and 'never-recorded' artifacts commit their states as
 * claim values too.
 */
async function buildFullResSealExtras(
  result: CaptureResult,
): Promise<{ extras: ExtraEvidenceFile[]; claims: ContextClaim[] }> {
  const extras: ExtraEvidenceFile[] = [];
  const claims: ContextClaim[] = [];
  if (result.captureSettings) {
    claims.push({
      claimId: 'context.capture-settings',
      family: 'context',
      rung: 0,
      value: JSON.stringify(result.captureSettings),
    });
  }
  const specs: Array<{
    key: 'fullResStill' | 'fullResSecondary';
    claimId: string;
    fileName: string;
    ep: ExhibitEvidencePath | undefined;
    nativeSha: string | null | undefined;
  }> = [
    { key: 'fullResStill', claimId: 'context.fullres-still', fileName: 'fullres-still.jpg', ep: result.fullResStill, nativeSha: result.fullResStillSha256 },
    { key: 'fullResSecondary', claimId: 'context.fullres-secondary', fileName: 'fullres-secondary.jpg', ep: result.fullResSecondary, nativeSha: result.fullResSecondarySha256 },
  ];
  for (const spec of specs) {
    const ep = spec.ep;
    if (!ep) continue; // older native build: absence stated by omission
    if (ep.state === 'never-recorded') {
      claims.push({ claimId: spec.claimId, family: 'context', rung: 0, value: `never-recorded:${ep.reason}` });
      continue;
    }
    if (ep.state === 'error') {
      claims.push({ claimId: spec.claimId, family: 'context', rung: 0, value: `error:${ep.code}: ${ep.message}`.slice(0, 500) });
      continue;
    }
    try {
      const uri = ep.path.startsWith('file://') ? ep.path : `file://${ep.path}`;
      const bytes = await readFileBytes(uri);
      const digest = bytesToHex(sha256(bytes));
      if (spec.nativeSha && spec.nativeSha !== digest) {
        // The bytes on disk at seal time do not match the hash the native
        // module committed; state it verbatim rather than picking one.
        claims.push({
          claimId: spec.claimId,
          family: 'context',
          rung: 0,
          value: `error:seal-time hash mismatch (native committed ${spec.nativeSha}, bytes on disk ${digest})`,
        });
        continue;
      }
      claims.push({ claimId: spec.claimId, family: 'context', rung: 0, value: `sha256:${digest}` });
      extras.push({ name: spec.key, fileName: spec.fileName, bytes, sha256: digest, nativeSha256: spec.nativeSha ?? null });
    } catch (e) {
      claims.push({
        claimId: spec.claimId,
        family: 'context',
        rung: 0,
        value: `error:seal-time artifact read failed: ${e instanceof Error ? e.message : 'read failed'}`.slice(0, 500),
      });
    }
  }
  return { extras, claims };
}

/**
 * Video pair artifact storage. After a video seals, the committed pair bytes
 * (converted calibration JSON — the exact bytes the bundle hash binds — and
 * the raw secondary JPEGs) move into the record's evidence dir under pairs/,
 * vault-sealed. A sealed pairs-summary.json carries the counts plus every
 * pair's three-state entries. The plaintext twins are deleted afterwards.
 * Best-effort: a storage failure never fails the seal.
 */
async function storeVideoStereoArtifacts(
  itemId: string,
  ev: NonNullable<SealJob['exhibitVideo']>,
  section: VideoStereoBundleSection,
  files: CommittedStereoFile[],
): Promise<void> {
  try {
    const dir = `${EVIDENCE_DIR}${itemId}/`;
    await FileSystem.makeDirectoryAsync(`${dir}pairs/`, { intermediates: true });
    const stored: string[] = [];
    for (const f of files) {
      try {
        const file = `${f.fileName}.sealed`;
        await writeFileBytes(`${dir}${file}`, await sealVaultBytes(f.bytes));
        stored.push(file);
      } catch {
        // Stated via the section entries; not a seal failure.
      }
    }
    const summary = {
      primaryVideoSha256: section.primaryVideoSha256,
      pairsCommitted: section.pairsCommitted,
      pairsMissed: section.pairsMissed,
      hardwareCost: section.hardwareCost,
      sessionStereo: ev.stereo ?? 'unreached',
      pairEventCount: (ev.pairEvents ?? []).length,
      pairs: section.pairs,
      stored,
    };
    await writeFileBytes(`${dir}pairs-summary.json`, await sealVaultJson(summary));
    for (const ev2 of ev.pairEvents ?? []) {
      for (const p of [ev2.secondaryPath, ev2.calibrationPath]) {
        if (!p) continue;
        const uri = p.startsWith('file://') ? p : `file://${p}`;
        await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
    }
  } catch {
    // Disclosed above: artifact storage must never sink a completed seal.
  }
}

/**
 * Read the CaptureKit sensor JSONL for the poseTrace commitment (Phase 2 §3).
 * A missing or unreadable log means no poseTrace assertion, not a seal failure.
 */
async function readSensorLogText(job: SealJob): Promise<string | null> {
  const p = job.captureEvidence?.sensorLogPath;
  if (typeof p !== 'string') return null;
  try {
    const uri = p.startsWith('file://') ? p : `file://${p}`;
    return new TextDecoder().decode(await readFileBytes(uri));
  } catch {
    return null;
  }
}

/** The toggle snapshot for the captureIntegrity assertion; only when CaptureKit ran. */
function evidenceEnabledFor(job: SealJob): EvidenceEnabledSnapshot | null {
  if (!job.captureEvidence) return null;
  const t = useStore.getState().settings;
  // The full-rate sensor log follows the Motion log toggle (includeSensors);
  // captureEvidence has no sensors flag of its own.
  return { ring: t.captureEvidence.ring, rawPcm: t.captureEvidence.rawPcm, sensors: t.includeSensors };
}

/**
 * Ledger anchoring: after the item seals, submit the record's payload digest
 * to the OTS calendars, hash-only. Offline digests queue with their delay
 * recorded, and a failed anchor never fails the seal. Drains the backlog when
 * the network is up.
 */
async function maybeAnchorOts(recordId: string, record: import('./manifest').AttestationRecord): Promise<void> {
  const { otsEnabled, otsCalendars } = useStore.getState().settings;
  if (!otsEnabled) return;
  await anchorRecordWithOts(recordId, record, otsCalendars ?? undefined);
  void drainOtsQueue(otsCalendars ?? undefined).catch(() => {});
}

/**
 * Merges the CaptureKit evidence-file paths into the record's context block at
 * seal time, so they are signed with everything else. Fallback-path captures
 * carry no such block.
 */
function contextWithCaptureKit(job: SealJob): SensorContext {
  if (!job.captureEvidence) return job.context;
  const context: SensorContext = { ...job.context };
  context.captureEvidence = job.captureEvidence;
  return context;
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    const list = await ensureLoaded();
    for (const job of list) {
      if (job.state !== 'pending') continue;
      // A queued job can be cancelled from the grid while this loop runs, so
      // re-check membership before claiming it.
      if (jobs?.includes(job) !== true) continue;
      job.state = 'sealing';
      job.attempts += 1;
      await persist();
      notify();
      // Checkpoint 0: honor a cancel that landed between the membership
      // re-check and the claim, before any seal work starts.
      if (await abandonIfCancelled(job, null)) continue;
      try {
        const key = await getDeviceKey();
        // PQ dual-signature layer. A failure here never fails the capture.
        const pq = await getOrCreatePqKey().catch(() => null);
        // Device integrity signals, collected at seal time and signed into
        // the record as a self-reported assertion.
        const integritySignals = await collectIntegritySignals().catch(() => null);
        // Drafts are vault-sealed at rest (DRAFT_MAGIC prefix). Unseal into
        // the plain cache, itself wiped on lock/background, for the
        // attestation readers. Unarmored drafts are used as-is.
        let workUri = job.draftUri;
        let workCleanup: string | null = null;
        {
          // A draft still missing after rebasing cannot seal; fail with a
          // sentence the user can act on.
          const draftInfo = await FileSystem.getInfoAsync(job.draftUri);
          if (!draftInfo.exists) {
            throw new Error(
              'the capture file is no longer on this device — the app was reinstalled after this capture and the draft did not migrate; this exhibit cannot be sealed, remove it'
            );
          }
          const draftBytes = await readFileBytes(job.draftUri);
          const armored =
            draftBytes.length > DRAFT_MAGIC.length &&
            DRAFT_MAGIC.every((b, i) => draftBytes[i] === b);
          if (armored) {
            const unsealed = await unsealVaultBytes(draftBytes.subarray(DRAFT_MAGIC.length));
            if (unsealed) {
              await ensureVaultDirs();
              const dot = job.draftUri.lastIndexOf('.');
              workUri = plainWorkUri(`sealwork-${job.id}${dot >= 0 ? job.draftUri.slice(dot) : ''}`);
              await writeFileBytes(workUri, unsealed);
              workCleanup = workUri;
            }
          }
        }
        // Read the cached Bitcoin tip once per job at seal time; refreshes
        // run on their own jittered schedule (src/lib/beacon.ts). Absent when
        // uncached.
        const beacon = currentBeacon();
        // Read the sensor JSONL for the poseTrace commitment and snapshot the
        // evidence toggles for the captureIntegrity assertion. The audio
        // recorder's gyro sink is not a CaptureKit session, so evidenceEnabled
        // stays null and the three-state sensorLogPath states the case.
        const sensorLogText = await readSensorLogText(job);
        const evidenceEnabled = job.kind === 'audio' ? null : evidenceEnabledFor(job);
        let savedId: string | null = null;
        if ((job.kind ?? 'photo') === 'audio') {
          const { signedAudioBytes, record, disclosure, chunkMaps } = await attestAudio({
            audioUri: workUri,
            // Merge the audio recorder's gyro evidence path into the signed
            // context, as video and photo do.
            context: contextWithCaptureKit(job),
            identity: job.identity,
            key,
            transcript: job.transcript ?? null,
            capturedAt: job.capturedAt,
            integritySignals,
            beacon,
            pq,
            biometricGatePassed: job.biometricGatePassed ?? null,
            sensorLogText,
            evidenceEnabled,
          });
          if (!signedAudioBytes) throw new Error('signing produced no output');
          // Checkpoint: last cancel point before the vault write.
          if (await abandonIfCancelled(job, workCleanup)) continue;
          savedId = (await saveItem({
            kind: 'audio',
            audioBytes: signedAudioBytes,
            record,
            transcriptPresent: !!job.transcript,
            // The audio grid thumbnail: the first line of the transcript,
            // sealed beside the media. Absent when transcription was off.
            transcriptSnippet: job.transcript?.text ? job.transcript.text.trim().slice(0, 140) : undefined,
          })).id;
          await saveDisclosureState(savedId, disclosure, chunkMaps);
          await maybeAnchorOts(savedId, record);
        } else if (job.kind === 'video') {
          // ExhibitCamera video stereo ingestion: the periodic pairs dumped
          // during recording are enumerated from the collected pair events
          // (the module writes no per-pair timestamps file), converted by
          // stereoGlue, and committed. The counts ride the signed context tree
          // as context.stereo-video-* claims; the section persists on the
          // vault record after signing, excluded from the signed payload. The
          // primary hash binds the stripped delivery bytes, the same bytes
          // attestVideo hashes into record.asset.sha256.
          let videoStereoCommit: { section: VideoStereoBundleSection; contextClaims: import('../disclosure/inventory').ContextClaim[] } | null = null;
          let videoStereoFiles: CommittedStereoFile[] = [];
          // Embedded viewing surface: up to 8 pair frames, evenly spaced with
          // first and last always included, sealed into the manifest as
          // componentOf ingredients. The vault keeps every pair.
          let videoStillsParam: { bytes: Uint8Array; pairIndex: number; hostSeconds: number | null }[] | null = null;
          if (job.exhibitVideo) {
            const primaryVideoSha256 = (await hashFileSha256(workUri)).hex;
            const glue = await buildStereoVideoPairInputs(job.exhibitVideo.pairEvents ?? [], readFileBytes);
            const withFrames = glue.pairs.filter((pr) => {
              const f = pr.artifacts.secondaryFrame;
              return !!f && 'bytes' in f && !!f.bytes && f.bytes.length > 0;
            });
            if (withFrames.length > 0) {
              const k = Math.min(8, withFrames.length);
              videoStillsParam = Array.from({ length: k }, (_, i) => {
                const pr = withFrames[Math.round((i * (withFrames.length - 1)) / Math.max(1, k - 1))];
                const f = pr.artifacts.secondaryFrame as { bytes: Uint8Array };
                return { bytes: f.bytes, pairIndex: pr.pairIndex, hostSeconds: pr.anchors.primaryHostSeconds ?? null };
              });
            }
            // Fail-closed on a three-state contract violation, same rule as
            // the photo path. Counts come from the native stop result.
            videoStereoCommit = commitStereoVideoArtifacts(
              glue.pairs,
              {
                pairsCommitted: job.exhibitVideo.pairsCommitted,
                pairsMissed: job.exhibitVideo.pairsMissed,
                hardwareCost: job.exhibitVideo.hardwareCost,
              },
              primaryVideoSha256,
            );
            videoStereoFiles = glue.files;
          }
          const { signedVideoBytes, record, disclosure, chunkMaps } = await attestVideo({
            videoUri: workUri,
            context: contextWithCaptureKit(job),
            identity: job.identity,
            key,
            capturedAt: job.capturedAt,
            integritySignals,
            beacon,
            pq,
            biometricGatePassed: job.biometricGatePassed ?? null,
            sensorLogText,
            evidenceEnabled,
            stereoClaims: videoStereoCommit?.contextClaims ?? null,
            videoStills: videoStillsParam,
          });
          // signedVideoBytes is undefined only for out-of-scope containers,
          // where saveItem seals the raw draft plus a sidecar record.
          // Checkpoint: last cancel point before the vault write.
          if (await abandonIfCancelled(job, workCleanup)) continue;
          savedId = (await saveItem({ kind: 'video', videoUri: workUri, videoBytes: signedVideoBytes, record })).id;
          await saveDisclosureState(savedId, disclosure, chunkMaps);
          if (videoStereoCommit && job.exhibitVideo) {
            // Committed pair bytes move under the sealed record's evidence
            // dir, vault-sealed with a three-state summary alongside.
            await storeVideoStereoArtifacts(savedId, job.exhibitVideo, videoStereoCommit.section, videoStereoFiles);
            // The section persists on the vault record so the share path can
            // pass it to buildProofBundle.
            const section = videoStereoCommit.section;
            await updateRecord(savedId, (rec) => ({ ...rec, videoStereo: section }));
          }
          await maybeAnchorOts(savedId, record);
        } else {
          // ExhibitCamera stereo ingestion (Spec-Camera-Module-0.13 §5): map
          // the CaptureResult's three-state EvidencePaths onto the commit
          // contract and commit them. The context.stereo-* claim values enter
          // the signed context tree via attestPhoto; the section persists on
          // the vault record after signing, excluded from the signed payload
          // like `ots`. The primary hash binds the stripped delivery bytes,
          // the same bytes attestPhoto hashes into record.asset.sha256.
          let stereoCommit: { section: StereoBundleSection; contextClaims: import('../disclosure/inventory').ContextClaim[] } | null = null;
          let stereoFiles: CommittedStereoFile[] = [];
          // Additive commitments: full-sensor stills (hash claims plus vault
          // storage) and the device-read capture-settings block, folded into
          // the same signed context tree as the stereo claims.
          let fullResExtras: ExtraEvidenceFile[] = [];
          let extraClaims: ContextClaim[] = [];
          // The resolved depth artifact for this capture.
          let depthInput: DepthCommitInput | null = null;
          // The resolved secondary viewpoint for this capture.
          let secondaryInput: SecondaryCommitInput | null = null;
          if (job.exhibitCapture) {
            const primarySha256 = (await hashFileSha256(workUri)).hex;
            const glue = await buildStereoInputs(job.exhibitCapture, readFileBytes);
            // Throws on a three-state contract violation: fail-closed, the
            // job retries. See the stereoArtifacts.ts header.
            stereoCommit = commitStereoArtifacts(glue.artifacts, primarySha256);
            stereoFiles = glue.files;
            const fullRes = await buildFullResSealExtras(job.exhibitCapture);
            fullResExtras = fullRes.extras;
            extraClaims = fullRes.claims;
            // The depth artifact rides the same job: resolved (full-res
            // primary, degraded fallback), committed pre-signing by
            // attestPhoto, sealed into the vault below.
            depthInput = resolveDepthSealInput(job.exhibitCapture);
            // The secondary viewpoint rides the same job, committed
            // pre-signing by attestPhoto as a componentOf ingredient
            // (embedded thumbnail plus full-res data hash). Its full-res bytes
            // are vault-sealed by buildFullResSealExtras above.
            secondaryInput = resolveSecondarySealInput(job.exhibitCapture);
          }
          const allClaims = [...(stereoCommit?.contextClaims ?? []), ...extraClaims];
          const { signedPhotoBytes, record, disclosure } = await attestPhoto({
            photoUri: workUri,
            context: contextWithCaptureKit(job),
            identity: job.identity,
            key,
            capturedAt: job.capturedAt,
            integritySignals,
            exif: job.exif ?? null,
            beacon,
            pq,
            biometricGatePassed: job.biometricGatePassed ?? null,
            sensorLogText,
            evidenceEnabled,
            stereoClaims: allClaims.length > 0 ? allClaims : null,
            depth: depthInput,
            secondary: secondaryInput,
          });
          if (!signedPhotoBytes) throw new Error('signing produced no output');
          // Checkpoint: last cancel point before the vault write.
          if (await abandonIfCancelled(job, workCleanup)) continue;
          savedId = (await saveItem({
            kind: 'photo',
            photoBytes: signedPhotoBytes,
            record,
            // The verified depth artifact is sealed beside the photo: path
            // plus committed sha, which vaultFs re-reads and re-verifies.
            depthArtifact:
              depthInput && depthInput.artifact.state === 'path' && depthInput.sha256
                ? { path: depthInput.artifact.path, mime: depthInput.metadata?.mime ?? 'image/png', sha256: depthInput.sha256 }
                : null,
          })).id;
          await saveDisclosureState(savedId, disclosure, null);
          if (stereoCommit && job.exhibitCapture) {
            // Committed artifact bytes move under the sealed record's
            // evidence dir, vault-sealed with a three-state summary alongside.
            await storeExhibitArtifacts(savedId, job.exhibitCapture, stereoCommit.section, stereoFiles, fullResExtras);
            // The section persists on the vault record so the share path can
            // pass it as buildProofBundle's 4th arg.
            const section = stereoCommit.section;
            await updateRecord(savedId, (rec) => ({ ...rec, stereo: section }));
          }
          await maybeAnchorOts(savedId, record);
          if (useStore.getState().settings.saveToCameraRoll) {
            const tmp = `${FileSystem.cacheDirectory}exhibit-export-${job.id}.jpg`;
            await writeFileBytes(tmp, signedPhotoBytes);
            await MediaLibrary.saveToLibraryAsync(tmp).catch(() => {});
          }
        }
        await FileSystem.deleteAsync(job.draftUri, { idempotent: true }).catch(() => {});
        if (workCleanup) await FileSystem.deleteAsync(workCleanup, { idempotent: true }).catch(() => {});
        list.splice(list.indexOf(job), 1);
        await persist();
        useStore.getState().bumpVault();
        logDiagnostic({ t: Date.now(), kind: job.kind ?? 'photo', outcome: 'sealed' });
        if (savedId) completionListeners.forEach((l) => l({ kind: job.kind ?? 'photo', itemId: savedId }));
      } catch (e) {
        job.error = e instanceof Error ? e.message : 'seal failed';
        // A vault-locked failure is an auth window, not a seal failure: with
        // the app locked under Face ID vault unlock, the keychain's presence
        // prompt cannot appear in the background and the read fails fast. Undo
        // the attempt and keep the job pending for the post-unlock pass.
        if (isVaultLockedError(e)) {
          job.attempts = Math.max(0, job.attempts - 1);
          job.state = 'pending';
          logDiagnostic({
            t: Date.now(),
            kind: 'seal',
            outcome: 'seal-deferred',
            message: 'vault locked — seals after the next unlock',
          });
        } else {
          job.state = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        }
        if (job.state === 'failed') {
          // Attempt budget exhausted: the Exhibits needs-attention section
          // renders the failure, and the log keeps the verbatim error.
          logDiagnostic({ t: Date.now(), kind: 'seal', outcome: 'seal-failed', message: job.error });
        }
        await persist();
      }
      notify();
    }
    // Transient failures get another chance without user action.
    if (list.some((j) => j.state === 'pending')) {
      setTimeout(() => void pump(), 15000);
    }
  } finally {
    pumping = false;
  }
}
