import Foundation
import CoreMotion
import CoreLocation

/**
 * SensorLogger — full-rate IMU / baro / location log (SPEC §5.2).
 *
 *   - CMMotionManager accelerometer + gyroscope at 100 Hz
 *   - CMAltimeter relative altitude (when available)
 *   - CLLocationManager best-accuracy fixes
 *
 * JSONL, one sample per line, at evidenceDir/sensors-<sessionId>.jsonl:
 *   {"t":<bootSec>,"mach":<machTicks>,"kind":"accel","x":..,"y":..,"z":..}
 *   {"t":<bootSec>,"mach":<machTicks>,"kind":"gyro","x":..,"y":..,"z":..}
 *   {"t":<bootSec>,"mach":<machTicks>,"kind":"baro","relAlt":..,"press":..}
 *   {"t":<bootSec>,"mach":<machTicks>,"kind":"loc","lat":..,"lon":..,"alt":..,
 *    "hAcc":..,"vAcc":..,"locSrc":"fused"}
 *
 * Timestamps: every sample carries BOTH mach absolute ticks and
 * boot-relative seconds (SPEC §5.2). The FIRST line of the file is an anchor
 * record binding the sensor clock to the session's frame-clock epoch anchor:
 *   {"kind":"anchor","startedAtMs":..,"machAtAnchor":..,"bootSecAtAnchor":..}
 * so the desk can align samples to frames (skew-vs-IMU analysis).
 *
 * HONESTY (SPEC §5.2): location samples are fused CLLocation — iOS provides
 * no raw GNSS (pseudoranges are Android-only). Every loc line therefore
 * carries "locSrc":"fused". If location permission is unavailable, loc
 * samples are simply absent; nothing is fabricated.
 *
 * Samples are NEVER sent over the bridge (SPEC §5.3) — file only.
 * Sink failures degrade (rule 4): a write failure marks the sink
 * failed; the module surfaces onError E_SENSOR_LOG and reports
 * sensorLogPath: null — the delivery capture is never blocked. At finalize a
 * failed sink appends one last best-effort line,
 *   {"kind":"sinkFailed","t":<bootSec>}
 * so the log file records its own truncation point (known limitation: the
 * failure is surfaced to JS at finalize time, not instantly).
 */
final class SensorLogger: NSObject {

  enum SinkError: Error, LocalizedError {
    case cannotCreateFile(String)

    var errorDescription: String? {
      switch self {
      case .cannotCreateFile(let m): return "Cannot create sensor log: \(m)"
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
  private var altimeter: CMAltimeter?
  private var locationManager: CLLocationManager?

  /// Wall-clock epoch (seconds) at boot, captured once so fused-location
  /// Dates can be expressed on the boot-relative clock too.
  private let bootEpochWallSec: Double
  private let anchorStartedAtMs: Int64

  /// True once any write has failed — module reports sensorLogPath: null.
  var hasFailed: Bool {
    writeLock.lock(); defer { writeLock.unlock() }
    return failed
  }

  init(url: URL, anchorStartedAtMs: Int64) throws {
    self.url = url
    self.anchorStartedAtMs = anchorStartedAtMs
    self.bootEpochWallSec = Date().timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
    motionQueue.name = "com.verify.capturekit.sensors"
    motionQueue.maxConcurrentOperationCount = 1
    super.init()

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
    // Anchor line first — binds mach/boot clock to the session's wall-clock
    // frame anchor (SPEC §5.2).
    let anchor = MachClock.nowTicks()
    let line = "{\"kind\":\"anchor\",\"startedAtMs\":\(anchorStartedAtMs),\"machAtAnchor\":\(anchor),\"bootSecAtAnchor\":\(captureKitFixed(MachClock.ticksToBootSeconds(anchor), 9))}\n"
    writeLine(line)
  }

  deinit {
    closeHandle()
  }

  // MARK: - Lifecycle

  func start() {
    // IMU at 100 Hz (SPEC §5.2). Handlers fire on motionQueue (serial).
    let manager = CMMotionManager()
    manager.accelerometerUpdateInterval = 0.01
    manager.gyroUpdateInterval = 0.01
    if manager.isAccelerometerAvailable {
      manager.startAccelerometerUpdates(to: motionQueue) { [weak self] data, _ in
        guard let self = self, let data = data else { return }
        let x = captureKitFixed(data.acceleration.x, 6)
        let y = captureKitFixed(data.acceleration.y, 6)
        let z = captureKitFixed(data.acceleration.z, 6)
        self.writeLine(self.sampleLine(kind: "accel", bootSec: data.timestamp, fields: "\"x\":\(x),\"y\":\(y),\"z\":\(z)"))
      }
    }
    if manager.isGyroAvailable {
      manager.startGyroUpdates(to: motionQueue) { [weak self] data, _ in
        guard let self = self, let data = data else { return }
        let x = captureKitFixed(data.rotationRate.x, 6)
        let y = captureKitFixed(data.rotationRate.y, 6)
        let z = captureKitFixed(data.rotationRate.z, 6)
        self.writeLine(self.sampleLine(kind: "gyro", bootSec: data.timestamp, fields: "\"x\":\(x),\"y\":\(y),\"z\":\(z)"))
      }
    }
    motion = manager

    // Barometer (relative altitude) when the hardware has one.
    if CMAltimeter.isRelativeAltitudeAvailable() {
      let alt = CMAltimeter()
      alt.startRelativeAltitudeUpdates(to: motionQueue) { [weak self] data, _ in
        guard let self = self, let data = data else { return }
        let relAlt = captureKitFixed(data.relativeAltitude.doubleValue, 4)
        let press = captureKitFixed(data.pressure.doubleValue, 5)
        self.writeLine(self.sampleLine(kind: "baro", bootSec: data.timestamp, fields: "\"relAlt\":\(relAlt),\"press\":\(press)"))
      }
      altimeter = alt
    }

    // Fused location — delegate callbacks must be created/started on a run
    // loop; use the main queue deterministically.
    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      let lm = CLLocationManager()
      lm.delegate = self
      lm.desiredAccuracy = kCLLocationAccuracyBest
      lm.distanceFilter = kCLDistanceFilterNone
      self.locationManager = lm
      switch lm.authorizationStatus {
      case .authorizedWhenInUse, .authorizedAlways:
        lm.startUpdatingLocation()
      case .notDetermined:
        // Only request if the host app actually declares the key — requesting
        // without it is undefined. (verify-app declares
        // NSLocationWhenInUseUsageDescription; guard keeps the module safe in
        // any host.)
        if Bundle.main.object(forInfoDictionaryKey: "NSLocationWhenInUseUsageDescription") != nil {
          lm.requestWhenInUseAuthorization()
        }
      default:
        break // denied/restricted: no loc samples, honestly absent
      }
    }
  }

  /// Stops all providers and closes the file. Returns the log path, or nil
  /// if the sink failed (module reports sensorLogPath: null + onError).
  func finish() -> String? {
    motion?.stopAccelerometerUpdates()
    motion?.stopGyroUpdates()
    altimeter?.stopRelativeAltitudeUpdates()
    let lm = locationManager
    if Thread.isMainThread {
      lm?.stopUpdatingLocation()
    } else {
      DispatchQueue.main.sync { lm?.stopUpdatingLocation() }
    }
    motion = nil
    altimeter = nil
    locationManager = nil
    writeLock.lock()
    let ok = !failed
    // Self-describing truncation (SPEC §5.2 honesty): when the sink failed
    // mid-session, the log itself records WHERE writes stopped. Best-effort
    // — the underlying handle may be exactly what failed, in which case the
    // line is lost and the absence is itself the truncation marker.
    if failed && !closed, let handle = handle {
      let t = MachClock.ticksToBootSeconds(MachClock.nowTicks())
      let line = "{\"kind\":\"sinkFailed\",\"t\":\(captureKitFixed(t, 9))}\n"
      if let data = line.data(using: .utf8) {
        try? handle.write(contentsOf: data)
      }
    }
    writeLock.unlock()
    closeHandle()
    return ok ? url.path : nil
  }

  // MARK: - Writing (lock-confined; callable from motionQueue and main)

  private func sampleLine(kind: String, bootSec: Double, fields: String) -> String {
    let mach = MachClock.bootSecondsToTicks(bootSec)
    return "{\"t\":\(captureKitFixed(bootSec, 9)),\"mach\":\(mach),\"kind\":\"\(kind)\",\(fields)}\n"
  }

  private func writeLine(_ line: String) {
    writeLock.lock()
    defer { writeLock.unlock() }
    guard !closed, !failed, let handle = handle else { return }
    guard let data = line.data(using: .utf8) else { return }
    do {
      try handle.write(contentsOf: data)
    } catch {
      failed = true // degrade: stop logging, module reports null path
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

  // MARK: - CLLocationManagerDelegate

  private func handleLocation(_ location: CLLocation) {
    let bootSec = location.timestamp.timeIntervalSince1970 - bootEpochWallSec
    let lat = captureKitFixed(location.coordinate.latitude, 8)
    let lon = captureKitFixed(location.coordinate.longitude, 8)
    let alt = captureKitFixed(location.altitude, 3)
    let hAcc = captureKitFixed(location.horizontalAccuracy, 3)
    let vAcc = captureKitFixed(location.verticalAccuracy, 3)
    writeLine(sampleLine(
      kind: "loc",
      bootSec: bootSec,
      fields: "\"lat\":\(lat),\"lon\":\(lon),\"alt\":\(alt),\"hAcc\":\(hAcc),\"vAcc\":\(vAcc),\"locSrc\":\"fused\""
    ))
  }
}

extension SensorLogger: CLLocationManagerDelegate {
  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    for location in locations {
      handleLocation(location)
    }
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    switch manager.authorizationStatus {
    case .authorizedWhenInUse, .authorizedAlways:
      manager.startUpdatingLocation()
    default:
      break
    }
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // Location failure is NOT a sink failure: the log file is intact, loc
    // samples are simply absent. Nothing to fabricate, nothing to hide.
  }
}
