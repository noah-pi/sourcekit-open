// Written with AI assistance. Verification: docs/PROVENANCE.md.
import Foundation
import AVFoundation

/**
 * AudioMasterConverter — native-format → canonical PCM master conversion.
 * Why this exists: `AVCaptureAudioDataOutput.audioSettings`
 * is macOS-only; on iOS the audio data output ALWAYS delivers the device's
 * native format (typically Float32 LPCM at 44.1/48 kHz, mono or stereo).
 * The PCM master is specified as LPCM mono 16 kHz 16-bit little-endian
 * (SPEC §5.1: 16 kHz ≫ Nyquist for the 120/180/240 Hz ENF harmonics),
 * so every native buffer is converted once with AVAudioConverter (sample-rate
 * conversion + downmix + float→int16) before the master writer sees it.
 * Honest architecture note: the delivery AAC writer consumes the NATIVE
 * buffers (no coupling to this converter — rule 4: delivery never dies);
 * the PCM master consumes the converted canonical representation. Both
 * derive from the same mic session and the same buffer source.
 * Thread confinement: session queue only (same as PcmMasterWriter).
 */
final class AudioMasterConverter {

  enum ConvertError: Error, LocalizedError {
    case noFormatDescription
    case badInputFormat
    case noConverter
    case allocationFailed
    case conversionFailed(String)

    var errorDescription: String? {
      switch self {
      case .noFormatDescription: return "audio buffer has no format description"
      case .badInputFormat: return "audio buffer format is not describable"
      case .noConverter: return "cannot create audio converter"
      case .allocationFailed: return "cannot allocate conversion buffers"
      case .conversionFailed(let m): return "audio conversion failed: \(m)"
      }
    }
  }

  /// Canonical PCM master format: LPCM mono 16 kHz 16-bit interleaved.
  let outputFormat: AVAudioFormat

  /// Lazily (re)built whenever the incoming stream format changes.
  private var converter: AVAudioConverter?
  private var inputFormat: AVAudioFormat?

  init?() {
    guard let fmt = AVAudioFormat(
      commonFormat: .pcmFormatInt16,
      sampleRate: PcmMasterWriter.sampleRate,
      channels: AVAudioChannelCount(PcmMasterWriter.channels),
      interleaved: true
    ) else { return nil }
    self.outputFormat = fmt
  }

  /// Structural stream-format comparison — AVAudioFormat inherits NSObject
  /// identity equality, which cannot detect a mid-stream format change.
  static func sameStreamFormat(_ a: AVAudioFormat?, _ b: AVAudioFormat) -> Bool {
    guard let a = a else { return false }
    return a.sampleRate == b.sampleRate
      && a.channelCount == b.channelCount
      && a.commonFormat == b.commonFormat
      && a.isInterleaved == b.isInterleaved
  }

 /**
 * Convert one native CMSampleBuffer into the canonical master format.
 * Returns nil for not-ready buffers AND for benign zero-output conversions
 * (frames parked in the SRC delay line — they emerge on a later call or at
 * drain); callers skip nil silently. Throws only for real conversion
 * failures (callers fail the PCM sink honestly).
 */
  func convert(_ sampleBuffer: CMSampleBuffer) throws -> AVAudioPCMBuffer? {
    guard CMSampleBufferDataIsReady(sampleBuffer) else { return nil }
    guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
          let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
    else { throw ConvertError.noFormatDescription }
    guard let inFmt = AVAudioFormat(streamDescription: asbdPtr) else {
      throw ConvertError.badInputFormat
    }

    if converter == nil || !AudioMasterConverter.sameStreamFormat(inputFormat, inFmt) {
      guard let conv = AVAudioConverter(from: inFmt, to: outputFormat) else {
        throw ConvertError.noConverter
      }
      converter = conv
      inputFormat = inFmt
    }
    guard let converter = converter else { throw ConvertError.noConverter }

    let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
    guard frameCount > 0 else { return nil }
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else {
      throw ConvertError.noFormatDescription
    }

    // Copy the sample bytes into an AVAudioPCMBuffer laid out per the input
    // format: for interleaved formats the audio buffer list has one buffer;
    // for non-interleaved it has one per channel, and the block stores the
    // channels back-to-back in the same order.
    guard let inBuf = AVAudioPCMBuffer(
      pcmFormat: inFmt,
      frameCapacity: AVAudioFrameCount(frameCount)
    ) else { throw ConvertError.allocationFailed }
    inBuf.frameLength = AVAudioFrameCount(frameCount)
    var offset = 0
    for buf in UnsafeMutableAudioBufferListPointer(inBuf.mutableAudioBufferList) {
      guard let data = buf.mData, buf.mDataByteSize > 0 else { continue }
      let status = CMBlockBufferCopyDataBytes(
        block,
        atOffset: offset,
        dataLength: Int(buf.mDataByteSize),
        destination: data
      )
      guard status == kCMBlockBufferNoErr else {
        throw ConvertError.conversionFailed("block copy failed (\(status))")
      }
      offset += Int(buf.mDataByteSize)
    }

    // Output capacity: expected frames after resampling, plus margin.
    let ratio = outputFormat.sampleRate / inFmt.sampleRate
    let outCapacity = AVAudioFrameCount(ceil(Double(frameCount) * ratio)) + 64
    guard let outBuf = AVAudioPCMBuffer(
      pcmFormat: outputFormat,
      frameCapacity: outCapacity
    ) else { throw ConvertError.allocationFailed }

    var consumed = false
    var error: NSError?
    let status = converter.convert(to: outBuf, error: &error) { _, inputStatus in
      if consumed {
        inputStatus.pointee = .noDataNow
        return nil
      }
      consumed = true
      inputStatus.pointee = .haveData
      return inBuf
    }
    switch status {
    case .haveData, .inputRanDry, .endOfStream:
      // Zero output is BENIGN, not an error: with the single-shot input
      // closure above, the frames just absorbed sit in the SRC delay line
      // and emerge on the NEXT convert call (or at drain). Throwing here
      // would permanently kill the PCM master sink for the whole take.
      return outBuf.frameLength > 0 ? outBuf : nil
    case .error:
      throw ConvertError.conversionFailed(error?.localizedDescription ?? "unknown")
    @unknown default:
      throw ConvertError.conversionFailed("unknown converter status")
    }
  }

 /**
 * Flush the SRC delay line at session end. The single-shot input closure
 * in convert(_:) can leave tail frames absorbed inside the converter;
 * signalling.endOfStream makes it emit whatever remains. Returns nil when
 * nothing remains (or no converter was ever built this session). Throws
 * only for genuine converter errors. The converter is torn down afterward
 * so the next session rebuilds it fresh (a converter that has seen
 * .endOfStream must not be reused without reset).
 */
  func drain() throws -> AVAudioPCMBuffer? {
    guard let converter = converter else { return nil }
    defer {
      self.converter = nil
      self.inputFormat = nil
    }
    // SRC latency is a few dozen output frames; 1024 covers it with a wide
    // margin. One call suffices: with.endOfStream signalled, the converter
    // flushes everything that fits — and the residue always fits.
    guard let outBuf = AVAudioPCMBuffer(
      pcmFormat: outputFormat,
      frameCapacity: 1024
    ) else { throw ConvertError.allocationFailed }
    var error: NSError?
    let status = converter.convert(to: outBuf, error: &error) { _, inputStatus in
      inputStatus.pointee = .endOfStream
      return nil
    }
    switch status {
    case .haveData, .inputRanDry, .endOfStream:
      return outBuf.frameLength > 0 ? outBuf : nil
    case .error:
      throw ConvertError.conversionFailed(error?.localizedDescription ?? "unknown")
    @unknown default:
      throw ConvertError.conversionFailed("unknown converter status")
    }
  }
}
