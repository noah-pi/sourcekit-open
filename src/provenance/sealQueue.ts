// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Capture ≠ seal.
 *
 * The shutter's critical path is: expose → write the raw file → enqueue.
 * Everything slow (hashing, Secure Enclave signing, the TSA network
 * countersign, C2PA embedding, vault encryption) happens HERE, in a serial
 * background queue — so the camera is live again in well under a second and
 * burst shooting just stacks jobs.
 *
 * Correctness properties, held deliberately:
 *   - Serial order: jobs seal in capture order. Provenance is about order;
 *    "what came first" must never race.
 *   - Capture time is recorded at enqueue, not at seal — the moment that
 *     can't be recreated is preserved even if sealing happens minutes later.
 *   - The queue persists to disk. If the app dies mid-seal, the raw capture
 *     survives and sealing resumes on next launch. Nothing is ever
 *     half-written: vault insertion is the last step.
 *   - Offline is fine: the TSA countersign degrades to device-clock time
 *     (attestPhoto already handles a null token); the seal still completes.
 *   - A job that keeps failing (e.g. vault was erased underneath it) is
 *     marked failed and its draft kept — never silently dropped.
 *   - Drafts are vault-SEALED at enqueue: no plaintext capture
 *     rests in the queue, so locking the phone mid-seal neither leaks nor
 *     loses anything. Sealing resumes on unlock.
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
import { saveItem, updateRecord, sealVaultJson, unsealVaultJson, sealVaultBytes, unsealVaultBytes, plainWorkUri, ensureVaultDirs } from '../vault/vaultFs';
import { concatBytes, bytesToHex } from '../lib/bytes';
import { sha256 } from '@noble/hashes/sha256';
import type { ContextClaim } from '../disclosure/inventory';
import { getDeviceKey } from '../lib/deviceKey';
import { getOrCreatePqKey } from '../lib/pqKeyStore';
import { assignmentCert, getAssignmentKey } from '../lib/assignmentKeys';
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
  /** Photos are the original flow; audio joined in 0.6.0, video in 0.7.0. Absent = photo (legacy queue). */
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
   * CaptureKit evidence-file paths (1.0.0, WS1) — raw PCM master, sensor log,
   * stills ring dump; merged into the record's context block at seal time.
   * Audio jobs (WS2 Phase 2 §3 parity) carry only the sensor-log slot — the
   * audio recorder's gyro JSONL; PCM/ring stay structural 'never-recorded'.
   */
  captureEvidence?: CaptureEvidencePaths | null;
  /**
   * ExhibitCamera stereo stills result: the FULL CaptureResult from
   * the native module — captureId, delivery path, stereo session state, and
   * the three-state EvidencePaths for the secondary frame / calibration /
   * timestamps / metadata / RAW DNG. The pump stores the artifact files
   * under the sealed record's evidence dir (storeExhibitArtifacts); the
   * signed ingestion of those artifacts is a downstream pass.
   */
  exhibitCapture?: CaptureResult | null;
  /**
   * ExhibitCamera video session facts — stated, never inferred:
   * audioTrack false means the delivery file structurally has no audio;
   * the pair counts and the evidence dir locate the periodic stereo pairs
   * committed during recording.
   */
  exhibitVideo?: {
    audioTrack: boolean;
    pairsCommitted: number;
    pairsMissed: number;
    hardwareCost: number | null;
    evidenceDir: string;
    /** Session stereo availability as probed at configure time, verbatim. */
    stereo?: 'available' | 'unsupported' | 'unreached';
    /** The onStereoPairCaptured events collected during recording (0.13.0
        §8): the per-pair enumeration + PTS anchors — the module writes no
        per-pair timestamps file, so these events ARE the anchors. */
    pairEvents?: StereoVideoPairEvent[];
  } | null;
  /**
   * Assignment-mode label snapshotted at enqueue — the capture signs
   * with the assignment key even if the setting changes before sealing.
   */
  assignmentLabel?: string | null;
  /**
   * Face check outcome — the boolean result of the OS biometric
   * check run at capture start when the toggle is on; null when off. Signed
   * into the record's captureIntegrity telemetry. The flag ONLY: no face
   * geometry, template, or image ever touches this queue.
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
 * Container rebasing (0.16.2, field failure 8/13): a TestFlight reinstall
 * moves Documents into a NEW app-container UUID. Every path this queue
 * persisted still names the OLD container, so perfectly intact drafts read
 * as "file does not exist" (the zombie FileNotExistsException jobs). The
 * layout under Documents/ is stable across the move, so at load every
 * persisted path's container prefix is rewritten to THIS install's
 * container. A draft still missing after rebasing is genuinely gone — the
 * pump states that plainly instead of leaking a Swift stack trace.
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
    // The queue holds GPS coords, byline, and audio transcripts — it is sealed
    // with the vault key like everything else identifying. Plaintext fallback
    // covers a queue written by ≤0.6.
    const bytes = await readFileBytes(QUEUE_FILE);
    const sealed = await unsealVaultJson<SealJob[]>(bytes);
    if (sealed) {
      jobs = sealed;
    } else {
      jobs = JSON.parse(new TextDecoder().decode(bytes)) as SealJob[];
    }
    for (const j of jobs) {
      // Anything interrupted mid-seal goes back to pending — the draft is intact.
      if (j.state === 'sealing') j.state = 'pending';
      // Rebase container-stale paths (draft, evidence paths, exhibitCapture)
      // to THIS install's container — see rebaseContainerPath.
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
// Seal-job visibility: the queue has always KEPT failed jobs and
// their verbatim error strings — what it never did was SHOW them. A seal
// failure used to be invisible (vault insertion is the last step, so a
// failed seal simply never appears in Exhibits). This read API is how the
// Exhibits "needs attention" section renders the queue's state plainly:
// failed with its error, pending/sealing as a stated state.
// ---------------------------------------------------------------------------

/** UI-facing snapshot of one job — a copy, never the live job object. */
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
 * User-initiated retry of a FAILED job. Resets the attempt budget, clears
 * the error, and kicks the pump — the pump's own failure logic is
 * untouched: if the cause persists it fails again, honestly, after the
 * same MAX_ATTEMPTS. A no-op for jobs that aren't failed.
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
 * User-initiated discard of a FAILED job: the Needs-attention card's
 * Remove action. Deletes the draft file (vault-armored ciphertext), drops the
 * job, persists, notifies. A no-op for jobs that aren't failed — a live pump
 * never loses work to a stray tap.
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
 * User-initiated cancel of a QUEUED (pending) job (0.18.3, Noah: "I want to
 * be able to select and cancel queued exhibits in the same way I can delete
 * sealed ones when I hit select"). Deletes the armored draft, drops the job,
 * persists, notifies.
 *
 * 0.18.4 (Noah: "allow you to also remove/cancel queued/sealing ones"): a
 * cancel requested while the pump holds the job ('sealing') is COOPERATIVE —
 * the id is marked here and honored at the pump's checkpoints, all of which
 * sit BEFORE the vault insertion, so a cancel never lands mid-write. A seal
 * already past the last checkpoint completes and lands as a sealed exhibit,
 * which can then be deleted like any other. A no-op for 'failed' jobs (their
 * discard path is discardSealJob).
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
 * Pump checkpoint: honor a mid-seal cancel between major steps —
 * never mid-write. On abandon: the unsealed work file and the armored draft
 * are deleted, the job drops out of the queue, and the log states the
 * discard. Returns true when the job was abandoned (the pump continues with
 * the next job). The claim-time membership re-check above covers cancels
 * that land between loop iterations.
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
 * Draft armor: drafts are vault-SEALED before they rest — no plaintext
 * capture ever sits in the queue, so locking the phone loses nothing.
 * Small drafts seal inline on the enqueue path; a large video seals in a
 * background pass so the shutter stays fast. The pump unseals on read and
 * falls back to plaintext, so pre-armor queue files and not-yet-armored
 * drafts keep working. The magic prefix keeps the two formats trivially
 * distinct.
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
      // Armor is best-effort: the pump's plaintext fallback still seals the job.
    }
  };
  if (sync) await work();
  else void work();
}

/**
 * Nuclear option for the queue: called by destroyVault (drafts are ciphertext,
 * but ciphertext of a destroyed vault is litter — and a legacy plaintext draft
 * must not survive the wipe).
 */
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
 * Completion signal: fired only when a seal ACTUALLY completes —
 * the count listener alone can't distinguish "drained" from "failed", and a
 * 'Sealed' flash must never fire on a failure. UI-only; the engine ignores it.
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
  /** CaptureKit ring/sensor-log evidence paths (1.0.0, WS1) — native stills path only. */
  captureEvidence?: CaptureEvidencePaths | null;
  /** Full ExhibitCamera CaptureResult (0.13.0) — stereo artifacts ride the job to the record's evidence dir. */
  exhibitCapture?: CaptureResult | null;
  /** Face check outcome (0.11.1) — boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
}): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const draftUri = `${DIR}${id}.jpg`;
  await FileSystem.copyAsync({ from: params.photoUri, to: draftUri });
  // The camera-cache original is a second plaintext copy — hand it back to the
  // OS the moment our draft exists.
  await FileSystem.deleteAsync(params.photoUri, { idempotent: true }).catch(() => {});
  await armorDraft(draftUri, true); // photos are small — seal inline, no plaintext rest

  const list = await ensureLoaded();
  list.push({
    id,
    draftUri,
    context: params.context,
    identity: params.identity,
    capturedAt: new Date().toISOString(), // the moment that can't be recreated
    assignmentLabel: useStore.getState().settings.assignmentId.trim() || null,
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
  /** Face check outcome (0.11.1) — boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
  /**
   * Audio IMU evidence path (WS2 Phase 2 §3 media parity) — the gyro JSONL
   * the native recorder wrote during the take, as a three-state EvidencePath
   * (path / enabled-but-failed null / 'never-recorded'); the other two
   * CaptureKit sinks are structural 'never-recorded' for audio. When the
   * path is a string, the pump reads the log and the seal carries a signed
   * com.verify.poseTrace exactly like video.
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
    assignmentLabel: useStore.getState().settings.assignmentId.trim() || null,
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
 * Video entry point: same capture ≠ seal contract as photos. The draft copy is
 * bigger (a 2-minute cap keeps it bounded), so the raw .mp4/.mov goes back to
 * the OS the moment the copy lands; hashing/signing/embedding/vaulting run in
 * the background pump while the camera is already live for the next recording.
 * The extension is preserved — attestVideo reads the container mime from it.
 */
export async function enqueueVideoSeal(params: {
  videoUri: string;
  context: SensorContext;
  identity: Identity;
  /** CaptureKit PCM/sensor-log evidence paths (1.0.0, WS1) — native session path only. */
  captureEvidence?: CaptureEvidencePaths | null;
  /** ExhibitCamera video session facts (0.13.0) — audio track presence, stereo pair counts, evidence dir. */
  exhibitVideo?: SealJob['exhibitVideo'];
  /** Face check outcome (0.11.1) — boolean only; null when the toggle was off. */
  biometricGatePassed?: boolean | null;
}): Promise<void> {
  await FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = /\.mov($|\?)/i.test(params.videoUri) ? '.mov' : '.mp4';
  const draftUri = `${DIR}${id}${ext}`;
  await FileSystem.copyAsync({ from: params.videoUri, to: draftUri });
  await FileSystem.deleteAsync(params.videoUri, { idempotent: true }).catch(() => {}); // no plaintext twin
  {
    // Big videos encrypt too slowly for the shutter path — armor in the
    // background; the pump's plaintext fallback covers the window honestly.
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
    assignmentLabel: useStore.getState().settings.assignmentId.trim() || null,
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
  // Burn scheduler (WS2 Phase 2 §4): foreground hook. Burns are recorded
  // events in the vault disclosure store — never silent. The outer catch
  // only guards the void'd promise; per-item containment lives INSIDE the
  // scheduler: one failing item is recorded in its
  // own state and cannot abort later items' burns.
  void runBurnScheduler(vaultDisclosureStore()).catch(() => {});
}

// ---------------------------------------------------------------------------
// WS2 Phase 2 §4: the vault disclosure store (sealed at rest like everything
// else) — per-item disclosure state (master seed until burn, Sealed bundle,
// claims) and the chunk maps behind the v2 streamedChunks assertion.
// ---------------------------------------------------------------------------

const DISC_DIR = `${FileSystem.documentDirectory}disclosure/`;

function disclosureUri(itemId: string): string {
  return `${DISC_DIR}${itemId}.json`;
}

/** The vault-sealed DisclosureStore the burn scheduler + open/export paths use. */
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
 * Persist a freshly sealed item's disclosure state + chunk maps. The
 * master seed lands here and ONLY here (sealed with the vault key) — it
 * is never written to any queue file, manifest, or export. Best-effort:
 * a store failure must never sink a completed seal (the item simply
 * carries no disclosable context — disclosed, not hidden).
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
    // Disclosed above: never sink a seal on the disclosure store.
  }
}

/**
 * ExhibitCamera stereo artifacts: after a still seals, the
 * COMMITTED artifact bytes (the desk-shape JSON for calibration /
 * timestamps / metadata — the exact bytes the bundle hash binds; the raw
 * sensor bytes for the frames) move into the sealed record's own evidence
 * dir, vault-sealed at rest like every other exhibit byte. A sealed
 * capture-summary.json states each artifact's three-state disposition
 * (the bundle section's own entries), so downstream ingestion never has
 * to guess which case an absence is. Best-effort per artifact: a storage
 * failure is stated in the summary, never a seal failure.
 */
const EVIDENCE_DIR = `${FileSystem.documentDirectory}evidence/`;

/** A W2.1 full-sensor artifact to vault-store alongside the stereo files
    (additive — never part of the frozen five-artifact stereo contract). */
export interface ExtraEvidenceFile {
  /** Summary key + plaintext-twin bookkeeping name ('fullResStill' | 'fullResSecondary'). */
  name: string;
  fileName: string;
  bytes: Uint8Array;
  /** The hash committed for these bytes (recomputed at seal time). */
  sha256: string;
  /** The native-reported hash from the capture result, when present — a
      mismatch is stated in the claim, never silently preferred. */
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
        // Stated below via the section entries; never a seal failure.
      }
    }
    // W2.1 full-sensor stills: vault-sealed like every other exhibit byte,
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
        sealedName = null; // stated in the summary; never a seal failure
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
      // W2.1/W2.4 additive fields — absent on pre-W2 captures.
      ...(Object.keys(extraSummary).length > 0 ? { fullRes: extraSummary } : {}),
      ...(result.captureSettings ? { captureSettings: result.captureSettings } : {}),
      stored,
    };
    await writeFileBytes(`${dir}capture-summary.json`, await sealVaultJson(summary));
    // The plaintext twins in the capture evidence dir have no further job —
    // the committed bytes are vault-sealed above and ride the bundle inline
    // (raw DNG excepted: hash-only in the bundle, vault-held here).
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
 * W2.1/W2.4 seal inputs from the capture result's additive fields:
 * vault-storage entries for the full-sensor stills plus the context-tree
 * claims that commit their hashes and the full capture-settings block into
 * the SIGNED tree. The hash committed is recomputed from the bytes read at
 * seal time; a mismatch against the native-reported hash is stated in the
 * claim value (a genuine cross-check), never silently preferred, never a
 * seal failure. Three-state honesty: 'error' and 'never-recorded'
 * full-res artifacts commit their states as claim values too.
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
    if (!ep) continue; // pre-W2 native build: absence stated by omission
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
        // module committed — stated verbatim, never resolved by fiat.
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
 * VIDEO pair artifact storage (0.13.0 §8): after a video seals, the
 * COMMITTED pair bytes (converted calibration JSON — the exact bytes the
 * bundle hash binds; the raw secondary JPEGs) move into the record's
 * evidence dir under pairs/, vault-sealed. A sealed pairs-summary.json
 * states the counts verbatim plus every pair's three-state entries from
 * the bundle section. The plaintext twins in the capture evidence dir are
 * deleted afterwards. Best-effort: storage failures never sink a seal.
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
        // Stated via the section entries; never a seal failure.
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
 * Read the CaptureKit sensor JSONL for the poseTrace commitment (WS2
 * Phase 2 §3). Best-effort: a missing/unreadable log is an honest absence
 * (no poseTrace assertion), never a seal failure.
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

/** The toggle snapshot for the captureIntegrity assertion — only when CaptureKit ran. */
function evidenceEnabledFor(job: SealJob): EvidenceEnabledSnapshot | null {
  if (!job.captureEvidence) return null;
  const t = useStore.getState().settings;
  // CaptureEvidence.sensors retired — the full-rate sensor log now
  // follows the single Motion log toggle (includeSensors).
  return { ring: t.captureEvidence.ring, rawPcm: t.captureEvidence.rawPcm, sensors: t.includeSensors };
}

/**
 * Ledger anchoring: after the item is sealed, submit the record's
 * payload digest to the free OTS calendars — hash-only, no account. Best-
 * effort: offline digests queue with their delay honestly recorded, and a
 * failed anchor never fails the seal. When the network is clearly up we
 * also drain the backlog.
 */
async function maybeAnchorOts(recordId: string, record: import('./manifest').AttestationRecord): Promise<void> {
  const { otsEnabled, otsCalendars } = useStore.getState().settings;
  if (!otsEnabled) return;
  await anchorRecordWithOts(recordId, record, otsCalendars ?? undefined);
  void drainOtsQueue(otsCalendars ?? undefined).catch(() => {});
}

/**
 * CaptureKit provenance (1.0.0, WS1): the evidence-file paths are merged
 * into the record's context block — the existing capture-metadata block —
 * at seal time, so they are signed with everything else. Fallback-path
 * captures carry no such block (absent, disclosed — never fabricated).
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
      // A queued job can be cancelled from the grid while this loop runs;
      // re-check membership before claiming it.
      if (jobs?.includes(job) !== true) continue;
      job.state = 'sealing';
      job.attempts += 1;
      await persist();
      notify();
      // Checkpoint 0: a cancel that landed between the membership
      // re-check and the claim is honored before any seal work starts.
      if (await abandonIfCancelled(job, null)) continue;
      try {
        // Assignment mode: sign with the assignment-scoped software
        // key instead of the device key — assignments are unlinkable to each
        // other and to the device. The cert chain is the assignment key's own
        // self-signed cert (never the device's chain or org credential).
        const assignmentLabel = job.assignmentLabel?.trim() ? job.assignmentLabel.trim() : null;
        const key = assignmentLabel ? await getAssignmentKey(assignmentLabel) : await getDeviceKey();
        const certChainOverride = assignmentLabel ? [await assignmentCert(key)] : undefined;
        // PQ dual-signature layer: every device-identity capture
        // dual-signs. ASSIGNMENT MODE DELIBERATELY OMITS IT — a long-lived
        // per-device key would re-link captures that exist to be unlinkable,
        // exactly like the device P-256 key would. Software key, signs
        // alongside, never instead; a failure here must never sink a capture.
        const pq = assignmentLabel ? null : await getOrCreatePqKey().catch(() => null);
        // Device integrity signals — collected at seal time (seconds after
        // capture), signed into the record as a self-reported assertion.
        const integritySignals = await collectIntegritySignals().catch(() => null);
        // Drafts are vault-sealed at rest (DRAFT_MAGIC prefix). Unseal
        // into the plain cache — itself wiped on lock/background — for the
        // attestation readers; anything that isn't armored is legacy plaintext
        // and is used as-is.
        let workUri = job.draftUri;
        let workCleanup: string | null = null;
        {
          // A draft genuinely gone (post-rebase — the app was reinstalled
          // and the file never migrated) can never seal: fail with a plain
          // sentence the user can act on, never a Swift stack trace.
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
        // Read the cached Bitcoin tip ONCE per job at seal time. Never fetched
        // here — refreshes run on their own jittered schedule, decoupled from
        // captures (src/lib/beacon.ts). Absent (not fabricated) when uncached.
        const beacon = currentBeacon();
        // WS2 Phase 2: read the sensor JSONL for the poseTrace commitment and
        // snapshot the evidence toggles for the captureIntegrity assertion.
        // Audio: the recorder's gyro sink is not a CaptureKit session and has
        // no CaptureKit toggle snapshot — evidenceEnabled stays null; the
        // three-state sensorLogPath in captureEvidence says which case it is.
        const sensorLogText = await readSensorLogText(job);
        const evidenceEnabled = job.kind === 'audio' ? null : evidenceEnabledFor(job);
        let savedId: string | null = null;
        if ((job.kind ?? 'photo') === 'audio') {
          const { signedAudioBytes, record, disclosure, chunkMaps } = await attestAudio({
            audioUri: workUri,
            // Media parity (WS2 Phase 2 §3): merge the audio recorder's gyro
            // evidence path into the signed context exactly like video/photo.
            context: contextWithCaptureKit(job),
            identity: job.identity,
            key,
            transcript: job.transcript ?? null,
            capturedAt: job.capturedAt,
            assignmentLabel,
            certChainOverride,
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
            // The audio grid "thumbnail": the first breath of the transcript,
            // sealed beside the media. Absent when transcription was off.
            transcriptSnippet: job.transcript?.text ? job.transcript.text.trim().slice(0, 140) : undefined,
          })).id;
          await saveDisclosureState(savedId, disclosure, chunkMaps);
          await maybeAnchorOts(savedId, record);
        } else if (job.kind === 'video') {
          // ExhibitCamera VIDEO stereo ingestion (0.13.0, Spec §8): the
          // periodic pairs dumped during recording are enumerated from the
          // collected pair events (the module writes no per-pair timestamps
          // file — the events carry the anchors), converted by stereoGlue
          // (calibration → committed desk shape, same as the photo path),
          // and committed: the counts ride the SIGNED context tree as
          // context.stereo-video-* claims, the section persists on the
          // vault record after signing (excluded from the signed payload).
          // The primary hash binds the STRIPPED delivery bytes — the same
          // bytes attestVideo hashes into record.asset.sha256.
          let videoStereoCommit: { section: VideoStereoBundleSection; contextClaims: import('../disclosure/inventory').ContextClaim[] } | null = null;
          let videoStereoFiles: CommittedStereoFile[] = [];
          if (job.exhibitVideo) {
            const primaryVideoSha256 = (await hashFileSha256(workUri)).hex;
            const glue = await buildStereoVideoPairInputs(job.exhibitVideo.pairEvents ?? [], readFileBytes);
            // Fail-closed on a three-state contract violation, same rule
            // as the photo path; counts are the native stop result,
            // committed verbatim.
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
            assignmentLabel,
            certChainOverride,
            integritySignals,
            beacon,
            pq,
            biometricGatePassed: job.biometricGatePassed ?? null,
            sensorLogText,
            evidenceEnabled,
            stereoClaims: videoStereoCommit?.contextClaims ?? null,
          });
          // signedVideoBytes is only undefined for out-of-scope containers, where
          // saveItem seals the raw draft + sidecar record — the honest degradation.
          // Checkpoint: last cancel point before the vault write.
          if (await abandonIfCancelled(job, workCleanup)) continue;
          savedId = (await saveItem({ kind: 'video', videoUri: workUri, videoBytes: signedVideoBytes, record })).id;
          await saveDisclosureState(savedId, disclosure, chunkMaps);
          if (videoStereoCommit && job.exhibitVideo) {
            // Committed pair bytes move under the sealed record's evidence
            // dir (vault-sealed, three-state summary alongside)…
            await storeVideoStereoArtifacts(savedId, job.exhibitVideo, videoStereoCommit.section, videoStereoFiles);
            // …and the section persists on the vault record so the share
            // path can pass it to buildProofBundle.
            const section = videoStereoCommit.section;
            await updateRecord(savedId, (rec) => ({ ...rec, videoStereo: section }));
          }
          await maybeAnchorOts(savedId, record);
        } else {
          // ExhibitCamera stereo ingestion (0.13.0, Spec-Camera-Module-0.13
          // §5): map the CaptureResult's three-state EvidencePaths onto the
          // commit contract (bytes read, JSON artifacts converted to the
          // committed desk shape by stereoGlue) and commit them — the
          // context.stereo-* claim values enter the SIGNED context tree via
          // attestPhoto, the section persists on the vault record after
          // signing (excluded from the signed payload, like `ots`).
          // The primary hash binds the STRIPPED delivery bytes — the same
          // bytes attestPhoto hashes into record.asset.sha256 (stripManifest
          // is a no-op on a fresh native capture).
          let stereoCommit: { section: StereoBundleSection; contextClaims: import('../disclosure/inventory').ContextClaim[] } | null = null;
          let stereoFiles: CommittedStereoFile[] = [];
          // W2.1/W2.4 additive commitments: full-sensor stills (hash claims
          // + vault storage) and the device-read capture-settings block,
          // folded into the SAME signed context tree as the stereo claims.
          let fullResExtras: ExtraEvidenceFile[] = [];
          let extraClaims: ContextClaim[] = [];
          // D1: the resolved depth artifact for THIS capture.
          let depthInput: DepthCommitInput | null = null;
          // The resolved secondary viewpoint for THIS capture.
          let secondaryInput: SecondaryCommitInput | null = null;
          if (job.exhibitCapture) {
            const primarySha256 = (await hashFileSha256(workUri)).hex;
            const glue = await buildStereoInputs(job.exhibitCapture, readFileBytes);
            // Throws on a three-state contract violation — fail-closed,
            // the job retries; a capture that cannot state its artifacts
            // must not seal (stereoArtifacts.ts header).
            stereoCommit = commitStereoArtifacts(glue.artifacts, primarySha256);
            stereoFiles = glue.files;
            const fullRes = await buildFullResSealExtras(job.exhibitCapture);
            fullResExtras = fullRes.extras;
            extraClaims = fullRes.claims;
            // D1: the depth artifact rides the same job — resolved
            // (full-res primary, degraded fallback), committed pre-signing
            // by attestPhoto, sealed into the vault below.
            depthInput = resolveDepthSealInput(job.exhibitCapture);
            // The secondary viewpoint rides the same job — resolved,
            // committed pre-signing by attestPhoto as a componentOf
            // ingredient (embedded thumbnail + full-res data hash); the
            // full-res bytes themselves are already vault-sealed by
            // buildFullResSealExtras above.
            secondaryInput = resolveSecondarySealInput(job.exhibitCapture);
          }
          const allClaims = [...(stereoCommit?.contextClaims ?? []), ...extraClaims];
          const { signedPhotoBytes, record, disclosure } = await attestPhoto({
            photoUri: workUri,
            context: contextWithCaptureKit(job),
            identity: job.identity,
            key,
            capturedAt: job.capturedAt,
            assignmentLabel,
            certChainOverride,
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
            // D1: the verified depth artifact is sealed beside the photo
            // (path + committed sha — vaultFs re-reads and re-verifies).
            depthArtifact:
              depthInput && depthInput.artifact.state === 'path' && depthInput.sha256
                ? { path: depthInput.artifact.path, mime: depthInput.metadata?.mime ?? 'image/png', sha256: depthInput.sha256 }
                : null,
          })).id;
          await saveDisclosureState(savedId, disclosure, null);
          if (stereoCommit && job.exhibitCapture) {
            // The committed artifact bytes move under the sealed record's
            // evidence dir (vault-sealed, three-state summary alongside)…
            await storeExhibitArtifacts(savedId, job.exhibitCapture, stereoCommit.section, stereoFiles, fullResExtras);
            // …and the section persists on the vault record so the share
            // path can pass it as buildProofBundle's 4th arg.
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
        job.state = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
        if (job.state === 'failed') {
          // Attempt budget exhausted — this failure is now a STATED state:
          // the Exhibits needs-attention section renders it, and the log
          // keeps the verbatim error after the toast is long gone.
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
