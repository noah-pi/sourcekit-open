// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * iOS binding (§2/§7a). Wraps the native module `modules/c2pa-ios` (c2pa-swift
 * v0.0.12, C2PAC.xcframework, iOS 16+) and returns the same normalized result
 * shape as the desk engine (src/provenance/engine/upstreamEngine.ts), so
 * policyLayer.ts gets identical facts on device and on desk. No verdicts here.
 *
 * The normalization code (status-code classes, thrown-error classifier, store
 * JSON summarization, container gate) is verbatim from the desk engine, since
 * the differential oracle's agreement claim requires both to sort engine output
 * identically. Only the runtime-specific parts differ: package loading becomes
 * the native module, the Blob/FileReaderSync shims become temp-file staging via
 * expo-file-system, and the engine call itself.
 *
 * Offline invariant: remote manifest fetch and OCSP are disabled in the loaded
 * settings, and the sign path uses no TSA URL. Trust material is only what the
 * caller pins.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';
import { base64ToBytes, bytesToBase64 } from '../../lib/bytes';
import { SOFT_BINDING_ALG_PHASH } from '../../c2pa/c2pa';

// ---------------------------------------------------------------------------
// Normalized result shape, identical to the desk engine's. policyLayer.ts
// consumes this and only this.
// ---------------------------------------------------------------------------

/** Which C2PA trust list the signer chained to, as far as this run knows. */
export type TrustListHit =
  | 'official'  // chained to anchors the caller pinned as the official C2PA Trust List
  | 'interim'   // chained to anchors the caller pinned as the frozen ITL (2026-01-01)
  | 'none'      // trust was evaluated against pinned anchors; signer is on neither list
  | 'unknown';  // trust not evaluated against caller-pinned anchors

export type EngineId =
  | 'upstream-c2pa-node'
  | 'upstream-c2pa-wasm'
  | 'upstream-c2pa-ios'
  | 'handrolled'
  | 'unavailable';

export interface EngineStatus {
  code: string;
  severity: 'failure' | 'informational' | 'success' | 'unknown';
  explanation: string | null;
}

export interface EngineManifestSummary {
  label: string | null;
  claimGenerator: string | null;
  title: string | null;
  format: string | null;
  instanceId: string | null;
  claimVersion: number | null;
  ingredients: { label: string | null; title: string | null; format: string | null; relationship: string | null }[];
  signature: {
    alg: string | null;
    issuer: string | null;
    commonName: string | null;
    time: string | null;
    certChainLength: number;
  } | null;
}

export interface NormalizedEngineResult {
  engine: EngineId;
  /** Human-pinned engine version string (package version, recorded for reproducibility). */
  engineVersion: string;
  /** False when the engine could not run; rawErrors says why. */
  engineAvailable: boolean;
  /** Container gate facts: the caller's flow rejected this container. */
  containerRejected: 'NOT_JPEG' | 'NOT_BMFF' | null;
  manifestFound: boolean;
  manifests: EngineManifestSummary[];
 /** The active (most recent) manifest's claim summary. */
  activeClaim: EngineManifestSummary | null;
  validationStatus: EngineStatus[];
  // --- inputs the policy layer turns into verdicts -------------------
  signatureValid: boolean | null;
  claimAssertionsMatch: boolean | null;
  assetHashMatches: boolean | null;
  /** 'void-binding' = the signed claim honors no usable binding; integrity unproven. */
  assetHashFailure: 'mismatch' | 'void-binding' | null;
  /** Structure the engine cannot evaluate (merkle-aux BMFF, unknown algorithms…). */
  unsupported: boolean;
  unsupportedReason: string | null;
  /** Container/parse failure that prevents any evaluation (corrupt file). */
  unreadable: boolean;
  signerChain: { length: number; linksValid: boolean | null; topSubject: string | null }[];
  trustListHit: TrustListHit;
  rawErrors: string[];
  /** Engine-specific raw output (the upstream store JSON, parsed). */
  raw?: unknown;
}

/** Trust material the caller pins for this run. Offline; never fetched. */
export interface EngineTrustOptions {
  /** PEM anchor bundle. `kind` declares which list the caller says this is. */
  anchorsPem: string;
  kind: 'official' | 'interim';
}

export interface UpstreamReadOptions {
  trust?: EngineTrustOptions;
}

// ---------------------------------------------------------------------------
// Native module loading: optional; the result reports what loaded.
// ---------------------------------------------------------------------------

/** c2pa-swift package version this binding is written against (pinned). */
const C2PA_SWIFT_VERSION = '0.0.12';

interface C2paIosNative {
  /** Upstream c2pa-rs core version string. */
  getVersion(): string;
  /** Process-global c2pa-rs settings (JSON). Pinned once per process; see initSettings. */
  loadSettings(settingsJSON: string): Promise<void>;
  /** Embedded manifest store JSON (format inferred from the path's extension). */
  readManifest(path: string): Promise<string>;
  /** Detached/sidecar manifest validation against an asset. */
  readManifestDetached(path: string, format: string, manifestBase64: string): Promise<string>;
  signFilePem(
    sourcePath: string, destPath: string, manifestJSON: string,
    certificatePEM: string, privateKeyPEM: string, algorithm: string,
  ): Promise<void>;
  signFileSecureEnclave(
    sourcePath: string, destPath: string, format: string, manifestJSON: string,
    certificateChainPEM: string, keyTag: string, requireBiometric: boolean,
    tsaUrl: string | null, resourcesJson: string | null, useHeldBioContext: boolean,
  ): Promise<string>;
}

let native: C2paIosNative | null = null;
let nativeLoadError: string | null = null;
let nativeCoreVersion: string | null = null;
try {
  if (Platform.OS === 'ios') {
    native = requireNativeModule<C2paIosNative>('C2paIos');
    try {
      // Optional call: requireNativeModule yields null when the module is
      // absent, which is the lab's case and a legitimate one on any build
      // without the pod.
      nativeCoreVersion = native?.getVersion() ?? null;
    } catch {
      nativeCoreVersion = null; // diagnostic only; does not gate the engine
    }
  } else {
    nativeLoadError = 'c2pa-ios native module is iOS-only';
  }
} catch (e) {
  native = null;
  nativeLoadError = e instanceof Error ? e.message : String(e);
}

/** True when the native c2pa-swift binding is present (dev build or TestFlight, not Expo Go). */
export function iosEngineAvailable(): boolean {
  return native !== null;
}

/** Pinned versions this module targets; recorded in reports and lockfiles. */
export const UPSTREAM_IOS_PINS = {
  c2paSwift: C2PA_SWIFT_VERSION,
  c2paSwiftBinaryTarget: 'C2PAC.xcframework',
  c2paSwiftChecksum: 'a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8',
  coreVersionAtRuntime: nativeCoreVersion ?? 'unknown',
  requires: 'iOS>=16, dev build (not Expo Go)',
} as const;

/**
 * Engine settings are process-global in c2pa-rs: load once, then pin. Offline
 * by construction (no remote manifest fetch, no OCSP), and trust anchors are
 * only what the caller supplies. Desk semantics; the native call is
 * Signer.loadSettings.
 */
let settingsLoaded = false;
let settingsFingerprint: string | null = null;

async function initSettings(opts?: UpstreamReadOptions): Promise<void> {
  const settings = {
    verify: { verify_after_reading: true, verify_trust: true, ocsp_fetch: false, remote_manifest_fetch: false },
    ...(opts?.trust ? { trust: { trust_anchors: opts.trust.anchorsPem } } : {}),
  };
  const fp = JSON.stringify(settings);
  if (settingsLoaded) {
    if (settingsFingerprint !== fp) {
      throw new Error('upstream engine settings are process-global and already pinned for this process; refusing to silently switch trust material mid-run');
    }
    return;
  }
  await native!.loadSettings(fp);
  settingsLoaded = true;
  settingsFingerprint = fp;
}

// ---------------------------------------------------------------------------
// Temp-file staging. The native reader works on file paths and infers the
// container format from the extension, so bytes are staged to the cache
// directory with a real extension and always cleaned up.
// ---------------------------------------------------------------------------

function extensionFor(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'video/quicktime': return 'mov';
    case 'audio/mp4': return 'm4a';
    default: return 'mp4';
  }
}

let stagedCounter = 0;

async function withStagedFile<T>(
  bytes: Uint8Array,
  mime: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error('expo-file-system cacheDirectory unavailable');
  stagedCounter = (stagedCounter + 1) % 0x10000;
  const path = `${dir}c2pa-ios-${Date.now()}-${stagedCounter}.${extensionFor(mime)}`;
  await FileSystem.writeAsStringAsync(path, bytesToBase64(bytes), {
    encoding: FileSystem.EncodingType.Base64,
  });
  try {
    return await fn(path);
  } finally {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Container sniffing: the photo flow accepts JPEG/PNG, the video flow BMFF.
// Same rule as the desk engine.
// ---------------------------------------------------------------------------

type Container = 'jpeg' | 'png' | 'bmff-mp4' | 'bmff-mov' | 'bmff-m4a' | 'unknown';

function sniffContainer(bytes: Uint8Array): Container {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand === 'qt  ') return 'bmff-mov';
    if (brand.startsWith('M4A') || brand.startsWith('M4B')) return 'bmff-m4a';
    return 'bmff-mp4';
  }
  return 'unknown';
}

function mimeFor(c: Container): string {
  switch (c) {
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'bmff-mov': return 'video/quicktime';
    case 'bmff-m4a': return 'audio/mp4';
    default: return 'video/mp4';
  }
}

// ---------------------------------------------------------------------------
// Status-code classes. This section sorts engine output into facts; the
// verdict mapping is in policyLayer.ts. Same rules as the desk engine.
// ---------------------------------------------------------------------------

/** Failure codes that mean "the manifest/signature itself is bad". */
const SIGNATURE_FAILURE_CODES = new Set([
  'claimSignature.invalid', 'claim.missing', 'claim.hardBindings.missing',
  'claim.cbor.invalid', 'claimSignature.outsideManifest',
]);
/** Failure codes that mean the media changed after signing. */
const ASSET_MISMATCH_CODES = new Set([
  'assertion.dataHash.mismatch', 'assertion.bmffHash.mismatch', 'assertion.boxesHash.mismatch',
]);
/**
 * A-1 binding-guard classes: the claim references no usable hard binding, or
 * one that is unresolvable. The binding is void, meaning integrity unproven
 * rather than proven tamper.
 */
const VOID_BINDING_CODES = new Set([
  'assertion.undeclared', 'assertion.missing', 'assertion.outsideManifest',
]);
/** Structure classes this policy declines to evaluate: the unsupported tri-state. */
const UNSUPPORTED_CODES = new Set([
  'algorithm.unsupported', 'assertion.bmffHash.malformed', 'assertion.boxesHash.unknownBox',
]);
/** Informational trust codes: inputs to the trust tiers, not verdict failures. */
const TRUST_INFO_CODES = new Set([
  'signingCredential.untrusted', 'signingCredential.trusted', 'timeStamp.untrusted', 'timeStamp.trusted',
]);

/**
 * Ordered thrown-error classification chain. Thrown messages are free text, so
 * the order is load-bearing:
 *
 *   1. Positive tamper signals first: a signature or hash mismatch is a
 *      failed-rung fact and must not fall into the neutral classes below.
 *   2. Absence classes (noManifest), exact-ish engine variant names only.
 *   3. Unsupported classes, kept narrow.
 *   4. Unreadable: container or parse failure, not a claim decode failure.
 *   5. Everything else fails closed: manifestFound with signatureValid=false.
 *
 * The native side passes the raw c2pa-rs error text through to this chain:
 * NamedException carries C2PAError.errorDescription
 * ("C2PA API error: <raw message>"); see C2paIosModule.mapError.
 */
function classifyThrown(message: string): { tamper: boolean; noManifest: boolean; unsupported: boolean; unreadable: boolean } {
  const m = message;
  const tamper = /mismatch|invalid signature|bad signature|signature (?:verification )?fail|hash (?:check )?fail/i.test(m);
  const noManifest = !tamper && /JumbfNotFound|no manifest|ManifestNotFound|no claim/i.test(m);
  const unsupported = !tamper && /unsupported|not supported|aux box/i.test(m);
  const unreadable = !tamper && /MalformedJumbf|truncated|InvalidBoxSize/i.test(m) && !/claim/i.test(m);
  return { tamper, noManifest, unsupported, unreadable };
}

// ---------------------------------------------------------------------------
// Normalization of the upstream store JSON. Same as the desk engine.
// ---------------------------------------------------------------------------

function summarizeManifest(label: string | null, m: Record<string, unknown>): EngineManifestSummary {
  const sig = (m.signature_info ?? null) as Record<string, unknown> | null;
  const ingredients = Array.isArray(m.ingredients)
    ? (m.ingredients as Record<string, unknown>[]).map((i) => ({
        label: (i.label as string) ?? null,
        title: (i.title as string) ?? null,
        format: (i.format as string) ?? null,
        relationship: (i.relationship as string) ?? null,
      }))
    : [];
  return {
    label: label ?? ((m.label as string) ?? null),
    claimGenerator: (m.claim_generator as string) ?? null,
    title: (m.title as string) ?? null,
    format: (m.format as string) ?? null,
    instanceId: (m.instance_id as string) ?? null,
    claimVersion: typeof m.claim_version === 'number' ? (m.claim_version as number) : null,
    ingredients,
    signature: sig
      ? {
          alg: (sig.alg as string) ?? null,
          issuer: (sig.issuer as string) ?? null,
          commonName: (sig.common_name as string) ?? null,
          time: (sig.time as string) ?? null,
          certChainLength: Array.isArray((sig as Record<string, unknown>).cert_chain)
            ? ((sig as Record<string, unknown>).cert_chain as unknown[]).length
            : 0,
        }
      : null,
  };
}

/** Blank normalized result; same shape as the desk engine adapters. */
export function baseResultLike(engine: EngineId, version: string): NormalizedEngineResult {
  return {
    engine, engineVersion: version, engineAvailable: true,
    containerRejected: null, manifestFound: false,
    manifests: [], activeClaim: null, validationStatus: [],
    signatureValid: null, claimAssertionsMatch: null,
    assetHashMatches: null, assetHashFailure: null,
    unsupported: false, unsupportedReason: null, unreadable: false,
    signerChain: [], trustListHit: 'unknown', rawErrors: [],
  };
}

function engineVersion(): string {
  return nativeCoreVersion
    ? `c2pa-swift ${C2PA_SWIFT_VERSION} (c2pa-rs core ${nativeCoreVersion})`
    : `c2pa-swift ${C2PA_SWIFT_VERSION}`;
}

function unavailableResult(reason: string): NormalizedEngineResult {
  const r = baseResultLike('unavailable', 'none');
  r.engineAvailable = false;
  r.unsupported = true;
  r.unsupportedReason = reason;
  r.rawErrors.push(reason);
  return r;
}

/**
 * Shared normalization: given a thunk that produces the upstream store JSON
 * string or throws an engine error, fill in the normalized result. Store shape,
 * code sorting, fail-closed handling of unknown failure classes, and trust
 * inputs match the desk engine's post-read logic.
 */
async function normalizeRead(
  r: NormalizedEngineResult,
  opts: UpstreamReadOptions | undefined,
  readStore: () => Promise<string>,
): Promise<NormalizedEngineResult> {
  let storeJson: string;
  try {
    await initSettings(opts);
    storeJson = await readStore();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    r.rawErrors.push(msg);
    const cls = classifyThrown(msg);
    if (cls.tamper) {
      // Positive tamper signal in the thrown text: failed-rung fact.
      r.manifestFound = true;
      r.signatureValid = false;
    } else if (cls.noManifest) {
      r.manifestFound = false;
    } else if (cls.unsupported) {
      r.manifestFound = true;
      r.unsupported = true;
      r.unsupportedReason = msg;
    } else if (cls.unreadable) {
      r.manifestFound = true;
      r.unreadable = true;
    } else {
      // Manifest present but undecodable: a tampered-manifest fact.
      r.manifestFound = true;
      r.signatureValid = false;
    }
    return r;
  }

  const store = JSON.parse(storeJson) as Record<string, unknown>;
  r.raw = store;
  const manifests = (store.manifests ?? {}) as Record<string, Record<string, unknown>>;
  const activeLabel = (store.active_manifest as string) ?? null;
  r.manifestFound = activeLabel !== null || Object.keys(manifests).length > 0;
  for (const [label, m] of Object.entries(manifests)) {
    r.manifests.push(summarizeManifest(label, m));
  }
  r.activeClaim = activeLabel && manifests[activeLabel] ? summarizeManifest(activeLabel, manifests[activeLabel]) : null;

  // validation_status (flat) + validation_results (tri-array) → statuses.
  const statuses: EngineStatus[] = [];
  const flat = Array.isArray(store.validation_status) ? (store.validation_status as Record<string, unknown>[]) : [];
  for (const s of flat) {
    const code = String(s.code ?? 'unknown');
    statuses.push({
      code,
      severity: TRUST_INFO_CODES.has(code) ? 'informational' : 'failure',
      explanation: (s.explanation as string) ?? null,
    });
  }
  const results = store.validation_results as Record<string, unknown> | undefined;
  const activeResults = results?.activeManifest as Record<string, unknown> | undefined;
  for (const sev of ['failure', 'informational', 'success'] as const) {
    const arr = activeResults?.[sev];
    if (Array.isArray(arr)) {
      for (const s of arr as Record<string, unknown>[]) {
        const code = String(s.code ?? 'unknown');
        if (!statuses.some((x) => x.code === code)) {
          statuses.push({ code, severity: sev, explanation: (s.explanation as string) ?? null });
        }
      }
    }
  }
  r.validationStatus = statuses;

  // --- facts from codes (mapping table lives in policyLayer.ts) ---
  const failures = statuses.filter((s) => s.severity === 'failure').map((s) => s.code);
  const unsupportedHits = failures.filter((c) => UNSUPPORTED_CODES.has(c));
  if (unsupportedHits.length > 0) {
    r.unsupported = true;
    r.unsupportedReason = `engine declined structure: ${unsupportedHits.join(', ')}`;
  }
  if (failures.some((c) => SIGNATURE_FAILURE_CODES.has(c))) r.signatureValid = false;
  if (failures.includes('assertion.hashedURI.mismatch')) r.claimAssertionsMatch = false;
  if (failures.some((c) => ASSET_MISMATCH_CODES.has(c))) {
    r.assetHashMatches = false;
    r.assetHashFailure = 'mismatch';
  }
  if (failures.some((c) => VOID_BINDING_CODES.has(c))) {
    r.assetHashMatches = false;
    r.assetHashFailure = 'void-binding';
  }
  const state = store.validation_state as string | undefined;
  if ((state === 'Valid' || state === 'Trusted') && failures.length === 0) {
    r.signatureValid = r.signatureValid ?? true;
    r.claimAssertionsMatch = r.claimAssertionsMatch ?? true;
    r.assetHashMatches = r.assetHashMatches ?? true;
  } else if (r.signatureValid === null && failures.length > 0) {
    // Fail closed on unknown failure classes: an unrecognized failure counts
    // as signature-invalid rather than being ignored, even when it arrives
    // alongside an unsupported class.
    const unknown = failures.filter((c) => !TRUST_INFO_CODES.has(c) && !UNSUPPORTED_CODES.has(c)
      && !SIGNATURE_FAILURE_CODES.has(c) && !ASSET_MISMATCH_CODES.has(c) && !VOID_BINDING_CODES.has(c)
      && c !== 'assertion.hashedURI.mismatch');
    if (unknown.length > 0) {
      r.signatureValid = false;
      r.rawErrors.push(`unclassified engine failure codes (mapped fail-closed): ${unknown.join(', ')}`);
    }
  }

  // --- trust inputs ---
  if (opts?.trust) {
    const trusted = statuses.some((s) => s.code === 'signingCredential.trusted') || state === 'Trusted';
    const untrusted = statuses.some((s) => s.code === 'signingCredential.untrusted');
    r.trustListHit = trusted ? opts.trust.kind : untrusted ? 'none' : 'unknown';
  } else {
    // No caller-pinned anchors: an engine trust report cannot be attributed to
    // the official TL versus the frozen ITL, so nothing is claimed. The report
    // must name which list a verdict used.
    r.trustListHit = 'unknown';
  }

  if (r.activeClaim?.signature) {
    r.signerChain = [{
      length: r.activeClaim.signature.certChainLength,
      linksValid: null, // chain mechanics not exposed by the upstream reader JSON
      topSubject: r.activeClaim.signature.issuer ?? r.activeClaim.signature.commonName,
    }];
  }
  return r;
}

/** Container gate shared by verify and readIosAsset; same rule as the desk. */
function gateContainer(r: NormalizedEngineResult, bytes: Uint8Array, flow: 'photo' | 'video'): Container | null {
  const container = sniffContainer(bytes);
  if (flow === 'photo' && container !== 'jpeg' && container !== 'png') {
    r.containerRejected = 'NOT_JPEG';
    return null;
  }
  if (flow === 'video' && !(container === 'bmff-mp4' || container === 'bmff-mov' || container === 'bmff-m4a')) {
    r.containerRejected = 'NOT_BMFF';
    return null;
  }
  if (container === 'unknown') {
    r.containerRejected = flow === 'photo' ? 'NOT_JPEG' : 'NOT_BMFF';
    return null;
  }
  return container;
}

/**
 * Primary read path: verify an asset's embedded C2PA manifest and return the
 * normalized result for the policy layer. `mime` must be the asset's real MIME
 * type (image/jpeg, image/png, video/mp4, video/quicktime, audio/mp4); it
 * selects the flow's container gate as the desk engine's flows do.
 */
export async function verify(
  bytes: Uint8Array,
  mime: string,
  opts?: UpstreamReadOptions,
): Promise<NormalizedEngineResult> {
  const flow: 'photo' | 'video' = mime === 'image/jpeg' || mime === 'image/png'
    ? 'photo'
    : mime === 'video/mp4' || mime === 'video/quicktime' || mime === 'audio/mp4'
      ? 'video'
      // Unrecognized caller MIME: derive the flow from the bytes, so the gate
      // rejects rather than trusting a wrong label.
      : sniffContainer(bytes) === 'jpeg' || sniffContainer(bytes) === 'png' ? 'photo' : 'video';
  return readIosAsset(bytes, flow, opts);
}

/**
 * Read an asset with the upstream iOS engine and normalize. `flow` mirrors the
 * desk entry points: 'photo' accepts JPEG/PNG, 'video' accepts BMFF. A wrong
 * container is reported as containerRejected for the policy layer.
 */
export async function readIosAsset(
  bytes: Uint8Array,
  flow: 'photo' | 'video',
  opts?: UpstreamReadOptions,
): Promise<NormalizedEngineResult> {
  if (!native) {
    return unavailableResult(
      `upstream iOS engine unavailable: ${nativeLoadError ?? 'C2paIos native module not linked (needs a dev build with modules/c2pa-ios)'}`,
    );
  }
  const r = baseResultLike('upstream-c2pa-ios', engineVersion());
  const container = gateContainer(r, bytes, flow);
  if (!container) return r;

  const mime = mimeFor(container);
  return normalizeRead(r, opts, () =>
    withStagedFile(bytes, mime, (path) => native!.readManifest(path)),
  );
}

/**
 * Detached path: validate a sidecar manifest (application/c2pa bytes) against
 * its asset, as in detached.ts. Same normalized result as the embedded path.
 */
export async function readIosDetached(
  manifestData: Uint8Array,
  bytes: Uint8Array,
  flow: 'photo' | 'video',
  opts?: UpstreamReadOptions,
): Promise<NormalizedEngineResult> {
  if (!native) {
    return unavailableResult(
      `upstream iOS engine unavailable: ${nativeLoadError ?? 'C2paIos native module not linked'}`,
    );
  }
  const r = baseResultLike('upstream-c2pa-ios', engineVersion());
  const container = gateContainer(r, bytes, flow);
  if (!container) return r;

  const mime = mimeFor(container);
  return normalizeRead(r, opts, () =>
    withStagedFile(bytes, mime, (path) =>
      native!.readManifestDetached(path, mime, bytesToBase64(manifestData)),
    ),
  );
}

// ---------------------------------------------------------------------------
// Sign: embed a signed manifest. The native APIs are verified against the
// c2pa-swift v0.0.12 source but not compiled here, so the first signed artifact
// must round-trip through verify on device before this path is used for
// captures. Certificate issuance for the Secure Enclave key belongs to the
// app's identity flow; this module never mints certificates.
// ---------------------------------------------------------------------------

/** The app's standard Secure Enclave signing key (modules/secure-enclave). */
export const DEFAULT_ENCLAVE_KEY_TAG = 'com.verify.camera.signing-key';

export type IosSigner =
  | {
      kind: 'pem';
      certificatePEM: string;
      privateKeyPEM: string;
      /** es256/es384/es512/ps256/ps384/ps512/ed25519; default es256. */
      algorithm?: string;
    }
  | {
      kind: 'secure-enclave';
      /** Caller-supplied chain whose leaf public key corresponds to the enclave key. */
      certificateChainPEM: string;
      /** Keychain tag of the enclave key; created by c2pa-swift if absent. */
      keyTag?: string;
      /** Biometric-bound key: per-use Face ID/Touch ID (new keys only). */
      requireBiometric?: boolean;
      /** Sign under the LAContext the caller vaulted with enclaveSealBioHold,
       *  so one Face ID scan covers the record and the COSE claim. Native
       *  throws when set with no hold live, rather than prompting again. */
      useHeldBioContext?: boolean;
    };

export interface IosSignOptions {
  /** C2PA manifest definition JSON (claim_generator, title, format, assertions…). */
  manifestJSON: string;
  signer: IosSigner;
  /** RFC 3161 endpoint for the claim-layer timestamp (sigTst2, applied by
   *  c2pa-swift itself), or null for an honestly untimed capture. Only
   *  meaningful for the secure-enclave signer. */
  tsaUrl?: string | null;
  /** JSON array of {identifier, contentType, dataBase64} — binary resources
   *  (thumbnails) for Builder.addResource. Secure-enclave signer only. */
  resourcesJson?: string | null;
}

export interface IosSignResult {
  /** The signed asset (manifest embedded). */
  signedBytes: Uint8Array;
  /** Embedded manifest bytes as returned by the builder (may be empty). */
  manifestBytes: Uint8Array | null;
}

/**
 * Sign `bytes` (JPEG/PNG/MP4/MOV/M4A per `mime`) with a C2PA manifest.
 * `tsaUrl` null keeps the offline invariant. Throws on any engine error
 * rather than emitting a half-signed artifact.
 */
export async function sign(
  bytes: Uint8Array,
  mime: string,
  opts: IosSignOptions,
): Promise<IosSignResult> {
  if (!native) {
    throw new Error(
      `upstream iOS engine unavailable: ${nativeLoadError ?? 'C2paIos native module not linked'}`,
    );
  }
  const container = sniffContainer(bytes);
  if (container === 'unknown') {
    throw new Error('sign: unrecognized container (expected JPEG, PNG, or BMFF bytes)');
  }
  const effectiveMime = mime || mimeFor(container);
  return withStagedFile(bytes, effectiveMime, async (sourcePath) => {
    const destPath = `${sourcePath}.signed.${extensionFor(effectiveMime)}`;
    try {
      let manifestBase64: string | null = null;
      if (opts.signer.kind === 'pem') {
        await native!.signFilePem(
          sourcePath, destPath, opts.manifestJSON,
          opts.signer.certificatePEM, opts.signer.privateKeyPEM,
          opts.signer.algorithm ?? 'es256',
        );
      } else {
        manifestBase64 = await native!.signFileSecureEnclave(
          sourcePath, destPath, effectiveMime, opts.manifestJSON,
          opts.signer.certificateChainPEM,
          opts.signer.keyTag ?? DEFAULT_ENCLAVE_KEY_TAG,
          opts.signer.requireBiometric ?? false,
          opts.tsaUrl ?? null,
          opts.resourcesJson ?? null,
          opts.signer.useHeldBioContext ?? false,
        );
      }
      const signedBase64 = await FileSystem.readAsStringAsync(destPath, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return {
        signedBytes: base64ToBytes(signedBase64),
        manifestBytes: manifestBase64 ? base64ToBytes(manifestBase64) : null,
      };
    } finally {
      await FileSystem.deleteAsync(destPath, { idempotent: true }).catch(() => undefined);
    }
  });
}

// ---------------------------------------------------------------------------
// c2pa-swift signing path: JPEG/PNG/BMFF bytes in, signed bytes out.
// Gated behind UPSTREAM_SIGNING_EXPERIMENT, a compile-time flag rather than a
// UI toggle.
//
// What the SDK manifest carries vs. the hand-rolled builder:
//   CARRIED (JSON assertions, labels unchanged — the verifier reads by label):
//     com.verify.telemetry (the signed attestation record), com.verify.app-attest,
//     com.verify.transcript, com.verify.exif, com.verify.identity, and the
//     JSON custom assertions (streamedChunks/contextTree/poseTrace/…).
//   BINARY PAYLOADS : the SDK embeds binary blobs as
//   RESOURCES (Builder.addResource + manifest identifier references — the
//   C2PA-conventional bfdb/bidb layout, verified against the reference implementation): claim thumbnail via manifest.thumbnail,
//   secondary-view still via a v3 ingredient's thumbnail. Depth maps ride
//   as the standard c2pa.depthmap.GDepth assertion (its map image is
//   base64-inside-payload already — no resource needed). pHash rides as
//   com.verify.phash (JSON) — the SDK has no slot for raw CBOR soft-binding
//   blocks; the verifier surfaces it through the same report field.
//   Custom assertion URI references to arbitrary resources are NOT used:
//   c2pa-rs only embeds resources referenced by thumbnail identifiers
//   , so nothing references a resource the store lacks.
//   PQ: record-only by design () — the SDK has no claim-PQ slot and
//   none is needed; the record's pqScope: 'record' says so.
//   RFC 3161: the caller's configured TSA endpoint is handed to c2pa-swift
//   (sigTst2, applied by the SDK at sign time) — the same authority the
//   hand-rolled path fetched from; null when none is configured, and the
//   capture is then honestly untimed ("Not countersigned — device clock only").
// ---------------------------------------------------------------------------

/**
 * Compile-time master gate for the SDK signing path. Even with this true,
 * every capture additionally requires the runtime settings switch in
 * src/lib/sdkSigningGate.ts before the SDK path runs. Both gates are real:
 * on and on means the SDK signs, self-verifies, and falls back to the
 * hand-rolled builder with a diagnostic entry on any failure.
 */
export const UPSTREAM_SIGNING_EXPERIMENT = true;

/** DER → PEM (64-col base64), leaf first when mapping a chain. */
export function derToPem(der: Uint8Array): string {
  const b64 = bytesToBase64(der);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

export interface SourceKitManifestSpec {
  /** e.g. "Source Kit/1.0.0 (com.verify.camera)". */
  appName: string;
  title: string;
  /** MIME format string for the SDK ('image/jpeg', 'video/mp4', …). */
  format: string;
  /** The signed attestation record (pqScope already declared inside it). */
  telemetry: Record<string, unknown>;
  appAttest?: Record<string, unknown> | null;
  transcript?: unknown | null;
  exif?: Record<string, number | string> | null;
  identity?: { org: string; role: string } | null;
  customAssertions?: { label: string; data: unknown }[] | null;
  /** Claim thumbnail (≤512px JPEG), embedded as a c2pa.thumbnail.claim resource. */
  thumbnailJpeg?: Uint8Array | null;
  /**
   * Secondary camera view: embedded as a v3 ingredient (title + thumbnail
   * resource). The full-res commitment rides in com.verify.secondary-view
   * (JSON) — c2pa-rs only embeds resources referenced by thumbnail
   * identifiers, so the still's own bytes are not embeddable; the hash
   * commitment is what the verifier checks on the desk side.
   */
  secondaryView?: { thumbnailJpeg: Uint8Array; fullResSha256: string; title: string } | null;
  /**
   * Video pair stills : each becomes a v3 ingredient with a
   * thumbnail resource; the full-res hash commitments (pairIndex /
   * hostSeconds anchors) ride in com.verify.video-stills (JSON) — c2pa-rs
   * embeds only thumbnail-referenced resources, so the commitment data is
   * the JSON assertion, exactly the split the photo path uses.
   */
  videoStills?: { thumbnailJpeg: Uint8Array; fullResSha256: string; pairIndex: number; hostSeconds: number | null }[] | null;
  /**
   * Depth map, GDepth-envelope fields exactly as the hand-rolled builder's
   * c2pa.depthmap.GDepth CBOR (map image base64 inside — no resource needed).
   * Emitted under the SAME standard label; the verifier reads CBOR payloads.
   */
  depthGdepth?: Record<string, unknown> | null;
  /** Perceptual hash of the asset (com.verify.phash JSON: { alg, hex }). */
  phashHex?: string | null;
}

/** A binary resource for the SDK Builder (embedded as bfdb/bidb). */
export interface SourceKitResource {
  /** Manifest identifier (thumbnail.identifier / ingredient thumbnail identifier). */
  identifier: string;
  contentType: string;
  bytes: Uint8Array;
}

/**
 * The manifestJSON the SDK Builder consumes, plus the binary resources the
 * bridge must hand to Builder.addResource. Assertion LABELS are byte-for-byte
 * the labels the hand-rolled builder emits — the verifier walks boxes by
 * label, so a SDK-signed file is indistinguishable in structure from a
 * hand-rolled one.
 */
export function buildSourceKitManifestJSON(spec: SourceKitManifestSpec): { manifestJSON: string; resources: SourceKitResource[] } {
  const assertions: { label: string; data: unknown }[] = [
    { label: 'com.verify.telemetry', data: spec.telemetry },
  ];
  const resources: SourceKitResource[] = [];
  if (spec.appAttest) assertions.push({ label: 'com.verify.app-attest', data: spec.appAttest });
  if (spec.transcript) assertions.push({ label: 'com.verify.transcript', data: spec.transcript });
  if (spec.exif && Object.keys(spec.exif).length > 0) {
    assertions.push({
      label: 'com.verify.exif',
      data: { note: 'camera-pipeline-reported, signed as self-reported metadata', ...spec.exif },
    });
  }
  if (spec.identity) assertions.push({ label: 'com.verify.identity', data: spec.identity });
  if (spec.depthGdepth) assertions.push({ label: 'c2pa.depthmap.GDepth', data: spec.depthGdepth });
  // The alg identifier and the length guard are the hand-rolled builder's
  // constant: two Source Kit files signed by different paths have to compare
  // on the recovery primitive, and a malformed hash is dropped the same way
  // on both sides.
  if (spec.phashHex && /^[0-9a-f]{16}$/i.test(spec.phashHex)) {
    assertions.push({ label: 'com.verify.phash', data: { alg: SOFT_BINDING_ALG_PHASH, hex: spec.phashHex } });
  }
  if (spec.secondaryView && /^[0-9a-f]{64}$/i.test(spec.secondaryView.fullResSha256)) {
    assertions.push({
      label: 'com.verify.secondary-view',
      data: {
        fullResSha256: spec.secondaryView.fullResSha256,
        note: 'thumbnail is a lead, not the measurement pixels; the data hash commits the full-res still',
      },
    });
  }
  const stills = (spec.videoStills ?? []).filter(
    (s) => s && s.thumbnailJpeg.length > 0 && /^[0-9a-f]{64}$/i.test(s.fullResSha256),
  );
  if (stills.length > 0) {
    assertions.push({
      label: 'com.verify.video-stills',
      data: {
        stills: stills.map((s) => ({ fullResSha256: s.fullResSha256, pairIndex: s.pairIndex, hostSeconds: s.hostSeconds })),
        note: 'thumbnails are leads, not the measurement pixels; each data hash commits the vaulted pair frame',
      },
    });
  }
  for (const ca of spec.customAssertions ?? []) assertions.push({ label: ca.label, data: ca.data });

  const manifest: Record<string, unknown> = {
    claim_generator: spec.appName,
    title: spec.title,
    format: spec.format,
    assertions,
  };
  if (spec.thumbnailJpeg && spec.thumbnailJpeg.length > 0) {
    manifest.thumbnail = { identifier: 'com.verify.claim-thumbnail', format: 'image/jpeg' };
    resources.push({ identifier: 'com.verify.claim-thumbnail', contentType: 'image/jpeg', bytes: spec.thumbnailJpeg });
  }
  const ingredients: Record<string, unknown>[] = [];
  if (spec.secondaryView && spec.secondaryView.thumbnailJpeg.length > 0) {
    ingredients.push({
      title: spec.secondaryView.title,
      format: 'image/jpeg',
      relationship: 'inputTo',
      thumbnail: { identifier: 'com.verify.secondary-thumbnail', format: 'image/jpeg' },
    });
    resources.push({ identifier: 'com.verify.secondary-thumbnail', contentType: 'image/jpeg', bytes: spec.secondaryView.thumbnailJpeg });
  }
  stills.forEach((s, i) => {
    const identifier = `com.verify.pair-thumbnail-${s.pairIndex ?? i}`;
    ingredients.push({
      title: `verify-pair-${s.pairIndex ?? i}.jpg`,
      format: 'image/jpeg',
      relationship: 'componentOf',
      thumbnail: { identifier, format: 'image/jpeg' },
    });
    resources.push({ identifier, contentType: 'image/jpeg', bytes: s.thumbnailJpeg });
  });
  if (ingredients.length > 0) manifest.ingredients = ingredients;
  return { manifestJSON: JSON.stringify(manifest), resources };
}

export interface SourceKitSdkSignParams {
  appName: string;
  title: string;
  telemetry: Record<string, unknown>;
  appAttest?: Record<string, unknown> | null;
  transcript?: unknown | null;
  exif?: Record<string, number | string> | null;
  identity?: { org: string; role: string } | null;
  customAssertions?: { label: string; data: unknown }[] | null;
  thumbnailJpeg?: Uint8Array | null;
  secondaryView?: { thumbnailJpeg: Uint8Array; fullResSha256: string; title: string } | null;
  videoStills?: { thumbnailJpeg: Uint8Array; fullResSha256: string; pairIndex: number; hostSeconds: number | null }[] | null;
  depthGdepth?: Record<string, unknown> | null;
  phashHex?: string | null;
  /** DER chain, leaf first (the app's existing identity flow — never minted here). */
  certChainDer: Uint8Array[];
  /** Keychain tag of the enclave key the certChainDer leaf belongs to
   * : without it, sign() falls back to the default
   * tag and a biometric capture signs with the non-bio key against the
   * bio cert. */
  enclaveKeyTag?: string | null;
  /** Configured RFC 3161 endpoint, or null for an honestly untimed capture. */
  tsaUrl?: string | null;
  /** the full witness pool in fallback order (timestamp.ts
   * configuredTsaUrls) — each endpoint gets its own attempt through the
   * loopback relay before the untimed retry fires. When present this
   * supersedes tsaUrl. */
  tsaUrls?: string[];
  /** the caller holds a vaulted Face ID evaluation
   * (enclaveSealBioHold) covering this sign — forwarded to the native
   * signer's keychain query. Only set for biometric-bound keys. */
  heldBioContext?: boolean;
}

export interface SourceKitSdkSignResult extends IosSignResult {
  /** true when the configured TSA was unreachable and the seal was
   * completed untimed on the single permitted retry. The claim then carries
   * no RFC 3161 countersignature — the same honestly-untimed shape the
   * hand-rolled path seals offline — and the caller's diagnostic names it. */
  untimedTsaRetry: boolean;
  /** the verbatim error string from the TIMED attempt when
   * untimedTsaRetry fired (relay lastError + upstream text — see
   * TsaLoopbackRelay.swift). Null on a timed success. Never read for
   * control flow — diagnostics only. */
  tsaError: string | null;
  /** the witness URL whose RFC 3161 token countersigned this seal
   * (null on an untimed seal — pool empty or every witness failed). The
   * caller's diagnostic names the answering witness so a field run shows
   * pool iteration on SUCCESS, not only on failure. Never read for control
   * flow — diagnostics only. */
  tsaWitness: string | null;
}

/**
 * Sign media bytes with c2pa-swift using the app's Secure Enclave key and
 * cert chain. Throws on any engine error — the caller's fallback decides what
 * happens next; this function never degrades silently.
 *
 * The only network call inside a c2pa-rs sign is the RFC 3161 fetch, so a
 * resolver-class throw with a TSA configured means the witness was
 * unreachable rather than that signing failed.
 *
 * Witness-pool parity with the hand-rolled path: each configured endpoint
 * gets its own one-shot relay attempt, only a TSA-class failure advances to
 * the next witness, and the single permitted untimed retry fires only once
 * every witness has failed that way. One authority being unreachable from a
 * given network must not cost the countersignature while another answers.
 * Any other failure — or the untimed retry's failure — propagates to the
 * caller's fallback unchanged.
 */
export async function signSourceKitAssetSecureEnclave(
  bytes: Uint8Array,
  mime: string,
  p: SourceKitSdkSignParams,
): Promise<SourceKitSdkSignResult> {
  const { manifestJSON, resources } = buildSourceKitManifestJSON({
    appName: p.appName,
    title: p.title,
    format: mime,
    telemetry: p.telemetry,
    appAttest: p.appAttest ?? null,
    transcript: p.transcript ?? null,
    exif: p.exif ?? null,
    identity: p.identity ?? null,
    customAssertions: p.customAssertions ?? null,
    thumbnailJpeg: p.thumbnailJpeg ?? null,
    secondaryView: p.secondaryView ?? null,
    videoStills: p.videoStills ?? null,
    depthGdepth: p.depthGdepth ?? null,
    phashHex: p.phashHex ?? null,
  });
  const resourcesJson = resources.length > 0
    ? JSON.stringify(resources.map((r) => ({
        identifier: r.identifier,
        contentType: r.contentType,
        dataBase64: bytesToBase64(r.bytes),
      })))
    : null;
  const signer = {
    kind: 'secure-enclave' as const,
    certificateChainPEM: p.certChainDer.map(derToPem).join(''),
    keyTag: p.enclaveKeyTag ?? undefined,
    useHeldBioContext: p.heldBioContext ?? false,
  };
  // the witness pool, in order. tsaUrls supersedes tsaUrl; an
  // empty/absent pool is an honestly untimed sign, not a retry case.
  const tsaUrls = p.tsaUrls ?? (p.tsaUrl ? [p.tsaUrl] : []);
  if (tsaUrls.length === 0) {
    const result = await sign(bytes, mime, { manifestJSON, resourcesJson, signer, tsaUrl: null });
    return { ...result, untimedTsaRetry: false, tsaError: null, tsaWitness: null };
  }
  // Each witness's failure text, verbatim, in the order tried — the
  // untimed-retry diagnostic carries all of them, not just the last.
  const tsaFailures: string[] = [];
  for (const url of tsaUrls) {
    try {
      const result = await sign(bytes, mime, { manifestJSON, resourcesJson, signer, tsaUrl: url });
      return { ...result, untimedTsaRetry: false, tsaError: null, tsaWitness: url };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // 'TSA relay' — the loopback relay names itself in the error it
      // appends (TsaLoopbackRelay.lastError), so a relay-side failure
      // (listener, forward hop, upstream non-200) classifies here too.
      const tsaUnreachable =
        message.includes('http resolver') || message.includes('error sending request') || message.includes('TSA relay');
      if (!tsaUnreachable) throw e; // a signing/manifest failure — never reclassify
      tsaFailures.push(`${url}: ${message}`);
    }
  }
  // Every configured witness failed TSA-class — seal untimed on the single
  // permitted retry, with each witness's reason preserved.
  const result = await sign(bytes, mime, { manifestJSON, resourcesJson, signer, tsaUrl: null });
  return { ...result, untimedTsaRetry: true, tsaError: tsaFailures.join(' | '), tsaWitness: null };
}