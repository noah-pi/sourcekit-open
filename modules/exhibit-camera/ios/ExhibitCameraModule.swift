// Not covered by CI; validated by the on-device soak checklist.
import ExpoModulesCore
import AVFoundation
import CoreMedia
import CoreVideo
import CoreImage
import CryptoKit
import UIKit
import simd

/**
 * ExhibitCamera — the app's single camera session (Spec-Camera-Module-0.13).
 *
 * Captures frames, calibration, timestamps, and metadata; no analysis, no
 * verdicts. A depth map is committed only when the hardware delivers one with
 * the photo; otherwise the payload states depth-not-recorded with a reason.
 *
 * Architecture:
 *   - One AVCaptureMultiCamSession always; single-cam devices run the same
 *     code path with one input/output (spec §1, §7).
 *   - Primary + secondary AVCaptureVideoDataOutput feed an
 *     AVCaptureDataOutputSynchronizer delivering hardware-synced frame pairs
 *     onto the serial sessionQueue (spec §4.1).
 *   - The native preview layer (ExhibitCameraPreviewView) binds to this same
 *     session.
 *   - Delivery video uses an AVAssetWriter (H.264 + AAC); the audio output
 *     sits outside the synchronizer, on the same serial queue.
 *   - Graph wiring is explicit everywhere: addInputWithNoConnections /
 *     addOutputWithNoConnections plus a manual AVCaptureConnection per port.
 *     Implicit connection forming is Apple's documented multi-cam hazard.
 *   - On a multi-cam session only formats flagged isMultiCamSupported may be
 *     set, so configureFormat filters for that and falls up to the smallest
 *     multi-cam format rather than failing the attach.
 *   - Rear stereo rides the dual-wide virtual device (one input, constituent
 *     ports, hardware-synced); legacyMultiInputGraph A/Bs back to two device
 *     inputs.
 *   - No secondary AVCapturePhotoOutput is attached. The stereo still derives
 *     from the retained pair's ultra-wide frame (deriveSecondaryStillFromPair)
 *     at stream resolution, with no OS EXIF, strobe, or depth; each absence is
 *     stated in the outcome's flashNote.
 *
 * Calibration (spec §4.2): per-frame intrinsics come from the sample-buffer
 * attachment kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix
 * (connection.isCameraIntrinsicMatrixDeliveryEnabled, iOS 11+). There is no
 * live path for full calibration (extrinsics, distortion LUTs), so the
 * calibration block commits 'unavailable'; the committed JSON's
 * `calibrationSource` field names which path produced every matrix. The 12 MP
 * maxPhotoDimensions clamp on the photo output stays on by default behind
 * photoMaxDimensionsPolicy.
 *
 * Thread confinement: all mutable session state lives on `sessionQueue`. The
 * synchronizer and the audio output deliver onto that same queue. Events are
 * emitted from that queue (sendEvent is safe from any thread); view-scoped
 * events hop to main.
 *
 * Watchdogs (spec §6): every native await has a timeout — first frame 10 s,
 * capture 10 s, stop 10 s.
 *
 * No network I/O of any kind.
 */

/**
 * promise.reject(code, description) drops the description on SDK 57, so this
 * subclass carries the message in `reason` to reach JS.
 */
final class ExhibitCameraNamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

/// AVCaptureDataOutputSynchronizerDelegate forwarder. The Module class is not
/// an NSObject, so delegate conformance lives here.
final class ExhibitSyncHandler: NSObject, AVCaptureDataOutputSynchronizerDelegate {
  var onCollection: ((AVCaptureSynchronizedDataCollection) -> Void)?

  func dataOutputSynchronizer(
    _ synchronizer: AVCaptureDataOutputSynchronizer,
    didOutput synchronizedDataCollection: AVCaptureSynchronizedDataCollection
  ) {
    onCollection?(synchronizedDataCollection)
  }
}

/// AVCaptureAudioDataOutputSampleBufferDelegate forwarder (video mode only;
/// audio sits outside the synchronizer — see header).
final class ExhibitAudioHandler: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
  var onAudio: ((CMSampleBuffer) -> Void)?

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    onAudio?(sampleBuffer)
  }
}

/// AVCapturePhotoCaptureDelegate forwarder — one per photo-output capture.
final class ExhibitPhotoHandler: NSObject, AVCapturePhotoCaptureDelegate {
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

/// The latest valid synchronized pair, retained on sessionQueue.
///
/// Holds the CMSampleBuffers themselves, extracted inside the delegate
/// callback: the synchronizer's wrapper objects are only valid for the
/// duration of that callback, and a stored Swift CMSampleBuffer is the
/// CFRetain Apple's header contract requires (nil-assignment on eviction or
/// teardown is the release). Storing wrappers instead leaves every entry
/// aliasing the newest recycled pool buffer.
///
/// At most one pair is held and the previous is released immediately: capture
/// pixel buffers come from a finite pool and holding several starves the
/// pipeline into frame drops. Intrinsics are not extracted here — the
/// attachment rides the retained sample buffer, so frameIntrinsics(from:)
/// reads it lazily at commit time and the per-frame delivery callback stays
/// allocation-free (see handleSynchronizedCollection).
private struct RetainedPair {
  var primary: CMSampleBuffer
  var secondary: CMSampleBuffer?    // nil in single-cam mode
  var deltaMs: Double?              // secondary−primary PTS delta; nil single-cam
  var receivedAt: Date
}

public class ExhibitCameraModule: Module {

  // MARK: - Session state (all confined to sessionQueue)

  private let sessionQueue = DispatchQueue(label: "com.exhibit.camera.session")
  /// Serial queue for evidence-sink I/O (JPEG encodes + file writes). Kept off
  /// sessionQueue: a >33 ms encode on the frame queue drops synchronized pairs.
  /// RetainedPair holds ARC-retained sample buffers, so the hop is safe.
  private let sinkIOQueue = DispatchQueue(label: "com.exhibit.camera.sinkio")

  private var session: AVCaptureMultiCamSession?
  private var sessionId: String = ""
  private var facing: ExhibitFacing = .back
  private var primaryDevice: AVCaptureDevice?
  private var secondaryDevice: AVCaptureDevice?
  private var primaryInput: AVCaptureDeviceInput?
  private var secondaryInput: AVCaptureDeviceInput?
  private var primaryVideoOutput: AVCaptureVideoDataOutput?
  private var secondaryVideoOutput: AVCaptureVideoDataOutput?
  private var primaryPhotoOutput: AVCapturePhotoOutput?
  private var secondaryPhotoOutput: AVCapturePhotoOutput?
  private var audioInput: AVCaptureDeviceInput?
  private var audioOutput: AVCaptureAudioDataOutput?
  private var synchronizer: AVCaptureDataOutputSynchronizer?
  private let syncHandler = ExhibitSyncHandler()
  private let audioHandler = ExhibitAudioHandler()

  private var latestPair: RetainedPair?
  private var droppedPairCount = 0
  // Drop-flood diagnostics: which half of the pair the platform is dropping.
  // These counts ride the stall event, the degraded-capture reason, and the
  // committed metadata.
  private var droppedPrimaryCount = 0
  private var droppedSecondaryHalfCount = 0
  /// Consecutive secondary-half drops, reset by any complete pair. The stall
  /// watchdog only watches silence (lastCollectionAt age), and a secondary-half
  /// flood keeps collections arriving, so it never fires. 150 consecutive
  /// halves (~5 s at 30 fps) kicks one synchronizer rebind per streak.
  private var consecutiveSecondaryDrops = 0
  // Where the secondary half dies:
  //   secondaryAbsentCount  — the synchronizer returned no data object for
  //     the secondary output at the master's PTS.
  //   secondaryDroppedCount — a data object was present but
  //     sampleBufferWasDropped.
  //   completePairCount     — pairs retained with both halves.
  //   staleShutterCount     — shutters that found no fresh pair at fire time.
  //   secondaryReseatDone   — the rung-2 output reseat fired this session.
  private var secondaryAbsentCount = 0
  //   virtualGraphActive   — rear stereo rides the dual-wide virtual device
  //                          (one input, constituent ports, hardware-synced)
  //                          instead of two device inputs. A/B via
  //                          legacyMultiInputGraph.
  //   virtualSecondaryPort — the ultra-wide constituent port of the virtual
  //                          input, requested by name rather than from the
  //                          ports array. Drives the secondary output wiring,
  //                          the reseat/re-attach paths, and the PiP
  //                          connection.
  private var virtualGraphActive = false
  private var virtualSecondaryPort: AVCaptureInput.Port? = nil
  // isActive settles asynchronously after startRunning, so a one-shot census
  // reads it too early. KVO observers on both video connections record the
  // initial state and every transition with ms timestamps relative to
  // sessionStartWallClock: never active means a graph-level reject, active
  // then inactive means evicted after start. Invalidated in teardownSession.
  private var connectionActiveObservers: [NSKeyValueObservation] = []
  private var sessionStartWallClock: Date? = nil
  private var secondaryDroppedCount = 0
  private var completePairCount = 0
  private var staleShutterCount = 0
  private var secondaryReseatDone = false
  private var stereoActive = false       // secondary input+output attached
  private var stereoDetachedForThermal = false
  private var sessionCalibration: [String: [String: Any]] = [:] // device rawValue → dict
  private var sessionCalibrationObjects: [String: AVCameraCalibrationData] = [:] // for metadata focal lengths
  private var calibrationCaptureInFlight = false

  // ---- Pro-control state (spec §14). What the module last applied. The
  // metadata block reads the device back at capture time, so these exist for
  // format/stabilization/HDR identity and rollback, not for reporting. ----
  private var currentFormatID: String?
  private var configuredFPS: Double = 30.0
  private var appliedStabilization: String = "auto"
  private var appliedHDR: Bool = false
  /// Photo-strobe preference: the flashMode written into every full-res
  /// capture's AVCapturePhotoSettings. Distinct from the torch, which stays the
  /// video-only continuous light. A per-capture value, not a device mode, so it
  /// persists across sessions.
  private var photoFlashPreference: ExhibitPhotoFlash = .off
  /// KVO on device.isAdjustingFocus → onAdjustingFocus event.
  private var focusObserver: NSKeyValueObservation?
  /// Photo-delegate forwarders retained until their capture completes; the
  /// output does not retain them.
  private var photoHandlers: [ExhibitPhotoHandler] = []

  // Video mode: delivery writer plus the raw PCM master sink.
  private enum Mode { case preview, video }
  private var mode: Mode = .preview

  // Recording state machine. `mode` routes frames, flipped to .preview the
  // instant stop begins so no buffer is appended after markAsFinished;
  // `videoState` owns the lifecycle and stays .stopping until the delivery
  // file's seal settles. startVideo during .stopping queues behind the seal,
  // stopVideo during .stopping joins the in-flight stop (idempotent), and the
  // seal's completion is the only place the state returns to .idle.
  private enum VideoState { case idle, recording, stopping }
  private var videoState: VideoState = .idle
  /// A startVideo call waiting for the in-flight stop to finish sealing.
  /// At most one; a second rejects E_BUSY.
  private var pendingStartVideo: (opts: [String: Any], promise: Promise)?
  /// Extra stopVideo promises attached to the in-flight stop; each settles
  /// with the same outcome.
  private var stopWaiters: [Promise] = []
  private var writer: AVAssetWriter?
  private var writerVideoInput: AVAssetWriterInput?
  private var writerAudioInput: AVAssetWriterInput?
  private var writerStarted = false
  private var writerFailed = false
  private var writerVideoFirstPTS: CMTime?
  private var writerAudioFirstPTS: CMTime?
  private var writerAudioFallback: DispatchWorkItem?
  private var deliveryURL: URL?
  private var evidenceDirURL: URL?
  // Raw-audio-master sink (video only): enabled per startVideo(opts.rawPcm).
  // nil writer while enabled means enabled-but-failed (reported null at stop);
  // disabled reports 'never-recorded' from the JS side, which owns the toggle.
  // The sink never touches delivery (rule 4 tee).
  private var pcmEnabled = false
  private var pcmWriter: PcmMasterWriter?
  private var pcmConverter: AudioMasterConverter?
  // Pair-dump cadence. Start and stop each force a dump so a short clip still
  // commits a beginning and an end.
  private var pairIntervalSec: Double = 2.0
  private var lastPairDumpAt: Date = .distantPast
  private var pairIndex = 0
  private var pairsMissed = 0
  private var videoStartDate: Date?
  private var stopPromise: Promise?
  private var stopTimeout: DispatchWorkItem?

  // IMU evidence sink. When sensorLogWanted (configureSession opts), the
  // logger samples accel+gyro at a 100 Hz target into a 60 s ring for the whole
  // session, so a still can slice [-2 s, +0.5 s] around the shutter and
  // stopVideo can slice the recording window. The logger reference is
  // sessionQueue-confined; the ring is NSLock-confined inside the logger
  // (appends land on its motionQueue). Per capture the state is 'recorded' +
  // path, 'unavailable' (toggle off, no IMU hardware, thermal-parked), or
  // 'failed' + error; a failed or absent log never blocks a capture (rule 4).
  private var sensorLogWanted = false
  private var sensorLogger: ExhibitSensorLogger?
  private var sensorLogThermalStopped = false
  private var videoSensorStartBootSec: Double = 0
  private var videoStartEpochMs: Int64 = 0

  // Lifecycle promises + watchdogs
  private var startPromise: Promise?
  private var startPromiseDone = false
  private var startTimeout: DispatchWorkItem?
  private var captureInFlight = false

  private var runtimeErrorObserver: NSObjectProtocol?
  private var thermalObserver: NSObjectProtocol?
  // Interruption boundaries, logged to the persistent diagnostics log.
  private var interruptionObserver: NSObjectProtocol?
  private var interruptionEndedObserver: NSObjectProtocol?
  private var firedErrorCodes = Set<String>()

  // Sync-pipeline health: the preview layer keeps painting while the
  // data-output pipeline is stalled, so stills reject E_STALE_PAIR against a
  // live viewfinder. lastCollectionAt feeds the watchdog.
  private var lastCollectionAt: Date?
  private var stallRecovering = false    // rung 1: one cheap synchronizer rebind per stall
  private var stallBounced = false       // rung 2: one in-place session bounce per stall
  private var stallEscalated = false     // rung 3: one JS escalation per session

  // Alt-view PiP: the second camera's live feed on screen while it is
  // attached. The view owns the layer; the module owns the AVCaptureConnection.
  // pipWanted mirrors the altPreview prop; pipLayer is weak because the view's
  // layer tree owns it.
  private var pipWanted = false
  private weak var pipLayer: AVCaptureVideoPreviewLayer?
  private var pipConnection: AVCaptureConnection?

  // Selectable secondary stack: nil means 'auto' (the UW/W-T pairing). Set
  // from configureSession(opts.secondaryLens) or setSecondaryLens; a live
  // change on a running back session detaches and re-attaches the secondary
  // pipeline. A preference that conflicts with the primary lens or is absent
  // on the hardware falls back to 'auto', stated in payloads.
  private var secondaryLensPreference: ExhibitLens?

  // Shutter-burst sink ("frames around the shutter"). Opt-in via
  // configureSession(opts.ring). While wanted and in preview mode the last few
  // complete frames are retained in a small ring; at the shutter the ring plus
  // the next few post-shutter frames commit to evidenceDir/ring-<captureId>/
  // as downsampled JPEGs and a JSON index. Depth stays small because every
  // retained frame pins capture-pool buffers and holding several starves the
  // pipeline into drop floods.
  private var burstSinkWanted = false
  private var burstRing: [RetainedPair] = []
  private let burstPreCapacity = 3
  private let burstPostCapacity = 4
  private var burstPostFrames: [RetainedPair] = []
  private var burstPostTarget = 0        // >0 while collecting post-shutter frames
  private var burstContinuation: (() -> Void)?
  private var burstTimeout: DispatchWorkItem?
  // Primary PTS of the last retained burst frame; the ring retains only
  // PTS-advancing frames (see handleSynchronizedCollection).
  private var lastBurstPTS: CMTime? = nil
  // The ring cadence-samples: a frame is retained only if at least
  // burstCadenceSeconds has passed since the last retained frame, so 3 pre +
  // 4 post span the ±300 ms axis the UI states rather than ~115 ms of
  // near-identical frames. The PTS-advance guard above applies first.
  private var lastBurstRetainedAt: Date? = nil
  private let burstCadenceSeconds: TimeInterval = 0.1

  // Audio-tap / PCM-master diagnostics and ENF anchor.
  private var audioBufferCount = 0
  private var pcmFirstSampleWallClockUtcMs: Int64?
  private var pcmAnchorSource = ""       // "source-pts" | "append-instant"

  /// The preview view registers here at prop-update time (main thread).
  /// Weak: the view is display-only.
  private weak var previewView: ExhibitCameraPreviewView?

  /// Shared CIContext for JPEG encode/downsample. CIContext is documented as
  /// thread-safe for rendering; it is used only from sinkIOQueue (still commits
  /// and periodic pairs).
  private let ciContext = CIContext(options: [.cacheIntermediates: false])

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("ExhibitCamera")
    Events("onSessionError", "onHardwarePressure", "onStereoPairCaptured", "onAdjustingFocus", "onSyncStalled", "onCameraDiagnostic")

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

    /// Probes hardware only; starts nothing. 'available' | 'unsupported' |
    /// 'unreached' (spec §7). A probe failure resolves 'unreached'.
    AsyncFunction("stereoAvailability") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.probeStereoAvailability().rawValue)
      }
    }

    /// Starts the session in preview mode. Resolves on first frame, or rejects
    /// via the 10 s watchdog.
    AsyncFunction("configureSession") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.configureSession(opts: opts, promise: promise)
      }
    }

    AsyncFunction("stopSession") { (promise: Promise) in
      self.sessionQueue.async {
        self.stopSession(promise: promise)
      }
    }

    /// Stereo pair capture from the running session (spec §4/§5).
    AsyncFunction("capture") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.capture(opts: opts, promise: promise)
      }
    }

    /// Video: delivery mp4 + periodic stereo pairs (spec §8).
    AsyncFunction("startVideo") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.startVideo(opts: opts, promise: promise)
      }
    }

    AsyncFunction("stopVideo") { (promise: Promise) in
      self.sessionQueue.async {
        self.stopVideo(promise: promise)
      }
    }

    // ---- Chrome (spec §3). All reconfigure on sessionQueue, all clamp, and
    // all no-op with a stated reason when the hardware lacks the capability ----

    AsyncFunction("setLens") { (lens: String, promise: Promise) in
      self.sessionQueue.async {
        self.setLens(ExhibitLens(jsValue: lens), promise: promise)
      }
    }

    /// Secondary stack: 'auto' (the UW/W-T pairing) or an explicit rear lens
    /// ('ultraWide'|'wide'|'telephoto'). Applies live on a running back
    /// session, otherwise stored for the next configureSession. A conflict with
    /// the primary lens resolves applied:false with a reason.
    AsyncFunction("setSecondaryLens") { (lens: String, promise: Promise) in
      self.sessionQueue.async {
        let pref: ExhibitLens? = (lens == "auto") ? nil : ExhibitLens(rawValue: lens)
        if lens != "auto" && pref == nil {
          promise.resolve([
            "applied": false,
            "reason": "unknown-secondary-lens",
            "secondaryLens": NSNull(),
          ])
          return
        }
        self.setSecondaryLens(pref, promise: promise)
      }
    }

    AsyncFunction("setFacing") { (facing: String, promise: Promise) in
      self.sessionQueue.async {
        self.setFacing(ExhibitFacing(jsValue: facing), promise: promise)
      }
    }

    AsyncFunction("setZoom") { (factor: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setZoom(factor, promise: promise)
      }
    }

    /// UI-driven zoom ramp: ramp(toVideoZoomFactor:withRate:) with a
    /// clamped rate. Instant jumps stay on setZoom.
    AsyncFunction("setZoomSmooth") { (factor: Double, rate: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setZoomSmooth(factor, rate: rate, promise: promise)
      }
    }

    /// Photo-strobe preference: flashMode for the photo output's stills.
    /// Not the torch, which is the video-only continuous light.
    AsyncFunction("setPhotoFlashMode") { (mode: String, promise: Promise) in
      self.sessionQueue.async {
        self.setPhotoFlashMode(ExhibitPhotoFlash(jsValue: mode), promise: promise)
      }
    }

    AsyncFunction("setTorch") { (mode: String, promise: Promise) in
      self.sessionQueue.async {
        self.setTorch(ExhibitTorch(jsValue: mode), promise: promise)
      }
    }

    /// x/y are normalized view coordinates (0–1, origin top-left).
    AsyncFunction("setFocusPoint") { (x: Double, y: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setFocusPoint(x: x, y: y, promise: promise)
      }
    }

    AsyncFunction("setExposureBias") { (bias: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setExposureBias(Float(bias), promise: promise)
      }
    }

    // ---- Pro controls (spec §14). Every setter no-ops instead of throwing
    // into JS on hardware lacking the capability; capabilities() reports what
    // exists so the UI can hide the rest ----

    /// { mode: 'auto'|'locked'|'custom', iso?, durationSeconds? }
    AsyncFunction("setExposureMode") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.setExposureMode(opts: opts, promise: promise)
      }
    }

    /// x/y normalized view coordinates; exposure POI independent of focus.
    AsyncFunction("setExposurePoint") { (x: Double, y: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setExposurePoint(x: x, y: y, promise: promise)
      }
    }

    /// { mode: 'auto'|'locked'|'manual', lensPosition? }
    AsyncFunction("setFocusMode") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.setFocusMode(opts: opts, promise: promise)
      }
    }

    /// { mode: 'auto'|'locked'|'manual', temperature?, tint? }
    AsyncFunction("setWhiteBalanceMode") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.setWhiteBalanceMode(opts: opts, promise: promise)
      }
    }

    /// level nil turns the torch off; otherwise clamped to the documented
    /// 1.0 API ceiling.
    AsyncFunction("setTorchLevel") { (level: Double?, promise: Promise) in
      self.sessionQueue.async {
        self.setTorchLevel(level: level, promise: promise)
      }
    }

    /// No session required: device-level capability/format inventory.
    AsyncFunction("listFormats") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.listFormats())
      }
    }

    /// { formatID, frameRate? } — applies to the current primary device.
    AsyncFunction("setFormat") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.setFormat(opts: opts, promise: promise)
      }
    }

    /// 'off'|'standard'|'cinematic'|'auto'
    AsyncFunction("setVideoStabilizationMode") { (mode: String, promise: Promise) in
      self.sessionQueue.async {
        self.setVideoStabilizationMode(mode, promise: promise)
      }
    }

    /// Explicit HDR, not the system default (spec §14).
    AsyncFunction("setHDREnabled") { (enabled: Bool, promise: Promise) in
      self.sessionQueue.async {
        self.setHDREnabled(enabled, promise: promise)
      }
    }

    /// Hardware capability inventory; the UI hides what is not listed.
    AsyncFunction("capabilities") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.capabilities())
      }
    }

    // ---- Debug flags (ExhibitDebugFlags). Defaults: photoConnectionRotation
    // false; photoMaxDimensionsPolicy true (the 12 MP clamp ships on, the flag
    // is the escape hatch); depthCapture true; sessionCalibrationPhoto false;
    // thirdViewEnabled false (untested extension point). Diagnostics only:
    // only known keys are writable and an unknown key resolves
    // applied:false ----

    AsyncFunction("setDebugFlag") { (key: String, value: Bool, promise: Promise) in
      self.sessionQueue.async {
        if ExhibitDebugFlags.set(key, value: value) {
          promise.resolve(["applied": true, "key": key, "value": value])
        } else {
          promise.resolve([
            "applied": false,
            "reason": "unknown-key",
            "acceptedKeys": [
              ExhibitDebugFlags.photoConnectionRotationKey,
              ExhibitDebugFlags.photoMaxDimensionsPolicyKey,
              ExhibitDebugFlags.depthCaptureKey,
              ExhibitDebugFlags.sessionCalibrationPhotoKey,
              ExhibitDebugFlags.thirdViewEnabledKey,
            ],
          ])
        }
      }
    }

    AsyncFunction("getDebugFlags") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(ExhibitDebugFlags.all())
      }
    }

    // ---- the native preview view (spec §2) ----

    View(ExhibitCameraPreviewView.self) {
      Events("onPreviewReady")

      // Every prop handler attaches the module: props are the first contact
      // between view and module under both Paper and Fabric. The JS side
      // always passes `lens`, so attach always happens.
      Prop("lens") { (view: ExhibitCameraPreviewView, value: String) in
        view.attach(module: self)
        self.sessionQueue.async {
          self.previewView = view
          self.setLens(ExhibitLens(jsValue: value), promise: nil)
        }
      }
      Prop("torch") { (view: ExhibitCameraPreviewView, value: String) in
        view.attach(module: self)
        self.sessionQueue.async {
          self.previewView = view
          self.setTorch(ExhibitTorch(jsValue: value), promise: nil)
        }
      }
      Prop("zoom") { (view: ExhibitCameraPreviewView, value: Double) in
        view.attach(module: self)
        self.sessionQueue.async {
          self.previewView = view
          self.setZoom(value, promise: nil)
        }
      }
      // Alt-view PiP: the second camera's live feed in a corner inset while it
      // is attached. The view owns the layer; the module owns the
      // AVCaptureConnection to the secondary input's video port.
      Prop("altPreview") { (view: ExhibitCameraPreviewView, value: Bool) in
        view.attach(module: self)
        view.setAltPreviewEnabled(value)
        let layer = view.currentPipLayer()
        self.sessionQueue.async {
          self.previewView = view
          self.setPipWanted(value, layer: layer)
        }
      }
    }
  }

  /// View attach (prop handler, main) hopped to sessionQueue. All preview-layer
  /// session binds and unbinds run on sessionQueue, serialized with
  /// configure/start/stop: on main, setSession: can synchronously commit the
  /// capture graph and stall into the scene-update watchdog, and a fire-and-
  /// forget main hop can let a bound layer outlive its session.
  func attachViewOnSessionQueue(_ view: ExhibitCameraPreviewView) {
    sessionQueue.async { [weak self, weak view] in
      guard let self = self, let view = view else { return }
      self.previewView = view
      if let session = self.session {
        view.bind(session: session)
      }
    }
  }

  /// Push the running session to the preview view. Enqueues the bind on
  /// sessionQueue (callers include the synchronizer's capture queue) so it is
  /// serialized with configure/start/stop. Also delivers first-frame readiness.
  private func pushSessionToPreview(readySignal: String? = nil) {
    sessionQueue.async { [weak self] in
      guard let self = self, let session = self.session, let view = self.previewView else { return }
      view.bind(session: session)
      if let signal = readySignal {
        view.reportReady(session: session, signal: signal)
      }
    }
  }

  // MARK: - Events / errors

  /// onSessionError dedupe: each code fires at most once per session, so a
  /// failing sink cannot flood the bridge.
  private func sendError(_ code: String, _ message: String) {
    sessionQueue.async { [weak self] in
      guard let self = self, !self.firedErrorCodes.contains(code) else { return }
      self.firedErrorCodes.insert(code)
      self.sendEvent("onSessionError", ["code": code, "message": message])
    }
  }

  private func currentEpochMs() -> Int64 {
    Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
  }
}

// MARK: - Alt-view PiP + sync-pipeline health

extension ExhibitCameraModule {

  /// The preview view's altPreview prop attaches or detaches the second
  /// camera's live feed. The connection binds the layer directly to the
  /// secondary input's video port (the documented multi-cam PiP pattern), so
  /// the inset shows what the evidence pipeline sees. Called on sessionQueue.
  func setPipWanted(_ wanted: Bool, layer: AVCaptureVideoPreviewLayer?) {
    let oldLayer = pipLayer
    pipWanted = wanted
    pipLayer = wanted ? layer : nil
    guard let session = session else { return }
    if wanted {
      ensurePipConnection(in: session)
    } else {
      session.beginConfiguration()
      teardownPipConnection(in: session)
      session.commitConfiguration()
      // A no-connection PiP layer retains its session. Clear the reference
      // here, ordered after the commit on this serial queue, so a discarded
      // inset layer cannot carry the session into a workloop dealloc.
      oldLayer?.session = nil
    }
  }

  /// Create or repair the PiP connection only when a secondary input is
  /// plumbed. With no partner there is no inset feed and the view keeps an
  /// empty frame.
  func ensurePipConnection(in session: AVCaptureMultiCamSession) {
    guard pipWanted, pipConnection == nil, let layer = pipLayer else { return }
    // On the virtual graph the secondary port lives on the single virtual
    // input, requested by name; there is no secondaryInput.
    let pipPort: AVCaptureInput.Port?
    let pipDevice: AVCaptureDevice?
    if virtualGraphActive {
      pipPort = virtualSecondaryPort
      pipDevice = secondaryDevice
    } else {
      // Documented selector (AVMultiCamPiP sample form) rather than scanning
      // the ports array.
      pipPort = secondaryInput.flatMap { input in
        input.ports(for: .video, sourceDeviceType: input.device.deviceType, sourceDevicePosition: input.device.position).first
      }
      pipDevice = secondaryInput?.device
    }
    guard let port = pipPort else { return }
    layer.setSessionWithNoConnection(session)
    // Non-failable initializer on iOS; canAddConnection below is the gate.
    let connection = AVCaptureConnection(inputPort: port, videoPreviewLayer: layer)
    session.beginConfiguration()
    guard session.canAddConnection(connection) else {
      session.commitConfiguration()
      return
    }
    session.addConnection(connection)
    session.commitConfiguration()
    if #available(iOS 17.0, *), let device = pipDevice {
      // Preview-bound connection: the coordinator's preview angle for the
      // secondary device, with the PiP layer.
      RotationPolicy.apply(to: connection, device: device, previewLayer: layer)
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    pipConnection = connection
  }

  func teardownPipConnection(in session: AVCaptureMultiCamSession) {
    guard let pip = pipConnection else { return }
    // Clear the reference first: the connection is gone from this module's
    // point of view whether or not the session still holds it. removeConnection
    // raises when the session does not, so it goes through the shim.
    pipConnection = nil
    guard session.connections.contains(pip) else { return }
    if let removeError = ExhibitSessionControl.safelyRemoveConnection(session, connection: pip) {
      sendError(
        ExhibitCameraErrorCode.platform,
        "PiP connection removal raised an exception: \(removeError.localizedDescription)"
      )
    }
  }

  /// Sync-pipeline health. Every 2 s while the session lives: if frames have
  /// delivered before and have gone quiet for >1.5 s, climb a three-rung
  /// ladder — rebind the synchronizer, bounce the session in place, then
  /// escalate once so JS can rebuild. Mid-recording only rung 1 runs; a bounce
  /// or rebuild would kill the take.
  func scheduleStallWatchdog() {
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 2.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      self.checkSyncStall()
      self.scheduleStallWatchdog()
    }
  }

  private func checkSyncStall() {
    guard let last = lastCollectionAt else { return } // never-delivered belongs to the 10 s start watchdog
    // The calibration dual-photo one-shot starves the sync pipeline briefly;
    // that is not a stall.
    guard !calibrationCaptureInFlight else { return }
    let age = Date().timeIntervalSince(last)
    guard age > 1.5 else {
      stallRecovering = false
      stallBounced = false
      return
    }
    if !stallRecovering {
      // Rung 1: rebind the synchronizer (no session reconfig). The only rung
      // that runs mid-recording; recording failures surface through the writer
      // path instead.
      stallRecovering = true
      rebuildSynchronizer()
    } else if mode != .video, !stallBounced {
      // Rung 2: bounce the session in place; startRunning blocks. The shim
      // makes this NSException-safe and idempotent: a thrown exception becomes
      // an onSessionError event and the ladder climbs to rung 3 next tick.
      stallBounced = true
      if let live = session {
        if let stopError = ExhibitSessionControl.safelyStop(live) {
          sendError(ExhibitCameraErrorCode.platform, "Stall-recovery stop failed: \(stopError.localizedDescription)")
        } else if let startError = ExhibitSessionControl.safelyStart(live) {
          sendError(ExhibitCameraErrorCode.platform, "Stall-recovery start failed: \(startError.localizedDescription)")
        }
      }
    } else if mode != .video, !stallEscalated {
      // Rung 3: escalate once so JS can rebuild the session.
      stallEscalated = true
      sendEvent("onSyncStalled", [
        "ageSeconds": age,
        "droppedPairCount": droppedPairCount,
        "droppedPrimaryCount": droppedPrimaryCount,
        "droppedSecondaryHalfCount": droppedSecondaryHalfCount,
        // Secondary-half drop split (see the state notes):
        "secondaryAbsentCount": secondaryAbsentCount,
        "secondaryDroppedCount": secondaryDroppedCount,
        "completePairCount": completePairCount,
        "staleShutterCount": staleShutterCount,
        "secondaryReseatDone": secondaryReseatDone,
        // Live connection census at stall.
        "connections": connectionCensus(),
      ])
    }
  }

  /// Photo-output calibration one-shot, gated by
  /// ExhibitDebugFlags.sessionCalibrationPhoto (default off). Deferred 1.0 s so
  /// the streams reach steady state, and session-id guarded so a stale timer
  /// never fires into a new session.
  ///
  /// Unreachable: no call site remains. With no secondary photo output attached
  /// the one-shot could only harvest a primary-only calibration, and
  /// convertCalibrationJson requires both lenses, so the calibration block
  /// commits 'unavailable'. Per-frame intrinsics ride the frame attachments and
  /// are unaffected. The flag key stays registered so a stale flipped value
  /// reads as a no-op.
  func scheduleSessionCalibrationCapture() {
    guard ExhibitDebugFlags.sessionCalibrationPhoto else { return }
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      self.kickoffSessionCalibrationCapture()
    }
  }
}

// MARK: - Session configuration (spec §1)

extension ExhibitCameraModule {

  /// Hardware probe only: no session objects, no side effects (spec §7).
  func probeStereoAvailability() -> StereoAvailability {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      return .unreached // permissions missing: not probed
    }
    guard AVCaptureMultiCamSession.isMultiCamSupported else {
      return .unsupported // pre-A12 or OS limitation
    }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera],
      mediaType: .video,
      position: .back
    )
    let types = Set(discovery.devices.map { $0.deviceType })
    guard types.contains(.builtInWideAngleCamera), types.contains(.builtInUltraWideCamera) else {
      return .unsupported
    }
    return .available
  }

  /// The stereo partner's device type for a given primary. The JS-selected
  /// preference wins when it is set, differs from the primary, and exists on
  /// this hardware; otherwise the automatic UW/W-T pairing. A requested but
  /// absent stack degrades to 'auto' rather than failing the session.
  private func partnerDeviceType(for primaryType: AVCaptureDevice.DeviceType) -> AVCaptureDevice.DeviceType {
    if let pref = secondaryLensPreference {
      let t = pref.deviceType
      if t != primaryType,
         AVCaptureDevice.default(t, for: .video, position: .back) != nil {
        return t
      }
    }
    return primaryType == .builtInUltraWideCamera ? .builtInWideAngleCamera : .builtInUltraWideCamera
  }

  /// Third-view hardware probe. True when a supported multi-cam device set
  /// with three or more rear devices exists. Reported via
  /// capabilities().thirdViewCapable; the plumbing is gated behind
  /// ExhibitDebugFlags.thirdViewEnabled (default off, untested).
  private func probeThirdViewSupport() -> Bool {
    guard AVCaptureMultiCamSession.isMultiCamSupported else { return false }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera],
      mediaType: .video,
      position: .back
    )
    return discovery.supportedMultiCamDeviceSets.contains { $0.count >= 3 }
  }

  /// Extension point for a third synchronized view. Untested on hardware; the
  /// flag is off by default. Inert beyond the probe — enabling the flag does
  /// not change the graph.
  ///
  /// Plumbing, in order: pick the rear stack unused by primary/secondary;
  /// attach input + AVCaptureVideoDataOutput like the secondary path (native
  /// format, alwaysDiscardsLateVideoFrames, per-frame intrinsics,
  /// RotationPolicy, configureFormat ≤1280×720); add the output to the
  /// synchronizer's dataOutputs (primary stays the master, first entry); extend
  /// RetainedPair with a third half plus delta and the same absent/dropped
  /// split; re-check session.hardwareCost and systemPressureCost after the
  /// attach and fall back over budget; optionally a third PiP connection.
  private func prepareThirdViewIfEnabled(in session: AVCaptureMultiCamSession) {
    guard ExhibitDebugFlags.thirdViewEnabled else { return }
    _ = probeThirdViewSupport()
    // No graph mutation; see the extension-point note above.
  }

  /// Pick the largest format at or under maxWidth×maxHeight that supports
  /// ≥30 fps. Multicam does not honor session presets the way single-cam does,
  /// so formats are chosen explicitly and committed in metadata.
  ///
  /// With requireMultiCam set, only isMultiCamSupported formats are eligible:
  /// on AVCaptureMultiCamSession the device format must be one where
  /// isMultiCamSupported is true (AVCaptureDevice.Format docs). If nothing
  /// in-budget qualifies, fall up to the smallest multi-cam format at ≥30 fps
  /// rather than failing the attach; the hardware-cost gate after commit
  /// arbitrates the whole graph. Every pick and refusal is logged.
  ///
  /// Also pins per-device AE/AWB to continuous auto: each physical camera in a
  /// multi-cam graph runs its own AE/AWB/AF, so the secondary would otherwise
  /// sit on factory defaults.
  private func configureFormat(device: AVCaptureDevice, maxWidth: Int32, maxHeight: Int32, requireMultiCam: Bool) -> Bool {
    let targetFPS = 30.0
    let inBudget = device.formats.filter { fmt in
      let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
      guard dims.width <= maxWidth, dims.height <= maxHeight else { return false }
      return fmt.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= targetFPS }
    }
    var pool = inBudget
    var fellUp = false
    if requireMultiCam {
      let multiCamInBudget = inBudget.filter { $0.isMultiCamSupported }
      if multiCamInBudget.isEmpty {
        fellUp = true
        pool = device.formats.filter { fmt in
          guard fmt.isMultiCamSupported else { return false }
          return fmt.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= targetFPS }
        }
      } else {
        pool = multiCamInBudget
      }
    }
    // Some multi-cam formats report maxAvailableVideoZoomFactor == min, which
    // pins zoom at 1.0 while the UI sweeps. If the pool has any zoom-capable
    // format, drop the pinned ones.
    let zoomable = pool.filter { $0.maxAvailableVideoZoomFactor > $0.minAvailableVideoZoomFactor + 0.01 }
    if !zoomable.isEmpty { pool = zoomable }
    let byArea: (AVCaptureDevice.Format, AVCaptureDevice.Format) -> Bool = { a, b in
      let da = CMVideoFormatDescriptionGetDimensions(a.formatDescription)
      let db = CMVideoFormatDescriptionGetDimensions(b.formatDescription)
      return Int64(da.width) * Int64(da.height) < Int64(db.width) * Int64(db.height)
    }
    let chosen = fellUp ? pool.min(by: byArea) : pool.max(by: byArea)
    guard let best = chosen else {
      logDiagnosticEvent("format pick FAILED: device=\(device.deviceType.rawValue) budget=\(maxWidth)x\(maxHeight) requireMultiCam=\(requireMultiCam) inBudget=\(inBudget.count) fellUp=\(fellUp) — no eligible format")
      return false
    }
    do {
      try device.lockForConfiguration()
      device.activeFormat = best
      // Matching min/max frame durations on both devices keep the streams
      // aligned for the synchronizer.
      device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
      device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
      if device.isSmoothAutoFocusSupported {
        device.isSmoothAutoFocusEnabled = true
      }
      if device.isFocusModeSupported(.continuousAutoFocus) {
        device.focusMode = .continuousAutoFocus
      }
      if device.isExposureModeSupported(.continuousAutoExposure) {
        device.exposureMode = .continuousAutoExposure
      }
      if device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
        device.whiteBalanceMode = .continuousAutoWhiteBalance
      }
      device.unlockForConfiguration()
      // Log the top three candidates the pick came from, not just the winner.
      let top3 = pool.sorted(by: byArea).suffix(3).reversed().map { self.formatSummary($0) }.joined(separator: " | ")
      logDiagnosticEvent("format chosen: device=\(device.deviceType.rawValue) \(self.formatSummary(best)) requireMultiCam=\(requireMultiCam) fellUp=\(fellUp) inBudget=\(inBudget.count) candidates=[\(top3)]")
      return true
    } catch {
      logDiagnosticEvent("format apply FAILED: device=\(device.deviceType.rawValue) error=\(error.localizedDescription)")
      return false
    }
  }

  /// Compact one-line format description for the diagnostics log, e.g.
  /// "1920x1440@<=60 binned:1 multiCam:1 zoomMax:4.00". String only, so the
  /// bridge type stays stable.
  private func formatSummary(_ format: AVCaptureDevice.Format) -> String {
    let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    let maxFPS = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
    return "\(dims.width)x\(dims.height)@<=\(Int(maxFPS)) binned:\(format.isVideoBinned ? 1 : 0) multiCam:\(format.isMultiCamSupported ? 1 : 0) zoomMax:\(String(format: "%.2f", Double(format.maxAvailableVideoZoomFactor)))"
  }

  /// Native to persistent diagnostics log: the JS side forwards this event
  /// verbatim into the on-disk log the Settings screen shows. Fire-and-forget;
  /// never gates, delays, or fails a capture.
  private func logDiagnosticEvent(_ message: String) {
    sendEvent("onCameraDiagnostic", ["message": message])
  }

  /// Mirror the primary's exposure/WB/focus state onto the secondary. With two
  /// physical cameras live each runs its own AE/AWB/AF and pro controls hit the
  /// primary only. Best-effort, with per-device capability guards and range
  /// clamps: a device that cannot take a mode keeps its own defaults, a lock
  /// failure leaves the secondary unchanged, and the committed per-capture
  /// metadata states what each device ran.
  private func mirrorProControlsToSecondary() {
    // Skipped on the virtual graph: the virtual device owns AE/AWB/AF for both
    // constituents, and configuring a constituent directly while the virtual
    // device streams is not a supported pattern.
    guard stereoActive, !virtualGraphActive, let primary = primaryDevice, let secondary = secondaryDevice else { return }
    do {
      try secondary.lockForConfiguration()
      defer { secondary.unlockForConfiguration() }
      switch primary.exposureMode {
      case .continuousAutoExposure:
        if secondary.isExposureModeSupported(.continuousAutoExposure) {
          secondary.exposureMode = .continuousAutoExposure
        }
      case .autoExpose:
        if secondary.isExposureModeSupported(.autoExpose) {
          secondary.exposureMode = .autoExpose
        }
      case .locked:
        if secondary.isExposureModeSupported(.locked) {
          secondary.exposureMode = .locked
        }
      case .custom:
        if secondary.isExposureModeSupported(.custom) {
          let sFormat = secondary.activeFormat
          let sISO = min(max(primary.iso, sFormat.minISO), sFormat.maxISO)
          var sDuration = primary.exposureDuration
          if CMTimeCompare(sDuration, sFormat.minExposureDuration) < 0 {
            sDuration = sFormat.minExposureDuration
          }
          if CMTimeCompare(sDuration, sFormat.maxExposureDuration) > 0 {
            sDuration = sFormat.maxExposureDuration
          }
          secondary.setExposureModeCustom(duration: sDuration, iso: sISO, completionHandler: nil)
        }
      @unknown default:
        break
      }
      // Exposure target bias rides the auto modes; clamped to the secondary's
      // own range.
      let sBias = min(max(primary.exposureTargetBias, secondary.minExposureTargetBias), secondary.maxExposureTargetBias)
      if sBias != secondary.exposureTargetBias {
        secondary.setExposureTargetBias(sBias, completionHandler: nil)
      }
      switch primary.whiteBalanceMode {
      case .continuousAutoWhiteBalance:
        if secondary.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
          secondary.whiteBalanceMode = .continuousAutoWhiteBalance
        }
      case .locked:
        // Custom-gains support bit, not just mode support (see
        // setWhiteBalanceMode).
        if secondary.isWhiteBalanceModeSupported(.locked),
           secondary.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
          var gains = primary.deviceWhiteBalanceGains
          let maxGain = secondary.maxWhiteBalanceGain
          gains.redGain = min(max(gains.redGain, 1.0), maxGain)
          gains.greenGain = min(max(gains.greenGain, 1.0), maxGain)
          gains.blueGain = min(max(gains.blueGain, 1.0), maxGain)
          secondary.setWhiteBalanceModeLocked(with: gains, completionHandler: nil)
        }
      @unknown default:
        break
      }
      switch primary.focusMode {
      case .continuousAutoFocus:
        if secondary.isFocusModeSupported(.continuousAutoFocus) {
          secondary.focusMode = .continuousAutoFocus
        }
      case .autoFocus:
        if secondary.isFocusModeSupported(.autoFocus) {
          secondary.focusMode = .autoFocus
        }
      case .locked:
        // Custom-position support bit, not just mode support (see
        // setFocusMode).
        if secondary.isFocusModeSupported(.locked),
           secondary.isLockingFocusWithCustomLensPositionSupported {
          secondary.setFocusModeLocked(lensPosition: primary.lensPosition, completionHandler: nil)
        }
      @unknown default:
        break
      }
    } catch {
      // Best-effort: the secondary keeps its own state; committed metadata
      // states what each device ran.
    }
  }

  /// Explicit multi-cam wiring: addOutputWithNoConnections plus a manually
  /// built AVCaptureConnection per port. Implicit connection forming is
  /// forbidden on AVCaptureMultiCamSession — with several same-media-type ports
  /// live, an implicitly formed connection can land on the wrong port or never
  /// materialize while canAddOutput still passes, so the output attaches and
  /// never delivers.
  ///
  /// Returns the live connection, nil on any refusal; callers own the
  /// degradation policy (single-cam fallback or rejection). Every refusal stage
  /// is written to the diagnostics log with the caller's label.
  @discardableResult
  private func wireOutput(
    _ output: AVCaptureOutput,
    to input: AVCaptureDeviceInput,
    port explicitPort: AVCaptureInput.Port? = nil,
    mediaType: AVMediaType,
    in session: AVCaptureMultiCamSession,
    label: String
  ) -> AVCaptureConnection? {
    guard session.canAddOutput(output) else {
      logDiagnosticEvent("wire \(label) REFUSED: canAddOutput=false (device=\(input.device.deviceType.rawValue))")
      return nil
    }
    session.addOutputWithNoConnections(output)
    // Default path uses the documented selector
    // ports(for:sourceDeviceType:sourceDevicePosition:); an explicit port wires
    // a virtual device's constituent by name. The resolved candidate count is
    // logged either way, so an unexpected multi-port answer is visible.
    let resolvedPorts: [AVCaptureInput.Port]
    if let explicitPort = explicitPort {
      resolvedPorts = [explicitPort]
    } else {
      resolvedPorts = input.ports(for: mediaType, sourceDeviceType: input.device.deviceType, sourceDevicePosition: input.device.position)
    }
    let portOrigin = explicitPort != nil ? "explicit" : "documented"
    guard let port = resolvedPorts.first else {
      logDiagnosticEvent("wire \(label) REFUSED: no \(mediaType.rawValue) port on device=\(input.device.deviceType.rawValue) (ports=\(portOrigin),count=0)")
      session.removeOutput(output)
      return nil
    }
    // Non-failable initializer on iOS; canAddConnection is the gate.
    let connection = AVCaptureConnection(inputPorts: [port], output: output)
    guard session.canAddConnection(connection) else {
      logDiagnosticEvent("wire \(label) REFUSED: canAddConnection=false (device=\(input.device.deviceType.rawValue) port=\(port.sourceDeviceType?.rawValue ?? "unknown") ports=\(portOrigin),count=\(resolvedPorts.count))")
      session.removeOutput(output)
      return nil
    }
    session.addConnection(connection)
    logDiagnosticEvent("wire \(label) OK: device=\(input.device.deviceType.rawValue) port=\(port.sourceDeviceType?.rawValue ?? "unknown") enabled=\(connection.isEnabled) ports=\(portOrigin),count=\(resolvedPorts.count)")
    return connection
  }

  /// Live connection census for the diagnostics payloads: per pipeline output,
  /// whether a connection to its intended input port exists, is enabled and
  /// active, and which device that port belongs to. String values only, so the
  /// bridge type stays stable.
  private func connectionCensus() -> [String: String] {
    var census: [String: String] = [:]
    let video: [(String, AVCaptureVideoDataOutput?)] = [
      ("primaryVideo", primaryVideoOutput),
      ("secondaryVideo", secondaryVideoOutput),
    ]
    for (label, output) in video {
      census[label] = connectionSummary(output?.connection(with: .video))
    }
    let photo: [(String, AVCapturePhotoOutput?)] = [
      ("primaryPhoto", primaryPhotoOutput),
      ("secondaryPhoto", secondaryPhotoOutput),
    ]
    for (label, output) in photo {
      census[label] = connectionSummary(output?.connection(with: .video))
    }
    census["audio"] = connectionSummary(audioOutput?.connection(with: .audio))
    // Active format per device, so a multi-cam format violation is visible.
    census["primaryFormat"] = primaryDevice.map { self.formatSummary($0.activeFormat) } ?? "none"
    census["secondaryFormat"] = secondaryDevice.map { self.formatSummary($0.activeFormat) } ?? "none"
    return census
  }

  private func connectionSummary(_ connection: AVCaptureConnection?) -> String {
    guard let connection = connection else { return "none" }
    let portDevice = connection.inputPorts.first?.sourceDeviceType?.rawValue ?? "unknown"
    return "enabled=\(connection.isEnabled),active=\(connection.isActive),port=\(portDevice)"
  }

  /// KVO on AVCaptureConnection.isActive with ms timestamps relative to
  /// startRunning. The census samples isActive once; this records the timeline:
  /// never activating means a graph-level reject, deactivating at t=+N s means
  /// evicted after start. The observer is invalidated in teardownSession, and
  /// logDiagnosticEvent is a fire-and-forget sendEvent, safe from the KVO
  /// delivery thread.
  private func observeConnectionActivity(_ connection: AVCaptureConnection?, label: String) {
    guard let connection = connection else { return }
    let observation = connection.observe(\.isActive, options: [.initial, .new]) { [weak self] conn, _ in
      let elapsed = self?.sessionStartWallClock.map { Date().timeIntervalSince($0) } ?? -1
      self?.logDiagnosticEvent("connection isActive: \(label)=\(conn.isActive) t=+\(String(format: "%.3f", elapsed))s")
    }
    connectionActiveObservers.append(observation)
  }

  /// Starts the session in preview mode. opts: { lens?, facing?, stereo?,
  /// sensorLog? }. Resolves on the first synchronized frame; the 10 s watchdog
  /// rejects otherwise. Hardware-cost refusal rejects rather than throttling
  /// (spec §6). sensorLog (default false) arms the IMU evidence sink.
  func configureSession(opts: [String: Any], promise: Promise) {
    guard session == nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.busy, "The camera session is already running"))
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.permission, "Camera permission is required"))
      return
    }

    let lens = ExhibitLens(jsValue: opts["lens"] as? String)
    let newFacing = ExhibitFacing(jsValue: opts["facing"] as? String)
    let wantStereo = (opts["stereo"] as? Bool) ?? true
    let wantSensorLog = (opts["sensorLog"] as? Bool) ?? false
    // Secondary stack ('auto' = the UW/W-T pairing) and shutter-burst opt-in
    // ('ring'). An unknown lens string falls back to 'auto', reported via
    // capabilities().secondaryLens; an absent key leaves a stored
    // setSecondaryLens preference intact.
    if let sl = opts["secondaryLens"] as? String {
      secondaryLensPreference = (sl == "auto") ? nil : ExhibitLens(rawValue: sl)
    }
    burstSinkWanted = (opts["ring"] as? Bool) ?? false
    burstRing.removeAll()
    burstPostFrames.removeAll()
    burstPostTarget = 0
    lastBurstPTS = nil
    lastBurstRetainedAt = nil

    // Device discovery. Primary follows the selected lens; the stereo partner
    // is wide+ultraWide on the back (spec §4.2). Front is single-cam, stated in
    // the payload.
    //
    // Rear stereo prefers the dual-wide virtual device: one input whose
    // constituent ports (requested by name) stream wide + ultra-wide
    // hardware-synchronized. Ports are verified before the session is touched;
    // any gap falls back to the multi-input graph with a log line. A/B via
    // legacyMultiInputGraph.
    var virtualInput: AVCaptureDeviceInput? = nil
    var virtualWidePort: AVCaptureInput.Port? = nil
    var virtualUWPort: AVCaptureInput.Port? = nil
    if newFacing == .back, wantStereo, lens == .wide,
       !ExhibitDebugFlags.legacyMultiInputGraph,
       probeStereoAvailability() == .available,
       let virtualDevice = AVCaptureDevice.default(.builtInDualWideCamera, for: .video, position: .back),
       let candidate = try? AVCaptureDeviceInput(device: virtualDevice) {
      let wide = candidate.ports(for: .video, sourceDeviceType: .builtInWideAngleCamera, sourceDevicePosition: .back).first
      let uw = candidate.ports(for: .video, sourceDeviceType: .builtInUltraWideCamera, sourceDevicePosition: .back).first
      if let wide = wide, let uw = uw {
        virtualInput = candidate
        virtualWidePort = wide
        virtualUWPort = uw
      } else {
        logDiagnosticEvent("virtual dual-wide graph unavailable: constituent ports missing — multi-input path")
      }
    }
    // The ultra-wide half of a virtual graph as a device, for rotation
    // policies, the format census, and committed metadata. Never configured
    // directly: the virtual device owns AE/AWB/AF for the pair.
    let secondaryConstituent: AVCaptureDevice? = virtualInput?.device.constituentDevices.first(where: { $0.deviceType == .builtInUltraWideCamera })

    guard let primary = virtualInput?.device
      ?? AVCaptureDevice.default(lens.deviceType, for: .video, position: newFacing.position)
      ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newFacing.position) else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No camera available for the requested facing"))
      return
    }

    var secondary: AVCaptureDevice? = nil
    if virtualInput == nil, newFacing == .back, wantStereo, probeStereoAvailability() == .available {
      // Partner stack is selectable (opts.secondaryLens / setSecondaryLens);
      // 'auto' keeps the UW/W-T pairing. A conflicting or absent preference
      // falls back to 'auto' inside partnerDeviceType.
      secondary = AVCaptureDevice.default(partnerDeviceType(for: primary.deviceType), for: .video, position: .back)
    }

    let session = AVCaptureMultiCamSession()
    session.beginConfiguration()

    // Primary input.
    do {
      let input: AVCaptureDeviceInput
      if let v = virtualInput {
        input = v
      } else {
        input = try AVCaptureDeviceInput(device: primary)
      }
      guard session.canAddInput(input) else {
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot add primary camera input")
      }
      // Explicit multi-cam wiring; see wireOutput.
      session.addInputWithNoConnections(input)
      // Promise no more than 30 fps so the session bills this input at 30
      // rather than the format's advertised max. Set after the add: adding an
      // input resets the override to kCMTimeInvalid.
      input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
      primaryInput = input
    } catch let e as ExhibitCameraNamedException {
      session.commitConfiguration()
      promise.reject(e)
      return
    } catch {
      session.commitConfiguration()
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Primary input failed: \(error.localizedDescription)"))
      return
    }

    // Primary stream format: up to 2560×1440 at 30 fps. 4K plus a 1080p
    // partner through one serial queue stalls the pipeline. Sealed stills are
    // unaffected — photo outputs capture at full sensor resolution — and the
    // committed format is recorded in every capture's metadata. With a stereo
    // partner the primary's format must be multi-cam-flagged; see
    // configureFormat.
    if !configureFormat(device: primary, maxWidth: 2560, maxHeight: 1440, requireMultiCam: secondary != nil || virtualInput != nil) {
      session.commitConfiguration()
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No usable primary camera format at 30 fps"))
      return
    }

    // Secondary input (stereo), with single-cam fallback. On the virtual graph
    // the pair is inherent: both constituent ports were verified before the
    // session existed, so stereo starts attached and the outputs wire to the
    // ports below with no second input.
    var stereoAttached = virtualInput != nil
    if let secondary = secondary {
      // Validate the pair against supportedMultiCamDeviceSets before any
      // wiring: an unsupported pair degrades to single-cam here rather than
      // failing obscurely downstream. supportedMultiCamDeviceSets lives on
      // AVCaptureDevice.DiscoverySession, not on AVCaptureMultiCamSession, and
      // holds Set<AVCaptureDevice>, so compare by deviceType.
      let pairDiscovery = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera],
        mediaType: .video,
        position: .back
      )
      let pairSupported = pairDiscovery.supportedMultiCamDeviceSets.contains { set in
        set.contains { $0.deviceType == primary.deviceType }
          && set.contains { $0.deviceType == secondary.deviceType }
      }
      if !pairSupported {
        logDiagnosticEvent("secondary attach REFUSED at configure: pair \(primary.deviceType.rawValue)+\(secondary.deviceType.rawValue) not in supportedMultiCamDeviceSets — single-cam fallback")
      }
      if pairSupported { do {
        let input = try AVCaptureDeviceInput(device: secondary)
        if session.canAddInput(input),
           configureFormat(device: secondary, maxWidth: 1280, maxHeight: 720, requireMultiCam: true) {
          // Explicit multi-cam wiring; see wireOutput.
          session.addInputWithNoConnections(input)
          // The 30 fps billing promise, same as the primary input above. Set
          // after the add, which resets it.
          input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
          secondaryInput = input
          stereoAttached = true
        } else {
          // configureFormat logs its own refusal; canAddInput=false lands
          // here.
          logDiagnosticEvent("secondary attach FAILED at configure: canAddInput=\(session.canAddInput(input)) device=\(secondary.deviceType.rawValue) — single-cam fallback")
        }
      } catch {
        // Secondary attach failure degrades to single-cam, stated in the
        // resolve payload as stereo:'unsupported'.
        logDiagnosticEvent("secondary attach THREW at configure: \(error.localizedDescription) — single-cam fallback")
        stereoAttached = false
      } }
    }

    // Primary video output. videoSettings is left empty so buffers arrive in
    // the camera's native format (420YpCbCr), per Apple's multi-cam guidance;
    // forcing 32BGRA makes the ISP convert every frame of both streams and
    // drops frames in steady state. Everything downstream is format-agnostic:
    // CIImage renders 420 natively for the JPEG sinks, and the delivery writer
    // takes its format hint from the stream.
    let primaryOut = AVCaptureVideoDataOutput()
    primaryOut.alwaysDiscardsLateVideoFrames = true
    guard let pInput = primaryInput,
          wireOutput(primaryOut, to: pInput, port: virtualWidePort, mediaType: .video, in: session, label: "primary-video") != nil else {
      session.commitConfiguration()
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot connect primary video output"))
      return
    }

    // Secondary video output (stereo).
    var secondaryOut: AVCaptureVideoDataOutput? = nil
    if stereoAttached {
      let out = AVCaptureVideoDataOutput()
      // Native format, as with the primary output. Both synced outputs must be
      // configured alike or the graph converts one stream only.
      out.alwaysDiscardsLateVideoFrames = true
      // The virtual graph wires to the UW constituent port on the single
      // input; the multi-input graph wires to the secondary input.
      let secondaryWired: Bool
      if let port = virtualUWPort, let vInput = virtualInput {
        secondaryWired = wireOutput(out, to: vInput, port: port, mediaType: .video, in: session, label: "secondary-video") != nil
      } else if let sInput = secondaryInput {
        secondaryWired = wireOutput(out, to: sInput, mediaType: .video, in: session, label: "secondary-video") != nil
      } else {
        secondaryWired = false
      }
      if secondaryWired {
        secondaryOut = out
      } else {
        // Output refused or no live connection: drop back to single-cam,
        // stated as stereo:'unsupported' in the resolve payload. The refusal
        // itself is logged inside wireOutput.
        logDiagnosticEvent("secondary video output unavailable at configure — single-cam fallback (see wire refusal above)")
        if let sInput = secondaryInput { session.removeInput(sInput) }
        secondaryInput = nil
        stereoAttached = false
      }
    }

    // Per-frame intrinsics via the documented attachment path (iOS 11+).
    // Must be enabled before startRunning.
    for out in [primaryOut, secondaryOut].compactMap({ $0 }) {
      if let connection = out.connection(with: .video),
         connection.isCameraIntrinsicMatrixDeliverySupported {
        connection.isCameraIntrinsicMatrixDeliveryEnabled = true
      }
    }

    // Photo output: primary only (RAW opt-in, session calibration, full-res
    // stills). The hardwareCost watchdog below arbitrates the steady-state
    // cost (spec §6). Added inside this configuration, before startRunning,
    // never mid-flight.
    let primaryPhoto = AVCapturePhotoOutput()
    // On the virtual graph a photo output binds the virtual device's own port,
    // not a constituent: wiring it to the explicit wide constituent port is
    // refused with canAddConnection=false. A nil port lets the documented
    // selector resolve the virtual device's video port; virtualWidePort is nil
    // on the two-input graph, so it is the same call either way.
    if let pInput = primaryInput,
       wireOutput(primaryPhoto, to: pInput, port: virtualInput != nil ? nil : virtualWidePort, mediaType: .video, in: session, label: "primary-photo") != nil {
      primaryPhotoOutput = primaryPhoto
      applyFullResPhotoPolicy(to: primaryPhoto, device: primary)
    }
    // No secondary photo output is attached, in any configuration. The stereo
    // still derives from the synchronized video pair (see attachFullResStills).
    // Consequences, each stated in the payload:
    //   - fullResSecondary is the retained pair's UW frame at stream
    //     resolution (1280×720), hashed on disk and labeled
    //     'video-stream-derived' in its evidence metadata;
    //   - UW session calibration commits 'unavailable', since
    //     AVCameraCalibrationData only rides photo captures;
    //   - secondary depth stills: never-recorded 'no-photo-output'.
    secondaryPhotoOutput = nil
    if stereoAttached {
      logDiagnosticEvent("0.18.5: secondary photo output NOT attached by design — stereo stills derive from the synced video pair; UW session calibration commits 'unavailable'")
    }

    session.commitConfiguration()

    // Post-commit cost census: hardwareCost and systemPressureCost are only
    // truthful after commit, so read them here along with each input's applied
    // override. systemPressureState is not exposed on AVCaptureMultiCamSession,
    // so systemPressureCost is the whole pressure story for this session type.
    do {
      let primaryOverrideText: String
      if let o = primaryInput?.videoMinFrameDurationOverride {
        primaryOverrideText = "\(o.value)/\(o.timescale)"
      } else {
        primaryOverrideText = "none"
      }
      let secondaryOverrideText: String
      if let o = secondaryInput?.videoMinFrameDurationOverride {
        secondaryOverrideText = "\(o.value)/\(o.timescale)"
      } else {
        secondaryOverrideText = "none"
      }
      let census = "multiCam census: graph=\(virtualInput != nil ? "virtual-dual-wide" : "multi-input")"
        + " hardwareCost=\(session.hardwareCost)"
        + " systemPressureCost=\(session.systemPressureCost)"
        + " primaryOverride=" + primaryOverrideText
        + " secondaryOverride=" + secondaryOverrideText
        + " stereoAttached=\(stereoAttached)"
      logDiagnosticEvent(census)
    }

    // Hardware-cost watchdog (spec §6): hardwareCost > 1.0 means the requested
    // graph exceeds the budget, so refuse rather than let the OS throttle.
    if session.hardwareCost > 1.0 {
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.hardwareCost,
        "Camera graph cost \(session.hardwareCost) exceeds budget 1.0; refused rather than throttled"
      ))
      return
    }

    // Over-budget systemPressureCost declines stereo and continues single-cam,
    // stated in the resolve payload; pressure cost is dynamic and may settle,
    // so the session itself is not refused. Runs pre-start, so the PiP
    // connection does not exist yet and the outputs/input are removed directly
    // (the local secondaryOut is not yet the secondaryVideoOutput property).
    if stereoAttached && session.systemPressureCost > 1.0 {
      logDiagnosticEvent("systemPressureCost \(session.systemPressureCost) exceeds budget 1.0 with stereo attached — declining stereo (single-cam continues)")
      session.beginConfiguration()
      if let secondaryOut = secondaryOut { session.removeOutput(secondaryOut) }
      if let secondaryPhoto = secondaryPhotoOutput { session.removeOutput(secondaryPhoto) }
      if let sInput = secondaryInput { session.removeInput(sInput) }
      session.commitConfiguration()
      secondaryOut = nil
      secondaryPhotoOutput = nil
      secondaryInput = nil
      stereoAttached = false
    }

    // Rotation and mirroring policy, per device rather than a hardcoded angle:
    // data outputs, photo outputs, and preview/PiP connections all ask the
    // AVCaptureDevice.RotationCoordinator for their horizon-level angle. Some
    // front cameras have portrait-mounted sensors, where a 90° constant gives
    // sideways preview/video/stills. The app is portrait-locked, so one read
    // per connection setup is the whole policy; lens swaps re-run
    // applyConnectionPolicies.
    //
    // Orientation contract: on AVCaptureVideoDataOutput connections the
    // rotation is physical — delivered pixel buffers arrive rotated by the
    // connection's videoRotationAngle and
    // CMVideoFormatDescriptionGetDimensions returns swapped dims. Every
    // consumer (writer input transform, JPEG sinks) must treat the bytes as
    // already upright; stamping a second rotation into the writer's track
    // transform produces sideways media. See handleVideoFrame and jpegData.
    // AVCapturePhotoOutput applies its own pixel compensation from its
    // connection's angle, so photo connections take the same policy.
    if #available(iOS 17.0, *) {
      if let connection = primaryOut.connection(with: .video) {
        RotationPolicy.apply(to: connection, device: primary)
      }
      if stereoAttached, let secondary = (secondary ?? secondaryConstituent),
         let connection = secondaryOut?.connection(with: .video) {
        RotationPolicy.apply(to: connection, device: secondary)
      }
      if let connection = primaryPhotoOutput?.connection(with: .video) {
        // photoConnectionRotation defaults off; portrait otherwise.
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: connection, device: primary)
        } else if connection.isVideoOrientationSupported {
          connection.videoOrientation = .portrait
        }
      }
      if stereoAttached, let secondary = (secondary ?? secondaryConstituent),
         let connection = secondaryPhotoOutput?.connection(with: .video) {
        // photoConnectionRotation defaults off; portrait otherwise.
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: connection, device: secondary)
        } else if connection.isVideoOrientationSupported {
          connection.videoOrientation = .portrait
        }
      }
    } else {
      for out in [primaryOut, secondaryOut].compactMap({ $0 }) {
        guard let connection = out.connection(with: .video) else { continue }
        if connection.isVideoOrientationSupported {
          connection.videoOrientation = .portrait
        }
      }
    }

    // Synchronizer over the video outputs, created after commit so the outputs
    // are fully connected. Single-cam mode uses a single-output synchronizer to
    // keep one code path.
    let outputs: [AVCaptureOutput] = [primaryOut, secondaryOut].compactMap { $0 }
    let sync = AVCaptureDataOutputSynchronizer(dataOutputs: outputs)
    sync.setDelegate(syncHandler, queue: sessionQueue)
    synchronizer = sync

    // Third-view extension point; inert unless
    // ExhibitDebugFlags.thirdViewEnabled is on.
    prepareThirdViewIfEnabled(in: session)

    // Wire state before startRunning so early frames land safely.
    self.session = session
    self.sessionId = UUID().uuidString
    self.facing = newFacing
    self.primaryDevice = primary
    self.secondaryDevice = stereoAttached ? (secondary ?? secondaryConstituent) : nil
    self.primaryVideoOutput = primaryOut
    self.secondaryVideoOutput = secondaryOut
    self.stereoActive = stereoAttached
    self.virtualGraphActive = virtualInput != nil
    self.virtualSecondaryPort = virtualUWPort
    self.stereoDetachedForThermal = false
    self.mode = .preview
    self.latestPair = nil
    self.droppedPairCount = 0
    self.droppedPrimaryCount = 0
    self.droppedSecondaryHalfCount = 0
    self.consecutiveSecondaryDrops = 0
    self.secondaryAbsentCount = 0
    self.secondaryDroppedCount = 0
    self.completePairCount = 0
    self.staleShutterCount = 0
    self.secondaryReseatDone = false
    self.audioBufferCount = 0
    self.pcmFirstSampleWallClockUtcMs = nil
    self.pcmAnchorSource = ""
    self.sessionCalibration = [:]
    self.firedErrorCodes.removeAll()
    self.currentFormatID = formatID(for: primary)
    self.configuredFPS = 30.0
    self.appliedStabilization = "auto"
    self.appliedHDR = false
    self.sensorLogWanted = wantSensorLog
    self.sensorLogThermalStopped = false
    self.sensorLogger = nil

    // Focus-settling signal (spec §14): KVO-compliant per AVFoundation docs,
    // emitted so the UI can avoid capturing mid-adjustment.
    focusObserver = primary.observe(\.isAdjustingFocus, options: [.new]) { [weak self] _, change in
      let adjusting = change.newValue ?? false
      self?.sendEvent("onAdjustingFocus", ["adjusting": adjusting])
    }

    syncHandler.onCollection = { [weak self] collection in
      self?.handleSynchronizedCollection(collection)
    }

    runtimeErrorObserver = NotificationCenter.default.addObserver(
      forName: .AVCaptureSessionRuntimeError,
      object: session,
      queue: nil
    ) { [weak self] note in
      let err = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
      let description = err.map { "\($0.domain) \($0.code): \($0.localizedDescription)" } ?? "unknown"
      self?.logDiagnosticEvent("session runtime error: \(description)")
      self?.sendError(ExhibitCameraErrorCode.platform, "Capture session runtime error: \(err?.localizedDescription ?? "unknown")")
    }

    // Interruption boundaries into the persistent log: an OS interruption that
    // never fully resumes can park the secondary stream while previews keep
    // their last buffers.
    interruptionObserver = NotificationCenter.default.addObserver(
      forName: .AVCaptureSessionWasInterrupted,
      object: session,
      queue: nil
    ) { [weak self] note in
      let reason = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue ?? -1
      guard let self = self else { return }
      self.logDiagnosticEvent("session INTERRUPTED: reason=\(reason) census=\(self.connectionCensus())")
    }
    interruptionEndedObserver = NotificationCenter.default.addObserver(
      forName: .AVCaptureSessionInterruptionEnded,
      object: session,
      queue: nil
    ) { [weak self] _ in
      guard let self = self else { return }
      self.logDiagnosticEvent("session interruption ended: census=\(self.connectionCensus())")
    }

    // Thermal policy (spec §6).
    thermalObserver = NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.sessionQueue.async {
        self?.handleThermalState(ProcessInfo.processInfo.thermalState)
      }
    }

    self.startPromise = promise
    self.startPromiseDone = false

    // Record the isActive timeline on both video connections; isActive settles
    // asynchronously, so a one-shot census reads it too early. The wall clock
    // is set first so the initial-state callbacks get t=+0.000s.
    sessionStartWallClock = Date()
    observeConnectionActivity(primaryVideoOutput?.connection(with: .video), label: "primaryVideo")
    observeConnectionActivity(secondaryVideoOutput?.connection(with: .video), label: "secondaryVideo")

    // NSException-safe start: the shim catches a thrown ObjC exception from
    // startRunning so it reaches the bridge as a rejection plus teardown, not a
    // crash.
    if let startError = ExhibitSessionControl.safelyStart(session) {
      rejectStart(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Session start failed: \(startError.localizedDescription)"
      ))
      teardownSession()
      return
    }

    // IMU evidence sink start, after startRunning so a failed start owns
    // nothing to tear down. CoreMotion is independent of the capture graph. No
    // IMU hardware, or serious/critical thermal pressure, means no logger and
    // every capture reports sensorLogState 'unavailable'.
    if sensorLogWanted,
       ExhibitSensorLogger.isHardwareAvailable,
       !sensorLogBlockedByThermal() {
      let logger = ExhibitSensorLogger()
      logger.start()
      sensorLogger = logger
    }

    pushSessionToPreview()
    ensurePipConnection(in: session)
    scheduleStallWatchdog()

    // Post-start census into the persistent log. isActive is only meaningful
    // while running; the first-frame census below is the ground truth and this
    // one catches a graph that never delivers at all.
    logDiagnosticEvent("configureSession started: graph=\(virtualGraphActive ? "virtual-dual-wide" : "multi-input") stereoAttached=\(stereoAttached) census=\(connectionCensus())")

    // The secondary takes the primary's current AE/AWB/AF state; fresh devices
    // are already continuous-auto from configureFormat, but a re-configured
    // session may carry stored pro controls.
    mirrorProControlsToSecondary()

    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self, !self.startPromiseDone else { return }
      self.rejectStart(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No video frames arrived within 10s of start"))
      self.teardownSession()
    }
    self.startTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: timeout)
  }

  /// Stable format identifier: "<deviceType.rawValue>:<index>", the format's
  /// position in device.formats. Stable for a given device model and OS;
  /// committed in metadata so a capture is reproducible.
  func formatID(for device: AVCaptureDevice) -> String? {
    guard let idx = device.formats.firstIndex(where: { $0 === device.activeFormat }) else { return nil }
    return "\(device.deviceType.rawValue):\(idx)"
  }

  private func resolveStart(_ payload: [String: Any]) {
    guard !startPromiseDone, let promise = startPromise else { return }
    startPromiseDone = true
    startPromise = nil
    startTimeout?.cancel()
    startTimeout = nil
    promise.resolve(payload)
  }

  private func rejectStart(_ error: ExhibitCameraNamedException) {
    guard !startPromiseDone, let promise = startPromise else { return }
    startPromiseDone = true
    startPromise = nil
    startTimeout?.cancel()
    startTimeout = nil
    promise.reject(error)
  }

  // MARK: - Synchronized frame handling (sessionQueue only)

  private func handleSynchronizedCollection(_ collection: AVCaptureSynchronizedDataCollection) {
    guard let primaryOut = primaryVideoOutput,
          let primaryData = collection.synchronizedData(for: primaryOut) as? AVCaptureSynchronizedSampleBufferData else {
      return
    }

    if primaryData.sampleBufferWasDropped {
      droppedPairCount += 1
      droppedPrimaryCount += 1
      // A dropped frame is the platform's backpressure signal, and Apple
      // directs delegates to release retained buffers in response. If the
      // retained pair is already past the 500 ms shutter freshness window,
      // release it here so its pixel buffers return to the output pools;
      // holding the last good pair through a drop flood turns transient pool
      // pressure into a wedge. capture() then waits for a fresh pair and
      // rejects E_STALE_PAIR if none arrives.
      if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) >= 0.5 {
        latestPair = nil
      }
      return
    }

    var secondaryData: AVCaptureSynchronizedSampleBufferData? = nil
    if stereoActive, let secondaryOut = secondaryVideoOutput {
      let data = collection.synchronizedData(for: secondaryOut) as? AVCaptureSynchronizedSampleBufferData
      if let data = data, !data.sampleBufferWasDropped {
        secondaryData = data
      } else {
        // One half of the pair dropped: skip the pair rather than build one
        // from unpaired frames (spec §4.1).
        droppedPairCount += 1
        droppedSecondaryHalfCount += 1
        consecutiveSecondaryDrops += 1
        // Absent means the synchronizer returned no data object at all;
        // dropped means a data object exists but the platform marked it
        // dropped.
        if data == nil {
          secondaryAbsentCount += 1
        } else {
          secondaryDroppedCount += 1
        }
        // The silence watchdog cannot see a flood while the primary keeps
        // arriving, so kick one rebind per 150-drop streak (~5 s) to give a
        // wedged secondary stream a chance to recover.
        if consecutiveSecondaryDrops == 150, !stallRecovering {
          stallRecovering = true
          // Flood rungs go to the persistent log with the live census, so the
          // connection state at starvation time is visible.
          logDiagnosticEvent("secondary flood rung 1 (150 consecutive, rebuild synchronizer): census=\(connectionCensus())")
          rebuildSynchronizer()
        } else if consecutiveSecondaryDrops == 300, !secondaryReseatDone {
          // Rung 2: a rebind cannot resurrect a parked secondary stream, so
          // remove and re-add the secondary video data output once per session
          // for a fresh connection and pool.
          secondaryReseatDone = true
          logDiagnosticEvent("secondary flood rung 2 (300 consecutive, reseat output): census=\(connectionCensus())")
          reseatSecondaryVideoOutput()
        }
      }
    }

    let primaryPTS = CMSampleBufferGetPresentationTimeStamp(primaryData.sampleBuffer)
    var deltaMs: Double? = nil
    if let secondaryData = secondaryData {
      let secondaryPTS = CMSampleBufferGetPresentationTimeStamp(secondaryData.sampleBuffer)
      if primaryPTS.isValid, secondaryPTS.isValid {
        deltaMs = (CMTimeGetSeconds(secondaryPTS) - CMTimeGetSeconds(primaryPTS)) * 1000.0
      }
    }

    // Retain the newest pair, release the previous, to guard against pool
    // starvation. This callback runs on the synchronizer's delivery queue at
    // frame rate and does only timestamp arithmetic and one struct store: no
    // intrinsics extraction (lazy at commit), no JSON, no allocation-heavy
    // work. Work done here delays the next collection's delivery and drops
    // pairs in steady state.
    let now = Date()
    lastCollectionAt = now
    if secondaryData != nil {
      consecutiveSecondaryDrops = 0
    }
    // Extract the sample buffers inside the callback: that is the only window
    // in which the wrappers vend valid payloads (see RetainedPair). Storing
    // them ARC-retains the buffers; the wrappers are discarded at scope end.
    let pair = RetainedPair(
      primary: primaryData.sampleBuffer,
      secondary: secondaryData?.sampleBuffer,
      deltaMs: deltaMs,
      receivedAt: now
    )
    latestPair = pair

    // Count pairs with both halves; completePairCount == 0 while the
    // absent/dropped counters climb means the secondary stream never landed.
    let frameComplete = secondaryData != nil
    if stereoActive, frameComplete {
      completePairCount += 1
    }

    // Shutter-burst ring (see the state notes): preview mode only, sink opt-in
    // only. Appending releases the oldest frame, so the held-buffer count stays
    // bounded. Primary-valid frames are retained even when the secondary half
    // is absent; the per-frame index entry states completeness (secondaryPath
    // null / complete:false), so a secondary flood degrades the burst to
    // primary-only frames instead of producing none.
    //
    // Only PTS-advancing frames are retained: a starved pipeline redelivers
    // collections built on the same primary buffer, which would fill the ring
    // with identical frames. A starved pipeline commits a shorter burst, or the
    // zero-frame 'error' EvidencePath.
    if burstSinkWanted, mode == .preview {
      let framePTS = CMSampleBufferGetPresentationTimeStamp(primaryData.sampleBuffer)
      let advances = (!framePTS.isValid) || (lastBurstPTS.map { CMTimeCompare(framePTS, $0) > 0 } ?? true)
      // Cadence gate: retain at most one frame per burstCadenceSeconds so the
      // burst spans the advertised ±300 ms axis.
      let onCadence = lastBurstRetainedAt.map { pair.receivedAt.timeIntervalSince($0) >= burstCadenceSeconds } ?? true
      if advances, onCadence {
        if framePTS.isValid { lastBurstPTS = framePTS }
        lastBurstRetainedAt = pair.receivedAt
        burstRing.append(pair)
        if burstRing.count > burstPreCapacity {
          burstRing.removeFirst()
        }
        if burstPostTarget > 0 {
          burstPostFrames.append(pair)
          if burstPostFrames.count >= burstPostTarget {
            finishBurstCollection()
          }
        }
      }
    }

    // First frame resolves configureSession / startVideo and reports preview
    // readiness; the payload states which signal fired (spec §2).
    if !startPromiseDone {
      if mode == .video {
        videoStartDate = Date()
      }
      resolveStart([
        "sessionId": sessionId,
        "startedAtMs": currentEpochMs(),
        "stereo": stereoActive ? StereoAvailability.available.rawValue : StereoAvailability.unsupported.rawValue,
        // Which rear-stereo graph this session runs: "virtual-dual-wide" (one
        // input, constituent ports) or "multi-input" (two device inputs).
        "graph": virtualGraphActive ? "virtual-dual-wide" : "multi-input",
        "hardwareCost": session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
        // Live connection census at first frame, where an absent or
        // cross-wired connection is visible.
        "connections": connectionCensus(),
      ])
      // Same census into the persistent log at first frame; isActive is the
      // ground-truth signal that media flows through a connection.
      logDiagnosticEvent("first frame: census=\(connectionCensus())")
      pushSessionToPreview(readySignal: "first-synchronized-frame")
    }

    // Video mode: feed the delivery writer and the periodic pair cadence
    // (spec §8).
    if mode == .video {
      handleVideoFrame(primaryData.sampleBuffer)
      maybeDumpPeriodicPair()
    }
  }

  /// Per-frame intrinsics from the documented sample-buffer attachment
  /// (iOS 11+; CFData encoding a matrix_float3x3). Row-major, 9 floats; nil
  /// when the attachment is absent.
  private func frameIntrinsics(from sampleBuffer: CMSampleBuffer) -> [Float]? {
    guard let data = CMGetAttachment(
      sampleBuffer,
      key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
      attachmentModeOut: nil
    ) as? Data, data.count == MemoryLayout<matrix_float3x3>.size else {
      return nil
    }
    let matrix: matrix_float3x3 = data.withUnsafeBytes { raw in
      raw.load(as: matrix_float3x3.self)
    }
    return [
      matrix.columns.0.x, matrix.columns.1.x, matrix.columns.2.x,
      matrix.columns.0.y, matrix.columns.1.y, matrix.columns.2.y,
      matrix.columns.0.z, matrix.columns.1.z, matrix.columns.2.z,
    ]
  }
}

// MARK: - Session calibration one-shot (spec §4.2)

extension ExhibitCameraModule {

  /// Fires a dual photo capture once per session configuration to harvest full
  /// AVCameraCalibrationData (extrinsics, distortion LUTs) for both devices.
  /// The inter-camera extrinsic is device-fixed, so one capture per
  /// configuration covers it; the result is labeled `session-photo-capture` to
  /// distinguish it from per-frame data. Failure leaves the map empty and every
  /// capture's calibration JSON states that.
  private func kickoffSessionCalibrationCapture() {
    guard !calibrationCaptureInFlight else { return }
    let candidates: [(AVCapturePhotoOutput?, String)] = [
      (primaryPhotoOutput, primaryDevice?.deviceType.rawValue ?? "primary"),
      (secondaryPhotoOutput, secondaryDevice?.deviceType.rawValue ?? "secondary"),
    ]
    let targets: [(AVCapturePhotoOutput, String)] = candidates.compactMap { pair in
      guard let output = pair.0, output.isCameraCalibrationDataDeliverySupported else { return nil }
      return (output, pair.1)
    }
    guard !targets.isEmpty else { return }
    // Health gate: a photo capture attempted under pressure can refuse and
    // leave the output unwilling to record afterward, so skip the one-shot when
    // the pipeline is already dropping frames. calibrationSource then commits
    // 'unavailable' and the graph keeps every buffer for evidence.
    guard droppedPairCount <= 20 else {
      sendError(
        ExhibitCameraErrorCode.platform,
        "Session calibration one-shot skipped: pipeline already dropping frames (\(droppedPairCount) dropped pairs, primary \(droppedPrimaryCount), secondary-half \(droppedSecondaryHalfCount)) — calibration commits 'unavailable' this session"
      )
      return
    }
    calibrationCaptureInFlight = true
    // Safety: if a photo delegate never fires, the in-flight flag must not
    // silence the stall watchdog forever. The safety also rebinds the
    // synchronizer, since a capture that never returned leaves the stream in
    // an unknown state.
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 5.0) { [weak self] in
      guard let self = self, self.sessionId == id, self.calibrationCaptureInFlight else { return }
      self.calibrationCaptureInFlight = false
      self.rebuildSynchronizer()
    }

    // Sequential captures, one photo at a time. A photo capture on a live
    // multi-cam graph is the documented maximum-resource moment and the video
    // data outputs drop frames for its duration, so overlapping two wedges the
    // sync pipeline. After the last capture returns the synchronizer is
    // rebound once to clear residual delivery disruption.
    fireNextCalibrationCapture(targets: targets, index: 0, sessionID: id)
  }

  /// Fires targets[index], then recurses on its completion (sessionQueue).
  /// After the last target it clears the in-flight flag and rebinds the
  /// synchronizer. One capture failing never blocks the next; partial
  /// calibration is stated in every committed JSON.
  private func fireNextCalibrationCapture(
    targets: [(AVCapturePhotoOutput, String)],
    index: Int,
    sessionID: String
  ) {
    guard index < targets.count else {
      calibrationCaptureInFlight = false
      rebuildSynchronizer()
      return
    }
    let (output, label) = targets[index]
    let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
    settings.isCameraCalibrationDataDeliveryEnabled = true
    // No flash for a calibration frame; the pixels are discarded. The setter
    // validates against supportedFlashModes at set time and throws an
    // uncatchable NSException on a mismatch, so assign only when supported.
    if output.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      settings.flashMode = AVCaptureDevice.FlashMode.off
    }
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, _ in
      self?.sessionQueue.async {
        guard let self = self, self.sessionId == sessionID else { return }
        if let calibration = photo?.cameraCalibrationData {
          self.sessionCalibration[label] = CalibrationSerializer.dictionary(from: calibration, deviceLabel: label)
          self.sessionCalibrationObjects[label] = calibration
        }
        if let handlerRef = handlerRef {
          self.photoHandlers.removeAll { $0 === handlerRef }
        }
        self.fireNextCalibrationCapture(targets: targets, index: index + 1, sessionID: sessionID)
      }
    }
    handlerRef = handler
    // Retain the handler until the delegate fires: the module holds it, the
    // closure releases it on completion.
    photoHandlers.append(handler)
    // NSException-safe fire: settings validation against the live multi-cam
    // graph can throw. A thrown exception becomes a stated skip and the
    // sequence continues with the next target.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: output, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      sendError(
        ExhibitCameraErrorCode.platform,
        "Session calibration capture threw at fire time: \(captureError.localizedDescription) — '\(label)' calibration commits 'unavailable' this session"
      )
      fireNextCalibrationCapture(targets: targets, index: index + 1, sessionID: sessionID)
    }
  }
}

// MARK: - capture() (spec §4/§5)

extension ExhibitCameraModule {

  /// opts: { deliveryPath, evidenceDir, raw?: Bool }.
  /// Evidence artifacts degrade to three-state EvidencePath dicts; the primary
  /// still lands or the call rejects.
  func capture(opts: [String: Any], promise: Promise) {
    guard session != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No camera session is running"))
      return
    }
    guard !captureInFlight else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.busy, "A capture is already in flight"))
      return
    }
    // Validate only: runCapture re-parses the URLs after any freshness wait.
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          exhibitCameraURL(for: deliveryPath) != nil,
          exhibitCameraURL(for: evidenceDir) != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }
    // Freshness: a pair older than 500 ms at shutter time is stale (spec §4.1),
    // so a covered or transitioning camera cannot mint old pixels as "now". A
    // stale or missing pair waits up to 900 ms for the next fresh pair rather
    // than rejecting immediately; the pipeline state rides the failure message
    // so the error text alone is diagnosable.
    if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) < 0.5 {
      runCapture(opts: opts, promise: promise, pair: pair)
    } else {
      // Counts a shutter that found no fresh pair at fire time.
      staleShutterCount += 1
      awaitFreshPair(opts: opts, promise: promise, deadline: Date().addingTimeInterval(0.9))
    }
  }

  /// Polls sessionQueue every 50 ms for a fresh pair until the deadline.
  /// sessionQueue-confined, so the check cannot race the frame handler.
  private func awaitFreshPair(opts: [String: Any], promise: Promise, deadline: Date) {
    if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) < 0.5 {
      runCapture(opts: opts, promise: promise, pair: pair)
      return
    }
    if Date() >= deadline {
      // Degradation path: under a chronic drop flood the retained pair is
      // released at staleness, so no fresh pair may ever arrive. Instead of
      // rejecting E_STALE_PAIR the photo output captures the delivery still
      // directly, and the commit states the degradation: stereoStatus
      // 'unavailable' plus this reason, every pair-derived artifact
      // never-recorded('no-synchronized-pair-at-shutter'), stereo geometry
      // absent. Genuine failures (no photo delivered, write failure) still
      // reject.
      let ageText: String
      if let pair = latestPair {
        ageText = String(format: "%.1fs", Date().timeIntervalSince(pair.receivedAt))
      } else if let last = lastCollectionAt {
        ageText = "\(String(format: "%.1fs", Date().timeIntervalSince(last))); stale pair released under drops"
      } else {
        ageText = "no frames yet"
      }
      let reason = "no fresh synchronized frame within 900ms at shutter (latest: \(ageText); dropped pairs: \(droppedPairCount), primary: \(droppedPrimaryCount), secondary-half: \(droppedSecondaryHalfCount); stereo: \(stereoActive ? "on" : "off"); secondary-absent: \(secondaryAbsentCount), secondary-dropped: \(secondaryDroppedCount), complete-pairs: \(completePairCount), stale-shutters: \(staleShutterCount), reseat: \(secondaryReseatDone ? 1 : 0))"
      // Rebind the synchronizer now so the pipeline is usually flowing again by
      // the next tap; the 2 s watchdog would otherwise get there later.
      if !stallRecovering {
        stallRecovering = true
        rebuildSynchronizer()
      }
      runDegradedSingleLensCapture(opts: opts, promise: promise, reason: reason)
      return
    }
    sessionQueue.asyncAfter(deadline: .now() + 0.05) { [weak self] in
      self?.awaitFreshPair(opts: opts, promise: promise, deadline: deadline)
    }
  }

  /// Stereo-off fallback, fired from awaitFreshPair's deadline: no fresh pair
  /// arrived within the shutter window, so the photo output captures the
  /// delivery still directly at full sensor resolution with the platform's own
  /// ISP and EXIF. The commit states the degradation:
  ///   - stereoStatus 'unavailable' plus stereoUnavailableReason;
  ///   - every pair-derived artifact (secondary frame, calibration, timestamps,
  ///     metadata block) is never-recorded with the reason
  ///     'no-synchronized-pair-at-shutter', keeping the three-state contract
  ///     intact for the seal queue's fail-closed validation;
  ///   - stereo geometry fields are absent;
  ///   - captureSettings.deliveryStillSource names the delivery pixels, and the
  ///     photo's own OS-written EXIF and strobe outcome merge in.
  /// Only genuine capture failures reject (no photo delivered, no photo output,
  /// write failure). Every path settles the promise, with the 10 s watchdog as
  /// the backstop.
  private func runDegradedSingleLensCapture(opts: [String: Any], promise: Promise, reason: String) {
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          let deliveryURL = exhibitCameraURL(for: deliveryPath),
          let evidenceDirURL = exhibitCameraURL(for: evidenceDir) else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }
    guard let photoOutput = primaryPhotoOutput, let device = primaryDevice else {
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "No fresh frame at shutter AND no photo output for the single-lens fallback — the session is unhealthy; it recovers on its own, tap again in a moment; \(self.photoFailureDump(path: "degraded", settings: nil, output: nil, device: self.primaryDevice))"
      ))
      return
    }

    captureInFlight = true
    let captureId = UUID().uuidString
    let capturedAtMs = currentEpochMs()
    let wantRaw = (opts["raw"] as? Bool) ?? false

    // Same settle/watchdog discipline as runCapture: every path settles once.
    var settled = false
    let settle: (Result<[String: Any], ExhibitCameraNamedException>) -> Void = { [weak self] outcome in
      guard let self = self, !settled else { return }
      settled = true
      self.captureInFlight = false
      switch outcome {
      case .success(let payload): promise.resolve(payload)
      case .failure(let error): promise.reject(error)
      }
    }
    let watchdog = DispatchWorkItem { [weak self] in
      guard let self = self, !settled else { return }
      settled = true
      self.captureInFlight = false
      // settings is declared below this closure, so the dump reads the live
      // output/connection state instead.
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Capture timed out after 10s; \(self.photoFailureDump(path: "degraded", settings: nil, output: photoOutput, device: device))"))
    }
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: watchdog)

    do {
      try FileManager.default.createDirectory(at: evidenceDirURL, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: deliveryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch {
      settle(.failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot create capture directories: \(error.localizedDescription)")))
      return
    }

    // Strobe policy identical to captureFullResStill: the preference is
    // validated against this output's supportedFlashModes, and an unsupported
    // mode degrades to off with the reason stated.
    let pref = photoFlashPreference
    let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
    var flashApplied = false
    var flashNote: String? = nil
    // The flashMode setter validates against supportedFlashModes at set time
    // and raises an uncatchable NSException on a mismatch, so assign only
    // contained values. An unassigned setting defaults to no flash.
    if pref != .off, photoOutput.supportedFlashModes.contains(pref.avFlashMode) {
      settings.flashMode = pref.avFlashMode
      flashApplied = true
    } else if photoOutput.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      settings.flashMode = AVCaptureDevice.FlashMode.off
      if pref != .off {
        flashNote = "flash mode '\(pref.rawValue)' is not in this output's supportedFlashModes — captured without the strobe (stated, not faked)"
      }
    } else if pref != .off {
      flashNote = "flash mode '\(pref.rawValue)' is not in this output's supportedFlashModes — captured without the strobe (stated, not faked)"
    }

    // The 12 MP clamp is on by default; the flag is the escape hatch (see
    // ExhibitDebugFlags.photoMaxDimensionsPolicy).
    if ExhibitDebugFlags.photoMaxDimensionsPolicy, #available(iOS 16.0, *) {
      settings.maxPhotoDimensions = photoOutput.maxPhotoDimensions
    }

    // Request depth delivery only when the flag is on and the live output
    // supports it for the current device/format. The reason rides the depth
    // fields when it is not requested, and a delivery or extraction failure
    // degrades to depth-not-recorded rather than failing the capture.
    let depthNotRequestedReason = self.requestDepthIfHonest(settings: settings, output: photoOutput)

    var handlerRef: ExhibitPhotoHandler?
    var retried = false
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      self?.sessionQueue.async { [weak self] in
        guard let self = self else { return }
        guard let photo = photo, let data = photo.fileDataRepresentation() else {
          // One automatic retry after a beat: transient resource contention
          // clears, a wedged output fails twice and the message says so. The
          // handler stays retained for the retry and is released at settle.
          if !retried {
            retried = true
            self.sessionQueue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
              // Retry through handlerRef; capturing `handler` here would be a
              // capture-before-initialization compile error.
              guard let self = self, !settled, let delegateHandler = handlerRef else { return }
              // A settings object is single-use: its uniqueID is spent by the
              // first fire, and refiring the same instance raises. The copy
              // initializer carries every configured value across under a
              // fresh uniqueID.
              let retrySettings = AVCapturePhotoSettings(from: settings)
              // NSException-safe retry fire: a thrown settings-validation
              // exception settles as a stated failure.
              if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: retrySettings, delegate: delegateHandler) {
                self.photoHandlers.removeAll { $0 === delegateHandler }
                settle(.failure(ExhibitCameraNamedException(
                  ExhibitCameraErrorCode.platform,
                  "Single-lens fallback capture retry threw at fire time: \(captureError.localizedDescription)"
                )))
              }
            }
            return
          }
          if let handlerRef = handlerRef {
            self.photoHandlers.removeAll { $0 === handlerRef }
          }
          settle(.failure(ExhibitCameraNamedException(
            ExhibitCameraErrorCode.platform,
            "No fresh frame at shutter and the single-lens fallback capture failed twice: \(error?.localizedDescription ?? "no photo delivered") (calibration in flight: \(self.calibrationCaptureInFlight); dropped pairs: \(self.droppedPairCount), primary \(self.droppedPrimaryCount), secondary-half \(self.droppedSecondaryHalfCount)) — tap again in a moment; \(self.photoFailureDump(path: "degraded", settings: settings, output: photoOutput, device: device))"
          )))
          return
        }
        if let handlerRef = handlerRef {
          self.photoHandlers.removeAll { $0 === handlerRef }
        }
        do {
          // `try?`: on a fresh delivery path the remove throws "no such file".
          try? FileManager.default.removeItem(at: deliveryURL)
          try data.write(to: deliveryURL, options: .atomic)
        } catch {
          settle(.failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.sink, "Cannot write delivery still: \(error.localizedDescription)")))
          return
        }

        // The delivery still is this photo, so its OS-written EXIF and strobe
        // outcome merge into captureSettings.
        let exif = PhotoExifExtractor.dictionary(from: photo)
        let fired = PhotoExifExtractor.flashFired(from: exif)
        // The stabilization mode in force on this output's connection at
        // the commit instant, as the API reports it. nil where the connection
        // lacks stabilization; the builder then omits the key rather than
        // falling back to the preferred mode.
        let activeStab = photoOutput.connection(with: .video).flatMap {
          $0.isVideoStabilizationSupported
            ? DeviceModeMapper.stabilizationMode($0.activeVideoStabilizationMode)
            : nil
        }
        var captureSettingsBlock = CaptureSettingsBuilder.dictionary(
          for: device,
          photoFlash: pref,
          flashSupportedModes: photoOutput.supportedFlashModes.map { DeviceModeMapper.flashMode($0) },
          activeStabilizationMode: activeStab
        )
        // Color profile read from the delivered JPEG's own bytes.
        // Omitted when ImageIO reports no profile name.
        if let profileName = JpegColorSpaceReader.profileName(from: data) {
          captureSettingsBlock["deliveryStillColorSpace"] = profileName
        }
        captureSettingsBlock["deliveryStillSource"] = "photo-output full-sensor still — degraded single-lens capture (\(reason))"
        if !exif.isEmpty { captureSettingsBlock["photoExif"] = exif }
        if let fired = fired { captureSettingsBlock["flashFired"] = fired }
        captureSettingsBlock["photoFlashApplied"] = [
          "requested": pref.rawValue,
          "applied": flashApplied,
          "note": flashNote as Any? ?? NSNull(),
        ] as [String: Any]

        // Depth export runs only after the delivery still is safely on
        // disk. Any depth failure degrades to a stated never-recorded or error
        // rather than failing the capture, so it cannot regress sealing.
        let depth: (evidence: [String: Any], sha256: String?, metadata: [String: Any]?)
        if let reason = depthNotRequestedReason {
          depth = (EvidencePathBuilder.neverRecorded(reason), nil, nil)
        } else {
          var photoW: Int? = nil
          var photoH: Int? = nil
          if #available(iOS 16.0, *) {
            let d = photo.resolvedSettings.photoDimensions
            if d.width > 0, d.height > 0 { photoW = Int(d.width); photoH = Int(d.height) }
          }
          depth = self.commitDepthArtifact(
            from: photo,
            depthURL: evidenceDirURL.appendingPathComponent("depth-\(captureId).png"),
            device: device,
            photoWidth: photoW,
            photoHeight: photoH
          )
        }

        // Mirroring is read off the connection RotationPolicy configured, not
        // inferred from the device position.
        let mirrored = photoOutput.connection(with: .video)?.isVideoMirrored ?? false

        var payload: [String: Any] = [
          "captureId": captureId,
          "deliveryPath": deliveryURL.path,
          "capturedAtMs": capturedAtMs,
          // Bytes on disk at the evidence path; mime, map semantics,
          // dimensions, and accuracy in depthMetadata; sha256 of the exact
          // bytes. The JS commit layer takes these verbatim.
          "depth": depth.evidence,
          "depthSha256": depth.sha256 as Any? ?? NSNull(),
          "depthMetadata": depth.metadata as Any? ?? NSNull(),
          // Session capability string. The degradation is stated by
          // stereoStatus rather than by rewriting what the session could do.
          "stereo": self.stereoActive ? "available" : (self.stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
          "stereoStatus": "unavailable",
          "stereoUnavailableReason": reason,
          "frontMirrored": mirrored,
          // Pair-derived artifacts: never-recorded, with the reason verbatim,
          // so the three-state contract stays intact for the seal queue's
          // fail-closed validation.
          "secondaryFrame": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "calibration": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "timestamps": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "metadata": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "synchronizedDeltaMs": NSNull(),
          "droppedPairCount": self.droppedPairCount,
          "hardwareCost": self.session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
          "physicalDevices": [
            "primary": device.deviceType.rawValue,
            "secondary": ((self.stereoActive ? self.secondaryDevice?.deviceType.rawValue : nil) as Any?) ?? NSNull(),
          ] as [String: Any],
          "captureSettings": captureSettingsBlock,
          // No separate full-sensor artifact on this path: the delivery still
          // is the photo.
          "fullResStill": EvidencePathBuilder.neverRecorded("delivery-still-is-the-full-sensor-photo"),
          "fullResStillSha256": NSNull(),
          "fullResStillDimensions": NSNull(),
          "fullResSecondary": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "fullResSecondarySha256": NSNull(),
          "fullResSecondaryDimensions": NSNull(),
          // Shutter burst is not attempted on the degraded path.
          "ringBufferDir": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "ringFrameCount": 0,
          // Live connection census at commit time; every capture carries its
          // graph state.
          "connections": self.connectionCensus(),
        ]

        // IMU slice with a wall-clock shutter anchor, since no pair PTS exists
        // on this path; the file's window line states its own requested bounds.
        // A failed log never blocks the still.
        self.attachSensorLogFieldsDegraded(
          captureId: captureId,
          capturedAtMs: capturedAtMs,
          evidenceDirURL: evidenceDirURL
        ) { [weak self] sensorFields in
          guard let self = self else { return }
          for (key, value) in sensorFields { payload[key] = value }
          // RAW is a second photo-output capture, not attempted on the
          // degraded path.
          payload["rawDng"] = EvidencePathBuilder.neverRecorded(wantRaw ? "degraded-single-lens-capture" : "not-requested")
          self.sessionQueue.async { settle(.success(payload)) }
        }
      }
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // NSException-safe fire: capturePhoto validates settings against the live
    // multi-cam graph and raises an NSException on a mismatch, which Swift
    // cannot catch, so the fire goes through the ObjC trampoline and a throw
    // becomes this path's stated failure.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      settle(.failure(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Single-lens fallback capture threw at fire time: \(captureError.localizedDescription); \(self.photoFailureDump(path: "degraded", settings: settings, output: photoOutput, device: device))"
      )))
    }
  }

  /// Degraded-path IMU slice: same window ([-2.0 s, +0.5 s]) and three-state
  /// fields as attachSensorLogFields, but the shutter anchor is the mach clock
  /// at photo delivery because no pair PTS exists here. Always calls completion
  /// exactly once, on sessionQueue.
  private func attachSensorLogFieldsDegraded(
    captureId: String,
    capturedAtMs: Int64,
    evidenceDirURL: URL,
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard sensorLogWanted, !sensorLogThermalStopped, let logger = sensorLogger else {
      completion(sensorLogFields(state: "unavailable"))
      return
    }
    let shutterSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    let url = evidenceDirURL.appendingPathComponent("sensors-\(captureId).jsonl")
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 0.55) { [weak self] in
      guard let self = self else { return } // module gone: the 10 s capture watchdog owns the promise
      guard self.sessionId == id else {
        completion(self.sensorLogFields(state: "unavailable"))
        return
      }
      completion(self.sensorWindowFields(
        url: url,
        from: shutterSec - 2.0,
        to: shutterSec + 0.5,
        anchorStartedAtMs: capturedAtMs,
        // No pair PTS on this path, so the shutter estimate is the event
        // instant on the boot clock, not the flush instant.
        anchorBootSec: shutterSec,
        logger: logger
      ))
    }
  }

  /// The capture body, run once a fresh pair is in hand.
  private func runCapture(opts: [String: Any], promise: Promise, pair: RetainedPair) {
    // capture() validated these paths before the wait; re-parse so a malformed
    // path rejects rather than crashing.
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          let deliveryURL = exhibitCameraURL(for: deliveryPath),
          let evidenceDirURL = exhibitCameraURL(for: evidenceDir) else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }

    captureInFlight = true
    let wantRaw = (opts["raw"] as? Bool) ?? false
    let captureId = UUID().uuidString
    let capturedAtMs = currentEpochMs()

    // 10 s capture watchdog (spec §6); covers the RAW await too.
    var settled = false
    let settle: (Result<[String: Any], ExhibitCameraNamedException>) -> Void = { [weak self] outcome in
      guard let self = self, !settled else { return }
      settled = true
      self.captureInFlight = false
      switch outcome {
      case .success(let payload): promise.resolve(payload)
      case .failure(let error): promise.reject(error)
      }
    }
    let watchdog = DispatchWorkItem { [weak self] in
      guard let self = self, !settled else { return }
      settled = true
      self.captureInFlight = false
      // The full-res and RAW photo captures ride this chain, so a wedged photo
      // output is one way to hit this timeout; dump the photo state.
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Capture timed out after 10s; \(self.photoFailureDump(path: "normal", settings: nil, output: self.primaryPhotoOutput, device: self.primaryDevice))"))
    }
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: watchdog)

    // commitPair snapshots sessionQueue state, then encodes and writes on
    // sinkIOQueue; the delivery queue never encodes. Its completion hops back
    // here, on sessionQueue.
    commitPair(
      pair: pair,
      captureId: captureId,
      deliveryURL: deliveryURL,
      evidenceDirURL: evidenceDirURL,
      capturedAtMs: capturedAtMs
    ) { [weak self] result in
      guard let self = self else { return }
      switch result {
      case .failure(let error):
        settle(.failure(error))
      case .success(let payload):
        // Shutter-burst sink: commits the pre-shutter ring plus the next few
        // post-shutter frames to evidenceDir/ring-<captureId>/ before the
        // full-res photo captures fire, since a photo capture on the live graph
        // is the documented maximum-resource moment and would starve the
        // post-shutter frames. Never rejects the capture; the result is a
        // three-state EvidencePath in ringBufferDir and ringFrameCount.
        self.attachShutterBurst(
          shutterPair: pair,
          captureId: captureId,
          evidenceDirURL: evidenceDirURL,
          payload: payload
        ) { [weak self] burstPayload in
          guard let self = self else { return }
        // IMU sink slice: the three-state sensorLog* fields join the payload
        // before settle. A live sink waits out a 0.55 s post-shutter drain,
        // inside the 10 s capture watchdog; off or unavailable, the completion
        // fires synchronously. A failed log never blocks the still.
        self.attachSensorLogFields(
          pair: pair,
          captureId: captureId,
          capturedAtMs: capturedAtMs,
          evidenceDirURL: evidenceDirURL
        ) { [weak self] sensorFields in
          guard let self = self else { return }
          var final = burstPayload
          for (key, value) in sensorFields { final[key] = value }
          // Full-res stills: photo-output captures at full sensor
          // resolution, sequential per output to avoid starving the graph,
          // folding the strobe outcome and OS-written EXIF into captureSettings.
          // A full-res failure does not reject the capture — the
          // delivery still already landed — and commits as a three-state
          // EvidencePath.
          self.attachFullResStills(
            captureId: captureId,
            evidenceDirURL: evidenceDirURL,
            payload: final
          ) { [weak self] withFullRes in
            guard let self = self else { return }
            var final = withFullRes
            if wantRaw {
              self.commitRawOptIn(captureId: captureId, evidenceDirURL: evidenceDirURL) { [weak self] rawPath in
                guard let self = self else { return }
                final["rawDng"] = rawPath
                self.sessionQueue.async { settle(.success(final)) }
              }
            } else {
              final["rawDng"] = EvidencePathBuilder.neverRecorded("not-requested")
              settle(.success(final))
            }
          }
        }
        }
      }
    }
  }

  // MARK: - Shutter-burst sink ("frames around the shutter")

  /// Settles the post-shutter collection exactly once, early at the target
  /// count or at the 1.5 s timeout, always on sessionQueue. A session rebuild
  /// clears burstContinuation in teardownSession; the in-flight capture then
  /// settles via its own 10 s watchdog.
  private func finishBurstCollection() {
    guard let continuation = burstContinuation else { return }
    burstContinuation = nil
    burstTimeout?.cancel()
    burstTimeout = nil
    burstPostTarget = 0
    continuation()
  }

  /// Arms the post-shutter collection and, when it settles, commits the burst
  /// on sinkIOQueue. Completion fires exactly once, on sessionQueue. Frames
  /// more than 2 s before the shutter are excluded from the pre set; under a
  /// secondary-half flood that can leave zero frames, which commits as an
  /// 'error' EvidencePath.
  private func attachShutterBurst(
    shutterPair: RetainedPair,
    captureId: String,
    evidenceDirURL: URL,
    payload: [String: Any],
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard burstSinkWanted else {
      var out = payload
      out["ringBufferDir"] = EvidencePathBuilder.neverRecorded("not-requested")
      out["ringFrameCount"] = 0
      completion(out)
      return
    }
    // The ring is preview-mode only: pool pressure during a recording is not
    // an acceptable trade.
    guard mode == .preview else {
      var out = payload
      out["ringBufferDir"] = EvidencePathBuilder.neverRecorded("not-available-during-video-recording")
      out["ringFrameCount"] = 0
      completion(out)
      return
    }
    let shutterAt = shutterPair.receivedAt
    let pre = burstRing.filter { shutterAt.timeIntervalSince($0.receivedAt) <= 2.0 }
    burstRing.removeAll()
    burstPostFrames = []
    burstPostTarget = burstPostCapacity
    burstContinuation = { [weak self] in
      guard let self = self else { return }
      let post = self.burstPostFrames
      self.burstPostFrames = []
      self.commitShutterBurst(
        pre: pre, post: post, shutterAt: shutterAt,
        captureId: captureId, evidenceDirURL: evidenceDirURL,
        payload: payload, completion: completion
      )
    }
    let timeout = DispatchWorkItem { [weak self] in
      self?.finishBurstCollection()
    }
    burstTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 1.5, execute: timeout)
  }

  /// Encodes and writes the burst frames on sinkIOQueue, off the frame queue.
  /// Each frame contributes a downsampled primary JPEG and, when present, a
  /// secondary JPEG; the JSON index states per-frame PTS, host-clock delta, and
  /// shutter offset. Partial failures degrade per frame (path null plus a note
  /// in the index); zero committed frames is an 'error' EvidencePath, not a
  /// rejection.
  private func commitShutterBurst(
    pre: [RetainedPair],
    post: [RetainedPair],
    shutterAt: Date,
    captureId: String,
    evidenceDirURL: URL,
    payload: [String: Any],
    completion: @escaping ([String: Any]) -> Void
  ) {
    let frames = pre + post
    let shutterFrameIndex = pre.count - 1
    sinkIOQueue.async { [weak self] in
      guard let self = self else { return }
      var out = payload
      guard !frames.isEmpty else {
        out["ringBufferDir"] = EvidencePathBuilder.error(
          ExhibitCameraErrorCode.stalePair,
          "no fresh synchronized frames within ±2s of the shutter"
        )
        out["ringFrameCount"] = 0
        self.sessionQueue.async { completion(out) }
        return
      }
      let ringDir = evidenceDirURL.appendingPathComponent("ring-\(captureId)", isDirectory: true)
      var indexEntries: [[String: Any]] = []
      var committedCount = 0
      var writeFailure: String? = nil
      for (i, frame) in frames.enumerated() {
        var entry: [String: Any] = [
          "frame": i,
          "offsetMsVsShutter": frame.receivedAt.timeIntervalSince(shutterAt) * 1000.0,
          "primaryHostSeconds": CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(frame.primary)),
          "primaryPath": NSNull(),
          "secondaryPath": NSNull(),
          // The ring may retain primary-only frames during a secondary flood,
          // so each entry states its own completeness.
          "complete": frame.secondary != nil,
        ]
        // A secondary buffer enters the pair only when the delivery callback
        // confirmed it was not a platform drop; there is no wrapper flag to
        // re-check at commit time.
        if let secondary = frame.secondary {
          let secondaryPTS = CMSampleBufferGetPresentationTimeStamp(secondary)
          let primaryPTS = CMSampleBufferGetPresentationTimeStamp(frame.primary)
          if primaryPTS.isValid, secondaryPTS.isValid {
            entry["deltaMs"] = (CMTimeGetSeconds(secondaryPTS) - CMTimeGetSeconds(primaryPTS)) * 1000.0
          }
          let secondaryURL = ringDir.appendingPathComponent("ring-\(captureId)-\(String(format: "%02d", i))-secondary.jpg")
          if let imageBuffer = CMSampleBufferGetImageBuffer(secondary),
             let (data, _) = self.downsampledJPEG(from: imageBuffer, targetBytes: 200_000) {
            do {
              try FileManager.default.createDirectory(at: ringDir, withIntermediateDirectories: true)
              try data.write(to: secondaryURL, options: .atomic)
              entry["secondaryPath"] = secondaryURL.path
            } catch {
              writeFailure = writeFailure ?? "secondary frame \(i): \(error.localizedDescription)"
            }
          } else {
            writeFailure = writeFailure ?? "secondary frame \(i): JPEG encode returned nil"
          }
        }
        let primaryURL = ringDir.appendingPathComponent("ring-\(captureId)-\(String(format: "%02d", i))-primary.jpg")
        if let imageBuffer = CMSampleBufferGetImageBuffer(frame.primary) {
          // The frame's 8×8 luma dHash rides the index as the committed
          // distinctness fact (see dHash64).
          if let dh = self.dHash64(from: imageBuffer) {
            entry["primaryDHash64"] = dh
          }
          if let (data, _) = self.downsampledJPEG(from: imageBuffer, targetBytes: 200_000) {
            do {
              try FileManager.default.createDirectory(at: ringDir, withIntermediateDirectories: true)
              try data.write(to: primaryURL, options: .atomic)
              entry["primaryPath"] = primaryURL.path
              committedCount += 1
            } catch {
              writeFailure = writeFailure ?? "primary frame \(i): \(error.localizedDescription)"
            }
          } else {
            writeFailure = writeFailure ?? "primary frame \(i): JPEG encode returned nil"
          }
        } else {
          writeFailure = writeFailure ?? "primary frame \(i): no pixel buffer"
        }
        indexEntries.append(entry)
      }
      if committedCount > 0 {
        let indexDoc: [String: Any] = [
          "captureId": captureId,
          "frameCount": frames.count,
          "framesCommitted": committedCount,
          "shutterFrameIndex": shutterFrameIndex,
          "preShutterDepth": pre.count,
          "postShutterDepth": post.count,
          "note": writeFailure as Any? ?? NSNull(),
          "frames": indexEntries,
        ]
        let indexURL = ringDir.appendingPathComponent("ring-\(captureId).json")
        do {
          let data = try JSONSerialization.data(withJSONObject: indexDoc, options: [.prettyPrinted, .sortedKeys])
          try data.write(to: indexURL, options: .atomic)
          out["ringBufferDir"] = EvidencePathBuilder.path(ringDir.path)
        } catch {
          out["ringBufferDir"] = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, "ring index write failed: \(error.localizedDescription)")
        }
      } else {
        out["ringBufferDir"] = EvidencePathBuilder.error(
          ExhibitCameraErrorCode.sink,
          "ring commit failed for every frame: \(writeFailure ?? "unknown")"
        )
      }
      out["ringFrameCount"] = committedCount
      self.sessionQueue.async { completion(out) }
    }
  }

  // MARK: - IMU sink slice

  /// Three-state vocabulary shared by the photo and video paths: 'recorded' +
  /// path; 'unavailable' + null (toggle off, no IMU hardware, thermal-parked);
  /// 'failed' + null + sensorLogError. sensorLogError rides only in the failed
  /// case, and the JS contract marks it optional.
  private func sensorLogFields(state: String, path: String? = nil, error: String? = nil) -> [String: Any] {
    var fields: [String: Any] = [
      // `as Any? ?? NSNull()`: mixed String/NSNull literals make the
      // dictionary type ambiguous without the explicit cast.
      "sensorLogPath": path as Any? ?? NSNull(),
      "sensorLogState": state,
    ]
    if let error = error {
      fields["sensorLogError"] = error
    }
    return fields
  }

  /// Flush one window from the ring and fold the outcome into the three-state
  /// fields. Zero samples in the window writes no file and reports
  /// 'unavailable'. A write failure reports 'failed' with the error text and
  /// never throws back into a capture path.
  private func sensorWindowFields(
    url: URL,
    from: Double,
    to: Double,
    anchorStartedAtMs: Int64,
    anchorBootSec: Double,
    logger: ExhibitSensorLogger
  ) -> [String: Any] {
    do {
      let written = try logger.flushWindow(from: from, to: to, to: url, anchorStartedAtMs: anchorStartedAtMs, anchorBootSec: anchorBootSec)
      guard written > 0 else {
        return sensorLogFields(state: "unavailable")
      }
      return sensorLogFields(state: "recorded", path: url.path)
    } catch {
      sendError(ExhibitCameraErrorCode.sink, "Sensor log write failed: \(error.localizedDescription)")
      return sensorLogFields(state: "failed", error: error.localizedDescription)
    }
  }

  /// Photo-path slice: [-2.0 s, +0.5 s] around the shutter, written next to the
  /// other evidence sinks (sensors-<captureId>.jsonl). Always calls completion
  /// exactly once, on sessionQueue: synchronously when the sink is off or
  /// unavailable, and after a 0.55 s post-shutter drain when it is live so the
  /// +0.5 s tail lands in the ring before slicing.
  private func attachSensorLogFields(
    pair: RetainedPair,
    captureId: String,
    capturedAtMs: Int64,
    evidenceDirURL: URL,
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard sensorLogWanted, !sensorLogThermalStopped, let logger = sensorLogger else {
      completion(sensorLogFields(state: "unavailable"))
      return
    }
    // Shutter anchor: the primary frame's PTS is mach-clock-derived, the same
    // clock CMLogItem.timestamp rides, so the window needs no conversion. The
    // now() fallback for an invalid PTS is stated in the file's window line via
    // requestedStart/requestedEnd.
    let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(pair.primary))
    let shutterSec = pts.isFinite ? pts : ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    let windowStart = shutterSec - 2.0
    let windowEnd = shutterSec + 0.5
    let url = evidenceDirURL.appendingPathComponent("sensors-\(captureId).jsonl")
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 0.55) { [weak self] in
      guard let self = self else { return } // module gone: the 10 s capture watchdog owns the promise
      guard self.sessionId == id else {
        // Session rebuilt mid-drain: nothing to slice.
        completion(self.sensorLogFields(state: "unavailable"))
        return
      }
      completion(self.sensorWindowFields(
        url: url,
        from: windowStart,
        to: windowEnd,
        anchorStartedAtMs: capturedAtMs,
        // The anchor binds the shutter's instant (the primary frame's PTS) to
        // the shutter's wall clock, not the flush instant.
        anchorBootSec: shutterSec,
        logger: logger
      ))
    }
  }

  /// Everything the pair commit needs out of sessionQueue-confined state,
  /// snapshotted up front so the encode and write phase can run on sinkIOQueue
  /// without touching module state. Device and connection references ride along
  /// strongly; their property reads in phase 2 are atomic getters.
  private struct CommitSnapshot {
    let pair: RetainedPair
    let captureId: String
    let deliveryURL: URL
    let evidenceDirURL: URL
    let capturedAtMs: Int64
    let calibrationDict: [String: Any]
    let timestampsDict: [String: Any]
    let stereoActive: Bool
    let stereoDetachedForThermal: Bool
    let stereoStateString: String
    let droppedPairCount: Int
    // Drop split at the commit instant: the total alone cannot distinguish a
    // primary-side flood (session-wide pressure) from a secondary-half flood
    // (the dual-capture path).
    let droppedPrimaryCount: Int
    let droppedSecondaryHalfCount: Int
    // Absent/dropped/complete split at the commit instant.
    let secondaryAbsentCount: Int
    let secondaryDroppedCount: Int
    let completePairCount: Int
    let hardwareCost: Double           // session?.hardwareCost ?? -1
    let hardwareCostPayload: Any       // Double or NSNull, for the result payload
    let physicalDevices: [String: Any]
    let primaryDevice: AVCaptureDevice?
    let secondaryDevice: AVCaptureDevice?
    let primaryLabel: String
    let secondaryLabel: String
    let primaryCalibration: AVCameraCalibrationData?
    let secondaryCalibration: AVCameraCalibrationData?
    let primaryFormatID: String?
    let secondaryFormatID: String?
    let primaryStab: String?
    let secondaryStab: String?
    // The stabilization mode in force as the connection reports it
    // (activeVideoStabilizationMode); the *Stab fields above are the preferred
    // mode. nil where the connection lacks stabilization.
    let primaryStabActive: String?
    let secondaryStabActive: String?
    let primaryHDR: Bool?
    let secondaryHDR: Bool?
    let configuredFPS: Double
    // Strobe preference and the output's supported modes,
    // snapshotted so the settings block is built from one instant.
    let photoFlashPreference: ExhibitPhotoFlash
    let flashSupportedModes: [String]
    /// The primary connection's mirroring state at the commit instant;
    /// RotationPolicy sets it explicitly (front mirrors, back does not).
    /// Committed as frontMirrored; nil only when no connection existed to
    /// read.
    let primaryConnectionMirrored: Bool?
  }

  /// Commits the pair artifacts in two phases:
  ///   1. sessionQueue: snapshot all module state (dictionary/scalar assembly,
  ///      no encodes, no file I/O).
  ///   2. sinkIOQueue: the two JPEG encodes (full-res delivery and
  ///      quality-stepped downsample) and every file write. A 1440p CIContext
  ///      encode plus downsample attempts plus five writes can span several
  ///      frame intervals, which on the synchronizer's delivery queue would
  ///      stall collection delivery and drop pairs. The retained pair keeps its
  ///      sample buffers alive across the hop.
  /// Delivery failures reject via .failure; every evidence artifact degrades to
  /// a stated EvidencePath. Completion fires on sessionQueue.
  private func commitPair(
    pair: RetainedPair,
    captureId: String,
    deliveryURL: URL,
    evidenceDirURL: URL,
    capturedAtMs: Int64,
    completion: @escaping (Result<[String: Any], ExhibitCameraNamedException>) -> Void
  ) {
    // ---- phase 1: snapshot (sessionQueue) ----
    let calibrationDict = buildCalibrationDict(pair: pair)

    // Sync timestamps JSON: host-clock PTS pair, wall anchor, and delta. The
    // delta is the sync claim, roughly one frame period at 30 fps (spec §4.2).
    let primaryPTS = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(pair.primary))
    var secondaryHostSeconds: Any = NSNull()
    if let secondary = pair.secondary {
      let s = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(secondary))
      if s.isFinite { secondaryHostSeconds = s }
    }
    let timestampsDict: [String: Any] = [
      "captureId": captureId,
      "capturedAtMs": capturedAtMs,
      "primaryHostSeconds": primaryPTS.isFinite ? primaryPTS : NSNull(),
      "secondaryHostSeconds": secondaryHostSeconds,
      "synchronizedDeltaMs": pair.deltaMs as Any? ?? NSNull(),
      "clockNote": "host seconds are mach-absolute-derived; capturedAtMs anchors them to wall clock",
    ]

    let primaryLabel = primaryDevice?.deviceType.rawValue ?? "primary"
    let secondaryLabel = secondaryDevice?.deviceType.rawValue ?? "secondary"
    let primaryConnection = primaryVideoOutput?.connection(with: .video)
    let secondaryConnection = secondaryVideoOutput?.connection(with: .video)
    // connection.isVideoHDREnabled is marked unavailable in recent SDKs, so it
    // is read through the responds(to:) + KVC helper: compiles on any SDK, nil
    // where the feature is absent.
    let snapshot = CommitSnapshot(
      pair: pair,
      captureId: captureId,
      deliveryURL: deliveryURL,
      evidenceDirURL: evidenceDirURL,
      capturedAtMs: capturedAtMs,
      calibrationDict: calibrationDict,
      timestampsDict: timestampsDict,
      stereoActive: stereoActive,
      stereoDetachedForThermal: stereoDetachedForThermal,
      // 'available' | 'degraded-thermal' | 'unsupported'. degraded is a
      // mid-session event; unsupported means the hardware never offered it
      // (§7).
      stereoStateString: stereoActive ? "available" : (stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
      droppedPairCount: droppedPairCount,
      droppedPrimaryCount: droppedPrimaryCount,
      droppedSecondaryHalfCount: droppedSecondaryHalfCount,
      secondaryAbsentCount: secondaryAbsentCount,
      secondaryDroppedCount: secondaryDroppedCount,
      completePairCount: completePairCount,
      hardwareCost: Double(session?.hardwareCost ?? -1),
      hardwareCostPayload: session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
      // Mixed String/NSNull values make the literal type ambiguous; the
      // explicit [String: Any] annotation resolves it.
      physicalDevices: [
        "primary": (primaryDevice?.deviceType.rawValue as Any?) ?? NSNull(),
        "secondary": ((stereoActive ? secondaryDevice?.deviceType.rawValue : nil) as Any?) ?? NSNull(),
      ] as [String: Any],
      primaryDevice: primaryDevice,
      secondaryDevice: stereoActive ? secondaryDevice : nil,
      primaryLabel: primaryLabel,
      secondaryLabel: secondaryLabel,
      primaryCalibration: sessionCalibrationObjects[primaryLabel],
      secondaryCalibration: sessionCalibrationObjects[secondaryLabel],
      primaryFormatID: currentFormatID,
      secondaryFormatID: secondaryDevice.flatMap { formatID(for: $0) },
      primaryStab: primaryConnection.map {
        DeviceModeMapper.stabilizationMode($0.preferredVideoStabilizationMode)
      },
      secondaryStab: secondaryConnection.map {
        DeviceModeMapper.stabilizationMode($0.preferredVideoStabilizationMode)
      },
      primaryStabActive: primaryConnection.flatMap {
        $0.isVideoStabilizationSupported
          ? DeviceModeMapper.stabilizationMode($0.activeVideoStabilizationMode)
          : nil
      },
      secondaryStabActive: secondaryConnection.flatMap {
        $0.isVideoStabilizationSupported
          ? DeviceModeMapper.stabilizationMode($0.activeVideoStabilizationMode)
          : nil
      },
      primaryHDR: (primaryDevice?.activeFormat.isVideoHDRSupported == true)
        ? primaryConnection.flatMap { connectionVideoHDREnabled($0) }
        : nil,
      secondaryHDR: (secondaryDevice?.activeFormat.isVideoHDRSupported == true)
        ? secondaryConnection.flatMap { connectionVideoHDREnabled($0) }
        : nil,
      configuredFPS: configuredFPS,
      photoFlashPreference: photoFlashPreference,
      flashSupportedModes: primaryPhotoOutput?.supportedFlashModes.map {
        DeviceModeMapper.flashMode($0)
      } ?? [],
      primaryConnectionMirrored: primaryConnection?.isVideoMirrored
    )

    // ---- phase 2: encode + write (sinkIOQueue), settle on sessionQueue ----
    sinkIOQueue.async { [weak self] in
      guard let self = self else { return } // module gone: the 10 s capture watchdog owns the promise
      let result = self.performPairCommit(snapshot)
      self.sessionQueue.async { completion(result) }
    }
  }

  /// Phase 2 of the pair commit. Runs on sinkIOQueue only, never
  /// sessionQueue.
  private func performPairCommit(
    _ snap: CommitSnapshot
  ) -> Result<[String: Any], ExhibitCameraNamedException> {
    let pair = snap.pair
    let captureId = snap.captureId
    let deliveryURL = snap.deliveryURL
    let evidenceDirURL = snap.evidenceDirURL
    do {
      try FileManager.default.createDirectory(at: evidenceDirURL, withIntermediateDirectories: true)
      try FileManager.default.createDirectory(at: deliveryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    } catch {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot create capture directories: \(error.localizedDescription)"))
    }

    // 1. Primary frame: full session resolution JPEG (the delivery still).
    guard let primaryBuffer = CMSampleBufferGetImageBuffer(pair.primary),
          let primaryJPEG = jpegData(from: primaryBuffer, quality: 0.9) else {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Primary frame could not be encoded"))
    }
    do {
      // `try?`: on a fresh delivery path the remove throws "no such file".
      try? FileManager.default.removeItem(at: deliveryURL)
      try primaryJPEG.write(to: deliveryURL, options: .atomic)
    } catch {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot write delivery still: \(error.localizedDescription)"))
    }

    // 2. Secondary frame: portrait-bounded ≤640×480 JPEG targeting ~200 KB
    // (spec §4.2 — geometry input; the actual bytes are committed). Upright in,
    // upright out.
    var secondaryEvidence: [String: Any]
    var secondaryBytes: Int? = nil
    var secondaryQuality: Double? = nil
    if !snap.stereoActive {
      secondaryEvidence = EvidencePathBuilder.neverRecorded(
        snap.stereoDetachedForThermal ? "stereo-detached-thermal" : "stereo-unsupported"
      )
    } else if let secondary = pair.secondary,
              let secondaryBuffer = CMSampleBufferGetImageBuffer(secondary) {
      let url = evidenceDirURL.appendingPathComponent("secondary-\(captureId).jpg")
      if let (data, quality) = downsampledJPEG(from: secondaryBuffer, targetBytes: 200_000) {
        do {
          try data.write(to: url, options: .atomic)
          secondaryEvidence = EvidencePathBuilder.path(url.path)
          secondaryBytes = data.count
          secondaryQuality = quality
        } catch {
          secondaryEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription)
        }
      } else {
        secondaryEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, "Secondary frame could not be encoded")
      }
    } else {
      secondaryEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.stalePair, "No valid secondary frame in the retained pair")
    }

    // 3. Calibration JSON (~2 KB): per-frame intrinsics and session-photo full
    // calibration, each with its source labeled (spec §4.2). The dict was
    // assembled in phase 1; only the write lands here.
    let calibrationURL = evidenceDirURL.appendingPathComponent("calibration-\(captureId).json")
    let calibrationEvidence: [String: Any]
    do {
      try CalibrationSerializer.writeJSON(snap.calibrationDict, to: calibrationURL)
      calibrationEvidence = EvidencePathBuilder.path(calibrationURL.path)
    } catch {
      calibrationEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription)
    }

    // 4. Sync timestamps JSON (dict from phase 1; write here).
    let timestampsURL = evidenceDirURL.appendingPathComponent("timestamps-\(captureId).json")
    let timestampsEvidence: [String: Any]
    do {
      try CalibrationSerializer.writeJSON(snap.timestampsDict, to: timestampsURL)
      timestampsEvidence = EvidencePathBuilder.path(timestampsURL.path)
    } catch {
      timestampsEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription)
    }

    // 5. Metadata block (spec §5/§14). Pro-control values are read back from
    // the device and the connections, not from the module's request log. Device
    // objects ride the snapshot, so these are pure reads.
    var metadata: [String: Any] = [:]
    if let device = snap.primaryDevice {
      metadata["primary"] = MetadataBlockBuilder.dictionary(
        for: device,
        calibration: snap.primaryCalibration, // focal pixels from session-photo calibration
        hardwareCost: Float(snap.hardwareCost),
        synchronizedDeltaMs: pair.deltaMs,
        droppedPairCount: snap.droppedPairCount,
        formatID: snap.primaryFormatID,
        stabilizationMode: snap.primaryStab,
        activeStabilizationMode: snap.primaryStabActive,
        hdrEnabled: snap.primaryHDR,
        configuredFPS: snap.configuredFPS
      )
    }
    if let device = snap.secondaryDevice, snap.stereoActive {
      metadata["secondary"] = MetadataBlockBuilder.dictionary(
        for: device,
        calibration: snap.secondaryCalibration,
        hardwareCost: Float(snap.hardwareCost),
        synchronizedDeltaMs: pair.deltaMs,
        droppedPairCount: snap.droppedPairCount,
        formatID: snap.secondaryFormatID,
        stabilizationMode: snap.secondaryStab,
        activeStabilizationMode: snap.secondaryStabActive,
        hdrEnabled: snap.secondaryHDR,
        configuredFPS: snap.configuredFPS
      )
    }
    metadata["captureId"] = captureId
    metadata["secondaryBytes"] = secondaryBytes as Any? ?? NSNull()
    metadata["secondaryJpegQuality"] = secondaryQuality as Any? ?? NSNull()
    // Where the secondary half dies: absent (no data object from the
    // synchronizer), dropped (data object marked dropped), or complete pairs
    // retained.
    metadata["secondaryAbsentCount"] = snap.secondaryAbsentCount
    metadata["secondaryDroppedCount"] = snap.secondaryDroppedCount
    metadata["completePairCount"] = snap.completePairCount
    let metadataURL = evidenceDirURL.appendingPathComponent("metadata-\(captureId).json")
    let metadataEvidence: [String: Any]
    do {
      try CalibrationSerializer.writeJSON(metadata, to: metadataURL)
      metadataEvidence = EvidencePathBuilder.path(metadataURL.path)
    } catch {
      metadataEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription)
    }

    // The committed camera-settings block, every value read back from
    // the device at this commit instant; flash and photo-EXIF facts merge in
    // later from the full-res photo's own metadata. Explicit nulls state
    // absence. Broken out of the payload literal because the inline
    // map-closure + ?? + `as [String: Any]` chain risks a type-check timeout.
    var captureSettingsBlock: [String: Any]
    if let commitDevice = snap.primaryDevice {
      captureSettingsBlock = CaptureSettingsBuilder.dictionary(
        for: commitDevice,
        photoFlash: snap.photoFlashPreference,
        flashSupportedModes: snap.flashSupportedModes,
        activeStabilizationMode: snap.primaryStabActive
      )
      // The color profile name is read out of the delivered JPEG's own bytes
      // (ImageIO). The fallback states the encoder-fixed pipeline fact: jpegData
      // renders into CGColorSpace.sRGB whatever the source buffer's space.
      captureSettingsBlock["deliveryStillColorSpace"] =
        JpegColorSpaceReader.profileName(from: primaryJPEG)
        ?? "sRGB (encoder-fixed; ImageIO reported no profile name)"
    } else {
      captureSettingsBlock = ["unavailable": true, "note": "no primary device reference at commit time"]
    }

    var result: [String: Any] = [
      "captureId": captureId,
      "deliveryPath": deliveryURL.path,
      "capturedAtMs": snap.capturedAtMs,
      "stereo": snap.stereoStateString,
      "secondaryFrame": secondaryEvidence,
      "calibration": calibrationEvidence,
      "timestamps": timestampsEvidence,
      "metadata": metadataEvidence,
      "synchronizedDeltaMs": pair.deltaMs as Any? ?? NSNull(),
      "droppedPairCount": snap.droppedPairCount,
      "hardwareCost": snap.hardwareCostPayload,
      "physicalDevices": snap.physicalDevices,
      "captureSettings": captureSettingsBlock,
      "frontMirrored": snap.primaryConnectionMirrored as Any? ?? NSNull(),
      // Live connection census at commit time; every capture carries its own
      // graph state.
      "connections": connectionCensus(),
    ]
    // Per-capture stereo evidence state: 'ok' only when a synchronized
    // secondary frame was committed. A stereo session whose secondary half
    // dropped at shutter commits 'unavailable' with the reason; the capture
    // still succeeds on the primary still. Absent on single-cam sessions, where
    // the 'stereo' capability string already says unsupported.
    if snap.stereoActive {
      if pair.secondary != nil {
        result["stereoStatus"] = "ok"
      } else {
        result["stereoStatus"] = "unavailable"
        result["stereoUnavailableReason"] = "secondary frame dropped at shutter (dropped pairs: \(snap.droppedPairCount), primary \(snap.droppedPrimaryCount), secondary-half \(snap.droppedSecondaryHalfCount); secondary-absent: \(snap.secondaryAbsentCount), secondary-dropped: \(snap.secondaryDroppedCount), complete-pairs: \(snap.completePairCount))"
      }
    }
    return .success(result)
  }

  private func buildCalibrationDict(pair: RetainedPair) -> [String: Any] {
    let primaryLabel = primaryDevice?.deviceType.rawValue ?? "primary"
    let secondaryLabel = secondaryDevice?.deviceType.rawValue ?? "secondary"
    // Per-frame intrinsics are extracted at commit time, not in the delivery
    // callback: the attachment rides the retained sample buffer, so the read is
    // identical but off the frame-rate hot path.
    let primaryIntrinsics = frameIntrinsics(from: pair.primary)
    let secondaryIntrinsics = pair.secondary.flatMap { frameIntrinsics(from: $0) }
    return [
      // Per-frame intrinsics from the documented attachment path; null when the
      // attachment was absent.
      "primaryIntrinsicsRowMajor": primaryIntrinsics as Any? ?? NSNull(),
      "secondaryIntrinsicsRowMajor": secondaryIntrinsics as Any? ?? NSNull(),
      // Full calibration (extrinsics, distortion LUTs) from the session
      // one-shot photo capture, or null.
      "primaryFull": sessionCalibration[primaryLabel] as Any? ?? NSNull(),
      "secondaryFull": sessionCalibration[secondaryLabel] as Any? ?? NSNull(),
      // Source labels distinguish per-frame from session-fixed, and full from
      // intrinsics-only.
      "calibrationSource": [
        "intrinsics": primaryIntrinsics != nil ? "frame-attachments" : "unavailable",
        "full": sessionCalibration.isEmpty ? "unavailable" : "session-photo-capture",
      ],
    ]
  }

  // MARK: - Encoding helpers (sinkIOQueue, never the frame delivery queue)

  /// BGRA/420 pixel buffer to JPEG.
  ///
  /// Orientation: the data connection physically rotates delivered buffers by
  /// its videoRotationAngle (see configureSession's orientation contract), so
  /// the bytes arrive upright. Encode exactly as delivered — baking a second
  /// 90° here double-rotates every committed still and stereo secondary.
  /// jpegRepresentation bakes the CIImage's orientation into the pixels, so the
  /// written JPEG is upright with orientation 1 and needs no EXIF tag. Front
  /// cameras also mirror, committed via physicalDevice in metadata.
  private func jpegData(from pixelBuffer: CVPixelBuffer, quality: CGFloat) -> Data? {
    let delivered = CIImage(cvPixelBuffer: pixelBuffer)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    // CIImageRepresentationOption wraps the CGImageDestination key by raw
    // value; the SDK exposes no named static for it.
    guard let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String) as CIImageRepresentationOption? else { return nil }
    return ciContext.jpegRepresentation(
      of: delivered,
      colorSpace: colorSpace,
      options: [qualityKey: quality]
    )
  }

  /// ≤640×480 downsample, portrait-bounded because the connection delivers
  /// upright portrait buffers (see jpegData). Quality steps down until the data
  /// is ≤ targetBytes or hits the 0.5 floor; the actual bytes are committed
  /// (spec §4.2).
  private func downsampledJPEG(from pixelBuffer: CVPixelBuffer, targetBytes: Int) -> (Data, Double)? {
    let source = CIImage(cvPixelBuffer: pixelBuffer)
    let extent = source.extent
    guard extent.width > 0, extent.height > 0 else { return nil }
    let scale = min(640.0 / extent.width, 480.0 / extent.height)
    let scaled = source
      .applyingFilter("CILanczosScaleTransform", parameters: [
        kCIInputScaleKey: scale,
        kCIInputAspectRatioKey: 1.0,
      ])
      .cropped(to: CGRect(x: 0, y: 0, width: 640, height: 480))
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
          let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String) as CIImageRepresentationOption? else { return nil }
    for quality in [0.8, 0.7, 0.6, 0.5] {
      if let data = ciContext.jpegRepresentation(
        of: scaled,
        colorSpace: colorSpace,
        options: [qualityKey: quality]
      ), data.count <= targetBytes || quality == 0.5 {
        return (data, quality)
      }
    }
    return nil
  }

  /// 8×8 luma difference hash (64 bits) of a ring frame, computed from the same
  /// pixel buffer the committed JPEG encodes, so frame distinctness is readable
  /// from committed data (N frames, M unique hashes).
  private func dHash64(from pixelBuffer: CVPixelBuffer) -> String? {
    let source = CIImage(cvPixelBuffer: pixelBuffer)
    let extent = source.extent
    guard extent.width > 0, extent.height > 0 else { return nil }
    // 9×8 luma grid (aspect-stretched, classic dHash geometry): 8 rows × 8
    // horizontal neighbor comparisons = 64 bits.
    let w = 9, h = 8
    let scaled = source
      .applyingFilter("CILanczosScaleTransform", parameters: [
        kCIInputScaleKey: CGFloat(w) / extent.width,
        kCIInputAspectRatioKey: (CGFloat(h) / extent.height) / (CGFloat(w) / extent.width),
      ])
      .cropped(to: CGRect(x: 0, y: 0, width: w, height: h))
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    ciContext.render(
      scaled,
      toBitmap: &pixels,
      rowBytes: w * 4,
      bounds: CGRect(x: 0, y: 0, width: w, height: h),
      format: .RGBA8,
      colorSpace: colorSpace
    )
    var hash: UInt64 = 0
    for y in 0..<h {
      for x in 0..<(w - 1) {
        let i0 = (y * w + x) * 4
        let i1 = (y * w + x + 1) * 4
        let l0 = (Int(pixels[i0]) * 299 + Int(pixels[i0 + 1]) * 587 + Int(pixels[i0 + 2]) * 114) / 1000
        let l1 = (Int(pixels[i1]) * 299 + Int(pixels[i1 + 1]) * 587 + Int(pixels[i1 + 2]) * 114) / 1000
        hash = (hash << 1) | (l0 > l1 ? 1 : 0)
      }
    }
    return String(format: "%016llx", hash)
  }

  // MARK: - True Bayer RAW opt-in (spec §9)

  /// Fires a RAW photo capture on the primary photo output. True Bayer RAW
  /// only; ProRAW is platform-processed and is not this path (spec §9).
  /// Completion hops back on sessionQueue.
  private func commitRawOptIn(
    captureId: String,
    evidenceDirURL: URL,
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard let photoOutput = primaryPhotoOutput else {
      completion(EvidencePathBuilder.error(ExhibitCameraErrorCode.platform, "No primary photo output in this session"))
      return
    }
    // availableRawPhotoPixelFormatTypes elements are already OSType (UInt32).
    // The RAW settings initializer label is rawPixelFormatType:, and flashMode
    // is fully qualified so the .off member keeps its contextual base.
    guard let rawFormat = photoOutput.availableRawPhotoPixelFormatTypes.first else {
      // Unsupported hardware (spec §7/§9).
      completion(EvidencePathBuilder.neverRecorded("raw-unsupported"))
      return
    }
    let settings = AVCapturePhotoSettings(rawPixelFormatType: rawFormat)
    if photoOutput.isCameraCalibrationDataDeliverySupported {
      settings.isCameraCalibrationDataDeliveryEnabled = true
    }
    // The setter validates against supportedFlashModes at set time and raises
    // an uncatchable NSException on a mismatch, so assign only when contained.
    if photoOutput.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      settings.flashMode = AVCaptureDevice.FlashMode.off
    }
    let dngURL = evidenceDirURL.appendingPathComponent("primary-\(captureId).dng")
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      // The settings requested RAW, so a delivered photo is the Bayer RAW
      // capture and fileDataRepresentation() is the DNG.
      if let photo = photo, let data = photo.fileDataRepresentation() {
        do {
          try data.write(to: dngURL, options: .atomic)
          completion(EvidencePathBuilder.path(dngURL.path))
        } catch {
          completion(EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription))
        }
      } else {
        completion(EvidencePathBuilder.error(
          ExhibitCameraErrorCode.platform,
          "RAW capture failed: \(error?.localizedDescription ?? "no photo delivered"); \(self?.photoFailureDump(path: "normal", settings: settings, output: photoOutput, device: self?.primaryDevice) ?? "dump=unavailable")"
        ))
      }
      // Release the retained delegate forwarder; the sessionQueue hop keeps
      // photoHandlers single-threaded.
      self?.sessionQueue.async {
        if let handlerRef = handlerRef {
          self?.photoHandlers.removeAll { $0 === handlerRef }
        }
      }
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // NSException-safe fire: a settings-validation throw becomes the stated RAW
    // error.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      completion(EvidencePathBuilder.error(
        ExhibitCameraErrorCode.platform,
        "RAW capture threw at fire time: \(captureError.localizedDescription)"
      ))
    }
  }
}

// MARK: - Full-res stills: photo-output captures at full sensor resolution

extension ExhibitCameraModule {

  /// One full-res capture's outcome: the three-state evidence path plus the
  /// facts only the photo itself carries (hash, dimensions, OS-written EXIF,
  /// strobe-fired bit).
  private struct FullResOutcome {
    let evidence: [String: Any]        // EvidencePath dict
    let sha256: String?                // hex of the exact bytes on disk
    let dimensions: [String: Int]?     // resolved photo dimensions (iOS 16+)
    let photoExif: [String: Any]?      // OS-written EXIF numbers, verbatim
    let flashFired: Bool?
    let flashRequested: String
    let flashApplied: Bool
    let flashNote: String?
    // Device-reported videoZoomFactor at capture-fire time. The still is
    // center-cropped and upscaled by it while its EXIF FocalLength stays the
    // physical lens, so committing it makes the delivered image's effective
    // geometry derivable. nil only with no device reference.
    let zoomFactor: Double?
    // Color profile name read out of the delivered JPEG's own bytes
    // (ImageIO); nil means omitted.
    let colorSpace: String?
    // The depth artifact's three-state evidence, the sha256 of its exact
    // bytes, and its metadata (map semantics, dimensions, accuracy,
    // normalization window, calibration when delivered). never-recorded with a
    // reason whenever depth is absent.
    let depthEvidence: [String: Any]
    let depthSha256: String?
    let depthMetadata: [String: Any]?
  }

  /// Fires the full-res still captures and folds their outcomes into the
  /// capture payload. Runs on sessionQueue, and the completion fires on
  /// sessionQueue too (the photo delegate callback hops), so the downstream
  /// RAW/settle chain keeps its single-queue confinement. Outputs are captured
  /// sequentially; back-to-back photo captures on a live multi-cam graph starve
  /// the pipeline. A full-res failure is a stated EvidencePath, not a capture
  /// rejection.
  private func attachFullResStills(
    captureId: String,
    evidenceDirURL: URL,
    payload: [String: Any],
    completion: @escaping ([String: Any]) -> Void
  ) {
    // Video mode: the delivery mp4 owns the pipeline and a photo capture
    // mid-recording would starve the writer, so it is not attempted.
    guard mode == .preview else {
      var out = payload
      out["fullResStill"] = EvidencePathBuilder.neverRecorded("video-mode-recording")
      out["fullResSecondary"] = EvidencePathBuilder.neverRecorded("video-mode-recording")
      out["fullResStillDepth"] = EvidencePathBuilder.neverRecorded("video-mode-recording")
      out["fullResSecondaryDepth"] = EvidencePathBuilder.neverRecorded("video-mode-recording")
      completion(out)
      return
    }
    guard let primaryPhoto = primaryPhotoOutput else {
      var out = payload
      out["fullResStill"] = EvidencePathBuilder.neverRecorded("no-photo-output")
      out["fullResSecondary"] = EvidencePathBuilder.neverRecorded("no-photo-output")
      out["fullResStillDepth"] = EvidencePathBuilder.neverRecorded("no-photo-output")
      out["fullResSecondaryDepth"] = EvidencePathBuilder.neverRecorded("no-photo-output")
      completion(out)
      return
    }
    captureFullResStill(
      output: primaryPhoto,
      fileStem: "fullres-\(captureId)",
      evidenceDirURL: evidenceDirURL
    ) { [weak self] primaryResult in
      guard let self = self else { return }
      var out = payload
      self.mergeFullRes(&out, key: "fullResStill", result: primaryResult)
      if self.stereoActive {
        // The stereo still derives from the retained synchronized pair's UW
        // frame; there is no secondary photo output (see configureSession).
        // Same buffer the geometry evidence commits, at stream resolution
        // (1280×720 UW), encoded once more at full quality: no OS EXIF block,
        // no strobe, no depth, each stated in the outcome below.
        self.deriveSecondaryStillFromPair(
          fileStem: "fullres-secondary-\(captureId)",
          evidenceDirURL: evidenceDirURL
        ) { [weak self] secondaryResult in
          guard let self = self else { return }
          self.mergeFullRes(&out, key: "fullResSecondary", result: secondaryResult)
          completion(out)
        }
      } else {
        // Same never-recorded vocabulary as the video-frame secondary: thermal
        // detach is a mid-session event, unsupported means the hardware never
        // offered it.
        out["fullResSecondary"] = EvidencePathBuilder.neverRecorded(
          self.stereoDetachedForThermal ? "stereo-detached-thermal" : "stereo-unsupported"
        )
        out["fullResSecondaryDepth"] = EvidencePathBuilder.neverRecorded(
          self.stereoDetachedForThermal ? "stereo-detached-thermal" : "stereo-unsupported"
        )
        completion(out)
      }
    }
  }

  /// One full-sensor JPEG capture on a photo output. The strobe preference is
  /// validated against this output's supportedFlashModes; an unsupported
  /// mode degrades to off with the reason stated. The completion fires exactly
  /// once, on sessionQueue.
  private func captureFullResStill(
    output: AVCapturePhotoOutput,
    fileStem: String,
    evidenceDirURL: URL,
    completion: @escaping (FullResOutcome) -> Void
  ) {
    let pref = photoFlashPreference
    let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
    var flashApplied = false
    var flashNote: String? = nil
    // The flashMode setter validates against supportedFlashModes at set time
    // and raises an uncatchable NSException on a mismatch, so assign only
    // contained values. An unassigned setting defaults to no flash.
    if pref != .off, output.supportedFlashModes.contains(pref.avFlashMode) {
      settings.flashMode = pref.avFlashMode
      flashApplied = true
    } else if output.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      settings.flashMode = AVCaptureDevice.FlashMode.off
      if pref != .off {
        flashNote = "flash mode '\(pref.rawValue)' is not in this output's supportedFlashModes — captured without the strobe (stated, not faked)"
      }
    } else if pref != .off {
      flashNote = "flash mode '\(pref.rawValue)' is not in this output's supportedFlashModes — captured without the strobe (stated, not faked)"
    }

    // The zoom factor in force as this capture fires (sessionQueue), not
    // the configure-time value. The still is center-cropped and upscaled by
    // this same device property, so committing it makes the delivered image's
    // effective focal length and FOV derivable; the photo's EXIF FocalLength
    // stays the physical lens.
    let zoomDevice = output === self.primaryPhotoOutput ? self.primaryDevice : self.secondaryDevice
    let zoomFactor = zoomDevice.map { Double($0.videoZoomFactor) }

    // Request depth delivery only when the flag is on and the live output
    // supports it for the current device/format. The reason rides the depth
    // fields when it is not requested; a delivery or extraction failure later
    // degrades to depth-not-recorded rather than failing the still.
    let depthNotRequestedReason = self.requestDepthIfHonest(settings: settings, output: output)

    let url = evidenceDirURL.appendingPathComponent("\(fileStem).jpg")
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      // Release the retained delegate forwarder on sessionQueue;
      // photoHandlers is sessionQueue-confined.
      self?.sessionQueue.async { [weak self] in
        if let handlerRef = handlerRef {
          self?.photoHandlers.removeAll { $0 === handlerRef }
        }
      }
      guard let self = self else { return }
      let finish: (FullResOutcome) -> Void = { [weak self] outcome in
        self?.sessionQueue.async { completion(outcome) }
      }
      guard let photo = photo, let data = photo.fileDataRepresentation() else {
        finish(FullResOutcome(
          evidence: EvidencePathBuilder.error(
            ExhibitCameraErrorCode.platform,
            "Full-res photo failed: \(error?.localizedDescription ?? "no photo delivered"); \(self.photoFailureDump(path: "normal", settings: settings, output: output, device: output === self.primaryPhotoOutput ? self.primaryDevice : self.secondaryDevice))"
          ),
          sha256: nil, dimensions: nil, photoExif: nil, flashFired: nil,
          flashRequested: pref.rawValue, flashApplied: flashApplied, flashNote: flashNote,
          zoomFactor: zoomFactor, colorSpace: nil,
          depthEvidence: EvidencePathBuilder.neverRecorded(depthNotRequestedReason ?? "photo-capture-failed"),
          depthSha256: nil, depthMetadata: nil
        ))
        return
      }
      do {
        try data.write(to: url, options: .atomic)
      } catch {
        finish(FullResOutcome(
          evidence: EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription),
          sha256: nil, dimensions: nil, photoExif: nil, flashFired: nil,
          flashRequested: pref.rawValue, flashApplied: flashApplied, flashNote: flashNote,
          zoomFactor: zoomFactor, colorSpace: nil,
          depthEvidence: EvidencePathBuilder.neverRecorded(depthNotRequestedReason ?? "photo-write-failed"),
          depthSha256: nil, depthMetadata: nil
        ))
        return
      }
      // The committed hash binds the exact bytes on disk (CryptoKit SHA-256).
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      var dimensions: [String: Int]? = nil
      if #available(iOS 16.0, *) {
        let d = photo.resolvedSettings.photoDimensions
        if d.width > 0, d.height > 0 {
          dimensions = ["width": Int(d.width), "height": Int(d.height)]
        }
      }
      // EXIF: only what the OS wrote into this photo's metadata. The
      // strobe-fired bit comes from that same metadata.
      let exif = PhotoExifExtractor.dictionary(from: photo)
      let fired = PhotoExifExtractor.flashFired(from: exif)
      // Depth rides the delivered photo, extracted, written, and hashed
      // after the still is safe on disk. Any failure here states itself in the
      // depth evidence and does not touch the photo's own outcome.
      let depth: (evidence: [String: Any], sha256: String?, metadata: [String: Any]?)
      if let reason = depthNotRequestedReason {
        depth = (EvidencePathBuilder.neverRecorded(reason), nil, nil)
      } else {
        depth = self.commitDepthArtifact(
          from: photo,
          depthURL: evidenceDirURL.appendingPathComponent("depth-\(fileStem).png"),
          device: output === self.primaryPhotoOutput ? self.primaryDevice : self.secondaryDevice,
          photoWidth: dimensions?["width"],
          photoHeight: dimensions?["height"]
        )
      }
      finish(FullResOutcome(
        evidence: EvidencePathBuilder.path(url.path),
        sha256: digest, dimensions: dimensions,
        photoExif: exif.isEmpty ? nil : exif, flashFired: fired,
        flashRequested: pref.rawValue, flashApplied: flashApplied, flashNote: flashNote,
        zoomFactor: zoomFactor, colorSpace: JpegColorSpaceReader.profileName(from: data),
        depthEvidence: depth.evidence, depthSha256: depth.sha256, depthMetadata: depth.metadata
      ))
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // NSException-safe fire: capturePhoto validates settings against the live
    // multi-cam graph and raises an NSException on a mismatch, which Swift
    // cannot catch, so the fire goes through the ObjC trampoline. A throw
    // becomes this still's stated failure outcome; the delivery still already
    // committed, so the full-res block degrades and the capture survives.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: output, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      completion(FullResOutcome(
        evidence: EvidencePathBuilder.error(
          ExhibitCameraErrorCode.platform,
          "Full-res photo threw at fire time: \(captureError.localizedDescription); \(self.photoFailureDump(path: "normal", settings: settings, output: output, device: output === self.primaryPhotoOutput ? self.primaryDevice : self.secondaryDevice))"
        ),
        sha256: nil, dimensions: nil, photoExif: nil, flashFired: nil,
        flashRequested: pref.rawValue, flashApplied: flashApplied, flashNote: flashNote,
        zoomFactor: zoomFactor, colorSpace: nil,
        depthEvidence: EvidencePathBuilder.neverRecorded(depthNotRequestedReason ?? "photo-capture-threw"),
        depthSha256: nil, depthMetadata: nil
      ))
    }
  }

  /// Stereo still without a photo output: encodes the retained synchronized
  /// pair's secondary (UW) frame at stream resolution. The buffer is already
  /// upright (see configureSession's orientation contract). Runs on
  /// sessionQueue, its caller's confinement; a 720p CIContext encode is ~5 ms
  /// and captureFullResStill's primary encode precedes it on the same queue.
  /// The completion fires exactly once, on sessionQueue. A missing secondary
  /// half is stalePair, matching the geometry evidence; an encode or write
  /// failure is sink.
  private func deriveSecondaryStillFromPair(
    fileStem: String,
    evidenceDirURL: URL,
    completion: @escaping (FullResOutcome) -> Void
  ) {
    let depthNA = EvidencePathBuilder.neverRecorded("no-photo-output")
    guard let pair = latestPair,
          let secondary = pair.secondary,
          let buffer = CMSampleBufferGetImageBuffer(secondary) else {
      completion(FullResOutcome(
        evidence: EvidencePathBuilder.error(
          ExhibitCameraErrorCode.stalePair,
          "No valid secondary frame in the retained pair for the video-derived stereo still"
        ),
        sha256: nil, dimensions: nil, photoExif: nil, flashFired: nil,
        flashRequested: photoFlashPreference.rawValue, flashApplied: false,
        flashNote: "video-stream-derived still: the strobe applies to photo captures only (stated, not faked)",
        zoomFactor: secondaryDevice.map { Double($0.videoZoomFactor) },
        colorSpace: nil,
        depthEvidence: depthNA, depthSha256: nil, depthMetadata: nil
      ))
      return
    }
    guard let data = jpegData(from: buffer, quality: 0.9) else {
      completion(FullResOutcome(
        evidence: EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, "Video-derived secondary frame could not be encoded"),
        sha256: nil, dimensions: nil, photoExif: nil, flashFired: nil,
        flashRequested: photoFlashPreference.rawValue, flashApplied: false, flashNote: nil,
        zoomFactor: nil, colorSpace: nil,
        depthEvidence: depthNA, depthSha256: nil, depthMetadata: nil
      ))
      return
    }
    let url = evidenceDirURL.appendingPathComponent("\(fileStem).jpg")
    do {
      try data.write(to: url, options: .atomic)
    } catch {
      completion(FullResOutcome(
        evidence: EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription),
        sha256: nil, dimensions: nil, photoExif: nil, flashFired: nil,
        flashRequested: photoFlashPreference.rawValue, flashApplied: false, flashNote: nil,
        zoomFactor: nil, colorSpace: nil,
        depthEvidence: depthNA, depthSha256: nil, depthMetadata: nil
      ))
      return
    }
    // Same commitment contract as the photo-output still: the hash binds the
    // exact bytes on disk and dimensions are read from the buffer itself.
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let dimensions = [
      "width": CVPixelBufferGetWidth(buffer),
      "height": CVPixelBufferGetHeight(buffer),
    ]
    completion(FullResOutcome(
      evidence: EvidencePathBuilder.path(url.path),
      sha256: digest, dimensions: dimensions,
      // No OS EXIF exists for a video frame, so the field is nil (omitted).
      // The source label below states the derivation.
      photoExif: nil, flashFired: nil,
      flashRequested: photoFlashPreference.rawValue, flashApplied: false,
      flashNote: "video-stream-derived still (0.18.5: no secondary photo output by design): stream-resolution UW frame from the synchronized pair — no strobe, no OS EXIF, no depth (stated, not faked)",
      zoomFactor: secondaryDevice.map { Double($0.videoZoomFactor) },
      colorSpace: JpegColorSpaceReader.profileName(from: data),
      depthEvidence: depthNA, depthSha256: nil, depthMetadata: nil
    ))
  }

  /// Compact state dump appended to every photo-capture failure message:
  /// `key=value` pairs joined by "; ". Reads live connection and device state at
  /// failure time (sessionQueue-confined, like its callers), not the module's
  /// request log.
  private func photoFailureDump(
    path: String,
    settings: AVCapturePhotoSettings?,
    output: AVCapturePhotoOutput?,
    device: AVCaptureDevice?
  ) -> String {
    var parts: [String] = ["path=\(path)"]
    if let settings = settings {
      let formatKeys = (settings.format ?? [:]).keys.sorted().joined(separator: ",")
      parts.append("settings.formatKeys=[\(formatKeys)]")
      parts.append("settings.flashMode=\(DeviceModeMapper.flashMode(settings.flashMode))")
      if #available(iOS 16.0, *) {
        let dims = settings.maxPhotoDimensions
        let wasSet = dims.width > 0 && dims.height > 0
        parts.append("settings.maxPhotoDimensions=\(wasSet ? "\(dims.width)x\(dims.height)" : "unset")")
      }
    } else {
      parts.append("settings=not-built")
    }
    for (label, photoOutput) in [("primary", self.primaryPhotoOutput), ("secondary", self.secondaryPhotoOutput)] {
      guard let photoOutput = photoOutput, let connection = photoOutput.connection(with: .video) else {
        parts.append("\(label)PhotoConn=none")
        continue
      }
      let state = "enabled=\(connection.isEnabled),active=\(connection.isActive),mirrored=\(connection.isVideoMirrored)"
      if #available(iOS 17.0, *) {
        parts.append("\(label)PhotoConn(\(state),rotationAngle=\(connection.videoRotationAngle))")
      } else {
        parts.append("\(label)PhotoConn(\(state),orientation=\(connection.videoOrientation.rawValue))")
      }
    }
    // The video connections decide whether the pair pipeline can live at all,
    // so an absent secondary video connection is visible in every capture
    // failure.
    for (label, videoOutput) in [("primaryVideo", self.primaryVideoOutput), ("secondaryVideo", self.secondaryVideoOutput)] {
      guard let videoOutput = videoOutput, let connection = videoOutput.connection(with: .video) else {
        parts.append("\(label)Conn=none")
        continue
      }
      let portDevice = connection.inputPorts.first?.sourceDeviceType?.rawValue ?? "unknown"
      parts.append("\(label)Conn(enabled=\(connection.isEnabled),active=\(connection.isActive),port=\(portDevice))")
    }
    if let device = device {
      let dims = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
      parts.append("activeFormat=\(dims.width)x\(dims.height)")
    } else {
      parts.append("activeFormat=none")
    }
    if let output = output {
      parts.append("supportedFlashModes=[\(output.supportedFlashModes.map { String($0.rawValue) }.joined(separator: ","))]")
    } else {
      parts.append("supportedFlashModes=none")
    }
    // Every debug flag, sorted. A persisted non-default flag in the
    // exhibit.debug suite survives app updates (only deletion clears it), so
    // the dump carries the whole flag state.
    for (key, value) in ExhibitDebugFlags.all().sorted(by: { $0.key < $1.key }) {
      parts.append("flag.\(key)=\(value)")
    }
    return parts.joined(separator: "; ")
  }

  /// Depth gating: request depth delivery with a photo only when the flag is on
  /// (default true) and the live output reports support for the current
  /// device/format; there is no session-free depth-support query. Returns the
  /// never-recorded reason when not requested, nil when requested. Never
  /// throws: depth problems degrade to depth-not-recorded. The RAW path never
  /// calls this, since RAW and depth delivery are mutually exclusive.
  private func requestDepthIfHonest(settings: AVCapturePhotoSettings, output: AVCapturePhotoOutput) -> String? {
    guard ExhibitDebugFlags.depthCapture else { return "depth-disabled" }
    // Key on output-level enablement, not mere support: the settings setter
    // throws uncatchably when delivery is not enabled on the output.
    // Enablement happens once at addOutput time (applyFullResPhotoPolicy).
    guard output.isDepthDataDeliveryEnabled else { return "depth-unsupported" }
    settings.isDepthDataDeliveryEnabled = true
    if output.isCameraCalibrationDataDeliverySupported {
      // The committed extrinsics ride the same delivery, under the same flag.
      settings.isCameraCalibrationDataDeliveryEnabled = true
    }
    return nil
  }

  /// Depth export: when depth data arrived with a delivered photo,
  /// canonicalize it (ExhibitDepthMapExtractor), write the PNG, and hash the
  /// exact bytes the JS commit layer receives. Absence is stated three-state;
  /// any failure here degrades to never-recorded or error rather than failing
  /// the photo, which is already on disk.
  private func commitDepthArtifact(
    from photo: AVCapturePhoto,
    depthURL: URL,
    device: AVCaptureDevice?,
    photoWidth: Int?,
    photoHeight: Int?
  ) -> (evidence: [String: Any], sha256: String?, metadata: [String: Any]?) {
    guard let depthData = photo.depthData else {
      // Requested but the pipeline produced none; scene-dependent.
      return (EvidencePathBuilder.neverRecorded("depth-not-delivered"), nil, nil)
    }
    guard let outcome = ExhibitDepthMapExtractor.extract(from: depthData, photoWidth: photoWidth, photoHeight: photoHeight) else {
      return (EvidencePathBuilder.error(ExhibitCameraErrorCode.platform, "Depth data arrived but PNG export failed"), nil, nil)
    }
    var metadata = outcome.metadata
    if let calibration = photo.cameraCalibrationData {
      // The signed extrinsics ride the depth metadata when the OS delivered
      // them with this photo.
      metadata["cameraCalibration"] = CalibrationSerializer.dictionary(
        from: calibration,
        deviceLabel: device?.deviceType.rawValue ?? "unknown"
      )
    }
    do {
      try outcome.png.write(to: depthURL, options: .atomic)
    } catch {
      return (EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, "Cannot write depth map: \(error.localizedDescription)"), nil, nil)
    }
    // The committed hash binds the exact bytes on disk (CryptoKit SHA-256); the
    // JS layer commits it verbatim.
    let digest = SHA256.hash(data: outcome.png).map { String(format: "%02x", $0) }.joined()
    return (EvidencePathBuilder.path(depthURL.path), digest, metadata)
  }

  /// Folds one full-res outcome into the payload. The primary still also merges
  /// its OS-written EXIF and strobe outcome into captureSettings; photo
  /// metadata is the only source for flash-fired.
  private func mergeFullRes(_ payload: inout [String: Any], key: String, result: FullResOutcome) {
    payload[key] = result.evidence
    payload["\(key)Sha256"] = result.sha256 as Any? ?? NSNull()
    payload["\(key)Dimensions"] = result.dimensions as Any? ?? NSNull()
    // The capture-fire zoom factor and the artifact-read color
    // profile ride beside the hash and dimensions for both full-res artifacts,
    // omitted when the source reported nothing.
    if let zoomFactor = result.zoomFactor {
      payload["\(key)ZoomFactor"] = zoomFactor
    }
    if let colorSpace = result.colorSpace {
      payload["\(key)ColorSpace"] = colorSpace
    }
    // The depth artifact's three-state evidence, the sha256 of its exact
    // bytes, and its metadata (mime, map semantics, dimensions, accuracy).
    // Absence is stated via the evidence reason.
    payload["\(key)Depth"] = result.depthEvidence
    payload["\(key)DepthSha256"] = result.depthSha256 as Any? ?? NSNull()
    payload["\(key)DepthMetadata"] = result.depthMetadata as Any? ?? NSNull()
    guard key == "fullResStill" else { return }
    var settings = payload["captureSettings"] as? [String: Any] ?? [:]
    if let exif = result.photoExif {
      settings["photoExif"] = exif
    }
    if let fired = result.flashFired {
      settings["flashFired"] = fired
    }
    settings["photoFlashApplied"] = [
      "requested": result.flashRequested,
      "applied": result.flashApplied,
      "note": result.flashNote as Any? ?? NSNull(),
    ] as [String: Any]
    payload["captureSettings"] = settings
  }
}

// MARK: - Video mode (spec §8: delivery mp4 + periodic stereo pairs)

extension ExhibitCameraModule {

  /// opts: { deliveryPath, evidenceDir, pairIntervalSec? }. Requires a running
  /// session (configureSession first); the same session records. Arms the
  /// writer and resolves once the writer is accepting frames.
  func startVideo(opts: [String: Any], promise: Promise) {
    guard session != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "configureSession must run before startVideo"))
      return
    }
    // videoState owns this decision. A start that arrives while the previous
    // clip is still sealing queues behind it instead of rejecting. The seal
    // owns a 10 s watchdog, so a queued start cannot hang; it re-enters this
    // function once the state returns to .idle.
    switch videoState {
    case .idle:
      break
    case .recording:
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.busy, "Video is already recording"))
      return
    case .stopping:
      guard pendingStartVideo == nil else {
        promise.reject(ExhibitCameraNamedException(
          ExhibitCameraErrorCode.busy,
          "A recording is already queued behind the clip that is finishing"
        ))
        return
      }
      pendingStartVideo = (opts, promise)
      return
    }
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.permission, "Microphone permission is required for video"))
      return
    }
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          let deliveryURL = exhibitCameraURL(for: deliveryPath),
          let evidenceDirURL = exhibitCameraURL(for: evidenceDir) else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }

    // Audio input and output are added to the running session inside a
    // configuration. The synchronizer is untouched: audio sits outside it.
    guard let session = session else { return }
    session.beginConfiguration()
    do {
      guard let audioDevice = AVCaptureDevice.default(for: .audio) else {
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No audio capture device available")
      }
      let audioInput = try AVCaptureDeviceInput(device: audioDevice)
      guard session.canAddInput(audioInput) else {
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot add audio input")
      }
      // Explicit multi-cam wiring; see wireOutput. An implicitly formed mic
      // connection on a running multi-cam graph can silently never deliver.
      session.addInputWithNoConnections(audioInput)
      let audioOutput = AVCaptureAudioDataOutput()
      audioOutput.setSampleBufferDelegate(audioHandler, queue: sessionQueue)
      guard wireOutput(audioOutput, to: audioInput, mediaType: .audio, in: session, label: "audio") != nil else {
        session.removeInput(audioInput)
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot connect audio output to the microphone input")
      }
      self.audioInput = audioInput
      self.audioOutput = audioOutput
    } catch let e as ExhibitCameraNamedException {
      session.commitConfiguration()
      promise.reject(e)
      return
    } catch {
      session.commitConfiguration()
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Audio input failed: \(error.localizedDescription)"))
      return
    }
    session.commitConfiguration()

    // hardwareCost re-check after adding audio (spec §6).
    if session.hardwareCost > 1.0 {
      if let audioOutput = audioOutput { session.removeOutput(audioOutput) }
      if let audioInput = audioInput { session.removeInput(audioInput) }
      self.audioInput = nil
      self.audioOutput = nil
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.hardwareCost,
        "Camera graph cost \(session.hardwareCost) exceeds budget 1.0 with audio; video refused"
      ))
      return
    }

    try? FileManager.default.createDirectory(at: deliveryURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: deliveryURL) // writer fails on existing files
    let writer: AVAssetWriter
    do {
      writer = try AVAssetWriter(outputURL: deliveryURL, fileType: .mp4)
    } catch {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.writer, "Cannot create delivery writer: \(error.localizedDescription)"))
      return
    }

    self.writer = writer
    self.deliveryURL = deliveryURL
    self.evidenceDirURL = evidenceDirURL
    // Raw-audio-master sink: creation failure is a sink failure (onError
    // E_SINK, rawPcmPath:null at stop); delivery is already safe above.
    pcmEnabled = (opts["rawPcm"] as? Bool) ?? false
    pcmWriter = nil
    pcmConverter = nil
    if pcmEnabled {
      do {
        try FileManager.default.createDirectory(at: evidenceDirURL, withIntermediateDirectories: true)
        pcmWriter = try PcmMasterWriter(url: evidenceDirURL.appendingPathComponent("master-\(sessionId).caf"))
        pcmConverter = AudioMasterConverter()
      } catch {
        sendError(ExhibitCameraErrorCode.sink, "PCM master creation failed: \(error.localizedDescription)")
        pcmWriter = nil
        pcmConverter = nil
      }
      // A nil converter fails the sink like a creation throw: a live writer
      // with no converter would no-op every tee and report rawPcmPath:null with
      // no error anywhere.
      if pcmWriter != nil, pcmConverter == nil {
        sendError(ExhibitCameraErrorCode.sink, "PCM master converter creation failed (format init returned nil) — sink disabled for this take")
        pcmWriter = nil
      }
    }
    // Per-take audio diagnostics and ENF anchor state.
    audioBufferCount = 0
    pcmFirstSampleWallClockUtcMs = nil
    pcmAnchorSource = ""
    // Default pair cadence 2 s; the floor is also 2 s.
    self.pairIntervalSec = max(2.0, (opts["pairIntervalSec"] as? NSNumber)?.doubleValue ?? 2.0)
    self.mode = .video
    self.videoState = .recording
    self.writerStarted = false
    self.writerFailed = false
    self.writerVideoInput = nil
    self.writerAudioInput = nil
    self.writerVideoFirstPTS = nil
    self.writerAudioFirstPTS = nil
    self.pairIndex = 0
    self.pairsMissed = 0
    // The first video frame dumps a pair immediately, anchoring record-start.
    self.lastPairDumpAt = .distantPast
    self.videoStartDate = Date()
    // IMU sink: the recording window starts now on the mach/boot clock, the
    // same clock the ring's sample timestamps ride, so stopVideo slices [this
    // instant, stop instant] with no conversion. The logger itself started at
    // configureSession and keeps running through the take.
    self.videoSensorStartBootSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    self.videoStartEpochMs = currentEpochMs()

    audioHandler.onAudio = { [weak self] buffer in
      self?.handleAudioSample(buffer)
    }

    // Resolve immediately: configureSession's first-frame watchdog already
    // proved the session live. Writer failures surface via onSessionError
    // (E_WRITER) and the stopVideo payload.
    promise.resolve([
      "sessionId": sessionId,
      "startedAtMs": currentEpochMs(),
      "pairIntervalSec": pairIntervalSec,
      "stereo": stereoActive ? "available" : (stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
    ])
  }

  /// Primary video frames to the delivery writer. The input is created lazily
  /// from the real stream format; buffers before startSession are dropped.
  private func handleVideoFrame(_ sampleBuffer: CMSampleBuffer) {
    guard let writer = writer, !writerFailed else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

    if writerVideoInput == nil {
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
      // Orientation contract: the capture connection physically rotates these
      // buffers by its videoRotationAngle (see configureSession), so the frames
      // are already upright and `dims` above reads the rotated dims. The track
      // transform must be identity — stamping the connection's rotation angle
      // here is a second rotation and plays back sideways.
      // videoRotationTransform is only valid for connections that do not
      // physically rotate.
      input.transform = .identity
      guard writer.canAdd(input) else {
        writerFailed = true
        sendError(ExhibitCameraErrorCode.writer, "Asset writer rejected the video input: \(writer.error?.localizedDescription ?? "unknown")")
        return
      }
      writer.add(input)
      writerVideoInput = input
      writerVideoFirstPTS = pts
      scheduleAudioFallback()
    }

    guard writerStarted else {
      maybeStartWriter()
      return
    }

    guard writer.status == .writing, let input = writerVideoInput, input.isReadyForMoreMediaData else { return }
    if !input.append(sampleBuffer), writer.status == .failed {
      writerFailed = true
      sendError(ExhibitCameraErrorCode.writer, "Asset writer append failed: \(writer.error?.localizedDescription ?? "unknown")")
    }
  }

  /// Rule 4 tee: the delivery AAC writer consumes the native buffers, the PCM
  /// master the converted canonical representation of the same buffers. Runs
  /// from the first audio frame in its own clock domain, uncoupled from the
  /// delivery writer's session-start timing. Any failure fails the sink (onError
  /// E_SINK, rawPcmPath:null at stop), never delivery.
  private func teeToPcmMaster(_ sampleBuffer: CMSampleBuffer) {
    guard let pcmWriter = pcmWriter, !pcmWriter.failed else { return }
    do {
      if let converted = try pcmConverter?.convert(sampleBuffer) {
        try pcmWriter.append(pcmBuffer: converted)
        if pcmFirstSampleWallClockUtcMs == nil {
          // ENF anchor: the absolute wall-clock time of the first audio sample
          // written to the master. The source buffer's PTS is mach-clock host
          // seconds, the same clock the session's video PTS and the sensor ring
          // ride, so the host-to-wall conversion is one subtraction: wall clock
          // now minus how long ago the source buffer's PTS was. Written frames
          // trail the source PTS by the converter's SRC delay line (single-digit
          // ms), and the anchor is labeled 'source-pts'.
          let nowHostSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
          let nowMs = currentEpochMs()
          let ptsSec = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
          if ptsSec.isFinite {
            pcmFirstSampleWallClockUtcMs = nowMs - Int64(((nowHostSec - ptsSec) * 1000.0).rounded())
            pcmAnchorSource = "source-pts"
          } else {
            // PTS invalid: the append instant is the anchor, labeled as such.
            pcmFirstSampleWallClockUtcMs = nowMs
            pcmAnchorSource = "append-instant"
          }
        }
      }
    } catch {
      pcmWriter.markFailed()
      sendError(ExhibitCameraErrorCode.sink, "PCM master append failed: \(error.localizedDescription)")
    }
  }

  /// Container facts read back from the finalized CAF: the desc ASBD fields and
  /// the frame count its payload implies, committed with the record as
  /// framesMatchContainer so a divergence from framesWritten is visible in the
  /// sealed data. Pure container walk, no decode.
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
    var payloadBytes: Int? = nil
    while off + 12 <= data.count {
      let t0 = data[off], t1 = data[off + 1], t2 = data[off + 2], t3 = data[off + 3]
      let hi = be32(off + 4)
      let lo = be32(off + 8)
      // A size of -1 (0xFFFFFFFF) means "to end of file" per the CAF spec.
      let size = (hi == 0 && lo != 0xffffffff) ? Int(lo) : data.count - (off + 12)
      let body = off + 12
      if t0 == 0x64, t1 == 0x65, t2 == 0x73, t3 == 0x63, body + 36 <= data.count { // 'desc'
        var rateBits: UInt64 = 0
        for i in 0..<8 { rateBits = (rateBits << 8) | UInt64(data[body + i]) }
        sampleRate = Double(bitPattern: rateBits)
        flags = be32(body + 12)
        bytesPerFrame = be32(body + 24)
        channels = be32(body + 28)
        bits = be32(body + 32)
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
      "containerPayloadBytes": payload,
      "containerFrames": frameBytes > 0 ? payload / frameBytes : 0,
    ]
  }

  private func handleAudioSample(_ sampleBuffer: CMSampleBuffer) {
    guard mode == .video else { return }
    // Tap-alive counter: pcmEnabled with this at 0 for a whole take means the
    // audio tap never delivered, stated at stop.
    audioBufferCount += 1
    teeToPcmMaster(sampleBuffer)
    guard let writer = writer, !writerFailed else { return }

    if writerAudioInput == nil, !writerStarted {
      guard let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) else { return }
      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)
      let sampleRate = asbd?.pointee.mSampleRate ?? 44_100
      let channels = asbd?.pointee.mChannelsPerFrame ?? 1
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: NSNumber(value: sampleRate),
          AVNumberOfChannelsKey: NSNumber(value: channels),
          AVEncoderBitRateKey: NSNumber(value: 128_000),
        ],
        sourceFormatHint: formatDesc
      )
      input.expectsMediaDataInRealTime = true
      guard writer.canAdd(input) else {
        writerFailed = true
        sendError(ExhibitCameraErrorCode.writer, "Asset writer rejected the audio input: \(writer.error?.localizedDescription ?? "unknown")")
        return
      }
      writer.add(input)
      writerAudioInput = input
      writerAudioFirstPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
    }

    if !writerStarted {
      maybeStartWriter()
      return
    }

    // writerAudioInput == nil after start means the audio-absent fallback
    // fired; drop late audio and stopVideo reports audioTrack:false.
    guard writer.status == .writing, let input = writerAudioInput, input.isReadyForMoreMediaData else { return }
    if !input.append(sampleBuffer), writer.status == .failed {
      writerFailed = true
      sendError(ExhibitCameraErrorCode.writer, "Asset writer audio append failed: \(writer.error?.localizedDescription ?? "unknown")")
    }
  }

  private func maybeStartWriter() {
    guard !writerStarted, !writerFailed,
          writerVideoInput != nil, writerAudioInput != nil,
          let videoPTS = writerVideoFirstPTS, let audioPTS = writerAudioFirstPTS else { return }
    let startPTS = CMTimeCompare(videoPTS, audioPTS) <= 0 ? videoPTS : audioPTS
    startWriterSession(at: startPTS)
  }

  /// Dead mic must not kill delivery (rule 4): video-only start ~500 ms after
  /// the first video frame, stated as audioTrack:false at stop.
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
      sendError(ExhibitCameraErrorCode.writer, "Asset writer failed to start: \(writer.error?.localizedDescription ?? "unknown")")
      return
    }
    writer.startSession(atSourceTime: pts)
    writerStarted = true
  }

  /// Periodic stereo pairs rather than continuous (spec §8), for thermal and
  /// power headroom. Missed cadence is counted and committed at stop as
  /// pairsMissed.
  private func maybeDumpPeriodicPair(force: Bool = false) {
    guard stereoActive, let evidenceDir = evidenceDirURL, let pair = latestPair else { return }
    let interval = ProcessInfo.processInfo.thermalState == .serious
      ? pairIntervalSec * 2.0   // thermal escalation halves cadence (spec §6)
      : pairIntervalSec
    // `force` is the stop-time dump: the record-end anchor commits even when
    // the last periodic dump landed inside the cadence window.
    guard force || Date().timeIntervalSince(lastPairDumpAt) >= interval else { return }
    lastPairDumpAt = Date()

    guard pair.secondary != nil else {
      pairsMissed += 1
      return
    }

    let index = pairIndex
    pairIndex += 1
    // Built on sessionQueue: it reads sessionQueue-confined calibration state
    // and is dictionary assembly only, no encoding.
    let calibrationDict = buildCalibrationDict(pair: pair)

    // Encode and write on sinkIOQueue: a 720p JPEG encode plus two file writes
    // can exceed a frame interval and would drop pairs on sessionQueue.
    sinkIOQueue.async { [weak self] in
      guard let self = self else { return }
      guard let secondary = pair.secondary,
            let secondaryBuffer = CMSampleBufferGetImageBuffer(secondary) else {
        self.sessionQueue.async { self.pairsMissed += 1 }
        return
      }

      let pairsDir = evidenceDir.appendingPathComponent("pairs", isDirectory: true)
      let base = "pair-\(String(format: "%04d", index))"

      var secondaryPath: String? = nil
      if let (data, _) = self.downsampledJPEG(from: secondaryBuffer, targetBytes: 200_000) {
        let url = pairsDir.appendingPathComponent("\(base)-secondary.jpg")
        do {
          try FileManager.default.createDirectory(at: pairsDir, withIntermediateDirectories: true)
          try data.write(to: url, options: .atomic)
          secondaryPath = url.path
        } catch {
          self.sendError(ExhibitCameraErrorCode.sink, "Pair \(index) secondary write failed: \(error.localizedDescription)")
        }
      }

      let calibrationURL = pairsDir.appendingPathComponent("\(base)-calibration.json")
      var calibrationPath: String? = nil
      do {
        try CalibrationSerializer.writeJSON(calibrationDict, to: calibrationURL)
        calibrationPath = calibrationURL.path
      } catch {
        self.sendError(ExhibitCameraErrorCode.sink, "Pair \(index) calibration write failed: \(error.localizedDescription)")
      }

      let primaryPTS = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(pair.primary))
      self.sendEvent("onStereoPairCaptured", [
        "index": index,
        "secondaryPath": secondaryPath as Any? ?? NSNull(),
        "calibrationPath": calibrationPath as Any? ?? NSNull(),
        "primaryHostSeconds": primaryPTS.isFinite ? primaryPTS : NSNull(),
        "synchronizedDeltaMs": pair.deltaMs as Any? ?? NSNull(),
      ])
    }
  }

  /// Stops video, finalizes the delivery file, and returns to preview mode on
  /// the same session; the video-only audio input and output are removed.
  /// Idempotent: a second stop while the seal is in flight joins the in-flight
  /// stop and settles with the same outcome. The seal is asynchronous and never
  /// blocks the state machine; the 10 s watchdog guarantees settlement.
  func stopVideo(promise: Promise) {
    switch videoState {
    case .idle:
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No video is recording"))
      return
    case .stopping:
      stopWaiters.append(promise)
      return
    case .recording:
      break
    }
    guard let writer = writer else {
      // State said recording but the writer is gone.
      videoState = .idle
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No video is recording"))
      return
    }
    videoState = .stopping

    audioHandler.onAudio = nil
    let durationMs = videoStartDate.map { Int((Date().timeIntervalSince($0) * 1000.0).rounded()) } ?? 0
    let audioTrack = writerAudioInput != nil && writerStarted
    let deliveryPath = deliveryURL?.path ?? ""
    // Record-end anchor: force one final pair dump before the counts are read.
    // The encode and write ride sinkIOQueue like every periodic dump.
    maybeDumpPeriodicPair(force: true)
    let pairs = pairIndex
    let missed = pairsMissed

    // PCM sink finalize: drain the SRC delay line, close the CAF, fold into the
    // three-state vocabulary. A zero-frame master reports through the failed
    // path (null), not as a recorded file. The disabled case never reaches here:
    // JS owns the toggle and states 'never-recorded' itself.
    var rawPcmPath: String? = nil
    // ENF anchor and integrity summary, exposed as rawPcmInfo in the stop
    // payload whenever the master commits. The anchor lets the desk
    // cross-correlate the 50/60 Hz mains trace against a reference ENF series
    // in absolute time; the sha256 binds that analysis to the committed bytes.
    var rawPcmInfo: [String: Any]? = nil
    if pcmEnabled, let pcmWriter = pcmWriter, !pcmWriter.failed {
      do {
        if let tail = try pcmConverter?.drain() {
          try pcmWriter.append(pcmBuffer: tail)
        }
      } catch {
        pcmWriter.markFailed()
        sendError(ExhibitCameraErrorCode.sink, "PCM master drain failed: \(error.localizedDescription)")
      }
      pcmWriter.finish()
      if !pcmWriter.failed && pcmWriter.framesWritten > 0 {
        rawPcmPath = pcmWriter.url.path
        // finish() finalized the CAF header (AVAudioFile deinit semantics), so
        // the bytes hashed here are the committed bytes.
        var sha: String? = nil
        if let bytes = try? Data(contentsOf: pcmWriter.url) {
          sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
        // Explicit locals: the ternary + `as Any? ?? NSNull()` idiom parses the
        // cast onto the ternary's String? and the compiler rejects
        // String? ?? NSNull.
        let anchorSource: String? = pcmAnchorSource.isEmpty ? nil : pcmAnchorSource
        rawPcmInfo = [
          "firstSampleWallClockUtcMs": (pcmFirstSampleWallClockUtcMs as Any?) ?? NSNull(),
          "firstSampleAnchor": (anchorSource as Any?) ?? NSNull(),
          "sampleCount": Int(pcmWriter.framesWritten),
          "sampleRate": Int(PcmMasterWriter.sampleRate),
          "fileSha256": (sha as Any?) ?? NSNull(),
        ]
        // Commit the container's own readback alongside the writer's counters,
        // so a divergence is a fact in the sealed record.
        if var info = rawPcmInfo, let facts = cafContainerFacts(pcmWriter.url) {
          for (key, value) in facts { info[key] = value }
          info["framesMatchContainer"] = (facts["containerFrames"] as? Int) == Int(pcmWriter.framesWritten)
          rawPcmInfo = info
        }
      }
    }
    // Distinguish why the master is absent: requested, but the audio tap
    // delivered nothing all take, is a tap problem, not a conversion problem.
    if pcmEnabled, audioBufferCount == 0 {
      // State the audio connection's liveness to discriminate "no connection"
      // from "connection live, no buffers", which points at the audio session
      // rather than the graph.
      let audioConnState: String
      if let liveAudioOutput = audioOutput, let connection = liveAudioOutput.connection(with: .audio) {
        audioConnState = "enabled=\(connection.isEnabled),active=\(connection.isActive)"
      } else {
        audioConnState = "none"
      }
      sendError(
        ExhibitCameraErrorCode.sink,
        "Raw audio master: the audio tap delivered zero buffers during the take (audioConn=\(audioConnState); audio-session configuration or mic permission suspect) — master not recorded"
      )
    }
    pcmWriter = nil
    pcmConverter = nil
    pcmEnabled = false

    // IMU sink finalize: slice the recording window [videoSensorStartBootSec,
    // now] from the ring, written next to the PCM master
    // (sensors-<sessionId>.jsonl). A recording longer than the 60 s ring span
    // commits its tail with truncated:true in the file's window line. Same
    // three-state vocabulary as the still path; a failed log never blocks the
    // stop. The logger keeps running after the take; only teardown or thermal
    // stops it.
    var sensorFields = sensorLogFields(state: "unavailable")
    if sensorLogWanted, !sensorLogThermalStopped, let logger = sensorLogger, let evidenceDir = evidenceDirURL {
      sensorFields = sensorWindowFields(
        url: evidenceDir.appendingPathComponent("sensors-\(sessionId).jsonl"),
        from: videoSensorStartBootSec,
        to: ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks()),
        anchorStartedAtMs: videoStartEpochMs,
        // The anchor binds the recording start's instant to its wall clock, not
        // the flush instant; the video motion card re-zeroes on it.
        anchorBootSec: videoSensorStartBootSec,
        logger: logger
      )
    }

    // Remove the video-only audio nodes; the session keeps running.
    if let session = session {
      session.beginConfiguration()
      if let audioOutput = audioOutput {
        audioOutput.setSampleBufferDelegate(nil, queue: nil)
        session.removeOutput(audioOutput)
      }
      if let audioInput = audioInput {
        session.removeInput(audioInput)
      }
      session.commitConfiguration()
    }
    audioInput = nil
    audioOutput = nil
    mode = .preview

    // Stop watchdog (spec §6): a hung finishWriting must not hang JS. It
    // settles through the same single path as the seal — a queued start is
    // released here too, so a start behind a hung seal waits at most 10 s.
    stopPromise = promise
    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.settleVideoStop(
        writer: writer,
        outcome: .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.writer, "Delivery finalize timed out after 10s; file state unknown"))
      )
    }
    stopTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: timeout)

    guard writerStarted, !writerFailed else {
      settleVideoStop(
        writer: writer,
        outcome: .failure(ExhibitCameraNamedException(
          ExhibitCameraErrorCode.writer,
          writerFailed ? "Delivery writer failed during capture" : "No frames were captured; there is no delivery file to commit"
        ))
      )
      return
    }

    writerVideoInput?.markAsFinished()
    writerAudioInput?.markAsFinished()
    writer.finishWriting {
      // finishWriting's callback fires on an internal writer queue, so hop.
      // Settlement is a single sessionQueue hop with no I/O, so the seal never
      // blocks the state machine.
      self.sessionQueue.async {
        if writer.status == .completed {
          var payload: [String: Any] = [
            "deliveryPath": deliveryPath,
            "durationMs": durationMs,
            // Structural audio absence is stated explicitly (rules 3/4).
            "audioTrack": audioTrack,
            "pairsCommitted": pairs,
            "pairsMissed": missed,
            // Three-state raw-audio sink: a path string means recorded, null
            // means enabled but failed. JS owns the toggle and states
            // 'never-recorded' for the disabled case.
            "rawPcmPath": rawPcmPath as Any? ?? NSNull(),
            // ENF anchor and integrity summary for the committed master, plus
            // the tap-alive counter.
            "rawPcmInfo": rawPcmInfo as Any? ?? NSNull(),
            "audioBufferCount": self.audioBufferCount,
            "hardwareCost": self.session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
          ]
          // IMU sink fields, computed above on sessionQueue before the
          // finishWriting hop: sensorLogPath, sensorLogState, and
          // sensorLogError only when 'failed'.
          for (key, value) in sensorFields { payload[key] = value }
          self.settleVideoStop(writer: writer, outcome: .success(payload))
        } else {
          let message = writer.error?.localizedDescription ?? "writer did not complete"
          self.settleVideoStop(writer: writer, outcome: .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.writer, "Delivery finalize failed: \(message)")))
        }
      }
    }
  }

  /// The single stop-settlement path: resolves or rejects the stop promise and
  /// every joined waiter with the same outcome, tears down writer state, returns
  /// the machine to .idle, and releases a queued startVideo. sessionQueue only.
  /// The identity guard keeps a stale finishWriting or timeout from a previous
  /// writer from touching a new recording's state.
  private func settleVideoStop(
    writer: AVAssetWriter,
    outcome: Result<[String: Any], ExhibitCameraNamedException>
  ) {
    guard self.writer === writer else { return }
    stopTimeout?.cancel()
    stopTimeout = nil
    let pending = stopPromise
    stopPromise = nil
    let waiters = stopWaiters
    stopWaiters.removeAll()
    self.writer = nil
    writerVideoInput = nil
    writerAudioInput = nil
    videoState = .idle
    switch outcome {
    case .success(let payload):
      pending?.resolve(payload)
      for waiter in waiters { waiter.resolve(payload) }
    case .failure(let error):
      pending?.reject(error)
      for waiter in waiters { waiter.reject(error) }
    }
    flushPendingStartVideo()
  }

  /// Runs a startVideo that queued behind the just-settled stop, if any.
  /// sessionQueue only. Re-enters startVideo so every guard and rejection of
  /// the normal path applies.
  private func flushPendingStartVideo() {
    guard videoState == .idle, let pending = pendingStartVideo else { return }
    pendingStartVideo = nil
    startVideo(opts: pending.opts, promise: pending.promise)
  }

  /// Orientation contract: apply this transform only to a connection whose
  /// rotation is metadata-only (an output that tags orientation without
  /// touching pixels, e.g. a movie-file output). AVCaptureVideoDataOutput
  /// connections physically rotate their delivered buffers, so stamping this on
  /// a writer input that consumes them rotates twice and plays back sideways.
  ///
  /// No call sites: every writer and sink here consumes physically rotated
  /// buffers and uses .identity. Before adding a call site, prove the
  /// connection does not physically rotate.
  private func videoRotationTransform(for connection: AVCaptureConnection) -> CGAffineTransform {
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
}

// MARK: - Chrome (spec §3): all sessionQueue, all clamped, all no-ops with a reason

extension ExhibitCameraModule {

  /// Lens switch on the running session: swap the primary input, then re-derive
  /// the stereo partner around it. Two atomic configurations: (1) detach the
  /// partner if it conflicts and swap the primary, (2) best-effort re-attach the
  /// re-derived partner. A session can never hold two inputs for one device, so
  /// a requested lens already plumbed as the partner must leave first. Failure
  /// at (1) restores the old primary and its partner; failure at (2) is a
  /// single-cam session, stated in the resolve payload.
  func setLens(_ lens: ExhibitLens, promise: Promise?) {
    guard let session = session, facing == .back else {
      promise?.resolve(["applied": false, "reason": "no-session-or-front-facing"])
      return
    }
    // On the virtual graph the primary is the dual-wide virtual device: wide
    // and ultra-wide are both live, so a "wide" request is already satisfied
    // and any other primary-lens swap would tear down the working pair. The
    // ultra-wide view is the 0.5x zoom stop on the same graph.
    if virtualGraphActive {
      if lens == .wide {
        promise?.resolve(["applied": true, "reason": "already-selected"])
      } else {
        promise?.resolve(["applied": false, "reason": "both lenses are live — zoom to 0.5x for the ultra-wide view"])
      }
      return
    }
    guard let current = primaryDevice, current.deviceType != lens.deviceType else {
      promise?.resolve(["applied": true, "reason": "already-selected"])
      return
    }
    guard let newDevice = AVCaptureDevice.default(lens.deviceType, for: .video, position: .back) else {
      // Requested lens not present on this hardware.
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Lens \(lens.rawValue) is not available on this device"))
      return
    }
    do {
      let newInput = try AVCaptureDeviceInput(device: newDevice)
      let oldInput = primaryInput
      let oldDevice = current
      // A device plumbed as the stereo partner must leave the session before it
      // can become the primary; duplicate-device inputs are illegal.
      let partnerConflict = secondaryDevice?.deviceType == newDevice.deviceType
      // Rollback helper: put the old partner back and rebind the synchronizer
      // to the restored topology. A synchronizer left pointing at a removed
      // output stalls the whole frame pipeline.
      let restorePartner: () -> Void = { [weak self] in
        guard let self = self, partnerConflict else { return }
        _ = self.ensureStereoPartner(excluding: oldDevice.deviceType)
        self.rebuildSynchronizer()
      }
      session.beginConfiguration()
      if partnerConflict {
        detachSecondaryPipeline(in: session)
      }
      if let oldInput = oldInput { session.removeInput(oldInput) }
      guard session.canAddInput(newInput) else {
        session.commitConfiguration()
        restorePartner()
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot add input for lens \(lens.rawValue)")
      }
      session.addInput(newInput)
      // The 30 fps billing promise follows the new input: adding an input
      // resets the override, so a mid-session lens swap would otherwise return
      // to worst-case billing.
      newInput.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
      // requireMultiCam mirrors configureSession: with stereo on, the new
      // primary's format must be multi-cam-legal so the partner re-attach after
      // this swap can stream.
      if configureFormat(device: newDevice, maxWidth: 3840, maxHeight: 2160, requireMultiCam: stereoActive) == false {
        // Roll back: restore the old primary and its partner.
        session.removeInput(newInput)
        if let oldInput = oldInput, session.canAddInput(oldInput) {
          session.addInput(oldInput)
        }
        session.commitConfiguration()
        restorePartner()
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No usable format for lens \(lens.rawValue)")
      }
      session.commitConfiguration()
      guard session.hardwareCost <= 1.0 else {
        // Roll back a configuration the OS would throttle (spec §6).
        session.beginConfiguration()
        session.removeInput(newInput)
        if let oldInput = oldInput, session.canAddInput(oldInput) {
          session.addInput(oldInput)
        }
        session.commitConfiguration()
        restorePartner()
        throw ExhibitCameraNamedException(ExhibitCameraErrorCode.hardwareCost, "Lens \(lens.rawValue) exceeds the hardware budget; kept the previous lens")
      }
      primaryInput = newInput
      primaryDevice = newDevice
      currentFormatID = formatID(for: newDevice)
      // The input swap recreates the outputs' connections, so re-apply the
      // rotation, mirroring, and per-frame intrinsics policies.
      if let primaryOut = primaryVideoOutput { applyConnectionPolicies(to: primaryOut, device: newDevice) }
      if #available(iOS 17.0, *), let photoConnection = primaryPhotoOutput?.connection(with: .video) {
        // photoConnectionRotation defaults off; portrait otherwise.
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: photoConnection, device: newDevice)
        } else if photoConnection.isVideoOrientationSupported {
          photoConnection.videoOrientation = .portrait
        }
      }
      // Re-derive the partner around the new primary. When the swap consumed
      // the old partner this restores stereo; when the attach fails the payload
      // says single-cam.
      let stereoNote: String
      if stereoDetachedForThermal {
        stereoNote = "degraded-thermal"
      } else {
        stereoNote = ensureStereoPartner(excluding: newDevice.deviceType) ? "available" : "unsupported"
      }
      // The synchronizer cannot track topology changes; recreate it over the
      // current outputs after any swap, detach, or attach.
      rebuildSynchronizer()
      promise?.resolve([
        "applied": true,
        "lens": lens.rawValue,
        "stereo": stereoNote,
        "hardwareCost": Double(session.hardwareCost),
      ])
    } catch let e as ExhibitCameraNamedException {
      promise?.reject(e)
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Lens switch failed: \(error.localizedDescription)"))
    }
  }

  /// Removes the secondary input and outputs inside an open configuration (the
  /// caller holds beginConfiguration) and drops the PiP connection with them.
  /// The synchronizer is untouched here; callers rebuild it after the commit.
  /// Shared by the lens swap and the thermal detach.
  private func detachSecondaryPipeline(in session: AVCaptureMultiCamSession) {
    teardownPipConnection(in: session)
    if let secondaryOut = secondaryVideoOutput { session.removeOutput(secondaryOut) }
    if let secondaryPhoto = secondaryPhotoOutput { session.removeOutput(secondaryPhoto) }
    if let sInput = secondaryInput { session.removeInput(sInput) }
    secondaryVideoOutput = nil
    secondaryPhotoOutput = nil
    secondaryInput = nil
    secondaryDevice = nil
    stereoActive = false
  }

  /// Best-effort stereo partner attach around the current primary: the same
  /// plumbing as configureSession's secondary block, factored so a lens swap
  /// can re-pair. Owns its begin/commit; failures return false for single-cam
  /// rather than throwing. Over-budget graphs are refused (spec §6).
  @discardableResult
  private func ensureStereoPartner(excluding primaryType: AVCaptureDevice.DeviceType) -> Bool {
    guard let session = session, facing == .back else { return false }
    if stereoActive, secondaryDevice != nil { return true } // already paired
    // On the virtual graph the pair is inherent to the single input, so there
    // is no partner device to attach; a thermal detach re-wires fresh outputs
    // to the UW constituent port. The partner preference does not apply: the
    // virtual pair is fixed wide + ultra-wide.
    if virtualGraphActive {
      guard secondaryLensPreference == nil || secondaryLensPreference == .ultraWide else {
        logDiagnosticEvent("stereo partner attach refused on the virtual graph: fixed wide+ultra-wide pair, preference not applicable")
        return false
      }
      guard let vInput = primaryInput, let port = virtualSecondaryPort else { return false }
      let constituent = vInput.device.constituentDevices.first(where: { $0.deviceType == .builtInUltraWideCamera })
      session.beginConfiguration()
      let out = AVCaptureVideoDataOutput()
      // Native format; see configureSession's primary output.
      out.alwaysDiscardsLateVideoFrames = true
      let videoOK = wireOutput(out, to: vInput, port: port, mediaType: .video, in: session, label: "partner-video") != nil
      // No partner photo output; see configureSession.
      session.commitConfiguration()
      guard videoOK else {
        logDiagnosticEvent("stereo partner attach FAILED on the virtual graph: UW port would not re-wire (see wire refusal above)")
        return false
      }
      secondaryDevice = constituent
      secondaryVideoOutput = out
      secondaryPhotoOutput = nil // none is attached; see configureSession
      stereoActive = true
      if let constituent = constituent {
        applyConnectionPolicies(to: out, device: constituent)
      }
      ensurePipConnection(in: session)
      logDiagnosticEvent("stereo partner attached on the virtual graph: UW constituent port census=\(connectionCensus())")
      return true
    }
    // Honor the selectable secondary stack; 'auto' is the UW/W-T pairing.
    let partnerType = partnerDeviceType(for: primaryType)
    guard let partner = AVCaptureDevice.default(partnerType, for: .video, position: .back),
          let input = try? AVCaptureDeviceInput(device: partner) else {
      logDiagnosticEvent("stereo partner attach FAILED: no \(partnerType.rawValue) device or input creation threw")
      return false
    }
    session.beginConfiguration()
    guard session.canAddInput(input),
          configureFormat(device: partner, maxWidth: 1920, maxHeight: 1080, requireMultiCam: true) else {
      session.commitConfiguration()
      // configureFormat logs its own failure; this states a canAddInput
      // refusal, which would otherwise be silent.
      logDiagnosticEvent("stereo partner attach FAILED: canAddInput=\(session.canAddInput(input)) (see format log lines)")
      return false
    }
    // Explicit multi-cam wiring; see wireOutput.
    session.addInputWithNoConnections(input)
    // The 30 fps billing promise on the partner too. Set after the add, which
    // resets the override.
    input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
    let out = AVCaptureVideoDataOutput()
    // Native format; see configureSession's primary output.
    out.alwaysDiscardsLateVideoFrames = true
    guard wireOutput(out, to: input, mediaType: .video, in: session, label: "partner-video") != nil else {
      session.removeInput(input)
      session.commitConfiguration()
      return false
    }
    // No partner photo output; see configureSession.
    session.commitConfiguration()
    guard session.hardwareCost <= 1.0 else {
      session.beginConfiguration()
      session.removeOutput(out)
      session.removeInput(input)
      session.commitConfiguration()
      logDiagnosticEvent("stereo partner attach REFUSED: hardwareCost over budget after attach; rolled back to single-cam")
      return false
    }
    secondaryInput = input
    secondaryDevice = partner
    secondaryVideoOutput = out
    secondaryPhotoOutput = nil // none is attached; see configureSession
    stereoActive = true
    applyConnectionPolicies(to: out, device: partner)
    ensurePipConnection(in: session)
    // A mid-session partner takes the primary's current AE/AWB/AF state
    // instead of factory defaults.
    mirrorProControlsToSecondary()
    logDiagnosticEvent("stereo partner attached: device=\(partner.deviceType.rawValue) census=\(connectionCensus())")
    return true
  }

  /// Rotation + mirroring + per-frame intrinsics on an output's video
  /// connection — the same policies configureSession applies at start.
  /// Connections are recreated whenever inputs change, so this re-runs
  /// after every swap. The device comes from the caller (connections are
  /// recreated with their inputs; the port-to-device walk is lossy).
  private func applyConnectionPolicies(to out: AVCaptureVideoDataOutput, device: AVCaptureDevice) {
    guard let connection = out.connection(with: .video) else { return }
    if connection.isCameraIntrinsicMatrixDeliverySupported {
      connection.isCameraIntrinsicMatrixDeliveryEnabled = true
    }
    if #available(iOS 17.0, *) {
      RotationPolicy.apply(to: connection, device: device)
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
  }

  /// The synchronizer cannot track output topology changes; recreate it over
  /// the current outputs after any swap, detach, or attach. No session
  /// reconfiguration.
  private func rebuildSynchronizer() {
    let outputs: [AVCaptureOutput] = [primaryVideoOutput, secondaryVideoOutput].compactMap { $0 }
    guard !outputs.isEmpty else { return }
    let sync = AVCaptureDataOutputSynchronizer(dataOutputs: outputs)
    sync.setDelegate(syncHandler, queue: sessionQueue)
    synchronizer = sync
  }

  /// Rung 2 for a chronic secondary-half flood: the 150-drop rebind cannot
  /// resurrect a stream the platform has parked, so remove and re-add the
  /// secondary video data output for a fresh connection and buffer pool without
  /// touching the input or the photo output. Once per session, never
  /// mid-recording or mid-capture. Whether it worked shows in the counters
  /// (completePairCount climbing) in the next degraded reason or stall event.
  private func reseatSecondaryVideoOutput() {
    guard let session = session, stereoActive, secondaryVideoOutput != nil,
          mode != .video, !captureInFlight, !calibrationCaptureInFlight else { return }
    let newOut = AVCaptureVideoDataOutput()
    // Native format; see configureSession's primary output.
    newOut.alwaysDiscardsLateVideoFrames = true
    session.beginConfiguration()
    // The old output holds the secondary port's video-data-output slot and must
    // be removed before the new one can connect; same-type fan-out from one
    // camera is forbidden. Explicit wiring, see wireOutput.
    if let oldOut = secondaryVideoOutput { session.removeOutput(oldOut) }
    var rewired = false
    // The virtual graph re-wires to the UW constituent port on the single
    // input; the multi-input graph re-wires to the secondary input.
    if virtualGraphActive, let port = virtualSecondaryPort, let vInput = primaryInput {
      rewired = wireOutput(newOut, to: vInput, port: port, mediaType: .video, in: session, label: "secondary-video-reseat") != nil
    } else if let sInput = secondaryInput {
      rewired = wireOutput(newOut, to: sInput, mediaType: .video, in: session, label: "secondary-video-reseat") != nil
    }
    session.commitConfiguration()
    guard rewired else {
      // Could not re-wire: the secondary video pipeline is detached and
      // stated; captures degrade via the E_STALE_PAIR path.
      secondaryVideoOutput = nil
      rebuildSynchronizer()
      logDiagnosticEvent("secondary reseat FAILED: detached for this session; census=\(connectionCensus())")
      sendError(
        ExhibitCameraErrorCode.platform,
        "Secondary video output reseat failed: no live connection after re-add — secondary stream detached for this session"
      )
      return
    }
    secondaryVideoOutput = newOut
    if let device = secondaryDevice {
      applyConnectionPolicies(to: newOut, device: device)
    }
    rebuildSynchronizer()
    logDiagnosticEvent("secondary reseat OK: census=\(connectionCensus())")
  }

  /// Live secondary-stack apply on a running back session: detach the current
  /// secondary pipeline and re-pair around the current primary with the new
  /// preference. A nil preference ('auto') restores the UW/W-T pairing. A
  /// preference equal to the primary lens resolves applied:false with a
  /// reason.
  func setSecondaryLens(_ lens: ExhibitLens?, promise: Promise?) {
    secondaryLensPreference = lens
    let prefValue: Any = lens?.rawValue ?? "auto"
    guard let session = session, facing == .back else {
      promise?.resolve([
        "applied": true,
        "secondaryLens": prefValue,
        "note": "preference stored; applies at the next configureSession (no running back session)",
      ])
      return
    }
    if stereoDetachedForThermal {
      promise?.resolve([
        "applied": true,
        "secondaryLens": prefValue,
        "note": "stereo detached for thermal pressure; the preference applies when stereo re-attaches",
      ])
      return
    }
    if let primary = primaryDevice, lens?.deviceType == primary.deviceType {
      promise?.resolve([
        "applied": false,
        "reason": "conflicts-with-primary-lens",
        "secondaryLens": NSNull(),
      ])
      return
    }
    session.beginConfiguration()
    detachSecondaryPipeline(in: session)
    session.commitConfiguration()
    let attached = ensureStereoPartner(excluding: primaryDevice?.deviceType ?? .builtInWideAngleCamera)
    rebuildSynchronizer()
    promise?.resolve([
      "applied": true,
      "secondaryLens": prefValue,
      "secondaryLensApplied": (secondaryDevice?.deviceType.rawValue as Any?) ?? NSNull(),
      "stereo": attached ? "available" : "unsupported",
      "hardwareCost": Double(session.hardwareCost),
    ])
  }

  /// Front/back flip: front is single-cam (spec §3). Implemented as a session
  /// rebuild rather than re-plumbing, still guarded by the 10 s first-frame
  /// watchdog. JS re-invokes configureSession with the new facing; this
  /// function only validates.
  func setFacing(_ newFacing: ExhibitFacing, promise: Promise?) {
    promise?.resolve([
      "applied": false,
      "reason": "rebuild-required",
      "note": "flip by re-invoking configureSession with facing:'\(newFacing.rawValue)'; front is single-cam, stated",
    ])
  }

  /// Full-sensor stills: cap the photo output at its largest supported
  /// dimensions (iOS 16+; older OSes keep the format default and the committed
  /// dimensions say what arrived). Set once at addOutput time, inside the
  /// session's begin/commit discipline. supportedMaxPhotoDimensions belongs to
  /// the device's active format, not the photo output, so the device is passed
  /// in from each creation site. The "largest" pick is an explicit loop because
  /// a chained max(by:) closure hits the type-checker's time limit.
  private func applyFullResPhotoPolicy(to output: AVCapturePhotoOutput, device: AVCaptureDevice) {
    if #available(iOS 16.0, *) {
      // Cap at 12 MP class. The session reserves bandwidth and ISP for the
      // configured photo stream, and a 48 MP reservation on a live multi-cam
      // graph starves the video streams and can make every photo capture fail
      // with "Cannot Record". The committed fullResStillDimensions state what
      // arrived.
      let maxArea = 12_600_000 // 4032×3024 class
      let supported = device.activeFormat.supportedMaxPhotoDimensions
      var best: CMVideoDimensions? = nil
      var bestArea = 0
      for dims in supported {
        // width/height are Int32; promote to Int before multiplying so a 12 MP
        // sensor cannot overflow the comparison.
        let area = Int(dims.width) * Int(dims.height)
        if area > bestArea, area <= maxArea {
          best = dims
          bestArea = area
        }
      }
      if let best = best {
        // On by default; the flag is the escape hatch (see ExhibitDebugFlags).
        if ExhibitDebugFlags.photoMaxDimensionsPolicy {
          output.maxPhotoDimensions = best
        }
      }
      // Nothing under the cap: leave the format default; the committed
      // dimensions say what it is.
    }

    // AVCapturePhotoSettings.isDepthDataDeliveryEnabled throws an uncatchable
    // NSException unless the output's own isDepthDataDeliveryEnabled is already
    // true, so enable output-level delivery here at addOutput time, inside the
    // begin/commit discipline, when the flag and hardware allow.
    // requestDepthIfHonest keys on that output-level flag. Depth is per-photo
    // processing, not a standing stream reservation, so it costs no multi-cam
    // bandwidth while idle.
    if ExhibitDebugFlags.depthCapture, output.isDepthDataDeliverySupported {
      output.isDepthDataDeliveryEnabled = true
    }
  }

  /// Instant device-zoom set, for lens-jump continuity: a sweep that
  /// crossed an optical stop lands on the new stack's factor immediately.
  /// UI-driven ramps go through setZoomSmooth. Clamped to the device's
  /// supported range.
  func setZoom(_ factor: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // The active format can pin zoom (multi-cam formats whose max == min).
    // Resolve applied:false with the real ceiling so the UI number never claims
    // a factor the hardware did not apply.
    if device.maxAvailableVideoZoomFactor <= device.minAvailableVideoZoomFactor + 0.001 {
      promise?.resolve([
        "applied": false,
        "reason": "format-zoom-locked",
        "maxZoom": Double(device.maxAvailableVideoZoomFactor),
      ])
      return
    }
    do {
      try device.lockForConfiguration()
      let clamped = min(max(CGFloat(factor), device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
      device.videoZoomFactor = clamped
      device.unlockForConfiguration()
      promise?.resolve([
        "applied": true,
        "zoomFactor": Double(clamped),
        "clamped": clamped != CGFloat(factor),
        "maxZoom": Double(device.maxAvailableVideoZoomFactor),
      ])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Zoom failed: \(error.localizedDescription)"))
    }
  }

  /// Ramped device-zoom set: ramp(toVideoZoomFactor:withRate:) for
  /// UI-driven scrub ramps. The rate is clamped to a usable band so a caller
  /// cannot wedge the device at rate 0 or slam it at 1000.
  func setZoomSmooth(_ factor: Double, rate: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // Same zoom-locked-format guard as setZoom.
    if device.maxAvailableVideoZoomFactor <= device.minAvailableVideoZoomFactor + 0.001 {
      promise?.resolve([
        "applied": false,
        "reason": "format-zoom-locked",
        "maxZoom": Double(device.maxAvailableVideoZoomFactor),
      ])
      return
    }
    do {
      try device.lockForConfiguration()
      let clamped = min(max(CGFloat(factor), device.minAvailableVideoZoomFactor), device.maxAvailableVideoZoomFactor)
      let clampedRate = Float(min(max(rate, 1.0), 60.0))
      device.ramp(toVideoZoomFactor: clamped, withRate: clampedRate)
      device.unlockForConfiguration()
      promise?.resolve([
        "applied": true,
        "zoomFactor": Double(clamped),
        "clamped": clamped != CGFloat(factor),
        "rate": Double(clampedRate),
      ])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Zoom ramp failed: \(error.localizedDescription)"))
    }
  }

  /// Photo-strobe preference: stored and written into every full-res
  /// capture's photoSettings at shutter time, validated against the output's
  /// supportedFlashModes there. No device mode is touched, and the preference
  /// survives sessions.
  func setPhotoFlashMode(_ mode: ExhibitPhotoFlash, promise: Promise?) {
    photoFlashPreference = mode
    let device = primaryDevice
    let supported: [String] = primaryPhotoOutput?.supportedFlashModes.map {
      DeviceModeMapper.flashMode($0)
    } ?? []
    promise?.resolve([
      "applied": true,
      "photoFlash": mode.rawValue,
      // An empty supportedModes list means no session yet (unknown), not
      // unsupported.
      "hasFlash": device?.hasFlash ?? false,
      "supportedModes": supported,
      "note": "preference stored; validated against supportedFlashModes at capture time",
    ])
  }

  func setTorch(_ mode: ExhibitTorch, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // Front cameras and devices without torch hardware: stated no-op.
    guard device.hasTorch, device.isTorchAvailable else {
      promise?.resolve(["applied": false, "reason": "torch-unavailable-on-this-device"])
      return
    }
    do {
      try device.lockForConfiguration()
      device.torchMode = (mode == .on) ? .on : .off
      device.unlockForConfiguration()
      promise?.resolve(["applied": true, "torch": mode.rawValue])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Torch failed: \(error.localizedDescription)"))
    }
  }

  /// Tap-to-focus (spec §3): normalized view point to device point of interest.
  /// Focus and exposure move together and both fall back to continuous modes.
  /// An unsupported focus mode is a stated no-op.
  func setFocusPoint(x: Double, y: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // The preview layer converts view to device coordinates: with a
    // landscape-native sensor and portrait preview, device x = view y and
    // device y = 1 − view x.
    let devicePoint = CGPoint(x: CGFloat(y), y: CGFloat(1.0 - x))
    do {
      try device.lockForConfiguration()
      var focusApplied = false
      var exposureApplied = false
      if device.isFocusPointOfInterestSupported {
        device.focusPointOfInterest = devicePoint
        device.focusMode = device.isFocusModeSupported(.autoFocus) ? .autoFocus : .continuousAutoFocus
        focusApplied = true
      }
      if device.isExposurePointOfInterestSupported {
        device.exposurePointOfInterest = devicePoint
        device.exposureMode = device.isExposureModeSupported(.autoExpose) ? .autoExpose : .continuousAutoExposure
        exposureApplied = true
      }
      device.unlockForConfiguration()
      promise?.resolve([
        "applied": focusApplied || exposureApplied,
        "focusApplied": focusApplied,
        "exposureApplied": exposureApplied,
        "devicePoint": ["x": Double(devicePoint.x), "y": Double(devicePoint.y)],
      ])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Focus failed: \(error.localizedDescription)"))
    }
  }

  func setExposureBias(_ bias: Float, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    do {
      try device.lockForConfiguration()
      // Clamp inside the device's reported range; the committed metadata reads
      // back exposureTargetBias, so the applied value is recorded.
      let clamped = min(max(bias, device.minExposureTargetBias), device.maxExposureTargetBias)
      device.setExposureTargetBias(clamped, completionHandler: nil)
      device.unlockForConfiguration()
      // The secondary runs its own AE, so mirror the bias; the mirror clamps to
      // the secondary's own range.
      mirrorProControlsToSecondary()
      promise?.resolve(["applied": true, "exposureBias": Double(clamped), "clamped": clamped != bias])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Exposure bias failed: \(error.localizedDescription)"))
    }
  }
}

// MARK: - Thermal policy (spec §6) + lifecycle

extension ExhibitCameraModule {

  /// serious: pair cadence halves (in maybeDumpPeriodicPair) plus an event.
  /// critical: the secondary is detached, stated; delivery continues. Stereo
  /// re-probes on the next configureSession (spec §6).
  func handleThermalState(_ state: ProcessInfo.ThermalState) {
    switch state {
    case .serious:
      stopSensorLogForThermal()
      sendEvent("onHardwarePressure", [
        "state": "serious",
        "action": "pair-cadence-halved",
        "thermalState": "serious",
      ])
    case .critical:
      stopSensorLogForThermal()
      guard stereoActive, !stereoDetachedForThermal else { return }
      detachSecondaryForThermal()
      sendEvent("onHardwarePressure", [
        "state": "critical",
        "action": "stereo-detached",
        "degraded": "stereo-detached",
        "thermalState": "critical",
      ])
    default:
      break
    }
  }

  /// Removes the secondary input and output and rebuilds the synchronizer over
  /// the primary output alone. The session keeps running single-cam; subsequent
  /// captures report secondary as E_THERMAL, distinct from unsupported
  /// hardware.
  private func detachSecondaryForThermal() {
    guard let session = session else { return }
    session.beginConfiguration()
    detachSecondaryPipeline(in: session)
    session.commitConfiguration()
    rebuildSynchronizer()
    stereoDetachedForThermal = true
  }

  /// Thermal gate for the IMU sink: serious or critical pressure parks the
  /// logger, matching the policy that halves pair cadence and detaches stereo
  /// (spec §6).
  private func sensorLogBlockedByThermal() -> Bool {
    let state = ProcessInfo.processInfo.thermalState
    return state == .serious || state == .critical
  }

  /// IMU sink thermal park: stops the logger and marks the sink
  /// thermal-stopped, so captures report sensorLogState 'unavailable'.
  /// CoreMotion is independent of the capture graph, so this is safe even
  /// mid-calibration one-shot. The logger restarts only on the next
  /// configureSession, which re-reads the toggle.
  private func stopSensorLogForThermal() {
    guard let logger = sensorLogger else { return }
    logger.stop()
    sensorLogger = nil
    sensorLogThermalStopped = true
  }

  /// Stops the session entirely (screen blur or unmount). Safe to call with
  /// nothing running; in-flight video must be finalized first.
  func stopSession(promise: Promise) {
    // Guard the whole recording state machine: tearing down mid-seal orphans
    // the in-flight stop promise and leaks the writer, and a mode==.video check
    // cannot see a stop that is still sealing.
    switch videoState {
    case .recording:
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.busy,
        "Video is recording; call stopVideo first — an unfinished delivery file is worse than a stated rejection"
      ))
      return
    case .stopping:
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.busy,
        "Video is finishing its previous clip; wait for stopVideo to settle — an unfinished delivery file is worse than a stated rejection"
      ))
      return
    case .idle:
      break
    }
    guard session != nil else {
      promise.resolve(["stopped": false, "reason": "no-session"])
      return
    }
    rejectStart(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Session stopped before the first frame"))
    // teardownSession unbinds both preview layers synchronously on this queue
    // before releasing the session, so no separate hop is needed.
    let stopError = teardownSession()
    if let stopError = stopError {
      // The session is torn down either way; the rejection states that the stop
      // itself threw.
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Session stop raised an exception: \(stopError.localizedDescription)"
      ))
      return
    }
    promise.resolve(["stopped": true])
  }

  /// Releases all session state. Idempotent; sessionQueue only. Returns the
  /// error from an NSException-safe stopRunning, nil on a clean stop, so
  /// stopSession can reject instead of crashing the bridge; the error is also
  /// surfaced as a deduped onSessionError event. The return is typed
  /// (any Error)? to match the shim: Swift imports the ObjC nullable-NSError
  /// return that way under the pinned NS_SWIFT_NAME.
  @discardableResult
  private func teardownSession() -> (any Error)? {
    if let observer = runtimeErrorObserver {
      NotificationCenter.default.removeObserver(observer)
      runtimeErrorObserver = nil
    }
    if let observer = thermalObserver {
      NotificationCenter.default.removeObserver(observer)
      thermalObserver = nil
    }
    if let observer = interruptionObserver {
      NotificationCenter.default.removeObserver(observer)
      interruptionObserver = nil
    }
    if let observer = interruptionEndedObserver {
      NotificationCenter.default.removeObserver(observer)
      interruptionEndedObserver = nil
    }
    // The isActive timeline observers die with the session.
    connectionActiveObservers.forEach { $0.invalidate() }
    connectionActiveObservers.removeAll()
    sessionStartWallClock = nil
    syncHandler.onCollection = nil
    audioHandler.onAudio = nil
    audioOutput?.setSampleBufferDelegate(nil, queue: nil)
    let deadSession = session
    if let deadSession = deadSession { teardownPipConnection(in: deadSession) }
    // NSException-safe, idempotent stop: sessionQueue is serial and this is the
    // only teardown path, and a thrown ObjC exception comes back as an NSError
    // instead of reaching the bridge as SIGABRT.
    var stopError: (any Error)? = nil
    if let deadSession = deadSession {
      stopError = ExhibitSessionControl.safelyStop(deadSession)
      if let stopError = stopError {
        sendError(
          ExhibitCameraErrorCode.platform,
          "Session stop raised an exception: \(stopError.localizedDescription)"
        )
      }
    }
    session = nil
    // Unbind both preview layers here, synchronously on sessionQueue, while
    // `deadSession` still holds the session strongly, so no layer is attached
    // when the last reference drops at the end of this function. A layer
    // retains its session: left attached, it can die with the session on a Fig
    // workloop, where the session's dealloc re-enters
    // detachFromFigCaptureSession on its own sync queue and aborts. Deferring
    // the unbind to main also puts setSession: on main, where it can
    // synchronously commit the capture graph and block past the 8 s
    // scene-update watchdog. AVCaptureVideoPreviewLayer serializes session
    // attachment internally on its Fig sync queue, so the setter is safe from
    // any other queue, and from sessionQueue it is ordered against stopRunning
    // above and any begin/commit on this serial queue.
    if deadSession != nil {
      // Module-held PiP ref first, since it survives a view swap; the view's own
      // pipLayer is normally the same object and detach is idempotent.
      pipLayer?.session = nil
      if let view = previewView {
        view.detachPipFromSession()
        view.bind(session: nil)
      }
    }
    sessionId = ""
    primaryDevice = nil
    secondaryDevice = nil
    primaryInput = nil
    secondaryInput = nil
    virtualGraphActive = false
    virtualSecondaryPort = nil
    primaryVideoOutput = nil
    secondaryVideoOutput = nil
    primaryPhotoOutput = nil
    secondaryPhotoOutput = nil
    audioInput = nil
    audioOutput = nil
    synchronizer = nil
    latestPair = nil
    lastCollectionAt = nil
    stallRecovering = false
    stallBounced = false
    stallEscalated = false
    // pipWanted and pipLayer survive a rebuild: the RN altPreview prop handler
    // only refires when the value changes, so clearing them here would leave the
    // inset black after a session rebuild. configureSession's
    // ensurePipConnection reattaches to the same layer.
    pipConnection = nil
    droppedPairCount = 0
    droppedPrimaryCount = 0
    droppedSecondaryHalfCount = 0
    consecutiveSecondaryDrops = 0
    secondaryAbsentCount = 0
    secondaryDroppedCount = 0
    completePairCount = 0
    staleShutterCount = 0
    secondaryReseatDone = false
    stereoActive = false
    stereoDetachedForThermal = false
    // Shutter-burst teardown: drop the ring and abandon any collection. A
    // capture waiting on the burst settles via its own 10 s watchdog.
    burstSinkWanted = false
    burstRing.removeAll()
    burstPostFrames.removeAll()
    burstPostTarget = 0
    lastBurstRetainedAt = nil
    burstContinuation = nil
    burstTimeout?.cancel()
    burstTimeout = nil
    audioBufferCount = 0
    pcmFirstSampleWallClockUtcMs = nil
    pcmAnchorSource = ""
    // secondaryLensPreference survives a rebuild: a stored preference applies
    // at the next configureSession unless that call's opts override it.
    sessionCalibration = [:]
    sessionCalibrationObjects = [:]
    calibrationCaptureInFlight = false
    photoHandlers.removeAll()
    focusObserver?.invalidate()
    focusObserver = nil
    currentFormatID = nil
    configuredFPS = 30.0
    appliedStabilization = "auto"
    appliedHDR = false
    mode = .preview
    writer = nil
    writerVideoInput = nil
    writerAudioInput = nil
    writerStarted = false
    writerFailed = false
    writerVideoFirstPTS = nil
    writerAudioFirstPTS = nil
    writerAudioFallback?.cancel()
    writerAudioFallback = nil
    deliveryURL = nil
    evidenceDirURL = nil
    videoStartDate = nil
    // IMU sink teardown: stop delivery, drop the ring, nil the reference. Safe
    // from sessionQueue: CoreMotion stop plus a lock-confined clear, and the
    // handlers are [weak self].
    sensorLogger?.stop()
    sensorLogger = nil
    sensorLogWanted = false
    sensorLogThermalStopped = false
    videoSensorStartBootSec = 0
    videoStartEpochMs = 0
    pairIndex = 0
    pairsMissed = 0
    captureInFlight = false
    firedErrorCodes.removeAll()
    startTimeout?.cancel()
    startTimeout = nil
    startPromise = nil
    startPromiseDone = false
    stopTimeout?.cancel()
    stopTimeout = nil
    // A stop in flight, or joined to one, must not dangle across a teardown, so
    // reject every outstanding promise. The seal's late finishWriting
    // completion is identity-guarded and becomes a no-op.
    if let pendingStop = stopPromise {
      pendingStop.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.noSession,
        "The camera session stopped while the delivery file was finalizing; file state unknown"
      ))
    }
    stopPromise = nil
    for waiter in stopWaiters {
      waiter.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.noSession,
        "The camera session stopped while the delivery file was finalizing; file state unknown"
      ))
    }
    stopWaiters.removeAll()
    // A queued start must not dangle across a teardown either.
    if let pending = pendingStartVideo {
      pendingStartVideo = nil
      pending.promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.noSession,
        "The camera session stopped before the queued recording could start"
      ))
    }
    videoState = .idle
    return stopError
  }
}

// MARK: - Pro controls (spec §14)
//
// Every setter is sessionQueue-confined and capability-guarded, reports the
// clamps it applied, and no-ops with a stated reason instead of throwing into
// JS when the hardware lacks the capability. The committed metadata reads the
// device back at capture time: these setters are intent, the metadata block is
// the record.

extension ExhibitCameraModule {

  /// { mode: 'auto'|'locked'|'custom', iso?, durationSeconds? }.
  /// 'custom' requires both iso and durationSeconds; each is clamped to the
  /// active format's min/max, not the device's global range, and the clamped
  /// values are reported back as applied.
  func setExposureMode(opts: [String: Any], promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    let mode = opts["mode"] as? String ?? "auto"
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      switch mode {
      case "auto":
        guard device.isExposureModeSupported(.continuousAutoExposure) else {
          promise?.resolve(["applied": false, "reason": "continuous-auto-exposure-unsupported"])
          return
        }
        device.exposureMode = .continuousAutoExposure
        promise?.resolve(["applied": true, "exposureMode": "auto"])
      case "locked":
        guard device.isExposureModeSupported(.locked) else {
          promise?.resolve(["applied": false, "reason": "exposure-lock-unsupported"])
          return
        }
        device.exposureMode = .locked
        promise?.resolve(["applied": true, "exposureMode": "locked"])
      case "custom":
        guard device.isExposureModeSupported(.custom) else {
          promise?.resolve(["applied": false, "reason": "custom-exposure-unsupported"])
          return
        }
        guard let isoNumber = opts["iso"] as? NSNumber,
              let durationNumber = opts["durationSeconds"] as? NSNumber else {
          promise?.resolve(["applied": false, "reason": "custom-requires-iso-and-durationSeconds"])
          return
        }
        let format = device.activeFormat
        // Clamp to the active format's ranges (spec §14).
        let clampedISO = min(max(isoNumber.floatValue, format.minISO), format.maxISO)
        let requestedDuration = CMTime(seconds: durationNumber.doubleValue, preferredTimescale: 1_000_000_000)
        var clampedDuration = requestedDuration
        if CMTimeCompare(clampedDuration, format.minExposureDuration) < 0 {
          clampedDuration = format.minExposureDuration
        }
        if CMTimeCompare(clampedDuration, format.maxExposureDuration) > 0 {
          clampedDuration = format.maxExposureDuration
        }
        device.setExposureModeCustom(duration: clampedDuration, iso: clampedISO, completionHandler: nil)
        promise?.resolve([
          "applied": true,
          "exposureMode": "custom",
          // The requested values after clamping; the device-settled values are
          // committed in the metadata block at capture.
          "iso": Double(clampedISO),
          "durationSeconds": CMTimeGetSeconds(clampedDuration),
          "isoClamped": clampedISO != isoNumber.floatValue,
          "durationClamped": CMTimeCompare(clampedDuration, requestedDuration) != 0,
          "note": "requested values clamped to active format; settled values are committed per-capture, device-reported",
        ])
      default:
        promise?.resolve(["applied": false, "reason": "unknown-exposure-mode"])
      }
    } catch {
      promise?.resolve(["applied": false, "reason": "lock-failed: \(error.localizedDescription)"])
      return
    }
    // Mirror the applied exposure mode onto the secondary.
    mirrorProControlsToSecondary()
  }

  /// Exposure point-of-interest, independent of focus (spec §14).
  func setExposurePoint(x: Double, y: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    guard device.isExposurePointOfInterestSupported else {
      promise?.resolve(["applied": false, "reason": "exposure-point-unsupported"])
      return
    }
    // Same view-to-device mapping as setFocusPoint.
    let devicePoint = CGPoint(x: CGFloat(y), y: CGFloat(1.0 - x))
    do {
      try device.lockForConfiguration()
      device.exposurePointOfInterest = devicePoint
      device.exposureMode = device.isExposureModeSupported(.autoExpose) ? .autoExpose : .continuousAutoExposure
      device.unlockForConfiguration()
      promise?.resolve([
        "applied": true,
        "devicePoint": ["x": Double(devicePoint.x), "y": Double(devicePoint.y)],
      ])
    } catch {
      promise?.resolve(["applied": false, "reason": "lock-failed: \(error.localizedDescription)"])
    }
  }

  /// { mode: 'auto'|'locked'|'manual', lensPosition? }.
  /// 'manual' locks focus at an explicit lensPosition (0–1, clamped). iOS has
  /// no focus-distance API, so lensPosition is the manual control and it is
  /// committed per capture (spec §5).
  func setFocusMode(opts: [String: Any], promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    let mode = opts["mode"] as? String ?? "auto"
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      switch mode {
      case "auto":
        guard device.isFocusModeSupported(.continuousAutoFocus) else {
          promise?.resolve(["applied": false, "reason": "continuous-auto-focus-unsupported"])
          return
        }
        device.focusMode = .continuousAutoFocus
        promise?.resolve(["applied": true, "focusMode": "auto"])
      case "locked":
        guard device.isFocusModeSupported(.locked) else {
          promise?.resolve(["applied": false, "reason": "focus-lock-unsupported"])
          return
        }
        device.focusMode = .locked
        promise?.resolve(["applied": true, "focusMode": "locked"])
      case "manual":
        // isFocusModeSupported(.locked) does not cover the custom-lens-position
        // API: the virtual DualWide device reports .locked supported yet
        // setFocusModeLocked(lensPosition:) throws an NSException, which Swift
        // cannot catch. Gate on the custom-position support bit.
        guard device.isFocusModeSupported(.locked),
              device.isLockingFocusWithCustomLensPositionSupported else {
          promise?.resolve(["applied": false, "reason": "manual-focus-unsupported"])
          return
        }
        guard let positionNumber = opts["lensPosition"] as? NSNumber else {
          promise?.resolve(["applied": false, "reason": "manual-requires-lensPosition"])
          return
        }
        let clamped = min(max(positionNumber.floatValue, 0.0), 1.0)
        device.setFocusModeLocked(lensPosition: clamped, completionHandler: nil)
        promise?.resolve([
          "applied": true,
          "focusMode": "manual",
          "lensPosition": Double(clamped),
          "lensPositionClamped": clamped != positionNumber.floatValue,
        ])
      default:
        promise?.resolve(["applied": false, "reason": "unknown-focus-mode"])
      }
    } catch {
      promise?.resolve(["applied": false, "reason": "lock-failed: \(error.localizedDescription)"])
      return
    }
    // Mirror the applied focus mode onto the secondary.
    mirrorProControlsToSecondary()
  }

  /// { mode: 'auto'|'locked'|'manual', temperature?, tint? }.
  /// 'manual' converts temperature and tint to gains via the device's own
  /// converter, clamps each gain to [1, maxWhiteBalanceGain], locks, and reports
  /// the round-tripped temperature and tint of the clamped gains.
  func setWhiteBalanceMode(opts: [String: Any], promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    let mode = opts["mode"] as? String ?? "auto"
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      switch mode {
      case "auto":
        guard device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) else {
          promise?.resolve(["applied": false, "reason": "continuous-auto-white-balance-unsupported"])
          return
        }
        device.whiteBalanceMode = .continuousAutoWhiteBalance
        promise?.resolve(["applied": true, "whiteBalanceMode": "auto"])
      case "locked":
        guard device.isWhiteBalanceModeSupported(.locked) else {
          promise?.resolve(["applied": false, "reason": "white-balance-lock-unsupported"])
          return
        }
        device.whiteBalanceMode = .locked
        promise?.resolve(["applied": true, "whiteBalanceMode": "locked"])
      case "manual":
        // Same as focus: .locked mode support does not imply custom-gains
        // locking, and the virtual device throws an uncatchable NSException.
        // Gate on the custom-gains bit.
        guard device.isWhiteBalanceModeSupported(.locked),
              device.isLockingWhiteBalanceWithCustomDeviceGainsSupported else {
          promise?.resolve(["applied": false, "reason": "manual-white-balance-unsupported"])
          return
        }
        guard let tempNumber = opts["temperature"] as? NSNumber,
              let tintNumber = opts["tint"] as? NSNumber else {
          promise?.resolve(["applied": false, "reason": "manual-requires-temperature-and-tint"])
          return
        }
        let tt = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(
          temperature: tempNumber.floatValue,
          tint: tintNumber.floatValue
        )
        var gains = device.deviceWhiteBalanceGains(for: tt)
        let maxGain = device.maxWhiteBalanceGain
        let requested = gains
        gains.redGain = min(max(gains.redGain, 1.0), maxGain)
        gains.greenGain = min(max(gains.greenGain, 1.0), maxGain)
        gains.blueGain = min(max(gains.blueGain, 1.0), maxGain)
        device.setWhiteBalanceModeLocked(with: gains, completionHandler: nil)
        // Round-trip the clamped gains back to temperature and tint so the UI
        // shows what was applied.
        let appliedTT = device.temperatureAndTintValues(for: gains)
        promise?.resolve([
          "applied": true,
          "whiteBalanceMode": "manual",
          "gains": ["r": gains.redGain, "g": gains.greenGain, "b": gains.blueGain],
          "gainsClamped": gains.redGain != requested.redGain
            || gains.greenGain != requested.greenGain
            || gains.blueGain != requested.blueGain,
          "appliedTemperature": appliedTT.temperature,
          "appliedTint": appliedTT.tint,
          "maxWhiteBalanceGain": maxGain,
        ])
      default:
        promise?.resolve(["applied": false, "reason": "unknown-white-balance-mode"])
      }
    } catch {
      promise?.resolve(["applied": false, "reason": "lock-failed: \(error.localizedDescription)"])
      return
    }
    // Mirror the applied white-balance mode onto the secondary.
    mirrorProControlsToSecondary()
  }

  /// Torch with level: nil turns it off, otherwise setTorchModeOn(level:)
  /// clamped to the documented 1.0 API ceiling. Missing torch hardware is a
  /// stated no-op rather than a throw (spec §14).
  ///
  /// maxTorchLevel is not visible to Swift in this SDK, so 1.0 is used as the
  /// ceiling. The argument label is level:, not withLevel:.
  func setTorchLevel(level: Double?, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    guard device.hasTorch, device.isTorchAvailable else {
      promise?.resolve(["applied": false, "reason": "torch-unavailable-on-this-device"])
      return
    }
    do {
      try device.lockForConfiguration()
      defer { device.unlockForConfiguration() }
      guard let level = level else {
        device.torchMode = .off
        promise?.resolve(["applied": true, "torchLevel": 0.0])
        return
      }
      // Neither AVCaptureDevice.maxTorchLevel nor the global
      // AVCaptureMaxTorchLevel is visible to Swift in this SDK, so 1.0 is the
      // ceiling. A device enforcing a lower maximum makes
      // setTorchModeOn(level:) throw, and the catch below returns
      // applied:false with the native error.
      let clamped = min(max(Float(level), 0.0), Float(1.0))
      guard clamped > 0 else {
        device.torchMode = .off
        promise?.resolve(["applied": true, "torchLevel": 0.0])
        return
      }
      try device.setTorchModeOn(level: clamped)
      promise?.resolve([
        "applied": true,
        "torchLevel": Double(clamped),
        "levelClamped": clamped != Float(level),
        "maxTorchLevel": Double(1.0), // documented API ceiling; device max enforced via throw
      ])
    } catch {
      promise?.resolve(["applied": false, "reason": "torch-failed: \(error.localizedDescription)"])
    }
  }
}

// MARK: - Pro controls II: formats, stabilization, HDR, capabilities (spec §14)

extension ExhibitCameraModule {

  /// Per-lens format inventory; a device-level query needing no session.
  /// formatID is "<deviceType.rawValue>:<index>", stable per device model and
  /// OS. RAW support is per-output, not per-format, and needs a photo output
  /// connected to the device, so it is reported from the running session when
  /// available and null with a note otherwise.
  func listFormats() -> [String: Any] {
    let lenses: [(String, AVCaptureDevice.DeviceType, AVCaptureDevice.Position)] = [
      ("ultraWide", .builtInUltraWideCamera, .back),
      ("wide", .builtInWideAngleCamera, .back),
      ("telephoto", .builtInTelephotoCamera, .back),
      ("frontWide", .builtInWideAngleCamera, .front),
    ]
    var result: [String: Any] = [:]
    for (label, type, position) in lenses {
      guard let device = AVCaptureDevice.default(type, for: .video, position: position) else {
        // Lens absent on this hardware.
        result[label] = ["present": false]
        continue
      }
      let formats: [[String: Any]] = device.formats.enumerated().map { idx, fmt in
        let dims = CMVideoFormatDescriptionGetDimensions(fmt.formatDescription)
        let ranges = fmt.videoSupportedFrameRateRanges.map { range in
          ["minFPS": range.minFrameRate, "maxFPS": range.maxFrameRate]
        }
        return [
          "formatID": "\(device.deviceType.rawValue):\(idx)",
          "width": Int(dims.width),
          "height": Int(dims.height),
          "frameRateRanges": ranges,
          "isVideoHDRSupported": fmt.isVideoHDRSupported,
          "isVideoBinned": fmt.isVideoBinned,
          "fieldOfViewDegrees": Double(fmt.videoFieldOfView),
          "minISO": Double(fmt.minISO),
          "maxISO": Double(fmt.maxISO),
          "minExposureDurationSec": CMTimeGetSeconds(fmt.minExposureDuration),
          "maxExposureDurationSec": CMTimeGetSeconds(fmt.maxExposureDuration),
        ]
      }
      result[label] = [
        "present": true,
        "deviceType": device.deviceType.rawValue,
        "formats": formats,
      ]
    }
    return [
      "lenses": result,
      "multiCamSupported": AVCaptureMultiCamSession.isMultiCamSupported,
      // RAW is a photo-output property, so it is null without a session.
      "rawSupported": primaryPhotoOutput.map { !$0.availableRawPhotoPixelFormatTypes.isEmpty } as Any? ?? NSNull(),
      "rawNote": "rawSupported requires a running session (photo-output query); null means unknown, not unsupported",
    ]
  }

  /// { formatID, frameRate? }, applied to the current primary device only;
  /// switch lenses first. Photo and video both flow from the device format, so
  /// one setter covers both, stated in the result. Rolls back and reports if
  /// the hardware-cost budget would be exceeded (spec §6).
  func setFormat(opts: [String: Any], promise: Promise?) {
    guard let session = session, let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    guard let formatID = opts["formatID"] as? String else {
      promise?.resolve(["applied": false, "reason": "missing-formatID"])
      return
    }
    // Parse "<deviceType.rawValue>:<index>".
    let parts = formatID.split(separator: ":")
    guard let last = parts.last, let index = Int(last) else {
      promise?.resolve(["applied": false, "reason": "malformed-formatID"])
      return
    }
    let prefix = parts.dropLast().joined(separator: ":")
    guard prefix == device.deviceType.rawValue else {
      promise?.resolve(["applied": false, "reason": "formatID-belongs-to-another-lens; switch lens first"])
      return
    }
    guard device.formats.indices.contains(index) else {
      promise?.resolve(["applied": false, "reason": "format-index-out-of-range"])
      return
    }
    let target = device.formats[index]
    let previousFormat = device.activeFormat
    let previousMin = device.activeVideoMinFrameDuration
    let previousMax = device.activeVideoMaxFrameDuration
    let requestedFPS = (opts["frameRate"] as? NSNumber)?.doubleValue

    do {
      try device.lockForConfiguration()
      device.activeFormat = target
      var appliedFPS = configuredFPS
      if let fps = requestedFPS {
        // Clamp the requested frame rate into the format's supported ranges and
        // pin min == max so the synchronizer sees a steady stream.
        let maxFPS = target.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? fps
        let minFPS = target.videoSupportedFrameRateRanges.map { $0.minFrameRate }.min() ?? fps
        appliedFPS = min(max(fps, minFPS), maxFPS)
        let duration = CMTime(seconds: 1.0 / appliedFPS, preferredTimescale: 1_000_000_000)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
      }
      device.unlockForConfiguration()

      // Hardware-cost watchdog (spec §6): a format over budget is rolled back
      // and reported rather than throttled.
      if session.hardwareCost > 1.0 {
        do {
          try device.lockForConfiguration()
          device.activeFormat = previousFormat
          device.activeVideoMinFrameDuration = previousMin
          device.activeVideoMaxFrameDuration = previousMax
          device.unlockForConfiguration()
        } catch { /* rollback failure surfaces via the result below */ }
        promise?.resolve([
          "applied": false,
          "reason": "hardware-cost-exceeded; rolled back to the previous format",
          "hardwareCost": Double(session.hardwareCost),
        ])
        return
      }

      currentFormatID = formatID
      configuredFPS = appliedFPS
      let dims = CMVideoFormatDescriptionGetDimensions(target.formatDescription)
      promise?.resolve([
        "applied": true,
        "formatID": formatID,
        "width": Int(dims.width),
        "height": Int(dims.height),
        "frameRate": appliedFPS,
        "frameRateClamped": requestedFPS.map { $0 != appliedFPS } ?? false,
        "appliesTo": "photo-and-video", // device format feeds both paths
        "hardwareCost": Double(session.hardwareCost),
      ])
    } catch {
      promise?.resolve(["applied": false, "reason": "lock-failed: \(error.localizedDescription)"])
    }
  }

  /// Video stabilization on the primary video connection. 'auto' hands the
  /// choice to the system; the committed metadata reads the connection back so
  /// the applied mode is recorded.
  func setVideoStabilizationMode(_ mode: String, promise: Promise?) {
    // Connection-level isVideoStabilizationModeSupported(_:) no longer exists in
    // recent SDKs; the capability check is
    // AVCaptureDevice.Format.isVideoStabilizationModeSupported(_:) on the active
    // format. preferredVideoStabilizationMode and activeVideoStabilizationMode
    // stay on the connection.
    guard let device = primaryDevice,
          let connection = primaryVideoOutput?.connection(with: .video) else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    let target: AVCaptureVideoStabilizationMode
    switch mode {
    case "off": target = .off
    case "standard": target = .standard
    case "cinematic": target = .cinematic
    case "auto": target = .auto
    default:
      promise?.resolve(["applied": false, "reason": "unknown-stabilization-mode"])
      return
    }
    guard device.activeFormat.isVideoStabilizationModeSupported(target) else {
      promise?.resolve(["applied": false, "reason": "stabilization-mode-\(mode)-unsupported-on-active-format"])
      return
    }
    connection.preferredVideoStabilizationMode = target
    appliedStabilization = mode
    promise?.resolve([
      "applied": true,
      "stabilizationMode": mode,
      // Connection read-back: what the pipeline has now.
      "activeMode": DeviceModeMapper.stabilizationMode(connection.preferredVideoStabilizationMode),
    ])
  }

  /// The connection HDR properties (automaticallyAdjustsVideoHDREnabled,
  /// isVideoHDREnabled) are marked unavailable in recent SDKs, so all access
  /// goes through responds(to:) plus KVC. That compiles on any SDK and returns
  /// nil where the feature is absent. The selector strings are not
  /// type-checked.
  private func connectionVideoHDREnabled(_ connection: AVCaptureConnection) -> Bool? {
    guard connection.responds(to: Selector(("isVideoHDREnabled"))) else { return nil }
    return (connection.value(forKey: "videoHDREnabled") as? NSNumber)?.boolValue
  }

  /// Explicit HDR on the primary video connection rather than the system
  /// default (spec §14). Disables automatic adjustment first; a format without
  /// HDR support is a stated no-op. Where the connection HDR control surface is
  /// absent (SDK-gated) this resolves applied:false, which the TS bridge
  /// handles.
  func setHDREnabled(_ enabled: Bool, promise: Promise?) {
    guard let device = primaryDevice,
          let connection = primaryVideoOutput?.connection(with: .video) else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    guard device.activeFormat.isVideoHDRSupported else {
      promise?.resolve(["applied": false, "reason": "hdr-unsupported-on-active-format"])
      return
    }
    // Selector-gated KVC writes; see connectionVideoHDREnabled above.
    let autoSelector = Selector(("setAutomaticallyAdjustsVideoHDREnabled:"))
    let enabledSelector = Selector(("setVideoHDREnabled:"))
    guard connection.responds(to: autoSelector),
          connection.responds(to: enabledSelector) else {
      promise?.resolve(["applied": false, "reason": "hdr-control-unavailable-on-this-device-or-sdk"])
      return
    }
    connection.setValue(false, forKey: "automaticallyAdjustsVideoHDREnabled")
    connection.setValue(enabled, forKey: "videoHDREnabled")
    appliedHDR = enabled
    promise?.resolve([
      "applied": true,
      "hdrEnabled": enabled,
      "activeHDR": connectionVideoHDREnabled(connection) as Any? ?? NSNull(),
    ])
  }

  /// Capability inventory so the UI can hide controls the hardware lacks
  /// (spec §14). Device-level queries; works without a session by falling back
  /// to the back wide camera. null means unknown without a session.
  func capabilities() -> [String: Any] {
    let device = primaryDevice
      ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: facing.position)
    guard let device = device else {
      return [
        "sessionActive": false,
        "devicePresent": false,
        "stereo": probeStereoAvailability().rawValue,
      ]
    }
    let connection = primaryVideoOutput?.connection(with: .video)
    var stabilization: [String] = []
    // The capability check lives on the active format; the connection-level API
    // was removed in recent SDKs. The live-connection gate is kept so "unknown
    // without a session" still reports an empty array.
    if connection != nil {
      for (name, mode) in [("off", AVCaptureVideoStabilizationMode.off),
                           ("standard", .standard),
                           ("cinematic", .cinematic),
                           ("auto", .auto)] as [(String, AVCaptureVideoStabilizationMode)] {
        if device.activeFormat.isVideoStabilizationModeSupported(mode) {
          stabilization.append(name)
        }
      }
    }
    return [
      "sessionActive": session != nil,
      "devicePresent": true,
      "physicalDevice": device.deviceType.rawValue,
      "stereo": probeStereoAvailability().rawValue,
      "exposureModes": [
        "auto": device.isExposureModeSupported(.continuousAutoExposure),
        "locked": device.isExposureModeSupported(.locked),
        "custom": device.isExposureModeSupported(.custom),
      ],
      "exposurePointOfInterestSupported": device.isExposurePointOfInterestSupported,
      "focusModes": [
        "auto": device.isFocusModeSupported(.continuousAutoFocus),
        "locked": device.isFocusModeSupported(.locked),
        // Manual focus is locked + lensPosition, so the support gate matches.
        "manual": device.isFocusModeSupported(.locked),
      ],
      "focusPointOfInterestSupported": device.isFocusPointOfInterestSupported,
      "whiteBalanceModes": [
        "auto": device.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance),
        "locked": device.isWhiteBalanceModeSupported(.locked),
        "manual": device.isWhiteBalanceModeSupported(.locked),
      ],
      "maxWhiteBalanceGain": Double(device.maxWhiteBalanceGain),
      "torch": [
        "available": device.hasTorch && device.isTorchAvailable,
        // Documented API ceiling is 1.0; see setTorchLevel. A device enforces
        // its own maximum by throwing, which setTorchLevel surfaces as
        // applied:false plus the native error.
        "maxTorchLevel": device.hasTorch ? Double(1.0) as Any : NSNull(),
      ],
      "activeFormatHDRSupported": device.activeFormat.isVideoHDRSupported,
      "stabilizationModesSupported": stabilization,
      "stabilizationNote": session != nil
        ? "queried on the active connection"
        : "unknown without a session — empty array is unreached, not unsupported",
      "rawSupported": primaryPhotoOutput.map { !$0.availableRawPhotoPixelFormatTypes.isEmpty } as Any? ?? NSNull(),
      "activeFormatISO": [
        "min": Double(device.activeFormat.minISO),
        "max": Double(device.activeFormat.maxISO),
      ],
      "activeFormatExposureDurationSec": [
        "min": CMTimeGetSeconds(device.activeFormat.minExposureDuration),
        "max": CMTimeGetSeconds(device.activeFormat.maxExposureDuration),
      ],
      "zoomRange": [
        // min/max are the active device's own supported range. qualityCap is
        // the app-chosen digital-zoom quality ceiling (see ExhibitZoomCaps),
        // not a hardware limit; the UI clamps to min(max, qualityCap).
        // switchOverFactors are the hardware hand-off points of the virtual
        // device containing this stack, so the UI's optical stops match them.
        "min": Double(device.minAvailableVideoZoomFactor),
        "max": Double(device.maxAvailableVideoZoomFactor),
        "qualityCap": min(
          Double(device.maxAvailableVideoZoomFactor),
          ExhibitZoomCaps.qualityCap(for: device.deviceType)
        ),
        "switchOverFactors": virtualSwitchOverFactors(for: device),
      ],
      // Per-constituent-device ceilings: every back stack this hardware
      // has, each with its hardware max and the app-chosen quality cap. The UI
      // picks its per-lens ceiling from this; an absent lens is omitted.
      "lensZoomCaps": lensZoomCaps(),
      "zoomQualityNote": "qualityCap values are a conservative app-chosen ceiling for digital-zoom resampling quality — NOT hardware limits; hardwareMax is the device's own maxAvailableVideoZoomFactor",
      // Selectable secondary stack: every rear stack present on this hardware,
      // the current preference, and the third-view hardware probe (untested
      // extension point, flag off by default).
      "secondaryLensOptions": rearStackOptions(),
      "secondaryLens": secondaryLensPreference?.rawValue ?? "auto",
      "thirdViewCapable": probeThirdViewSupport(),
    ]
  }

  /// The rear stacks present on this hardware, in the bridge's lens vocabulary;
  /// the secondary-stack option list.
  private func rearStackOptions() -> [String] {
    let specs: [(String, AVCaptureDevice.DeviceType)] = [
      ("ultraWide", .builtInUltraWideCamera),
      ("wide", .builtInWideAngleCamera),
      ("telephoto", .builtInTelephotoCamera),
    ]
    var options: [String] = []
    for (name, type) in specs {
      if AVCaptureDevice.default(type, for: .video, position: .back) != nil {
        options.append(name)
      }
    }
    return options
  }

  /// Hardware hand-off points: virtualDeviceSwitchOverVideoZoomFactors
  /// of the virtual device containing the active stack. When the primary is a
  /// physical device the factors are read from the virtual device
  /// (triple/dual-wide/dual) at the same position. Empty when no virtual device
  /// exists.
  private func virtualSwitchOverFactors(for device: AVCaptureDevice) -> [Double] {
    if device.isVirtualDevice {
      return device.virtualDeviceSwitchOverVideoZoomFactors.map { $0.doubleValue }
    }
    let virtualTypes: [AVCaptureDevice.DeviceType] = [
      .builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera,
    ]
    for type in virtualTypes {
      guard let virtual = AVCaptureDevice.default(type, for: .video, position: device.position),
            virtual.isVirtualDevice else { continue }
      return virtual.virtualDeviceSwitchOverVideoZoomFactors.map { $0.doubleValue }
    }
    return []
  }

  /// Per-constituent-device zoom ceilings, keyed by the bridge's lens
  /// vocabulary so the UI never parses deviceType rawValues. Devices not present
  /// are omitted; listFormats is the presence source.
  private func lensZoomCaps() -> [[String: Any]] {
    let position = facing.position
    let specs: [(String, AVCaptureDevice.DeviceType)] = [
      ("ultraWide", .builtInUltraWideCamera),
      ("wide", .builtInWideAngleCamera),
      ("telephoto", .builtInTelephotoCamera),
    ]
    var caps: [[String: Any]] = []
    for (lens, type) in specs {
      guard let d = AVCaptureDevice.default(type, for: .video, position: position) else { continue }
      let hardwareMax = Double(d.maxAvailableVideoZoomFactor)
      caps.append([
        "lens": lens,
        "deviceType": type.rawValue,
        "hardwareMax": hardwareMax,
        "qualityCap": min(hardwareMax, ExhibitZoomCaps.qualityCap(for: type)),
      ])
    }
    return caps
  }
}
