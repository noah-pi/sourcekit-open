// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import AVFoundation

/**
 * PcmMasterWriter — raw LPCM master writer (SPEC §5.1).
 *
 * Receives canonical-format PCM buffers from AudioMasterConverter: on iOS,
 * AVCaptureAudioDataOutput ALWAYS delivers the device-native audio format
 * (its `audioSettings` property is macOS-only), so the module converts each
 * native buffer to LPCM mono 16 kHz 16-bit and hands the converted frames
 * here. The delivery AAC writer consumes the native buffers independently —
 * one mic session, one buffer source, two sinks (rule 4: evidence degrades,
 * delivery never dies).
 *
 * Output: evidenceDir/master-<sessionId>.caf — LPCM, mono, 16 kHz, 16-bit,
 * little-endian — 16 kHz ≫ Nyquist for the 120/180/240 Hz ENF harmonics.
 * Session config (.record / .measurement) is applied by the module
 * before the capture session starts — see CaptureKitModule.
 *
 * Fail-fast sink (SPEC §5.1): any failure throws; the module surfaces
 * onError E_PCM_SINK and reports rawPcmPath: null. The delivery
 * video is unaffected.
 *
 * Thread confinement: session queue only.
 */
final class PcmMasterWriter {

  enum SinkError: Error, LocalizedError {
    case cannotCreateFile(String)
    case badBuffer(String)
    case writeFailed(String)

    var errorDescription: String? {
      switch self {
      case .cannotCreateFile(let m): return "Cannot create PCM master: \(m)"
      case .badBuffer(let m): return "Bad audio buffer for PCM master: \(m)"
      case .writeFailed(let m): return "PCM master write failed: \(m)"
      }
    }
  }

  /// Canonical PCM master format: LPCM mono 16 kHz 16-bit signed
  /// little-endian. AudioMasterConverter produces exactly this.
  static let sampleRate: Double = 16_000
  static let channels: UInt32 = 1
  static let bitDepth: UInt32 = 16

  /// AVAssetWriterInput settings for the delivery AAC track (SPEC §3: a
  /// single AVAssetWriter writes the delivery .mp4, H.264/AAC). The writer
  /// encodes from the NATIVE LPCM buffers it is handed, so the AAC rate and
  /// channel count follow the source stream (no resampling assumptions in
  /// the writer).
  static func deliveryAudioWriterSettings(
    sourceSampleRate: Double,
    sourceChannels: UInt32
  ) -> [String: Any] {
    [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: sourceSampleRate,
      AVNumberOfChannelsKey: min(max(sourceChannels, 1), 2),
      AVEncoderBitRateKey: 64_000,
    ]
  }

  // AVAudioFile finalizes the CAF header on deinit (it has no explicit close
  // API — the audio-capture module relies on the same behavior for .m4a), so
  // the reference is optional and finish drops it.
  private var file: AVAudioFile?
  private let format: AVAudioFormat
  let url: URL
  private(set) var failed = false
  /// Total frames written. Checked at performStop: a zero-frame master is
  /// not evidence and must be reported via the failed/empty path, not as a
  /// recorded file.
  private(set) var framesWritten: AVAudioFrameCount = 0

  init(url: URL) throws {
    self.url = url
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatLinearPCM,
      AVSampleRateKey: PcmMasterWriter.sampleRate,
      AVNumberOfChannelsKey: PcmMasterWriter.channels,
      AVLinearPCMBitDepthKey: PcmMasterWriter.bitDepth,
      AVLinearPCMIsFloatKey: false,
      AVLinearPCMIsBigEndianKey: false,
    ]
    guard let format = AVAudioFormat(settings: settings) else {
      throw SinkError.cannotCreateFile("invalid LPCM format description")
    }
    self.format = format
    do {
      // .caf extension → CAF file type, which holds LPCM natively.
      self.file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatInt16, interleaved: true)
    } catch {
      throw SinkError.cannotCreateFile(error.localizedDescription)
    }
  }

  /**
   * Append one canonical-format buffer (LPCM mono 16 kHz 16-bit, produced by
   * AudioMasterConverter). The buffer is written directly; nothing
   * accumulates.
   */
  func append(pcmBuffer: AVAudioPCMBuffer) throws {
    guard !failed else { throw SinkError.writeFailed("sink previously failed") }
    guard let file = file else { throw SinkError.writeFailed("sink already closed") }
    guard pcmBuffer.frameLength > 0 else { return }
    // Structural format check — AVAudioFormat inherits NSObject identity
    // equality, so `==` would reject every buffer.
    let bufFmt = pcmBuffer.format
    guard bufFmt.sampleRate == format.sampleRate,
          bufFmt.channelCount == format.channelCount,
          bufFmt.commonFormat == format.commonFormat,
          bufFmt.isInterleaved == format.isInterleaved
    else {
      throw SinkError.badBuffer("PCM buffer is not in the canonical master format")
    }
    do {
      try file.write(from: pcmBuffer)
      framesWritten &+= pcmBuffer.frameLength
    } catch {
      throw SinkError.writeFailed(error.localizedDescription)
    }
  }

  /// Closes the file, finalizing the CAF header. Safe to call repeatedly.
  func finish() {
    file = nil
  }

  /// Marks the sink failed after a caught error so later appends fail fast
  /// instead of writing a silently truncated master (degrade honestly,
  /// SPEC rule 4).
  func markFailed() { failed = true }
}
