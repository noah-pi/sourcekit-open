// Source Kit 0.1.0 — camera module's IMU evidence sink
import Foundation
import CoreMotion

/**
 * ExhibitSensorLogger — the camera module's IMU evidence sink. Adapted from
 * CaptureKit SensorLogger (modules/capture-kit/ios/SensorLogger.swift), which
 * streams straight to a file for a whole delivery session; the camera instead
 * needs a window around an event (the shutter, the recording), so this logger
 * keeps a bounded in-memory ring and flushes a boot-time window on demand.
 * Sampling: CMMotionManager accelerometer and gyroscope at the 100 Hz
 * target (updateInterval 0.01), handlers on a serial OperationQueue.
 * Delivery is best-effort; the file's own Δt sequence is the rate record
 * and nothing is resampled or interpolated.
 * Buffer: a ring hard-capped at 12,000 samples (60 s at the
 * 100 Hz × 2-stream target, ~0.6 MB). Memory does not grow with session
 * length, and stop drops the contents.
 * File format: JSONL in the CaptureKit SensorLogger line format:
 * {"t":<bootSec>,"mach":<machTicks>,"kind":"accel","x":..,"y":..,"z":..}
 * {"t":<bootSec>,"mach":<machTicks>,"kind":"gyro","x":..,"y":..,"z":..}
 * The first line anchors the sensor clock to the event's wall clock;
 * machAtAnchor / bootSecAtAnchor are the event's instant on the sensor
 * clock, so a reader can re-zero the window against either domain:
 * {"kind":"anchor","startedAtMs":..,"machAtAnchor":..,"bootSecAtAnchor":..}
 * The second line states the flush window, including tail truncation when
 * a recording outlived the ring span:
 * {"kind":"window","requestedStart":..,"requestedEnd":..,
 * "actualStart":..,"actualEnd":..,"samples":N,"spanSec":60.0,
 * "truncated":false}
 * Clocks: CMLogItem.timestamp is boot-relative seconds on the mach clock, the
 * same clock the camera frame PTS rides ("host seconds" in the
 * timestamps-*.json sink), so windows slice both domains with no conversion.
 * Threading: samples append on the serial motionQueue; start/stop and window
 * slices run on the module's sessionQueue. The ring is NSLock-confined so the
 * two never race, and sliceWindow returns a value copy the caller owns. The
 * module drives the lifecycle from sessionQueue (start at configureSession,
 * stop at teardown or thermal).
 * States (SensorLogger rule 4): no IMU means no logger and 'unavailable'; a
 * flush that finds zero samples writes no file and reports 'unavailable'; a
 * write failure throws and the module reports 'failed' plus sensorLogError.
 * A failed or absent log never blocks a capture, and samples never cross the
 * bridge.
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
  /// Index of the oldest sample once the ring is full; 0 while filling.
  private var head = 0
  /// Number of live samples (≤ capacity); ring.count grows to capacity once.
  private var count = 0
  private let ringLock = NSLock()

  private let motionQueue = OperationQueue()
  private var motion: CMMotionManager?

  /// IMU hardware probe; no session objects, no side effects. False here is
  /// what the module reports as 'unavailable'.
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

  /// Stops delivery and drops the buffer, so no stale window can be attributed
  /// to a later capture. CoreMotion is independent of the capture graph, so
  /// this never disturbs an in-flight photo. sessionQueue only.
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

  /// Samples with t in [from, to], oldest first. Lock-confined snapshot; the
  /// returned array is a value copy the caller owns.
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
  /// count written; 0 means no file was created and the module reports
  /// 'unavailable'. Throws on I/O failure, which the module reports as
  /// 'failed' plus sensorLogError without blocking the capture.
  ///
  /// `anchorBootSec` must be the event's instant on the sensor clock (the
  /// shutter PTS or the recording start), since the anchor line binds
  /// `anchorStartedAtMs` to that instant. Passing now-at-flush instead binds
  /// the event's start wall clock to the take's end boot time, and readers
  /// that re-zero on the anchor place the whole window at negative offsets.
  func flushWindow(from: Double, to: Double, to url: URL, anchorStartedAtMs: Int64, anchorBootSec: Double) throws -> Int {
    let slice = sliceWindow(from: from, to: to)
    guard !slice.isEmpty else { return 0 }

    let anchorTicks = ExhibitMachClock.bootSecondsToTicks(anchorBootSec)
    var text = "{\"kind\":\"anchor\",\"startedAtMs\":\(anchorStartedAtMs),\"machAtAnchor\":\(anchorTicks),\"bootSecAtAnchor\":\(exhibitSensorFixed(anchorBootSec, 9))}\n"
    // actualStart/actualEnd are the buffer's real coverage; `truncated` says
    // the ring could not reach back to the requested start, so a recording that
    // outlived the 60 s span commits only its tail.
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

/// JSON-number-safe formatting: no inf/nan, fixed decimals, and
/// String(format:) is locale-independent for %f, so lines stay parseable.
/// Own copy; the CaptureKit and audio equivalents are in other pod targets.
private func exhibitSensorFixed(_ v: Double, _ places: Int = 6) -> String {
  guard v.isFinite else { return "0" }
  return String(format: "%.\(places)f", v)
}
