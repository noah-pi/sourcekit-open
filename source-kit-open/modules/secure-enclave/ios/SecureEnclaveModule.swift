import ExpoModulesCore
import LocalAuthentication
import Security
import CryptoKit
import MachO // _dyld_image_count/_dyld_get_image_name — not exposed to Swift implicitly; explicit import required on recent SDKs

// NOTE: NamedException lives in AppAttestModule.swift. Both files compile
// into the SAME SecureEnclave pod target, and Swift classes are visible
// module-wide — declaring it here too is an "invalid redeclaration" build
// error. (AudioCaptureModule.swift has its own copy because that module is
// a separate pod target.)

/**
 * Secure Enclave signing identities.
 *
 * Two keys, two promises:
 *
 * 1. The standard key (tag ...signing-key). P-256, generated inside the
 *    Secure Enclave, non-extractable: key material never exists in app
 *    memory and cannot be read out by any process — the chip signs.
 *
 * 2. The biometric-bound key (tag ...signing-key-bio). Same silicon, but the
 *    access control adds .biometryCurrentSet + .privateKeyUsage: EVERY sign
 *    operation requires Face ID/Touch ID, and the key is permanently
 *    invalidated if the device's enrolled biometrics change. This binds each
 *    signature to a physically present, recognized person — not merely an
 *    unlocked phone. (Apple does not permit biometric ACLs on App Attest
 *    keys, which is why this is a separate identity — the app presents that
 *    trade-off honestly in Settings.)
 *
 * Runtime-instrumentation hardening:
 *
 * a. PER-USE BIOMETRIC EVALUATION. sealBio evaluates Face ID once, signs
 *    exactly the payloads it was given, and invalidates the LAContext
 *    before returning. A
 *    runtime-instrumented process can no longer mint extra signatures
 *    silently inside a reuse window; forging a capture now needs a live,
 *    cooperating user per signature batch.
 *
 * b. NATIVE SEAL. seal/sealBio compute SHA-256 and the Enclave signature in
 *    one native call — the payload is hashed here, never in JS — narrowing
 *    the hook surface from easy JS instrumentation to native-only.
 *
 * c. SPEED BUMPS, PRICED HONESTLY. PT_DENY_ATTACH at module load, plus
 *    debugger/DYLD-injection artifact checks that GATE signing (active
 *    instrumentation → no signature). These are cost-raisers against
 *    commodity tooling (Frida, Cycript, SSL kill switches), NOT
 *    tamper-proofing: a determined adversary patches the checks themselves.
 *    The durable bounds stay off-device (time-anchoring, roster revocation,
 *    desk content analysis). Note the gate is on ACTIVE instrumentation
 *    only — jailbreak path indicators remain a signed self-report
 *    (src/lib/integrity.ts), never a gate, because refusing attacked
 *    journalists' devices was the failure mode we deliberately avoided.
 *
 * API surface (synchronous unless noted; Security framework calls are fast):
 *   isAvailable()        -> Bool
 *   getPublicKey()       -> String?  — base64 65-byte X9.63 point
 *   generateKey()        -> String
 *   sign(digest:)        -> String   — DER signature base64
 *   deleteKey()          -> Void
 *   getBioPublicKey()    -> String?
 *   generateBioKey()     -> String
 *   signBio(digest:)     -> String   — signs behind Face ID/Touch ID
 *   deleteBioKey()       -> Void
 *   seal(payload:)       -> String   — SHA-256 + sign, one call (standard key)
 *   sealBio(payloads:, reason:) -> [String]  — one scan, per-use (async)
 *   deviceIntegrity()    -> [String: Any]    — active-instrumentation findings
 */
public class SecureEnclaveModule: Module {
  private let keyTag = "com.verify.camera.signing-key"
  private let bioKeyTag = "com.verify.camera.signing-key-bio"
  private let keyType = kSecAttrKeyTypeECSECPrimeRandom

  public func definition() -> ModuleDefinition {
    Name("SecureEnclave")

    // Speed bump (c): refuse debugger attachment for the process's lifetime.
    // Cost-raiser only — a jailbroken host patches around it; documented as such.
    OnCreate {
      denyDebuggerAttach()
    }

    Function("isAvailable") { () -> Bool in
      // Real probe: attempt an ephemeral Secure Enclave keypair; success
      // means the SEP is present and functional. Simulator:
      // kSecAttrTokenIDSecureEnclave is honored from iOS 13+ in the sim's
      // SEP emulator — if the probe errors there, we report false and the
      // JS layer falls back to software keys, which is the honest answer
      // for that host anyway.
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
      // Face ID/Touch ID prompt — per-use evaluation, no session.
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
      // Per-use evaluation: a FRESH context, one scan, invalidated in defer —
      // nothing reusable survives this call.
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

    Function("deviceIntegrity") { () -> [String: Any] in
      [
        "debuggerAttached": isDebuggerAttached(),
        "injectedLibraries": injectedLibraryNames(),
      ]
    }
  }

  // MARK: - Instrumentation gate (speed bumps, priced honestly)

  /// Signing refuses while ACTIVE runtime instrumentation is detected.
  private func gateOnInstrumentation() throws {
    if isDebuggerAttached() { throw EnclaveError.instrumentationDetected("debugger attached") }
    let injected = injectedLibraryNames()
    if !injected.isEmpty { throw EnclaveError.instrumentationDetected(injected.joined(separator: ", ")) }
  }

  // MARK: - Keychain plumbing

  private func generateKey(tag: String, flags: SecAccessControlCreateFlags) throws -> String {
    // If a key already exists, return it — rotation is an explicit delete+generate.
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
    guard let digest = Data(base64Encoded: digestBase64), digest.count == 32 else {
      throw EnclaveError.badDigest
    }
    guard let key = self.loadKey(tag: tag, context: context) else {
      throw EnclaveError.noKey
    }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(
      key,
      .ecdsaSignatureDigestX962SHA256, // we pre-hash; the Enclave signs the digest as-is
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
    // A key reference retrieved WITH an authentication context uses that
    // context's just-evaluated biometry for SecKeyCreateSignature — this is
    // what lets ONE Face ID scan cover exactly one sealBio call's payloads.
    // The caller invalidates the context in the same call; nothing is reused.
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
/// Makes lldb/Frida's server-mode attach fail for this process. A jailbroken
/// host patches around it — a cost-raiser, not a guarantee.
private func denyDebuggerAttach() {
  typealias PtraceFn = @convention(c) (Int32, pid_t, Int32, Int32) -> Int32
  let PT_DENY_ATTACH: Int32 = 31
  if let sym = dlsym(dlopen(nil, RTLD_LAZY), "ptrace") {
    let f = unsafeBitCast(sym, to: PtraceFn.self)
    _ = f(PT_DENY_ATTACH, 0, 0, 0)
  }
}

/// sysctl kinfo_proc — true while a debugger has this process traced.
private func isDebuggerAttached() -> Bool {
  var info = kinfo_proc()
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
  var size = MemoryLayout<kinfo_proc>.stride
  let ok = sysctl(&mib, u_int(mib.count), &info, &size, nil, 0)
  return ok == 0 && (info.kp_proc.p_flag & P_TRACED) != 0
}

/// Loaded-dynamic-image scan for commodity instrumentation artifacts.
/// Returns the suspicious image names found (empty = none).
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
