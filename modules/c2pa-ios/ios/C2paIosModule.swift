// Written with AI assistance. Verification: docs/PROVENANCE.md.
// NOT COMPILED BY CI. No Swift compiler runs against this file in this
// repository; it is exercised only by an on-device soak run. See
// docs/PROVENANCE.md for what the test lab does and does not reach.
import ExpoModulesCore
// NO `import C2PA`: c2pa-swift v0.0.12 is VENDORED (Vendor/C2PA/** compiles
// into THIS pod target, so its types are same-module here; the C2PAC Rust
// core is a clang module from the vendored xcframework, used only by the
// vendored sources). See Vendor/C2PA/VENDORED.md "Module-name note".
import Foundation
import LocalAuthentication  // LAContext, for the held biometric context
import Security  // SecAccessControlCreateFlags (same explicit import as upstream's SecureEnclaveSigner.swift)
import SecureEnclave  // SealContextVault — cross-pod; C2paIos.podspec depends on it

/**
 * C2paIos — upstream C2PA engine binding (SPEC WS3, WS3-Binding-Path §2/§7a),
 * wrapping c2pa-swift v0.0.12. READ: store JSON goes verbatim to the TS layer
 * (src/provenance/engine/upstreamEngineIos.ts) — NO VERDICTS here; verdicts
 * belong to the policy layer (SPEC §0.2). SIGN: PEM or Secure Enclave ES256.
 * Offline invariant (SPEC §0 rule 5): no TSA URL is ever passed and the TS
 * bridge disables remote_manifest_fetch/ocsp_fetch. APIs below were read from
 * the tagged v0.0.12 source; unconfirmed ones carry UNVERIFIED-API comments.
 */

/**
 * promise.reject drops the description on SDK 57 ("CODE: undefined reason") —
 * same NamedException pattern as CaptureKit/AudioCapture; own copy because
 * this is a separate pod target.
 */
final class NamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

public class C2paIosModule: Module {

  /**
   * (freeze,): expo-modules-core dispatches EVERY
   * module's AsyncFunctions on one shared serial queue
   * (expo.modules.AsyncFunctionQueue). signFileSecureEnclave BLOCKS its
   * calling thread through the whole TSA round trip (TsaLoopbackRelay's
   * 30 s semaphore per witness + the untimed retry = 60 s+), which parked
   * every camera AsyncFunction (configureSession/stopSession/setFacing/
   * capture/startVideo) behind it — dead preview and unresponsive shutter
   * while the "Sealing…" pill showed, until the seal finished. All of this
   * module's blocking work now runs on its OWN serial queue; a seal can
   * never again queue ahead of the camera. Retained by the module so the
   * queue outlives every in-flight call.
   */
  private let c2paQueue = DispatchQueue(label: "com.verify.camera.c2pa", qos: .userInitiated)

  public func definition() -> ModuleDefinition {
    Name("C2paIos")

    /// c2pa-rs core version, recorded in reports for reproducibility.
    Function("getVersion") { () -> String in
      C2PA.version
    }

    /**
     * Load c2pa-rs global settings (JSON). PROCESS-GLOBAL upstream — the TS
     * bridge pins them once per process and refuses to switch trust material
     * mid-run. Verified API: Signer.loadSettings(_:format:) (static; throws).
     */
    AsyncFunction("loadSettings") { (settingsJSON: String) throws -> Void in
      do {
        try Signer.loadSettings(settingsJSON, format: .json)
      } catch {
        throw self.mapError(error, code: "C2PA_SETTINGS")
      }
    }.runOnQueue(c2paQueue)

    /**
     * Read + validate the embedded manifest store; returns the upstream store
     * JSON verbatim for the TS layer to parse and normalize. Format is inferred
     * from the FILE EXTENSION (UNVERIFIED-API: observed c2pa_read_file behavior),
     * so the TS bridge stages a correctly-extensioned temp file. The raw c2pa-rs
     * error text feeds the TS error classifier — it MUST NOT be rewritten here.
     */
    AsyncFunction("readManifest") { (path: String) throws -> String in
      do {
        return try C2PA.readFile(at: self.fileURL(path))
      } catch {
        throw self.mapError(error, code: "C2PA_READ")
      }
    }.runOnQueue(c2paQueue)

    /**
     * Read + validate a DETACHED (sidecar) manifest against its asset
     * (WS3-Binding-Path §6c). Verified API: Reader(format:stream:manifest:) +
     * Stream(readFrom:) + reader.json.
     */
    AsyncFunction("readManifestDetached") { (path: String, format: String, manifestBase64: String) throws -> String in
      guard let manifestData = Data(base64Encoded: manifestBase64) else {
        throw NamedException("C2PA_READ", "manifestBase64 is not valid base64")
      }
      do {
        let stream = try Stream(readFrom: self.fileURL(path))
        let reader = try Reader(format: format, stream: stream, manifest: manifestData)
        return try reader.json()
      } catch {
        throw self.mapError(error, code: "C2PA_READ")
      }
    }.runOnQueue(c2paQueue)

    /**
     * Sign with a PEM certificate chain + PEM private key. Offline: tsa is
     * always nil. Verified API: C2PA.signFile(source:destination:manifestJSON:
     * signerInfo:) with SignerInfo(algorithm:certificatePEM:privateKeyPEM:tsa:).
     */
    AsyncFunction("signFilePem") { (sourcePath: String, destPath: String, manifestJSON: String,
                                    certificatePEM: String, privateKeyPEM: String,
                                    algorithm: String) throws -> Void in
      guard let alg = SigningAlgorithm(rawValue: algorithm) else {
        throw NamedException("C2PA_SIGN", "unknown signing algorithm '\(algorithm)' (expected es256/es384/es512/ps256/ps384/ps512/ed25519)")
      }
      let dest = self.fileURL(destPath)
      // c2pa_sign_file may not overwrite — fail loudly instead of silently
      // signing into a stale destination.
      try? FileManager.default.removeItem(at: dest)
      let info = SignerInfo(
        algorithm: alg,
        certificatePEM: certificatePEM,
        privateKeyPEM: privateKeyPEM,
        tsa: nil  // offline invariant: no network timestamping from device
      )
      do {
        try C2PA.signFile(
          source: self.fileURL(sourcePath),
          destination: dest,
          manifestJSON: manifestJSON,
          signerInfo: info
        )
      } catch {
        throw self.mapError(error, code: "C2PA_SIGN")
      }
    }.runOnQueue(c2paQueue)

    /**
     * Sign with a Secure Enclave P-256 key (ES256 only — hardware limit); key
     * material never exists in app memory. keyTag names an EXISTING enclave
     * key (else c2pa-swift creates it under that tag). The chain's leaf MUST
     * correspond to the enclave key — this module never mints certs.
     * requireBiometric (.biometryCurrentSet, per-use Face ID) only applies to
     * a newly created key; an existing key keeps its original ACL. Returns
     * base64 of the embedded manifest (informational; the signed copy is in
     * destPath). Verified API: Builder/Signer/SecureEnclaveSignerConfig/
     * Stream(writeTo overwrites) per the tagged v0.0.12 source.
     */
    AsyncFunction("signFileSecureEnclave") { (sourcePath: String, destPath: String, format: String,
                                              manifestJSON: String, certificateChainPEM: String,
                                              keyTag: String, requireBiometric: Bool,
                                              tsaUrl: String?, resourcesJson: String?,
                                              useHeldBioContext: Bool) throws -> String in
      var relay: TsaLoopbackRelay?
      var heldContext: LAContext?
      do {
        // (c): the biometric arm. The caller ran sealBioHold (ONE
        // Face ID evaluation, vaulted in the SecureEnclave pod); this sign
        // rides that context through the vendored signer's keychain query.
        // When the vault is EMPTY we throw — the SDK path never raises its
        // own silent second prompt; the caller's fallback logs and seals
        // hand-rolled. Lifecycle (TTL, release, invalidate) belongs to the
        // vault and the caller's finally — not to this function.
        if useHeldBioContext {
          guard let ctx = SealContextVault.shared.current(keyTag: keyTag) else {
            throw NamedException("C2PA_SIGN", "useHeldBioContext was set but no held biometric context exists for '\(keyTag)' (vault empty or expired) — refusing to raise a second Face ID prompt silently")
          }
          heldContext = ctx
        }
        let accessControl: SecAccessControlCreateFlags = requireBiometric
          ? [.privateKeyUsage, .biometryCurrentSet]
          : [.privateKeyUsage]
        let config = SecureEnclaveSignerConfig(keyTag: keyTag, accessControl: accessControl, context: heldContext)
        // caller-chosen TSA endpoint (the app's own configured RFC
        // 3161 authority) or nil — nil remains the offline invariant, and
        // an untimed capture is disclosed downstream, never dressed up. The
        // SDK takes URL?, so a malformed configured URL must THROW (the JS
        // gate catches it, falls back, and logs the reason) — silently
        // degrading to nil would dress a configuration failure up as an
        // offline capture.
        // (b2): with a TSA configured, the SDK is pointed at a
        // ONE-SHOT loopback relay that forwards the RFC 3161 exchange over
        // URLSession — c2pa-rs's own resolver never completes the round-trip
        // from an app process and there is no public seam to fix that
        // (c2pa-swift #109; see TsaLoopbackRelay.swift / VENDORED.md). The
        // relay's failure text rides lastError into the thrown error below.
        let tsaURL: URL?
        if let tsaUrl = tsaUrl {
          guard let parsed = URL(string: tsaUrl) else {
            throw C2PAError.api("malformed TSA URL: \(tsaUrl)")
          }
          let tsr = TsaLoopbackRelay(upstream: parsed)
          relay = tsr
          tsaURL = try tsr.start()
        } else {
          tsaURL = nil
        }
        defer { relay?.stop() }
        let signer = try Signer(
          algorithm: .es256,
          certificateChainPEM: certificateChainPEM,
          tsa: tsaURL,
          secureEnclaveConfig: config
        )
        let builder = try Builder(manifestJSON: manifestJSON)
        // full port: binary payloads (thumbnails) as embedded
        // resources — the bfdb/bidb layout c2pa-rs produces, referenced from
        // the manifest by thumbnail identifiers. Only identifiers the
        // manifest actually references are ever passed; c2pa-rs drops
        // unreferenced resources (probe-verified against c2pa-rs).
        if let resourcesJson = resourcesJson,
           let raw = resourcesJson.data(using: .utf8),
           let list = try JSONSerialization.jsonObject(with: raw) as? [[String: String]] {
          for entry in list {
            guard let identifier = entry["identifier"],
                  let dataBase64 = entry["dataBase64"],
                  let data = Data(base64Encoded: dataBase64) else {
              throw C2PAError.api("malformed resource entry")
            }
            try builder.addResource(uri: identifier, stream: try Stream(data: data))
          }
        }
        let source = try Stream(readFrom: self.fileURL(sourcePath))
        let dest = try Stream(writeTo: self.fileURL(destPath))
        let manifestBytes = try builder.sign(
          format: format,
          source: source,
          destination: dest,
          signer: signer
        )
        return manifestBytes.base64EncodedString()
      } catch {
        // (b1/b2): the relay's side-channel names WHY the timestamp
        // fetch failed (listener, forward hop, upstream status) — append it
        // verbatim so the TS diagnostic carries the real reason and the
        // 'TSA relay' classifier needle matches.
        let base = self.mapError(error, code: "C2PA_SIGN")
        guard let relayNote = relay?.lastError else { throw base }
        let baseText = (base as? NamedException)?.reason ?? error.localizedDescription
        throw NamedException("C2PA_SIGN", "\(baseText) — \(relayNote)")
      }
    }.runOnQueue(c2paQueue)
  }

  // MARK: - helpers

  /// Accepts plain paths and file:// URIs (percent-decoding handled).
  private func fileURL(_ path: String) -> URL {
    if let url = URL(string: path), url.isFileURL {
      return url
    }
    return URL(fileURLWithPath: path)
  }

  /**
   * Preserve the upstream error text: the TS classifier is an ORDERED chain
   * over message substrings (tamper first, then no-manifest, unsupported,
   * unreadable; audit A-05/B-8) and consumes it verbatim.
   */
  private func mapError(_ error: Error, code: String) -> Exception {
    if let c2paError = error as? C2PAError {
      return NamedException(code, c2paError.errorDescription ?? String(describing: c2paError))
    }
    return NamedException(code, error.localizedDescription)
  }
}
