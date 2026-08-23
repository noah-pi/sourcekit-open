// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * IOS binding (
 * §2/§7a). Wraps the native module `modules/c2pa-ios` (c2pa-swift v0.0.12,
 * C2PAC.xcframework, iOS 16+) and returns the SAME NORMALIZED result shape
 * as the desk engine (src/provenance/engine/upstreamEngine.ts),
 * so the shared policy layer (policyLayer.ts — THE verdict authority) is fed
 * identical facts on device and on desk. NO VERDICTS HERE — normalization
 * only.
 *
 * Normalization code (status-code classes, thrown-error classifier, store
 * JSON summarization, container gate) is deliberately VERBATIM from the desk
 * engine — the two engines must sort engine output into facts identically,
 * or the differential oracle's agreement claim is meaningless. The only
 * parts replaced are the runtime-specific ones: package loading (→ native
 * module), Blob/FileReaderSync shims (→ temp-file staging via
 * expo-file-system), and the engine call itself.
 *
 * Offline invariant: remote manifest fetch and OCSP are disabled in the
 * loaded settings; no TSA URL is ever used by the sign path. Trust material
 * is only what the caller pins.
 */

import { Platform } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';
import * as FileSystem from 'expo-file-system/legacy';
import { base64ToBytes, bytesToBase64 } from '../../lib/bytes';

// ---------------------------------------------------------------------------
// Normalized result shape — IDENTICAL to the desk engine's.
// policyLayer.ts consumes this and only this.
// ---------------------------------------------------------------------------

/** Which C2PA trust list the signer chained to, as far as THIS run knows. */
export type TrustListHit =
  | 'official'  // chained to anchors the caller pinned as the official C2PA Trust List
  | 'interim'   // chained to anchors the caller pinned as the frozen ITL (2026-01-01)
  | 'none'      // trust WAS evaluated against pinned anchors; signer is on neither list
  | 'unknown';  // trust not evaluated against caller-pinned anchors — never claimed

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
  /** False when the engine could not run at all — rawErrors says why. */
  engineAvailable: boolean;
  /** Container gate facts: the caller's flow rejected this container. */
  containerRejected: 'NOT_JPEG' | 'NOT_BMFF' | null;
  manifestFound: boolean;
  manifests: EngineManifestSummary[];
 /** The active (most recent) manifest's claim summary — the active claim. */
  activeClaim: EngineManifestSummary | null;
  validationStatus: EngineStatus[];
  // --- verdict facts (never verdicts) -------------------------------
  signatureValid: boolean | null;
  claimAssertionsMatch: boolean | null;
  assetHashMatches: boolean | null;
  /** 'void-binding' = the signed claim honors no usable binding → integrity UNPROVEN. */
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

/** Trust material the caller pins for THIS run (offline; never fetched). */
export interface EngineTrustOptions {
  /** PEM anchor bundle. `kind` declares which list the caller says this is. */
  anchorsPem: string;
  kind: 'official' | 'interim';
}

export interface UpstreamReadOptions {
  trust?: EngineTrustOptions;
}

// ---------------------------------------------------------------------------
// Native module loading — optional, honest about what loaded.
// ---------------------------------------------------------------------------

/** c2pa-swift package version this binding is written against (pinned, ). */
const C2PA_SWIFT_VERSION = '0.0.12';

interface C2paIosNative {
  /** Upstream c2pa-rs core version string. */
  getVersion(): string;
  /** Process-global c2pa-rs settings (JSON). Pinned once per process — see initSettings. */
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
  ): Promise<string>;
}

let native: C2paIosNative | null = null;
let nativeLoadError: string | null = null;
let nativeCoreVersion: string | null = null;
try {
  if (Platform.OS === 'ios') {
    native = requireNativeModule<C2paIosNative>('C2paIos');
    try {
      nativeCoreVersion = native.getVersion();
    } catch {
      nativeCoreVersion = null; // version string is diagnostic only — never gates the engine
    }
  } else {
    nativeLoadError = 'c2pa-ios native module is iOS-only';
  }
} catch (e) {
  native = null;
  nativeLoadError = e instanceof Error ? e.message : String(e);
}

/** True when the native c2pa-swift binding is present (dev build / TestFlight — never Expo Go). */
export function iosEngineAvailable(): boolean {
  return native !== null;
}

/** Pinned versions this module targets — recorded in reports/lockfiles. */
export const UPSTREAM_IOS_PINS = {
  c2paSwift: C2PA_SWIFT_VERSION,
  c2paSwiftBinaryTarget: 'C2PAC.xcframework',
  c2paSwiftChecksum: 'a038bc316f7a890d1233e156cc743854cee98e24359a6176fb107088359fe0a8',
  coreVersionAtRuntime: nativeCoreVersion ?? 'unknown',
  requires: 'iOS>=16, dev build (not Expo Go)',
} as const;

/**
 * Engine settings are process-global in c2pa-rs — load once, then pin.
 * Offline by construction: no remote manifest fetch, no OCSP. Trust anchors
 * are only what the caller supplies. (Verbatim desk semantics; the native
 * call is Signer.loadSettings.)
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
// Temp-file staging — the native reader works on file paths (and infers the
// container format from the EXTENSION), so bytes are staged to the cache
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
// Container sniffing — the photo flow accepts JPEG/PNG, the video flow BMFF.
// (Verbatim from the desk engine.)
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
// Status-code classes — see policyLayer.ts for the verdict mapping that
// consumes these facts. This section only SORTS engine output into facts.
// (Verbatim from the desk engine.)
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
 * A-1 binding-guard classes: the claim references no usable hard
 * binding, or references one outside/unresolvable — the binding is VOID
 * (integrity unproven, defective credentials), never proven tamper.
 */
const VOID_BINDING_CODES = new Set([
  'assertion.undeclared', 'assertion.missing', 'assertion.outsideManifest',
]);
/** Structure classes this policy declines to evaluate — the UNSUPPORTED tri-state. */
const UNSUPPORTED_CODES = new Set([
  'algorithm.unsupported', 'assertion.bmffHash.malformed', 'assertion.boxesHash.unknownBox',
]);
/** Informational trust codes — inputs to OUR trust tiers, never verdict failures. */
const TRUST_INFO_CODES = new Set([
  'signingCredential.untrusted', 'signingCredential.trusted', 'timeStamp.untrusted', 'timeStamp.trusted',
]);

/**
 * Ordered thrown-error classification chain:
 * thrown messages are free text — an unstable engine API surface — so the
 * order is load-bearing and documented:
 *
 *   1. POSITIVE TAMPER SIGNALS FIRST. Any message asserting a signature or
 *      hash MISMATCH is a failed-rung fact and must NOT be captured by the
 *      neutral classes below.
 *   2. Absence classes (noManifest), exact-ish engine variant names only.
 *   3. UNSUPPORTED classes — deliberately NARROW.
 *   4. UNREADABLE (container/parse failure, never a claim decode failure).
 *   5. EVERYTHING ELSE fails CLOSED: manifestFound + signatureValid=false.
 *
 * The native side guarantees the raw c2pa-rs error text reaches this chain
 * (NamedException carries C2PAError.errorDescription =
 * "C2PA API error: <raw message>" — see C2paIosModule.mapError).
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
// Normalization of the upstream store JSON. (Verbatim from the desk engine.)
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

/** Blank normalized result — same shape as both desk engine adapters. */
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
 * string (or throws an engine error), fill in the normalized result. This is
 * the desk engine's post-read logic, verbatim — store shape, code sorting,
 * fail-closed on unknown failure classes, and trust inputs are identical.
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
      // Manifest present but undecodable — tampered-manifest fact.
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

  // --- trust inputs (never verdicts) ---
  if (opts?.trust) {
    const trusted = statuses.some((s) => s.code === 'signingCredential.trusted') || state === 'Trusted';
    const untrusted = statuses.some((s) => s.code === 'signingCredential.untrusted');
    r.trustListHit = trusted ? opts.trust.kind : untrusted ? 'none' : 'unknown';
  } else {
    // No caller-pinned anchors: we cannot attribute an engine trust report
    // to the official TL vs the frozen ITL — so we claim nothing
 // (disclose WHICH list a verdict used).
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

/** Container gate shared by verify and readIosAsset (verbatim desk rule). */
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
 * PRIMARY READ PATH — verify an asset's embedded C2PA manifest and return
 * the normalized result for the policy layer. `mime` must be the asset's
 * real MIME type (image/jpeg, image/png, video/mp4, video/quicktime,
 * audio/mp4); it selects the flow's container gate exactly as the desk
 * engine's photo/video flows do.
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
      // Unrecognized caller MIME: derive the flow from the bytes themselves —
      // the gate then rejects honestly instead of trusting a wrong label.
      : sniffContainer(bytes) === 'jpeg' || sniffContainer(bytes) === 'png' ? 'photo' : 'video';
  return readIosAsset(bytes, flow, opts);
}

/**
 * Read an asset with the upstream iOS engine and normalize. `flow` mirrors
 * the desk entry points: 'photo' accepts JPEG/PNG, 'video' accepts BMFF —
 * a wrong container is a FACT (containerRejected) for the policy layer.
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
 * DETACHED path — validate a sidecar manifest (application/c2pa bytes)
 * against its asset (; the app's existing detached.ts
 * flow). Same normalized result as the embedded path.
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
// SIGN — embed a signed manifest. Second-priority deliverable: the native
// APIs are verified against c2pa-swift v0.0.12 source, but no compiler
// exists on this desk — EAS is the compiler, and the first signed artifact
// must round-trip through verify on device before this path is trusted
// for captures. Certificate issuance for the Secure Enclave key is the
// app's existing identity flow — this module NEVER mints certificates.
// ---------------------------------------------------------------------------

/** The app's standard Secure Enclave signing key (modules/secure-enclave). */
export const DEFAULT_ENCLAVE_KEY_TAG = 'com.verify.camera.signing-key';

export type IosSigner =
  | {
      kind: 'pem';
      certificatePEM: string;
      privateKeyPEM: string;
      /** es256/es384/es512/ps256/ps384/ps512/ed25519 — default es256. */
      algorithm?: string;
    }
  | {
      kind: 'secure-enclave';
      /** Chain whose LEAF public key corresponds to the enclave key (caller-supplied). */
      certificateChainPEM: string;
      /** Keychain tag of the enclave key; created by c2pa-swift if absent. */
      keyTag?: string;
      /** Biometric-bound key: per-use Face ID/Touch ID (new keys only). */
      requireBiometric?: boolean;
    };

export interface IosSignOptions {
  /** C2PA manifest definition JSON (claim_generator, title, format, assertions…). */
  manifestJSON: string;
  signer: IosSigner;
}

export interface IosSignResult {
  /** The signed asset (manifest embedded). */
  signedBytes: Uint8Array;
  /** Embedded manifest bytes as returned by the builder (may be empty). */
  manifestBytes: Uint8Array | null;
}

/**
 * Sign `bytes` (JPEG/PNG/MP4/MOV/M4A per `mime`) with a C2PA manifest.
 * Offline: no TSA. Throws on any engine error — signing failures are never
 * swallowed (a half-signed artifact is worse than none).
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
