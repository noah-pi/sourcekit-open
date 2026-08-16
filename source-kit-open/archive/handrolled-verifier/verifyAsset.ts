/**
 * Verification pipeline — the desk editor's path.
 *
 *   photo:  extract embedded manifest (APP11) → verify COSE signature →
 *           recompute hash.data binding → verdict
 *   video:  extract embedded manifest (uuid box) → verify COSE signature →
 *           recompute c2pa.hash.bmff.v2 binding → verdict
 *   legacy: sidecar JSON + media file → re-hash → compare → verify → verdict
 *
 * Every failure mode is a distinct, plainly-worded verdict. Nothing here
 * ever "upgrades" uncertainty into confidence.
 */

import { extractManifest, stripManifest, isJpeg } from './jpegApp11';
import { recordFromManifestBytes } from '../../src/provenance/manifest';
import { extractC2paStore, parseManifest, parseManifestChain, verifyManifest, timestampMessageForSignature, bstr } from './c2pa';
import { extractC2paStoreBmff, stripC2paFromBmff, isBmff, BmffUnsupported } from './bmff';
import { isPng, extractCaBx, stripCaBx } from './png';
import { verifyRecordSignature } from '../../src/lib/sign';
import type { PqLayerCheck } from '../../src/lib/pq';
import { isValidTip } from '../../src/lib/beacon';
import { sha256Hex } from '../../src/lib/sign';
import { isAttestationRecord, type AttestationRecord } from '../../src/provenance/manifest';
import type { SignerTrust } from '../../src/lib/trustProvider';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '../../src/lib/bytes';
import { parseCertificate, verifyChain } from '../../src/lib/x509';
import { verifyTimestampToken } from '../../src/lib/rfc3161';
import { pinnedTsaFor } from '../../src/lib/tsaTrustList';
import { verifyAppAttestAssertion, type AppAttestVerification } from './verifyAppAttest';

export type VerdictCode =
  | 'INTACT'             // signature valid + bytes identical to what was signed
  | 'CONTENT_MODIFIED'   // signature valid, but the media changed after signing
  | 'SIGNATURE_INVALID'  // the manifest itself was tampered with
  | 'NO_ATTESTATION'     // no Exhibit A manifest found
  | 'NOT_JPEG'           // embedded photo flow only supports JPEG
  | 'NOT_BMFF'           // embedded video flow only supports MP4/MOV
  | 'UNSUPPORTED'        // manifest present, but uses structures this build can't check (e.g. merkle aux boxes)
  | 'UNREADABLE';        // corrupt file / parse failure

export interface VerificationReport {
  verdict: VerdictCode;
  record: AttestationRecord | null;
  /** Present when a C2PA manifest was found and checked. */
  c2pa?: {
    generator: string | null;
    alg: string | null;
    claimAssertionsMatch: boolean;
    /** True when the embedded telemetry is an Exhibit A record from this ecosystem. */
    hasVerifyTelemetry: boolean;
    /** Why the asset hash failed, when it did — 'void-binding' means the
        declared exclusions exempt the hash input (integrity UNPROVEN, not
        proven tamper). Surfaced so verdict surfaces can say it precisely. */
    assetHashFailure: 'mismatch' | 'void-binding' | null;
    /** SHA-256 of the signing key, hex — the signer's public identity. */
    signerFingerprint: string | null;
    /**
     * Mechanical verification of the COSE x5chain (signatures, name chaining,
     * CA flags, validity at verified signing time). The top of the chain is
     * always self-asserted here — a valid chain proves structure, not that
     * the named org actually vouches for this key.
     */
    certChain: {
      length: number;
      linksValid: boolean;
      reason: string | null;
      topSubject: string | null;
    } | null;
    /** Real, offline App Attest verification — never a presence check. */
    appAttest: AppAttestVerification;
    /**
     * PQ dual-signature layer — claim-level and record-level
     * checks, each null when the capture carries no PQ layer. Software-key
     * custody: this layer hedges a future P-256 break; it is never a second
     * hardware anchor and must be labeled as such wherever it is displayed.
     */
    pq: { claim: PqLayerCheck | null; record: PqLayerCheck | null };
    timestamps: {
      /** Tokens embedded (witness count claimed). */
      present: number;
      /** Tokens that passed full cryptographic verification. */
      valid: number;
      /**
       * Valid tokens whose authority is on the pinned TSA trust list
       * (src/lib/tsaTrustList.ts). ONLY these anchor verified time for
       * roster-membership and certificate-validity evaluation — an
       * unpinned TSA's genTime is self-asserted by an unvetted operator.
       */
      trusted: number;
      /** Display names of the pinned authorities that countersigned. */
      trustedNames: string[];
      /** Earliest genTime among VALID tokens (any authority, pinned or not). */
      earliestValidUtc: string | null;
      /** Earliest genTime among TRUSTED tokens — null when no pinned TSA countersigned. */
      earliestTrustedUtc: string | null;
      tsaNames: string[];
      /** Why each invalid token failed. */
      failures: string[];
    };
  };
  /** Present when a record was found — details for the UI. */
  checks: {
    manifestFound: boolean;
    signatureValid: boolean | null;
    fingerprintMatches: boolean | null;
    assetHashMatches: boolean | null;
    recomputedSha256: string | null;
  };
  /** Every check actually performed — the verbose panel shows both lists. */
  checksPerformed: string[];
  /** Every check NOT performed, with the reason — absence of a check is itself disclosed. */
  checksNotPerformed: string[];
  /**
   * Trust axis: WHO vouches for the signing key,
   * resolved through anchors OUTSIDE the file — part of the DATA MODEL,
   * not a switch statement in a React component. A desk scripting against
   * verifyPhotoBytes sees the same 'unknown' the UI renders amber.
   * null/undefined = NOT RESOLVED (no resolver supplied) — disclosed in
   * checksNotPerformed, never silently green.
   */
  signerTrust?: SignerTrust | null;
}

/**
 * Optional anchors for the trust axis. The resolver is injected because
 * anchor storage differs by host (app keychain, desk localStorage, a
 * script's own files) — the verifier must not import any of them.
 */
export interface VerifyOptions {
  trustResolver?: (input: {
    fingerprint: string;
    verifiedAtMs: number | null;
    orgChain: { linksValid: boolean; topSubject: string | null; issuer: string | null } | null;
  }) => Promise<SignerTrust> | SignerTrust;
}

const noChecks = {
  manifestFound: false,
  signatureValid: null,
  fingerprintMatches: null,
  assetHashMatches: null,
  recomputedSha256: null,
};

/** Every report carries both lists — even a bare one. */
const NO_EXTRAS = { checksPerformed: [] as string[], checksNotPerformed: [] as string[] };

export async function verifyPhotoBytes(bytes: Uint8Array, opts?: VerifyOptions): Promise<VerificationReport> {
  // PNG path — the manifest rides in a caBX chunk before IEND, hard-bound by
  // the same c2pa.hash.data byte-exclusion the JPEG path uses.
  if (isPng(bytes)) {
    const caBx = extractCaBx(bytes);
    if (!caBx) {
      return { verdict: 'NO_ATTESTATION', record: null, checks: { ...noChecks }, ...NO_EXTRAS };
    }
    const manifest = parseManifest(caBx.store);
    if (!manifest) {
      return { verdict: 'SIGNATURE_INVALID', record: null, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
    }
    return c2paReport(bytes, manifest, caBx.store, () => sha256Hex(stripCaBx(bytes)), { start: caBx.chunkStart, length: caBx.chunkLength }, opts);
  }

  if (!isJpeg(bytes)) {
    return { verdict: 'NOT_JPEG', record: null, checks: { ...noChecks }, ...NO_EXTRAS };
  }

  // 1. Genuine C2PA path — what our camera embeds now, and what any
  //    third-party C2PA signer produces.
  const c2paStore = extractC2paStore(bytes);
  if (c2paStore) {
    const manifest = parseManifest(c2paStore.payload);
    if (!manifest) {
      return { verdict: 'SIGNATURE_INVALID', record: null, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
    }
    return c2paReport(bytes, manifest, c2paStore.payload, () => sha256Hex(stripManifest(bytes)), { start: c2paStore.segmentStart, length: c2paStore.segmentLength }, opts);
  }

  // 2. Legacy Exhibit A manifests (photos signed by pre-C2PA builds).
  const manifestBytes = extractManifest(bytes);
  if (!manifestBytes) {
    return { verdict: 'NO_ATTESTATION', record: null, checks: { ...noChecks }, ...NO_EXTRAS };
  }

  const record = recordFromManifestBytes(manifestBytes);
  if (!record || !isAttestationRecord(record)) {
    return { verdict: 'SIGNATURE_INVALID', record: null, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
  }

  const rec = verifyRecordSignature(record);
  const { signatureValid, fingerprintMatches } = rec;

  let recomputed: string;
  try {
    recomputed = sha256Hex(stripManifest(bytes));
  } catch {
    return { verdict: 'UNREADABLE', record, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
  }
  const assetHashMatches = recomputed === record.asset.sha256;

  let verdict: VerdictCode;
  if (!signatureValid) verdict = 'SIGNATURE_INVALID';
  else if (!assetHashMatches) verdict = 'CONTENT_MODIFIED';
  else verdict = 'INTACT';

  // Trust axis on the legacy path too — legacy records
  // carry a signer fingerprint; a supplied resolver gets its say.
  let legacyTrust: SignerTrust | null = null;
  const legacyNotPerformed = [
    'signer identity — legacy manifests carry no chain to evaluate; the signing key is self-asserted',
    'trusted time — legacy manifests carry no RFC 3161 countersignature',
  ];
  if (opts?.trustResolver && record.signer?.fingerprint) {
    try {
      legacyTrust = await opts.trustResolver({
        fingerprint: record.signer.fingerprint, verifiedAtMs: null, orgChain: null,
      });
    } catch {
      legacyNotPerformed.push('signer trust resolution FAILED (resolver threw) — signer unresolved');
    }
  } else if (!opts?.trustResolver) {
    legacyNotPerformed.push('signer trust — no resolver supplied by the caller; who vouches for this key is UNRESOLVED');
  }

  return {
    verdict,
    record,
    checks: {
      manifestFound: true,
      signatureValid,
      fingerprintMatches,
      assetHashMatches,
      recomputedSha256: recomputed,
    },
    checksPerformed: [
      'record signature verified against the embedded public key',
      'media re-hashed and compared to the signed hash',
      ...pqPerformedLines(rec.pq),
    ],
    checksNotPerformed: legacyNotPerformed,
    signerTrust: legacyTrust,
  };
}

/** One honest line for a record-level PQ layer, in any path that has one. */
function pqPerformedLines(pq: PqLayerCheck | null): string[] {
  if (!pq) return [];
  if (pq.present && pq.signatureValid) {
    return ['post-quantum layer verified on the record (ML-DSA-65, SOFTWARE key — hedges a future P-256 break; NOT a hardware anchor)'];
  }
  if (pq.present) {
    return ['post-quantum layer on the record FAILED — the classical layer still stands; the PQ layer proves nothing here'];
  }
  return ['post-quantum layer STRIPPED from the record: a PQ key is committed inside the signed payload but the PQ signature is missing — the file was altered after signing'];
}

/**
 * Video path — the same genuine C2PA verification over MP4/MOV containers:
 * the manifest lives in a uuid box, the hard binding is c2pa.hash.bmff.v2.
 * Videos without an embedded manifest report NO_ATTESTATION so the caller
 * can offer the sidecar flow.
 */
export async function verifyVideoBytes(bytes: Uint8Array, opts?: VerifyOptions): Promise<VerificationReport> {
  if (!isBmff(bytes)) {
    return { verdict: 'NOT_BMFF', record: null, checks: { ...noChecks }, ...NO_EXTRAS };
  }

  let store: ReturnType<typeof extractC2paStoreBmff>;
  try {
    store = extractC2paStoreBmff(bytes);
  } catch (e) {
    // A manifest is present but uses structures this build cannot check
    // (e.g. merkle aux boxes). "Unsupported" is the true statement —
    // "signature invalid" would condemn credentials we never evaluated.
    // The file is not condemned; it is unchecked here.
    if (e instanceof BmffUnsupported) {
      return {
        verdict: 'UNSUPPORTED', record: null,
        checks: { ...noChecks, manifestFound: true },
        checksPerformed: [],
        checksNotPerformed: [`everything — the manifest uses a structure this build cannot verify (${e.message}). Not a broken file, not tamper: unchecked.`],
      };
    }
    return { verdict: 'SIGNATURE_INVALID', record: null, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
  }
  if (!store) {
    return { verdict: 'NO_ATTESTATION', record: null, checks: { ...noChecks }, ...NO_EXTRAS };
  }

  const manifest = parseManifest(store.payload);
  if (!manifest) {
    return { verdict: 'SIGNATURE_INVALID', record: null, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
  }
  return c2paReport(bytes, manifest, store.payload, () => sha256Hex(stripC2paFromBmff(bytes)), { start: store.boxStart, length: store.boxSize }, opts);
}

/** Shared C2PA report assembly for the JPEG, PNG and BMFF embedded paths. */
async function c2paReport(
  bytes: Uint8Array,
  manifest: NonNullable<ReturnType<typeof parseManifest>>,
  storePayload: Uint8Array,
  recomputeClean: () => string,
  manifestRange: { start: number; length: number },
  opts?: VerifyOptions
): Promise<VerificationReport> {
  const result = verifyManifest(bytes, manifest, manifestRange);
  const performed: string[] = [
    'COSE signature over the claim verified',
    ...(result.assetHashFailure === 'void-binding' && !manifest.hashData && !manifest.hashBmff
      ? ['no signed hard-binding assertion — the signature is genuine but commits to no media bytes']
      : [`${manifest.hashBmff ? 'c2pa.hash.bmff.v2' : 'c2pa.hash.data'} hard binding recomputed over the file bytes`]),
    'assertion hashes cross-checked against the signed claim',
  ];
  if (result.assetHashFailure === 'void-binding') {
    performed.push(
      'asset hash binding is VOID: the declared exclusions exempt the hash input itself ' +
      '(the whole file, the media boxes, or not the manifest’s own range), the exclusion set is ' +
      'malformed, or the signed claim references no hard-binding assertion — the credentials commit ' +
      'to nothing, so integrity is UNPROVEN. This is defective credentials, not proven tamper.'
    );
  }
  const notPerformed: string[] = [];

  // Our own media carries the full Exhibit A record as the telemetry assertion.
  const telemetryRecord =
    manifest.telemetry && isAttestationRecord(manifest.telemetry) ? manifest.telemetry : null;
  // Defense in depth: the inner record carries its own ECDSA signature.
  const inner = telemetryRecord ? verifyRecordSignature(telemetryRecord) : null;
  if (inner) performed.push('inner Exhibit A record signature verified (defense in depth)');

  // --- Post-quantum dual signature. ---
  // Two layers, two custodies — always labeled. A PQ FAILURE never flips the
  // verdict by itself (the classical layer is load-bearing today, and letting
  // PQ tampering flip INTACT to red would make the layer a downgrade attack
  // vector) — but tampering is reported loudly, and a stripped layer is
  // detectable because the committed key cannot leave the signed payload.
  const claimPq = result.pq;
  const recordPq = inner?.pq ?? null;
  if (!claimPq && !recordPq) {
    notPerformed.push(
      'post-quantum layer — none carried (capture predates 0.10.0, or a de-identified copy: deID omits the PQ layer by design, since the device\'s long-lived PQ key would re-link an anonymised copy)',
    );
  } else {
    const pqWhere = (claim: PqLayerCheck | null, record: PqLayerCheck | null): string =>
      [claim?.signatureValid ? 'COSE claim' : null, record?.signatureValid ? 'record' : null].filter(Boolean).join(' + ');
    if (claimPq?.signatureValid || recordPq?.signatureValid) {
      performed.push(
        `post-quantum layer verified on the ${pqWhere(claimPq, recordPq)} (ML-DSA-65, SOFTWARE key — hedges a future P-256 break; NOT a second hardware anchor; key committed inside the signed payload)`,
      );
    }
    if (claimPq && claimPq.present && !claimPq.signatureValid) {
      performed.push(
        'post-quantum layer on the COSE claim FAILED (signature invalid or bound to no committed key) — the classical layer still stands; the PQ layer proves nothing here',
      );
    }
    if (recordPq && recordPq.present && !recordPq.signatureValid) {
      performed.push(
        'post-quantum layer on the inner record FAILED (signature invalid or key fingerprint mismatch) — the classical layer still stands; the PQ layer proves nothing here',
      );
    }
    const strippedClaim = claimPq && !claimPq.present && claimPq.keyCommitted;
    const strippedRecord = recordPq && !recordPq.present && recordPq.keyCommitted;
    if (strippedClaim || strippedRecord) {
      performed.push(
        `post-quantum layer STRIPPED (${[strippedClaim ? 'COSE claim' : null, strippedRecord ? 'record' : null].filter(Boolean).join(' + ')}): a PQ key is committed inside the signed payload but the PQ signature is missing — the commitment cannot be removed without breaking the classical signature, so this file was altered after signing`,
      );
    }
  }
  // The pose trace is signed DATA, not a check: its integrity rides the
  // record signature above. What it shows is for the desk to weigh.
  const poseTrace = telemetryRecord?.context?.poseTrace;
  if (poseTrace) {
    performed.push(
      `signed pose trace present (${poseTrace.samples} samples @ ${poseTrace.hz} Hz: gyro rotation rate, fused attitude, gravity-free acceleration) — integrity covered by the record signature; analysis is a desk-side, human-weighed step`,
    );
  }
  if (manifest.exif) {
    const fields = Object.keys(manifest.exif.data).filter((k) => k !== 'note').length;
    if (manifest.exif.referenced) {
      performed.push(
        `camera EXIF assertion present (${fields} fields: exposure/optics, camera-reported) — signed as self-reported metadata, hash cross-checked against the claim`,
      );
    } else {
      // Box surgery: a com.verify.exif box attached
      // AFTER signing still parses, but the signed claim never references it
      // — its bytes bind to nothing. Never the claim-bound string.
      notPerformed.push(
        `camera EXIF assertion box present (${fields} fields) but NOT referenced by the signed claim — carrying no cryptographic weight (attachable after signing; its contents bind to nothing)`,
      );
    }
  }
  // Bitcoin beacon: a signed TIME LOWER BOUND. The embedded
  // block hash could not have been known before that block was mined, so the
  // signature cannot predate it. The block hash is the objective part; the
  // signer's `observedAt` is its own clock. Never a verdict — shape-checked
  // and disclosed, exactly like the other self-reported signals.
  const beacon = telemetryRecord?.beacon;
  if (beacon) {
    if (isValidTip(beacon.blockHash, beacon.blockHeight)) {
      performed.push(
        `Bitcoin beacon (time lower bound): block #${beacon.blockHeight} (${beacon.blockHash.slice(0, 16)}…) observed via ${beacon.source} — this signature cannot predate that block; pair with the OTS anchor (upper bound) to bracket the signing moment`,
      );
    } else {
      notPerformed.push(
        'the signed Bitcoin beacon is malformed (not a plausible block hash/height) — its time-lower-bound claim is meaningless',
      );
    }
  }

  // --- Trusted time: verify every RFC 3161 token for real. ---
  // The countersigned message covers the bstr-WRAPPED protected header, exactly
  // as it sat in the COSE_Sign1 (c2pa-rs sigtst.rs::cose_countersign_data).
  // parseManifest hands us the UNWRAPPED header (cbor-x strips the bstr tag) —
  // passing it raw shifts the message three bytes and every genuine token fails
  // messageImprint.
  const expectedMessage = timestampMessageForSignature(bstr(manifest.protectedHeader), manifest.signature);
  const tokenResults = manifest.timestampTokens.map((t) => verifyTimestampToken(t, expectedMessage));
  const validTokens = tokenResults.filter((r) => r.tokenValid);
  const earliestValidUtc = validTokens.map((r) => r.genTimeUtc!).sort()[0] ?? null;
  const tsaNames = [...new Set(validTokens.map((r) => r.tsaName).filter((n): n is string => !!n))];
  const failures = tokenResults.filter((r) => !r.tokenValid).map((r) => r.reason ?? 'invalid');
  // Trust pinning: a VALID token still only proves SOME authority countersigned
  // — anyone can run a TSA and mint any genTime. Only tokens from authorities
  // on the pinned TSA trust list anchor verified time below (roster membership,
  // certificate validity); a backdated capture around a revocation would need a
  // self-run TSA, and an unpinned token can no longer pull that off silently.
  const validWithPins = validTokens.map((r) => ({ result: r, pin: pinnedTsaFor(r.tsaFingerprints) }));
  const trustedTokens = validWithPins.filter((d) => d.pin !== null);
  const trustedNames = [...new Set(trustedTokens.map((d) => d.pin!.name))];
  const earliestTrustedUtc = trustedTokens.map((d) => d.result.genTimeUtc!).sort()[0] ?? null;
  if (manifest.timestampTokens.length > 0) {
    performed.push(`RFC 3161 countersignatures: ${validTokens.length}/${manifest.timestampTokens.length} verified (messageImprint ↔ this signature, TSTInfo digest, TSA signature, chain links, validity at genTime)`);
  }
  if (trustedTokens.length > 0) {
    performed.push(`countersigning authority on the pinned TSA trust list: ${trustedNames.join(', ')} — its time anchors identity and validity evaluation`);
  }
  if (validTokens.length > trustedTokens.length) {
    notPerformed.push(
      `${validTokens.length - trustedTokens.length} valid token(s) from UNPINNED authorities — genuine tokens, but the operator is unvetted (anyone can run a timestamp server), so their genTime does not anchor roster or validity checks`,
    );
  }

  // --- Signer key + chain mechanics. ---
  let signerPub: Uint8Array | null = null;
  let signerFingerprint: string | null = null;
  let certChain: { length: number; linksValid: boolean; reason: string | null; topSubject: string | null };
  try {
    const leaf = parseCertificate(manifest.certDer);
    if (leaf.keyAlg.kind === 'ec') {
      signerPub = leaf.keyAlg.point;
      signerFingerprint = bytesToHex(sha256(signerPub));
    }
  } catch { /* unparseable leaf — chain verdict below fails closed */ }
  // "Verified signing time" = pinned-authority time only. An unpinned TSA's
  // genTime is displayed for context but never anchors chain validity,
  // App Attest validity, or roster membership.
  const atMs = earliestTrustedUtc ? Date.parse(earliestTrustedUtc) : null;
  {
    const chain = verifyChain(manifest.certChain, [], atMs);
    certChain = { length: manifest.certChain.length, linksValid: chain.linksValid, reason: chain.reason, topSubject: chain.topSubject };
  }
  // --- Trust axis: who vouches for this key lives
  // in the data model. The UI consumes report.signerTrust; a desk scripting
  // against verifyPhotoBytes gets the same amber. No resolver → disclosed
  // as unresolved, never silently green.
  let signerTrust: SignerTrust | null = null;
  if (signerFingerprint && opts?.trustResolver) {
    try {
      signerTrust = await opts.trustResolver({
        fingerprint: signerFingerprint,
        verifiedAtMs: atMs,
        orgChain: certChain && manifest.certChain.length > 1
          ? { linksValid: certChain.linksValid, topSubject: certChain.topSubject, issuer: null }
          : null,
      });
      performed.push(`signer trust resolved through outside anchors: ${signerTrust.tier}${signerTrust.tier === 'unknown' ? ' (nothing outside the file vouches for this key — the amber is in the data, not just the UI)' : ''}`);
    } catch {
      notPerformed.push('signer trust resolution FAILED (resolver threw) — stated, not hidden; treat the signer as unresolved');
    }
  } else if (signerFingerprint && !opts?.trustResolver) {
    notPerformed.push('signer trust — no resolver supplied by the caller; who vouches for this key is UNRESOLVED (the app supplies one; scripting callers should too)');
  }
  if (manifest.certChain.length > 1 && certChain) {
    if (certChain.linksValid) {
      performed.push(`certificate chain mechanics verified (${certChain.length} certs: signatures, name chaining, CA flags${atMs ? ', validity at verified signing time' : ''})`);
      notPerformed.push('the top of the chain is self-asserted — a valid chain proves structure, not that the named organization vouches for this key; confirm the CA out of band');
    } else {
      performed.push('certificate chain verification FAILED — see warning');
    }
  }
  // --- Org identity assertion: binding ↔ claim and org ↔
  // x5chain-top cross-checks both run inside verifyManifest (the chain top is
  // read from the protected-header order, so the check survives chains that
  // full verification can't order). Four honest outcomes — a cross-check
  // that could not run is reported as unproven, never silently skipped.
  // Identity vouches for key custody, NEVER for truth.
  if (result.identity?.present) {
    const id = result.identity;
    if (!id.telemetryHashMatches) {
      performed.push('org identity assertion FAILED — its telemetry binding reference does not match the claim; the assertion proves nothing here');
    } else if (id.orgMatchesChainTop === true) {
      performed.push(`org identity assertion verified: "${id.org}" countersigned this claim (binding matches the claim's telemetry hash, and the named org matches the chain top subject "${id.chainTopName}") — proves WHICH org credential produced the file, never that its contents are true`);
    } else if (id.orgMatchesChainTop === false) {
      performed.push(`org identity assertion names "${id.org}" but the chain top is "${id.chainTopName}" — MISMATCH, treat the assertion as unproven`);
    } else {
      performed.push(`org identity assertion is bound to this claim, but the org name could not be cross-checked against the certificate chain${id.chainTopName === null ? ' (top certificate unparseable or absent)' : ' (the assertion names no org)'} — treat as unproven`);
    }
    notPerformed.push('identity is not truthfulness: a verified org identity vouches for key custody — the content still stands or falls on the integrity and custody checks above');
  }

  if (atMs === null) {
    notPerformed.push('certificate validity windows not checked (no pinned-authority timestamp to check them against)');
  }

  // --- App Attest: real offline verification, never a presence check. ---
  const appAttest = verifyAppAttestAssertion(manifest.appAttestAssertion, signerPub);
  performed.push(...appAttest.checksPerformed);

  // An update chain carries several manifests. The VERDICT rests on the
  // active (last) one per the C2PA rule, but every earlier manifest is
  // evaluated and reported — never silently skipped. An earlier manifest
  // whose asset hash no longer matches is normal (update chains exist to
  // record edits); one whose signature fails is not.
  if (manifest.manifestCount > 1) {
    performed.push(`store contains ${manifest.manifestCount} manifests — the verdict rests on the active (most recent) one per the C2PA update-chain rule`);
    const chain = parseManifestChain(storePayload);
    if (!chain) {
      notPerformed.push('earlier manifests in this update chain could not be parsed for evaluation');
    } else {
      chain.manifests.forEach((m, i) => {
        if (i === chain.manifests.length - 1) return; // active manifest — fully verified above
        if (!m) {
          performed.push(`update chain: manifest ${i + 1}/${chain.manifests.length} could not be parsed — invalid credentials for that manifest`);
          return;
        }
        const r = verifyManifest(bytes, m);
        const sig = r.signatureValid ? 'signature valid' : 'SIGNATURE INVALID';
        const asset = r.assetHashMatches
          ? 'asset hash matches the file as it stands'
          : r.assetHashFailure === 'void-binding'
            ? 'asset binding is VOID — integrity unproven for this manifest (defective credentials, not proven tamper)'
            : 'asset hash does not match — the media was edited after this manifest (expected in an update chain)';
        const assertions = r.claimAssertionsMatch ? '' : ', ASSERTION HASHES MISMATCH';
        performed.push(`update chain: manifest ${i + 1}/${chain.manifests.length} ("${m.manifestLabel}") — ${sig}, ${asset}${assertions}`);
      });
    }
  }

  // Revocation is deliberately not performed anywhere (offline verification).
  notPerformed.push('revocation (OCSP/CRL) — verification is fully offline; ask the issuing org about a cert\'s current status');

  let recomputed: string | null = null;
  try {
    recomputed = recomputeClean();
  } catch { /* verdict below still stands on the hard-binding hash */ }

  let verdict: VerdictCode;
  if (!result.signatureValid || !result.claimAssertionsMatch) verdict = 'SIGNATURE_INVALID';
  else if (inner && !inner.signatureValid) verdict = 'SIGNATURE_INVALID';
  // A void binding is NOT proven tamper — the manifest's own exclusion
  // declaration exempts the hash input, so the credentials prove nothing
  // about the media. It lands as SIGNATURE_INVALID (defective credentials),
  // never CONTENT_MODIFIED.
  else if (!result.assetHashMatches && result.assetHashFailure === 'void-binding') verdict = 'SIGNATURE_INVALID';
  else if (!result.assetHashMatches) verdict = 'CONTENT_MODIFIED';
  else verdict = 'INTACT';

  return {
    verdict,
    record: telemetryRecord,
    c2pa: {
      generator: typeof manifest.claim['claim_generator'] === 'string' ? (manifest.claim['claim_generator'] as string) : null,
      alg: result.alg,
      claimAssertionsMatch: result.claimAssertionsMatch,
      assetHashFailure: result.assetHashFailure,
      hasVerifyTelemetry: telemetryRecord !== null,
      signerFingerprint,
      certChain: certChain ?? null,
      appAttest,
      pq: { claim: claimPq, record: recordPq },
      timestamps: {
        present: manifest.timestampTokens.length,
        valid: validTokens.length,
        trusted: trustedTokens.length,
        trustedNames,
        earliestValidUtc,
        earliestTrustedUtc,
        tsaNames,
        failures,
      },
    },
    checks: {
      manifestFound: true,
      signatureValid: result.signatureValid,
      fingerprintMatches: inner ? inner.fingerprintMatches : null,
      // void-binding → null (integrity UNPROVEN), never false (proven tamper)
      assetHashMatches: result.assetHashFailure === 'void-binding' ? null : result.assetHashMatches,
      recomputedSha256: recomputed,
    },
    checksPerformed: performed,
    checksNotPerformed: notPerformed,
    signerTrust,
  };
}

export async function verifyWithSidecarBytes(
  mediaBytes: Uint8Array,
  record: AttestationRecord,
  opts?: VerifyOptions
): Promise<VerificationReport> {
  if (!isAttestationRecord(record)) {
    return { verdict: 'SIGNATURE_INVALID', record: null, checks: { ...noChecks, manifestFound: true }, ...NO_EXTRAS };
  }

  const rec = verifyRecordSignature(record);
  const { signatureValid, fingerprintMatches } = rec;

  const recomputed = sha256Hex(mediaBytes);
  const assetHashMatches = recomputed === record.asset.sha256;

  let verdict: VerdictCode;
  if (!signatureValid) verdict = 'SIGNATURE_INVALID';
  else if (!assetHashMatches) verdict = 'CONTENT_MODIFIED';
  else verdict = 'INTACT';

  // Trust axis on the legacy path too — legacy records
  // carry a signer fingerprint; a supplied resolver gets its say.
  let legacyTrust: SignerTrust | null = null;
  const legacyNotPerformed = [
    'signer identity — legacy manifests carry no chain to evaluate; the signing key is self-asserted',
    'trusted time — legacy manifests carry no RFC 3161 countersignature',
  ];
  if (opts?.trustResolver && record.signer?.fingerprint) {
    try {
      legacyTrust = await opts.trustResolver({
        fingerprint: record.signer.fingerprint, verifiedAtMs: null, orgChain: null,
      });
    } catch {
      legacyNotPerformed.push('signer trust resolution FAILED (resolver threw) — signer unresolved');
    }
  } else if (!opts?.trustResolver) {
    legacyNotPerformed.push('signer trust — no resolver supplied by the caller; who vouches for this key is UNRESOLVED');
  }

  return {
    verdict,
    record,
    checks: {
      manifestFound: true,
      signatureValid,
      fingerprintMatches,
      assetHashMatches,
      recomputedSha256: recomputed,
    },
    checksPerformed: [
      'record signature verified against the embedded public key',
      'media re-hashed and compared to the signed hash',
      ...pqPerformedLines(rec.pq),
    ],
    checksNotPerformed: legacyNotPerformed,
    signerTrust: legacyTrust,
  };
}

/** One-line, plain-English verdict text used across the UI. */
export function verdictHeadline(verdict: VerdictCode): string {
  switch (verdict) {
    case 'INTACT':
      return 'Signature valid — media unchanged since signing';
    case 'CONTENT_MODIFIED':
      return 'Media altered after signing';
    case 'SIGNATURE_INVALID':
      return 'Attestation signature invalid';
    case 'NO_ATTESTATION':
      return 'No attestation found';
    case 'NOT_JPEG':
      return 'Embedded photo attestation requires a JPEG or PNG';
    case 'NOT_BMFF':
      return 'Embedded attestation requires an MP4/MOV/M4A file';
    case 'UNSUPPORTED':
      return 'Manifest uses a structure this build cannot check';
    case 'UNREADABLE':
      return 'File could not be read';
  }
}
