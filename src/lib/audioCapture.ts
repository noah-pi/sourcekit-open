// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Bridge to the native AudioCapture module (modules/audio-capture) — one
 * AVAudioEngine feeding both the .m4a file and on-device speech recognition.
 * Absent on web, Expo Go, Android, or old builds — callers must check
 * `audioCaptureAvailable()` first.
 */

import { Platform } from 'react-native';
import { requireNativeModule, EventEmitter, type EventSubscription } from 'expo-modules-core';

export interface TranscriptSegment {
  /** Seconds from recording start. */
  start: number;
  duration: number;
  text: string;
}

/** Three-state result of the recording's IMU (gyro) sink — media parity with video. */
export type SensorLogState =
  /** The gyro JSONL exists at sensorLogPath and covers the recorded window. */
  | 'recorded'
  /** The sink was requested but failed (write error) — stated as a failure, never hidden. */
  | 'failed'
  /** No gyro on this device, or no log was requested — nothing was ever going to be recorded. */
  | 'unavailable';

/** Delivery-file sink outcome, declared natively — a truncated take is never passed off as complete. */
export type AudioFileState =
  /** Every audio buffer reached the file. */
  | 'clean'
  /** A write failed mid-take — the file is real but truncated; fileError says why. */
  | 'partial'
  /** Nothing durable reached disk — path is null; sealing must be refused. */
  | 'failed';

export interface AudioStopResult {
  path: string;
  durationMs: number;
  transcript: string;
  segments: TranscriptSegment[];
  /**
   * Delivery-file sink state. ABSENT (undefined) on pre-parity native
   * builds — treat as 'clean' (those builds could not detect write errors).
   */
  fileState?: AudioFileState;
  /** The first write error's message when fileState is 'partial' or 'failed'. */
  fileError?: string | null;
  /**
   * Gyro JSONL covering exactly the recorded window (CaptureKit SensorLogger
   * line format; WS2 Phase 2 §3 media parity) — the source of the exhibit's
   * signed com.verify.poseTrace. Present only when sensorLogState is
   * 'recorded'. ABSENT (undefined) on pre-parity native builds.
   */
  sensorLogPath?: string | null;
  /** Which IMU-sink case this recording is. ABSENT (undefined) on pre-parity native builds. */
  sensorLogState?: SensorLogState;
  /**
   * Uncompressed LPCM master (CAF) for this take — present only when
   * rawPcmState is 'recorded'. ABSENT (undefined) on pre-0.18.3 native
   * builds; callers map that to the toggle's null (enabled-but-failed is
   * not distinguishable there, and the path was never produced at all).
   */
  rawPcmPath?: string | null;
  /** Which raw-sink case this recording is ('recorded' | 'failed' | 'unavailable'). */
  rawPcmState?: string;
  /** The first raw-master write/create error, when one happened. */
  rawPcmError?: string | null;
}

/** Why live transcription is off for a recording (null = it's on). */
export type TranscriptionOffReason = 'unsupported' | 'denied' | 'restricted' | null;

interface AudioCaptureNative {
  requestPermissions(): Promise<{ microphone: boolean; speech: boolean }>;
  transcriptionAvailable(): boolean;
  start(path: string, sensorLogPath?: string | null, rawPcmPath?: string | null): Promise<{ transcribing: boolean; transcriptionOffReason: TranscriptionOffReason }>;
  stop(): Promise<AudioStopResult>;
}

type Emitter = InstanceType<typeof EventEmitter>;

let native: AudioCaptureNative | null = null;
try {
  if (Platform.OS === 'ios') {
    native = requireNativeModule<AudioCaptureNative>('AudioCapture');
  }
} catch {
  native = null;
}

let emitter: Emitter | null = null;
function getEmitter(): Emitter | null {
  if (!native) return null;
  if (!emitter) emitter = new EventEmitter(native as never);
  return emitter;
}

export function audioCaptureAvailable(): boolean {
  return native !== null;
}

export function transcriptionAvailable(): boolean {
  try {
    return native !== null && native.transcriptionAvailable();
  } catch {
    return false;
  }
}

export async function requestAudioPermissions(): Promise<{ microphone: boolean; speech: boolean }> {
  if (!native) return { microphone: false, speech: false };
  return native.requestPermissions();
}

export function onTranscript(cb: (e: { text: string; isFinal: boolean }) => void): EventSubscription | null {
  return getEmitter()?.addListener('onTranscript', cb) ?? null;
}

export function onLevel(cb: (e: { db: number }) => void): EventSubscription | null {
  return getEmitter()?.addListener('onLevel', cb) ?? null;
}

export function onCaptureError(cb: (e: { message: string }) => void): EventSubscription | null {
  return getEmitter()?.addListener('onError', cb) ?? null;
}

/**
 * Fired when iOS seizes the audio session mid-recording (phone call, Siri,
 * alarm). The native side has already finalized the .m4a at the last good
 * frame — the payload is the same shape as stop(), and the transcript may be
 * shorter than what the live partial showed (no 4s wait for a final result).
 */
export function onInterrupted(cb: (e: AudioStopResult) => void): EventSubscription | null {
  return getEmitter()?.addListener('onInterrupted', cb) ?? null;
}

/**
 * Starts recording. `sensorLogPath` (optional) is where the native IMU sink
 * writes the gyro JSONL for this take — pass null/omit only when the capture
 * -evidence sensors toggle is off; the stop result then honestly reports
 * sensorLogState 'unavailable' (or the fields are absent on a pre-parity
 * native build, which callers must map to 'never-recorded').
 */
export async function startCapture(
  path: string,
  sensorLogPath?: string | null,
  rawPcmPath?: string | null
): Promise<{ transcribing: boolean; transcriptionOffReason: TranscriptionOffReason }> {
  if (!native) throw new Error('Audio capture module unavailable');
  const res = await native.start(path, sensorLogPath ?? null, rawPcmPath ?? null);
  // Older native builds don't return the reason field — degrade to null.
  return { transcribing: res.transcribing, transcriptionOffReason: res.transcriptionOffReason ?? null };
}

export async function stopCapture(): Promise<AudioStopResult> {
  if (!native) throw new Error('Audio capture module unavailable');
  return native.stop();
}
