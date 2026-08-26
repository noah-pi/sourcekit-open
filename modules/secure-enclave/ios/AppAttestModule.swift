// Source Kit 0.1.0 — Apple App Attest bridge
// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
import DeviceCheck
import Security

/**
 * App Attest (DCAppAttestService). Apple's App Attest CA signs an attestation
 * object stating that this is genuine Apple hardware running an unmodified
 * install of this app.
 * App Attest keys have no SecKey access and can only be used through
 * DCAppAttestService, so they never sign manifests. The attestation is instead
 * bound to the app's own Secure Enclave signing key: the caller passes
 * clientDataHash = SHA256(challenge ‖ signingPublicKey) (emulated key
 * attestation), and Apple's nonce extension in the attestation leaf
 * certificate certifies that binding.
 * The same key also signs one assertion per capture, bound to that
 * capture's media hash. Apple increments a counter in the Enclave on every
 * assertion and signs it in, so two assertions from one key show whether
 * the count advanced.
 * API:
 * isSupported -> Bool
 * hasAttestedKey -> Bool
 * generateAttestKey -> String (keyId)
 * attestKey(keyId, clientDataHashB64) -> String (attestation object, base64)
 * generateAssertion(clientDataHashB64) -> String (assertion object, base64)
 * deleteAttestKey -> Void
 */
/**
 * SDK 57 workaround: promise.reject(code, description) drops the description,
 * because the JS-visible message is built from `reason`, which the convenience
 * init never sets. This subclass puts the message in `reason`.
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

    // clientDataHashBase64 is the 32-byte hash bound into the attestation:
    // SHA256(challenge ‖ signingPublicKey), computed by the caller.
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

    // The per-capture assertion. clientDataHashBase64 binds it to one
    // capture: SHA256(domain ‖ cleanFileSha256 ‖ signingPublicKey),
    // computed by the caller.
    //
    // The counter Apple increments is not readable from here. It rides
    // inside the returned assertion object, where anyone holding two
    // assertions from the same key can see whether it advanced. Nothing on
    // the device tracks it, and nothing off the device is told.
    AsyncFunction("generateAssertion") { (clientDataHashBase64: String, promise: Promise) in
      guard let keyId = self.storedKeyId() else {
        promise.reject(NamedException("ASSERT_NO_KEY", "no attested key on this device"))
        return
      }
      guard let hash = Data(base64Encoded: clientDataHashBase64), hash.count == 32 else {
        promise.reject(NamedException("ASSERT_BAD_HASH", "clientDataHash must be base64 of 32 bytes"))
        return
      }
      self.service.generateAssertion(keyId, clientDataHash: hash) { assertion, error in
        if let error = error {
          promise.reject(NamedException("ASSERT_FAILED", "generateAssertion failed: \(error.localizedDescription)"))
          return
        }
        guard let assertion = assertion else {
          promise.reject(NamedException("ASSERT_FAILED", "no assertion object returned"))
          return
        }
        promise.resolve(assertion.base64EncodedString())
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
