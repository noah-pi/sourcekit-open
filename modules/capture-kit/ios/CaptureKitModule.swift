// Written with AI assistance. Verification: docs/PROVENANCE.md.
import ExpoModulesCore
import AVFoundation
import CoreMedia
import CoreVideo

/**
 * CaptureKit — evidentiary camera capture (SPEC WS1).
 *
 * The camera commits, it never concludes (SPEC §0 rule 1): this module
 * captures and hashes. No analysis, no verdicts, no ENF logic. It records
 * evidence (ring buffer, raw PCM master, sensor log, region-derived
 * anti-banding state) for desk-side analysis later.
 *
 * Architecture: ONE AVCaptureSession; the video/audio data outputs fan out
 * sample buffers on a single serial session queue to:
 *   1. AVAssetWriter → delivery.mp4 (H.264/AAC)
 *   2. StreamingHasher → legacy 0.11.x stream commitment (see below)
 *   3. PcmMasterWriter → LPCM mono 16 kHz 16-bit.caf master (§5.1)
 *   4. RingBuffer → last 8 frames, JPEG dump on photo only (§4)
 *   5. SensorLogger → 100 Hz IMU/baro/fused-loc JSONL file (§5.2)
 *
 * Hashing reality: the StreamingHasher NEVER sees delivery
 * (compressed H.264/AAC) bytes. Video capture frames are CVPixelBuffer-backed
 * with no CMBlockBuffer, so hashBytes's CMSampleBufferGetDataBuffer guard is
 * always nil and no video byte is ever hashed — the video Merkle root is the
 * documented empty-stream SHA-256 with 0 chunks. Audio roots commit the
 * pre-encode native LPCM sample stream handed to the AAC encoder, NOT the
 * AAC bytes stored in the file. As of these roots are no longer
 * consumed for new seals (v2 delivery-file roots are computed at seal time
 * and carry the commitment); the machinery remains only so 0.11.x records
 * can still be reproduced. See StreamingHasher.swift.
 *
 * Thread confinement: ALL mutable session state lives on `sessionQueue`.
 * Both data outputs deliver onto that same queue, so writer appends, hashing,
 * ring retention, PCM writes, and lifecycle never race. Events are emitted
 * from that queue (sendEvent is safe from any thread).
 *
 * No network I/O of any kind (SPEC §0 rule 5).
 */

/**
 * promise.reject(code, description) silently DROPS the description on SDK 57:
 * the JS-visible message is built from `reason` (which the convenience init
 * never sets), so every rejection arrived as "CODE: undefined reason" and
 * real failures were undiagnosable. This subclass carries the message in
 * `reason`, so actionable errors reach JS. (Same pattern as
 * AudioCaptureModule; own copy because this is a separate pod target.)
 */
final class NamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

/// AVCaptureVideoDataOutputSampleBufferDelegate /
/// AVCaptureAudioDataOutputSampleBufferDelegate forwarder. The Module class
/// is not an NSObject, so delegate conformance lives here. Both outputs
/// share the module's serial session queue, so callbacks are serialized.
final class SampleBufferHandler: NSObject,
  AVCaptureVideoDataOutputSampleBufferDelegate,
  AVCaptureAudioDataOutputSampleBufferDelegate {
  var onVideo: ((CMSampleBuffer) -> Void)?
  var onAudio: ((CMSampleBuffer) -> Void)?

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    if output is AVCaptureVideoDataOutput {
      onVideo?(sampleBuffer)
    } else {
      onAudio?(sampleBuffer)
    }
  }
}

/// AVCapturePhotoCaptureDelegate forwarder (one per capturePhotoWithRing call;
/// the module retains it until completion).
final class PhotoCaptureHandler: NSObject, AVCapturePhotoCaptureDelegate {
  let completion: (AVCapturePhoto?, Error?) -> Void

  init(completion: @escaping (AVCapturePhoto?, Error?) -> Void) {
    self.completion = completion
  }

  func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    completion(photo, error)
  }
}

public class CaptureKitModule: Module {

  // MARK: - Session state (ALL confined to sessionQueue)

  private enum SessionKind { case video, photo }

  /// One serial queue owns the capture session and every sink.
  private let sessionQueue = DispatchQueue(label: "com.verify.capturekit.session")

  private var session: AVCaptureSession?
  private var sessionKind: SessionKind?
  private var sessionId: String = ""
  private var videoDevice: AVCaptureDevice?
  private var videoOutput: AVCaptureVideoDataOutput?
  private var audioOutput: AVCaptureAudioDataOutput?
  private var photoOutput: AVCapturePhotoOutput?
  private let sampleHandler = SampleBufferHandler()
  private var photoHandler: PhotoCaptureHandler?

  private var writer: AVAssetWriter?
  private var writerVideoInput: AVAssetWriterInput?
  private var writerAudioInput: AVAssetWriterInput?
  private var writerStarted = false
  private var writerFailed = false
  /// Count of audio sample buffers SUCCESSFULLY appended to the delivery
  /// writer. writerAudioInput existing only proves an audio buffer ARRIVED
  /// (and that first buffer is itself dropped pre-startSession) — the
  /// stop-payload audioTrack must be derived from this count, so a take
  /// whose only audio buffer was the dropped one reports audioTrack:false.
  private var appendedAudioBuffers = 0
  /// First-buffer PTS stashed per track at input-creation time. The writer
  /// session starts at the EARLIER of the two so neither track's head is
  /// clipped (startSession(atSourceTime:) precedes every appended buffer).
  private var writerVideoFirstPTS: CMTime?
  private var writerAudioFirstPTS: CMTime?
  /// Audio-absent fallback (~500 ms after the first video frame): a dead
  /// mic must not kill the delivery file (rule 4) — start video-only.
  private var writerAudioFallback: DispatchWorkItem?
  /// onError dedupe: each code fires AT MOST ONCE per session. Without this
  /// a rejected writer input re-fired on every audio buffer (~43/s) and
  /// flooded the bridge for the rest of the take.
  private var firedErrorCodes = Set<String>()

  private var hasher: StreamingHasher?
  private var pcm: PcmMasterWriter?
  private var pcmFailed = false
  /// Native→canonical (16 kHz mono int16) converter for the PCM master.
  /// Session-queue confined, like the sinks it feeds.
  private let masterConverter = AudioMasterConverter()
  private let ring = RingBuffer()
  private var sensors: SensorLogger?
  private var toggles = EvidenceToggles(opts: nil)

  private var deliveryURL: URL?
  private var evidenceDirURL: URL?

  private var startDate: Date?      // wall clock of first video frame
  private var startPromise: Promise?
  private var startPromiseDone = false
  private var startTimeout: DispatchWorkItem?
  private var maxDurationItem: DispatchWorkItem?

  private var stopping = false
  private var cachedStopOutcome: Result<[String: Any], NamedException>?

  private var lastLevelSent = Date.distantPast
  private var runtimeErrorObserver: NSObjectProtocol?

  // Photo-capture in-flight state
  private var photoPromise: Promise?
  private var photoWaitingForRing = false
  private var photoTimeout: DispatchWorkItem?

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("CaptureKit")
    Events("onChunkHashed", "onRecordingLevel", "onError")

    AsyncFunction("requestPermissions") { (promise: Promise) in
      AVCaptureDevice.requestAccess(for: .video) { camera in
        if #available(iOS 17.0, *) {
          AVAudioApplication.requestRecordPermission { mic in
            promise.resolve(["camera": camera, "microphone": mic])
          }
        } else {
          AVAudioSession.sharedInstance().requestRecordPermission { mic in
            promise.resolve(["camera": camera, "microphone": mic])
          }
        }
      }
    }

    AsyncFunction("startVideoSession") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.startVideoSession(opts: opts, promise: promise)
      }
    }

    AsyncFunction("stopVideoSession") { (promise: Promise) in
      self.sessionQueue.async {
        self.stopVideoSession(promise: promise)
      }
    }

    AsyncFunction("capturePhotoWithRing") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.capturePhotoWithRing(opts: opts, promise: promise)
      }
    }

    AsyncFunction("detectPlatformIngredient") { (assetPath: String, promise: Promise) in
      promise.resolve(self.detectPlatformIngredient(assetPath: assetPath))
    }
  }

  // MARK: - Helpers

  private func sendError(_ code: String, _ message: String) {
    // firedErrorCodes is sessionQueue-confined state, but the runtime-error
    // observer fires on an arbitrary thread — hop. Same-queue callers keep
    // FIFO order, so an error still precedes the stop promise's settlement.
    sessionQueue.async { [weak self] in
      guard let self = self, !self.firedErrorCodes.contains(code) else { return }
      self.firedErrorCodes.insert(code)
      self.sendEvent("onError", ["code": code, "message": message])
    }
  }

  /// Resolve a start promise exactly once.
  private func resolveStart(_ payload: [String: Any]) {
    guard !startPromiseDone, let promise = startPromise else { return }
    startPromiseDone = true
    startPromise = nil
    startTimeout?.cancel()
    startTimeout = nil
    promise.resolve(payload)
  }

  private func rejectStart(_ error: NamedException) {
    guard !startPromiseDone, let promise = startPromise else { return }
    startPromiseDone = true
    startPromise = nil
    startTimeout?.cancel()
    startTimeout = nil
    promise.reject(error)
  }

  private func currentEpochMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
  }

  private func findBackCamera(_ lens: LensChoice) -> AVCaptureDevice? {
    if let device = AVCaptureDevice.default(lens.deviceType, for: .video, position: .back) {
      return device
    }
    // Honest fallback: requested lens not present on this hardware → wide.
    // (The result payload carries no lens claim, so nothing is misreported;
    // documented behavior — the caller gets SOME capture or E_PLATFORM.)
    return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
  }

  // MARK: - startVideoSession

  private func startVideoSession(opts: [String: Any], promise: Promise) {
    guard session == nil else {
      promise.reject(NamedException(CaptureKitErrorCode.busy, "A capture session is already running"))
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
          AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      promise.reject(NamedException(CaptureKitErrorCode.permission, "Camera and microphone permission are required"))
      return
    }
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          let deliveryURL = captureKitURL(for: deliveryPath),
          let evidenceDirURL = captureKitURL(for: evidenceDir) else {
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }
    let lens = LensChoice(jsValue: opts["lens"] as? String)
    let maxDurationSec = (opts["maxDurationSec"] as? NSNumber)?.doubleValue ?? 120.0
    let toggles = EvidenceToggles(opts: opts)

    // SPEC §5.1: disable voice processing / AGC / noise suppression as far as
    // public API allows. We configure the audio session ourselves and stop
    // AVCaptureSession from reconfiguring it.
    do {
      let audio = AVAudioSession.sharedInstance()
      try audio.setCategory(.record, mode: .measurement, options: [])
      try audio.setActive(true, options: .notifyOthersOnDeactivation)
    } catch {
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Audio session configuration failed: \(error.localizedDescription)"))
      return
    }

    guard let device = findBackCamera(lens) else {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      promise.reject(NamedException(CaptureKitErrorCode.platform, "No back camera available on this device"))
      return
    }

    let session = AVCaptureSession()
    session.automaticallyConfiguresApplicationAudioSession = false
    // 1080p delivery; preview frames stay under the SPEC §4 1920×1440 cap.
    session.sessionPreset = .hd1920x1080
    session.beginConfiguration()

    do {
      let videoInput = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(videoInput) else {
        throw NamedException(CaptureKitErrorCode.platform, "Cannot add video input")
      }
      session.addInput(videoInput)
    } catch let e as NamedException {
      session.commitConfiguration()
      promise.reject(e)
      return
    } catch {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Video input failed: \(error.localizedDescription)"))
      return
    }

    if let audioDevice = AVCaptureDevice.default(for: .audio) {
      do {
        let audioInput = try AVCaptureDeviceInput(device: audioDevice)
        if session.canAddInput(audioInput) {
          session.addInput(audioInput)
        }
      } catch {
        session.commitConfiguration()
        promise.reject(NamedException(CaptureKitErrorCode.platform, "Microphone input failed: \(error.localizedDescription)"))
        return
      }
    } else {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "No audio capture device available"))
      return
    }

    let videoOutput = AVCaptureVideoDataOutput()
    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_32BGRA),
    ]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(sampleHandler, queue: sessionQueue)
    guard session.canAddOutput(videoOutput) else {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Cannot add video data output"))
      return
    }
    session.addOutput(videoOutput)

    // SPEC §5.1: on iOS, AVCaptureAudioDataOutput ALWAYS delivers the
    // device-native audio format — its `audioSettings` property is
    // macOS-only. The native buffers feed the AAC delivery writer as-is;
    // AudioMasterConverter resamples/downmixes them to the canonical LPCM
    // mono 16 kHz 16-bit master format for the PCM sink.
    let audioOutput = AVCaptureAudioDataOutput()
    audioOutput.setSampleBufferDelegate(sampleHandler, queue: sessionQueue)
    guard session.canAddOutput(audioOutput) else {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Cannot add audio data output"))
      return
    }
    session.addOutput(audioOutput)

    session.commitConfiguration()

    // Delivery writer (SPEC §3: single AVAssetWriter, H.264/AAC).
    try? FileManager.default.createDirectory(at: deliveryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: deliveryURL) // AVAssetWriter fails on existing files
    let writer: AVAssetWriter
    do {
      writer = try AVAssetWriter(outputURL: deliveryURL, fileType: .mp4)
    } catch {
      promise.reject(NamedException(CaptureKitErrorCode.writer, "Cannot create delivery writer: \(error.localizedDescription)"))
      return
    }

    // Wire up state BEFORE startRunning so early sample buffers land safely.
    let sid = UUID().uuidString
    self.session = session
    self.sessionKind = .video
    self.sessionId = sid
    self.videoDevice = device
    self.videoOutput = videoOutput
    self.audioOutput = audioOutput
    self.writer = writer
    self.deliveryURL = deliveryURL
    self.evidenceDirURL = evidenceDirURL
    self.hasher = StreamingHasher()
    self.ring.clear()
    self.writerStarted = false
    self.writerFailed = false
    self.writerVideoInput = nil
    self.writerAudioInput = nil
    self.writerVideoFirstPTS = nil
    self.writerAudioFirstPTS = nil
    self.writerAudioFallback = nil
    self.firedErrorCodes.removeAll()
    self.appendedAudioBuffers = 0
    self.pcmFailed = false
    self.startDate = nil
    self.stopping = false
    self.cachedStopOutcome = nil
    self.lastLevelSent = .distantPast
    self.toggles = toggles

    let hasher = self.hasher!
    hasher.onChunk = { [weak self] chunk in
      self?.sendEvent("onChunkHashed", [
        "sessionId": sid,
        "index": chunk.index,
        "bytes": chunk.bytes,
        "sha256Hex": chunk.sha256Hex,
      ])
    }

    sampleHandler.onVideo = { [weak self] buffer in
      self?.handleVideoSample(buffer)
    }
    sampleHandler.onAudio = { [weak self] buffer in
      self?.handleAudioSample(buffer)
    }

    // PCM master sink — only when the toggle enables it (rule 4b: disabled
    // means never-started, never-recorded). Failure → onError E_PCM_SINK +
    // null path; delivery unaffected (rule 4: evidence degrades, delivery
    // never dies).
    if toggles.rawPcm {
      let pcmURL = evidenceDirURL.appendingPathComponent("master-\(sid).caf")
      do {
        self.pcm = try PcmMasterWriter(url: pcmURL)
      } catch {
        self.pcm = nil
        self.pcmFailed = true
        sendError(CaptureKitErrorCode.pcmSink, error.localizedDescription)
      }
    }

    runtimeErrorObserver = NotificationCenter.default.addObserver(
      forName: .AVCaptureSessionRuntimeError,
      object: session,
      queue: nil
    ) { [weak self] note in
      let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
      self?.sendError(CaptureKitErrorCode.platform, "Capture session runtime error: \(err?.localizedDescription ?? "unknown")")
    }

    self.startPromise = promise
    self.startPromiseDone = false

    session.startRunning() // blocking; we are on sessionQueue

    // First-frame timeout: without frames the session never truly started.
    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self, !self.startPromiseDone else { return }
      self.rejectStart(NamedException(CaptureKitErrorCode.platform, "No video frames arrived within 10s of start"))
      self.teardownSession()
    }
    self.startTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: timeout)

    // Hard stop + auto-finalize at maxDurationSec (SPEC §2.2).
    let item = DispatchWorkItem { [weak self] in
      self?.autoFinalize()
    }
    self.maxDurationItem = item
    sessionQueue.asyncAfter(deadline: .now() + max(1.0, maxDurationSec), execute: item)
  }

  // MARK: - Sample buffer fan-out (sessionQueue only)

  private func handleVideoSample(_ sampleBuffer: CMSampleBuffer) {
    // Ring retention only when the toggle enables it (rule 4b). Photo
    // sessions dump it; video sessions discard on stop (SPEC §4).
    if toggles.ring, let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
      ring.retain(pixelBuffer)
    }

    let firstFrame = (startDate == nil)
    if firstFrame {
      startDate = Date()
      let startedAtMs = currentEpochMs()
      // Sensor log starts at the frame-clock anchor so the recorded window
      // covers exactly the captured frames (SPEC §5.2).
      startSensorLogger(anchorStartedAtMs: startedAtMs)
      resolveStart([
        "sessionId": sessionId,
        "startedAtMs": startedAtMs,
        "mainsHz": AntiBandingState.regionMainsHz(),
      ])
    }

    // Photo sessions only feed the ring — no writer, no hashing.
    guard sessionKind == .video else {
      maybeTriggerPhotoCapture()
      return
    }

    // Post-failure no-op: once the delivery writer is dead, handlers return
    // before doing any per-frame writer work (the error already fired once).
    guard let writer = writer, !writerFailed else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    if writerVideoInput == nil {
      // Lazily create the video writer input from the actual stream format —
      // width/height then match whatever the device really delivers. The
      // input is created BEFORE startWriting: AVAssetWriter refuses inputs
      // added after startWriting.
      guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
      let dims = CMVideoFormatDescriptionGetDimensions(formatDesc)
      let videoSettings: [String: Any] = [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: NSNumber(value: dims.width),
        AVVideoHeightKey: NSNumber(value: dims.height),
        AVVideoCompressionPropertiesKey: [
          AVVideoAverageBitRateKey: NSNumber(value: 10_000_000),
        ],
      ]
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings, sourceFormatHint: formatDesc)
      input.expectsMediaDataInRealTime = true
      if let connection = videoOutput?.connection(with: .video) {
        input.transform = rotationTransform(for: connection)
      }
      guard writer.canAdd(input) else {
        writerFailed = true
        sendError(CaptureKitErrorCode.writer, "Asset writer rejected the video input: \(writer.error?.localizedDescription ?? "unknown")")
        return
      }
      writer.add(input)
      writerVideoInput = input
      writerVideoFirstPTS = pts
      scheduleAudioFallback()
    }

    // Frames that arrive before startSession(atSourceTime:) are DROPPED —
    // appending before the session starts is illegal. The writer starts once
    // BOTH track inputs exist (or the audio-absent fallback has fired).
    guard writerStarted else {
      maybeStartWriter()
      return
    }

    guard writer.status == .writing, let input = writerVideoInput, input.isReadyForMoreMediaData else { return }
    if input.append(sampleBuffer) {
      hashBytes(track: .video, from: sampleBuffer)
    } else if writer.status == .failed {
      writerFailed = true
      sendError(CaptureKitErrorCode.writer, "Asset writer append failed: \(writer.error?.localizedDescription ?? "unknown")")
    }
  }

  private func handleAudioSample(_ sampleBuffer: CMSampleBuffer) {
    // PCM master sink consumes a canonical (16 kHz mono int16) conversion of
    // the native buffer; the AAC writer consumes the native buffer as-is.
    // Conversion or write failure → one onError E_PCM_SINK, rawPcmPath:null;
    // delivery unaffected (SPEC §5.1, rule 4).
    if let pcm = pcm, !pcmFailed {
      do {
        if let converted = try masterConverter?.convert(sampleBuffer) {
          try pcm.append(pcmBuffer: converted)
        } else if masterConverter == nil {
          throw PcmMasterWriter.SinkError.badBuffer("audio master converter unavailable")
        }
      } catch {
        pcm.markFailed()
        pcmFailed = true
        sendError(CaptureKitErrorCode.pcmSink, error.localizedDescription)
      }
    }

    emitLevel(sampleBuffer)

    // Post-failure no-op (cheap early return; the error already fired once).
    guard sessionKind == .video, let writer = writer, !writerFailed else { return }

    if writerAudioInput == nil, !writerStarted {
      // Create the audio input BEFORE startWriting — AVAssetWriter refuses
      // inputs added after startWriting.
      guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
      // Encode AAC at the source stream's own rate/channel count — the
      // writer receives native buffers, so its settings must match them.
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: PcmMasterWriter.deliveryAudioWriterSettings(
          sourceSampleRate: asbd?.pointee.mSampleRate ?? 44_100,
          sourceChannels: asbd?.pointee.mChannelsPerFrame ?? 1
        ),
        sourceFormatHint: formatDesc
      )
      input.expectsMediaDataInRealTime = true
      guard writer.canAdd(input) else {
        writerFailed = true
        sendError(CaptureKitErrorCode.writer, "Asset writer rejected the audio input: \(writer.error?.localizedDescription ?? "unknown")")
        return
      }
      writer.add(input)
      writerAudioInput = input
      writerAudioFirstPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    }

    if !writerStarted {
      // Pre-startSession buffers are DROPPED (appending before it is
      // illegal). This also covers the video-only fallback start: the audio
      // input must NOT be added late, so late audio lands here (or in the
      // nil-input guard below), dropped and never hashed.
      maybeStartWriter()
      return
    }

    // writerAudioInput == nil after start means the audio-absent fallback
    // fired — drop late audio honestly; nothing is hashed for the track.
    guard writer.status == .writing, let input = writerAudioInput, input.isReadyForMoreMediaData else { return }
    if input.append(sampleBuffer) {
      appendedAudioBuffers += 1
      hashBytes(track: .audio, from: sampleBuffer)
    } else if writer.status == .failed {
      writerFailed = true
      sendError(CaptureKitErrorCode.writer, "Asset writer audio append failed: \(writer.error?.localizedDescription ?? "unknown")")
    }
  }

  // MARK: - Writer start (both inputs BEFORE startWriting)

  /// Starts the delivery writer once BOTH track inputs exist (the
  /// audio-absent fallback is the other path in). The session starts at the
  /// EARLIER of the two tracks' first-buffer PTS values so neither track's
  /// head is clipped.
  private func maybeStartWriter() {
    guard !writerStarted, !writerFailed,
          writerVideoInput != nil, writerAudioInput != nil,
          let videoPTS = writerVideoFirstPTS, let audioPTS = writerAudioFirstPTS else { return }
    let startPTS = CMTimeCompare(videoPTS, audioPTS) <= 0 ? videoPTS : audioPTS
    startWriterSession(at: startPTS)
  }

  /// Arms the audio-absent fallback (rule 4: delivery never dies). If no
  /// audio buffer has arrived ~500 ms after the first video frame (mic
  /// failure, no audio device), the writer starts video-only; the absence
  /// is stated honestly in the stop payload (audioTrack: false).
  private func scheduleAudioFallback() {
    writerAudioFallback?.cancel()
    let item = DispatchWorkItem { [weak self] in
      guard let self = self, !self.writerStarted, !self.writerFailed,
            self.writerVideoInput != nil, self.writerAudioInput == nil,
            let videoPTS = self.writerVideoFirstPTS else { return }
      self.startWriterSession(at: videoPTS)
    }
    writerAudioFallback = item
    sessionQueue.asyncAfter(deadline: .now() + 0.5, execute: item)
  }

  private func startWriterSession(at pts: CMTime) {
    guard let writer = writer, !writerStarted, !writerFailed else { return }
    writerAudioFallback?.cancel()
    writerAudioFallback = nil
    guard writer.startWriting() else {
      writerFailed = true
      sendError(CaptureKitErrorCode.writer, "Asset writer failed to start: \(writer.error?.localizedDescription ?? "unknown")")
      return
    }
    writer.startSession(atSourceTime: pts)
    writerStarted = true
  }

  /// Commit sample-buffer bytes to the legacy (0.11.x) streaming hasher.
  ///
  /// AUDIT NOTE: this does NOT hash delivery/compressed bytes.
  /// Video: AVCaptureVideoDataOutput frames wrap a CVPixelBuffer and carry
  /// no CMBlockBuffer, so the guard below ALWAYS yields nil for capture
  /// frames — no video byte is ever hashed and the video root is the
  /// empty-stream hash with 0 chunks. Audio: the bytes hashed are the
  /// pre-encode native LPCM samples the AAC writer was handed, not the
  /// encoded AAC in the delivery file. Retained for 0.11.x record
  /// reproduction only; seals use v2 delivery-file roots.
  private func hashBytes(track: HashTrack, from sampleBuffer: CMSampleBuffer) {
    // Nil for every video capture frame (CVPixelBuffer-backed, no
    // CMBlockBuffer) — see the audit note above.
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0 else { return }
    var data = Data(count: length)
    let status = data.withUnsafeMutableBytes { ptr -> OSStatus in
      guard let base = ptr.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
    }
    guard status == kCMBlockBufferNoErr else { return }
    hasher?.append(track: track, data: data)
  }

  /// ~4 Hz level meter for the UI (SPEC §2.2 onRecordingLevel, §5.3).
  /// dBFS of the LPCM int16 stream; ≤ 0 by construction.
  private func emitLevel(_ sampleBuffer: CMSampleBuffer) {
    let now = Date()
    if now.timeIntervalSince(lastLevelSent) < 0.25 { return }
    guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
    let length = CMBlockBufferGetDataLength(block)
    guard length > 0 else { return }
    // The audio data output delivers the device-native format on iOS —
    // usually Float32 LPCM, sometimes Int16 — so decode per the ASBD.
    var isFloat = false
    var bytesPerSample = MemoryLayout<Int16>.size
    if let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer),
       let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc) {
      let flags = asbd.pointee.mFormatFlags
      isFloat = (flags & kAudioFormatFlagIsFloat) != 0
      let bits = Int(asbd.pointee.mBitsPerChannel)
      if bits > 0 { bytesPerSample = bits / 8 }
    }
    let sampleCount = length / bytesPerSample
    guard sampleCount > 0 else { return }
    var sumSquares: Double = 0
    var data = Data(count: length)
    let status = data.withUnsafeMutableBytes { ptr -> OSStatus in
      guard let base = ptr.baseAddress else { return -1 }
      return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
    }
    guard status == kCMBlockBufferNoErr else { return }
    data.withUnsafeBytes { raw in
      if isFloat {
        guard let base = raw.baseAddress?.assumingMemoryBound(to: Float.self) else { return }
        for i in 0..<sampleCount {
          let v = Double(base[i])
          sumSquares += v * v
        }
      } else if bytesPerSample == MemoryLayout<Int16>.size {
        guard let base = raw.baseAddress?.assumingMemoryBound(to: Int16.self) else { return }
        for i in 0..<sampleCount {
          let v = Double(base[i]) / 32768.0
          sumSquares += v * v
        }
      } // other widths: skip this tick rather than emit a garbage level
    }
    let rms = sqrt(sumSquares / Double(sampleCount))
    let db = 20.0 * log10(max(rms, 1e-7))
    lastLevelSent = now
    sendEvent("onRecordingLevel", ["db": db])
  }

  private func rotationTransform(for connection: AVCaptureConnection) -> CGAffineTransform {
    // Rotation needed to display the sensor-native buffers upright.
    if #available(iOS 17.0, *) {
      let angle = connection.videoRotationAngle
      return CGAffineTransform(rotationAngle: CGFloat(angle) * .pi / 180.0)
    } else {
      switch connection.videoOrientation {
      case .portrait: return CGAffineTransform(rotationAngle: .pi / 2)
      case .portraitUpsideDown: return CGAffineTransform(rotationAngle: -.pi / 2)
      case .landscapeLeft: return CGAffineTransform(rotationAngle: .pi)
      default: return .identity
      }
    }
  }

  // MARK: - Sensor logger (lazy, anchored to first frame)

  private func startSensorLogger(anchorStartedAtMs: Int64) {
    // Toggle gate (rule 4b): disabled → never-started, never-recorded; the
    // result field will be null with evidenceEnabled.sensors=false.
    guard toggles.sensors, sensors == nil, let evidenceDir = evidenceDirURL else { return }
    let url = evidenceDir.appendingPathComponent("sensors-\(sessionId).jsonl")
    do {
      let logger = try SensorLogger(url: url, anchorStartedAtMs: anchorStartedAtMs)
      logger.start()
      sensors = logger
    } catch {
      sensors = nil
      sendError(CaptureKitErrorCode.sensorLog, error.localizedDescription)
    }
  }

  // MARK: - stopVideoSession

  private func stopVideoSession(promise: Promise) {
    if let cached = cachedStopOutcome {
      cachedStopOutcome = nil
      switch cached {
      case .success(let payload): promise.resolve(payload)
      case .failure(let error): promise.reject(error)
      }
      return
    }
    guard session != nil, sessionKind == .video else {
      promise.reject(NamedException(CaptureKitErrorCode.noSession, "No video session is running"))
      return
    }
    guard !stopping else {
      promise.reject(NamedException(CaptureKitErrorCode.busy, "Session is already stopping"))
      return
    }
    stopping = true
    performStop { outcome in
      switch outcome {
      case .success(let payload): promise.resolve(payload)
      case .failure(let error): promise.reject(error)
      }
    }
  }

  /// Max-duration hard stop + auto-finalize (SPEC §2.2). The outcome is
  /// cached; the next stopVideoSession call returns it exactly.
  private func autoFinalize() {
    guard session != nil, sessionKind == .video, !stopping, cachedStopOutcome == nil else { return }
    stopping = true
    // If the session never produced frames, the start promise may still be
    // pending — fail it honestly rather than leave JS hanging.
    rejectStart(NamedException(CaptureKitErrorCode.platform, "Session auto-stopped before the first frame"))
    performStop { [weak self] outcome in
      self?.cachedStopOutcome = outcome
    }
  }

  /**
   * Shared stop pipeline (manual stop and max-duration auto-stop). Order:
   * halt capture → flush hash tails → close PCM/sensor sinks → discard ring
   * (video sessions: ringBufferDir is null, SPEC §4) → finish delivery file.
   * The completion always hops back onto sessionQueue before running.
   */
  private func performStop(completion: @escaping (Result<[String: Any], NamedException>) -> Void) {
    // finishWriting's callback fires on an internal writer queue; hop back
    // onto sessionQueue (and release session state there) before completing.
    let finishOnQueue: (Result<[String: Any], NamedException>) -> Void = { [weak self] outcome in
      self?.sessionQueue.async {
        self?.teardownSession()
        completion(outcome)
      }
    }

    maxDurationItem?.cancel()
    maxDurationItem = nil
    startTimeout?.cancel()
    startTimeout = nil
    writerAudioFallback?.cancel()
    writerAudioFallback = nil

    session?.stopRunning()
    sampleHandler.onVideo = nil
    sampleHandler.onAudio = nil
    videoOutput?.setSampleBufferDelegate(nil, queue: nil)
    audioOutput?.setSampleBufferDelegate(nil, queue: nil)

    // Evidence sinks, degrade-on-failure with explicit nulls (rule 4).
    hasher?.finalize()
    var evidence = SessionEvidence()
    if !toggles.rawPcm {
      evidence.rawPcmPath = nil // never-recorded (toggle off, rule 4b)
    } else if pcmFailed || pcm == nil {
      evidence.rawPcmPath = nil // enabled but failed (onError already fired)
    } else {
      // Flush the converter's SRC delay line: with its single-shot input
      // closure, tail frames absorbed during the take only emerge when the
      // converter sees.endOfStream (see AudioMasterConverter.drain).
      do {
        if let tail = try masterConverter?.drain() {
          try pcm?.append(pcmBuffer: tail)
        }
      } catch {
        pcm?.markFailed()
        pcmFailed = true
        sendError(CaptureKitErrorCode.pcmSink, error.localizedDescription)
      }
      pcm?.finish()
      if pcmFailed {
        evidence.rawPcmPath = nil // drain failed (onError fired above)
      } else if (pcm?.framesWritten ?? 0) == 0 {
        // Enabled sink produced a ZERO-FRAME master (e.g. the mic delivered
        // nothing): an empty file is not evidence. Report it via the same
        // enabled-but-failed vocabulary as any other sink failure — null
        // path + onError E_PCM_SINK (JS maps this to null-with-error).
        sendError(CaptureKitErrorCode.pcmSink, "PCM master captured zero frames; nothing to keep")
        evidence.rawPcmPath = nil
      } else {
        evidence.rawPcmPath = pcm?.url.path
      }
    }
    if let logger = sensors {
      let path = logger.finish()
      if path == nil {
        // Enabled sink failed mid-session — surface it now (the logger
        // cannot emit events itself).
        sendError(CaptureKitErrorCode.sensorLog, "Sensor log write failed during capture")
      }
      evidence.sensorLogPath = path
    } else {
      evidence.sensorLogPath = nil // toggle off, or creation failure (onError fired at start)
    }
    evidence.ringBufferDir = nil // ring is photo-only; discarded here (§4)
    ring.clear()

    // evidenceComplete: every ENABLED sink succeeded (rule 4b). The ring is
    // not counted for video — it produces no output in video sessions (§4).
    let evidenceComplete =
      (!toggles.rawPcm || evidence.rawPcmPath != nil) &&
      (!toggles.sensors || evidence.sensorLogPath != nil)
    // The ring dump sink does not exist in video sessions (photo-only, §4):
    // echo ring:false so evidence.ringBufferDir==null reads as structural,
    // never as enabled-but-failed (three-state honesty, rule 4b).
    var evidenceEnabled = toggles.asDictionary
    evidenceEnabled["ring"] = false
    // Structural audio absence is stated EXPLICITLY — never a silently
    // missing track (rules 3/4). The delivery file is intact. Derived from
    // SUCCESSFUL appends, not writerAudioInput != nil: the first audio
    // buffer creates the input and is then dropped pre-startSession, so a
    // take whose only audio buffer was that one has an input but an EMPTY
    // audio track — and must report false.
    let audioTrack = appendedAudioBuffers > 0
    evidenceEnabled["audioTrack"] = audioTrack

    let antiBanding = AntiBandingState.fromDevice(videoDevice)
    let durationMs = startDate.map { Int((Date().timeIntervalSince($0) * 1000.0).rounded()) } ?? 0
    let chunkCount = hasher?.chunkCount ?? 0
    let chunkBytes = hasher?.chunkBytes ?? kCaptureKitChunkBytes
    let merkleRootHex = hasher?.merkleRootHex() ?? ""
    let deliveryPath = deliveryURL?.path ?? ""

    guard writerStarted, let writer = writer, !writerFailed else {
      let reason = writerFailed
        ? "Delivery writer failed during capture"
        : "No frames were captured; there is no delivery file to commit"
      finishOnQueue(.failure(NamedException(CaptureKitErrorCode.writer, reason)))
      return
    }

    writerVideoInput?.markAsFinished()
    writerAudioInput?.markAsFinished()
    writer.finishWriting {
      if writer.status == .completed {
        let payload: [String: Any] = [
          "deliveryPath": deliveryPath,
          "durationMs": durationMs,
          "chunkCount": chunkCount,
          "chunkBytes": chunkBytes,
          "merkleRootHex": merkleRootHex,
          "evidence": evidence.asDictionary,
          "evidenceEnabled": evidenceEnabled,
          "evidenceComplete": evidenceComplete,
          // False when no audio sample reached the delivery file: the
          // audio-absent fallback started the writer video-only, or every
          // audio buffer was dropped pre-startSession — a structural
          // statement, not a sink failure.
          "audioTrack": audioTrack,
          "antiBanding": antiBanding.asDictionary,
        ]
        finishOnQueue(.success(payload))
      } else {
        let message = writer.error?.localizedDescription ?? "writer did not complete"
        finishOnQueue(.failure(NamedException(CaptureKitErrorCode.writer, "Delivery finalize failed: \(message)")))
      }
    }
  }

  /// Releases all session state. Idempotent; sessionQueue only.
  private func teardownSession() {
    let wasVideo = (sessionKind == .video)
    if let observer = runtimeErrorObserver {
      NotificationCenter.default.removeObserver(observer)
      runtimeErrorObserver = nil
    }
    sampleHandler.onVideo = nil
    sampleHandler.onAudio = nil
    videoOutput?.setSampleBufferDelegate(nil, queue: nil)
    audioOutput?.setSampleBufferDelegate(nil, queue: nil)
    session?.stopRunning()
    session = nil
    sessionKind = nil
    videoDevice = nil
    videoOutput = nil
    audioOutput = nil
    photoOutput = nil
    photoHandler = nil
    writer = nil
    writerVideoInput = nil
    writerAudioInput = nil
    writerVideoFirstPTS = nil
    writerAudioFirstPTS = nil
    writerAudioFallback?.cancel()
    writerAudioFallback = nil
    firedErrorCodes.removeAll()
    appendedAudioBuffers = 0
    hasher = nil
    pcm = nil
    sensors = nil
    ring.clear()
    deliveryURL = nil
    evidenceDirURL = nil
    sessionId = ""
    startDate = nil
    writerStarted = false
    writerFailed = false
    pcmFailed = false
    stopping = false
    photoPromise = nil
    photoWaitingForRing = false
    photoTimeout?.cancel()
    photoTimeout = nil
    if wasVideo {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
  }

  // MARK: - capturePhotoWithRing (SPEC §2.2, §4)

  private func capturePhotoWithRing(opts: [String: Any], promise: Promise) {
    guard session == nil else {
      promise.reject(NamedException(CaptureKitErrorCode.busy, "A capture session is already running"))
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      promise.reject(NamedException(CaptureKitErrorCode.permission, "Camera permission is required"))
      return
    }
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          let deliveryURL = captureKitURL(for: deliveryPath),
          let evidenceDirURL = captureKitURL(for: evidenceDir) else {
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }
    let lens = LensChoice(jsValue: opts["lens"] as? String)
    let toggles = EvidenceToggles(opts: opts)

    guard let device = findBackCamera(lens) else {
      promise.reject(NamedException(CaptureKitErrorCode.platform, "No back camera available on this device"))
      return
    }

    let session = AVCaptureSession()
    session.automaticallyConfiguresApplicationAudioSession = false
    session.sessionPreset = .hd1920x1080 // ring frames stay under the 1920×1440 cap (§4)
    session.beginConfiguration()

    do {
      let videoInput = try AVCaptureDeviceInput(device: device)
      guard session.canAddInput(videoInput) else {
        throw NamedException(CaptureKitErrorCode.platform, "Cannot add video input")
      }
      session.addInput(videoInput)
    } catch let e as NamedException {
      session.commitConfiguration()
      promise.reject(e)
      return
    } catch {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Video input failed: \(error.localizedDescription)"))
      return
    }

    // Photo sessions carry no mic: the ring feeds on video frames only, and
    // the sensor log needs no audio session.
    let videoOutput = AVCaptureVideoDataOutput()
    videoOutput.videoSettings = [
      kCVPixelBufferPixelFormatTypeKey as String: NSNumber(value: kCVPixelFormatType_32BGRA),
    ]
    videoOutput.alwaysDiscardsLateVideoFrames = true
    videoOutput.setSampleBufferDelegate(sampleHandler, queue: sessionQueue)
    guard session.canAddOutput(videoOutput) else {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Cannot add video data output"))
      return
    }
    session.addOutput(videoOutput)

    let photoOutput = AVCapturePhotoOutput()
    guard session.canAddOutput(photoOutput) else {
      session.commitConfiguration()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Cannot add photo output"))
      return
    }
    session.addOutput(photoOutput)

    session.commitConfiguration()

    let sid = UUID().uuidString
    self.session = session
    self.sessionKind = .photo
    self.sessionId = sid
    self.videoDevice = device
    self.videoOutput = videoOutput
    self.photoOutput = photoOutput
    self.deliveryURL = deliveryURL
    self.evidenceDirURL = evidenceDirURL
    self.toggles = toggles
    self.ring.clear()
    self.startDate = nil

    sampleHandler.onVideo = { [weak self] buffer in
      self?.handleVideoSample(buffer)
    }
    sampleHandler.onAudio = nil

    runtimeErrorObserver = NotificationCenter.default.addObserver(
      forName: .AVCaptureSessionRuntimeError,
      object: session,
      queue: nil
    ) { [weak self] note in
      let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
      self?.sendError(CaptureKitErrorCode.platform, "Capture session runtime error: \(err?.localizedDescription ?? "unknown")")
    }

    self.photoPromise = promise
    self.photoWaitingForRing = true

    session.startRunning() // blocking; we are on sessionQueue

    // Ring-fill timeout: if no preview frames arrive (e.g. simulator), fail
    // honestly rather than hang the JS promise.
    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self, self.photoWaitingForRing else { return }
      self.photoWaitingForRing = false
      let promise = self.photoPromise
      self.photoPromise = nil
      self.teardownSession()
      promise?.reject(NamedException(CaptureKitErrorCode.platform, "No preview frames arrived within 5s of session start"))
    }
    self.photoTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 5.0, execute: timeout)
  }

  /// Called from handleVideoSample for photo sessions: fires the shutter once
  /// the ring holds a full burst of pre-shutter frames (SPEC §4: the ring is
  /// the 8 frames BEFORE the shutter; the shutter frame is the 9th). With the
  /// ring toggle off (rule 4b) there is nothing to wait for — the shutter
  /// fires on the first frame.
  private func maybeTriggerPhotoCapture() {
    let ready = toggles.ring ? ring.isFull : true
    guard sessionKind == .photo, photoWaitingForRing, ready,
          let photoOutput = photoOutput else { return }
    photoWaitingForRing = false
    photoTimeout?.cancel()
    photoTimeout = nil

    let handler = PhotoCaptureHandler { [weak self] photo, error in
      self?.sessionQueue.async {
        self?.finishPhotoCapture(photo: photo, error: error)
      }
    }
    photoHandler = handler
    let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
    photoOutput.capturePhoto(with: settings, delegate: handler)
  }

  private func finishPhotoCapture(photo: AVCapturePhoto?, error: Error?) {
    let promise = photoPromise
    photoPromise = nil
    guard let promise = promise else {
      teardownSession()
      return
    }
    guard error == nil, let photo = photo, let data = photo.fileDataRepresentation() else {
      teardownSession()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Photo capture failed: \(error?.localizedDescription ?? "no image data")"))
      return
    }

    // capturedAtMs from the photo's host-time timestamp, converted onto the
    // wall clock via the mach clock (falls back to now if unavailable).
    var capturedAtMs = currentEpochMs()
    let photoTime = photo.timestamp
    if photoTime.isValid && !photoTime.isIndefinite {
      let photoSec = CMTimeGetSeconds(photoTime) // host-time seconds (mach domain)
      if photoSec.isFinite {
        let nowSec = MachClock.ticksToBootSeconds(MachClock.nowTicks())
        let delta = nowSec - photoSec
        if delta >= 0 && delta < 60 {
          capturedAtMs = Int64(((Date().timeIntervalSince1970 - delta) * 1000.0).rounded())
        }
      }
    }

    // Delivery still.
    guard let deliveryURL = deliveryURL else {
      teardownSession()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Missing delivery URL"))
      return
    }
    do {
      try FileManager.default.createDirectory(at: deliveryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      try data.write(to: deliveryURL, options: .atomic)
    } catch {
      teardownSession()
      promise.reject(NamedException(CaptureKitErrorCode.platform, "Cannot write delivery still: \(error.localizedDescription)"))
      return
    }

    // Evidence sinks — rule 4: evidence degrades, delivery never
    // dies. A failed or disabled sink yields an explicit null + onError +
    // evidenceComplete:false; the photo ALWAYS lands. (Hard rejects above —
    // E_PERMISSION/E_PLATFORM — are unchanged.)
    var ringDir: String? = nil
    if toggles.ring {
      if let evidenceDir = evidenceDirURL {
        do {
          ringDir = try ring.dumpJPEG(toEvidenceDir: evidenceDir)
        } catch {
          sendError(CaptureKitErrorCode.ringDump, error.localizedDescription)
          ringDir = nil
        }
      } else {
        sendError(CaptureKitErrorCode.ringDump, "Missing evidence directory")
      }
    }
    // Never-recorded vs enabled-but-failed stays visible: ringDir==nil with
    // evidenceEnabled.ring==true means the dump failed; with ==false it was
    // never collected (rule 4b).

    var sensorPath: String? = nil
    if toggles.sensors {
      if let logger = sensors {
        sensorPath = logger.finish()
        if sensorPath == nil {
          sendError(CaptureKitErrorCode.sensorLog, "Sensor log write failed during photo capture")
        }
      }
      // sensors == nil here means creation failed at session start — onError
      // E_SENSOR_LOG already fired there; the field stays honestly null.
    }

    let evidenceComplete =
      (!toggles.ring || ringDir != nil) &&
      (!toggles.sensors || sensorPath != nil)
    // Photo sessions have no PCM sink at all — echo rawPcm:false so the
    // enabled flags are literally true for this session kind.
    var evidenceEnabled = toggles.asDictionary
    evidenceEnabled["rawPcm"] = false

    let mainsHz = AntiBandingState.regionMainsHz()
    teardownSession()
    promise.resolve([
      "deliveryPath": deliveryURL.path,
      "capturedAtMs": capturedAtMs,
      "ringBufferDir": ringDir as Any? ?? NSNull(),
      "sensorLogPath": sensorPath as Any? ?? NSNull(),
      "mainsHz": mainsHz,
      "evidenceEnabled": evidenceEnabled,
      "evidenceComplete": evidenceComplete,
    ])
  }

  // MARK: - detectPlatformIngredient (SPEC §2.2)

  /**
   * Honest stub (SPEC §2.2): no current iOS version embeds a platform C2PA
   * ingredient in captures, and this module ships no C2PA parser. Returns
   * found:false unconditionally — feature-detected, never required. The
   * assetPath is accepted (and validated for shape only) so the call
   * signature is stable if a future iOS exposes an ingredient.
   */
  private func detectPlatformIngredient(assetPath: String) -> [String: Any] {
    return [
      "found": false,
      "ingredient": NSNull(),
      "source": NSNull(),
    ]
  }
}
