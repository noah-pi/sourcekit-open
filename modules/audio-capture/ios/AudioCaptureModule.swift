// Source Kit 0.1.0 — Audio capture with on-device live transcription — the
// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
import AVFoundation
import CoreMotion
import CryptoKit
import Speech

/**
 * Audio capture with on-device live transcription — the Voice Memos
 * architecture: ONE AVAudioEngine whose input tap fans out to two sinks:
 *
 *   1. AVAudioFile → the signed.m4a (AAC), written in real time
 *   2. SFSpeechAudioBufferRecognitionRequest → partial transcripts streamed
 *      to JS as `onTranscript` events
 *
 * Privacy stance: when the device supports on-device speech recognition we
 * require it (requiresOnDeviceRecognition = true) — audio never leaves the
 * phone for transcription. When unsupported, recording still works and the
 * caller is told transcription is off.
 *
 * While recording, a CoreMotion gyro log (AudioMotionLog, 100 Hz target,
 * CaptureKit SensorLogger line format, anchor line first) covers exactly
 * the recorded window — the IMU sink behind the audio exhibit's signed
 * com.verify.poseTrace assertion (media parity with video).
 *
 * API:
 *   requestPermissions -> { microphone: Bool, speech: Bool }
 *   transcriptionAvailable -> Bool (on-device recognition supported)
 *   start(path, sensorLogPath?) -> { transcribing: Bool }
 *   stop -> { path, durationMs, transcript, segments,
 *                                    fileState, fileError,
 *                                    sensorLogPath, sensorLogState,
 *                                    rawPcmPath, rawPcmState, rawPcmError,
 *                                    rawPcmInfo } (: ENF anchor +
 *                                    integrity summary for the raw master,
 *                                    same shape as the video tee's)
 *
 * fileState is the delivery-file sink's three-state honesty: "clean" (every
 * buffer landed), "partial" (a write failed mid-take — file real but
 * truncated, fileError carries the first error), "failed" (nothing durable
 * reached disk — path is null and JS must refuse to seal). A truncated file
 * is never passed off as a complete one.
 *   events: onTranscript { text, isFinal }, onLevel { db }, onError { message }
 *
 * sensorLogState is three-state honesty for the IMU sink: "recorded"
 * (sensorLogPath holds the JSONL path), "failed" (the sink was requested
 * but died — sensorLogPath is null), "unavailable" (no gyro on this device
 * or no log requested — nothing was ever going to be recorded).
 */
/**
 * promise.reject(code, description) silently DROPS the description on SDK 57:
 * the JS-visible message is built from `reason` (which the convenience init
 * never sets), so every rejection arrived as "CODE: undefined reason" and
 * real failures were undiagnosable. This subclass carries the message in
 * `reason`, so actionable errors reach JS.
 */
final class NamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

public class AudioCaptureModule: Module {
  private var engine: AVAudioEngine?
  private var audioFile: AVAudioFile?
  private var converter: AVAudioConverter?
  // Delivery-file sink honesty: a failed AVAudioFile.write must never become
  // a silently truncated exhibit. The first error is remembered, surfaced
  // live via onError, and declared in the stop payload; buffersWritten == 0
  // at stop means nothing durable exists and the take fails closed.
  private var firstWriteError: String?
  private var buffersWritten = 0
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?

  private var fileURL: URL?
  private var startTime: Date?
  private var transcribing = false
  private var lastLevelSent = Date.distantPast

  private var finalText = ""
  private var finalSegments: [[String: Any]] = []
  private var stopPromise: Promise?
  private var stopResolved = false
  private var interruptionObserver: NSObjectProtocol?

  // IMU sink (WS2 Phase 2 §3 media parity): gyro JSONL covering exactly the
  // recorded window, in the CaptureKit SensorLogger line format, so audio
  // exhibits carry a signed com.verify.poseTrace like video. Honest absence:
  // "unavailable" (no gyro / not requested) and "failed" (sink died) are
  // distinct states — the log is never fabricated, never silently empty.
  private var motionLog: AudioMotionLog?
  private var motionLogState = "unavailable" // "recorded" | "failed" | "unavailable"
  private var motionLogPath: String?

  // Raw-audio sink for audio takes: the uncompressed LPCM master
  // (CAF), same three-state contract as the video session's raw sink. The
  // tap delivers hardware-format LPCM buffers, so the master writes with
  // NO converter — the exact frames the AAC delivery file sees. Until this
  // existed the sink was structurally 'never-recorded' for audio captures
  // even with the Raw audio toggle on.
  private var rawFile: AVAudioFile?
  private var rawFileURL: URL?
  private var rawState = "unavailable" // "recorded" | "failed" | "unavailable"
  private var rawBuffersWritten = 0
  // ENF anchor (media parity with the video tee's rawPcmInfo): the
  // raw master's committed frame count + first-sample wall clock + the
  // container's own readback ride the stop payload so JS can seal them —
  // the parser in the details screen arbitrates its CAF interpretation
  // against this anchor, and a desk can place the mains trace in absolute
  // time. Audio-mode masters had no anchor before (the field report:
  // "raw audio layout incoherent" on a float32 hardware-format CAF).
  private var rawFramesWritten: AVAudioFrameCount = 0
  private var rawFirstSampleWallClockUtcMs: Int64? = nil
  /// The committed file's processing-format rate, captured at creation —
  /// stopPayload runs after finishStop has nilled rawFile (deinit
  /// finalizes the CAF header), so reading it there would report a
  /// fabricated 0.
  private var rawSampleRate: Double = 0
  private var rawWriteError: String?

  public func definition() -> ModuleDefinition {
    Name("AudioCapture")
    Events("onTranscript", "onLevel", "onError", "onInterrupted")

    AsyncFunction("requestPermissions") { (promise: Promise) in
      let finish = { (mic: Bool) in
        SFSpeechRecognizer.requestAuthorization { status in
          promise.resolve(["microphone": mic, "speech": status == .authorized])
        }
      }
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission { granted in finish(granted) }
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission { granted in finish(granted) }
      }
    }

    Function("transcriptionAvailable") { () -> Bool in
      return SFSpeechRecognizer()?.supportsOnDeviceRecognition ?? false
    }

    AsyncFunction("start") { (path: String, sensorLogPath: String?, rawPcmPath: String?, promise: Promise) in
      self.start(path: path, sensorLogPath: sensorLogPath, rawPcmPath: rawPcmPath, promise: promise)
    }

    AsyncFunction("stop") { (promise: Promise) in
      self.stop(promise: promise)
    }
  }

  // MARK: - Recording

  /// Callers hand us expo-file-system paths, which may be file:// URI
  /// strings. URL(fileURLWithPath:) would treat "file:///var/…" as a literal
  /// relative path and AVAudioFile then fails with the opaque
  /// kAudioFileUnspecifiedError ('wht?'). Parse URIs as URLs, plain paths as
  /// paths. Shared by the.m4a and the IMU JSONL.
  private static func fileURL(for path: String) -> Result<URL, NamedException> {
    if path.hasPrefix("file://") {
      guard let parsed = URL(string: path) else {
        return .failure(NamedException("AUDIO_FILE", "Cannot create audio file: malformed file URI"))
      }
      return .success(parsed)
    }
    return .success(URL(fileURLWithPath: path))
  }

  private func start(path: String, sensorLogPath: String?, rawPcmPath: String?, promise: Promise) {
    if engine != nil {
      promise.reject(NamedException("AUDIO_BUSY", "Already recording"))
      return
    }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
      try session.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      promise.reject(NamedException("AUDIO_SESSION", "Audio session failed: \(error.localizedDescription)"))
      return
    }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    let hwFormat = input.outputFormat(forBus: 0)
    guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
      promise.reject(NamedException("AUDIO_ENGINE", "Audio input unavailable"))
      return
    }

    // AAC.m4a at the hardware sample rate, mono.
    let url: URL
    switch Self.fileURL(for: path) {
    case .success(let parsed):
      url = parsed
    case .failure(let error):
      promise.reject(error)
      return
    }
    // Defense in depth: JS creates this directory, but AVAudioFile fails with
    // an opaque error if it is absent — create it natively right before use
    // so a missed/migrated directory can never kill a recording.
    try? FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: hwFormat.sampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: 96000,
    ]
    do {
      audioFile = try AVAudioFile(forWriting: url, settings: settings)
    } catch {
      promise.reject(NamedException("AUDIO_FILE", "Cannot create audio file: \(error.localizedDescription)"))
      return
    }
    converter = AVAudioConverter(from: hwFormat, to: audioFile!.processingFormat)

    // Raw LPCM master (the "Raw audio" toggle, audio takes): a parallel CAF
    // in the tap's hardware format — no conversion, so the waveform/hash a
    // reader recomputes are of the very samples the microphone delivered.
    // A create failure degrades the sink ("failed"), never the recording.
    rawFile = nil
    rawFileURL = nil
    rawState = "unavailable"
    rawBuffersWritten = 0
    rawFramesWritten = 0
    rawFirstSampleWallClockUtcMs = nil
    rawSampleRate = 0
    rawWriteError = nil
    if let rawPcmPath = rawPcmPath, !rawPcmPath.isEmpty {
      switch Self.fileURL(for: rawPcmPath) {
      case .success(let rawURL):
        try? FileManager.default.createDirectory(
          at: rawURL.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        do {
          rawFile = try AVAudioFile(
            forWriting: rawURL,
            settings: hwFormat.settings,
            commonFormat: hwFormat.commonFormat,
            interleaved: hwFormat.isInterleaved
          )
          rawFileURL = rawURL
          rawState = "recorded"
          rawSampleRate = rawFile!.processingFormat.sampleRate
        } catch {
          rawState = "failed"
          rawWriteError = error.localizedDescription
          sendEvent("onError", ["message": "Raw audio master failed to start: \(error.localizedDescription)"])
        }
      case .failure(let error):
        rawState = "failed"
        rawWriteError = error.reason
        sendEvent("onError", ["message": "Raw audio master failed to start: \(error.reason)"])
      }
    }

    // Speech: on-device when supported AND authorized. A recognizer without
    // speech permission starts a task that dies instantly with an opaque
    // error — from the user's seat, "transcription isn't working" with no
    // explanation. Gate on BOTH and report a machine-readable reason so JS
    // can say exactly why transcription is off.
    finalText = ""
    finalSegments = []
    stopResolved = false
    firstWriteError = nil
    buffersWritten = 0
    var offReason: String? = nil
    let rec = SFSpeechRecognizer()
    let speechSupported = rec?.supportsOnDeviceRecognition ?? false
    let speechAuth = SFSpeechRecognizer.authorizationStatus()
    if !speechSupported {
      offReason = "unsupported" // no on-device model for this device/language
    } else if speechAuth != .authorized {
      offReason = speechAuth == .restricted ? "restricted" : "denied"
    }
    transcribing = offReason == nil
    if let rec = rec, transcribing {
      let req = SFSpeechAudioBufferRecognitionRequest()
      req.shouldReportPartialResults = true
      req.requiresOnDeviceRecognition = true
      request = req
      recognizer = rec
      task = rec.recognitionTask(with: req) { [weak self] result, error in
        guard let self = self else { return }
        if let result = result {
          let best = result.bestTranscription
          let text = best.formattedString
          self.sendEvent("onTranscript", ["text": text, "isFinal": result.isFinal])
          if result.isFinal {
            self.finalText = text
            self.finalSegments = best.segments.map { seg in
              ["start": seg.timestamp, "duration": seg.duration, "text": seg.substring]
            }
            self.resolveStop()
          }
        }
        if let error = error {
          // Recognition hiccups must never kill the recording itself.
          self.sendEvent("onError", ["message": error.localizedDescription])
          self.resolveStop()
        }
      }
    }

    input.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
      guard let self = self else { return }
      self.request?.append(buffer)
      self.writeToFile(buffer)
      self.writeRaw(buffer)
      self.emitLevel(buffer)
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      promise.reject(NamedException("AUDIO_ENGINE", "Engine failed to start: \(error.localizedDescription)"))
      return
    }

    self.engine = engine
    self.fileURL = url
    let startWall = Date()
    self.startTime = startWall

    // IMU sink (media parity): the gyro log starts at the recording clock
    // anchor — the anchor line binds the sensor clock to startWall — and
    // runs until finalizeMotionLog at the exact end of the take (manual
    // stop or interruption). A sink failure degrades the evidence, never
    // the recording (same rule as CaptureKit SensorLogger).
    motionLog = nil
    motionLogPath = nil
    motionLogState = "unavailable"
    if let sensorLogPath = sensorLogPath, !sensorLogPath.isEmpty {
      if CMMotionManager().isGyroAvailable {
        switch Self.fileURL(for: sensorLogPath) {
        case .success(let logURL):
          do {
            let log = try AudioMotionLog(
              url: logURL,
              anchorStartedAtMs: Int64(startWall.timeIntervalSince1970 * 1000)
            )
            log.start()
            motionLog = log
            motionLogState = "recorded"
          } catch {
            motionLogState = "failed"
            sendEvent("onError", ["message": "IMU log failed to start: \(error.localizedDescription)"])
          }
        case .failure(let error):
          motionLogState = "failed"
          sendEvent("onError", ["message": "IMU log failed to start: \(error.reason)"])
        }
      }
      // No gyro hardware: motionLogState stays "unavailable" — the exhibit
      // will honestly show the device could not provide motion data.
    }

    // A phone call (or Siri, or an alarm) seizes the audio session without
    // asking. Rather than losing the take, finalize the file at the last good
    // frame and tell JS — it seals the partial recording exactly like a
    // manual stop. Closing audioFile finalizes the m4a moov atom, so the
    // partial take is a complete, playable file.
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { [weak self] note in
      guard let self = self,
            let typeValue = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: typeValue) == .began
      else { return }
      self.handleInterruption()
    }

    promise.resolve(["transcribing": transcribing])
  }

  private func handleInterruption() {
    guard let engine = engine else { return } // already stopped — nothing to save
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    finalizeMotionLog()
    finishStop()
    sendEvent("onInterrupted", stopPayload())
  }

  /**
   * Closes the IMU log at the exact end of the take — called where the
   * engine stops (manual stop AND interruption), NOT in finishStop: a
   * manual stop waits up to 4s for the final transcript before finishStop
   * runs, and the gyro window must cover the recorded audio, not the
   * transcript wait. Idempotent.
   */
  private func finalizeMotionLog() {
    guard let log = motionLog else { return }
    motionLog = nil
    if let path = log.finish() {
      motionLogPath = path
      motionLogState = "recorded"
    } else {
      motionLogPath = nil
      motionLogState = "failed"
    }
  }

  private func writeRaw(_ buffer: AVAudioPCMBuffer) {
    // The raw master shares the delivery file's honesty rule: a failed
    // write is remembered and declared, never silently dropped.
    guard let file = rawFile else { return }
    do {
      try file.write(from: buffer)
      rawBuffersWritten += 1
      rawFramesWritten &+= buffer.frameLength
      // Anchor = the tap callback's wall clock at the first durable raw
      // frame ("append-instant" — the same honest semantics the video
      // tee declares when no source PTS back-projection is available).
      if rawFirstSampleWallClockUtcMs == nil {
        rawFirstSampleWallClockUtcMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
      }
    } catch {
      if rawWriteError == nil {
        rawWriteError = error.localizedDescription
        sendEvent("onError", ["message": "Raw audio master write failed: \(error.localizedDescription)"])
      }
    }
  }

  private func writeToFile(_ buffer: AVAudioPCMBuffer) {
    guard let file = audioFile, let converter = converter else { return }
    let outCapacity = max(buffer.frameCapacity, buffer.frameLength * 2, 4096)
    guard let outBuffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: outCapacity) else { return }
    var consumed = false
    var error: NSError?
    converter.convert(to: outBuffer, error: &error) { _, status in
      if consumed {
        status.pointee = .noDataNow
        return nil
      }
      consumed = true
      status.pointee = .haveData
      return buffer
    }
    if error == nil, outBuffer.frameLength > 0 {
      do {
        try file.write(from: outBuffer)
        buffersWritten += 1
      } catch {
        // Elegant fail, in the user's favor: remember the first error, tell
        // JS immediately (the take may be incomplete), and keep trying —
        // later buffers may still land. stop declares the outcome.
        if firstWriteError == nil {
          firstWriteError = error.localizedDescription
          sendEvent("onError", ["message": "Audio save error — this recording may be incomplete: \(error.localizedDescription)"])
        }
      }
    }
  }

  private func emitLevel(_ buffer: AVAudioPCMBuffer) {
    let now = Date()
    if now.timeIntervalSince(lastLevelSent) < 0.1 { return }
    guard let data = buffer.floatChannelData else { return }
    let n = Int(buffer.frameLength)
    if n == 0 { return }
    var sum: Float = 0
    for i in 0..<n { sum += data[0][i] * data[0][i] }
    let rms = sqrt(sum / Float(n))
    let db = 20 * log10(max(rms, 1e-7))
    lastLevelSent = now
    sendEvent("onLevel", ["db": Double(db)])
  }

  private func stop(promise: Promise) {
    guard let engine = engine else {
      promise.reject(NamedException("AUDIO_IDLE", "Not recording"))
      return
    }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    // The recorded window ends HERE — close the gyro log now so it covers
    // exactly the take, not the up-to-4s wait for the final transcript.
    finalizeMotionLog()

    if task != nil {
      // Wait briefly for the final transcript, then resolve with what we have.
      stopPromise = promise
      DispatchQueue.main.asyncAfter(deadline: .now() + 4.0) { [weak self] in
        self?.resolveStop()
      }
      request?.endAudio()
    } else {
      finishStop()
      promise.resolve(stopPayload())
    }
  }

  private func resolveStop() {
    guard !stopResolved, let promise = stopPromise else { return }
    stopResolved = true
    stopPromise = nil
    finishStop()
    promise.resolve(stopPayload())
  }

  private func finishStop() {
    if let obs = interruptionObserver {
      NotificationCenter.default.removeObserver(obs)
      interruptionObserver = nil
    }
    task?.cancel()
    task = nil
    request = nil
    recognizer = nil
    audioFile = nil // closing finalizes the m4a moov atom
    rawFile = nil // closing finalizes the CAF header
    converter = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func stopPayload() -> [String: Any] {
    let durationMs = startTime.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
    // Delivery-file sink, three-state honesty: "clean" (every buffer landed)
    // / "partial" (a write failed mid-take — the file is real but truncated,
    // and the error rides along) / "failed" (nothing durable — path is null,
    // the empty shell is removed, and JS must refuse to seal it).
    let fileState: String
    if buffersWritten == 0 {
      fileState = "failed"
      if let url = fileURL { try? FileManager.default.removeItem(at: url) }
    } else {
      fileState = firstWriteError != nil ? "partial" : "clean"
    }
    return [
      "path": fileState == "failed" ? NSNull() : (fileURL?.path ?? NSNull()),
      "durationMs": durationMs,
      "transcript": finalText,
      "segments": finalSegments,
      "fileState": fileState,
      "fileError": firstWriteError ?? NSNull(),
      // IMU sink, three-state honesty: "recorded" + path / "failed" + null /
      // "unavailable" + null. JS maps these onto the EvidencePath vocabulary
      // (path / enabled-but-failed null / 'never-recorded').
      "sensorLogPath": motionLogPath ?? NSNull(),
      "sensorLogState": motionLogState,
      // Raw-master sink, the same three-state vocabulary: "recorded" +
      // path / "failed" + null / "unavailable" + null (toggle off). Zero
      // durable buffers means nothing to keep — the empty shell is removed
      // and the take reports the sink failed.
      "rawPcmPath": rawSinkState().path ?? NSNull(),
      "rawPcmState": rawSinkState().state,
      "rawPcmError": rawWriteError ?? NSNull(),
      // ENF anchor + integrity summary, the same shape the video
      // tee commits (firstSampleWallClockUtcMs / firstSampleAnchor /
      // sampleCount / sampleRate / fileSha256 + the container's own
      // readback and the frames-match cross-check). Null unless the sink
      // recorded — JS seals it as the take's enfAnchor.
      "rawPcmInfo": rawPcmInfoSummary() ?? NSNull(),
    ]
  }

  /// ENF anchor + integrity summary for the committed raw master,
  /// mirroring the video path's rawPcmInfo field-for-field. Nil unless the
  /// sink recorded; every sub-field that cannot be produced rides as null
  /// rather than being invented.
  private func rawPcmInfoSummary() -> [String: Any]? {
    let sink = rawSinkState()
    guard sink.state == "recorded", let url = rawFileURL else { return nil }
    var sha: String? = nil
    if let bytes = try? Data(contentsOf: url) {
      sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    var info: [String: Any] = [
      "firstSampleWallClockUtcMs": (rawFirstSampleWallClockUtcMs as Any?) ?? NSNull(),
      "firstSampleAnchor": "append-instant",
      "sampleCount": Int(rawFramesWritten),
      "sampleRate": Int(rawSampleRate),
      "fileSha256": (sha as Any?) ?? NSNull(),
    ]
    // Commit the container's own readback alongside the writer's counters —
    // a divergence is then a committed fact, not a post-hoc riddle.
    if let facts = cafContainerFacts(url) {
      for (key, value) in facts { info[key] = value }
      info["framesMatchContainer"] = (facts["containerFrames"] as? Int) == Int(rawFramesWritten)
    }
    return info
  }

  /// The CAF container's own stated layout + payload size, read back from
  /// the committed bytes (ported from the exhibit-camera module,:
  /// layout-aware — AVAudioFile's hardware-format CAFs can carry the
  /// compacted 32-byte description where every field after mBytesPerPacket
  /// sits 4 bytes early, so when the standard read lands on an impossible
  /// bit depth the compacted offsets get their say, stated via
  /// containerDescLayout).
  private func cafContainerFacts(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url), data.count >= 12 else { return nil }
    guard data[0] == 0x63, data[1] == 0x61, data[2] == 0x66, data[3] == 0x66 else { return nil } // 'caff'
    func be32(_ at: Int) -> UInt32 {
      (UInt32(data[at]) << 24) | (UInt32(data[at + 1]) << 16) | (UInt32(data[at + 2]) << 8) | UInt32(data[at + 3])
    }
    var off = 8
    var sampleRate: Double = 0
    var flags: UInt32 = 0
    var bytesPerFrame: UInt32 = 0
    var channels: UInt32 = 0
    var bits: UInt32 = 0
    var descLayout = "standard"
    var payloadBytes: Int? = nil
    let plausibleBits: [UInt32] = [0, 8, 16, 20, 24, 32, 64]
    while off + 12 <= data.count {
      let t0 = data[off], t1 = data[off + 1], t2 = data[off + 2], t3 = data[off + 3]
      let hi = be32(off + 4)
      let lo = be32(off + 8)
      // A size of -1 (0xFFFFFFFF) means "to end of file" per the CAF spec.
      let size = (hi == 0 && lo != 0xffffffff) ? Int(lo) : data.count - (off + 12)
      let body = off + 12
      if t0 == 0x64, t1 == 0x65, t2 == 0x73, t3 == 0x63, body + 32 <= data.count { // 'desc'
        var rateBits: UInt64 = 0
        for i in 0..<8 { rateBits = (rateBits << 8) | UInt64(data[body + i]) }
        sampleRate = Double(bitPattern: rateBits)
        flags = be32(body + 12)
        bytesPerFrame = be32(body + 24)
        channels = be32(body + 28)
        bits = body + 36 <= data.count ? be32(body + 32) : UInt32.max
        // The compacted 32-byte description (mFramesPerPacket absent): when
        // the standard read lands on an impossible bit depth — e.g. the
        // next chunk's FourCC — the real fields sit 4 bytes early.
        if !plausibleBits.contains(bits), size == 32 || body + 36 > data.count {
          bytesPerFrame = be32(body + 20)
          channels = be32(body + 24)
          bits = be32(body + 28)
          descLayout = "compacted-32"
        }
      } else if t0 == 0x64, t1 == 0x61, t2 == 0x74, t3 == 0x61 { // 'data' — 4-byte edit count, then payload
        payloadBytes = max(0, size - 4)
      }
      if size <= 0 { break }
      off = body + size
    }
    guard let payload = payloadBytes, bytesPerFrame > 0 else { return nil }
    // Non-interleaved CAF stores channel blocks: bytesPerFrame is per-channel,
    // so a full frame spans bytesPerFrame × channels (mirrors the JS reader).
    let nonInterleaved = (flags & 32) != 0
    let frameBytes = nonInterleaved ? Int(bytesPerFrame) * Int(max(1, channels)) : Int(bytesPerFrame)
    return [
      "containerSampleRate": sampleRate,
      "containerFormatFlags": Int(flags),
      "containerBytesPerFrame": Int(bytesPerFrame),
      "containerChannels": Int(channels),
      "containerBitsPerChannel": Int(bits),
      "containerDescLayout": descLayout,
      "containerPayloadBytes": payload,
      "containerFrames": payload / max(1, frameBytes),
    ]
  }

  /// The raw sink's stop-time state, computed once per payload (stop and
  /// interruption both read it). A requested master with zero buffers is
  /// "failed" and its empty file is removed.
  private func rawSinkState() -> (state: String, path: String?) {
    guard rawFileURL != nil else { return (rawState, nil) }
    if rawBuffersWritten == 0 {
      if let url = rawFileURL { try? FileManager.default.removeItem(at: url) }
      return ("failed", nil)
    }
    return ("recorded", rawFileURL?.path)
  }
}
