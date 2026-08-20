// UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
import Foundation
import CoreMotion

/**
 * ExhibitSensorLogger — the camera module's IMU evidence sink (0.15).
 *
 * The Settings sensor toggle was a dead control without this file: photo and
 * video capture committed `sensorLogPath: 'never-recorded'` because the
 * module had no IMU sink at all. This is the sink, adapted from the audited
 * CaptureKit SensorLogger (modules/capture-kit/ios/SensorLogger.swift) with
 * ONE design change: that logger streams straight to a file for a whole
 * delivery session; the camera needs a window around an EVENT (the shutter,
 * the recording), so this logger keeps a bounded in-memory ring and flushes
 * a boot-time window to a JSONL evidence file on demand.
 *
 *   - Sampling: CMMotionManager accelerometer + gyroscope at the 100 Hz
 *     target (updateInterval 0.01), handlers on a serial OperationQueue.
 *     CoreMotion delivery is best-effort — the file's own Δt sequence is the
 *     honest rate record; nothing is resampled or interpolated.
 *   - Buffer: a ring hard-capped at 12,000 samples (60 s at the
 *     100 Hz × 2-stream target, ~0.6 MB of value-type structs). Memory never
 *     grows with session length; stop() drops the contents — no buffer
 *     retention beyond the ring.
 *   - File format: JSONL, EXACTLY the CaptureKit SensorLogger line format,
 *     so the desk speaks one sensor language for every media kind:
 *       {"t":<bootSec>,"mach":<machTicks>,"kind":"accel","x":..,"y":..,"z":..}
 *       {"t":<bootSec>,"mach":<machTicks>,"kind":"gyro","x":..,"y":..,"z":..}
 *     The FIRST line is the anchor record binding the sensor clock to the
 *     event's wall clock (shutter ms / recording-start ms) — machAtAnchor /
 *     bootSecAtAnchor are the EVENT's instant on the sensor clock, so a
 *     reader can re-zero the window against either domain:
 *       {"kind":"anchor","startedAtMs":..,"machAtAnchor":..,"bootSecAtAnchor":..}
 *     The SECOND line states the flush window honestly — including tail
 *     truncation when a recording outlived the ring span:
 *       {"kind":"window","requestedStart":..,"requestedEnd":..,
 *        "actualStart":..,"actualEnd":..,"samples":N,"spanSec":60.0,
 *        "truncated":false}
 *
 * Clocks: CMLogItem.timestamp is boot-relative seconds on the mach clock —
 * the SAME clock the camera frame PTS rides ("host seconds" in the
 * timestamps-*.json sink), so windows slice both domains with no conversion.
 *
 * Threading: samples append on the logger's serial motionQueue; start/stop
 * and window slices run on the module's sessionQueue. The ring is
 * NSLock-confined so the two never race; sliceWindow returns a value copy
 * the caller owns. The module owns the logger lifecycle entirely from
 * sessionQueue (start at configureSession, stop at teardown/thermal).
 *
 * HONESTY (mirrors SensorLogger rule 4 / the audio module's three-state
 * precedent): a device with no IMU → no logger → 'unavailable'. A flush
 * that finds zero samples in the window writes NO file → 'unavailable'. A
 * write failure throws → the module reports 'failed' + sensorLogError. A
 * failed or absent log NEVER blocks a capture. Samples are NEVER sent over
 * the bridge — file only.
 */
final class ExhibitSensorLogger {

  /// One IMU sample. `t` is CMLogItem.timestamp (boot-relative mach-clock
  /// seconds); `mach` is the same instant in mach absolute ticks, so every
  /// sample carries both clocks (CaptureKit SPEC §5.2 convention).
  struct Sample {
    var t: Double
    var mach: UInt64
    var gyro: Bool // false = accel
    var x: Double
    var y: Double
    var z: Double
  }

  /// 60 s of history at the 100 Hz × 2-stream target. Hard cap.
  static let capacity = 12_000
  /// The ring's nominal time span, stated in the file's window line.
  static let spanSec = 60.0

  private var ring: [Sample] = []
  /// Index of the OLDEST sample once the ring is full; 0 while filling.
  private var head = 0
  /// Number of live samples (≤ capacity); ring.count grows to capacity once.
  private var count = 0
  private let ringLock = NSLock()

  private let motionQueue = OperationQueue()
  private var motion: CMMotionManager?

  /// IMU hardware probe — no session objects, no side effects. A false here
  /// is what the module reports as 'unavailable' on IMU-less hardware.
  static var isHardwareAvailable: Bool {
    let probe = CMMotionManager()
    return probe.isAccelerometerAvailable || probe.isGyroAvailable
  }

  init() {
    ring.reserveCapacity(ExhibitSensorLogger.capacity)
    motionQueue.name = "com.exhibit.camera.sensors"
    motionQueue.maxConcurrentOperationCount = 1
  }

  // MARK: - Lifecycle (sessionQueue only)

  /// Starts accel + gyro at the 100 Hz target. Idempotent. Handlers fire on
  /// motionQueue (serial) and only append to the lock-confined ring.
  func start() {
    guard motion == nil else { return }
    let manager = CMMotionManager()
    manager.accelerometerUpdateInterval = 0.01
    manager.gyroUpdateInterval = 0.01
    if manager.isAccelerometerAvailable {
      manager.startAccelerometerUpdates(to: motionQueue) { [weak self] data, _ in
        guard let self = self, let data = data else { return }
        self.append(Sample(
          t: data.timestamp,
          mach: ExhibitMachClock.bootSecondsToTicks(data.timestamp),
          gyro: false,
          x: data.acceleration.x,
          y: data.acceleration.y,
          z: data.acceleration.z
        ))
      }
    }
    if manager.isGyroAvailable {
      manager.startGyroUpdates(to: motionQueue) { [weak self] data, _ in
        guard let self = self, let data = data else { return }
        self.append(Sample(
          t: data.timestamp,
          mach: ExhibitMachClock.bootSecondsToTicks(data.timestamp),
          gyro: true,
          x: data.rotationRate.x,
          y: data.rotationRate.y,
          z: data.rotationRate.z
        ))
      }
    }
    motion = manager
  }

  /// Stops delivery and drops the buffer — no retention beyond the ring, and
  /// no stale window can be mis-attributed to a later capture. CoreMotion is
  /// independent of the capture graph, so this never disturbs an in-flight
  /// photo (session calibration one-shot included). sessionQueue only.
  func stop() {
    motion?.stopAccelerometerUpdates()
    motion?.stopGyroUpdates()
    motion = nil
    ringLock.lock()
    ring.removeAll(keepingCapacity: true)
    head = 0
    count = 0
    ringLock.unlock()
  }

  // MARK: - Ring (lock-confined; appends land on motionQueue)

  private func append(_ sample: Sample) {
    ringLock.lock()
    if count < ExhibitSensorLogger.capacity {
      ring.append(sample) // fills to capacity once; head stays 0
      count += 1
    } else {
      ring[head] = sample
      head = (head + 1) % ExhibitSensorLogger.capacity
    }
    ringLock.unlock()
  }

  /// Samples with t in [from, to], oldest first. Lock-confined snapshot —
  /// the returned array is a value copy the caller owns.
  func sliceWindow(from: Double, to: Double) -> [Sample] {
    ringLock.lock()
    defer { ringLock.unlock() }
    var out: [Sample] = []
    out.reserveCapacity(min(count, 4_096))
    for i in 0..<count {
      // While filling, head == 0 and ring.count == count; once full,
      // ring.count == capacity. Both cases index correctly here.
      let sample = ring[(head + i) % ExhibitSensorLogger.capacity]
      if sample.t >= from, sample.t <= to {
        out.append(sample)
      }
    }
    return out
  }

  // MARK: - Window flush (sessionQueue; bounded — ≤ 60 s of samples, ~1 MB)

  /// Flush a boot-time window to a JSONL evidence file. Returns the sample
  /// count written; 0 means NO file was created (an empty log is not
  /// evidence — the module reports 'unavailable'). Throws on I/O failure —
  /// the module reports 'failed' + sensorLogError and never blocks the
  /// capture.
  ///
  /// `anchorBootSec` is the EVENT's instant on the sensor clock (the shutter
  /// PTS / the recording start) — the anchor line exists to bind
  /// `anchorStartedAtMs` (the event's wall clock) to THAT instant. 0.18.6
  /// field fix: this used to write now-at-flush, so the line bound the
  /// event's START wall clock to the take's END boot time — every reader
  /// that re-zeroes on the anchor (the video motion card) placed the whole
  /// window at negative offsets and the gyro lane rendered off-card.
  func flushWindow(from: Double, to: Double, to url: URL, anchorStartedAtMs: Int64, anchorBootSec: Double) throws -> Int {
    let slice = sliceWindow(from: from, to: to)
    guard !slice.isEmpty else { return 0 }

    let anchorTicks = ExhibitMachClock.bootSecondsToTicks(anchorBootSec)
    var text = "{\"kind\":\"anchor\",\"startedAtMs\":\(anchorStartedAtMs),\"machAtAnchor\":\(anchorTicks),\"bootSecAtAnchor\":\(exhibitSensorFixed(anchorBootSec, 9))}\n"
    // actualStart/actualEnd are the buffer's honest coverage; `truncated`
    // says the ring could not reach back to the requested start (a recording
    // that outlived the 60 s span commits its tail, stated — never implied
    // to be the whole window).
    let actualStart = slice.first?.t ?? from // slice is non-empty (guard above)
    let actualEnd = slice.last?.t ?? to
    let truncated = actualStart > from + 0.05
    text += "{\"kind\":\"window\",\"requestedStart\":\(exhibitSensorFixed(from, 9)),\"requestedEnd\":\(exhibitSensorFixed(to, 9)),\"actualStart\":\(exhibitSensorFixed(actualStart, 9)),\"actualEnd\":\(exhibitSensorFixed(actualEnd, 9)),\"samples\":\(slice.count),\"spanSec\":\(exhibitSensorFixed(ExhibitSensorLogger.spanSec, 1)),\"truncated\":\(truncated)}\n"
    for sample in slice {
      let kind = sample.gyro ? "gyro" : "accel"
      text += "{\"t\":\(exhibitSensorFixed(sample.t, 9)),\"mach\":\(sample.mach),\"kind\":\"\(kind)\",\"x\":\(exhibitSensorFixed(sample.x, 6)),\"y\":\(exhibitSensorFixed(sample.y, 6)),\"z\":\(exhibitSensorFixed(sample.z, 6))}\n"
    }
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    try text.write(to: url, atomically: true, encoding: .utf8)
    return slice.count
  }
}

/// JSON-number-safe formatting (own copy — the CaptureKit/audio equivalents
/// live in different pod targets and are not shared): never emits inf/nan,
/// fixed decimals, and String(format:) is locale-independent for %f, so
/// lines stay machine-parseable.
private func exhibitSensorFixed(_ v: Double, _ places: Int = 6) -> String {
  guard v.isFinite else { return "0" }
  return String(format: "%.\(places)f", v)
}
