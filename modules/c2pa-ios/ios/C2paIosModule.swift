// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
// NO `import C2PA`: c2pa-swift v0.0.12 is VENDORED (Vendor/C2PA/** compiles
// into THIS pod target, so its types are same-module here; the C2PAC Rust
// core is a clang module from the vendored xcframework, used only by the
// vendored sources). See Vendor/C2PA/VENDORED.md "Module-name note".
import Foundation
import Security  // SecAccessControlCreateFlags (same explicit import as upstream's SecureEnclaveSigner.swift)

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
    }

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
    }

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
    }

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
    }

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
                                              keyTag: String, requireBiometric: Bool) throws -> String in
      do {
        let accessControl: SecAccessControlCreateFlags = requireBiometric
          ? [.privateKeyUsage, .biometryCurrentSet]
          : [.privateKeyUsage]
        let config = SecureEnclaveSignerConfig(keyTag: keyTag, accessControl: accessControl)
        let signer = try Signer(
          algorithm: .es256,
          certificateChainPEM: certificateChainPEM,
          tsa: nil,  // offline invariant
          secureEnclaveConfig: config
        )
        let builder = try Builder(manifestJSON: manifestJSON)
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
        throw self.mapError(error, code: "C2PA_SIGN")
      }
    }
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
   * unreadable) and consumes it verbatim.
   */
  private func mapError(_ error: Error, code: String) -> Exception {
    if let c2paError = error as? C2PAError {
      return NamedException(code, c2paError.errorDescription ?? String(describing: c2paError))
    }
    return NamedException(code, error.localizedDescription)
  }
}
