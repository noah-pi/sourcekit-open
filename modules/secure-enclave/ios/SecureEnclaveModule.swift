// Source Kit 0.1.0 — Secure Enclave signing identities
// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
import LocalAuthentication
import Security
import CryptoKit
import MachO // explicit import: _dyld_image_count/_dyld_get_image_name are not implicit on recent SDKs

// NamedException lives in AppAttestModule.swift, which compiles into this same
// SecureEnclave pod target, so redeclaring it here is a build error.
// AudioCaptureModule.swift has its own copy; it is a separate pod target.

/**
 * Secure Enclave signing identities.
 * Two keys:
 * 1. Standard key (tag...signing-key). P-256, generated inside the Secure
 * Enclave, non-extractable; the chip signs.
 * 2. Biometric-bound key (tag...signing-key-bio). Access control adds
 * .biometryCurrentSet +.privateKeyUsage, so every sign requires Face
 * ID/Touch ID and the key is invalidated when enrolled biometrics change.
 * It is a separate identity because Apple does not permit biometric ACLs
 * on App Attest keys.
 * Runtime-instrumentation hardening:
 * a. Per-use biometric evaluation. sealBio evaluates Face ID once, signs the
 * payloads it was given, and invalidates the LAContext before returning.
 * b. Native seal. seal/sealBio compute SHA-256 and the Enclave signature in
 * one native call, so the payload is never hashed in JS.
 * c. Speed bumps. PT_DENY_ATTACH at module load, plus debugger and
 * DYLD-injection artifact checks that gate signing. These raise the cost
 * of commodity tooling (Frida, Cycript, SSL kill switches); they are not
 * tamper-proofing. The gate covers active instrumentation only; jailbreak
 * path indicators stay a signed self-report in src/lib/integrity.ts.
 * API surface (synchronous unless noted):
 * isAvailable -> Bool
 * getPublicKey -> String? base64 65-byte X9.63 point
 * generateKey -> String
 * sign(digest:) -> String DER signature base64
 * deleteKey -> Void
 * getBioPublicKey -> String?
 * generateBioKey -> String
 * signBio(digest:) -> String signs behind Face ID/Touch ID
 * deleteBioKey -> Void
 * seal(payload:) -> String SHA-256 + sign in one call, standard key
 * sealBio(payloads:, reason:) -> [String] one scan per call (async)
 * deviceIntegrity -> [String: Any] active-instrumentation findings
 */
public class SecureEnclaveModule: Module {
  private let keyTag = "com.verify.camera.signing-key"
  private let bioKeyTag = "com.verify.camera.signing-key-bio"
  private let keyType = kSecAttrKeyTypeECSECPrimeRandom

  public func definition() -> ModuleDefinition {
    Name("SecureEnclave")

    // Speed bump (c): refuse debugger attachment for the process's lifetime.
    OnCreate {
      denyDebuggerAttach()
    }

    Function("isAvailable") { () -> Bool in
      // Probe with an ephemeral Secure Enclave keypair; success means the SEP
      // is present and functional. The simulator reports true without the
      // probe (its SEP emulator honors kSecAttrTokenIDSecureEnclave from iOS
      // 13); elsewhere a failed probe sends the JS layer to software keys.
      #if targetEnvironment(simulator)
        return true
      #else
        let attributes: [String: Any] = [
          kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
          kSecAttrKeySizeInBits as String: 256,
          kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
          kSecPrivateKeyAttrs as String: [kSecAttrIsPermanent as String: false],
        ]
        var error: Unmanaged<CFError>?
        let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error)
        return key != nil
      #endif
    }

    Function("getPublicKey") { () -> String? in
      guard let key = self.loadKey(tag: self.keyTag) else { return nil }
      return self.publicKeyBase64(from: key)
    }

    Function("generateKey") { () throws -> String in
      try self.generateKey(tag: self.keyTag, flags: [])
    }

    Function("sign") { (digestBase64: String) throws -> String in
      try self.sign(digestBase64: digestBase64, tag: self.keyTag)
    }

    Function("deleteKey") { () -> Void in
      self.deleteKey(tag: self.keyTag)
    }

    // MARK: Biometric-bound key

    Function("getBioPublicKey") { () -> String? in
      guard let key = self.loadKey(tag: self.bioKeyTag) else { return nil }
      return self.publicKeyBase64(from: key)
    }

    Function("generateBioKey") { () throws -> String in
      try self.generateKey(tag: self.bioKeyTag, flags: [.privateKeyUsage, .biometryCurrentSet])
    }

    Function("signBio") { (digestBase64: String) throws -> String in
      // SecKeyCreateSignature on a biometry-bound key invokes the system
      // Face ID/Touch ID prompt, once per call.
      try self.sign(digestBase64: digestBase64, tag: self.bioKeyTag)
    }

    Function("deleteBioKey") { () -> Void in
      self.deleteKey(tag: self.bioKeyTag)
    }

    // MARK: Native seal

    Function("seal") { (payloadBase64: String) throws -> String in
      try self.gateOnInstrumentation()
      guard let payload = Data(base64Encoded: payloadBase64) else {
        throw EnclaveError.badDigest
      }
      let digest = SHA256.hash(data: payload)
      return try self.sign(digestBase64: Data(digest).base64EncodedString(), tag: self.keyTag)
    }

    AsyncFunction("sealBio") { (payloadsBase64: [String], reason: String, promise: Promise) in
      do {
        try self.gateOnInstrumentation()
      } catch {
        promise.reject(error)
        return
      }
      var payloads: [Data] = []
      for b64 in payloadsBase64 {
        guard let d = Data(base64Encoded: b64) else {
          promise.reject(NamedException("BAD_PAYLOAD", "sealBio expects base64 payloads"))
          return
        }
        payloads.append(d)
      }
      // A live SDK-arm hold already covers this call — signing under it
      // rather than prompting again is the point of the ceremony.
      if let held = SealContextVault.shared.current(keyTag: self.bioKeyTag) {
        do {
          var signatures: [String] = []
          for payload in payloads {
            let digest = SHA256.hash(data: payload)
            signatures.append(try self.sign(digestBase64: Data(digest).base64EncodedString(), tag: self.bioKeyTag, context: held))
          }
          promise.resolve(signatures)
        } catch {
          promise.reject(error)
        }
        return
      }
      // Fresh context, one scan, invalidated in defer.
      let context = LAContext()
      context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
        guard ok else {
          promise.reject(NamedException("BIO_AUTH", error?.localizedDescription ?? "Biometric authentication failed"))
          return
        }
        defer { context.invalidate() }
        do {
          var signatures: [String] = []
          for payload in payloads {
            let digest = SHA256.hash(data: payload)
            signatures.append(try self.sign(digestBase64: Data(digest).base64EncodedString(), tag: self.bioKeyTag, context: context))
          }
          promise.resolve(signatures)
        } catch {
          promise.reject(error)
        }
      }
    }

 /**
 * Evaluates Face ID or Touch ID once and vaults the context, so the
 * c2pa-swift arm can sign the COSE claim without a second prompt. The
 * hold is tag-scoped, expires on its own, and the caller releases it.
 * Resolves true; rejects like sealBio on a failed or cancelled scan.
 */
    AsyncFunction("sealBioHold") { (reason: String, promise: Promise) in
      do {
        try self.gateOnInstrumentation()
      } catch {
        promise.reject(error)
        return
      }
      let context = LAContext()
      context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { ok, error in
        guard ok else {
          promise.reject(NamedException("BIO_AUTH", error?.localizedDescription ?? "Biometric authentication failed"))
          return
        }
        SealContextVault.shared.place(context: context, keyTag: self.bioKeyTag)
        promise.resolve(true)
      }
    }

    /// Releases and invalidates any held context. Safe to call when empty.
    Function("sealBioRelease") { () -> Void in
      SealContextVault.shared.release()
    }

    Function("deviceIntegrity") { () -> [String: Any] in
      [
        "debuggerAttached": isDebuggerAttached(),
        "injectedLibraries": injectedLibraryNames(),
      ]
    }
  }

  // MARK: - Instrumentation gate

  /// Signing refuses while active runtime instrumentation is detected.
  private func gateOnInstrumentation() throws {
    if isDebuggerAttached() { throw EnclaveError.instrumentationDetected("debugger attached") }
    let injected = injectedLibraryNames()
    if !injected.isEmpty { throw EnclaveError.instrumentationDetected(injected.joined(separator: ", ")) }
  }

  // MARK: - Keychain plumbing

  private func generateKey(tag: String, flags: SecAccessControlCreateFlags) throws -> String {
    // Existing key is returned as-is; rotation is an explicit delete+generate.
    if let existing = self.loadKey(tag: tag), let pub = self.publicKeyBase64(from: existing) {
      return pub
    }
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      flags,
      nil
    ) else {
      throw EnclaveError.accessControlFailed
    }
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: self.keyType,
      kSecAttrKeySizeInBits as String: 256,
      kSecAttrTokenID as String: kSecAttrTokenIDSecureEnclave,
      kSecPrivateKeyAttrs as String: [
        kSecAttrIsPermanent as String: true,
        kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
        kSecAttrAccessControl as String: access,
      ],
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
      throw EnclaveError.keyGenerationFailed(error?.takeRetainedValue().localizedDescription ?? "unknown")
    }
    guard let pub = self.publicKeyBase64(from: key) else {
      throw EnclaveError.publicKeyUnavailable
    }
    return pub
  }

  private func sign(digestBase64: String, tag: String, context: LAContext? = nil) throws -> String {
    // With no explicit context, consult the vault so every sign made while a
    // hold is live is covered by that hold's single evaluation. Nil when no
    // hold exists, which is the unchanged per-use path.
    let effectiveContext = context ?? SealContextVault.shared.current(keyTag: tag)
    guard let digest = Data(base64Encoded: digestBase64), digest.count == 32 else {
      throw EnclaveError.badDigest
    }
    guard let key = self.loadKey(tag: tag, context: effectiveContext) else {
      throw EnclaveError.noKey
    }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(
      key,
      .ecdsaSignatureDigestX962SHA256, // pre-hashed; the Enclave signs the digest as-is
      digest as CFData,
      &error
    ) else {
      throw EnclaveError.signingFailed(error?.takeRetainedValue().localizedDescription ?? "unknown")
    }
    return (sig as Data).base64EncodedString()
  }

  private func loadKey(tag: String, context: LAContext? = nil) -> SecKey? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
      kSecAttrKeyType as String: self.keyType,
      kSecReturnRef as String: true,
    ]
    // A key reference retrieved with an authentication context uses that
    // context's just-evaluated biometry for SecKeyCreateSignature, so one Face
    // ID scan covers one sealBio call's payloads. The caller invalidates it.
    if let context = context {
      query[kSecUseAuthenticationContext as String] = context
    }
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else { return nil }
    return (item as! SecKey)
  }

  private func deleteKey(tag: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag.data(using: .utf8)!,
    ]
    SecItemDelete(query as CFDictionary)
  }

  /// External representation of an EC public key is the ANSI X9.63 uncompressed point.
  private func publicKeyBase64(from key: SecKey) -> String? {
    guard let pub = SecKeyCopyPublicKey(key) else { return nil }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(pub, &error) as Data? else { return nil }
    return data.base64EncodedString()
  }
}

// MARK: - Anti-instrumentation primitives (file-scope; no state)

/// PT_DENY_ATTACH via dlsym (ptrace is not exposed to Swift directly).
/// Makes lldb and Frida server-mode attach fail for this process.
private func denyDebuggerAttach() {
  typealias PtraceFn = @convention(c) (Int32, pid_t, Int32, Int32) -> Int32
  let PT_DENY_ATTACH: Int32 = 31
  if let sym = dlsym(dlopen(nil, RTLD_LAZY), "ptrace") {
    let f = unsafeBitCast(sym, to: PtraceFn.self)
    _ = f(PT_DENY_ATTACH, 0, 0, 0)
  }
}

/// sysctl kinfo_proc: true while a debugger has this process traced.
private func isDebuggerAttached() -> Bool {
  var info = kinfo_proc()
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  var size = MemoryLayout<kinfo_proc>.stride
  let ok = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
  return ok == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
}

/// Loaded-dynamic-image scan for commodity instrumentation artifacts.
/// Returns the suspicious image names found; empty means none.
private func injectedLibraryNames() -> [String] {
  let needles = [
    "frida", "fridagadget", "cycript", "mobilesubstrate", "libsubstrate",
    "substrate", "sslkillswitch", "libhooker", "ellekit", "substitute",
    "needle", "radare",
  ]
  var found: [String] = []
  let count = _dyld_image_count()
  for i in 0..<count {
    guard let cName = _dyld_get_image_name(i) else { continue }
    let name = String(cString: cName).lowercased()
    if needles.contains(where: { name.contains($0) }) {
      found.append(String(cString: cName))
    }
  }
  // DYLD_INSERT_LIBRARIES survives in the environment on some injection paths.
  if let env = getenv("DYLD_INSERT_LIBRARIES"), String(cString: env).isEmpty == false {
    found.append("DYLD_INSERT_LIBRARIES")
  }
  return found
}

enum EnclaveError: Error, LocalizedError {
  case accessControlFailed
  case keyGenerationFailed(String)
  case publicKeyUnavailable
  case badDigest
  case noKey
  case signingFailed(String)
  case instrumentationDetected(String)

  var errorDescription: String? {
    switch self {
    case .accessControlFailed: return "Could not create keychain access control"
    case .keyGenerationFailed(let m): return "Secure Enclave key generation failed: \(m)"
    case .publicKeyUnavailable: return "Could not export Enclave public key"
    case .badDigest: return "sign() expects a base64-encoded 32-byte digest"
    case .noKey: return "No Enclave key exists yet"
    case .signingFailed(let m): return "Enclave signing failed: \(m)"
    case .instrumentationDetected(let m):
      return "Signing paused: active runtime instrumentation detected (\(m)). Source refuses to sign while debugging or injection tools are attached, so a signature always means the app produced it unobserved. This is a speed bump, not a guarantee — and it never affects existing files."
    }
  }
}
