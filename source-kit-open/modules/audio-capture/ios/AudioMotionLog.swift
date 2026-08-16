import Foundation
import CoreMotion

/**
 * AudioMotionLog — the audio recorder's IMU sink (WS2 Phase 2 §3 parity).
 *
 * Audio joins photo/video poseTrace parity: while a recording runs, gyro
 * samples stream to a JSONL file in EXACTLY the CaptureKit SensorLogger
 * line format (SPEC-WS1 §5.2), so the desk speaks one sensor language for
 * every media kind:
 *
 *   {"t":<bootSec>,"mach":<machTicks>,"kind":"gyro","x":..,"y":..,"z":..}
 *
 * The FIRST line is the anchor record binding the sensor clock to the
 * recording's wall-clock start (the recording clock anchor), same as the
 * CaptureKit session anchor:
 *   {"kind":"anchor","startedAtMs":..,"machAtAnchor":..,"bootSecAtAnchor":..}
 *
 * RATE HONESTY: CMMotionManager gyro is requested at 100 Hz
 * (gyroUpdateInterval = 0.01), the same target as the video-side logger.
 * CoreMotion delivery is best-effort — the committed poseTrace assertion
 * derives its `hz` from the trace's own intervals (median Δt), never from
 * this target, so a slower device states its real rate.
 *
 * Gyro only: the poseTrace commitment (src/provenance/poseTrace.ts) reads
 * gyro lines; accel/baro/loc are CaptureKit-session sinks and stay there.
 *
 * FAILURE HONESTY (mirrors SensorLogger rule 4): a write failure marks the
 * sink failed; finish() then returns nil and the module reports
 * sensorLogState "failed" — the recording itself is never blocked. A failed
 * sink appends one last best-effort line,
 *   {"kind":"sinkFailed","t":<bootSec>}
 * so the log records its own truncation point. When the device has no gyro
 * at all, no logger is created and the module reports "unavailable" — the
 * poseTrace is honestly ABSENT, never fabricated, never silently empty.
 */

/// Boot-relative clock helpers, local to this module (the CaptureKit
/// equivalents live in a different pod and are not shared).
private enum AudioMachClock {
  static let timebase: mach_timebase_info_data_t = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info
  }()

  static func nowTicks() -> UInt64 { mach_absolute_time() }

  static func ticksToBootSeconds(_ ticks: UInt64) -> Double {
    let nanos = Double(ticks) * Double(timebase.numer) / Double(timebase.denom)
    return nanos / 1_000_000_000.0
  }

  /// Boot-relative seconds back to (approximate) mach ticks, to tag gyro
  /// samples whose native timestamp is already boot-relative (SPEC §5.2).
  static func bootSecondsToTicks(_ seconds: Double) -> UInt64 {
    let nanos = seconds * 1_000_000_000.0
    return UInt64((nanos * Double(timebase.denom) / Double(timebase.numer)).rounded())
  }
}

/// JSON-number-safe formatting: never emits inf/nan, fixed decimals, and
/// String(format:) is locale-independent for %f — lines stay machine-parseable.
private func audioLogFixed(_ v: Double, _ places: Int = 6) -> String {
  guard v.isFinite else { return "0" }
  return String(format: "%.\(places)f", v)
}

final class AudioMotionLog {

  enum SinkError: Error, LocalizedError {
    case cannotCreateFile(String)

    var errorDescription: String? {
      switch self {
      case .cannotCreateFile(let m): return "Cannot create audio IMU log: \(m)"
      }
    }
  }

  private let url: URL
  private var handle: FileHandle?
  private var failed = false
  private var closed = false
  private let writeLock = NSLock()

  private let motionQueue = OperationQueue()
  private var motion: CMMotionManager?

  var hasFailed: Bool {
    writeLock.lock(); defer { writeLock.unlock() }
    return failed
  }

  init(url: URL, anchorStartedAtMs: Int64) throws {
    self.url = url
    motionQueue.name = "com.verify.audiocapture.imu"
    motionQueue.maxConcurrentOperationCount = 1

    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
      throw SinkError.cannotCreateFile("createFile failed at \(url.path)")
    }
    do {
      self.handle = try FileHandle(forWritingTo: url)
    } catch {
      throw SinkError.cannotCreateFile(error.localizedDescription)
    }
    // Anchor line first — binds mach/boot clock to the recording's
    // wall-clock start anchor (same convention as CaptureKit SensorLogger).
    let anchor = AudioMachClock.nowTicks()
    let line = "{\"kind\":\"anchor\",\"startedAtMs\":\(anchorStartedAtMs),\"machAtAnchor\":\(anchor),\"bootSecAtAnchor\":\(audioLogFixed(AudioMachClock.ticksToBootSeconds(anchor), 9))}\n"
    writeLine(line)
  }

  deinit {
    closeHandle()
  }

  /// Gyro at the 100 Hz target; handlers fire on motionQueue (serial).
  func start() {
    let manager = CMMotionManager()
    guard manager.isGyroAvailable else { return } // caller checks first; belt-and-braces
    manager.gyroUpdateInterval = 0.01
    manager.startGyroUpdates(to: motionQueue) { [weak self] data, _ in
      guard let self = self, let data = data else { return }
      let x = audioLogFixed(data.rotationRate.x, 6)
      let y = audioLogFixed(data.rotationRate.y, 6)
      let z = audioLogFixed(data.rotationRate.z, 6)
      self.writeLine(self.sampleLine(bootSec: data.timestamp, fields: "\"x\":\(x),\"y\":\(y),\"z\":\(z)"))
    }
    motion = manager
  }

  /// Stops the gyro and closes the file. Returns the log path, or nil if
  /// the sink failed (the module then reports sensorLogState "failed").
  func finish() -> String? {
    motion?.stopGyroUpdates()
    motion = nil
    writeLock.lock()
    let ok = !failed
    // Self-describing truncation: when the sink failed mid-recording, the
    // log itself records WHERE writes stopped. Best-effort — the underlying
    // handle may be exactly what failed, in which case the absence of the
    // marker is itself the record.
    if failed && !closed, let handle = handle {
      let t = AudioMachClock.ticksToBootSeconds(AudioMachClock.nowTicks())
      let line = "{\"kind\":\"sinkFailed\",\"t\":\(audioLogFixed(t, 9))}\n"
      if let data = line.data(using: .utf8) {
        try? handle.write(contentsOf: data)
      }
    }
    writeLock.unlock()
    closeHandle()
    return ok ? url.path : nil
  }

  // MARK: - Writing (lock-confined; callable from motionQueue and main)

  private func sampleLine(bootSec: Double, fields: String) -> String {
    let mach = AudioMachClock.bootSecondsToTicks(bootSec)
    return "{\"t\":\(audioLogFixed(bootSec, 9)),\"mach\":\(mach),\"kind\":\"gyro\",\(fields)}\n"
  }

  private func writeLine(_ line: String) {
    writeLock.lock()
    defer { writeLock.unlock() }
    guard !closed, !failed, let handle = handle else { return }
    guard let data = line.data(using: .utf8) else { return }
    do {
      try handle.write(contentsOf: data)
    } catch {
      failed = true // degrade: stop logging, module reports "failed"
    }
  }

  private func closeHandle() {
    writeLock.lock()
    defer { writeLock.unlock() }
    guard !closed else { return }
    closed = true
    if let handle = handle {
      try? handle.close()
    }
    handle = nil
  }
}
