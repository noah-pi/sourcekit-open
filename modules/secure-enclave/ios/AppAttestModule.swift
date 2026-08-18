// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
import DeviceCheck
import Security

/**
 * App Attest (DCAppAttestService).
 *
 * Apple's hardware attestation: the App Attest service generates a Secure
 * Enclave key and produces an attestation object — a WebAuthn-format
 * statement signed by Apple's App Attest CA proving "this is genuine Apple
 * hardware running a genuine, unmodified install of this app."
 *
 * Apple deliberately gives the app no SecKey access to App Attest keys —
 * they are usable only through DCAppAttestService.attestKey /
 * generateAssertion (which track the hardware counter), so an App Attest
 * key can never sign our manifests. Instead the attestation is BOUND to the
 * app's own Secure Enclave signing key: the caller hashes that key's public
 * bytes into the clientDataHash (SHA256(challenge ‖ signingPublicKey) — the
 * industry-standard emulated key attestation), Apple's nonce extension in
 * the attestation leaf certificate then certifies the binding, and all
 * media signing continues with the Enclave key. The registry server
 * re-derives and verifies the same construction.
 *
 * API:
 *   isSupported                        -> Bool
 *   hasAttestedKey                     -> Bool
 *   generateAttestKey                  -> String (keyId)
 *   attestKey(keyId, clientDataHashB64)  -> String (attestation object, base64)
 *   deleteAttestKey                    -> Void
 */
/**
 * promise.reject(code, description) silently DROPS the description on SDK 57:
 * the JS-visible message is built from `reason` (which the convenience init
 * never sets), so every rejection arrived as "CODE: undefined reason" and
 * real failures were undiagnosable. This subclass carries the message in
 * `reason`, so actionable errors reach JS.
 */
final class NamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

public class AppAttestModule: Module {
  private let service = DCAppAttestService.shared
  private let tagKey = "com.verify.camera.app-attest-keyid"

  public func definition() -> ModuleDefinition {
    Name("AppAttest")

    Function("isSupported") { () -> Bool in
      return self.service.isSupported
    }

    Function("hasAttestedKey") { () -> Bool in
      return self.storedKeyId() != nil
    }

    AsyncFunction("generateAttestKey") { (promise: Promise) in
      self.service.generateKey { keyId, error in
        if let error = error {
          promise.reject(NamedException("ATTEST_KEYGEN", "App Attest key generation failed: \(error.localizedDescription)"))
          return
        }
        guard let keyId = keyId else {
          promise.reject(NamedException("ATTEST_KEYGEN", "App Attest returned no keyId"))
          return
        }
        self.storeKeyId(keyId)
        promise.resolve(keyId)
      }
    }

    // clientDataHashBase64 is the EXACT 32-byte hash to bind into the
    // attestation — the caller computes SHA256(challenge ‖ signingPublicKey)
    // so the Apple-certified attestation also commits to the app's Enclave
    // signing key (emulated key attestation).
    AsyncFunction("attestKey") { (keyId: String, clientDataHashBase64: String, promise: Promise) in
      guard let hash = Data(base64Encoded: clientDataHashBase64), hash.count == 32 else {
        promise.reject(NamedException("ATTEST_BAD_HASH", "clientDataHash must be base64 of 32 bytes"))
        return
      }
      self.service.attestKey(keyId, clientDataHash: hash) { attestation, error in
        if let error = error {
          promise.reject(NamedException("ATTEST_FAILED", "attestKey failed: \(error.localizedDescription)"))
          return
        }
        guard let attestation = attestation else {
          promise.reject(NamedException("ATTEST_FAILED", "no attestation object returned"))
          return
        }
        promise.resolve(attestation.base64EncodedString())
      }
    }

    Function("deleteAttestKey") { () -> Void in
      if let keyId = self.storedKeyId() {
        let query: [String: Any] = [
          kSecClass as String: kSecClassKey,
          kSecAttrApplicationTag as String: keyId.data(using: .utf8)!,
        ]
        SecItemDelete(query as CFDictionary)
      }
      UserDefaults.standard.removeObject(forKey: self.tagKey)
    }
  }

  // MARK: - plumbing

  private func storedKeyId() -> String? {
    return UserDefaults.standard.string(forKey: tagKey)
  }

  private func storeKeyId(_ keyId: String) {
    UserDefaults.standard.set(keyId, forKey: tagKey)
  }
}
