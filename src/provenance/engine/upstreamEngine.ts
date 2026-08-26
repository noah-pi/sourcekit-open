// Source Kit 0.1.0 — wraps the official C2PA reader
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Wraps the official C2PA reader and returns a normalized result. No verdicts
 * here; policyLayer.ts composes those.
 *
 * Binding: @contentauth/c2pa-node (napi over c2pa-rs) requires node >= 22, and
 * the staged harness and CI run node 20, so this module falls back to
 * @contentauth/c2pa-wasm, the same c2pa-rs core compiled to wasm and pinned
 * exactly. `engine` in the result says which one ran.
 *
 * Node gaps in the wasm build shimmed here:
 *   - wasm-bindgen glue uses FileReaderSync (a Web Worker API) to read Blobs.
 *     The polyfill is backed by a WeakMap; every Blob handed to the engine
 *     comes from blobFrom below, and a foreign Blob throws.
 *   - Engine settings are process-global (c2pa-rs settings model), loaded once
 *     per process from the first call's options; changing trust material
 *     mid-process is rejected (see initSettings).
 *
 * Offline invariant: remote manifest fetch and OCSP are disabled in the loaded
 * settings. Trust material is only what the caller pins.
 */

import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Normalized result shape, shared by both engines. Minimum fields: manifests,
// activeClaim, validationStatus, signerChain, trustListHit, rawErrors. The rest
// are the facts policyLayer needs to compose verdicts.
// ---------------------------------------------------------------------------

/** Which C2PA trust list the signer chained to, as far as this run knows. */
export type TrustListHit =
  | 'official'  // chained to anchors the caller pinned as the official C2PA Trust List
  | 'interim'   // chained to anchors the caller pinned as the frozen ITL (2026-01-01)
  | 'none'      // trust was evaluated against pinned anchors; signer is on neither list
  | 'unknown';  // trust not evaluated against caller-pinned anchors

export type EngineId = 'upstream-c2pa-node' | 'upstream-c2pa-wasm' | 'handrolled' | 'unavailable';

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
  /** False when the engine package could not load; rawErrors says why. */
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
  /** Engine-specific raw output (VerificationReport for handrolled; store JSON for upstream). */
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
// Engine loading: dynamic and optional; the result reports what loaded.
// ---------------------------------------------------------------------------

const C2PA_NODE_VERSION = '0.8.1';   // pinned target; node>=22 only
const C2PA_WASM_VERSION = '0.11.1';  // pinned fallback; node 20 harness

interface WasmBindings {
  initSync: (m: { module: Uint8Array }) => unknown;
  WasmReader: {
    fromBlob: (format: string, blob: Blob, context?: string | null) => Promise<{ json: () => string }>;
  };
  loadSettings?: (settings: string) => void;
}

let wasmBindings: WasmBindings | null = null;
let wasmLoadError: string | null = null;
let settingsLoaded = false;
let settingsFingerprint: string | null = null;

/** Blobs the engine will read, with their bytes tracked for the polyfill. */
const trackedBlobs = new WeakMap<Blob, Uint8Array>();

export function blobFrom(bytes: Uint8Array): Blob {
  const b = new Blob([bytes as unknown as BlobPart]);
  trackedBlobs.set(b, bytes);
  return b;
}

function installNodePolyfills(): void {
  // FileReaderSync exists only in Web Workers; c2pa-wasm's glue calls it to
  // read Blobs synchronously. This polyfill reads the tracked bytes and throws
  // on an untracked Blob rather than returning wrong bytes.
  const g = globalThis as Record<string, unknown>;
  if (typeof g.FileReaderSync === 'undefined') {
    g.FileReaderSync = class {
      readAsArrayBuffer(blob: Blob): ArrayBuffer {
        const b = trackedBlobs.get(blob);
        if (!b) throw new Error('c2pa-wasm FileReaderSync polyfill: untracked Blob (use blobFrom())');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      }
    };
  }
}

/**
 * Import an optional engine package by name, robustly across runtimes.
 * Bare dynamic imports break when a bundler/transpiler re-homes this module
 * (tsx compiles out-of-package files into data: URLs, where bare specifiers
 * cannot resolve). Resolving to a file URL first via createRequire works
 * everywhere the package is installed.
 */
async function importOptionalPackage(spec: string): Promise<unknown> {
  const { pathToFileURL } = await import('node:url');
  // Resolution bases, in order: this module's own location (staged harness,
  // where node_modules sits at the package root), then the process cwd (the
  // desk CLI, whose node_modules holds the pinned engine while this file lives
  // outside the desk package, so walk-up from here does not find it).
  const bases = [import.meta.url, pathToFileURL(process.cwd() + '/').href];
  let lastErr: unknown;
  for (const base of bases) {
    try {
      const req = createRequire(base);
      const entry = req.resolve(spec);
      return await import(pathToFileURL(entry).href);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/** Load the upstream engine. Prefers c2pa-node on node>=22; wasm otherwise. */
async function loadEngine(): Promise<{ id: EngineId; version: string; wasm?: WasmBindings; nodeReader?: unknown }> {
  const nodeMajor = typeof process !== 'undefined' && process.versions?.node
    ? Number(process.versions.node.split('.')[0]) : 0;
  if (nodeMajor >= 22) {
    try {
      // Specifier built at runtime: c2pa-node is an optional binding absent on
      // node<22 harnesses, where a static import would break typecheck and
      // bundlers.
      const mod = (await importOptionalPackage('@contentauth/c2pa-node')) as Record<string, unknown>;
      return { id: 'upstream-c2pa-node', version: C2PA_NODE_VERSION, nodeReader: mod };
    } catch {
      // Fall through to wasm; the fallback is a supported configuration and is
      // disclosed via the returned engine id.
    }
  }
  if (wasmBindings) return { id: 'upstream-c2pa-wasm', version: C2PA_WASM_VERSION, wasm: wasmBindings };
  if (wasmLoadError) throw new Error(wasmLoadError);
  try {
    installNodePolyfills();
    const mod = (await importOptionalPackage('@contentauth/c2pa-wasm')) as WasmBindings & { default?: unknown };
    // wasm-bindgen needs the module bytes explicitly in Node (no fetch of a
    // relative .wasm URL). Resolve the pinned package's wasm asset with the
    // same base fallback as the package import.
    const { pathToFileURL } = await import('node:url');
    const fs = await import('node:fs');
    let wasmBytes: Uint8Array | null = null;
    for (const base of [import.meta.url, pathToFileURL(process.cwd() + '/').href]) {
      try {
        const wasmPath = createRequire(base).resolve('@contentauth/c2pa-wasm/c2pa.wasm');
        wasmBytes = new Uint8Array(fs.readFileSync(wasmPath));
        break;
      } catch { /* try the next base */ }
    }
    if (!wasmBytes) throw new Error('could not locate @contentauth/c2pa-wasm/c2pa.wasm from any resolution base');
    mod.initSync({ module: wasmBytes });
    wasmBindings = mod;
    return { id: 'upstream-c2pa-wasm', version: C2PA_WASM_VERSION, wasm: mod };
  } catch (e) {
    wasmLoadError = `upstream engine unavailable: @contentauth/c2pa-wasm@${C2PA_WASM_VERSION} could not load (${e instanceof Error ? e.message : e})`;
    throw new Error(wasmLoadError);
  }
}

/**
 * Engine settings are process-global in c2pa-rs: load once, then pin. Offline
 * by construction (no remote manifest fetch, no OCSP), and trust anchors are
 * only what the caller supplies.
 */
function initSettings(mod: WasmBindings | Record<string, unknown>, opts?: UpstreamReadOptions): void {
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
  const load = (mod as WasmBindings).loadSettings;
  if (typeof load === 'function') load(fp);
  settingsLoaded = true;
  settingsFingerprint = fp;
}

// ---------------------------------------------------------------------------
// Container sniffing: the photo flow accepts JPEG/PNG, the video flow BMFF.
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
// verdict mapping that consumes them is in policyLayer.ts.
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
 *   1. Positive tamper signals first: any message asserting a signature or hash
 *      mismatch is a failed-rung fact, and loose substring classes below would
 *      route it to unsupported or no-attestation instead.
 *   2. Absence classes (noManifest), exact-ish engine variant names only.
 *   3. Unsupported classes, kept narrow: bare 'algorithm' and 'merkle'
 *      substrings do not qualify.
 *   4. Unreadable: container or parse failure, not a claim decode failure,
 *      which is a tampered-manifest fact.
 *   5. Everything else fails closed: manifestFound with signatureValid=false.
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
// Normalization of the upstream store JSON.
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

/** Blank normalized result, shared by both engine adapters. */
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

/**
 * Read an asset with the upstream engine and normalize. `flow` mirrors the
 * handrolled entry points: 'photo' accepts JPEG/PNG, 'video' accepts BMFF. A
 * wrong container is reported as containerRejected for the policy layer.
 */
export async function readUpstreamAsset(
  bytes: Uint8Array,
  flow: 'photo' | 'video',
  opts?: UpstreamReadOptions,
): Promise<NormalizedEngineResult> {
  let engine: { id: EngineId; version: string; wasm?: WasmBindings; nodeReader?: unknown };
  try {
    engine = await loadEngine();
  } catch (e) {
    const r = baseResultLike('unavailable', 'none');
    r.engineAvailable = false;
    r.unsupported = true;
    r.unsupportedReason = e instanceof Error ? e.message : String(e);
    r.rawErrors.push(r.unsupportedReason);
    return r;
  }
  const r = baseResultLike(engine.id, engine.version);

  const container = sniffContainer(bytes);
  if (flow === 'photo' && container !== 'jpeg' && container !== 'png') {
    r.containerRejected = 'NOT_JPEG';
    return r;
  }
  if (flow === 'video' && !(container === 'bmff-mp4' || container === 'bmff-mov' || container === 'bmff-m4a')) {
    r.containerRejected = 'NOT_BMFF';
    return r;
  }
  if (container === 'unknown') {
    r.containerRejected = flow === 'photo' ? 'NOT_JPEG' : 'NOT_BMFF';
    return r;
  }

  let storeJson: string;
  try {
    if (engine.id === 'upstream-c2pa-node' && engine.nodeReader) {
      // node>=22 path: Reader.fromAsset(buffer | {format, buffer}).
      const mod = engine.nodeReader as { Reader?: { fromAsset: (asset: unknown) => Promise<{ json: () => string } | { json: () => string }> } };
      initSettings(mod, opts);
      // Buffer is Node-only; under Hermes this branch does not run, since the
      // iOS native engine serves the device.
      const buf = typeof Buffer !== 'undefined' ? Buffer.from(bytes) : bytes;
      const reader = await mod.Reader!.fromAsset({ format: mimeFor(container), buffer: buf });
      storeJson = reader.json();
    } else {
      const wasm = engine.wasm!;
      initSettings(wasm, opts);
      const reader = await wasm.WasmReader.fromBlob(mimeFor(container), blobFrom(bytes));
      storeJson = reader.json();
    }
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
    // Fail closed on unknown failure classes: an unrecognized failure becomes a
    // signature-invalid fact and rawErrors keeps it. Runs even when
    // `unsupported` is set, since the policy layer ranks a positive tamper fact
    // above the decline-to-evaluate tri-state.
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
    // No caller-pinned anchors: the engine may still report
    // signingCredential.untrusted against its built-in list, but that cannot be
    // attributed to the official TL versus the frozen ITL, so nothing is
    // claimed. The report must name which list a verdict used.
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

/** Pinned versions this module targets; recorded in reports and lockfiles. */
export const UPSTREAM_ENGINE_PINS = {
  c2paNode: C2PA_NODE_VERSION,
  c2paNodeRequires: 'node>=22',
  c2paWasm: C2PA_WASM_VERSION,
  c2paWasmFallbackReason: 'staged harness and CI run node 20; c2pa-node declares engines node>=22 (documented fallback)',
} as const;
