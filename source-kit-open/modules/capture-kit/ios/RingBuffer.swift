import Foundation
import AVFoundation
import CoreVideo
import CoreImage
import ImageIO // kCGImageDestinationLossyCompressionQuality

/**
 * RingBuffer — the parallax ring for stills (SPEC §4).
 *
 * Retains the last 8 uncompressed CVPixelBuffer frames from the video data
 * output. These are PRE-SHUTTER frames only; for a photo capture the shutter
 * frame is the 9th frame and is never part of the ring.
 *
 * CVPixelBuffers from the data output are owned by the capture pool and are
 * REUSED underneath us, so every frame is deep-copied on retain
 * (`copyPixelBuffer`) — retaining the pool's buffer would silently alias to
 * whatever frame the pool later writes into it.
 *
 * Memory: ≤ 8 × (preview pixels × 1.5 bytes); the session preset caps the
 * preview at 1920×1440 (SPEC §4).
 *
 * Dump: JPEG quality 0.9, evidenceDir/ring-<uuid>/f000.jpg … f007.jpg,
 * oldest first. Dump happens ONLY from capturePhotoWithRing; video sessions
 * keep the ring in memory and discard it on stop (ringBufferDir: null —
 * parallax burst is a stills feature for 1.0.0).
 *
 * Thread confinement: session queue only (retain/dump/clear all called from
 * the module's single serial queue).
 */
final class RingBuffer {

  enum RingError: Error, LocalizedError {
    case copyFailed
    case jpegFailed(Int)
    case directoryFailed(String)
    case empty

    var errorDescription: String? {
      switch self {
      case .copyFailed: return "Could not copy a CVPixelBuffer out of the capture pool"
      case .jpegFailed(let i): return "JPEG encoding failed for ring frame \(i)"
      case .directoryFailed(let m): return "Cannot create ring dump directory: \(m)"
      case .empty: return "Ring buffer holds no frames to dump"
      }
    }
  }

  let capacity: Int
  private var frames: [CVPixelBuffer] = []

  init(capacity: Int = kCaptureKitRingCapacity) {
    self.capacity = capacity
  }

  var count: Int { frames.count }
  var isFull: Bool { frames.count >= capacity }

  /// Retains a DEEP COPY of the frame (pool reuse safety, see header).
  func retain(_ pixelBuffer: CVPixelBuffer) {
    guard let copy = RingBuffer.copyPixelBuffer(pixelBuffer) else {
      // A failed copy must not corrupt ordering: skip this frame rather than
      // retain an aliasing reference. The ring simply holds one frame fewer.
      return
    }
    frames.append(copy)
    if frames.count > capacity {
      frames.removeFirst(frames.count - capacity)
    }
  }

  func clear() {
    frames.removeAll()
  }

  /**
   * Dumps all retained frames as JPEG q0.9, oldest first: f000.jpg, f001.jpg…
   * Returns the dump directory's filesystem path. Throws RingError on any
   * failure — the module maps that to onError E_RING_DUMP + a null field
   * (evidence degrades, delivery never dies — SPEC rule 4).
   */
  func dumpJPEG(toEvidenceDir evidenceDir: URL) throws -> String {
    guard !frames.isEmpty else { throw RingError.empty }
    let dir = evidenceDir.appendingPathComponent("ring-\(UUID().uuidString)")
    do {
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    } catch {
      throw RingError.directoryFailed(error.localizedDescription)
    }
    let context = CIContext()
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    for (index, buffer) in frames.enumerated() {
      let image = CIImage(cvPixelBuffer: buffer)
      guard let data = context.jpegRepresentation(
        of: image,
        colorSpace: colorSpace,
        options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.9]
      ) else {
        throw RingError.jpegFailed(index)
      }
      let name = String(format: "f%03d.jpg", index)
      do {
        try data.write(to: dir.appendingPathComponent(name), options: .atomic)
      } catch {
        throw RingError.jpegFailed(index)
      }
    }
    return dir.path
  }

  // MARK: - Deep copy

  /**
   * Deep-copies a CVPixelBuffer: new buffer, same pixel format/dimensions,
   * every plane copied row-by-row respecting bytes-per-row on both sides
   * (pool buffers may be padded; a naive contiguous memcpy is wrong).
   */
  static func copyPixelBuffer(_ src: CVPixelBuffer) -> CVPixelBuffer? {
    let width = CVPixelBufferGetWidth(src)
    let height = CVPixelBufferGetHeight(src)
    let pixelFormat = CVPixelBufferGetPixelFormatType(src)
    var dst: CVPixelBuffer?
    let attrs: [String: Any] = [:]
    guard CVPixelBufferCreate(
      kCFAllocatorDefault,
      width,
      height,
      pixelFormat,
      attrs as CFDictionary,
      &dst
    ) == kCVReturnSuccess, let dstBuffer = dst else {
      return nil
    }

    CVPixelBufferLockBaseAddress(src, .readOnly)
    CVPixelBufferLockBaseAddress(dstBuffer, CVPixelBufferLockFlags(rawValue: 0))

    let planeCount = CVPixelBufferGetPlaneCount(src)
    if planeCount == 0 {
      copyPlane(src: src, dst: dstBuffer, plane: nil, height: height)
    } else {
      for plane in 0..<planeCount {
        let planeHeight = CVPixelBufferGetHeightOfPlane(src, plane)
        copyPlane(src: src, dst: dstBuffer, plane: plane, height: planeHeight)
      }
    }

    CVPixelBufferUnlockBaseAddress(dstBuffer, CVPixelBufferLockFlags(rawValue: 0))
    CVPixelBufferUnlockBaseAddress(src, .readOnly)
    return dstBuffer
  }

  private static func copyPlane(src: CVPixelBuffer, dst: CVPixelBuffer, plane: Int?, height: Int) {
    let srcBase: UnsafeMutableRawPointer?
    let dstBase: UnsafeMutableRawPointer?
    let srcBytesPerRow: Int
    let dstBytesPerRow: Int
    if let plane = plane {
      srcBase = CVPixelBufferGetBaseAddressOfPlane(src, plane)
      dstBase = CVPixelBufferGetBaseAddressOfPlane(dst, plane)
      srcBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(src, plane)
      dstBytesPerRow = CVPixelBufferGetBytesPerRowOfPlane(dst, plane)
    } else {
      srcBase = CVPixelBufferGetBaseAddress(src)
      dstBase = CVPixelBufferGetBaseAddress(dst)
      srcBytesPerRow = CVPixelBufferGetBytesPerRow(src)
      dstBytesPerRow = CVPixelBufferGetBytesPerRow(dst)
    }
    guard let s = srcBase, let d = dstBase, srcBytesPerRow > 0, dstBytesPerRow > 0 else { return }
    let rowBytes = min(srcBytesPerRow, dstBytesPerRow)
    for row in 0..<height {
      memcpy(d + row * dstBytesPerRow, s + row * srcBytesPerRow, rowBytes)
    }
  }
}
