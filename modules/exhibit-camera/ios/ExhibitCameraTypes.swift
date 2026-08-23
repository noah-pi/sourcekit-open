import Foundation
import AVFoundation
import CoreMedia
import ImageIO
import simd

/**
 * Shared value types for the ExhibitCamera module. Every recorded field is a
 * value the platform actually reported; where it cannot provide one, the field
 * is an explicit null. No network I/O.
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

/// Photo-strobe preference (W2.2), distinct from the torch: sets
/// AVCapturePhotoSettings.flashMode on the photo output for stills. The torch
/// is the video-only continuous light. Values match the TS bridge.
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

/// 'available'   — multicam supported, both back devices present, calibration
///                 delivery supported, hardwareCost ≤ 1.0 at probe time.
/// 'unsupported' — hardware or OS cannot do stereo.
/// 'unreached'   — not probed, permissions missing, or module absent.
enum StereoAvailability: String {
  case available
  case unsupported
  case unreached
}

// MARK: - EvidencePath (three states, spec §5)

/// Every committed artifact reports one of exactly three states:
///   { state: 'path', path }                 — the file exists on disk
///   { state: 'error', code, message }       — attempted and failed
///   { state: 'never-recorded', reason }     — not attempted (toggle off or
///                                             unsupported)
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

// MARK: - Calibration serialization (spec §4.2: commit the inputs)

/// Serialize an AVCameraCalibrationData to a JSON-able dictionary (~2 KB).
/// LUTs ride as float arrays. Values are exactly what the OS delivered; the
/// desk undistorts and fits geometry.
enum CalibrationSerializer {

  static func dictionary(from calibration: AVCameraCalibrationData, deviceLabel: String) -> [String: Any] {
    let intr = calibration.intrinsicMatrix // matrix_float3x3
    let extr = calibration.extrinsicMatrix // matrix_float4x3
    return [
      "device": deviceLabel,
      // simd stores column-major; emitted row-major, with the convention stated.
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

// MARK: - Anti-banding (CaptureKit §5.4 pattern; region-derived)

/// iOS exposes no anti-banding query API, so mainsHz is derived from the locale
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

// MARK: - Mach clock (own copy; separate pod target from CaptureKit)

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
  /// (CaptureKit SPEC §5.2: every sample carries both clocks). Input is
  /// non-negative by construction.
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

// MARK: - Device mode mappers (spec §5: device-reported enums, mapped and raw)

/// The module's setter vocabulary ('auto'|'locked'|'custom' etc.) is the
/// requested intent; the metadata block commits what the device reports.
/// Device enums are emitted both mapped (stable string) and raw (Int).
enum DeviceModeMapper {
  /// .continuousAutoExposure / .autoExpose → 'auto'; .locked → 'locked';
  /// .custom → 'custom'.
  static func exposureMode(_ mode: AVCaptureDevice.ExposureMode) -> String {
    switch mode {
    case .continuousAutoExposure, .autoExpose: return "auto"
    case .locked: return "locked"
    case .custom: return "custom"
    @unknown default: return "unknown"
    }
  }

  /// .autoFocus → 'auto'; .continuousAutoFocus → 'continuous';
  /// .locked → 'locked'. The device cannot distinguish 'locked' from 'manual'
  /// (locked with an explicit lensPosition); manual intent shows as
  /// lensPosition plus 'locked'.
  static func focusMode(_ mode: AVCaptureDevice.FocusMode) -> String {
    switch mode {
    case .autoFocus: return "auto"
    case .continuousAutoFocus: return "continuous"
    case .locked: return "locked"
    @unknown default: return "unknown"
    }
  }

  /// .autoWhiteBalance → 'auto'; .continuousAutoWhiteBalance →
  /// 'continuous'; .locked → 'locked'. Same locked/manual conflation as focus:
  /// manual white balance is mode-locked with explicit gains.
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

  /// OS-reported thermal state (ProcessInfo) → stable string (M1/C6).
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

// MARK: - Digital-zoom quality caps (W2.3)

/// Conservative digital-zoom ceilings (device-zoom factor) per constituent
/// device class. These are an app-chosen quality bar, not hardware limits; past
/// them the frame is a heavy digital crop of the sensor readout. The device's
/// own ceiling (maxAvailableVideoZoomFactor) is exposed alongside as
/// `hardwareMax`.
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

// MARK: - Photo EXIF extraction (W2.4: OS-written values only)

/// Reads the EXIF numbers the OS wrote into a captured photo's metadata
/// (AVCapturePhoto.metadata → Exif sub-dictionary) and re-keys them under the
/// standard EXIF tag names the app contract commits. Values pass through
/// verbatim (NSNumber); a tag the OS did not write is absent.
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
    // ISOSpeedRatings rides as an array in the OS metadata; the first element
    // (the exposure ISO) is committed as written.
    if let isoList = exif["ISOSpeedRatings"] as? [NSNumber], let first = isoList.first {
      out["ISOSpeedRatings"] = first
    }
    return out
  }

  /// EXIF Flash tag, bit 0: the strobe fired. nil when the OS wrote no Flash
  /// tag, which is committed as no strobe claim.
  static func flashFired(from exif: [String: Any]) -> Bool? {
    guard let value = exif["Flash"] as? NSNumber else { return nil }
    return (value.intValue & 0x1) != 0
  }
}

// MARK: - Delivered-JPEG color space (M1/C6)

/// Reads the color profile name out of a delivered JPEG's bytes (ImageIO).
/// nil when ImageIO reports no profile name; the request path is never used as
/// a substitute.
enum JpegColorSpaceReader {
  static func profileName(from data: Data) -> String? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any] else { return nil }
    return props[kCGImagePropertyProfileName as String] as? String
  }
}

// MARK: - Depth map export (D1; c2pa.depthmap capture side)

/**
 * Canonicalizes a delivered AVDepthData into the committed depth artifact: a
 * 16-bit grayscale PNG of the map as delivered (disparity or depth per
 * depthDataType, semantics committed, never converted), min/max normalized with
 * the window committed alongside so source values are recoverable
 * (value = gray/65535 × span + min).
 *
 * PNG rather than a raw float dump: lossless, byte-deterministic so the
 * committed sha256 binds these exact bytes, and decodable by the TS/web reader
 * with no native dependencies. The source is whatever the photo output
 * delivered; no LiDAR is assumed.
 *
 * nil when the map cannot be exported (unknown pixel type, no finite samples,
 * encode failure).
 */
enum ExhibitDepthMapExtractor {

  struct Outcome {
    let png: Data
    let metadata: [String: Any]
  }

  static func extract(from depthData: AVDepthData, photoWidth: Int?, photoHeight: Int?) -> Outcome? {
    // Map semantics come from the delivered pixel format. Float16 storage is
    // converted to Float32 for reading; the semantics are unchanged.
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

    // Min/max over finite samples only; non-finite pixels (invalid disparity
    // holes) stay 0 in the PNG and are counted.
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

    // "public.png" as a literal CFString: kUTTypePNG is deprecated on the iOS
    // 15 SDK floor and UTType would need a UniformTypeIdentifiers import. The
    // UTI string is stable and ImageIO accepts it directly.
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
      // Unfiltered depth is requested (isDepthDataFilteredEnabled untouched,
      // platform default off). The pipeline's own filtering beyond that is not
      // knowable, so only the request is committed.
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

// MARK: - Capture settings block (W2.4: every setting from a device read)

/// Builds the committed capture-settings dictionary: the camera state at
/// shutter time. Every value is read back from the AVCaptureDevice at commit
/// time (labeled controlsReportedBy:'device') or is an explicit null.
/// Flash and EXIF facts the photo path owns arrive null here and are merged by
/// the full-res capture completion (mergeFullRes).
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

    // deviceWhiteBalanceGains can be mid-transition; invalid gains commit as
    // null (same gate as MetadataBlockBuilder).
    var wbGains: [String: Float]? = nil
    let gains = device.deviceWhiteBalanceGains
    if gains.redGain >= 1.0, gains.greenGain >= 1.0, gains.blueGain >= 1.0,
       gains.redGain <= device.maxWhiteBalanceGain,
       gains.greenGain <= device.maxWhiteBalanceGain,
       gains.blueGain <= device.maxWhiteBalanceGain {
      wbGains = ["r": gains.redGain, "g": gains.greenGain, "b": gains.blueGain]
    }

    // Temperature/tint via the OS's converter from the device-reported gains
    // (W2.4). Committed whenever the gains are valid; outside WB lock the
    // values are transient, which the note states.
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
    // readout center-cropped by videoZoomFactor when > 1 (iOS digital zoom is a
    // symmetric crop; past an optical stop the device changes, which
    // physicalDevice commits). The committed crop inputs make the delivered
    // image's effective focal length (× zoomFactor) and FOV derivable. Read
    // from the device at this commit instant, not configure-time state.
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
    // Center Stage (front ultra-wide): the module never enables it, so this is
    // normally false. Committed as the OS reports it, rect included when the OS
    // says it is active. iOS 16+ API, gated (the pod targets 15.1); on older
    // OSes the keys are omitted.
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
    // 35mm-equivalent focal length: no direct API, so it is derived from the
    // device-reported horizontal FOV on a 36 mm reference (18/tan(hfov/2)).
    // Uncropped-format value; the delivered crop's equivalent is × zoomFactor.
    let hfovRadians = Double(format.videoFieldOfView) * .pi / 180.0
    let focal35mm: Double? = hfovRadians > 0 ? 18.0 / tan(hfovRadians / 2.0) : nil

    var out: [String: Any] = [
      // W2.1: the delivery still's pixels come from the synchronized video
      // frame at session resolution, resampled rather than a full-sensor
      // readout. The full-sensor still is the separate fullResStill artifact
      // with its own hash.
      "deliveryStillSource": "video-frame, resampled from the session-resolution stream",
      "iso": Double(device.iso),
      "exposureDurationSec": exposureSec as Any? ?? NSNull(),
      "lensPosition": Double(device.lensPosition),
      "whiteBalanceGains": wbGains as Any? ?? NSNull(),
      "whiteBalanceTemperatureTint": wbTempTint as Any? ?? NSNull(),
      "apertureFNumber": Double(device.lensAperture),
      "exposureTargetBias": Double(device.exposureTargetBias),
      "videoZoomFactor": Double(device.videoZoomFactor),
      // Zoom/crop geometry and derived 35mm-equivalent (M1/C1); see the locals
      // above. The delivered image is the crop these inputs describe.
      "sensorCrop": sensorCrop,
      "focalLength35mmEquivalent": focal35mm as Any? ?? NSNull(),
      // OS-reported thermal state at the commit instant (ProcessInfo, the same
      // source the thermal policy reads) (M1/C6).
      "thermalState": DeviceModeMapper.thermalState(ProcessInfo.processInfo.thermalState),
      "thermalStateRaw": ProcessInfo.processInfo.thermalState.rawValue,
      "exposureMode": DeviceModeMapper.exposureMode(device.exposureMode),
      "focusMode": DeviceModeMapper.focusMode(device.focusMode),
      "whiteBalanceMode": DeviceModeMapper.whiteBalanceMode(device.whiteBalanceMode),
      "physicalDevice": device.deviceType.rawValue,
      // Photo-strobe facts (W2.2/W2.4). flashFired stays null until the
      // full-res photo's metadata answers; no photo means no strobe claim.
      "photoFlashMode": photoFlash.rawValue,
      "photoFlashHardware": device.hasFlash,
      "photoFlashSupportedModes": flashSupportedModes,
      "flashFired": NSNull(),
      // OS-written EXIF numbers from the full-res photo's metadata (merged
      // later by mergeFullRes); null when no full-res photo ran this shutter.
      // Not synthesized from device state.
      "photoExif": NSNull(),
      // iOS exposes no device focal-length-in-mm property; the full-res photo's
      // EXIF FocalLength is the only mm source and rides in photoExif. The
      // desk-facing mm derivation from committed calibration is in the stereo
      // glue.
      "controlsReportedBy": "device",
    ]
    // The stabilization mode in force at the commit instant
    // (activeVideoStabilizationMode, API-self-reported) (M1/C6). Omitted when
    // the connection reported nothing; the preferred mode is not substituted.
    if let activeStabilizationMode = activeStabilizationMode {
      out["stabilizationModeActive"] = activeStabilizationMode
    }
    return out
  }
}

// MARK: - Metadata block (spec §5: commit inputs, not computed answers)

/// Builds the per-device camera metadata dictionary. Every value is read from
/// the device at capture time or is an explicit null. The pro-control fields
/// (spec §14) are device-reported applied values, labeled via
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

    // deviceWhiteBalanceGains can be mid-transition; invalid gains commit as
    // null.
    var wb: [String: Float]? = nil
    let gains = device.deviceWhiteBalanceGains
    if gains.redGain >= 1.0, gains.greenGain >= 1.0, gains.blueGain >= 1.0,
       gains.redGain <= device.maxWhiteBalanceGain,
       gains.greenGain <= device.maxWhiteBalanceGain,
       gains.blueGain <= device.maxWhiteBalanceGain {
      wb = ["r": gains.redGain, "g": gains.greenGain, "b": gains.blueGain]
    }

    // Pixel focal length comes from the committed calibration. Null when the OS
    // delivered no calibration.
    var focalPixels: [String: Double]? = nil
    if let cal = calibration {
      focalPixels = [
        "fx": Double(cal.intrinsicMatrix.columns.0.x),
        "fy": Double(cal.intrinsicMatrix.columns.1.y),
      ]
    }

    // White-balance temperature/tint, computed from the device-reported gains
    // via the OS's converter. Only meaningful when the device reports
    // mode-locked (manual white balance is locked-with-gains); outside locked
    // mode the values are transient, so they are committed only when locked.
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
    // readout center-cropped by videoZoomFactor when > 1 (iOS digital zoom is a
    // symmetric crop; past an optical stop the device changes, which
    // physicalDevice/formatID commit). focalLengthPixels and fieldOfViewDegrees
    // below describe the uncropped format; these inputs make the delivered
    // image's effective focal length (× zoomFactor) and FOV derivable.
    // videoZoomFactor is the same device property CaptureSettingsBuilder
    // commits, read at the same instant, so the two blocks agree.
    let zoomFactor = Double(device.videoZoomFactor)
    var sensorCrop: [String: Any] = [
      "applied": zoomFactor > 1.0,
      "mode": "center-crop (iOS digital zoom) — derived from device-reported videoZoomFactor, not measured",
      "zoomFactor": zoomFactor,
      "width": Int((Double(dims.width) / zoomFactor).rounded()),
      "height": Int((Double(dims.height) / zoomFactor).rounded()),
      "outputDimensions": ["width": Int(dims.width), "height": Int(dims.height)],
    ]
    // Center Stage (front ultra-wide): the module never enables it, so this is
    // normally false. Committed as the OS reports it, rect included when the OS
    // says it is active. iOS 16+ API, gated (the pod targets 15.1); on older
    // OSes the keys are omitted.
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
    // 35mm-equivalent focal length: no direct API, so it is derived from the
    // device-reported horizontal FOV on a 36 mm reference (18/tan(hfov/2)).
    // Uncropped-format value; the delivered crop's equivalent is × zoomFactor.
    let hfovRadians = Double(format.videoFieldOfView) * .pi / 180.0
    let focal35mm: Double? = hfovRadians > 0 ? 18.0 / tan(hfovRadians / 2.0) : nil

    return [
      "physicalDevice": device.deviceType.rawValue,
      "modelID": device.modelID,
      // ---- pro controls (spec §14): applied values, device-reported ----
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
      // The mode in force on the connection at the commit instant
      // (activeVideoStabilizationMode, API-self-reported; stabilizationMode
      // above is the preferred mode) (M1/C6).
      "stabilizationModeActive": activeStabilizationMode as Any? ?? NSNull(),
      "hdrEnabled": hdrEnabled as Any? ?? NSNull(),
      // OS-reported thermal state at the commit instant (ProcessInfo, the same
      // source the thermal policy reads) (M1/C6).
      "thermalState": DeviceModeMapper.thermalState(ProcessInfo.processInfo.thermalState),
      "thermalStateRaw": ProcessInfo.processInfo.thermalState.rawValue,
      // Every field above is read back from the device or connection, not from
      // the module's request log. Labeled as such.
      "controlsReportedBy": "device",
      // iOS exposes no public focus-distance-in-meters API, so this is null
      // rather than derived from lensPosition (spec §5).
      "focusDistanceMeters": NSNull(),
      "focalLengthPixels": focalPixels as Any? ?? NSNull(),
      "fieldOfViewDegrees": Double(format.videoFieldOfView),
      // Zoom/crop geometry for the delivered image (M1/C1). focalLengthPixels
      // and FOV above are the uncropped format; these inputs describe the crop
      // delivered. See the locals above.
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
      // (deep-fusion-class on supported devices). Stated so no manifest implies
      // unprocessed sensor data for a JPEG (spec §10).
      "platformProcessing": "apple-default-pipeline",
    ]
  }
}


// MARK: - Rotation + mirroring policy (per-device, never hardcoded)

/**
 * Every connection's horizon-level rotation angle comes from
 * AVCaptureDevice.RotationCoordinator, never a hardcoded constant. iPhone 17's
 * Center Stage front camera has a portrait-mounted sensor (WWDC 2026 session
 * 341), so the 90° constant that fits landscape-mounted sensors renders
 * front-camera preview, video and stills sideways there. The coordinator reads
 * the actual mounting and returns the right angle per device. Read once per
 * connection setup; the app is portrait-locked, so the angle is stable per
 * device, and lens swaps and session rebuilds re-apply it
 * (applyConnectionPolicies / configureSession).
 *
 * Consumers: AVCaptureVideoDataOutput connections physically rotate their
 * delivered buffers by this angle (see configureSession's orientation contract;
 * the writer transform stays .identity). AVCapturePhotoOutput applies its own
 * pixel compensation from its connection's angle, so photo connections need the
 * same policy.
 *
 * Mirroring: preview layers auto-mirror the front camera, data and photo
 * outputs do not, so it is set explicitly. Front connections mirror, matching
 * the preview the user composed on, and the connection's value is committed as
 * frontMirrored in the capture payload.
 */
@available(iOS 17.0, *)
enum RotationPolicy {

  /// Horizon-level capture angle for a device's data/photo connections.
  static func captureAngle(for device: AVCaptureDevice) -> CGFloat {
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: nil)
    return coordinator.videoRotationAngleForHorizonLevelCapture
  }

  /// Horizon-level preview angle for a device's preview-layer connection.
  static func previewAngle(for device: AVCaptureDevice, previewLayer: AVCaptureVideoPreviewLayer) -> CGFloat {
    let coordinator = AVCaptureDevice.RotationCoordinator(device: device, previewLayer: previewLayer)
    return coordinator.videoRotationAngleForHorizonLevelPreview
  }

  /// One policy for every connection kind: coordinator angle plus explicit
  /// front-camera mirroring. Pass the preview layer for preview-bound
  /// connections, whose angle can differ from the capture angle, and nil for
  /// data/photo connections.
  static func apply(to connection: AVCaptureConnection, device: AVCaptureDevice, previewLayer: AVCaptureVideoPreviewLayer? = nil) {
    let angle = previewLayer.map { previewAngle(for: device, previewLayer: $0) } ?? captureAngle(for: device)
    if connection.isVideoRotationAngleSupported(angle) {
      connection.videoRotationAngle = angle
    }
    if connection.isVideoMirroringSupported {
      // Set explicitly: data/photo connections default to not mirroring while
      // the preview does.
      connection.automaticallyAdjustsVideoMirroring = false
      connection.isVideoMirrored = (device.position == .front)
    }
  }
}

// MARK: - Photo-path isolation debug flags

/**
 * Runtime-flippable switches, set from Settings ▸ Diagnostics, for A/B-ing the
 * photo-path changes on device:
 *   - photoConnectionRotation   — RotationPolicy on photo-output connections.
 *                                 Default false; data/preview rotation is
 *                                 unconditional.
 *   - photoMaxDimensionsPolicy  — maxPhotoDimensions clamp (≤12 MP) on photo
 *                                 outputs and degraded-path settings. Default
 *                                 true.
 * Backed by a UserDefaults suite, so the flags survive a session rebuild and
 * are readable from any queue. Isolation scaffolding, not a product surface.
 */
enum ExhibitDebugFlags {
  static let suite = "exhibit.debug"
  static let photoConnectionRotationKey = "photoConnectionRotation"
  static let photoMaxDimensionsPolicyKey = "photoMaxDimensionsPolicy"
  static let depthCaptureKey = "depthCapture"
  /// Inert: the session-calibration dual-photo one-shot has no call site and
  /// no settings switch. The key stays registered so a stale flipped value in
  /// the suite reads as a no-op rather than an unknown-key error.
  static let sessionCalibrationPhotoKey = "sessionCalibrationPhoto"
  /// Extension-point gate for the opportunistic third synchronized view.
  /// Untested on hardware; keep off in shipping builds until an on-device soak
  /// validates the path. Default false; the probe result is reported via
  /// capabilities().thirdViewCapable regardless.
  static let thirdViewEnabledKey = "thirdViewEnabled"
  /// A/B switch for the rear-stereo graph. Default false uses the dual-wide
  /// virtual-device path (one input, constituent ports requested by name,
  /// hardware-synced; Apple's AVDualCam architecture, WWDC19-249). True
  /// restores the two-device-input graph, on which iPhone 17 delivered zero
  /// secondary frames with no error callbacks.
  static let legacyMultiInputGraphKey = "legacyMultiInputGraph"

  static var photoConnectionRotation: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: photoConnectionRotationKey) ?? false
  }
  /// The ≤12 MP maxPhotoDimensions clamp, on by default: an unclamped 48 MP
  /// photo-stream reservation on a live multi-cam graph is the suspect for the
  /// photo-path field failures. Settable to false to A/B it.
  static var photoMaxDimensionsPolicy: Bool {
    guard let defaults = UserDefaults(suiteName: suite),
          defaults.object(forKey: photoMaxDimensionsPolicyKey) != nil else { return true }
    return defaults.bool(forKey: photoMaxDimensionsPolicyKey)
  }
  /// Default false; see the key's note above.
  static var sessionCalibrationPhoto: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: sessionCalibrationPhotoKey) ?? false
  }
  /// Default false; untested on hardware.
  static var thirdViewEnabled: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: thirdViewEnabledKey) ?? false
  }
  /// False (the default) uses the virtual-device rear-stereo graph. True
  /// restores the two-device-input graph, for A/B only.
  static var legacyMultiInputGraph: Bool {
    UserDefaults(suiteName: suite)?.bool(forKey: legacyMultiInputGraphKey) ?? false
  }
  /// D1 depth export. Default true, since depth is a shipped feature, so an
  /// unset suite means on (the isolation flags above default off). The flag is
  /// the on-device escape hatch for isolating depth problems without a
  /// rebuild.
  static var depthCapture: Bool {
    guard let defaults = UserDefaults(suiteName: suite),
          defaults.object(forKey: depthCaptureKey) != nil else { return true }
    return defaults.bool(forKey: depthCaptureKey)
  }

  /// Only the known keys are writable; anything else returns false, so a typo
  /// in Diagnostics does not silently no-op an isolation run.
  @discardableResult
  static func set(_ key: String, value: Bool) -> Bool {
    guard key == photoConnectionRotationKey || key == photoMaxDimensionsPolicyKey
            || key == depthCaptureKey || key == sessionCalibrationPhotoKey
            || key == thirdViewEnabledKey || key == legacyMultiInputGraphKey else { return false }
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
      legacyMultiInputGraphKey: legacyMultiInputGraph,
    ]
  }
}
