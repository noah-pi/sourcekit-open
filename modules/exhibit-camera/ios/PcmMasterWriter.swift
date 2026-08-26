// Source Kit 0.1.0 — raw LPCM master writer for the ExhibitCamera video
// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import AVFoundation

/**
 * PcmMasterWriter — raw LPCM master writer for the ExhibitCamera video
 * session. Thread confinement: session queue only.
 * Takes canonical-format PCM buffers from AudioMasterConverter. On iOS
 * AVCaptureAudioDataOutput delivers the device-native audio format (its
 * `audioSettings` property is macOS-only), so the converter downmixes to LPCM
 * mono 16 kHz 16-bit and hands the frames here; the delivery AAC writer
 * consumes the native buffers independently.
 * Output: evidenceDir/master-<sessionId>.caf — LPCM, mono, 16 kHz, 16-bit,
 * little-endian. 16 kHz is well above Nyquist for the 120/180/240 Hz ENF
 * harmonics.
 * The ENF anchor and integrity summary (firstSampleWallClockUtcMs /
 * sampleCount / sampleRate / fileSha256) are assembled by the module at
 * tee/stop and exposed as rawPcmInfo on the stopVideo payload.
 * Fail-fast sink: any failure throws, the module surfaces onError E_SINK and
 * reports rawPcmPath: null, and the delivery video is unaffected.
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

  // AVAudioFile finalizes the CAF header on deinit (it has no explicit close
  // API — the audio-capture module relies on the same behavior for.m4a), so
  // the reference is optional and finish drops it.
  private var file: AVAudioFile?
  private let format: AVAudioFormat
  let url: URL
  private(set) var failed = false
  /// Total frames written. Checked at stopVideo: a zero-frame master is
  /// reported via the failed/empty path, not as a recorded file.
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
    // Do not compare isInterleaved for the mono master: the writer's format
    // is settings-derived and the converter's is commonFormat-derived, and the
    // two can disagree on that flag for 1-channel formats, where interleaving
    // means nothing. Sample rate, channel count, and common format still pin
    // the canonical layout.
    let interleaveMatches = bufFmt.channelCount > 1
      ? bufFmt.isInterleaved == format.isInterleaved
      : true
    guard bufFmt.sampleRate == format.sampleRate,
          bufFmt.channelCount == format.channelCount,
          bufFmt.commonFormat == format.commonFormat,
          interleaveMatches
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
  /// instead of writing a silently truncated master.
  func markFailed() { failed = true }
}
