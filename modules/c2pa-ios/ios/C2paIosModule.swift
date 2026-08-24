// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
// No `import C2PA`: c2pa-swift v0.0.12 is vendored, so Vendor/C2PA/** compiles
// into this pod target and its types are same-module here. See
// Vendor/C2PA/VENDORED.md "Module-name note".
import Foundation
import LocalAuthentication  // LAContext, for the vaulted biometric hold
import Security  // SecAccessControlCreateFlags (same explicit import as upstream's SecureEnclaveSigner.swift)
import SecureEnclave  // SealContextVault — cross-pod; C2paIos.podspec depends on it

/**
 * C2paIos — upstream C2PA engine binding,
 * wrapping c2pa-swift v0.0.12. Read: store JSON goes verbatim to
 * src/provenance/engine/upstreamEngineIos.ts; verdicts belong to the policy
 * layer (SPEC §0.2). Sign: PEM or Secure Enclave ES256. Offline invariant
 * (SPEC §0 rule 5): no TSA URL is ever passed and the TS bridge disables
 * remote_manifest_fetch/ocsp_fetch. Unconfirmed APIs carry UNVERIFIED-API
 * comments.
 */

/**
 * promise.reject drops the description on SDK 57 ("CODE: undefined reason").
 * Same pattern as CaptureKit/AudioCapture; own copy since this is a separate
 * pod target.
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
     * Load c2pa-rs global settings (JSON). Process-global upstream, so the TS
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
     * Read and validate the embedded manifest store; returns the upstream store
     * JSON verbatim for the TS layer to parse. Format is inferred from the file
     * extension (UNVERIFIED-API: observed c2pa_read_file behavior), so the TS
     * bridge stages a correctly-extensioned temp file. The raw c2pa-rs error
     * text feeds the TS error classifier and must not be rewritten here.
     */
    AsyncFunction("readManifest") { (path: String) throws -> String in
      do {
        return try C2PA.readFile(at: self.fileURL(path))
      } catch {
        throw self.mapError(error, code: "C2PA_READ")
      }
    }

    /**
     * Read and validate a detached (sidecar) manifest against its asset.
     * Verified API: Reader(format:stream:manifest:) +
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
     * Sign with a PEM certificate chain and PEM private key. Offline: tsa is
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
      // c2pa_sign_file may refuse to overwrite; clear the destination first so
      // a stale file is never mistaken for the signed output.
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
     * Sign with a Secure Enclave P-256 key (ES256 only, a hardware limit); key
     * material never exists in app memory. keyTag names an existing enclave key,
     * or c2pa-swift creates one under that tag. The chain's leaf must correspond
     * to the enclave key; this module never mints certs. requireBiometric
     * (.biometryCurrentSet, per-use Face ID) applies only to a newly created
     * key; an existing key keeps its ACL. Returns base64 of the embedded
     * manifest; the signed copy is in destPath. Verified API:
     * Builder/Signer/SecureEnclaveSignerConfig/Stream(writeTo overwrites).
     */
    AsyncFunction("signFileSecureEnclave") { (sourcePath: String, destPath: String, format: String,
                                              manifestJSON: String, certificateChainPEM: String,
                                              keyTag: String, requireBiometric: Bool,
                                              tsaUrl: String?, resourcesJson: String?,
                                              useHeldBioContext: Bool) throws -> String in
      var relay: TsaLoopbackRelay?
      var heldContext: LAContext?
      do {
        // The caller ran sealBioHold, so one Face ID evaluation is vaulted
        // and this signature rides it through the vendored signer's keychain
        // query. An empty vault throws rather than letting the signer raise
        // its own prompt: the caller's fallback logs and seals hand-rolled.
        // The hold's lifetime belongs to the vault and the caller's finally.
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
        // The caller's configured RFC 3161 authority, or nil for the offline
        // invariant — an untimed capture is disclosed downstream, never
        // dressed up. A malformed configured URL throws rather than degrading
        // to nil, which would present a configuration failure as an offline
        // capture. With an authority set, the SDK is pointed at a one-shot
        // loopback relay: the core's own resolver does not complete the
        // round-trip from an app process. See TsaLoopbackRelay.swift.
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
        // Binary payloads (thumbnails) as embedded resources — the bfdb/bidb
        // layout, referenced from the manifest by thumbnail identifier. Only
        // identifiers the manifest references are passed; unreferenced
        // resources are dropped by the core.
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
        // The relay names why a timestamp fetch failed — listener, forward
        // hop, or upstream status. Append it so the diagnostic carries the
        // real reason and the caller's 'TSA relay' classifier matches.
        let base = self.mapError(error, code: "C2PA_SIGN")
        guard let relayNote = relay?.lastError else { throw base }
        let baseText = (base as? NamedException)?.reason ?? error.localizedDescription
        throw NamedException("C2PA_SIGN", "\(baseText) — \(relayNote)")
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
   * Preserve the upstream error text: the TS classifier is an ordered chain
   * over message substrings (tamper, no-manifest, unsupported, unreadable) and
   * consumes it verbatim.
   */
  private func mapError(_ error: Error, code: String) -> Exception {
    if let c2paError = error as? C2PAError {
      return NamedException(code, c2paError.errorDescription ?? String(describing: c2paError))
    }
    return NamedException(code, error.localizedDescription)
  }
}
