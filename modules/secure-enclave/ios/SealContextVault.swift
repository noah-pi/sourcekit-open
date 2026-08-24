// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import LocalAuthentication

/**
 * One Face ID evaluation, two signatures.
 *
 * A biometric-bound capture signs twice: the telemetry record, and on the
 * c2pa-swift arm the COSE claim. A `.biometryCurrentSet` key prompts per
 * signing operation, so the SDK arm would raise a second prompt outside the
 * one-prompt seal flow. An evaluated LAContext is iOS's answer: a key ref
 * fetched with `kSecUseAuthenticationContext` signs under that context's
 * already-evaluated biometry without prompting again.
 *
 * This vault holds that context between the two signatures. It is public
 * because the C2paIos pod consumes it on the SDK arm — two pod targets, one
 * process.
 *
 * The discipline that keeps it equivalent to the per-use promise:
 *  - A TTL, enforced on read and by a guarded timer, whichever lands first.
 *  - The timer captures its hold's token and invalidates only that hold, so
 *    a stale timer can never kill a newer one.
 *  - Explicit release on every SDK-arm exit, which invalidates the context
 *    so no later sign can ride it.
 *  - `current(keyTag:)` is non-consuming but tag-scoped: only the key the
 *    hold was evaluated for can use it. Past the TTL or a release a caller
 *    gets nil, and the SDK arm throws rather than raising a second prompt.
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

  /// Long enough to cover the record signature, every TSA witness attempt
  /// and the SDK signature — a witness pool that outlives the hold would
  /// leave the later attempts signing against nothing. Short enough that the
  /// window in which one scan authorizes a signature stays small: the relay
  /// caps each witness at 15s, so a pool of two finishes well inside this.
  private let ttlSeconds: TimeInterval = 60

  private init() {}

  /// Stores a freshly evaluated context for `keyTag`, replacing any prior
  /// hold. Only callable after a successful evaluatePolicy — the vault never
  /// evaluates biometry itself.
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

  /// The held context when one exists for this keyTag and is unexpired, nil
  /// otherwise. An expired hold is evicted and invalidated here rather than
  /// left alive until the timer fires.
  public func current(keyTag: String) -> LAContext? {
    lock.lock()
    guard let h = hold else { lock.unlock(); return nil }
    if h.expiresAt <= Date() {
      hold = nil
      lock.unlock()
      h.context.invalidate()
      return nil
    }
    lock.unlock()
    return h.keyTag == keyTag ? h.context : nil
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
