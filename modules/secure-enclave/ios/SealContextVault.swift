// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import LocalAuthentication

/**
 * SealContextVault (biometric-via-SDK) — ONE Face ID evaluation,
 * TWO signatures.
 *
 * The problem: a biometric-bound capture signs TWICE — the telemetry record
 * (sealBio) and, on the c2pa-swift arm, the COSE claim (the vendored
 * SecureEnclaveSigner's own SecKeyCreateSignature). A.biometryCurrentSet
 * key prompts per signing operation, so the SDK arm would raise a SECOND
 * Face ID prompt outside the one-prompt seal flow (the audit's
 * reason for gating the SDK arm off for bio keys). iOS's own answer is the
 * evaluated LAContext: a key ref fetched with kSecUseAuthenticationContext
 * signs under that context's just-evaluated biometry without re-prompting.
 *
 * This vault holds that freshly evaluated context between the two
 * signatures. It is PUBLIC because the C2paIos pod (which depends on this
 * pod) consumes the context on the SDK arm — two pod targets, one process.
 *
 * Discipline (matches the per-use sealBio promise):
 *  - 30 s TTL. The record sign, the TSA relay hop, and the SDK sign all
 *    fit in seconds; a leaked hold dies on its own. Expiry is enforced on
 *    READ (expiresAt) and by a guarded timer, whichever lands first.
 *  - Identity-guarded timer: the async-after captures the hold's token and
 *    only invalidates THAT hold — a stale timer can never kill a newer one.
 *  - Explicit release on every SDK-arm exit (attest.ts finally), which
 *    invalidates the context so no later sign can ride it.
 *  - current(keyTag:) is NON-consuming but tag-scoped: only the bio key the
 *    hold was evaluated for can use it. After the TTL or a release, a
 *    caller asking for the context gets nil — and the SDK arm THROWS rather
 *    than silently raising a second prompt (C2paIosModule).
 */
public final class SealContextVault {
  public static let shared = SealContextVault()

  private struct Hold {
    let token: UUID
    let keyTag: String
    let context: LAContext
    let expiresAt: Date
  }

  private let lock = NSLock()
  private var hold: Hold?
  private let ttlSeconds: TimeInterval = 30

  private init() {}

  /// Stores a freshly evaluated context for `keyTag`, replacing any prior
  /// hold (invalidated immediately). Only callable after a successful
  /// evaluatePolicy — the vault never evaluates biometry itself.
  public func place(context: LAContext, keyTag: String) {
    lock.lock()
    let previous = hold
    let token = UUID()
    hold = Hold(token: token, keyTag: keyTag, context: context, expiresAt: Date().addingTimeInterval(ttlSeconds))
    lock.unlock()
    previous?.context.invalidate()
    DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + ttlSeconds) { [weak self] in
      guard let self = self else { return }
      self.lock.lock()
      let victim = (self.hold?.token == token) ? self.hold : nil
      if victim != nil { self.hold = nil }
      self.lock.unlock()
      victim?.context.invalidate()
    }
  }

  /// The held context when one exists for this keyTag and is unexpired;
  /// nil otherwise (expired holds are evicted here too — exactness, not
  /// timer latency).
  public func current(keyTag: String) -> LAContext? {
    lock.lock()
    defer { lock.unlock() }
    guard let h = hold, h.keyTag == keyTag, h.expiresAt > Date() else { return nil }
    return h.context
  }

  /// Explicit release — invalidates the context so nothing can ride it
  /// afterwards. Idempotent.
  public func release() {
    lock.lock()
    let victim = hold
    hold = nil
    lock.unlock()
    victim?.context.invalidate()
  }
}
