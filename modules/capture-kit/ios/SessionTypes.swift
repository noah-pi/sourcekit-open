// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import AVFoundation

/**
 * Shared value types for the CaptureKit module.
 * Every field recorded here must be LITERALLY TRUE (SPEC §0 rule 3):
 * if the platform cannot provide a value, we record nil/null and say so —
 * we never fabricate.
 */

/// Lens selection accepted by startVideoSession / capturePhotoWithRing.
/// Values match SPEC §2.2 exactly: 'ultraWide' | 'wide' | 'telephoto'.
enum LensChoice: String {
  case ultraWide
  case wide
  case telephoto

  init(jsValue: String?) {
    self = LensChoice(rawValue: jsValue ?? "wide") ?? .wide
  }

  /// Back-facing device type for this lens. nil when the hardware does not
  /// have that camera (e.g. ultra-wide on older devices) — callers fall back.
  var deviceType: AVCaptureDevice.DeviceType {
    switch self {
    case .ultraWide: return .builtInUltraWideCamera
    case .wide: return .builtInWideAngleCamera
    case .telephoto: return .builtInTelephotoCamera
    }
  }
}

/// Error codes — SPEC §2.2, exact strings, JS-visible via onError and promise
/// rejections. Do not rename; JS matches on these.
enum CaptureKitErrorCode {
  static let permission = "E_PERMISSION"   // camera/mic not granted
  static let busy = "E_BUSY"               // a session is already running
  static let writer = "E_WRITER"           // delivery AVAssetWriter failed
  static let pcmSink = "E_PCM_SINK"        // raw PCM master sink failed
  static let sensorLog = "E_SENSOR_LOG"    // sensor JSONL sink failed
  static let ringDump = "E_RING_DUMP"      // ring buffer JPEG dump failed
  static let noSession = "E_NO_SESSION"    // stop with nothing running
  static let platform = "E_PLATFORM"       // device/OS cannot do what was asked
}

/// Fixed logical chunk size for streamed hashing (SPEC §3): 1 MiB.
let kCaptureKitChunkBytes = 1_048_576

/// Number of pre-shutter frames retained by the ring buffer (SPEC §4).
let kCaptureKitRingCapacity = 8

/**
 * Anti-banding state (SPEC §5.4). iOS exposes NO anti-banding query API, so
 * mainsHz is derived from the locale region (50 Hz vs 60 Hz grid lists) and
 * exposureSec is the capture device's last known exposure duration. The
 * literal note "region-derived" is part of the contract — the desk must not
 * read this as a measured flicker estimate.
 */
struct AntiBandingState {
  let mainsHz: Int          // 50 or 60
  let exposureSec: Double?  // nil when the device did not report one
  let note = "region-derived"

  /// Region-derived mains frequency. 60 Hz grids (whole or majority):
  /// North/Central America + Caribbean, Liberia, and a few others. Everything
  /// else defaults to 50. This is explicitly region-derived (see `note`) —
  /// Japan straddles both grids and is recorded as 60 with the note carrying
  /// the honesty burden.
  static func regionMainsHz() -> Int {
    let region: String?
    if #available(iOS 16.0, *) {
      region = Locale.current.region?.identifier
    } else {
      region = Locale.current.regionCode
    }
    // Country codes with 60 Hz mains grids (predominantly).
    let sixtyHz: Set<String> = [
      "US", "CA", "MX", "BR", "CO", "VE", "PE", "CL", "EC", "GY", "SR",
      "CR", "PA", "NI", "HN", "SV", "GT", "BZ", "CU", "DO", "HT", "PR",
      "VI", "GU", "AS", "JM", "TT", "BS", "BB", "AW", "CW", "KY", "AI",
      "AG", "DM", "GD", "KN", "LC", "MS", "TC", "VG", "GP", "MQ", "PM",
      "BL", "MF", "SX", "BQ", "FK", "GF",
      "KR", "TW", "PH", "JP", "SA", "LR", "GQ", "MM", "KP",
    ]
    guard let code = region?.uppercased() else { return 50 }
    return sixtyHz.contains(code) ? 60 : 50
  }

  static func fromDevice(_ device: AVCaptureDevice?) -> AntiBandingState {
    var exposure: Double? = nil
    if let device = device {
      let t = device.exposureDuration
      // exposureDuration is a CMTime; it can be indefinite/invalid when the
      // device is not streaming — record null in that case (honesty rule 3).
      if t.isValid && !t.isIndefinite {
        let s = CMTimeGetSeconds(t)
        if s.isFinite && s > 0 { exposure = s }
      }
    }
    return AntiBandingState(mainsHz: regionMainsHz(), exposureSec: exposure)
  }

  var asDictionary: [String: Any] {
    // exposureSec must be present with an explicit NSNull when unavailable —
    // "the absence is always explicit in the result payload" (SPEC §0 rule 4).
    [
      "mainsHz": mainsHz,
      "exposureSec": exposureSec as Any? ?? NSNull(),
      "note": note,
    ]
  }
}

/**
 * Evidence paths for a finished video session (SPEC §2.2 stopVideoSession).
 * nil means EITHER the sink failed (onError fired) OR the sink was disabled
 * by the user toggle (never-recorded) — the result payload's
 * `evidenceEnabled` object disambiguates the two null states (rule 4b,
 * three-state honesty: collected / enabled-but-failed / never-recorded).
 */
struct SessionEvidence {
  var rawPcmPath: String?
  var sensorLogPath: String?
  var ringBufferDir: String?  // always nil for video sessions (ring is photo-only, SPEC §4)

  var asDictionary: [String: Any] {
    [
      "rawPcmPath": rawPcmPath as Any? ?? NSNull(),
      "sensorLogPath": sensorLogPath as Any? ?? NSNull(),
      "ringBufferDir": ringBufferDir as Any? ?? NSNull(),
    ]
  }
}

/**
 * Evidence collection toggles (SPEC rule 4b). Both session APIs accept
 * `evidence?: { ring?: Bool, rawPcm?: Bool, sensors?: Bool }`, default all
 * true. A `false` means DO NOT COLLECT AT ALL: the sink is never started,
 * its result field is null, and it does NOT count against evidenceComplete.
 * The result payload always echoes these flags as `evidenceEnabled` so JS can
 * record never-recorded (enabled=false) vs enabled-but-failed
 * (enabled=true, field=null) — no silent middle states.
 */
struct EvidenceToggles {
  var ring = true
  var rawPcm = true
  var sensors = true

  init(opts: [String: Any]?) {
    guard let dict = opts?["evidence"] as? [String: Any] else { return }
    if let v = dict["ring"] as? Bool { ring = v }
    if let v = dict["rawPcm"] as? Bool { rawPcm = v }
    if let v = dict["sensors"] as? Bool { sensors = v }
  }

  var asDictionary: [String: Any] {
    ["ring": ring, "rawPcm": rawPcm, "sensors": sensors]
  }
}

/// Which media track a hashed byte stream belongs to (SPEC §3: chunking is
/// per-track, tracked separately). Legacy 0.11.x commitment only — see the
/// StreamingHasher class header for what each track's stream really contains
/// (video: nothing; audio: pre-encode LPCM, not delivery bytes).
enum HashTrack: String {
  case video
  case audio

  /// UTF-8 bytes used as the `trackId` component of the chunk hash input
  /// (`trackId || chunkIndex || bytes`, SPEC §3). Wire format, fixed forever:
  ///   trackId — ASCII "video" (5 bytes) or "audio" (5 bytes)
  ///   chunkIndex — UInt64 big-endian
  ///   bytes — the bytes of this chunk, in append order
  var idBytes: [UInt8] { Array(rawValue.utf8) }
}

/// Convert mach absolute time ticks to boot-relative seconds.
/// CMLogItem.timestamp is already boot-relative seconds derived from mach;
/// we keep both representations so the desk can align against either clock.
enum MachClock {
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

  /// Inverse: boot-relative seconds back to (approximate) mach ticks. Used to
  /// tag sensor samples whose native timestamp is already boot-relative with
  /// a mach absolute value (SPEC §5.2: "mach absolute time per sample").
  static func bootSecondsToTicks(_ seconds: Double) -> UInt64 {
    let nanos = seconds * 1_000_000_000.0
    return UInt64((nanos * Double(timebase.denom) / Double(timebase.numer)).rounded())
  }
}

/**
 * Parse a path that may be either a `file://` URI string (what
 * expo-file-system hands JS) or a plain filesystem path. Same rule as
 * AudioCaptureModule: URL(fileURLWithPath:) on a file:// string silently
 * produces a bogus relative path — never do that.
 */
func captureKitURL(for path: String) -> URL? {
  if path.hasPrefix("file://") {
    return URL(string: path)
  }
  return URL(fileURLWithPath: path)
}

/// JSON-number-safe formatting: never emits inf/nan, fixed 6 decimals.
/// JSONL is hand-built per sample (100 Hz); String(format:) is
/// locale-independent for %f and keeps the lines machine-parseable.
func captureKitFixed(_ v: Double, _ places: Int = 6) -> String {
  guard v.isFinite else { return "0" }
  return String(format: "%.\(places)f", v)
}
