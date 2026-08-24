// Validated by an on-device soak checklist, not by CI.
import Foundation
import AVFoundation
import CoreMedia
import ImageIO
import simd

/**
 * Shared value types for the ExhibitCamera module.
 *
 * The camera commits, it never concludes: every field recorded here must be
 * LITERALLY TRUE. If the platform cannot provide a value, we record an
 * explicit null and say so — we never fabricate. Absence is stated, never
 * suspicious; unsupported hardware is unreached, never red.
 *
 * No network I/O of any kind.
 */

// MARK: - Error codes (JS-visible; do not rename — JS matches on these)

enum ExhibitCameraErrorCode {
  static let permission = "E_PERMISSION"       // camera/mic not granted
  static let busy = "E_BUSY"                   // session running / op in flight
  static let noSession = "E_NO_SESSION"        // call requires a running session
  static let platform = "E_PLATFORM"           // device/OS cannot do what was asked
  static let writer = "E_WRITER"               // delivery AVAssetWriter failed
  static let stalePair = "E_STALE_PAIR"        // no fresh synchronized pair at shutter
  static let thermal = "E_THERMAL"             // thermal policy detached/refused a path
  static let hardwareCost = "E_HARDWARE_COST"  // session.hardwareCost > 1.0 after config
  static let sink = "E_SINK"                   // an evidence file write failed
}

// MARK: - Lens / facing / torch enums (values match the TS bridge exactly)

enum ExhibitLens: String {
  case ultraWide
  case wide
  case telephoto

  init(jsValue: String?) {
    self = ExhibitLens(rawValue: jsValue ?? "wide") ?? .wide
  }

  var deviceType: AVCaptureDevice.DeviceType {
    switch self {
    case .ultraWide: return .builtInUltraWideCamera
    case .wide: return .builtInWideAngleCamera
    case .telephoto: return .builtInTelephotoCamera
    }
  }
}

enum ExhibitFacing: String {
  case back
  case front

  init(jsValue: String?) {
    self = ExhibitFacing(rawValue: jsValue ?? "back") ?? .back
  }

  var position: AVCaptureDevice.Position {
    switch self {
    case .back: return .back
    case .front: return .front
    }
  }
}

enum ExhibitTorch: String {
  case off
  case on

  init(jsValue: String?) {
    self = ExhibitTorch(rawValue: jsValue ?? "off") ?? .off
  }
}

/// Photo-strobe preference (W2.2), distinct from the torch: this sets
/// AVCapturePhotoSettings.flashMode on the photo output for stills; the
/// torch stays the video-only continuous light. Values match the TS bridge.
enum ExhibitPhotoFlash: String {
  case auto
  case on
  case off

  init(jsValue: String?) {
    self = ExhibitPhotoFlash(rawValue: jsValue ?? "off") ?? .off
  }

  var avFlashMode: AVCaptureDevice.FlashMode {
    switch self {
    case .auto: return .auto
    case .on: return .on
    case .off: return .off
    }
  }
}

// MARK: - Stereo availability (three states; failure is a fourth thing, per spec §7)

/// 'available' — multicam supported, both back devices present, calibration
///                 delivery supported, hardwareCost ≤ 1.0 at probe time.
/// 'unsupported' — hardware/OS cannot do stereo. Unreached, never red.
/// 'unreached' — not probed, permissions missing, or module absent.
enum StereoAvailability: String {
  case available
  case unsupported
  case unreached
}

// MARK: - EvidencePath (three-state honesty, spec §5)

/// Every committed artifact reports one of exactly three states:
///   { state: 'path', path } — the file exists on disk
///   { state: 'error', code, message } — attempted, failed; stated
///   { state: 'never-recorded', reason } — not attempted (toggle off /
///                                             unsupported); unreached, never red
enum EvidencePathBuilder {
  static func path(_ p: String) -> [String: Any] {
    ["state": "path", "path": p]
  }
  static func error(_ code: String, _ message: String) -> [String: Any] {
    ["state": "error", "code": code, "message": message]
  }
  static func neverRecorded(_ reason: String) -> [String: Any] {
    ["state": "never-recorded", "reason": reason]
  }
}

// MARK: - Calibration serialization (spec §4.2 — commit the inputs)

/// Serialize an AVCameraCalibrationData to a JSON-able dictionary (~2 KB).
/// LUTs ride as float arrays. All values are exactly what the OS delivered;
/// the desk undistorts and fits geometry — nothing here is interpreted.
enum CalibrationSerializer {

  static func dictionary(from calibration: AVCameraCalibrationData, deviceLabel: String) -> [String: Any] {
    let intr = calibration.intrinsicMatrix // matrix_float3x3
    let extr = calibration.extrinsicMatrix // matrix_float4x3
    return [
      "device": deviceLabel,
      // simd stores column-major; we emit row-major with the convention stated.
      "intrinsicMatrixRowMajor": [
        intr.columns.0.x, intr.columns.1.x, intr.columns.2.x,
        intr.columns.0.y, intr.columns.1.y, intr.columns.2.y,
        intr.columns.0.z, intr.columns.1.z, intr.columns.2.z,
      ],
      "intrinsicMatrixReferenceDimensions": [
        "width": Double(calibration.intrinsicMatrixReferenceDimensions.width),
        "height": Double(calibration.intrinsicMatrixReferenceDimensions.height),
      ],
      "extrinsicMatrixRowMajor": [
        extr.columns.0.x, extr.columns.1.x, extr.columns.2.x, extr.columns.3.x,
        extr.columns.0.y, extr.columns.1.y, extr.columns.2.y, extr.columns.3.y,
        extr.columns.0.z, extr.columns.1.z, extr.columns.2.z, extr.columns.3.z,
      ],
      "pixelSizeMicrometers": Double(calibration.pixelSize),
      "lensDistortionCenter": [
        "x": Double(calibration.lensDistortionCenter.x),
        "y": Double(calibration.lensDistortionCenter.y),
      ],
      "lensDistortionLookupTable": floatArray(from: calibration.lensDistortionLookupTable) as Any? ?? NSNull(),
      "inverseLensDistortionLookupTable": floatArray(from: calibration.inverseLensDistortionLookupTable) as Any? ?? NSNull(),
    ]
  }

  private static func floatArray(from data: Data?) -> [Float]? {
    guard let data = data, data.count % MemoryLayout<Float>.size == 0 else { return nil }
    return data.withUnsafeBytes { raw -> [Float] in
      guard let base = raw.baseAddress?.assumingMemoryBound(to: Float.self) else { return [] }
      return Array(UnsafeBufferPointer(start: base, count: data.count / MemoryLayout<Float>.size))
    }
  }

  static func writeJSON(_ dict: [String: Any], to url: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys])
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }
}

// MARK: - Anti-banding (CaptureKit §5.4 pattern — region-derived, never measured)

/// iOS exposes NO anti-banding query API; mainsHz is derived from the locale
/// region. The literal note "region-derived" is part of the contract.
struct ExhibitAntiBanding {
  static func mainsHz() -> Int {
    let region: String?
    if #available(iOS 16.0, *) {
      region = Locale.current.region?.identifier
    } else {
      region = Locale.current.regionCode
    }
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
}

// MARK: - Mach clock (own copy — separate pod target from CaptureKit)

enum ExhibitMachClock {
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

  /// Boot-relative seconds back to (approximate) mach ticks, to tag IMU
  /// samples whose native CMLogItem.timestamp is already boot-relative
  /// (CaptureKit SPEC §5.2: every sample carries BOTH clocks). Input is
  /// non-negative by construction (uptime-derived).
  static func bootSecondsToTicks(_ seconds: Double) -> UInt64 {
    let nanos = max(0.0, seconds) * 1_000_000_000.0
    return UInt64((nanos * Double(timebase.denom) / Double(timebase.numer)).rounded())
  }
}

// MARK: - Path parsing (CaptureKit pattern: file:// vs plain path)

func exhibitCameraURL(for path: String) -> URL? {
  if path.hasPrefix("file://") {
    return URL(string: path)
  }
  return URL(fileURLWithPath: path)
}

// MARK: - Device mode mappers (spec §5 — device-reported enums, mapped + raw)

/// The module's SETTER vocabulary ('auto'|'locked'|'custom' etc.) is the
/// requested intent; the metadata block commits what the DEVICE reports.
/// Device enums are emitted both mapped (stable string) and raw (Int) so
/// nothing is lost in translation.
enum DeviceModeMapper {
  /// .continuousAutoExposure /.autoExpose → 'auto';.locked → 'locked';
  /// .custom → 'custom'.
  static func exposureMode(_ mode: AVCaptureDevice.ExposureMode) -> String {
    switch mode {
    case .continuousAutoExposure, .autoExpose: return "auto"
    case .locked: return "locked"
    case .custom: return "custom"
    @unknown default: return "unknown"
    }
  }

  /// .autoFocus → 'auto';.continuousAutoFocus → 'continuous';
  /// .locked → 'locked'. NOTE: the device cannot distinguish 'locked' from
  /// 'manual' (locked with an explicit lensPosition) — both report
  /// 'locked'; the manual intent is visible via lensPosition + 'locked'.
  static func focusMode(_ mode: AVCaptureDevice.FocusMode) -> String {
    switch mode {
    case .autoFocus: return "auto"
    case .continuousAutoFocus: return "continuous"
    case .locked: return "locked"
    @unknown default: return "unknown"
    }
  }

  /// .autoWhiteBalance → 'auto';.continuousAutoWhiteBalance →
  /// 'continuous';.locked → 'locked'. Same locked/manual conflation as
  /// focus: manual white balance IS mode-locked with explicit gains.
  static func whiteBalanceMode(_ mode: AVCaptureDevice.WhiteBalanceMode) -> String {
    switch mode {
    case .autoWhiteBalance: return "auto"
    case .continuousAutoWhiteBalance: return "continuous"
    case .locked: return "locked"
    @unknown default: return "unknown"
    }
  }

  /// Connection-reported video stabilization mode → stable string.
  static func stabilizationMode(_ mode: AVCaptureVideoStabilizationMode) -> String {
    switch mode {
    case .off: return "off"
    case .standard: return "standard"
    case .cinematic: return "cinematic"
    case .auto: return "auto"
    @unknown default: return "unknown"
    }
  }

  /// OS-reported thermal state (ProcessInfo) → stable string. Reported by
  /// the OS, never measured by us (M1/C6).
  static func thermalState(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  /// Device-reported strobe mode → the bridge's 'auto'|'on'|'off' vocabulary.
  static func flashMode(_ mode: AVCaptureDevice.FlashMode) -> String {
    switch mode {
    case .auto: return "auto"
    case .on: return "on"
    case .off: return "off"
    @unknown default: return "unknown"
    }
  }
}

// MARK: - Digital-zoom quality caps (W2.3 — a quality choice, stated as such)

/// Conservative digital-zoom ceilings (device-zoom factor) per constituent
/// device class. These are an APP-CHOSEN quality bar, NOT hardware limits:
/// past them the frame is a heavy digital crop of the sensor readout, and
/// the app refuses to present that as optical reach. The device's own
/// ceiling (maxAvailableVideoZoomFactor) is always exposed alongside as
/// `hardwareMax` so nothing here hides the hardware number.
enum ExhibitZoomCaps {
  static func qualityCap(for deviceType: AVCaptureDevice.DeviceType) -> Double {
    switch deviceType {
    case .builtInUltraWideCamera: return 2.0
    case .builtInWideAngleCamera: return 3.0
    case .builtInTelephotoCamera: return 2.0
    default: return 2.0
    }
  }
}

// MARK: - Photo EXIF extraction (W2.4 — OS-written values only, never synthesized)

/// Reads the EXIF numbers the OS ITSELF wrote into a captured photo's
/// metadata (AVCapturePhoto.metadata → Exif sub-dictionary) and re-keys
/// them under the standard EXIF tag names the app contract commits. Values
/// pass through verbatim (NSNumber); a tag the OS did not write is ABSENT —
/// never defaulted, never derived.
enum PhotoExifExtractor {

  static func dictionary(from photo: AVCapturePhoto) -> [String: Any] {
    guard let exif = photo.metadata[kCGImagePropertyExifDictionary as String] as? [String: Any] else {
      return [:]
    }
    var out: [String: Any] = [:]
    // (committed contract key, OS metadata key). FocalLenIn35mmFilm is the
    // CGImageProperty spelling of the EXIF FocalLengthIn35mmFilm tag.
    let numeric: [(String, String)] = [
      ("ExposureTime", "ExposureTime"),
      ("FNumber", "FNumber"),
      ("ExposureBiasValue", "ExposureBiasValue"),
      ("FocalLength", "FocalLength"),
      ("FocalLengthIn35mmFilm", "FocalLenIn35mmFilm"),
      ("Flash", "Flash"),
      ("WhiteBalance", "WhiteBalance"),
    ]
    for (contractKey, osKey) in numeric {
      if let value = exif[osKey] as? NSNumber {
        out[contractKey] = value
      }
    }
    // ISOSpeedRatings rides as an array in the OS metadata; commit its first
    // element (the exposure ISO), exactly as written.
    if let isoList = exif["ISOSpeedRatings"] as? [NSNumber], let first = isoList.first {
      out["ISOSpeedRatings"] = first
    }
    return out
  }

  /// EXIF Flash tag, bit 0: the strobe fired. nil when the OS wrote no
  /// Flash tag (no strobe claim at all — stated, never implied).
  static func flashFired(from exif: [String: Any]) -> Bool? {
    guard let value = exif["Flash"] as? NSNumber else { return nil }
    return (value.intValue & 0x1) != 0
  }
}

// MARK: - Delivered-JPEG color space (M1/C6 — the artifact's own claim)

/// Reads the color profile name out of a DELIVERED JPEG's bytes (ImageIO).
/// The artifact speaks for itself: nil when ImageIO reports no profile
/// name — stated, never assumed from the request path.
enum JpegColorSpaceReader {
  static func profileName(from data: Data) -> String? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { return nil }
    return props[kCGImagePropertyProfileName as String] as? String
  }
}

// MARK: - Depth map export (D1, c2pa.depthmap capture side)

/**
 * Canonicalizes a delivered AVDepthData into the committed depth artifact:
 * a 16-bit grayscale PNG of the map AS DELIVERED — disparity or depth per
 * depthDataType, the semantics committed, never converted — min/max
 * normalized with the window committed alongside so source values are
 * recoverable (value = gray/65535 × span + min).
 *
 * Why PNG and not a raw float dump: lossless, byte-deterministic
 * (hashable — the committed sha256 binds these exact bytes), and decodable
 * by the TS/web reader with zero native dependencies. No LiDAR assumption:
 * the source is whatever the photo output genuinely delivered (dual-camera
 * disparity / portrait pipeline on iPhone 17).
 *
 * nil when the map cannot be exported honestly (unknown pixel type, no
 * finite samples, encode failure) — a stated absence, never a fabricated
 * map.
 */
enum ExhibitDepthMapExtractor {

  struct Outcome {
    let png: Data
    let metadata: [String: Any]
  }

  static func extract(from depthData: AVDepthData, photoWidth: Int?, photoHeight: Int?) -> Outcome? {
    // Map semantics from the delivered pixel format; Float16 STORAGE is
    // converted to Float32 for reading (storage only — semantics kept).
    let mapSemantics: String
    var data = depthData
    switch data.depthDataType {
    case kCVPixelFormatType_DisparityFloat32:
      mapSemantics = "disparity"
    case kCVPixelFormatType_DisparityFloat16:
      mapSemantics = "disparity"
      data = data.converting(toDepthDataType: kCVPixelFormatType_DisparityFloat32)
    case kCVPixelFormatType_DepthFloat32:
      mapSemantics = "depth"
    case kCVPixelFormatType_DepthFloat16:
      mapSemantics = "depth"
      data = data.converting(toDepthDataType: kCVPixelFormatType_DepthFloat32)
    default:
      return nil
    }

    let map = data.depthDataMap
    CVPixelBufferLockBaseAddress(map, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(map, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(map) else { return nil }
    let width = CVPixelBufferGetWidth(map)
    let height = CVPixelBufferGetHeight(map)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(map)
    guard width > 0, height > 0, bytesPerRow >= width * MemoryLayout<Float>.size else { return nil }

    // Min/max over FINITE samples only; non-finite pixels (invalid
    // disparity holes) stay 0 in the PNG and are counted, stated.
    var minValue = Float.greatestFiniteMagnitude
    var maxValue = -Float.greatestFiniteMagnitude
    var nonFinite = 0
    for row in 0..<height {
      let rowBase = base.advanced(by: row * bytesPerRow).assumingMemoryBound(to: Float.self)
      for col in 0..<width {
        let value = rowBase[col]
        if value.isFinite {
          if value < minValue { minValue = value }
          if value > maxValue { maxValue = value }
        } else {
          nonFinite += 1
        }
      }
    }
    guard minValue <= maxValue else { return nil } // no finite samples at all
    let span = maxValue - minValue

    var pixels = [UInt16](repeating: 0, count: width * height)
    for row in 0..<height {
      let rowBase = base.advanced(by: row * bytesPerRow).assumingMemoryBound(to: Float.self)
      for col in 0..<width {
        let value = rowBase[col]
        guard value.isFinite, span > 0 else { continue } // stays 0, stated via window
        let scaled = (value - minValue) / span * 65535.0
        pixels[row * width + col] = UInt16(min(max(scaled, 0), 65535).rounded())
      }
    }

    let pixelData = Data(bytes: &pixels, count: pixels.count * MemoryLayout<UInt16>.size)
    guard let gray = CGColorSpace(name: CGColorSpace.linearGray),
          let provider = CGDataProvider(data: pixelData as CFData),
          let image = CGImage(
            width: width,
            height: height,
            bitsPerComponent: 16,
            bitsPerPixel: 16,
            bytesPerRow: width * MemoryLayout<UInt16>.size,
            space: gray,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue | CGBitmapInfo.byteOrder16Little.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
          ) else { return nil }

    // "public.png" as a literal CFString: kUTTypePNG is deprecated on the
    // iOS 15 SDK floor and UTType would need a UniformTypeIdentifiers
    // import — the UTI string is stable and ImageIO accepts it directly.
    let pngData = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(pngData, "public.png" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { return nil }

    let accuracy: String
    switch data.depthDataAccuracy {
    case .relative: accuracy = "relative"
    case .absolute: accuracy = "absolute"
    @unknown default: accuracy = "unknown"
    }

    var metadata: [String: Any] = [
      "mime": "image/png",
      "mapSemantics": mapSemantics,
      // We request UNFILTERED depth (isDepthDataFilteredEnabled untouched —
      // platform default off): the request is stated; the pipeline's own
      // filtering choices beyond it are not knowable, never claimed.
      "filtered": false,
      "width": width,
      "height": height,
      "accuracy": accuracy,
      "accuracyRaw": data.depthDataAccuracy.rawValue,
      // The normalization window: source value = gray/65535 × span + min.
      "normalizationMin": Double(minValue),
      "normalizationMax": Double(maxValue),
      "nonFinitePixelCount": nonFinite,
      "note": "16-bit grayscale PNG, min/max-normalized; map semantics as delivered, never converted",
    ]
    metadata["photoWidth"] = photoWidth as Any? ?? NSNull()
    metadata["photoHeight"] = photoHeight as Any? ?? NSNull()
    return Outcome(png: pngData as Data, metadata: metadata)
  }
}

// MARK: - Capture settings block (W2.4 — every setting committed from a device read)

/// Builds the committed capture-settings dictionary: the full camera state
/// at shutter time. Every value is read back from the AVCaptureDevice at
/// commit time (labeled controlsReportedBy:'device') or is an explicit
/// null; flash/EXIF facts the photo path owns arrive as null here and are
/// merged by the full-res capture completion (mergeFullRes) — a null is a
/// stated absence, never a fabrication.
enum CaptureSettingsBuilder {

  static func dictionary(
    for device: AVCaptureDevice,
    photoFlash: ExhibitPhotoFlash,
    flashSupportedModes: [String],
    activeStabilizationMode: String?
  ) -> [String: Any] {
    // exposureDuration is a CMTime; invalid/indefinite while not streaming.
    var exposureSec: Double? = nil
    let t = device.exposureDuration
    if t.isValid && !t.isIndefinite {
      let s = CMTimeGetSeconds(t)
      if s.isFinite && s > 0 { exposureSec = s }
    }

    // deviceWhiteBalanceGains can be mid-transition; garbage gains are worse
    // than a stated null (same gate as MetadataBlockBuilder).
    var wbGains: [String: Float]? = nil
    let gains = device.deviceWhiteBalanceGains
    if gains.redGain >= 1.0, gains.greenGain >= 1.0, gains.blueGain >= 1.0,
       gains.redGain <= device.maxWhiteBalanceGain,
       gains.greenGain <= device.maxWhiteBalanceGain,
       gains.blueGain <= device.maxWhiteBalanceGain {
      wbGains = ["r": gains.redGain, "g": gains.greenGain, "b": gains.blueGain]
    }

    // Temperature/tint via the OS's own converter FROM the device-reported
    // gains (W2.4). Committed whenever the gains are valid — outside WB
    // lock the values are transient, which the note states. The conversion
    // itself is platform code, not our estimate.
    var wbTempTint: [String: Any]? = nil
    if let wb = wbGains {
      let tt = device.temperatureAndTintValues(
        for: AVCaptureDevice.WhiteBalanceGains(
          redGain: wb["r"] ?? 1, greenGain: wb["g"] ?? 1, blueGain: wb["b"] ?? 1
        )
      )
      wbTempTint = [
        "temperature": tt.temperature,
        "tint": tt.tint,
        "note": "computed from device-reported gains via temperatureAndTintValues(for:); transient unless whiteBalanceMode is locked",
      ]
    }

    // ---- zoom/crop geometry (M1/C1): the delivered image is the format
    // readout CENTER-CROPPED by videoZoomFactor when > 1 (iOS digital zoom
    // is a symmetric crop; past an optical stop the DEVICE changes, which
    // physicalDevice already commits). The committed crop inputs make the
    // DELIVERED image's effective focal length (× zoomFactor) and effective
    // FOV derivable — inputs committed, answers never computed. Read from
    // the device at this commit instant, never configure-time state.
    let format = device.activeFormat
    let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    let zoomFactor = Double(device.videoZoomFactor)
    var sensorCrop: [String: Any] = [
      "applied": zoomFactor > 1.0,
      "mode": "center-crop (iOS digital zoom) — derived from device-reported videoZoomFactor, not measured",
      "zoomFactor": zoomFactor,
      "width": Int((Double(dims.width) / zoomFactor).rounded()),
      "height": Int((Double(dims.height) / zoomFactor).rounded()),
      "outputDimensions": ["width": Int(dims.width), "height": Int(dims.height)],
    ]
    // Center Stage (front ultra-wide): the module never enables it, so this
    // is expected false — committed as the OS-REPORTED fact, rect included
    // when the OS says it is active. iOS 16+ API: gated (the pod targets
    // 15.1); on older OSes the keys are OMITTED, never fabricated.
    if #available(iOS 16.0, *) {
      sensorCrop["centerStageActive"] = device.isCenterStageActive
      if device.isCenterStageActive {
        let rect = device.centerStageRectOfInterest
        sensorCrop["centerStageRectOfInterest"] = [
          "x": Double(rect.origin.x), "y": Double(rect.origin.y),
          "width": Double(rect.width), "height": Double(rect.height),
        ]
      }
    }
    // 35mm-equivalent focal length: no direct API — derived from the
    // device-reported horizontal FOV on a 36 mm reference (18/tan(hfov/2)).
    // UNCROPPED-format value; the delivered crop's equivalent is × zoomFactor.
    let hfovRadians = Double(format.videoFieldOfView) * .pi / 180.0
    let focal35mm: Double? = hfovRadians > 0 ? 18.0 / tan(hfovRadians / 2.0) : nil

    var out: [String: Any] = [
      // Honesty note (W2.1): the DELIVERY still's pixels come from the
      // synchronized video frame at session resolution — resampled, not a
      // full-sensor readout. The full-sensor still is the separate
      // fullResStill artifact with its own hash.
      "deliveryStillSource": "video-frame, resampled from the session-resolution stream",
      "iso": Double(device.iso),
      "exposureDurationSec": exposureSec as Any? ?? NSNull(),
      "lensPosition": Double(device.lensPosition),
      "whiteBalanceGains": wbGains as Any? ?? NSNull(),
      "whiteBalanceTemperatureTint": wbTempTint as Any? ?? NSNull(),
      "apertureFNumber": Double(device.lensAperture),
      "exposureTargetBias": Double(device.exposureTargetBias),
      "videoZoomFactor": Double(device.videoZoomFactor),
      // Zoom/crop geometry + derived 35mm-equivalent (M1/C1) — see the
      // locals above; the delivered image is the crop these inputs describe.
      "sensorCrop": sensorCrop,
      "focalLength35mmEquivalent": focal35mm as Any? ?? NSNull(),
      // OS-REPORTED thermal state at the commit instant (ProcessInfo — the
      // same source the thermal policy reads; reported by the OS, not
      // measured) (M1/C6).
      "thermalState": DeviceModeMapper.thermalState(ProcessInfo.processInfo.thermalState),
      "thermalStateRaw": ProcessInfo.processInfo.thermalState.rawValue,
      "exposureMode": DeviceModeMapper.exposureMode(device.exposureMode),
      "focusMode": DeviceModeMapper.focusMode(device.focusMode),
      "whiteBalanceMode": DeviceModeMapper.whiteBalanceMode(device.whiteBalanceMode),
      "physicalDevice": device.deviceType.rawValue,
      // Photo-strobe facts (W2.2/W2.4). flashFired stays null until the
      // full-res photo's own metadata answers; no photo → no strobe claim.
      "photoFlashMode": photoFlash.rawValue,
      "photoFlashHardware": device.hasFlash,
      "photoFlashSupportedModes": flashSupportedModes,
      "flashFired": NSNull(),
      // OS-written EXIF numbers from the full-res photo's metadata (merged
      // later by mergeFullRes); null when no full-res photo ran this
      // shutter. NEVER synthesized from device state.
      "photoExif": NSNull(),
      // iOS exposes no device focal-length-in-mm property; the full-res
      // photo's EXIF FocalLength is the only honest mm source and rides in
      // photoExif. The desk-facing mm derivation from committed calibration
      // stays in the stereo glue.
      "controlsReportedBy": "device",
    ]
    // The stabilization mode ACTUALLY in force at the commit instant
    // (activeVideoStabilizationMode — API-self-reported, not measured)
    // (M1/C6). OMITTED when the connection reported nothing — never
    // fabricated from the preferred mode.
    if let activeStabilizationMode = activeStabilizationMode {
      out["stabilizationModeActive"] = activeStabilizationMode
    }
    return out
  }
}

// MARK: - Metadata block (spec §5 — commit inputs, never computed answers)

/// Builds the per-device camera metadata dictionary. Every value is read
/// from the device at capture time or is an explicit null. The pro-control
/// fields (spec §14) are DEVICE-REPORTED applied values — the honesty win
/// is that manual decisions become signed evidence — and are labeled via
/// `controlsReportedBy: 'device'`.
enum MetadataBlockBuilder {

  static func dictionary(
    for device: AVCaptureDevice,
    calibration: AVCameraCalibrationData?,
    hardwareCost: Float,
    synchronizedDeltaMs: Double?,
    droppedPairCount: Int,
    formatID: String?,
    stabilizationMode: String?,
    activeStabilizationMode: String?,
    hdrEnabled: Bool?,
    configuredFPS: Double
  ) -> [String: Any] {
    // exposureDuration is a CMTime; invalid/indefinite while not streaming.
    var exposureSec: Double? = nil
    let t = device.exposureDuration
    if t.isValid && !t.isIndefinite {
      let s = CMTimeGetSeconds(t)
      if s.isFinite && s > 0 { exposureSec = s }
    }

    // deviceWhiteBalanceGains can be mid-transition; garbage gains are worse
    // than a stated null.
    var wb: [String: Float]? = nil
    let gains = device.deviceWhiteBalanceGains
    if gains.redGain >= 1.0, gains.greenGain >= 1.0, gains.blueGain >= 1.0,
       gains.redGain <= device.maxWhiteBalanceGain,
       gains.greenGain <= device.maxWhiteBalanceGain,
       gains.blueGain <= device.maxWhiteBalanceGain {
      wb = ["r": gains.redGain, "g": gains.greenGain, "b": gains.blueGain]
    }

    // Pixel focal length comes from the committed calibration, not from
    // marketing mm numbers. Null when the OS delivered no calibration.
    var focalPixels: [String: Double]? = nil
    if let cal = calibration {
      focalPixels = [
        "fx": Double(cal.intrinsicMatrix.columns.0.x),
        "fy": Double(cal.intrinsicMatrix.columns.1.y),
      ]
    }

    // White-balance temperature/tint: computed FROM the device-reported
    // gains via the OS's own converter — only meaningful when the device
    // reports mode-locked (manual white balance IS locked-with-gains).
    // Outside locked mode the conversion is still well-defined but the
    // values are transient; we commit them only when locked, stated.
    var wbTempTint: [String: Any]? = nil
    if device.whiteBalanceMode == .locked, let wb = wb {
      let tt = device.temperatureAndTintValues(
        for: AVCaptureDevice.WhiteBalanceGains(
          redGain: wb["r"] ?? 1, greenGain: wb["g"] ?? 1, blueGain: wb["b"] ?? 1
        )
      )
      wbTempTint = [
        "temperature": tt.temperature,
        "tint": tt.tint,
        "note": "computed from device-reported gains via temperatureAndTintValues(for:)",
      ]
    }

    let format = device.activeFormat
    let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)

    // ---- zoom/crop geometry (M1/C1): the delivered image is the format
    // readout CENTER-CROPPED by videoZoomFactor when > 1 (iOS digital zoom
    // is a symmetric crop; past an optical stop the DEVICE changes, which
    // physicalDevice/formatID already commit). focalLengthPixels and
    // fieldOfViewDegrees below describe the UNCROPPED format; the inputs
    // here make the DELIVERED image's effective focal length (× zoomFactor)
    // and effective FOV derivable — inputs committed, answers never
    // computed. videoZoomFactor is the SAME device property
    // CaptureSettingsBuilder commits, read at this same commit instant —
    // the two blocks agree by construction.
    let zoomFactor = Double(device.videoZoomFactor)
    var sensorCrop: [String: Any] = [
      "applied": zoomFactor > 1.0,
      "mode": "center-crop (iOS digital zoom) — derived from device-reported videoZoomFactor, not measured",
      "zoomFactor": zoomFactor,
      "width": Int((Double(dims.width) / zoomFactor).rounded()),
      "height": Int((Double(dims.height) / zoomFactor).rounded()),
      "outputDimensions": ["width": Int(dims.width), "height": Int(dims.height)],
    ]
    // Center Stage (front ultra-wide): the module never enables it, so this
    // is expected false — committed as the OS-REPORTED fact, rect included
    // when the OS says it is active. iOS 16+ API: gated (the pod targets
    // 15.1); on older OSes the keys are OMITTED, never fabricated.
    if #available(iOS 16.0, *) {
      sensorCrop["centerStageActive"] = device.isCenterStageActive
      if device.isCenterStageActive {
        let rect = device.centerStageRectOfInterest
        sensorCrop["centerStageRectOfInterest"] = [
          "x": Double(rect.origin.x), "y": Double(rect.origin.y),
          "width": Double(rect.width), "height": Double(rect.height),
        ]
      }
    }
    // 35mm-equivalent focal length: no direct API — derived from the
    // device-reported horizontal FOV on a 36 mm reference (18/tan(hfov/2)).
    // UNCROPPED-format value; the delivered crop's equivalent is × zoomFactor.
    let hfovRadians = Double(format.videoFieldOfView) * .pi / 180.0
    let focal35mm: Double? = hfovRadians > 0 ? 18.0 / tan(hfovRadians / 2.0) : nil

    return [
      "physicalDevice": device.deviceType.rawValue,
      "modelID": device.modelID,
      // ---- pro controls (spec §14): ACTUAL applied values, device-reported ----
      "exposureMode": DeviceModeMapper.exposureMode(device.exposureMode),
      "exposureModeRaw": device.exposureMode.rawValue,
      "exposureDurationSec": exposureSec as Any? ?? NSNull(),
      "iso": Double(device.iso),
      "exposureBias": Double(device.exposureTargetBias),
      "focusMode": DeviceModeMapper.focusMode(device.focusMode),
      "focusModeRaw": device.focusMode.rawValue,
      "lensPosition": Double(device.lensPosition),
      "whiteBalanceMode": DeviceModeMapper.whiteBalanceMode(device.whiteBalanceMode),
      "whiteBalanceModeRaw": device.whiteBalanceMode.rawValue,
      "whiteBalanceGains": wb as Any? ?? NSNull(),
      "whiteBalanceTemperatureTint": wbTempTint as Any? ?? NSNull(),
      // torchLevel is 0 when off; null on devices with no torch hardware.
      "torchLevel": device.hasTorch ? Double(device.torchLevel) as Any : NSNull(),
      "formatID": formatID as Any? ?? NSNull(),
      "stabilizationMode": stabilizationMode as Any? ?? NSNull(),
      // The mode ACTUALLY in force on the connection at the commit instant
      // (activeVideoStabilizationMode — API-self-reported, not measured;
      // stabilizationMode above is the PREFERRED mode) (M1/C6).
      "stabilizationModeActive": activeStabilizationMode as Any? ?? NSNull(),
      "hdrEnabled": hdrEnabled as Any? ?? NSNull(),
      // OS-REPORTED thermal state at the commit instant (ProcessInfo — the
      // same source the thermal policy reads; reported by the OS, not
      // measured) (M1/C6).
      "thermalState": DeviceModeMapper.thermalState(ProcessInfo.processInfo.thermalState),
      "thermalStateRaw": ProcessInfo.processInfo.thermalState.rawValue,
      // Every field above is read back from the device/connection, never
      // from the module's request log. Labeled as such.
      "controlsReportedBy": "device",
      // iOS exposes NO public focus-distance-in-meters API. Stated null,
      // never fabricated from lensPosition (spec §5).
      "focusDistanceMeters": NSNull(),
      "focalLengthPixels": focalPixels as Any? ?? NSNull(),
      "fieldOfViewDegrees": Double(format.videoFieldOfView),
      // Zoom/crop geometry for the DELIVERED image (M1/C1) — the
      // focalLengthPixels/FOV above are the UNCROPPED format; these inputs
      // describe the crop actually delivered. See the locals above.
      "videoZoomFactor": zoomFactor,
      "sensorCrop": sensorCrop,
      "focalLength35mmEquivalent": focal35mm as Any? ?? NSNull(),
      "apertureFNumber": Double(device.lensAperture),
      "antiBanding": [
        "mainsHz": ExhibitAntiBanding.mainsHz(),
        "exposureSec": exposureSec as Any? ?? NSNull(),
        "note": "region-derived",
      ],
      "activeFormat": [
        "width": Int(dims.width),
        "height": Int(dims.height),
        "fps": configuredFPS, // configured frame duration; actuals ride in the PTS timestamps
      ],
      "hardwareCost": Double(hardwareCost),
      "synchronizedDeltaMs": synchronizedDeltaMs as Any? ?? NSNull(),
      "droppedPairCount": droppedPairCount,
      // Every iOS frame passes through the platform's computational pipeline
      // (deep-fusion-class on supported devices). Stated so no manifest ever
      // implies "unprocessed sensor data" for a JPEG (spec §10).
      "platformProcessing": "apple-default-pipeline",
    ]
  }
}


// MARK: - Rotation + mirroring policy ( per-device, never hardcoded)

/**
 * Every connection's horizon-level rotation angle comes from
 * AVCaptureDevice.RotationCoordinator — NEVER a hardcoded constant.
 *
 * Why (root cause of the iPhone 17 sideways-selfie bug): iPhone 17's
 * Center Stage front camera has a PORTRAIT-mounted sensor (WWDC 2026
 * session 341 — the front sensor changed from landscape-left to portrait;
 * Apple: "If your app relies on rotation values that worked before, photos
 * may appear sideways or upside down"). The 90° constant that fits every
 * landscape-mounted sensor renders front-camera preview, video, and stills
 * SIDEWAYS on that hardware. The coordinator reads the actual sensor
 * mounting and returns the correct angle per device (90° for legacy
 * landscape-mounted sensors, 0° for the portrait-mounted front sensor, in
 * this portrait-locked app). Read once per connection setup — the app is
 * portrait-locked, so the angle is stable per device; lens swaps and
 * session rebuilds re-apply it (applyConnectionPolicies / configureSession).
 *
 * Consumers: AVCaptureVideoDataOutput connections PHYSICALLY rotate their
 * delivered buffers by this angle (see configureSession's ORIENTATION
 * CONTRACT — the writer transform stays.identity); AVCapturePhotoOutput
 * applies its own pixel compensation from its connection's angle, so photo
 * connections need the same policy.
 *
 * Mirroring: preview layers auto-mirror the front camera; data and photo
 * outputs DO NOT (same session: "use isVideoMirrored on video data
 * outputs"). We set it EXPLICITLY — front connections mirror, so the
 * committed pixels match the mirrored preview the user composed on — and
 * the actual connection value is committed (frontMirrored in the capture
 * payload), never implied.
 */
@available(iOS 17.0, *)
enum RotationPolicy {

  /// Horizon-level CAPTURE angle for a device's data/photo connections.
  static func captureAngle(for device: AVCaptureDevice) -> CGFloat {
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
    return coordinator.videoRotationAngleForHorizonLevelCapture
  }

  /// Horizon-level PREVIEW angle for a device's preview-layer connection.
  static func previewAngle(for device: AVCaptureDevice, previewLayer: AVCaptureVideoPreviewLayer) -> CGFloat {
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
    return coordinator.videoRotationAngleForHorizonLevelPreview
  }

  /// One policy for every connection kind: coordinator angle + explicit
  /// front-camera mirroring. Call with the preview layer for preview-bound
  /// connections (its angle can differ from the capture angle), nil for
  /// data/photo connections.
  static func apply(to connection: AVCaptureConnection, device: AVCaptureDevice, previewLayer: AVCaptureVideoPreviewLayer? = nil) {
    let angle = previewLayer.map { previewAngle(for: device, previewLayer: $0) } ?? captureAngle(for: device)
    if connection.isVideoRotationAngleSupported(angle) {
      connection.videoRotationAngle = angle
    }
    if connection.isVideoMirroringSupported {
      // Explicit, never inherited: data/photo connections default to NOT
      // mirroring while the preview the user composed on does.
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = (device.position == .front)
    }
  }
}

// MARK: - W7 isolation debug flags (photo-path wave-5/6 suspects)

/**
 * Runtime-flippable switches for the wave-7 isolation build, flipped from
 * Settings ▸ Diagnostics to A/B the universal photo-path changes against
 * the failure (every photo capture failing on iPhone 17 since wave
 * 5, even with stereo off). default split — see the key notes:
 * photoConnectionRotation still defaults false (pre-wave-5 behavior);
 * photoMaxDimensionsPolicy now defaults TRUE; the
 * sessionCalibrationPhoto and thirdViewEnabled keys default FALSE:
 *   - photoConnectionRotation — wave-5 RotationPolicy on PHOTO-output
 *                                 connections (data/preview rotation stays
 *                                 unconditional; it fixed real bugs).
 *   - photoMaxDimensionsPolicy — wave-6 maxPhotoDimensions clamp (≤12 MP)
 *                                 on photo outputs + degraded-path settings.
 * verdict folded in: the maxPhotoDimensions clamp is ON by default
 * (unset suite = ON; the flag is now the escape hatch to reproduce the
 * pre-clamp reservation), and the session-calibration one-shot is OFF by
 * default behind the new sessionCalibrationPhoto key — see the key notes.
 * Backed by a UserDefaults suite so the flags survive a session rebuild
 * and are readable from any queue. Isolation scaffolding, not a product
 * surface — remove with the wave-7 verdict.
 */
enum ExhibitDebugFlags {
  static let suite = "exhibit.debug"
  static let photoConnectionRotationKey = "photoConnectionRotation"
  static let photoMaxDimensionsPolicyKey = "photoMaxDimensionsPolicy"
  static let depthCaptureKey = "depthCapture"
  /// the session-calibration dual-photo one-shot on the live
  /// multi-cam graph. Default FALSE — the flood (primary-half
  /// drops 0, secondary-half drops 100%, onset ~1 s into the session =
  /// exactly when the one-shot fired; build-26 showed a photo capture can
  /// leave an output unwilling to deliver afterward) names it the primary
  /// suspect for the dead secondary stream. With it off, the "full"
  /// calibration block commits 'unavailable' (stated, never fabricated);
  /// per-frame intrinsics ride the frame attachments, unaffected.
  /// INERT — the one-shot is retired (no call site remains) and the
  /// settings switch is gone; the key stays registered so a stale flipped
  /// value in the suite reads as a no-op, not an unknown-key error.
  static let sessionCalibrationPhotoKey = "sessionCalibrationPhoto"
  /// EXTENSION-POINT GATE for the opportunistic third synchronized
  /// view. UNTESTED ON HARDWARE — must stay OFF in shipping builds until an
  /// on-device soak validates the path. Default FALSE; the probe result is
  /// reported via capabilities.thirdViewCapable regardless.
  static let thirdViewEnabledKey = "thirdViewEnabled"
  ///  –: A/B for the dual-wide VIRTUAL-device rear-stereo graph.
  /// SUPERSEDED by legacyVirtualGraphKey with the default flipped
  /// back to multi-input (see that key's note). This key stays registered so
  /// a stale flipped value in the suite reads as a no-op, not an
  /// unknown-key error.
  static let legacyMultiInputGraphKey = "legacyMultiInputGraph"
  /// A/B for the dual-wide VIRTUAL-device graph, no longer
  /// the default. DEFAULT FALSE = the two-device-input graph (physical wide
  /// primary + physical ultra-wide secondary) is the rear-stereo default.
  /// Why the flip: the diagnostics caught the virtual device
  /// reporting range=2.0–4.0 on iPhone 17 (iOS 26.6) — with the ultra-wide
  /// constituent streaming its own port for the secondary feed, the virtual
  /// device's available zoom collapses to the wide-only zone and every
  /// 0.5/1x request clamps to 2.0 ("zoom measure moves, image doesn't",
  /// "stuck on 2 by default"). The product spec is primary wide at a true
  /// 1x default with a free sweep + secondary UW fixed at 0.5x — only the
  /// two-device-input graph delivers that. The reason for preferring
  /// virtual (multi-input accepted the wiring but never delivered a single
  /// secondary frame, zero callbacks) lost its prime suspect: the
  /// secondary photo output, present in EVERY dead session, is gone from
  /// both graphs since. If the silent-delivery class ever reappears, the
  /// secondary-delivery watchdog names it in Diagnostics within seconds.
  /// Flip ON only to A/B the old graph.
  /// ────────────────────────────────────────────────────────────────────
  /// DO NOT USE — kept in code for the open-source agent and for
  /// stale-suite no-op safety ONLY. The settings row is gone from the
  /// interface: the two-device-input graph is unambiguously the better
  /// pipeline (true 1x wide + free zoom + fixed 0.5x second view; the
  /// virtual graph's 2×–4× pin is documented above) and a persisted flip
  /// survives TestFlight updates, silently contaminating future field runs.
  /// Nothing in the app should set this key; if you are the open-source
  /// agent reading this tree, leave it OFF and prefer deleting the virtual
  /// path outright over reviving the switch.
  /// ────────────────────────────────────────────────────────────────────
  static let legacyVirtualGraphKey = "legacyVirtualGraph"

  static var photoConnectionRotation: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: photoConnectionRotationKey) ?? false
  }
  /// DEFAULT FLIP: the ≤12 MP maxPhotoDimensions clamp is now ON by
  /// default — the unclamped 48 MP photo-stream reservation on a live
  /// multi-cam graph was named "the structural suspect for BOTH field
  /// failures" in the note, and the clamp is honest evidence (the
  /// committed dimensions state what actually arrived). The flag remains
  /// settable to false so the wave-7 isolation can still A/B it.
  static var photoMaxDimensionsPolicy: Bool {
    guard let defaults = UserDefaults(suiteName: suite),
          defaults.object(forKey: photoMaxDimensionsPolicyKey) != nil else { return true }
    return defaults.bool(forKey: photoMaxDimensionsPolicyKey)
  }
  /// Default FALSE — see the key's note above.
  static var sessionCalibrationPhoto: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: sessionCalibrationPhotoKey) ?? false
  }
  /// Default FALSE — UNTESTED ON HARDWARE (extension-point gate).
  static var thirdViewEnabled: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: thirdViewEnabledKey) ?? false
  }
  /// INERT — superseded by legacyVirtualGraph (see the key's
  /// note). Read-only leftover so a stale suite value is a no-op.
  static var legacyMultiInputGraph: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: legacyMultiInputGraphKey) ?? false
  }
  /// Default FALSE = the two-device-input graph is the rear-stereo default
  /// . TRUE restores the dual-wide virtual graph for A/B only.
  static var legacyVirtualGraph: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: legacyVirtualGraphKey) ?? false
  }
  /// D1 depth export (feature): default TRUE — depth is a shipped
  /// feature, so an UNSET suite means ON (unlike the W7 isolation flags
  /// above, whose unset means OFF). The flag is the on-device escape
  /// hatch: depth problems are isolable without a rebuild.
  static var depthCapture: Bool {
    guard let defaults = UserDefaults(suiteName: suite),
          defaults.object(forKey: depthCaptureKey) != nil else { return true }
    return defaults.bool(forKey: depthCaptureKey)
  }

  /// Only the known keys are writable; anything else returns false
  /// so a typo in Diagnostics can't silently no-op an isolation run.
  @discardableResult
  static func set(_ key: String, value: Bool) -> Bool {
    guard key == photoConnectionRotationKey || key == photoMaxDimensionsPolicyKey
            || key == depthCaptureKey || key == sessionCalibrationPhotoKey
            || key == thirdViewEnabledKey || key == legacyMultiInputGraphKey
            || key == legacyVirtualGraphKey else { return false }
    UserDefaults(suiteName: suite)?.set(value, forKey: key)
    return true
  }

  static func all() -> [String: Bool] {
    [
      photoConnectionRotationKey: photoConnectionRotation,
      photoMaxDimensionsPolicyKey: photoMaxDimensionsPolicy,
      depthCaptureKey: depthCapture,
      sessionCalibrationPhotoKey: sessionCalibrationPhoto,
      thirdViewEnabledKey: thirdViewEnabled,
      // legacyMultiInputGraphKey is deliberately NOT exposed: the key stays
      // writable (stale suite values no-op) but the flag is inert since
      // and an inert toggle must never render in the debug UI.
      legacyVirtualGraphKey: legacyVirtualGraph,
    ]
  }
}
