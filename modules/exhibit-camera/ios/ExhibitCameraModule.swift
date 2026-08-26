// Source Kit 0.1.0 — the native camera, capture and sensor modules
import ExpoModulesCore
import AVFoundation
import CoreMedia
import CoreVideo
import CoreImage
import CryptoKit
import UIKit
import simd

/**
 * ExhibitCamera — the app's one camera session.
 *
 * The camera commits, it never concludes. This module records frames,
 * calibration, timestamps, and metadata, and writes them down. No analysis,
 * no verdicts. Everything it commits is an input the desk can re-derive
 * from; nothing is an answer.
 *
 * When a value is unavailable the payload says so and names the reason.
 * Nothing is filled in with a plausible substitute — a stated gap is
 * evidence, an invented value is not.
 *
 * THE GRAPH
 *
 *   One AVCaptureMultiCamSession, always, even on a single-camera device:
 *   one code path running with one input and one output, rather than two
 *   paths that drift apart.
 *
 *   A primary and a secondary AVCaptureVideoDataOutput feed the frame
 *   pipeline. The primary rides an AVCaptureDataOutputSynchronizer. The
 *   secondary delivers straight to its own delegate and is paired to the
 *   primary by presentation timestamp, because the synchronizer does not
 *   surface a second physical device on current hardware.
 *
 *   Every input, output, and connection is wired by hand
 *   (addInputWithNoConnections / addOutputWithNoConnections, plus one
 *   AVCaptureConnection per port). Letting AVFoundation form multi-cam
 *   connections implicitly is a documented hazard.
 *
 *   The preview layer binds to this same session, so there is no second
 *   session to contend with.
 *
 *   Audio sits outside the synchronizer, on the same queue — synchronized
 *   audio-and-video collections are unreliable. Delivery video is written
 *   with AVAssetWriter, H.264 plus AAC.
 *
 * FORMATS
 *
 *   When a second camera will run, only formats flagged isMultiCamSupported
 *   may be selected; setting any other one is what breaks the secondary
 *   stream. configureFormat filters on that flag and falls up to the
 *   smallest multi-cam format rather than failing the attach. Photo outputs
 *   clamp to 12 MP: an unclamped 48 MP reservation on a live multi-cam graph
 *   starves the streams.
 *
 * CALIBRATION
 *
 *   Per-frame intrinsics ride the sample buffer
 *   (connection.isCameraIntrinsicMatrixDeliveryEnabled →
 *   kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix).
 *
 *   Full calibration — extrinsics and distortion maps — would need the
 *   photo-path calibration from both lenses, and the secondary photo output
 *   is not attached, so calibrationSource commits 'unavailable'. That field
 *   exists so the desk can always tell which path produced a matrix.
 *
 *   Depth is committed only when the hardware delivers a real depth map with
 *   the photo. Otherwise the payload states depth-not-recorded and why.
 *
 * OPTIONAL SINKS
 *
 *   Shutter ring (configureSession opts.ring): three frames before the
 *   shutter and four after, preview mode only, written to
 *   evidenceDir/ring-<captureId>/. Each entry states its own completeness,
 *   so a missing secondary degrades the burst honestly instead of voiding
 *   it. Shallow on purpose — retained frames hold pool buffers.
 *
 *   Raw audio master: rawPcmInfo on the stopVideo payload carries the first
 *   sample's wall clock, the sample count, the rate, and the file digest.
 *
 *   Secondary lens selection (opts.secondaryLens, setSecondaryLens; 'auto'
 *   pairs ultra-wide with wide or telephoto).
 *
 * DIAGNOSTICS
 *
 *   A connection census — each output's enabled and active state, its port's
 *   device, and that device's active format — rides the configureSession
 *   result, the first-frame log, every capture payload, and every failure
 *   dump. Drop accounting keeps three cases apart: a secondary the
 *   synchronizer never offered, one the platform marked dropped, and a
 *   complete pair. Silent failure paths in the graph build write to the
 *   persistent diagnostics log.
 *
 *   A stalled secondary is rebound at 150 consecutive drops and its output
 *   reseated once at 300, because a parked stream does not come back from a
 *   rebind alone.
 *
 * THREADS
 *
 *   All mutable session state lives on sessionQueue. The synchronizer, the
 *   secondary delegate, and the audio output deliver onto that same queue.
 *   Events are emitted from it; view-scoped events hop to main.
 *
 * WATCHDOGS
 *
 *   Every native await has a timeout: ten seconds for first frame, for
 *   capture, and for stop. A hung native call must never freeze the UI.
 *
 * No network I/O of any kind.
 */

/**
 * An error whose message survives the bridge.
 *
 * promise.reject(code, description) drops the description on SDK 57. This
 * subclass carries it in `reason` instead, so a JS caller sees what went
 * wrong rather than a bare code. CaptureKit keeps its own copy — the two
 * are separate pod targets.
 */
final class ExhibitCameraNamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

/// Receives synchronized frame collections and hands them on. The Module
/// class is not an NSObject, so delegate conformance lives in a forwarder.
final class ExhibitSyncHandler: NSObject, AVCaptureDataOutputSynchronizerDelegate {
  var onCollection: ((AVCaptureSynchronizedDataCollection) -> Void)?

  func dataOutputSynchronizer(
    _ synchronizer: AVCaptureDataOutputSynchronizer,
    didOutput synchronizedDataCollection: AVCaptureSynchronizedDataCollection
  ) {
    onCollection?(synchronizedDataCollection)
  }
}

/// Receives the secondary camera's frames directly.
///
/// The synchronizer does not surface a second physical device, so the
/// secondary output delivers to this delegate instead — the AVMultiCamPiP
/// topology — and handleSynchronizedCollection pairs its frames to the
/// primary by presentation timestamp.
final class ExhibitSecondaryDirectHandler: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
  var onFrame: ((CMSampleBuffer) -> Void)?
  var onDrop: (() -> Void)?

  func captureOutput(
    _ output: AVCaptureOutput,
    didOutput sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    onFrame?(sampleBuffer)
  }

  func captureOutput(
    _ output: AVCaptureOutput,
    didDrop sampleBuffer: CMSampleBuffer,
    from connection: AVCaptureConnection
  ) {
    onDrop?()
  }
}

/// Receives audio buffers. Video mode only; audio runs outside the
/// synchronizer.
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

/// Receives one finished photo. Built fresh for each photo capture.
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

/// The most recent good frame pair, held on sessionQueue.
///
/// Two rules govern this struct.
///
/// It stores the CMSampleBuffers themselves, never the synchronizer's
/// wrapper objects. Apple's contract is that synchronized data is valid
/// only for the duration of the delegate callback; a wrapper held past
/// that point retains none of the payload, and the pool recycles the
/// buffer underneath it, so every stored frame silently becomes an alias
/// of the newest one. A Swift CMSampleBuffer is an ARC-managed CF
/// reference: storing it is the retain the contract asks for, releasing
/// it is the release, and the pool cannot recycle a buffer something
/// still points at.
///
/// It holds at most one pair, and drops the previous one immediately.
/// Pixel buffers come from a finite pool and holding several starves the
/// pipeline into drops.
///
/// Intrinsics stay in the buffer's attachment rather than being copied out
/// here, so frameIntrinsics(from:) can read them at commit time and the
/// per-frame delivery path allocates nothing.
private struct RetainedPair {
  var primary: CMSampleBuffer
  var secondary: CMSampleBuffer?    // nil in single-cam mode
  var deltaMs: Double?              // secondary−primary PTS delta; nil single-cam
  var receivedAt: Date
}

public class ExhibitCameraModule: Module {

  // MARK: - Session state (all of it confined to sessionQueue)

  private let sessionQueue = DispatchQueue(label: "com.exhibit.camera.session")
  /// Marks sessionQueue so code can tell whether it is already running on
  /// it. OnDestroy needs this: dispatching sync onto the queue you are
  /// already on deadlocks. Set once in OnCreate, before anything can fire.
  private let sessionQueueSpecificKey = DispatchSpecificKey<UInt8>()
  /// The one capture session, for the life of the process.
  ///
  /// AVFoundation aborts when a session deallocates while a preview layer
  /// is still attached to it: dealloc reaches detachFromFigCaptureSession,
  /// which barrier-syncs to Fig's own queue and asserts on the
  /// inconsistent state. Everything that used to guard that moment — a
  /// bind-time layer registry, a parking area, a Fig round-trip, a proof
  /// that nothing was attached, bounded retries, a graveyard for the
  /// sessions that could not be proven clean — existed to make one
  /// dealloc survivable.
  ///
  /// A session that never deallocates does not need any of it. This one is
  /// created once and never released, so the abort has no precondition
  /// left to satisfy. Preview layers may keep their reference across a
  /// blur, a view's death, anything: the referent outlives them all.
  ///
  /// What replaces teardown is rewiring. configureSession strips the
  /// current graph with unwireGraph and builds the new one inside the same
  /// begin-and-commit, and resetCaptureState clears the per-graph state
  /// that a fresh session used to clear by existing.
  private static let processSession = AVCaptureMultiCamSession()

  /// Serial queue for evidence-sink work — JPEG encodes and file writes.
  /// Kept off sessionQueue: an encode longer than a frame interval on the
  /// frame queue drops synchronized pairs. RetainedPair holds its sample
  /// buffers under ARC, so the hop is safe.
  private let sinkIOQueue = DispatchQueue(label: "com.exhibit.camera.sinkio")

  /// The process session, from the first configureSession on. nil means
  /// only that nothing has configured yet — it is never nil'd again and
  /// never replaced. A graph change rewires it in place.
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
  // Which half of the pair the platform is dropping. Stills that wedge and
  // stereo that quietly goes missing both look the same from JS; these
  // counts separate a starved primary stream from a starved secondary.
  // They ride the stall event, the degraded-capture reason, and the
  // committed metadata.
  private var droppedPrimaryCount = 0
  private var droppedSecondaryHalfCount = 0
  /// Consecutive secondary-half drops. Any complete pair resets it.
  ///
  /// The stall watchdog watches for silence, and a secondary-half flood is
  /// not silent — collections keep arriving, so the watchdog never fires
  /// while stereo is absent for the whole session. This counter catches
  /// that case: 150 in a row, about five seconds at 30 fps, triggers one
  /// synchronizer rebind per streak.
  private var consecutiveSecondaryDrops = 0
  // Where the secondary half dies. Read them together:
  //
  //   secondaryAbsentCount   the synchronizer offered no data object at all
  //                          for the secondary output.
  //   secondaryDroppedCount  an object arrived, marked dropped.
  //   completePairCount      pairs retained with both halves. Zero while
  //                          the two counters above climb means the
  //                          secondary stream never lands.
  //   staleShutterCount      shutters that found no fresh pair — frames
  //                          arrived but too late to use.
  //   secondaryReseatDone    the output reseat has already fired this
  //                          session.
  private var secondaryAbsentCount = 0
  // Rear stereo can also ride the dual-wide virtual device — one input with
  // hardware-synced constituent ports — instead of two device inputs. It is
  // not the default: running the ultra-wide constituent's own stream pins
  // the zoom range to 2.0–4.0, and the product needs a 1x default with a
  // free sweep. Flip it from Settings ▸ Diagnostics ▸ legacyVirtualGraph.
  //
  //   virtualSecondaryPort   the ultra-wide constituent port, always
  //                          requested by name rather than picked out of
  //                          the ports array. Drives the secondary output
  //                          wiring, the reseat path, and the PiP
  //                          connection.
  private var virtualGraphActive = false
  private var virtualSecondaryPort: AVCaptureInput.Port? = nil
  // A connection's isActive settles asynchronously after startRunning, so a
  // single census reads it too early to mean anything. These observers
  // record the whole timeline instead — initial state and every transition,
  // timestamped against sessionStartWallClock. Never active means the graph
  // rejected the connection; active and then inactive means it was evicted
  // after start. Invalidated in resetCaptureState.
  private var connectionActiveObservers: [NSKeyValueObservation] = []
  private var sessionStartWallClock: Date? = nil
  private var secondaryDroppedCount = 0
  private var completePairCount = 0
  private var staleShutterCount = 0
  private var secondaryReseatDone = false
  /// Guards scheduleSecondaryDeliveryCheck so the "attached but no pairs"
  /// finding is logged once per session rather than on every tick.
  private var secondaryDeliveryChecked = false
  // The secondary stream's own delivery path, bypassing the synchronizer.
  // Holds the newest ultra-wide frame — at most one, released on pair, on
  // commit, or at teardown, and pinned by ARC so the pool cannot recycle
  // it — plus a lifetime frame count. That count is what tells the watchdog
  // whether the platform starved the output or whether frames arrived and
  // none of them could be paired.
  private let secondaryDirectHandler = ExhibitSecondaryDirectHandler()
  private var latestDirectSecondary: (buffer: CMSampleBuffer, pts: CMTime, receivedAt: Date)? = nil
  private var directSecondaryFrameCount = 0
  /// Throttles zoom success logging to the first set per graph and range
  /// each session. Logging every commit runs the whole
  /// interpolate-bridge-store path mid-pinch and makes the gesture stutter.
  /// Failures always log.
  private var lastZoomLogSignature: String? = nil
  private var stereoActive = false       // secondary input+output attached
  private var stereoDetachedForThermal = false
  private var sessionCalibration: [String: [String: Any]] = [:] // device rawValue → dict
  private var sessionCalibrationObjects: [String: AVCameraCalibrationData] = [:] // for metadata focal lengths
  private var calibrationCaptureInFlight = false

  // ---- Pro controls: what this module last applied. ----
  //
  // Nothing here is reported. The metadata block reads the device back at
  // capture time, because the device is what the picture was actually taken
  // with. These fields exist to identify the current format and to roll
  // back a failed change.
  private var currentFormatID: String?
  private var configuredFPS: Double = 30.0
  private var appliedStabilization: String = "auto"
  private var appliedHDR: Bool = false
  /// The flash mode written into every full-res capture's photo settings.
  /// Not the torch, which is the continuous video light and is untouched
  /// here. This is a per-capture setting rather than a device mode, so it
  /// is kept across sessions and a fresh session honors it.
  private var photoFlashPreference: ExhibitPhotoFlash = .off
  /// KVO on device.isAdjustingFocus → onAdjustingFocus event.
  private var focusObserver: NSKeyValueObservation?
  /// Photo delegates, held until their capture finishes. The photo output
  /// does not retain its delegate, so one that lived only as a local would
  /// deallocate mid-capture.
  private var photoHandlers: [ExhibitPhotoHandler] = []

  // Video mode: the delivery writer, and the raw audio master beside it.
  private enum Mode { case preview, video }
  private var mode: Mode = .preview

  // Two pieces of state, because they answer different questions.
  //
  // `mode` routes frames. It flips to .preview the instant a stop begins,
  // so no buffer can be appended after the writer is marked finished.
  //
  // `videoState` owns the lifecycle. Sealing a file is asynchronous, and it
  // stays .stopping until the seal settles. A startVideo that arrives
  // during .stopping queues behind the seal rather than failing — the user
  // tapped record, and the moment should not be lost. A stopVideo that
  // arrives during .stopping joins the stop already running. The seal's
  // completion is the only place the state returns to .idle.
  private enum VideoState { case idle, recording, stopping }
  private var videoState: VideoState = .idle
  /// A startVideo waiting for the in-flight stop to finish sealing. At most
  /// one; a second is rejected rather than silently dropped.
  private var pendingStartVideo: (opts: [String: Any], promise: Promise)?
  /// Extra stopVideo callers attached to the stop already running. All of
  /// them settle with that stop's outcome.
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
  // The raw audio master, video only, enabled per startVideo(opts.rawPcm).
  // Enabled with no writer means enabled and failed, and stop reports null
  // for it; the JS side owns the toggle and reports 'never-recorded' when it
  // is off. The two cases must never look alike. This sink is a tee — it
  // never touches the delivery file.
  private var pcmEnabled = false
  private var pcmWriter: PcmMasterWriter?
  private var pcmConverter: AudioMasterConverter?
  // How often a frame pair is committed during a recording. Start and stop
  // each force one on top of the cadence, so even a very short clip commits
  // a beginning and an end rather than nothing at all.
  private var pairIntervalSec: Double = 2.0
  private var lastPairDumpAt: Date = .distantPast
  private var pairIndex = 0
  private var pairsMissed = 0
  private var videoStartDate: Date?
  private var stopPromise: Promise?
  private var stopTimeout: DispatchWorkItem?

  // The motion log. When enabled through configureSession, it samples the
  // accelerometer and gyroscope at 100 Hz into a sixty-second ring that
  // runs for the whole session, so a still can slice the two seconds before
  // the shutter and stopVideo can slice the recording window.
  //
  // The logger reference is confined to sessionQueue like everything above;
  // the ring inside it has its own lock, since appends land on the logger's
  // own queue.
  //
  // Every capture reports one of three things: recorded, with a path;
  // unavailable, when the toggle is off, the hardware has no IMU, or the
  // logger is parked for heat; or failed, with the error. A missing motion
  // log never blocks a capture.
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
  // Interruption boundaries, written to the persistent diagnostics log. An
  // interruption that parks the secondary stream must not be invisible
  // afterward.
  private var interruptionObserver: NSObjectProtocol?
  private var interruptionEndedObserver: NSObjectProtocol?
  private var firedErrorCodes = Set<String>()

  // Pipeline health. The preview layer keeps painting even when the data
  // outputs have stalled, so the viewfinder looks fine while every still is
  // rejected as stale. lastCollectionAt is what the watchdog reads.
  private var lastCollectionAt: Date?
  // Three escalating responses to a stall, each fired at most once.
  private var stallRecovering = false    // rebind the synchronizer
  private var stallBounced = false       // bounce the session in place
  private var stallEscalated = false     // tell JS (once per session)

  // The second camera's live feed on screen, shown exactly while that
  // camera is attached — the picture is the disclosure. The view owns the
  // layer and only displays it; this module owns the connection. pipLayer
  // is weak because the view's layer tree is its owner.
  private var pipWanted = false
  private weak var pipLayer: AVCaptureVideoPreviewLayer?
  private var pipConnection: AVCaptureConnection?

  // Which lens runs as the secondary. nil means auto: ultra-wide paired
  // with wide or telephoto. Changing it on a running rear session detaches
  // and re-attaches the secondary pipeline. A choice that conflicts with
  // the primary lens, or that this hardware does not have, falls back to
  // auto and the payload says so.
  private var secondaryLensPreference: ExhibitLens?

  // Frames around the shutter. Opt-in through configureSession(opts.ring).
  //
  // While enabled and in preview mode, the last few complete frames sit in
  // a small ring. At the shutter, the ring plus the next few frames are
  // written to evidenceDir/ring-<captureId>/ as downsampled JPEGs with a
  // JSON index.
  //
  // The ring is shallow on purpose. Every retained frame pins a capture
  // pool buffer, and holding several starves the pipeline into drops.
  // Three before and four after is the roughly eight frames the UI
  // promises.
  private var burstSinkWanted = false
  private var burstRing: [RetainedPair] = []
  private let burstPreCapacity = 3
  private let burstPostCapacity = 4
  private var burstPostFrames: [RetainedPair] = []
  private var burstPostTarget = 0        // >0 while collecting post-shutter frames
  private var burstContinuation: (() -> Void)?
  private var burstTimeout: DispatchWorkItem?
  // Presentation timestamp of the last frame the ring kept. Only frames
  // with a later timestamp are retained, so a repeat never enters twice.
  private var lastBurstPTS: CMTime? = nil
  // The ring samples on a cadence rather than taking every frame. Filling
  // at the full frame rate would pack seven frames into about a tenth of a
  // second, close enough together to be identical, and Motion Trace would
  // read no movement across a window the UI says is much wider. A frame is
  // kept only once this long has passed since the last one. The timestamp
  // check above still runs first.
  private var lastBurstRetainedAt: Date? = nil
  private let burstCadenceSeconds: TimeInterval = 0.1

  // Audio tap health, and the wall-clock anchor for the raw master. The
  // count exists so a master that never commits fails loudly rather than
  // silently.
  private var audioBufferCount = 0
  private var pcmFirstSampleWallClockUtcMs: Int64?
  // Which clock the anchor came from: "source-pts" or "append-instant".
  // Always stated, because they are not equally precise.
  private var pcmAnchorSource = ""

  /// The preview view registers itself here when its props update, on the
  /// main thread. Weak, because the view is display-only.
  private weak var previewView: ExhibitCameraPreviewView?

  /// Shared context for JPEG encoding and downsampling. CIContext is
  /// documented as thread-safe for rendering; it is used from sinkIOQueue
  /// and never touches session state.
  private let ciContext = CIContext(options: [.cacheIntermediates: false])

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("ExhibitCamera")
    Events("onSessionError", "onHardwarePressure", "onStereoPairCaptured", "onAdjustingFocus", "onSyncStalled", "onCameraDiagnostic")

    // This body is a result builder and takes only definition components,
    // so the queue tag is set in OnCreate, which runs before any
    // AsyncFunction can fire.
    OnCreate {
      self.sessionQueue.setSpecific(key: self.sessionQueueSpecificKey, value: 1)
    }

    // The module must not die with a session still parked. A release
    // closure that fires after the module is gone returns early at its
    // `guard let self` and never sweeps or releases, which leaves the
    // session's last reference in an array whose release point nobody
    // controls — the abort described above, by another route.
    //
    // So tear down and drain synchronously, on sessionQueue, while both are
    // known to be alive. The specific-key check keeps that safe even if
    // destruction itself originates on sessionQueue.
    OnDestroy {
      if DispatchQueue.getSpecific(key: self.sessionQueueSpecificKey) != nil {
        self.stopForModuleDestroy()
      } else {
        self.sessionQueue.sync { self.stopForModuleDestroy() }
      }
    }

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

    /// Asks the hardware whether stereo is possible. Starts nothing.
    /// Answers 'available', 'unsupported', or 'unreached'. Never throws: a
    /// probe that fails is itself 'unreached'.
    AsyncFunction("stereoAvailability") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.probeStereoAvailability().rawValue)
      }
    }

    /// Starts the session in preview mode. Resolves on the first frame, or
    /// rejects at the ten-second watchdog. It never hangs the UI.
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

    /// Takes a still from the running session.
    AsyncFunction("capture") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.capture(opts: opts, promise: promise)
      }
    }

    /// Starts recording: the delivery mp4, plus frame pairs on a cadence.
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

    // ---- Camera controls ----
    //
    // All of these reconfigure on sessionQueue, clamp their input, and do
    // nothing and say so when the hardware lacks the capability.

    AsyncFunction("setLens") { (lens: String, promise: Promise) in
      self.sessionQueue.async {
        self.setLens(ExhibitLens(jsValue: lens), promise: promise)
      }
    }

    /// Chooses the secondary lens: 'auto', or one of 'ultraWide', 'wide',
    /// 'telephoto' — telephoto as the stereo partner on a triple-lens
    /// phone, for instance. Applies immediately on a running rear session,
    /// otherwise waits for the next configureSession. It never swaps
    /// silently: a conflict with the primary lens resolves applied:false
    /// with the reason.
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

    /// Ramps zoom smoothly, for a pinch. Instant jumps — a lens hand-off
    /// that has to stay continuous — go through setZoom instead.
    AsyncFunction("setZoomSmooth") { (factor: Double, rate: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setZoomSmooth(factor, rate: rate, promise: promise)
      }
    }

    /// Sets the flash for stills. Never the torch, which is the continuous
    /// video light.
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

    /// x and y are view coordinates from 0 to 1, origin top left.
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

    // ---- Pro controls ----
    //
    // Every setter here does nothing rather than throwing when the hardware
    // lacks the capability. capabilities() reports what exists, so the UI
    // can hide the rest instead of offering a control that cannot work.

    /// { mode: 'auto'|'locked'|'custom', iso?, durationSeconds? }
    AsyncFunction("setExposureMode") { (opts: [String: Any], promise: Promise) in
      self.sessionQueue.async {
        self.setExposureMode(opts: opts, promise: promise)
      }
    }

    /// View coordinates from 0 to 1. The exposure point is independent of
    /// the focus point.
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

    /// nil turns the torch off. Any level is clamped to the documented
    /// ceiling of 1.0.
    AsyncFunction("setTorchLevel") { (level: Double?, promise: Promise) in
      self.sessionQueue.async {
        self.setTorchLevel(level: level, promise: promise)
      }
    }

    /// Lists what the devices can do. No session needed.
    AsyncFunction("listFormats") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.listFormats())
      }
    }

    /// { formatID, frameRate? }, applied to the current primary device.
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

    /// HDR is set explicitly here, never left to a system default, so the
    /// committed metadata can state which it was.
    AsyncFunction("setHDREnabled") { (enabled: Bool, promise: Promise) in
      self.sessionQueue.async {
        self.setHDREnabled(enabled, promise: promise)
      }
    }

    /// What this hardware can do. The UI hides anything not listed.
    AsyncFunction("capabilities") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.capabilities())
      }
    }

    // ---- Debug flags ----
    //
    // Diagnostics only. Just the known keys are writable; an unknown key
    // resolves applied:false and names the keys that exist. Defaults:
    //
    //   photoMaxDimensionsPolicy  on   the 12 MP clamp; the flag is the
    //                                  escape hatch, not the switch
    //   depthCapture              on
    //   photoConnectionRotation   off
    //   sessionCalibrationPhoto   off
    //   thirdViewEnabled          off  gates an untested extension point

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

    // ---- The preview view ----

    View(ExhibitCameraPreviewView.self) {
      Events("onPreviewReady")

      // Every prop handler attaches the module, because a prop is the one
      // contact between view and module guaranteed under both Paper and
      // Fabric. JS always passes `lens`, so the attach always happens.
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
      // The second camera's live feed in a corner inset, on screen exactly
      // while that camera is attached. The view owns the layer; this module
      // owns the connection to the secondary input's video port.
      Prop("altPreview") { (view: ExhibitCameraPreviewView, value: Bool) in
        view.attach(module: self)
        // Read the inset layer BEFORE disabling it. The disable path nils
        // the view's layer on this thread, so reading afterward hands
        // sessionQueue a nil and leaves the module's weak reference to die
        // still attached. Enabling reads after, because the call is what
        // creates the layer; disabling reads before.
        let layerBefore = view.currentPipLayer()
        view.setAltPreviewEnabled(value)
        let layer = value ? view.currentPipLayer() : layerBefore
        self.sessionQueue.async {
          self.previewView = view
          self.setPipWanted(value, layer: layer)
        }
      }
    }
  }

  /// Binds the view's layer to the session, from a prop handler on main
  /// onto sessionQueue.
  ///
  /// Every preview-layer bind and unbind runs on sessionQueue, which puts
  /// them in order with configure, start, and stop by construction. What
  /// they must not do is run on main, where setSession: can commit the
  /// capture graph synchronously and stall into the scene-update watchdog.
  func attachViewOnSessionQueue(_ view: ExhibitCameraPreviewView) {
    sessionQueue.async { [weak self, weak view] in
      guard let self = self, let view = view else { return }
      self.previewView = view
      if let session = self.session {
        view.bind(session: session)
      }
    }
  }

  /// A dying view's unbind, hopped onto sessionQueue. Tidiness rather than
  /// safety now: a layer that outlives its view holding a reference to the
  /// session harms nothing, because the session is never released.
  func enqueueLayerUnbind(preview: AVCaptureVideoPreviewLayer, pip: AVCaptureVideoPreviewLayer?) {
    sessionQueue.async {
      // When the dying view's inset layer is the one the tracked live
      // connection feeds, remove that connection first, so the next bind
      // builds a fresh inset instead of finding a stale one and showing
      // black.
      if let pip = pip, let session = self.session, self.pipConnection?.videoPreviewLayer === pip {
        session.beginConfiguration()
        self.teardownPipConnection(in: session)
        session.commitConfiguration()
      }
      preview.session = nil
      pip?.session = nil
    }
  }

  /// Pushes the running session to the preview view, and reports
  /// first-frame readiness. The bind is enqueued on sessionQueue — callers
  /// include the synchronizer's own queue — so it stays in order with
  /// configure, start, and stop.
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

  /// Sends an error to JS, at most once per code per session. A sink that
  /// fails repeatedly would otherwise flood the bridge.
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

// MARK: - The second camera's inset, and pipeline health

extension ExhibitCameraModule {

  /// Attaches or detaches the second camera's live feed, from the view's
  /// altPreview prop. The connection binds the layer straight to the
  /// secondary input's video port, so the inset shows exactly what the
  /// evidence pipeline sees rather than a separate render. Runs on
  /// sessionQueue.
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
      // A layer bound with no connection still retains its session. Clear
      // it here, after the commit and on this serial queue, so a discarded
      // inset layer can never carry the session off to deallocate
      // somewhere else.
      oldLayer?.session = nil
    }
  }

  /// Creates or repairs the inset's connection, only when a secondary input
  /// is actually plumbed. No partner means no inset: the view keeps an
  /// empty frame rather than showing something that is not the second
  /// camera.
  func ensurePipConnection(in session: AVCaptureMultiCamSession) {
    // A connection missing from this session's own list is stale — left
    // behind when an in-place rewire stripped the graph. Clearing it lets
    // the inset rebuild instead of staying black behind the guard below.
    if let stale = pipConnection, !session.connections.contains(stale) { pipConnection = nil }
    guard pipWanted, pipConnection == nil, let layer = pipLayer else { return }
    // On the virtual graph there is no secondary input: the secondary port
    // is a constituent of the single virtual input, requested by name.
    let pipPort: AVCaptureInput.Port?
    let pipDevice: AVCaptureDevice?
    if virtualGraphActive {
      pipPort = virtualSecondaryPort
      pipDevice = secondaryDevice
    } else {
      // Ask for the port by device type and position rather than scanning
      // the ports array, which is what Apple's own sample does.
      pipPort = secondaryInput.flatMap { input in
        input.ports(for: .video, sourceDeviceType: input.device.deviceType, sourceDevicePosition: input.device.position).first
      }
      pipDevice = secondaryInput?.device
    }
    guard let port = pipPort else { return }
    layer.setSessionWithNoConnection(session)
    // The initializer cannot fail on iOS; canAddConnection below is the
    // real gate.
    let connection = AVCaptureConnection(inputPort: port, videoPreviewLayer: layer)
    session.beginConfiguration()
    guard session.canAddConnection(connection) else {
      session.commitConfiguration()
      return
    }
    session.addConnection(connection)
    session.commitConfiguration()
    if #available(iOS 17.0, *), let device = pipDevice {
      // A preview-bound connection takes the coordinator's preview angle
      // for the secondary device, never a fixed orientation.
      RotationPolicy.apply(to: connection, device: device, previewLayer: layer)
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    pipConnection = connection
  }

  func teardownPipConnection(in session: AVCaptureMultiCamSession) {
    guard let pip = pipConnection else { return }
    // Removing a connection KVO-unregisters it, and that throws when the
    // observer is already gone — reachable when the graph was rebuilt
    // underneath us, or when teardown already invalidated this connection.
    //
    // Removal is idempotent in intent: a connection we no longer hold is
    // gone either way. So clear the reference in every outcome, skip the
    // call when the session no longer holds the connection, and route the
    // removal through the exception shim. A throw becomes a stated error,
    // not a crash.
    pipConnection = nil
    guard session.connections.contains(pip) else { return }
    if let removeError = ExhibitSessionControl.safelyRemoveConnection(session, connection: pip) {
      sendError(
        ExhibitCameraErrorCode.platform,
        "PiP connection removal raised an exception: \(removeError.localizedDescription)"
      )
    }
  }

  /// Watches for a stalled pipeline, every two seconds while the session
  /// lives.
  ///
  /// If frames were arriving and have now been quiet for more than a second
  /// and a half, the response escalates: rebind the synchronizer, which is
  /// cheap; bounce the session in place, which blocks but the pipeline is
  /// already dead; and only then tell JS, once, so it can rebuild.
  ///
  /// Mid-recording, only the first step runs. A bounce or a rebuild would
  /// lose the take. Either way the stall is stated, never left to wedge
  /// quietly.
  func scheduleStallWatchdog() {
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 2.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      self.checkSyncStall()
      self.scheduleStallWatchdog()
    }
  }

  /// Catches a secondary stream that never starts at all.
  ///
  /// The stall watchdog above begins from "frames were arriving and stopped",
  /// so it cannot see a stream that delivered nothing from the first frame
  /// while every connection reported healthy. This fires once, four seconds
  /// in: stereo attached and still no complete pairs means the secondary
  /// never landed. It logs the live census and the flag that switches
  /// graphs.
  ///
  /// It is not a verdict on the capture pipeline. Single-half collections
  /// still seal honestly, recording 'no-synchronized-pair-at-shutter'
  /// against the secondary evidence.
  private func scheduleSecondaryDeliveryCheck() {
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 4.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      guard !self.secondaryDeliveryChecked else { return }
      self.secondaryDeliveryChecked = true
      guard self.stereoActive, self.completePairCount == 0 else { return }
      // directFrames says which layer failed. Zero means the platform
      // starved the output itself and there is nothing left to fix on this
      // side; try the other graph. Above zero means frames arrived and none
      // could be paired, which is a timestamp or tolerance problem.
      self.logDiagnosticEvent("secondary stream attached but ZERO complete pairs 4s after start (absent=\(self.secondaryAbsentCount) dropped=\(self.secondaryDroppedCount) directFrames=\(self.directSecondaryFrameCount) graph=\(self.virtualGraphActive ? "virtual-dual-wide" : "multi-input")) — the secondary stream never landed; the virtual graph is one flip away (Settings ▸ Diagnostics ▸ legacyVirtualGraph). census=\(self.connectionCensus())")
    }
  }

  private func checkSyncStall() {
    guard let last = lastCollectionAt else { return } // never delivered: the start watchdog owns that case
    // A dual photo capture starves the sync pipeline for a moment by
    // design. That is not a stall.
    guard !calibrationCaptureInFlight else { return }
    let age = Date().timeIntervalSince(last)
    guard age > 1.5 else {
      stallRecovering = false
      stallBounced = false
      return
    }
    if !stallRecovering {
      // Rebind the synchronizer. Cheap, no session reconfiguration, and
      // the only step allowed mid-recording — a bounce or a rebuild would
      // lose the take, and recording failures surface through the writer.
      stallRecovering = true
      rebuildSynchronizer()
    } else if mode != .video, !stallBounced {
      // Bounce the session in place. startRunning blocks, but the pipeline
      // is already dead, and this is the documented recovery — cheaper than
      // a full rebuild from JS.
      //
      // Both calls go through the exception shim. A throw becomes an error
      // event and the next tick simply escalates, rather than crashing.
      stallBounced = true
      if let live = session {
        if let stopError = ExhibitSessionControl.safelyStop(live) {
          sendError(ExhibitCameraErrorCode.platform, "Stall-recovery stop failed: \(stopError.localizedDescription)")
        } else if let startError = ExhibitSessionControl.safelyStart(live) {
          sendError(ExhibitCameraErrorCode.platform, "Stall-recovery start failed: \(startError.localizedDescription)")
        }
      }
    } else if mode != .video, !stallEscalated {
      // Last resort: tell JS once, so it can rebuild the session.
      stallEscalated = true
      sendEvent("onSyncStalled", [
        "ageSeconds": age,
        "droppedPairCount": droppedPairCount,
        "droppedPrimaryCount": droppedPrimaryCount,
        "droppedSecondaryHalfCount": droppedSecondaryHalfCount,
        // Where the secondary half died — see the counters' own notes.
        "secondaryAbsentCount": secondaryAbsentCount,
        "secondaryDroppedCount": secondaryDroppedCount,
        "completePairCount": completePairCount,
        "staleShutterCount": staleShutterCount,
        "secondaryReseatDone": secondaryReseatDone,
        // The live connection census at the moment of the stall.
        "connections": connectionCensus(),
      ])
    }
  }

  /// Retired. Nothing calls this.
  ///
  /// The one-shot fired a dual photo capture a second into every session to
  /// harvest full calibration. Two reasons it is gone. The secondary photo
  /// output is no longer attached, so it could only ever return the primary
  /// lens, and the committed rig extrinsic needs both — its result was
  /// unreachable by any path that commits. And a maximum-resource photo
  /// capture on a live multi-cam graph can leave an output unwilling to
  /// deliver afterward, which is the failure this is meant to avoid.
  ///
  /// Per-frame intrinsics ride the frame attachments and never depended on
  /// this. The full calibration block commits 'unavailable' rather than a
  /// fabricated matrix.
  ///
  /// The debug flag key stays registered but inert, so a value left flipped
  /// on someone's device reads as a no-op rather than an error. The
  /// machinery below is unreachable and kept for reference.
  func scheduleSessionCalibrationCapture() {
    guard ExhibitDebugFlags.sessionCalibrationPhoto else { return }
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 1.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      self.kickoffSessionCalibrationCapture()
    }
  }
}

// MARK: - Session configuration

extension ExhibitCameraModule {

  /// Asks the hardware what it has. Builds nothing, changes nothing.
  func probeStereoAvailability() -> StereoAvailability {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      return .unreached // no permission, so nothing was probed — not a failure
    }
    guard AVCaptureMultiCamSession.isMultiCamSupported else {
      return .unsupported // the hardware or the OS cannot do multi-cam
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

  /// Picks the stereo partner for a given primary lens. A preference set
  /// from JS wins when it differs from the primary and exists on this
  /// hardware; otherwise the automatic pairing applies. A lens that was
  /// asked for and is not there falls back to automatic, never to a failed
  /// session.
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

  /// Opportunistic third view — hardware probe only. TRUE when a
  /// supported multi-cam device set with 3+ rear devices exists on this
  /// hardware (e.g. a triple-lens Pro). Reported via
  /// capabilities.thirdViewCapable; plumbing is gated behind
  /// ExhibitDebugFlags.thirdViewEnabled (default OFF, UNTESTED).
  private func probeThirdViewSupport() -> Bool {
    guard AVCaptureMultiCamSession.isMultiCamSupported else { return false }
    let discovery = AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .builtInUltraWideCamera, .builtInTelephotoCamera],
      mediaType: .video,
      position: .back
    )
    return discovery.supportedMultiCamDeviceSets.contains { $0.count >= 3 }
  }

  /// EXTENSION POINT — opportunistic third synchronized view.
  /// UNTESTED ON HARDWARE: the flag is OFF by default and MUST stay off in
  /// shipping builds until an on-device soak validates the path. When
  /// enabled on capable hardware (see probeThirdViewSupport), the intended
  /// plumbing — to be written with hardware in hand — is, in order:
  ///   1. pick the third rear stack NOT used by primary/secondary
  ///      (partnerDeviceType generalizes: iterate the discovery session's
  ///      devices, exclude primaryDevice/secondaryDevice types);
  ///   2. attach input + AVCaptureVideoDataOutput EXACTLY like the
  ///      secondary path (native format, alwaysDiscardsLateVideoFrames,
  ///      per-frame intrinsics, RotationPolicy, configureFormat ≤1280×720);
  ///   3. include the output in the AVCaptureDataOutputSynchronizer's
  ///      dataOutputs array (primary stays the master — first array entry);
  ///   4. extend RetainedPair with a third half + delta, counted by the
  ///      same absent/dropped diagnostics split as the secondary;
  ///   5. re-check session.hardwareCost AND systemPressureCost after the
  ///      attach — refuse honestly (single/dual-cam fallback) over budget;
  ///   6. optionally a third PiP connection (ensurePipConnection pattern).
  /// Today this function is deliberately inert beyond the probe: enabling
  /// the flag changes NOTHING in the graph, so a mistaken flip is safe.
  private func prepareThirdViewIfEnabled(in session: AVCaptureMultiCamSession) {
    guard ExhibitDebugFlags.thirdViewEnabled else { return }
    _ = probeThirdViewSupport()
    // Intentionally no graph mutation — see the extension-point note above.
  }

  /// Chooses this device's format: the largest one within the pixel budget
  /// that can hold 30 fps. Multi-cam does not honor session presets the way
  /// single-cam does, so formats are picked explicitly and recorded in the
  /// metadata.
  ///
  /// When requireMultiCam is set, only formats flagged isMultiCamSupported
  /// are eligible. Apple's rule is flat: on a multi-cam session you may set
  /// only such a format. Breaking it fails silently — the second stream
  /// simply never delivers, with every connection reporting healthy.
  ///
  /// If nothing within budget is multi-cam capable, this falls up to the
  /// smallest multi-cam format at 30 fps rather than failing the attach.
  /// The hardware-cost check after commit is the honest arbiter for the
  /// graph as a whole. Every pick and every refusal goes to the diagnostics
  /// log.
  ///
  /// It also pins exposure and white balance to continuous auto. Each
  /// physical camera in a multi-cam graph runs its own, and a secondary
  /// left on factory defaults is what makes one lens look underexposed
  /// beside the other.
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
    // Some multi-cam formats pin the zoom ceiling to the floor, so the UI
    // sweeps and the picture never changes. When the pool holds any format
    // that can actually zoom, drop the pinned ones — a smaller resolution
    // with a working sweep beats a larger one locked at 1x.
    let zoomFloor = device.minAvailableVideoZoomFactor
    let zoomable = pool.filter { fmt in
      if #available(iOS 18.0, *) {
        return fmt.videoMaxZoomFactor > zoomFloor + 0.01
      }
      return true // no per-format zoom cap before iOS 18, so nothing to filter
    }
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
      // Both devices get the same frame duration, which is what keeps the
      // two streams aligned for the synchronizer.
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
      // Log the three best candidates alongside the winner. A log that
      // shows only the pick cannot tell you what the choices were.
      let top3 = pool.sorted(by: byArea).suffix(3).reversed().map { self.formatSummary($0) }.joined(separator: " | ")
      logDiagnosticEvent("format chosen: device=\(device.deviceType.rawValue) \(self.formatSummary(best)) requireMultiCam=\(requireMultiCam) fellUp=\(fellUp) inBudget=\(inBudget.count) candidates=[\(top3)]")
      return true
    } catch {
      logDiagnosticEvent("format apply FAILED: device=\(device.deviceType.rawValue) error=\(error.localizedDescription)")
      return false
    }
  }

  /// One line describing a format, for the log:
  /// "1920x1440@<=60 binned:1 multiCam:1 zoomMax:4.00".
  private func formatSummary(_ format: AVCaptureDevice.Format) -> String {
    let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    let maxFPS = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
    // The per-format zoom ceiling exists only on iOS 18 and later.
    let zoomMax: String
    if #available(iOS 18.0, *) {
      zoomMax = String(format: "%.2f", Double(format.videoMaxZoomFactor))
    } else {
      zoomMax = "n/a"
    }
    return "\(dims.width)x\(dims.height)@<=\(Int(maxFPS)) binned:\(format.isVideoBinned ? 1 : 0) multiCam:\(format.isMultiCamSupported ? 1 : 0) zoomMax:\(zoomMax)"
  }

  /// Writes a line to the diagnostics log. JS forwards the event verbatim
  /// into the on-disk log the Settings screen shows. Fire and forget: it
  /// never gates, delays, or fails a capture.
  private func logDiagnosticEvent(_ message: String) {
    sendEvent("onCameraDiagnostic", ["message": message])
  }

  /// Copies the primary's exposure, white balance, and focus onto the
  /// secondary.
  ///
  /// Two live cameras each run their own metering, and the pro controls
  /// only ever reach the primary. Without this the second lens sits on
  /// factory defaults and one half of every pair looks wrong.
  ///
  /// Best effort, guarded per capability and clamped to each device's own
  /// ranges. A device that cannot take a mode keeps its defaults, and the
  /// committed metadata states what each one actually ran. Nothing here can
  /// fail a capture: if the lock fails, the secondary is left as it was.
  private func mirrorProControlsToSecondary() {
    // Not on the virtual graph. There the virtual device meters for both
    // constituents — that unification is the point of it — and configuring
    // a constituent directly while it streams is not supported.
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
      // Bias applies in the auto modes, clamped to the secondary's range.
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
        // custom-gains support bit, not just mode support (see
        // setWhiteBalanceMode's crash-fix note).
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
        // Locking needs the custom-position capability as well as the
        // mode; the mode bit alone is not enough.
        if secondary.isFocusModeSupported(.locked),
           secondary.isLockingFocusWithCustomLensPositionSupported {
          secondary.setFocusModeLocked(lensPosition: primary.lensPosition, completionHandler: nil)
        }
      @unknown default:
        break
      }
    } catch {
      // The secondary keeps its own state, and the metadata records what
      // each device actually ran.
    }
  }

  /// Attaches one output and wires it to one port by hand.
  ///
  /// Implicit connection forming is not allowed on a multi-cam session.
  /// With several ports of the same media type live, an implicit connection
  /// can land on the wrong port or never materialize at all, and it says
  /// nothing when it does: canAddOutput passes, the output attaches, and it
  /// simply never delivers.
  ///
  /// Returns the live connection, or nil on any refusal — callers keep
  /// their own degradation policy. Every refusal stage is logged with the
  /// caller's label. Nothing in the graph build unwinds silently.
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
    // Ask for the port by device type and position rather than scanning
    // the ports array by media type. An explicit port is still accepted,
    // which is how a virtual device's constituent gets wired by name. The
    // candidate count is logged either way, so an unexpected answer is
    // visible afterward.
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
    // The initializer cannot fail on iOS; canAddConnection is the real
    // gate.
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

  /// A snapshot of every connection, for the diagnostics payloads: whether
  /// each output has a connection to its intended port, whether that
  /// connection is enabled and active, and which device the port belongs
  /// to. A connection that is missing or cross-wired shows up here at once.
  /// String values only, so the shape is stable across the bridge.
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
    // The active formats. These two lines are what settle whether the
    // multi-cam format rule was honored.
    census["primaryFormat"] = primaryDevice.map { self.formatSummary($0.activeFormat) } ?? "none"
    census["secondaryFormat"] = secondaryDevice.map { self.formatSummary($0.activeFormat) } ?? "none"
    return census
  }

  private func connectionSummary(_ connection: AVCaptureConnection?) -> String {
    guard let connection = connection else { return "none" }
    let portDevice = connection.inputPorts.first?.sourceDeviceType?.rawValue ?? "unknown"
    return "enabled=\(connection.isEnabled),active=\(connection.isActive),port=\(portDevice)"
  }

  /// Records when a connection becomes active, timestamped against
  /// startRunning.
  ///
  /// The census samples isActive once; this keeps the whole timeline. A
  /// connection that never activates was rejected at the graph level; one
  /// that goes inactive later was evicted after start, by pressure or by
  /// another reservation.
  ///
  /// isActive is documented as observable. The observer is invalidated in
  /// resetCaptureState, and the log call is fire-and-forget, so it is safe
  /// from whichever thread delivers the change.
  private func observeConnectionActivity(_ connection: AVCaptureConnection?, label: String) {
    guard let connection = connection else { return }
    let observation = connection.observe(\.isActive, options: [.initial, .new]) { [weak self] conn, _ in
      let elapsed = self?.sessionStartWallClock.map { Date().timeIntervalSince($0) } ?? -1
      self?.logDiagnosticEvent("connection isActive: \(label)=\(conn.isActive) t=+\(String(format: "%.3f", elapsed))s")
    }
    connectionActiveObservers.append(observation)
  }

  /// Starts the session in preview mode.
  ///
  /// opts: { lens?, facing?, stereo?, sensorLog?, secondaryLens?, ring? }.
  /// Resolves on the first synchronized frame; the ten-second watchdog
  /// rejects otherwise.
  ///
  /// If the hardware refuses the graph on cost, that is a stated rejection
  /// rather than a quiet downgrade. sensorLog, off by default, arms the
  /// motion log for the whole session.
  func configureSession(opts: [String: Any], promise: Promise) {
    // There is no "already running" rejection: there is exactly one session
    // for the life of the process, and a configure that finds it wired
    // rewires the graph in place below.
    //
    // What still rejects is a configure landing mid-recording. Rewiring the
    // graph underneath a sealing writer orphans the stop already in flight,
    // which is what the recording state machine exists to prevent.
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
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.permission, "Camera permission is required"))
      return
    }

    let lens = ExhibitLens(jsValue: opts["lens"] as? String)
    let newFacing = ExhibitFacing(jsValue: opts["facing"] as? String)
    let wantStereo = (opts["stereo"] as? Bool) ?? true
    let wantSensorLog = (opts["sensorLog"] as? Bool) ?? false
    // An unknown lens string falls back to auto, stated through
    // capabilities, rather than failing the session. A key that is absent
    // entirely leaves any stored preference alone.
    if let sl = opts["secondaryLens"] as? String {
      secondaryLensPreference = (sl == "auto") ? nil : ExhibitLens(rawValue: sl)
    }
    burstSinkWanted = (opts["ring"] as? Bool) ?? false
    burstRing.removeAll()
    burstPostFrames.removeAll()
    burstPostTarget = 0
    lastBurstPTS = nil
    lastBurstRetainedAt = nil

    // Device discovery. The primary follows the selected lens; the stereo
    // partner is chosen on the back only. The front camera is always
    // single-cam, and says so rather than degrading quietly.
    //
    // Rear stereo runs on two physical device inputs, wide and ultra-wide.
    // The alternative is the dual-wide virtual device, one input whose
    // constituent ports carry both lenses, and it is not the default: with
    // the ultra-wide constituent streaming its own port, the virtual
    // device's zoom range collapses to the wide-only zone, and every 0.5x
    // and 1x request clamps upward — the zoom number moves and the picture
    // does not. A wide primary at a true 1x with a free sweep, alongside a
    // fixed 0.5x secondary, cannot be delivered that way.
    //
    // On two inputs, zoom targets the physical wide device across its full
    // range, the ultra-wide stream is unaffected by it, and the preview
    // lands on the wide port, so the viewfinder follows zoom by
    // construction.
    //
    // The virtual graph stays available behind
    // ExhibitDebugFlags.legacyVirtualGraph. Ports are verified before the
    // session is touched; any gap falls back to two inputs with a log
    // line.
    var virtualInput: AVCaptureDeviceInput? = nil
    var virtualWidePort: AVCaptureInput.Port? = nil
    var virtualUWPort: AVCaptureInput.Port? = nil
    if newFacing == .back, wantStereo, lens == .wide,
       ExhibitDebugFlags.legacyVirtualGraph,
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
    // The ultra-wide half of a virtual graph, as a device — needed for
    // rotation, the format census, and the committed metadata. Never
    // configured directly: the virtual device meters for the pair.
    let secondaryConstituent: AVCaptureDevice? = virtualInput?.device.constituentDevices.first(where: { $0.deviceType == .builtInUltraWideCamera })

    guard let primary = virtualInput?.device
      ?? AVCaptureDevice.default(lens.deviceType, for: .video, position: newFacing.position)
      ?? AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: newFacing.position) else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No camera available for the requested facing"))
      return
    }

    var secondary: AVCaptureDevice? = nil
    if virtualInput == nil, newFacing == .back, wantStereo, probeStereoAvailability() == .available {
      // partnerDeviceType honors a lens preference when it is workable and
      // falls back to the automatic pairing when it is not.
      secondary = AVCaptureDevice.default(partnerDeviceType(for: primary.deviceType), for: .video, position: .back)
    }

    // The one session, created once and held for the life of the process.
    // Every configure first strips whatever graph a previous configure —
    // or one that failed mid-build — left behind, atomically with the new
    // wiring inside this single begin-and-commit, and resets the per-graph
    // state. That is the clean slate a fresh session used to provide. On
    // the first run the strip is a no-op.
    let session = Self.processSession
    session.beginConfiguration()
    unwireGraph(session)
    resetCaptureState()

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
      // Wired by hand — see wireOutput.
      session.addInputWithNoConnections(input)
      // Promise no more than 30 fps, so the session bills this input at 30
      // rather than at the format's advertised maximum. Without it, the
      // session must assume the worst case, and a 60-capable format costs
      // twice what is ever used. Set after the add: adding an input resets
      // the override.
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

    // Primary stream format: up to 2560x1440 at 30 fps. 4K alongside a
    // 1080p partner is about a gigabyte a second through one serial queue,
    // which stalls; 1440p keeps it smooth. Sealed stills are unaffected —
    // photo outputs capture at full sensor resolution — and the format that
    // was used is recorded in every capture's metadata.
    //
    // With a stereo partner coming, the primary's format must be multi-cam
    // flagged. Single-cam has no such constraint.
    if !configureFormat(device: primary, maxWidth: 2560, maxHeight: 1440, requireMultiCam: secondary != nil || virtualInput != nil) {
      session.commitConfiguration()
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No usable primary camera format at 30 fps"))
      return
    }

    // The secondary input, falling back to single-cam and saying so.
    //
    // On the virtual graph the pair is inherent: both constituent ports
    // were verified before the session existed, so stereo starts attached
    // and the outputs wire straight to those ports. There is no second
    // input to add.
    var stereoAttached = virtualInput != nil
    if let secondary = secondary {
      // Check the pair against supportedMultiCamDeviceSets before wiring
      // anything — those are the combinations this hardware can actually
      // stream together. An unsupported pair degrades to single-cam here,
      // where the reason can be stated, rather than failing obscurely
      // further down.
      //
      // The list lives on DiscoverySession, not on the session, and holds
      // devices rather than device types, so the comparison goes through
      // deviceType.
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
          // Wired by hand — see wireOutput.
          session.addInputWithNoConnections(input)
          // The same 30 fps billing promise as the primary. Set after the
          // add, which resets it.
          input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
          secondaryInput = input
          stereoAttached = true
        } else {
          // configureFormat logs its own refusal; a canAddInput of false
          // lands here. Neither falls back silently.
          logDiagnosticEvent("secondary attach FAILED at configure: canAddInput=\(session.canAddInput(input)) device=\(secondary.deviceType.rawValue) — single-cam fallback")
        }
      } catch {
        // A failed secondary degrades to single-cam and is reported as
        // stereo:'unsupported'. It never fails the session.
        logDiagnosticEvent("secondary attach THREW at configure: \(error.localizedDescription) — single-cam fallback")
        stereoAttached = false
      } }
    }

    // The primary video output, with no forced pixel format. Leaving
    // videoSettings empty delivers the camera's native format, which is
    // Apple's multi-cam guidance; forcing BGRA makes the ISP convert every
    // frame of both streams and is a leading cause of steady-state drops.
    // Nothing downstream cares: CIImage renders the native format for the
    // JPEG sinks, and the delivery writer takes its hint from the stream.
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
      // Native format, as above. Both synchronized outputs must be
      // configured alike, or the graph converts one stream and not the
      // other.
      out.alwaysDiscardsLateVideoFrames = true
      // The virtual graph wires to the ultra-wide constituent port on its
      // single input; two inputs wire to the secondary input.
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
        // Refused, or wired with no live connection: fall back to
        // single-cam and report stereo:'unsupported'. wireOutput has
        // already logged why.
        logDiagnosticEvent("secondary video output unavailable at configure — single-cam fallback (see wire refusal above)")
        if let sInput = secondaryInput { session.removeInput(sInput) }
        secondaryInput = nil
        stereoAttached = false
      }
    }

    // Per-frame intrinsics ride an attachment on each sample buffer. This
    // must be enabled before startRunning.
    for out in [primaryOut, secondaryOut].compactMap({ $0 }) {
      if let connection = out.connection(with: .video),
         connection.isCameraIntrinsicMatrixDeliverySupported {
        connection.isCameraIntrinsicMatrixDeliveryEnabled = true
      }
    }

    // The photo output, for full-resolution stills and the RAW opt-in. It
    // costs real steady-state resources; the hardware-cost check below is
    // the arbiter. Added inside this configuration, before startRunning,
    // never mid-flight.
    let primaryPhoto = AVCapturePhotoOutput()
    // A photo output binds the virtual device's own port, not a
    // constituent's, so wiring it to the explicit wide port is refused.
    // Passing nil lets the selector resolve the device's video port. On two
    // inputs virtualWidePort is already nil, so the call is the same
    // either way.
    if let pInput = primaryInput,
       wireOutput(primaryPhoto, to: pInput, port: virtualInput != nil ? nil : virtualWidePort, mediaType: .video, in: session, label: "primary-photo") != nil {
      primaryPhotoOutput = primaryPhoto
      applyFullResPhotoPolicy(to: primaryPhoto, device: primary)
    }
    // No secondary photo output is attached, in any configuration. Stereo
    // stills derive from the synchronized video pair instead — see
    // attachFullResStills. What follows from that, all of it stated in the
    // record rather than papered over:
    //
    //   - the secondary still is the pair's ultra-wide frame at stream
    //     resolution, hashed on disk as before and labeled
    //     'video-stream-derived' in its evidence metadata;
    //   - session calibration covers the primary only, so the ultra-wide's
    //     commits 'unavailable' — calibration data rides photo captures and
    //     there is no photo capture here;
    //   - secondary depth stills are never-recorded, reason
    //     'no-photo-output'.
    secondaryPhotoOutput = nil
    if stereoAttached {
      logDiagnosticEvent("secondary photo output not attached by design — stereo stills derive from the synced video pair; ultra-wide session calibration commits 'unavailable'")
    }

    session.commitConfiguration()

    // Log what the graph was billed. hardwareCost and systemPressureCost
    // are only truthful after commit, and each input's frame-duration
    // override is reported as actually applied.
    //
    // systemPressureState is not available on a multi-cam session; for this
    // session type the two costs are the whole pressure story.
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

    // Refuse a graph the OS would throttle. Above 1.0 the requested
    // configuration is over budget: say so rather than run it degraded.
    if session.hardwareCost > 1.0 {
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.hardwareCost,
        "Camera graph cost \(session.hardwareCost) exceeds budget 1.0; refused rather than throttled"
      ))
      return
    }

    // Pressure cost is gated too. An over-budget pressure cost is what
    // makes the system shed a stream silently, so it must not sail past the
    // hardware-cost check above.
    //
    // Over budget declines stereo rather than the whole session: pressure
    // is dynamic and may settle, and single-cam still works. The resolve
    // payload says stereo was declined.
    //
    // This runs before start, so there is no PiP connection yet and the
    // outputs can be removed directly.
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

    // Rotation, asked per device, never a constant angle. Data outputs,
    // photo outputs, and preview connections all get their angle from the
    // device's rotation coordinator. Some front cameras have a
    // portrait-mounted sensor, where a fixed 90 degrees produces sideways
    // preview, video, and stills. The app is portrait-locked, so one read
    // per connection is the whole policy; a lens swap re-runs
    // applyConnectionPolicies.
    //
    // What that rotation means, because everything downstream depends on
    // it: on a video data output connection the rotation is physical. The
    // delivered pixel buffers arrive already rotated, with swapped
    // dimensions. It is not display metadata. Every consumer of these
    // buffers — the writer's track transform, the JPEG sinks — must treat
    // the bytes as upright and add no rotation of its own, or the media
    // comes out sideways. A photo output applies its own compensation from
    // the same angle, so photo connections take the same policy.
    if #available(iOS 17.0, *) {
      if let connection = primaryOut.connection(with: .video) {
        RotationPolicy.apply(to: connection, device: primary)
      }
      if stereoAttached, let secondary = (secondary ?? secondaryConstituent),
         let connection = secondaryOut?.connection(with: .video) {
        RotationPolicy.apply(to: connection, device: secondary)
      }
      if let connection = primaryPhotoOutput?.connection(with: .video) {
        // Off by default; flip it from Settings ▸ Diagnostics to test.
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: connection, device: primary)
        } else if connection.isVideoOrientationSupported {
          connection.videoOrientation = .portrait
        }
      }
      if stereoAttached, let secondary = (secondary ?? secondaryConstituent),
         let connection = secondaryPhotoOutput?.connection(with: .video) {
        // Off by default; flip it from Settings ▸ Diagnostics to test.
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

    // The synchronizer, built after commit so the outputs are fully
    // connected. In single-cam mode it carries one output, which keeps a
    // single code path.
    //
    // On two device inputs it carries the primary only: a synchronizer over
    // two physical devices does not surface the second one. The secondary
    // output gets its own sample-buffer delegate and pairs by timestamp in
    // handleSynchronizedCollection. On the virtual graph both outputs stay
    // in the synchronizer, where it works.
    let outputs: [AVCaptureOutput] = virtualInput != nil
      ? [primaryOut, secondaryOut].compactMap { $0 }
      : [primaryOut]
    let sync = AVCaptureDataOutputSynchronizer(dataOutputs: outputs)
    sync.setDelegate(syncHandler, queue: sessionQueue)
    synchronizer = sync
    if virtualInput == nil, let secondaryOut = secondaryOut {
      secondaryOut.setSampleBufferDelegate(secondaryDirectHandler, queue: sessionQueue)
    }

    // An extension point for a third synchronized view. Untested on
    // hardware, and inert unless thirdViewEnabled is on.
    prepareThirdViewIfEnabled(in: session)

    // Set the module's state before startRunning, so a frame that arrives
    // immediately lands somewhere valid.
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
    self.secondaryDeliveryChecked = false
    self.latestDirectSecondary = nil
    self.directSecondaryFrameCount = 0
    self.lastZoomLogSignature = nil
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

    // Tells the UI when focus is settling, so it can avoid firing the
    // shutter mid-adjustment.
    focusObserver = primary.observe(\.isAdjustingFocus, options: [.new]) { [weak self] _, change in
      let adjusting = change.newValue ?? false
      self?.sendEvent("onAdjustingFocus", ["adjusting": adjusting])
    }

    syncHandler.onCollection = { [weak self] collection in
      self?.handleSynchronizedCollection(collection)
    }
    // the multi-input secondary's direct delegate closures (nil'd
    // in resetCaptureState alongside syncHandler.onCollection).
    secondaryDirectHandler.onFrame = { [weak self] buffer in
      self?.handleDirectSecondaryFrame(buffer)
    }
    secondaryDirectHandler.onDrop = { [weak self] in
      self?.handleDirectSecondaryDrop()
    }

    // Session-lifetime observers attach once. The session object is
    // process-lifetime, so these live as long as it does; removing and
    // re-attaching them on every rewire would double-fire every handler.
    // [weak self] keeps a dead module out of the closures.
    if runtimeErrorObserver == nil {
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

      // Interruption boundaries. When the OS interrupts the graph, or
      // resumes it incompletely, the secondary stream can park while the
      // previews go on showing their last buffers. Without these two lines
      // that looks like nothing happened.
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

      // Thermal policy.
      thermalObserver = NotificationCenter.default.addObserver(
        forName: ProcessInfo.thermalStateDidChangeNotification,
        object: nil,
        queue: nil
      ) { [weak self] _ in
        self?.sessionQueue.async {
          self?.handleThermalState(ProcessInfo.processInfo.thermalState)
        }
      }
    }

    self.startPromise = promise
    self.startPromiseDone = false

    // Start recording when each video connection becomes active. The wall
    // clock is set first, so the initial-state callbacks are timestamped
    // against a real zero.
    sessionStartWallClock = Date()
    observeConnectionActivity(primaryVideoOutput?.connection(with: .video), label: "primaryVideo")
    observeConnectionActivity(secondaryVideoOutput?.connection(with: .video), label: "secondaryVideo")

    // startRunning can throw an Objective-C exception, which would cross
    // the bridge as a crash. The shim catches it; this rejects and tears
    // down instead.
    if let startError = ExhibitSessionControl.safelyStart(session) {
      rejectStart(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Session start failed: \(startError.localizedDescription)"
      ))
      // No teardown: the graph stays wired on the permanent session. Stop
      // the hardware and state the failure; the next configure rewires in
      // place.
      _ = ExhibitSessionControl.safelyStop(session)
      return
    }

    // The motion log starts after startRunning, so a failed start leaves
    // nothing to tear down. CoreMotion is independent of the capture graph,
    // so starting and stopping it cannot disturb the photo pipeline.
    //
    // No IMU hardware, or serious thermal pressure, means no logger, and
    // every capture reports sensorLogState 'unavailable'.
    if sensorLogWanted,
       ExhibitSensorLogger.isHardwareAvailable,
       !sensorLogBlockedByThermal() {
      let logger = ExhibitSensorLogger()
      logger.start()
      sensorLogger = logger
    }

    // The session never changes identity now, so the view's per-session
    // stale-frame shield would never re-arm across an in-place rewire — a
    // facing flip would paint the last rear frame over the live front
    // camera. Re-arm it explicitly: unbind to black, and let the first
    // frame of the new graph lift the shield.
    previewView?.bind(session: nil)
    pushSessionToPreview()
    ensurePipConnection(in: session)
    scheduleStallWatchdog()
    scheduleSecondaryDeliveryCheck()

    // A census right after start. isActive only means anything while
    // running. The first-frame census is the ground truth; this one exists
    // to catch a graph that never delivers a frame at all.
    logDiagnosticEvent("configureSession started: graph=\(virtualGraphActive ? "virtual-dual-wide" : "multi-input") stereoAttached=\(stereoAttached) census=\(connectionCensus())")

    // Hand the secondary the primary's current metering. Fresh devices are
    // already on continuous auto; a reconfigured session may carry stored
    // pro controls.
    mirrorProControlsToSecondary()

    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self, !self.startPromiseDone else { return }
      self.rejectStart(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No video frames arrived within 10s of start"))
      // Stop, do not tear down — the graph stays wired and the next
      // configure rewires it in place.
      if let session = self.session { _ = ExhibitSessionControl.safelyStop(session) }
    }
    self.startTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: timeout)
  }

  /// A stable name for a format: "<deviceType>:<index>", the format's
  /// position in the device's list. Stable for a given phone model and OS,
  /// and committed in the metadata so a capture can be reproduced.
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

  // MARK: - Frame handling (sessionQueue only)

  /// Records a pair whose secondary half is missing. The pair is skipped;
  /// two unpaired frames are never presented as a pair.
  ///
  /// Absent and dropped are counted apart. On the virtual graph, absent
  /// means the synchronizer offered no data object and dropped means it
  /// offered one already marked dropped. On two device inputs, where the
  /// secondary delivers directly, a pairing miss counts as absent, and the
  /// direct frame count and drop callback carry the arrival evidence
  /// instead.
  ///
  /// The silence watchdog cannot see this, because the primary keeps
  /// arriving. So a streak of 150 and a streak of 300 each trigger one
  /// recovery step — roughly five and ten seconds — and a wedged secondary
  /// gets a chance to come back instead of being absent all session.
  private func recordSecondaryMiss(absent: Bool) {
    droppedPairCount += 1
    droppedSecondaryHalfCount += 1
    consecutiveSecondaryDrops += 1
    if absent {
      secondaryAbsentCount += 1
    } else {
      secondaryDroppedCount += 1
    }
    if consecutiveSecondaryDrops == 150, !stallRecovering {
      stallRecovering = true
      // Log with the live census, so the connection state at the moment
      // the secondary starves is recoverable afterward. The message names
      // the mechanism this graph actually uses: rebuild the synchronizer,
      // or re-attach the direct delegate.
      logDiagnosticEvent("secondary flood rung 1 (150 consecutive, \(virtualGraphActive ? "rebuild synchronizer" : "re-attach direct secondary delegate")): census=\(connectionCensus())")
      rebuildSynchronizer()
    } else if consecutiveSecondaryDrops == 300, !secondaryReseatDone {
      // A rebind cannot revive a stream the platform has parked. Remove
      // and re-add the secondary video output, once per session, for a
      // fresh connection and a fresh buffer pool.
      secondaryReseatDone = true
      logDiagnosticEvent("secondary flood rung 2 (300 consecutive, reseat output): census=\(connectionCensus())")
      reseatSecondaryVideoOutput()
    }
  }

  /// Takes one directly-delivered secondary frame.
  ///
  /// Runs on sessionQueue at frame rate, and deliberately does almost
  /// nothing: count the arrival, and pin the newest buffer with its
  /// timestamp. At most one is held, so the pool keeps recycling. Pairing
  /// happens on the primary's cadence in handleSynchronizedCollection, and
  /// intrinsics are read from the buffer at commit time rather than here.
  private func handleDirectSecondaryFrame(_ buffer: CMSampleBuffer) {
    directSecondaryFrameCount += 1
    latestDirectSecondary = (buffer, CMSampleBufferGetPresentationTimeStamp(buffer), Date())
  }

  /// The platform dropped a directly-delivered secondary frame. Counted the
  /// same way the virtual graph counts its own drops.
  private func handleDirectSecondaryDrop() {
    secondaryDroppedCount += 1
  }

  private func handleSynchronizedCollection(_ collection: AVCaptureSynchronizedDataCollection) {
    guard let primaryOut = primaryVideoOutput,
          let primaryData = collection.synchronizedData(for: primaryOut) as? AVCaptureSynchronizedSampleBufferData else {
      return
    }

    if primaryData.sampleBufferWasDropped {
      droppedPairCount += 1
      droppedPrimaryCount += 1
      // A dropped frame is the platform's backpressure signal; Apple directs
      // delegates to release retained buffers in response. If the retained
      // pair has gone stale anyway (past the 500 ms shutter freshness
      // window — a capture would never commit it), drop the reference NOW so
      // its pixel buffers return to the output pools. The old code held the
      // last good pair forever once every frame started dropping, which can
      // turn transient pool pressure into a self-sustaining wedge. Releasing
      // never fabricates anything: capture simply waits for a fresh pair
      // and rejects E_STALE_PAIR if none arrives.
      if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) >= 0.5 {
        latestPair = nil
      }
      return
    }

    // Where the secondary half comes from depends on the graph. On the
    // virtual graph the synchronizer carries both outputs. On two device
    // inputs it never surfaces the second one, so the secondary rides its
    // own delegate and is paired by timestamp here. Nothing is lost either
    // way: the delta between the two frames was always computed here
    // rather than taken from the synchronizer.
    var secondaryBuffer: CMSampleBuffer? = nil
    if stereoActive, secondaryVideoOutput != nil {
      if virtualGraphActive {
        let data = collection.synchronizedData(for: secondaryVideoOutput!) as? AVCaptureSynchronizedSampleBufferData
        if let data = data, !data.sampleBufferWasDropped {
          secondaryBuffer = data.sampleBuffer
        } else {
          recordSecondaryMiss(absent: data == nil)
        }
      } else {
        // Pair with the newest ultra-wide frame within 25 ms of the
        // primary's timestamp, and still fresh by the wall clock.
        // Hardware-synced streams land well inside one 33 ms frame, so 25
        // ms absorbs phase skew without ever pairing across frames at 30
        // fps. A match is consumed: one frame can never pair twice. A miss
        // counts as absent.
        let primaryPTSCandidate = CMSampleBufferGetPresentationTimeStamp(primaryData.sampleBuffer)
        if let candidate = latestDirectSecondary,
           primaryPTSCandidate.isValid, candidate.pts.isValid,
           abs(CMTimeGetSeconds(candidate.pts) - CMTimeGetSeconds(primaryPTSCandidate)) * 1000.0 <= 25.0,
           Date().timeIntervalSince(candidate.receivedAt) < 0.5 {
          secondaryBuffer = candidate.buffer
          latestDirectSecondary = nil
        } else {
          recordSecondaryMiss(absent: true)
        }
      }
    }

    let primaryPTS = CMSampleBufferGetPresentationTimeStamp(primaryData.sampleBuffer)
    var deltaMs: Double? = nil
    if let secondaryBuffer = secondaryBuffer {
      let secondaryPTS = CMSampleBufferGetPresentationTimeStamp(secondaryBuffer)
      if primaryPTS.isValid, secondaryPTS.isValid {
        deltaMs = (CMTimeGetSeconds(secondaryPTS) - CMTimeGetSeconds(primaryPTS)) * 1000.0
      }
    }

    // Keep the newest pair and drop the previous one, so the pool is never
    // starved.
    //
    // This callback runs at frame rate on the delivery queue and does
    // nothing but timestamp arithmetic and one struct store — no intrinsics
    // extraction, no JSON, nothing that allocates. Work done here delays the
    // next collection and is the usual cause of steady-state dropped pairs.
    let now = Date()
    lastCollectionAt = now
    if secondaryBuffer != nil {
      consecutiveSecondaryDrops = 0
    }
    // Take the sample buffers out here, inside the callback — the only
    // window where the wrappers hold valid payloads. Storing them retains
    // the buffers themselves; the wrappers go away with this scope.
    let pair = RetainedPair(
      primary: primaryData.sampleBuffer,
      secondary: secondaryBuffer,
      deltaMs: deltaMs,
      receivedAt: now
    )
    latestPair = pair

    // Count pairs that have both halves. Zero here while the miss counters
    // climb means the secondary never landed this session.
    let frameComplete = secondaryBuffer != nil
    if stereoActive, frameComplete {
      completePairCount += 1
    }

    // The shutter ring. Preview mode only, and only when the sink is on.
    // Appending releases the oldest frame, so the number of held buffers
    // stays bounded.
    //
    // Frames with a valid primary are kept even when the secondary half is
    // missing, and the index entry for each one states its own
    // completeness. A secondary that floods degrades the burst to
    // primary-only frames rather than producing no burst at all. Every
    // frame commits exactly the halves it has.
    //
    // Only frames whose timestamp advances are kept. A starved pipeline
    // redelivers collections built on the same buffer, which would fill the
    // ring with identical frames and read as no movement at all while the
    // gyroscope says otherwise. A duplicate is not evidence; a short burst
    // is.
    if burstSinkWanted, mode == .preview {
      let framePTS = CMSampleBufferGetPresentationTimeStamp(primaryData.sampleBuffer)
      let advances = (!framePTS.isValid) || (lastBurstPTS.map { CMTimeCompare(framePTS, $0) > 0 } ?? true)
      // Keep at most one frame per cadence interval, so the burst spans
      // the window the UI advertises rather than a fraction of it.
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

    // The first frame resolves configureSession or startVideo and reports
    // preview readiness. The payload names which signal fired.
    if !startPromiseDone {
      if mode == .video {
        videoStartDate = Date()
      }
      resolveStart([
        "sessionId": sessionId,
        "startedAtMs": currentEpochMs(),
        "stereo": stereoActive ? StereoAvailability.available.rawValue : StereoAvailability.unsupported.rawValue,
        // Which graph this session runs: "virtual-dual-wide" for one input
        // with constituent ports, "multi-input" for two device inputs.
        "graph": virtualGraphActive ? "virtual-dual-wide" : "multi-input",
        "hardwareCost": session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
        // The connection census at first frame, where a missing or
        // cross-wired connection is visible.
        "connections": connectionCensus(),
      ])
      // The same census into the log. isActive at first frame is the
      // ground truth for whether media is flowing through a connection.
      logDiagnosticEvent("first frame: census=\(connectionCensus())")
      pushSessionToPreview(readySignal: "first-synchronized-frame")
      // No calibration one-shot here — see scheduleSessionCalibrationCapture.
    }

    // In video mode, feed the writer and commit pairs on the cadence.
    if mode == .video {
      handleVideoFrame(primaryData.sampleBuffer)
      maybeDumpPeriodicPair()
    }
  }

  /// Reads the intrinsic matrix off a sample buffer's attachment. Nine
  /// floats, row-major. nil when the attachment is absent — which is
  /// reported as absent, never filled in.
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

// MARK: - Session calibration one-shot (retired; see below)

extension ExhibitCameraModule {

  /// Fires one dual photo capture per session configuration to harvest full
  /// calibration — extrinsics and distortion maps — for both devices.
  ///
  /// The inter-camera extrinsic is fixed in the hardware and does not change
  /// frame to frame, so one capture per configuration is an honest
  /// commitment. It is labeled `session-photo-capture` so the desk can tell
  /// it apart from per-frame data. If it fails, the map stays empty and
  /// every capture's calibration says so.
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
    // Do not fire onto a graph that is already dropping frames. A photo
    // capture attempted under pressure can refuse and leave the output
    // unwilling to deliver afterward. Skipping costs one calibration, which
    // commits 'unavailable'; not skipping can cost the session.
    guard droppedPairCount <= 20 else {
      sendError(
        ExhibitCameraErrorCode.platform,
        "Session calibration one-shot skipped: pipeline already dropping frames (\(droppedPairCount) dropped pairs, primary \(droppedPrimaryCount), secondary-half \(droppedSecondaryHalfCount)) — calibration commits 'unavailable' this session"
      )
      return
    }
    calibrationCaptureInFlight = true
    // Safety: if a photo delegate never fires (pipeline wedged), the flag
    // must not silence the stall watchdog forever. Firing the safety ALSO
    // rebinds the synchronizer — a photo capture that never returned left
    // the stream in an unknown state, and the rebind is the cheap recovery.
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 5.0) { [weak self] in
      guard let self = self, self.sessionId == id, self.calibrationCaptureInFlight else { return }
      self.calibrationCaptureInFlight = false
      self.rebuildSynchronizer()
    }

    // One photo at a time. A photo capture on a live multi-cam graph is the
    // heaviest moment there is — the video outputs drop frames for its
    // duration — and firing two back to back wedges the pipeline. Going one
    // at a time halves the spike, and rebinding the synchronizer after the
    // last one resets any residual disruption instead of leaving it for the
    // rest of the session.
    fireNextCalibrationCapture(targets: targets, index: 0, sessionID: id)
  }

  /// Fires targets[index], then recurses on its completion (sessionQueue).
  /// After the last target: clears the in-flight flag and rebinds the
  /// synchronizer (see above). Failure of one capture never blocks the next
  /// — partial calibration is stated in every committed JSON, never faked.
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
    // No flash for a calibration frame; the pixels are discarded. The
    // setter validates against supportedFlashModes on assignment and throws
    // an uncatchable exception on a mismatch, so assign only when the mode
    // is supported.
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
    // Hold the handler until the delegate fires; the closure releases it
    // on completion.
    photoHandlers.append(handler)
    // Validating these settings against a live multi-cam graph can throw.
    // A throw becomes a stated skip and the sequence moves to the next
    // target.
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

// MARK: - Taking a still

extension ExhibitCameraModule {

  /// Takes a still. opts: { deliveryPath, evidenceDir, raw?: Bool }.
  ///
  /// The delivery picture always lands or the call rejects. Every other
  /// artifact can degrade, and each one reports recorded, failed, or
  /// never-recorded with a reason.
  func capture(opts: [String: Any], promise: Promise) {
    // The session object now outlives stopSession, so the honest gate is
    // "not running" rather than "nil".
    guard session?.isRunning == true else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No camera session is running"))
      return
    }
    guard !captureInFlight else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.busy, "A capture is already in flight"))
      return
    }
    // Validate the paths here; runCapture re-parses them after any wait for
    // a fresh frame.
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          exhibitCameraURL(for: deliveryPath) != nil,
          exhibitCameraURL(for: evidenceDir) != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }
    // A pair older than half a second is stale: a covered or transitioning
    // camera must not have old pixels committed as now.
    //
    // Stale does not mean fail. The pipeline can stall while the preview
    // keeps painting, and rejecting outright makes stills unusable exactly
    // when they matter. So a stale or missing pair waits up to 900 ms for
    // the next fresh one. Old pixels are never reused — the committed pair
    // carries its own timestamp — and the failure message carries the
    // pipeline state, so the error text alone is diagnosable.
    if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) < 0.5 {
      runCapture(opts: opts, promise: promise, pair: pair)
    } else {
      // A shutter that found no fresh pair at fire time.
      staleShutterCount += 1
      awaitFreshPair(opts: opts, promise: promise, deadline: Date().addingTimeInterval(0.9))
    }
  }

  /// Checks every 50 ms for a fresh pair until the deadline. Everything
  /// here runs on sessionQueue, so this and the frame handler cannot race.
  private func awaitFreshPair(opts: [String: Any], promise: Promise, deadline: Date) {
    if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) < 0.5 {
      runCapture(opts: opts, promise: promise, pair: pair)
      return
    }
    if Date() >= deadline {
      // A starved pipeline must not dead-end the shutter. Under a chronic
      // flood the retained pair is released as it goes stale, so a fresh
      // one may never arrive at all, and rejecting would make every still
      // unusable on exactly the devices where the picture matters.
      //
      // Instead the photo output takes the delivery still directly, at full
      // sensor resolution. The commit states the degradation: stereo
      // unavailable with this reason, every pair-derived artifact
      // never-recorded, and the stereo geometry absent rather than
      // invented. Real failures still reject.
      let ageText: String
      if let pair = latestPair {
        ageText = String(format: "%.1fs", Date().timeIntervalSince(pair.receivedAt))
      } else if let last = lastCollectionAt {
        ageText = "\(String(format: "%.1fs", Date().timeIntervalSince(last))); stale pair released under drops"
      } else {
        ageText = "no frames yet"
      }
      let reason = "no fresh synchronized frame within 900ms at shutter (latest: \(ageText); dropped pairs: \(droppedPairCount), primary: \(droppedPrimaryCount), secondary-half: \(droppedSecondaryHalfCount); stereo: \(stereoActive ? "on" : "off"); secondary-absent: \(secondaryAbsentCount), secondary-dropped: \(secondaryDroppedCount), complete-pairs: \(completePairCount), stale-shutters: \(staleShutterCount), reseat: \(secondaryReseatDone ? 1 : 0))"
      // Rebind now, so the pipeline is usually flowing again by the next
      // tap. The watchdog would get there eventually, but a degraded
      // shutter is the user telling us it is needed.
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

  /// Takes the still from the photo output alone, when no fresh pair
  /// arrived within the shutter window.
  ///
  /// The picture is full sensor resolution with the platform's own ISP and
  /// EXIF. What the record says about it:
  ///
  ///   - stereo is 'unavailable', with the reason string attached as a
  ///     checkable fact rather than a euphemism;
  ///   - every pair-derived artifact — secondary frame, calibration,
  ///     timestamps, metadata block — is never-recorded with the reason
  ///     'no-synchronized-pair-at-shutter', so the three-state contract
  ///     holds and the seal queue's validation passes honestly;
  ///   - stereo geometry is absent, not invented;
  ///   - deliveryStillSource says exactly what the delivery pixels are, and
  ///     the photo's own EXIF and flash outcome merge in, because on this
  ///     path the delivery still is the photo.
  ///
  /// Only real capture failures reject: no photo delivered, no photo
  /// output, a write that failed. Every path settles the promise, with a
  /// ten-second watchdog behind it, so the capture state cannot wedge.
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

    // Same discipline as runCapture: every path settles exactly once.
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
      // The settings are declared below this closure, so the dump reads
      // the live output and connection state instead.
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

    // Flash, same policy as captureFullResStill. The preference is checked
    // against this output's supported modes; an unsupported one degrades to
    // off with the reason stated.
    //
    // The setter validates on assignment and raises an uncatchable
    // exception on a mismatch, so the decision is made once here and only
    // supported values are ever assigned. An unassigned setting means no
    // flash.
    let pref = photoFlashPreference
    let flashDecision: AVCaptureDevice.FlashMode?
    var flashApplied = false
    var flashNote: String? = nil
    if pref != .off, photoOutput.supportedFlashModes.contains(pref.avFlashMode) {
      flashDecision = pref.avFlashMode
      flashApplied = true
    } else if photoOutput.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      flashDecision = AVCaptureDevice.FlashMode.off
      if pref != .off {
        flashNote = "flash mode '\(pref.rawValue)' is not in this output's supportedFlashModes — captured without the strobe (stated, not faked)"
      }
    } else {
      flashDecision = nil
      if pref != .off {
        flashNote = "flash mode '\(pref.rawValue)' is not in this output's supportedFlashModes — captured without the strobe (stated, not faked)"
      }
    }

    // (field bug, 8/23 5:07 PM): Apple allows an AVCapturePhotoSettings
    // object exactly ONE trip through capturePhoto — the automatic retry
    // below re-fired the SAME instance and died at fire time with
    // "Settings may not be re-used", a retry that could NEVER succeed.
    // Settings construction is now a FACTORY: the first fire and the retry
    // each get a FRESH, identically-configured object. The depth reason is
    // captured from the first build — it is a property of the live output,
    // not of the settings instance.
    var depthNotRequestedReason: String? = nil
    let makeSettings: () -> AVCapturePhotoSettings = {
      let fresh = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      if let mode = flashDecision {
        fresh.flashMode = mode
      }
      // The dimensions clamp is on by default; the flag is the escape
      // hatch.
      if ExhibitDebugFlags.photoMaxDimensionsPolicy, #available(iOS 16.0, *) {
        fresh.maxPhotoDimensions = photoOutput.maxPhotoDimensions
      }
      // Ask for depth only when this output really supports it for the
      // current device and format. When it is not requested, the reason
      // rides the depth fields; when delivery or extraction fails, depth is
      // recorded as not recorded. Neither fails the capture.
      let reason = self.requestDepthIfHonest(settings: fresh, output: photoOutput)
      if depthNotRequestedReason == nil {
        depthNotRequestedReason = reason
      }
      return fresh
    }
    let settings = makeSettings()

    var handlerRef: ExhibitPhotoHandler?
    var retried = false
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      self?.sessionQueue.async { [weak self] in
        guard let self = self else { return }
        guard let photo = photo, let data = photo.fileDataRepresentation() else {
          // One automatic retry after a beat. Transient resource
          // contention clears; a wedged output fails twice and the message
          // says so. The handler stays retained through the retry and is
          // released whichever way it settles.
          if !retried {
            retried = true
            self.sessionQueue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
              // Retry through handlerRef; capturing `handler` itself here
              // would be a use before initialization.
              guard let self = self, !settled, let delegateHandler = handlerRef else { return }
              // A fresh settings object each time: a settings instance is
              // good for one capture, and re-firing the first one throws.
              // A validation throw settles as a stated failure.
              if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: makeSettings(), delegate: delegateHandler) {
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
          // try?: on a fresh delivery path there is nothing to remove, and
          // that throw must not fail the write.
          try? FileManager.default.removeItem(at: deliveryURL)
          try data.write(to: deliveryURL, options: .atomic)
        } catch {
          settle(.failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.sink, "Cannot write delivery still: \(error.localizedDescription)")))
          return
        }

        // The delivery still is this photo, so its EXIF and flash outcome
        // are the delivery's own facts and merge into captureSettings.
        let exif = PhotoExifExtractor.dictionary(from: photo)
        let fired = PhotoExifExtractor.flashFired(from: exif)
        // The stabilization mode actually in force on this connection at
        // the commit instant, as the API reports it. nil where the
        // connection has none — the builder then omits the key rather than
        // substituting the mode that was asked for.
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
        // The color profile read out of the delivered JPEG's own bytes.
        // Omitted when there is no profile name to read, never assumed from
        // what was requested.
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

        // Depth is written only after the delivery still is safely on
        // disk. Any failure here becomes a stated never-recorded or error.
        // The photo is the artifact that matters, and depth must never
        // cost it.
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

        // Read mirroring off the connection that was actually configured,
        // rather than inferring it from which camera this is.
        let mirrored = photoOutput.connection(with: .video)?.isVideoMirrored ?? false

        var payload: [String: Any] = [
          "captureId": captureId,
          "deliveryPath": deliveryURL.path,
          "capturedAtMs": capturedAtMs,
          // What the desk needs to project anything: which camera this
          // was, and its real horizontal field of view as the device
          // reports it. Sun and horizon math is wrong without both, and a
          // nominal field of view is a guess.
          "facing": device.position == .front ? "front" : "back",
          "primaryHfovDeg": Double(device.activeFormat.videoFieldOfView),
          // Depth: the bytes on disk, their digest, and the metadata that
          // says what kind of map it is and how accurate. The commit layer
          // takes these verbatim.
          "depth": depth.evidence,
          "depthSha256": depth.sha256 as Any? ?? NSNull(),
          "depthMetadata": depth.metadata as Any? ?? NSNull(),
          // What the session is capable of, unchanged. The degradation is
          // stated by stereoStatus rather than by rewriting this.
          "stereo": self.stereoActive ? "available" : (self.stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
          "stereoStatus": "unavailable",
          "stereoUnavailableReason": reason,
          "frontMirrored": mirrored,
          // Everything derived from the pair: never-recorded, with the
          // reason. The three-state contract stays intact for the seal
          // queue, and no geometry is invented.
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
          // There is no separate full-sensor artifact on this path: the
          // delivery still is the photo.
          "fullResStill": EvidencePathBuilder.neverRecorded("delivery-still-is-the-full-sensor-photo"),
          "fullResStillSha256": NSNull(),
          "fullResStillDimensions": NSNull(),
          "fullResSecondary": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "fullResSecondarySha256": NSNull(),
          "fullResSecondaryDimensions": NSNull(),
          // The shutter ring is not attempted here, and says so.
          "ringBufferDir": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "ringFrameCount": 0,
          // The connection census at the moment of commit, so every
          // capture carries the state of the graph that produced it.
          "connections": self.connectionCensus(),
        ]

        // The motion slice, anchored to the wall clock because there is no
        // pair timestamp on this path. The file states its own requested
        // bounds. A failed log never blocks the still.
        self.attachSensorLogFieldsDegraded(
          captureId: captureId,
          capturedAtMs: capturedAtMs,
          evidenceDirURL: evidenceDirURL
        ) { [weak self] sensorFields in
          guard let self = self else { return }
          for (key, value) in sensorFields { payload[key] = value }
          // RAW is a second photo capture and is not attempted here. Said
          // out loud rather than left missing.
          payload["rawDng"] = EvidencePathBuilder.neverRecorded(wantRaw ? "degraded-single-lens-capture" : "not-requested")
          self.sessionQueue.async { settle(.success(payload)) }
        }
      }
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // capturePhoto validates these settings against the live graph and
    // raises an Objective-C exception on a mismatch, which Swift cannot
    // catch. The fire goes through the trampoline, and a throw becomes this
    // path's stated failure.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      settle(.failure(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Single-lens fallback capture threw at fire time: \(captureError.localizedDescription); \(self.photoFailureDump(path: "degraded", settings: settings, output: photoOutput, device: device))"
      )))
    }
  }

  /// The motion slice for the degraded path. Same window and same
  /// three-state fields as attachSensorLogFields, but anchored to the mach
  /// clock at photo delivery, since there is no pair timestamp here. Calls
  /// completion exactly once, on sessionQueue.
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
      guard let self = self else { return } // module gone; the capture watchdog owns the promise
      guard self.sessionId == id else {
        completion(self.sensorLogFields(state: "unavailable"))
        return
      }
      completion(self.sensorWindowFields(
        url: url,
        from: shutterSec - 2.0,
        to: shutterSec + 0.5,
        anchorStartedAtMs: capturedAtMs,
        // No pair timestamp here, so the shutter estimate is the event
        // instant on the boot clock, not the instant the log was flushed.
        anchorBootSec: shutterSec,
        logger: logger
      ))
    }
  }

  /// The capture itself, run once a fresh pair is in hand — immediately
  /// when the pipeline is healthy, after a short wait when it stumbled.
  private func runCapture(opts: [String: Any], promise: Promise, pair: RetainedPair) {
    // capture() validated these before the wait; re-parse them here so a
    // malformed path still rejects rather than crashing.
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

    // A ten-second watchdog covering everything below, including the RAW
    // capture.
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
      // The full-resolution and RAW captures ride this chain, and a wedged
      // photo output is one way to reach this timeout, so dump its state.
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Capture timed out after 10s; \(self.photoFailureDump(path: "normal", settings: nil, output: self.primaryPhotoOutput, device: self.primaryDevice))"))
    }
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: watchdog)

    // commitPair takes a snapshot of session state here, then encodes and
    // writes on sinkIOQueue — the delivery queue never encodes. Its
    // completion comes back onto sessionQueue.
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
        // The shutter ring: the frames already held plus the next few,
        // written before the full-resolution captures fire. A photo
        // capture on a live graph is the heaviest moment there is, and
        // would starve the frames that come after the shutter. This never
        // rejects the capture; its result is a path and a frame count.
        self.attachShutterBurst(
          shutterPair: pair,
          captureId: captureId,
          evidenceDirURL: evidenceDirURL,
          payload: payload
        ) { [weak self] burstPayload in
          guard let self = self else { return }
        // The motion slice joins the payload before it settles. With the
        // log live this waits out a short drain after the shutter, well
        // inside the watchdog; with it off the completion fires
        // synchronously and nothing about the capture changes. A failed log
        // never blocks the still.
        self.attachSensorLogFields(
          pair: pair,
          captureId: captureId,
          capturedAtMs: capturedAtMs,
          evidenceDirURL: evidenceDirURL
        ) { [weak self] sensorFields in
          guard let self = self else { return }
          var final = burstPayload
          for (key, value) in sensorFields { final[key] = value }
          // Full-resolution stills from the photo output, one output at a
          // time — firing them together starves the graph. The flash
          // outcome and the OS-written EXIF fold into captureSettings. A
          // failure here never rejects the capture: the delivery still has
          // already landed, and the failure is stated as a path.
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

  // MARK: - Frames around the shutter

  /// Settles the post-shutter collection exactly once — early when the
  /// target count arrives, otherwise at the timeout — always on
  /// sessionQueue.
  ///
  /// A session rebuild clears the continuation in resetCaptureState, and the
  /// capture in flight then settles through its own watchdog, which is how
  /// every teardown-mid-capture is handled.
  private func finishBurstCollection() {
    guard let continuation = burstContinuation else { return }
    burstContinuation = nil
    burstTimeout?.cancel()
    burstTimeout = nil
    burstPostTarget = 0
    continuation()
  }

  /// Arms the collection of post-shutter frames and, when it settles,
  /// writes the burst on sinkIOQueue. Completion fires exactly once, on
  /// sessionQueue.
  ///
  /// Frames from more than two seconds before the shutter are excluded. An
  /// old frame is never passed off as one taken around the shutter. Under a
  /// flood that can leave nothing at all, which commits as an error path
  /// rather than a shorter burst pretending to be a full one.
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
    // Preview mode only. Pool pressure during a recording is not a trade
    // worth making, and the reason is stated rather than left implied.
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

  /// Encodes and writes the burst off the frame queue.
  ///
  /// Each frame contributes a downsampled primary JPEG, and a secondary one
  /// where it exists. The JSON index carries each frame's timestamp, its
  /// host-clock delta, and its offset from the shutter, so the desk can
  /// check the claim that these are frames around the shutter against the
  /// committed data rather than taking it on faith.
  ///
  /// A frame that fails degrades on its own, with a null path and a note in
  /// the index. Zero committed frames is an error path, never a rejected
  /// capture.
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
          // The ring keeps primary-only frames during a flood, so each
          // entry states its own completeness.
          "complete": frame.secondary != nil,
        ]
        // A secondary buffer only enters a pair when the delivery callback
        // confirmed it was not dropped, so there is nothing to re-check
        // here.
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
          // Each frame's own perceptual hash rides the index — see
          // dHash64.
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

  // MARK: - The motion log slice

  /// The three states, shared by the photo and video paths:
  ///
  ///   recorded     a path
  ///   unavailable  no path — the toggle is off, there is no IMU, or the
  ///                logger is parked for heat. Nothing was going to be
  ///                recorded.
  ///   failed       no path, plus the error. It was asked for and it died.
  ///
  /// sensorLogError rides only in the failed case.
  private func sensorLogFields(state: String, path: String? = nil, error: String? = nil) -> [String: Any] {
    var fields: [String: Any] = [
      // The explicit cast keeps the dictionary's type unambiguous; mixing
      // a String literal with NSNull does not always infer.
      "sensorLogPath": path as Any? ?? NSNull(),
      "sensorLogState": state,
    ]
    if let error = error {
      fields["sensorLogError"] = error
    }
    return fields
  }

  /// Flushes one window out of the ring and folds the outcome into the
  /// three fields above.
  ///
  /// A window with no samples writes no file and reports unavailable — an
  /// empty log is not evidence. A write that fails reports failed with the
  /// error text. Neither throws back into a capture path.
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

  /// The slice for a still: two seconds before the shutter to half a second
  /// after, written beside the other evidence.
  ///
  /// Completion fires exactly once, on sessionQueue. When the log is off it
  /// fires synchronously, so a disabled log adds no latency to the shutter.
  /// When it is live, it waits out a short drain first, so the tail after
  /// the shutter is actually in the ring before the slice is taken.
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
    // The primary frame's timestamp comes off the same clock the motion
    // samples ride, so the window needs no conversion. If it is invalid,
    // now is used instead, and the file's window line states the bounds
    // that were actually requested.
    let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(pair.primary))
    let shutterSec = pts.isFinite ? pts : ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    let windowStart = shutterSec - 2.0
    let windowEnd = shutterSec + 0.5
    let url = evidenceDirURL.appendingPathComponent("sensors-\(captureId).jsonl")
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 0.55) { [weak self] in
      guard let self = self else { return } // module gone; the capture watchdog owns the promise
      guard self.sessionId == id else {
        // The session was rebuilt mid-drain. There is nothing to slice.
        completion(self.sensorLogFields(state: "unavailable"))
        return
      }
      completion(self.sensorWindowFields(
        url: url,
        from: windowStart,
        to: windowEnd,
        anchorStartedAtMs: capturedAtMs,
        // The anchor ties the shutter's own instant to the shutter's wall
        // clock, not the instant the log was flushed.
        anchorBootSec: shutterSec,
        logger: logger
      ))
    }
  }

  /// Everything a pair commit needs out of sessionQueue-confined state,
  /// taken up front so the encode and write can run on sinkIOQueue without
  /// touching module state.
  ///
  /// Device and connection references ride along and are read there. Those
  /// reads are atomic getters — the same reads, just off the frame queue.
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
    // The drops, split at the commit instant. A total alone cannot tell
    // session-wide pressure on the primary from a failure in the stereo
    // path itself.
    let droppedPrimaryCount: Int
    let droppedSecondaryHalfCount: Int
    // Absent, dropped, and complete, at the commit instant.
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
    // The stabilization mode actually in force, as the connection reports
    // it. The fields above are the mode that was asked for. nil where the
    // connection has no stabilization.
    let primaryStabActive: String?
    let secondaryStabActive: String?
    let primaryHDR: Bool?
    let secondaryHDR: Bool?
    let configuredFPS: Double
    // The flash preference and the output's supported modes, taken
    // together so the settings block is built from one instant.
    let photoFlashPreference: ExhibitPhotoFlash
    let flashSupportedModes: [String]
    /// The primary connection's mirroring at the commit instant, as it was
    /// actually set. Committed as frontMirrored. nil only when there was no
    /// connection to read.
    let primaryConnectionMirrored: Bool?
  }

  /// Commits a pair's artifacts in two phases.
  ///
  /// First, on sessionQueue: take a snapshot of module state. Dictionary
  /// and scalar assembly only — no encoding, no file I/O.
  ///
  /// Then, on sinkIOQueue: the JPEG encodes and every write. A 1440p encode
  /// plus several downsample attempts plus five writes runs longer than
  /// several frame intervals. Doing that on the delivery queue stalls the
  /// next collection and drops pairs, which is why sinkIOQueue exists. The
  /// retained pair keeps its sample buffers alive across the hop.
  ///
  /// A failed delivery still rejects. Every other artifact degrades to a
  /// stated path. Completion fires on sessionQueue.
  private func commitPair(
    pair: RetainedPair,
    captureId: String,
    deliveryURL: URL,
    evidenceDirURL: URL,
    capturedAtMs: Int64,
    completion: @escaping (Result<[String: Any], ExhibitCameraNamedException>) -> Void
  ) {
    // ---- Phase one: snapshot, on sessionQueue ----
    let calibrationDict = buildCalibrationDict(pair: pair)

    // The timestamps file: both frames' host-clock timestamps, the wall
    // anchor, and the delta between them. The delta is the sync claim —
    // roughly one frame period at 30 fps. What it means is the desk's
    // question, not this module's.
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
    // connection.isVideoHDREnabled is marked unavailable in recent SDKs,
    // so it is read through a responds-to helper instead: that compiles on
    // any SDK and reports nil, meaning unknown, where the property is
    // absent.
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
      // available, degraded-thermal, or unsupported. Degraded is something
      // that happened mid-session; unsupported is a fact about the
      // hardware, and neither is a failure.
      stereoStateString: stereoActive ? "available" : (stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
      droppedPairCount: droppedPairCount,
      droppedPrimaryCount: droppedPrimaryCount,
      droppedSecondaryHalfCount: droppedSecondaryHalfCount,
      secondaryAbsentCount: secondaryAbsentCount,
      secondaryDroppedCount: secondaryDroppedCount,
      completePairCount: completePairCount,
      hardwareCost: Double(session?.hardwareCost ?? -1),
      hardwareCostPayload: session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
      // The explicit annotation is needed: a literal mixing String and
      // NSNull does not infer a type.
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

    // ---- Phase two: encode and write on sinkIOQueue, settle back on
    // sessionQueue ----
    sinkIOQueue.async { [weak self] in
      guard let self = self else { return } // module gone; the capture watchdog owns the promise
      let result = self.performPairCommit(snapshot)
      self.sessionQueue.async { completion(result) }
    }
  }

  /// The second phase of a pair commit. Runs on sinkIOQueue only, never on
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

    // 1. The primary frame, at full session resolution. This is the
    //    delivery still.
    guard let primaryBuffer = CMSampleBufferGetImageBuffer(pair.primary),
          let primaryJPEG = jpegData(from: primaryBuffer, quality: 0.9) else {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Primary frame could not be encoded"))
    }
    do {
      // try?: on a fresh delivery path there is nothing to remove, and
      // that throw must not fail the write.
      try? FileManager.default.removeItem(at: deliveryURL)
      try primaryJPEG.write(to: deliveryURL, options: .atomic)
    } catch {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot write delivery still: \(error.localizedDescription)"))
    }

    // 2. The secondary frame, small — this is geometry input, not a
    //    picture for the eye, and the bytes actually written are what is
    //    committed. Upright in, upright out.
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

    // 3. Calibration: per-frame intrinsics and, where it exists, full
    //    calibration, each labeled with the path that produced it. The
    //    dictionary was assembled in phase one; only the write is here.
    let calibrationURL = evidenceDirURL.appendingPathComponent("calibration-\(captureId).json")
    let calibrationEvidence: [String: Any]
    do {
      try CalibrationSerializer.writeJSON(snap.calibrationDict, to: calibrationURL)
      calibrationEvidence = EvidencePathBuilder.path(calibrationURL.path)
    } catch {
      calibrationEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription)
    }

    // 4. Timestamps. Assembled in phase one, written here.
    let timestampsURL = evidenceDirURL.appendingPathComponent("timestamps-\(captureId).json")
    let timestampsEvidence: [String: Any]
    do {
      try CalibrationSerializer.writeJSON(snap.timestampsDict, to: timestampsURL)
      timestampsEvidence = EvidencePathBuilder.path(timestampsURL.path)
    } catch {
      timestampsEvidence = EvidencePathBuilder.error(ExhibitCameraErrorCode.sink, error.localizedDescription)
    }

    // 5. The metadata block: inputs, never computed answers. Pro-control
    //    values are read back off the device and its connections, never
    //    taken from what this module asked for. The device objects ride the
    //    snapshot, and these are pure reads.
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
    // Where the secondary half died: never offered, offered and marked
    // dropped, or paired.
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

    // The camera settings block. Every value is read back off the device
    // at this commit instant; the flash and EXIF facts merge in later from
    // the full-resolution photo's own metadata. Absence is an explicit
    // null, never a synthesized value. A missing primary device cannot
    // happen on a running session, and says so if it does.
    //
    // Built here rather than inline in the payload literal: the nested
    // closure and casts push the type checker past its budget.
    var captureSettingsBlock: [String: Any]
    if let commitDevice = snap.primaryDevice {
      captureSettingsBlock = CaptureSettingsBuilder.dictionary(
        for: commitDevice,
        photoFlash: snap.photoFlashPreference,
        flashSupportedModes: snap.flashSupportedModes,
        activeStabilizationMode: snap.primaryStabActive
      )
      // The color profile is read out of the delivered JPEG's own bytes,
      // so the artifact speaks for itself. The fallback states the pipeline
      // fact — jpegData renders into sRGB whatever the source was — and
      // labels itself as such rather than passing as a reading.
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
      // The projection inputs, off the snapshotted device, as of the
      // commit instant.
      "facing": snap.primaryDevice.map { $0.position == .front ? "front" : "back" } as Any? ?? NSNull(),
      "primaryHfovDeg": snap.primaryDevice.map { Double($0.activeFormat.videoFieldOfView) } as Any? ?? NSNull(),
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
      // The connection census at the moment of commit, so every capture
      // carries the state of the graph that produced it.
      "connections": connectionCensus(),
    ]
    // Whether this particular capture got stereo. 'ok' only when a
    // synchronized secondary frame was actually committed. When the
    // secondary dropped at the shutter, 'unavailable' with the reason: the
    // capture succeeds, because the primary still is real, and nothing
    // stereo is implied. Absent on single-cam sessions, where the
    // capability string already says unsupported.
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
    // Intrinsics are pulled out here, at commit time, not in the delivery
    // callback. The attachment rides the retained buffer, so it is the same
    // read — just off the frame-rate path.
    let primaryIntrinsics = frameIntrinsics(from: pair.primary)
    let secondaryIntrinsics = pair.secondary.flatMap { frameIntrinsics(from: $0) }
    return [
      // Real per-frame data from the buffer's attachment. null when the
      // attachment was not there.
      "primaryIntrinsicsRowMajor": primaryIntrinsics as Any? ?? NSNull(),
      "secondaryIntrinsicsRowMajor": secondaryIntrinsics as Any? ?? NSNull(),
      // Extrinsics and distortion maps, from the session's photo capture.
      // These are fixed in the hardware. null when there was none.
      "primaryFull": sessionCalibration[primaryLabel] as Any? ?? NSNull(),
      "secondaryFull": sessionCalibration[secondaryLabel] as Any? ?? NSNull(),
      // The labels let the desk tell per-frame from session-fixed, and
      // full calibration from intrinsics alone. Partial is not the same as
      // invented.
      "calibrationSource": [
        "intrinsics": primaryIntrinsics != nil ? "frame-attachments" : "unavailable",
        "full": sessionCalibration.isEmpty ? "unavailable" : "session-photo-capture",
      ],
    ]
  }

  // MARK: - Encoding (sinkIOQueue, never the frame delivery queue)

  /// Encodes one pixel buffer as JPEG.
  ///
  /// Orientation: the connection has already rotated these buffers
  /// physically, so the bytes arrive upright. Adding a rotation here would
  /// turn every still and every stereo secondary sideways. Encode exactly
  /// as delivered — jpegRepresentation bakes orientation into the pixels,
  /// so the written JPEG is upright with orientation 1, no EXIF tag needed
  /// and nothing left to a viewer's discretion.
  private func jpegData(from pixelBuffer: CVPixelBuffer, quality: CGFloat) -> Data? {
    let delivered = CIImage(cvPixelBuffer: pixelBuffer)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    // The option wraps the CGImageDestination key by raw value; prefer a
    // named static if the SDK grows one.
    guard let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String) as CIImageRepresentationOption? else { return nil }
    return ciContext.jpegRepresentation(
      of: delivered,
      colorSpace: colorSpace,
      options: [qualityKey: quality]
    )
  }

  /// Downsamples to at most 640x480 and steps the quality down until the
  /// result fits the byte target or hits the floor. The target is a target:
  /// the bytes actually written are what gets committed.
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

  /// A 64-bit difference hash of the frame, computed from the same pixel
  /// buffer the committed JPEG encodes.
  ///
  /// It rides the ring index so that whether a burst holds distinct frames
  /// is answerable from the committed data — count the frames, count the
  /// unique hashes — rather than argued from appearance. The hash is a fact
  /// about the frame, not a verdict on it.
  private func dHash64(from pixelBuffer: CVPixelBuffer) -> String? {
    let source = CIImage(cvPixelBuffer: pixelBuffer)
    let extent = source.extent
    guard extent.width > 0, extent.height > 0 else { return nil }
    // A 9-by-8 luma grid: eight rows of eight neighbor comparisons is 64
    // bits.
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

  // MARK: - RAW

  /// Fires a RAW capture on the primary photo output.
  ///
  /// True Bayer RAW only. ProRAW is computationally processed by the
  /// platform, which is the opposite of what this path is for. Completion
  /// comes back on sessionQueue.
  private func commitRawOptIn(
    captureId: String,
    evidenceDirURL: URL,
    completion: @escaping ([String: Any]) -> Void
  ) {
    guard let photoOutput = primaryPhotoOutput else {
      completion(EvidencePathBuilder.error(ExhibitCameraErrorCode.platform, "No primary photo output in this session"))
      return
    }
    // The format types here are already OSType values, the RAW settings
    // initializer takes rawPixelFormatType:, and the flash mode is fully
    // qualified so it cannot lose its contextual base.
    guard let rawFormat = photoOutput.availableRawPhotoPixelFormatTypes.first else {
      // This hardware has no RAW format. Not a failure.
      completion(EvidencePathBuilder.neverRecorded("raw-unsupported"))
      return
    }
    let settings = AVCapturePhotoSettings(rawPixelFormatType: rawFormat)
    if photoOutput.isCameraCalibrationDataDeliverySupported {
      settings.isCameraCalibrationDataDeliveryEnabled = true
    }
    // The setter validates on assignment and raises an uncatchable
    // exception on a mismatch, so assign only a supported mode.
    if photoOutput.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      settings.flashMode = AVCaptureDevice.FlashMode.off
    }
    let dngURL = evidenceDirURL.appendingPathComponent("primary-\(captureId).dng")
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      // The settings asked for RAW, so a delivered photo is the Bayer RAW
      // capture and its file representation is the DNG.
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
      // Release the delegate on sessionQueue, which is the only queue that
      // touches photoHandlers.
      self?.sessionQueue.async {
        if let handlerRef = handlerRef {
          self?.photoHandlers.removeAll { $0 === handlerRef }
        }
      }
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // A settings-validation throw becomes the stated RAW error rather than
    // a crash.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      completion(EvidencePathBuilder.error(
        ExhibitCameraErrorCode.platform,
        "RAW capture threw at fire time: \(captureError.localizedDescription)"
      ))
    }
  }
}

// MARK: - Full-resolution stills

extension ExhibitCameraModule {

  /// What one full-resolution capture produced: its evidence path, plus the
  /// facts only the photo itself can establish — its own digest,
  /// dimensions, OS-written EXIF, and whether the flash fired.
  private struct FullResOutcome {
    let evidence: [String: Any]        // EvidencePath dict
    let sha256: String?                // hex of the exact bytes on disk
    let dimensions: [String: Int]?     // resolved photo dimensions (iOS 16+)
    let photoExif: [String: Any]?      // OS-written EXIF numbers, verbatim
    let flashFired: Bool?
    let flashRequested: String
    let flashApplied: Bool
    let flashNote: String?
    // The zoom factor as the device reported it when the capture fired.
    // The still is cropped and scaled by it while its EXIF focal length
    // stays the physical lens, so committing it is what makes the delivered
    // image's real geometry derivable. nil only with no device reference.
    let zoomFactor: Double?
    // The color profile read out of the delivered JPEG's own bytes. nil
    // means omitted, never assumed from what was requested.
    let colorSpace: String?
    // The depth artifact: its evidence path, the digest of its exact
    // bytes, and metadata saying what kind of map it is, its dimensions and
    // accuracy, the normalization window, and calibration where delivered.
    // Absent depth is never-recorded with the reason — never a silent gap,
    // and never an invented map.
    let depthEvidence: [String: Any]
    let depthSha256: String?
    let depthMetadata: [String: Any]?
  }

  /// Fires the full-resolution captures and folds their outcomes into the
  /// payload.
  ///
  /// Runs on sessionQueue, and the completion fires there too, so the RAW
  /// and settle chain below stays on one queue. Outputs are captured one at
  /// a time: back-to-back photo captures on a live multi-cam graph starve
  /// the pipeline. A failure here is a stated path, never a rejected
  /// capture.
  private func attachFullResStills(
    captureId: String,
    evidenceDirURL: URL,
    payload: [String: Any],
    completion: @escaping ([String: Any]) -> Void
  ) {
    // Not during a recording. The delivery file owns the pipeline, and a
    // photo capture would starve the writer. Said out loud rather than
    // attempted.
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
        // The stereo still comes from the retained pair's ultra-wide
        // frame, since there is no secondary photo output. It is the same
        // buffer the geometry evidence already commits, encoded once more
        // at full quality. What it therefore lacks — sensor resolution, an
        // OS EXIF block, flash, depth — is stated in the outcome below
        // rather than left to be inferred.
        self.deriveSecondaryStillFromPair(
          fileStem: "fullres-secondary-\(captureId)",
          evidenceDirURL: evidenceDirURL
        ) { [weak self] secondaryResult in
          guard let self = self else { return }
          self.mergeFullRes(&out, key: "fullResSecondary", result: secondaryResult)
          completion(out)
        }
      } else {
        // Same vocabulary as the video-frame secondary: a thermal detach
        // is something that happened, unsupported is a fact about the
        // hardware, and neither is a failure.
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

  /// One full-sensor JPEG capture on a photo output.
  ///
  /// The flash preference is checked against this output's supported modes;
  /// an unsupported one degrades to off with the reason stated. Completion
  /// fires exactly once, on sessionQueue.
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
    // The setter validates on assignment and raises an uncatchable
    // exception on a mismatch, so only supported values are assigned. An
    // unassigned setting means no flash.
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

    // The zoom in force as this capture fires — real capture-time state,
    // not what was set at configure time. The still is cropped and scaled
    // by this same property, so committing it is what makes the delivered
    // image's effective focal length and field of view derivable. The
    // photo's own EXIF focal length stays the physical lens.
    let zoomDevice = output === self.primaryPhotoOutput ? self.primaryDevice : self.secondaryDevice
    let zoomFactor = zoomDevice.map { Double($0.videoZoomFactor) }

    // Ask for depth only when this output really supports it here. When it
    // is not requested, the reason rides the depth fields; a delivery or
    // extraction failure later becomes depth-not-recorded, never a failed
    // still.
    let depthNotRequestedReason = self.requestDepthIfHonest(settings: settings, output: output)

    let url = evidenceDirURL.appendingPathComponent("\(fileStem).jpg")
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      // Release the delegate on sessionQueue, the only queue that touches
      // photoHandlers.
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
      // The digest binds the exact bytes on disk.
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      var dimensions: [String: Int]? = nil
      if #available(iOS 16.0, *) {
        let d = photo.resolvedSettings.photoDimensions
        if d.width > 0, d.height > 0 {
          dimensions = ["width": Int(d.width), "height": Int(d.height)]
        }
      }
      // Only what the OS wrote into this photo's own metadata. Whether the
      // flash fired comes from there too, never inferred from what was
      // requested.
      let exif = PhotoExifExtractor.dictionary(from: photo)
      let fired = PhotoExifExtractor.flashFired(from: exif)
      // Depth rides the delivered photo, and is extracted, written, and
      // hashed only after the still is safe on disk. A failure states
      // itself in the depth evidence and never touches the photo's
      // outcome.
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
    // capturePhoto validates these settings against the live graph and
    // raises an Objective-C exception on a mismatch, which Swift cannot
    // catch. The fire goes through the trampoline, and a throw becomes this
    // still's stated failure. The delivery still has already committed, so
    // the capture survives with this block degraded.
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

  /// The stereo still, without a photo output: encodes the retained pair's
  /// ultra-wide frame at full stream resolution.
  ///
  /// The buffer is already upright, since the connection's rotation is
  /// physical. Runs on sessionQueue like its caller; encoding a 720p frame
  /// takes a few milliseconds and the primary's encode has already run on
  /// the same queue. Completion fires exactly once.
  ///
  /// Absences use the shared vocabulary: a missing secondary half is a
  /// stale pair, the same reason the geometry evidence gives; a failed
  /// encode or write is a sink failure.
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
    // Same contract as the photo-output still: the digest binds the exact
    // bytes on disk, and the dimensions come off the buffer itself.
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let dimensions = [
      "width": CVPixelBufferGetWidth(buffer),
      "height": CVPixelBufferGetHeight(buffer),
    ]
    completion(FullResOutcome(
      evidence: EvidencePathBuilder.path(url.path),
      sha256: digest, dimensions: dimensions,
      // A video frame has no OS EXIF, so the field is omitted rather than
      // filled with a plausible block. The note below states where this
      // still came from.
      photoExif: nil, flashFired: nil,
      flashRequested: photoFlashPreference.rawValue, flashApplied: false,
      flashNote: "video-stream-derived still (no secondary photo output by design): stream-resolution UW frame from the synchronized pair — no strobe, no OS EXIF, no depth (stated, not faked)",
      zoomFactor: secondaryDevice.map { Double($0.videoZoomFactor) },
      colorSpace: JpegColorSpaceReader.profileName(from: data),
      depthEvidence: depthNA, depthSha256: nil, depthMetadata: nil
    ))
  }

  /// A compact state dump appended to every photo-capture failure message:
  /// key=value pairs, readable when pasted out of a toast.
  ///
  /// Everything here is read live off the connections and devices at the
  /// moment of failure. Nothing comes from what this module asked for.
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
    // The video connections decide whether the pair pipeline can work at
    // all, so a missing secondary video connection is visible in every
    // capture failure rather than only in a session log.
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
    // Every debug flag, not a chosen few. A flag left on persists across
    // app updates and only clears on deletion, so it can quietly change
    // what a run means. Carrying the whole set here lets a reader see the
    // uncontrolled variable without asking for a second run.
    for (key, value) in ExhibitDebugFlags.all().sorted(by: { $0.key < $1.key }) {
      parts.append("flag.\(key)=\(value)")
    }
    return parts.joined(separator: "; ")
  }

  /// Decides whether to ask for depth with this photo.
  ///
  /// Two conditions: the flag is on, and the live output reports support for
  /// the current device and format. That last one is the only real per-lens
  /// answer — there is no way to ask without a session.
  ///
  /// Returns the reason when depth is not requested, nil when it is. Never
  /// throws: a depth problem becomes depth-not-recorded, never a failed
  /// photo. The RAW path never calls this, since RAW and depth delivery
  /// cannot both be requested.
  private func requestDepthIfHonest(settings: AVCapturePhotoSettings, output: AVCapturePhotoOutput) -> String? {
    guard ExhibitDebugFlags.depthCapture else { return "depth-disabled" }
    // Check whether delivery is enabled on the output, not merely
    // supported: the settings setter throws uncatchably when it is not.
    // Enablement happens once, when the output is added. An output that
    // reaches here without it must never see the per-request flag.
    guard output.isDepthDataDeliveryEnabled else { return "depth-unsupported" }
    settings.isDepthDataDeliveryEnabled = true
    if output.isCameraCalibrationDataDeliverySupported {
      // D1's committed extrinsics ride the same delivery; under the same
      // flag so a regression is isolable on device.
      settings.isCameraCalibrationDataDeliveryEnabled = true
    }
    return nil
  }

  /// Writes the depth map, when and only when depth genuinely arrived with
  /// a delivered photo. Canonicalizes it, writes the PNG, and hashes the
  /// exact bytes the commit layer will receive.
  ///
  /// Absence is stated, never a silent gap, and any failure here degrades
  /// to never-recorded or error. The still is already safe on disk before
  /// this runs, so none of it can cost the photo.
  private func commitDepthArtifact(
    from photo: AVCapturePhoto,
    depthURL: URL,
    device: AVCaptureDevice?,
    photoWidth: Int?,
    photoHeight: Int?
  ) -> (evidence: [String: Any], sha256: String?, metadata: [String: Any]?) {
    guard let depthData = photo.depthData else {
      // Asked for, and the pipeline produced none. Scene-dependent, and
      // stated rather than filled in.
      return (EvidencePathBuilder.neverRecorded("depth-not-delivered"), nil, nil)
    }
    guard let outcome = ExhibitDepthMapExtractor.extract(from: depthData, photoWidth: photoWidth, photoHeight: photoHeight) else {
      return (EvidencePathBuilder.error(ExhibitCameraErrorCode.platform, "Depth data arrived but PNG export failed"), nil, nil)
    }
    var metadata = outcome.metadata
    if let calibration = photo.cameraCalibrationData {
      // Extrinsics ride the depth metadata when the OS delivered them with
      // this photo.
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
    // The digest binds the exact bytes on disk. The commit layer takes it
    // verbatim, so there is nothing to re-hash and nothing to disagree
    // about.
    let digest = SHA256.hash(data: outcome.png).map { String(format: "%02x", $0) }.joined()
    return (EvidencePathBuilder.path(depthURL.path), digest, metadata)
  }

  /// Folds one full-resolution outcome into the payload. The primary still
  /// also merges its OS-written EXIF and flash outcome into captureSettings,
  /// since the photo's own metadata is the only real source for whether the
  /// flash fired.
  private func mergeFullRes(_ payload: inout [String: Any], key: String, result: FullResOutcome) {
    payload[key] = result.evidence
    payload["\(key)Sha256"] = result.sha256 as Any? ?? NSNull()
    payload["\(key)Dimensions"] = result.dimensions as Any? ?? NSNull()
    // The zoom at capture time and the profile read out of the artifact
    // ride beside the digest and dimensions for both stills. Omitted when
    // the source reported nothing.
    if let zoomFactor = result.zoomFactor {
      payload["\(key)ZoomFactor"] = zoomFactor
    }
    if let colorSpace = result.colorSpace {
      payload["\(key)ColorSpace"] = colorSpace
    }
    // Depth: the evidence path, the digest of its exact bytes, and the
    // metadata describing the map. Absence carries its reason.
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

// MARK: - Video

extension ExhibitCameraModule {

  /// Starts recording. opts: { deliveryPath, evidenceDir, pairIntervalSec?,
  /// rawPcm? }.
  ///
  /// Needs a session already running: the same session that was previewing
  /// is the one that records. Arms the writer and resolves once it is
  /// accepting frames.
  func startVideo(opts: [String: Any], promise: Promise) {
    // Running, not merely configured: a stopped session would arm a writer
    // that never sees a frame.
    guard session?.isRunning == true else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "configureSession must run before startVideo"))
      return
    }
    // A start that arrives while the previous clip is still sealing queues
    // behind it rather than failing — the user tapped record, and the
    // moment should not be lost. The seal has its own watchdog, so a queued
    // start cannot hang; it re-enters here once the state is idle again.
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

    // Audio is added to the running session inside a configuration. The
    // synchronizer is untouched: audio sits outside it, because
    // synchronized audio-and-video collections are unreliable.
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
      // Wired by hand — see wireOutput. An implicitly formed microphone
      // connection on a running multi-cam graph is exactly the silent dead
      // end that avoids.
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

    // Re-check the cost now that audio is attached.
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
    try? FileManager.default.removeItem(at: deliveryURL) // the writer refuses an existing file
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
    // The raw audio master. A failure to create it is a sink failure, and
    // stop reports a null path; the delivery file is already safe above.
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
      // A live writer with no converter means every tee does nothing and
      // the take ends with an empty master and no error anywhere. Treat a
      // nil converter as a failed sink, exactly like a throw.
      if pcmWriter != nil, pcmConverter == nil {
        sendError(ExhibitCameraErrorCode.sink, "PCM master converter creation failed (format init returned nil) — sink disabled for this take")
        pcmWriter = nil
      }
    }
    // Per-take audio counters and the wall-clock anchor.
    audioBufferCount = 0
    pcmFirstSampleWallClockUtcMs = nil
    pcmAnchorSource = ""
    // Two seconds between committed pairs, and two seconds is also the
    // floor.
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
    // The first video frame commits a pair immediately. The moment
    // recording started is the one a reviewer always looks at.
    self.lastPairDumpAt = .distantPast
    self.videoStartDate = Date()
    // The recording window starts now on the boot clock — the same clock
    // the motion ring's samples ride, so stopVideo
    // slices [this instant, stop instant] with no conversion. The logger
    // itself started at configureSession (CoreMotion is capture-graph
    // independent) and simply keeps running through the take.
    self.videoSensorStartBootSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    self.videoStartEpochMs = currentEpochMs()

    audioHandler.onAudio = { [weak self] buffer in
      self?.handleAudioSample(buffer)
    }

    // Resolve now: configureSession's first-frame watchdog already proved
    // the session live. A writer failure surfaces as an error event and in
    // the stopVideo payload, so delivery never dies quietly.
    promise.resolve([
      "sessionId": sessionId,
      "startedAtMs": currentEpochMs(),
      "pairIntervalSec": pairIntervalSec,
      "stereo": stereoActive ? "available" : (stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
    ])
  }

  /// Feeds primary frames to the delivery writer. The writer input is built
  /// lazily from the real stream format, and buffers that arrive before the
  /// writer session starts are dropped rather than appended illegally.
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
      // The transform must be identity. The capture connection has already
      // rotated these buffers physically, and the dimensions read above are
      // the rotated ones. Stamping the connection's angle here would be a
      // second rotation on top of upright bytes, and playback and
      // thumbnails would come out sideways wherever the track metadata is
      // honored. A rotation transform is only ever right for a connection
      // that does not rotate pixels; this is not one.
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

  /// Tees audio to the raw master. The delivery writer takes the native
  /// buffers; the master takes a converted, canonical form of the same
  /// ones.
  ///
  /// It runs from the first audio frame and has its own clock domain, so it
  /// is not coupled to when the delivery writer's session starts. Any
  /// failure fails this sink alone, never delivery.
  private func teeToPcmMaster(_ sampleBuffer: CMSampleBuffer) {
    guard let pcmWriter = pcmWriter, !pcmWriter.failed else { return }
    do {
      if let converted = try pcmConverter?.convert(sampleBuffer) {
        try pcmWriter.append(pcmBuffer: converted)
        if pcmFirstSampleWallClockUtcMs == nil {
          // The wall-clock time of the first audio sample in the master.
          //
          // The source buffer's timestamp is on the same clock the video
          // timestamps and the motion ring ride, so the conversion is one
          // subtraction at one instant: now, minus how long ago that
          // timestamp was.
          //
          // Written frames trail the source timestamp by the converter's
          // delay line, a few milliseconds. The anchor is labeled
          // 'source-pts' so the desk knows which instant is committed.
          let nowHostSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
          let nowMs = currentEpochMs()
          let ptsSec = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
          if ptsSec.isFinite {
            pcmFirstSampleWallClockUtcMs = nowMs - Int64(((nowHostSec - ptsSec) * 1000.0).rounded())
            pcmAnchorSource = "source-pts"
          } else {
            // No usable timestamp, so the append instant is the anchor,
            // and it is labeled as such.
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

  /// Reads the finished master's container facts back off disk: its format
  /// description and the frame count its payload size implies.
  ///
  /// These are committed with the record so that whether the container
  /// agrees with what was written is answerable from the data, rather than
  /// reasoned about afterward. A pure container walk — no decode, no
  /// interpretation, no claim about the audio itself.
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
      // A size of -1 means the chunk runs to the end of the file.
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
    // A non-interleaved file stores channel blocks, so bytesPerFrame is
    // per channel and a whole frame spans that times the channel count.
    // The JS reader does the same thing.
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
    // Counts that the tap is alive. Enabled and still zero across a whole
    // take means the audio tap never delivered at all, which points at the
    // audio session or permissions. Stated at stop.
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

    // No audio input after start means the no-audio fallback fired. Drop
    // late audio; stopVideo reports that the file has no audio track.
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

  /// A dead microphone must not cost the recording. Starts the writer
  /// video-only about half a second after the first video frame, and stop
  /// reports that the file has no audio track.
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

  /// Commits stereo pairs on a cadence rather than continuously. Heat and
  /// power headroom are real, and timestamped pairs at intervals are enough
  /// geometry. A missed interval is counted and committed at stop.
  private func maybeDumpPeriodicPair(force: Bool = false) {
    guard stereoActive, let evidenceDir = evidenceDirURL, let pair = latestPair else { return }
    let interval = ProcessInfo.processInfo.thermalState == .serious
      ? pairIntervalSec * 2.0   // halve the rate when the phone is hot
      : pairIntervalSec
    // force is the stop-time commit: the moment recording ended is
    // committed even if the last one landed inside the interval.
    guard force || Date().timeIntervalSince(lastPairDumpAt) >= interval else { return }
    lastPairDumpAt = Date()

    guard pair.secondary != nil else {
      pairsMissed += 1
      return
    }

    let index = pairIndex
    pairIndex += 1
    // Built here on sessionQueue, because it reads state confined to this
    // queue and costs nothing — dictionary assembly, no encoding.
    let calibrationDict = buildCalibrationDict(pair: pair)

    // Encode and write on the sink queue. A 720p encode plus two writes
    // runs longer than a frame interval and must never happen on
    // sessionQueue.
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

  /// Stops recording, seals the delivery file, and returns the same session
  /// to preview mode. The audio input and output are removed, since they
  /// were only there for the recording.
  ///
  /// Idempotent: a second stop while the seal is in flight joins the one
  /// already running and settles with its outcome. It is the same stop, not
  /// a new one. The seal is asynchronous and never blocks the state
  /// machine, and a ten-second watchdog guarantees it settles.
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
      // The state said recording and the writer is gone. Say so.
      videoState = .idle
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No video is recording"))
      return
    }
    videoState = .stopping

    audioHandler.onAudio = nil
    let durationMs = videoStartDate.map { Int((Date().timeIntervalSince($0) * 1000.0).rounded()) } ?? 0
    let audioTrack = writerAudioInput != nil && writerStarted
    let deliveryPath = deliveryURL?.path ?? ""
    // One last pair before the counts are read, so the moment recording
    // ended is anchored. It encodes on the sink queue like every other one.
    maybeDumpPeriodicPair(force: true)
    let pairs = pairIndex
    let missed = pairsMissed

    // Finish the raw master: drain the converter's delay line, close the
    // file, and fold the outcome into the three states. A master with no
    // frames is not evidence and is reported as failed, never as a recorded
    // file. The disabled case never gets here — JS owns the toggle and
    // reports never-recorded itself.
    var rawPcmPath: String? = nil
    // The anchor and integrity summary, reported as rawPcmInfo whenever
    // the master commits. The anchor is what lets the desk line the
    // recording's mains hum up against a reference series in absolute time;
    // the digest binds any such analysis to the exact committed bytes.
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
        // finish() has written the header, so the bytes hashed here are
        // the committed bytes.
        var sha: String? = nil
        if let bytes = try? Data(contentsOf: pcmWriter.url) {
          sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
        // An explicit local: inlining the ternary parses the cast onto its
        // own optional and does not compile.
        let anchorSource: String? = pcmAnchorSource.isEmpty ? nil : pcmAnchorSource
        rawPcmInfo = [
          "firstSampleWallClockUtcMs": (pcmFirstSampleWallClockUtcMs as Any?) ?? NSNull(),
          "firstSampleAnchor": (anchorSource as Any?) ?? NSNull(),
          "sampleCount": Int(pcmWriter.framesWritten),
          "sampleRate": Int(PcmMasterWriter.sampleRate),
          "fileSha256": (sha as Any?) ?? NSNull(),
        ]
        // Commit what the container itself says beside what the writer
        // counted. If the two disagree, that disagreement is a fact in the
        // sealed record rather than a puzzle discovered later.
        if var info = rawPcmInfo, let facts = cafContainerFacts(pcmWriter.url) {
          for (key, value) in facts { info[key] = value }
          info["framesMatchContainer"] = (facts["containerFrames"] as? Int) == Int(pcmWriter.framesWritten)
          rawPcmInfo = info
        }
      }
    }
    // Say why the master is absent. Requested, and the tap delivered
    // nothing all take, means the audio session or the tap — not the
    // conversion.
    if pcmEnabled, audioBufferCount == 0 {
      // Report the connection's liveness, so no connection can be told
      // apart from a live connection delivering nothing. The second points
      // at the audio session rather than the graph.
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

    // Slice the recording window out of the motion ring and write it beside
    // the master.
    //
    // A recording longer than the ring commits its tail, marked truncated
    // in the file's window line — never implied to be the whole thing. Same
    // three states as the still path, and a failed log never blocks the
    // stop.
    //
    // The logger keeps running afterward: the session returns to preview
    // and a still may follow. Only teardown or heat stops it.
    var sensorFields = sensorLogFields(state: "unavailable")
    if sensorLogWanted, !sensorLogThermalStopped, let logger = sensorLogger, let evidenceDir = evidenceDirURL {
      sensorFields = sensorWindowFields(
        url: evidenceDir.appendingPathComponent("sensors-\(sessionId).jsonl"),
        from: videoSensorStartBootSec,
        to: ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks()),
        anchorStartedAtMs: videoStartEpochMs,
        // The anchor ties the instant recording started to its wall clock,
        // not the instant the log was flushed. The motion card re-zeroes on
        // it.
        anchorBootSec: videoSensorStartBootSec,
        logger: logger
      )
    }

    // Remove the audio nodes that were only there for the recording. The
    // session keeps running.
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

    // A hung finalize must not hang JS. This settles through the same
    // single path the seal does, and releases a queued start, so a start
    // waiting behind a stuck seal waits ten seconds at most.
    stopPromise = promise
    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self else { return }
      self.settleVideoStop(
        writer: writer,
        outcome: .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.writer, "Delivery finalize timed out after 10s; file state unknown — stated, not guessed"))
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
      // This callback fires on the writer's own queue, so hop back. The
      // seal never blocks the state machine: settling is one hop with no
      // I/O in it.
      self.sessionQueue.async {
        if writer.status == .completed {
          var payload: [String: Any] = [
            "deliveryPath": deliveryPath,
            "durationMs": durationMs,
            // The projection inputs, read off the primary device at
            // finalize.
            "facing": self.primaryDevice.map { $0.position == .front ? "front" : "back" } as Any? ?? NSNull(),
            "primaryHfovDeg": self.primaryDevice.map { Double($0.activeFormat.videoFieldOfView) } as Any? ?? NSNull(),
            // A missing audio track is stated, never just absent.
            "audioTrack": audioTrack,
            "pairsCommitted": pairs,
            "pairsMissed": missed,
            // A path means recorded; null means enabled and failed. The
            // disabled case is reported by JS, which owns the toggle.
            "rawPcmPath": rawPcmPath as Any? ?? NSNull(),
            // The anchor and integrity summary for the committed master,
            // plus the tap counter.
            "rawPcmInfo": rawPcmInfo as Any? ?? NSNull(),
            "audioBufferCount": self.audioBufferCount,
            "hardwareCost": self.session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
          ]
          // The motion fields, computed above on sessionQueue before this
          // hop: a path, a state, and an error only when it failed.
          for (key, value) in sensorFields { payload[key] = value }
          self.settleVideoStop(writer: writer, outcome: .success(payload))
        } else {
          let message = writer.error?.localizedDescription ?? "writer did not complete"
          self.settleVideoStop(writer: writer, outcome: .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.writer, "Delivery finalize failed: \(message)")))
        }
      }
    }
  }

  /// The one place a stop settles. Resolves or rejects the stop promise and
  /// every joined waiter with the same outcome, tears down writer state,
  /// returns the machine to idle, and releases a queued start. sessionQueue
  /// only.
  ///
  /// The identity check at the top matters: a stale finalize or timeout
  /// belonging to a previous writer must never touch a new recording's
  /// state.
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

  /// Runs a start that queued behind the stop just settled, if there is
  /// one. It re-enters startVideo, so every guard and every rejection of
  /// the normal path applies unchanged: a queued start is a real start,
  /// only later.
  private func flushPendingStartVideo() {
    guard videoState == .idle, let pending = pendingStartVideo else { return }
    pendingStartVideo = nil
    startVideo(opts: pending.opts, promise: pending.promise)
  }

  /// Read this before calling. This transform is valid only for a
  /// connection whose rotation is metadata — an output that tags
  /// orientation without touching pixels.
  ///
  /// Video data output connections rotate their buffers physically, so
  /// their frames are already upright. Passing one here and stamping the
  /// result on a writer input rotates twice, and playback and thumbnails
  /// come out sideways.
  ///
  /// It has no call sites: every sink in this module consumes physically
  /// rotated buffers and uses identity. Kept for a future metadata-only
  /// output. If you add a call site, prove the connection does not rotate
  /// pixels first.
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

// MARK: - Camera controls

extension ExhibitCameraModule {

  /// Switches lens on a running session: swap the primary input, then work
  /// out the stereo partner again around it.
  ///
  /// The order matters. The requested lens is often the current stereo
  /// partner, already in the session, and a session cannot hold two inputs
  /// for one device. So the partner is detached before the primary is
  /// asked for.
  ///
  /// Two configurations: detach the conflicting partner and swap the
  /// primary, then re-attach a partner around the new primary. A failure in
  /// the first restores both the old primary and its partner; a failure in
  /// the second is a single-cam session, stated in the payload. Never a
  /// dead session.
  func setLens(_ lens: ExhibitLens, promise: Promise?) {
    guard let session = session, facing == .back else {
      promise?.resolve(["applied": false, "reason": "no-session-or-front-facing"])
      return
    }
    // On the virtual graph the primary is the dual-wide device, so wide
    // and ultra-wide are both already live. A wide request is satisfied,
    // and any other swap would tear down a working pair. Refused with the
    // reason: the ultra-wide view is the 0.5x stop on this same graph.
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
      // This hardware does not have that lens.
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Lens \(lens.rawValue) is not available on this device"))
      return
    }
    do {
      let newInput = try AVCaptureDeviceInput(device: newDevice)
      let oldInput = primaryInput
      let oldDevice = current
      // If the requested device is currently the stereo partner it has to
      // leave the session before it can be the primary: two inputs for one
      // device are illegal.
      let partnerConflict = secondaryDevice?.deviceType == newDevice.deviceType
      // Rollback: put the old partner back and rebind the synchronizer to
      // the restored topology. A synchronizer left pointing at a removed
      // output stalls the whole pipeline.
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
      // The 30 fps billing promise follows the new input. Adding an input
      // resets the override, so without this a mid-session swap quietly
      // returns to worst-case billing.
      newInput.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
      // Same rule as configureSession: with stereo on, the new primary's
      // format has to be multi-cam legal, or the partner re-attached just
      // below cannot stream.
      if configureFormat(device: newDevice, maxWidth: 3840, maxHeight: 2160, requireMultiCam: stereoActive) == false {
        // Restore the old primary and its partner.
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
        // Roll back a configuration the OS would throttle.
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
      // Swapping the input recreated the outputs' connections, so rotation,
      // mirroring, and intrinsics delivery all have to be applied again.
      if let primaryOut = primaryVideoOutput { applyConnectionPolicies(to: primaryOut, device: newDevice) }
      if #available(iOS 17.0, *), let photoConnection = primaryPhotoOutput?.connection(with: .video) {
        // W7 isolation: default off — wave-5/6 suspect, flip via Settings ▸ Diagnostics when testing
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: photoConnection, device: newDevice)
        } else if photoConnection.isVideoOrientationSupported {
          photoConnection.videoOrientation = .portrait
        }
      }
      // Work out the partner for the new primary. When the swap consumed
      // the old partner, this is what brings stereo back; when it fails,
      // the payload says single-cam.
      let stereoNote: String
      if stereoDetachedForThermal {
        stereoNote = "degraded-thermal"
      } else {
        stereoNote = ensureStereoPartner(excluding: newDevice.deviceType) ? "available" : "unsupported"
      }
      // The synchronizer cannot follow topology changes, so recreate it
      // over the current outputs after any swap, detach, or attach.
      rebuildSynchronizer()
      // No calibration one-shot here — see scheduleSessionCalibrationCapture.
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

  /// Removes the secondary input + outputs inside an OPEN configuration
  /// (the caller holds beginConfiguration) and drops the PiP connection
  /// with them. The synchronizer is NOT touched here — callers rebuild it
  /// after the commit. Shared by the lens swap and the thermal detach.
  private func detachSecondaryPipeline(in session: AVCaptureMultiCamSession) {
    teardownPipConnection(in: session)
    // detach the direct delegate BEFORE the output leaves the
    // session (multi-input graph; nil queue detaches) and drop the pinned
    // frame back to the pool.
    if let secondaryOut = secondaryVideoOutput {
      secondaryOut.setSampleBufferDelegate(nil, queue: nil)
      session.removeOutput(secondaryOut)
    }
    latestDirectSecondary = nil
    if let secondaryPhoto = secondaryPhotoOutput { session.removeOutput(secondaryPhoto) }
    if let sInput = secondaryInput { session.removeInput(sInput) }
    secondaryVideoOutput = nil
    secondaryPhotoOutput = nil
    secondaryInput = nil
    secondaryDevice = nil
    stereoActive = false
  }

  /// Attaches a stereo partner around the current primary. Same plumbing as
  /// configureSession's secondary block, split out so a lens swap can
  /// re-pair.
  ///
  /// Owns its own begin and commit. A failure returns false and leaves a
  /// single-cam session, never a thrown error. An over-budget graph is
  /// refused.
  @discardableResult
  private func ensureStereoPartner(excluding primaryType: AVCaptureDevice.DeviceType) -> Bool {
    guard let session = session, facing == .back else { return false }
    if stereoActive, secondaryDevice != nil { return true } // already paired
    // On the virtual graph the pair belongs to the single input, so there
    // is no partner device to attach — stereo detached for heat is re-wired
    // by pointing fresh outputs at the ultra-wide constituent port. A lens
    // preference does not apply: the virtual pair is fixed.
    if virtualGraphActive {
      guard secondaryLensPreference == nil || secondaryLensPreference == .ultraWide else {
        logDiagnosticEvent("stereo partner attach refused on the virtual graph: fixed wide+ultra-wide pair, preference not applicable")
        return false
      }
      guard let vInput = primaryInput, let port = virtualSecondaryPort else { return false }
      let constituent = vInput.device.constituentDevices.first(where: { $0.deviceType == .builtInUltraWideCamera })
      session.beginConfiguration()
      let out = AVCaptureVideoDataOutput()
      // Native format — see configureSession's primary output.
      out.alwaysDiscardsLateVideoFrames = true
      let videoOK = wireOutput(out, to: vInput, port: port, mediaType: .video, in: session, label: "partner-video") != nil
      // No partner photo output, by design — see configureSession.
      session.commitConfiguration()
      guard videoOK else {
        logDiagnosticEvent("stereo partner attach FAILED on the virtual graph: UW port would not re-wire (see wire refusal above)")
        return false
      }
      secondaryDevice = constituent
      secondaryVideoOutput = out
      secondaryPhotoOutput = nil // by design — see configureSession
      stereoActive = true
      if let constituent = constituent {
        applyConnectionPolicies(to: out, device: constituent)
      }
      ensurePipConnection(in: session)
      logDiagnosticEvent("stereo partner attached on the virtual graph: UW constituent port census=\(connectionCensus())")
      return true
    }
    // Honor the lens preference; auto uses the standard pairing.
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
      // configureFormat logs its own failure. A canAddInput refusal would
      // otherwise pass silently, so it is logged here.
      logDiagnosticEvent("stereo partner attach FAILED: canAddInput=\(session.canAddInput(input)) (see format log lines)")
      return false
    }
    // Wired by hand — see wireOutput.
    session.addInputWithNoConnections(input)
    // The 30 fps billing promise on the partner too, set after the add,
    // which resets it.
    input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
    let out = AVCaptureVideoDataOutput()
    // Native format — see configureSession's primary output.
    out.alwaysDiscardsLateVideoFrames = true
    guard wireOutput(out, to: input, mediaType: .video, in: session, label: "partner-video") != nil else {
      session.removeInput(input)
      session.commitConfiguration()
      return false
    }
    // No partner photo output, by design — see configureSession.
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
    secondaryPhotoOutput = nil // by design — see configureSession
    stereoActive = true
    applyConnectionPolicies(to: out, device: partner)
    ensurePipConnection(in: session)
    // A partner attached mid-session takes the primary's current metering
    // rather than factory defaults.
    mirrorProControlsToSecondary()
    logDiagnosticEvent("stereo partner attached: device=\(partner.deviceType.rawValue) census=\(connectionCensus())")
    return true
  }

  /// Applies rotation, mirroring, and intrinsics delivery to an output's
  /// video connection — the same policies configureSession applies at
  /// start. Connections are recreated whenever inputs change, so this runs
  /// again after every swap.
  ///
  /// The device comes from the caller: walking back from the port to a
  /// device loses information.
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

  /// Recreates the synchronizer over the current outputs. It cannot follow
  /// topology changes, so this runs after any swap, detach, or attach. It is
  /// cheap: no session reconfiguration.
  ///
  /// On two device inputs the synchronizer carries the primary only, and
  /// this also re-attaches the secondary's direct delegate — so the first
  /// recovery step means something on both graphs.
  private func rebuildSynchronizer() {
    let outputs: [AVCaptureOutput] = virtualGraphActive
      ? [primaryVideoOutput, secondaryVideoOutput].compactMap { $0 }
      : [primaryVideoOutput].compactMap { $0 }
    guard !outputs.isEmpty else { return }
    let sync = AVCaptureDataOutputSynchronizer(dataOutputs: outputs)
    sync.setDelegate(syncHandler, queue: sessionQueue)
    synchronizer = sync
    if !virtualGraphActive, stereoActive, let out = secondaryVideoOutput {
      latestDirectSecondary = nil
      out.setSampleBufferDelegate(secondaryDirectHandler, queue: sessionQueue)
    }
  }

  /// The second recovery step for a chronic secondary flood.
  ///
  /// A rebind cannot revive a stream the platform has parked — a photo
  /// capture under pressure can leave an output unwilling to deliver at
  /// all. Removing and re-adding the secondary video output forces a fresh
  /// connection and a fresh buffer pool, without touching the input.
  ///
  /// Once per session, never during a recording or a capture. Whether it
  /// worked shows in the counters: complete pairs start climbing again.
  private func reseatSecondaryVideoOutput() {
    guard let session = session, stereoActive, secondaryVideoOutput != nil,
          mode != .video, !captureInFlight, !calibrationCaptureInFlight else { return }
    let newOut = AVCaptureVideoDataOutput()
    // Native format — see configureSession's primary output.
    newOut.alwaysDiscardsLateVideoFrames = true
    session.beginConfiguration()
    // The old output holds this port's slot and has to go before the new
    // one can connect: two outputs of the same type on one camera are not
    // allowed. Wired by hand — see wireOutput.
    if let oldOut = secondaryVideoOutput { session.removeOutput(oldOut) }
    var rewired = false
    // The virtual graph re-wires to the ultra-wide constituent port on its
    // single input; two inputs re-wire to the secondary input.
    if virtualGraphActive, let port = virtualSecondaryPort, let vInput = primaryInput {
      rewired = wireOutput(newOut, to: vInput, port: port, mediaType: .video, in: session, label: "secondary-video-reseat") != nil
    } else if let sInput = secondaryInput {
      rewired = wireOutput(newOut, to: sInput, mediaType: .video, in: session, label: "secondary-video-reseat") != nil
    }
    session.commitConfiguration()
    guard rewired else {
      // It would not re-wire. The secondary pipeline is detached for this
      // session and says so; captures degrade through the stale-pair path.
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
    // On two inputs the secondary delivers directly, so the fresh output
    // needs its delegate. The rebuild below would also set it; doing it
    // here keeps the attachment next to the wiring.
    if !virtualGraphActive {
      latestDirectSecondary = nil
      newOut.setSampleBufferDelegate(secondaryDirectHandler, queue: sessionQueue)
    }
    rebuildSynchronizer()
    logDiagnosticEvent("secondary reseat OK: census=\(connectionCensus())")
  }

  /// Changes the secondary lens on a running rear session: detach the
  /// current secondary pipeline and re-pair around the current primary with
  /// the new preference. nil restores the automatic pairing.
  ///
  /// It never swaps silently: a preference that matches the primary lens
  /// resolves applied:false with the reason.
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
    // No calibration one-shot here — see scheduleSessionCalibrationCapture.
    promise?.resolve([
      "applied": true,
      "secondaryLens": prefValue,
      "secondaryLensApplied": (secondaryDevice?.deviceType.rawValue as Any?) ?? NSNull(),
      "stereo": attached ? "available" : "unsupported",
      "hardwareCost": Double(session.hardwareCost),
    ])
  }

  /// Flips between front and back. The front camera is single-cam, and says
  /// so.
  ///
  /// A flip is a rare, user-visible transition, so it is a session rebuild
  /// rather than a re-plumb: simpler, and still guarded by the first-frame
  /// watchdog. JS calls configureSession again with the new facing; this
  /// function only validates.
  func setFacing(_ newFacing: ExhibitFacing, promise: Promise?) {
    promise?.resolve([
      "applied": false,
      "reason": "rebuild-required",
      "note": "flip by re-invoking configureSession with facing:'\(newFacing.rawValue)'; front is single-cam, stated",
    ])
  }

  /// Sets the photo output's still size, once, when the output is added,
  /// inside the session's begin-and-commit.
  ///
  /// The supported sizes are a property of the device's active format, not
  /// of the photo output, so the device is passed in from each creation
  /// site. On older systems there is nothing to set and the committed
  /// dimensions say what arrived.
  ///
  /// The largest-under-the-cap pick is an explicit loop; the equivalent
  /// chained closure pushes the type checker past its budget.
  private func applyFullResPhotoPolicy(to output: AVCapturePhotoOutput, device: AVCaptureDevice) {
    if #available(iOS 16.0, *) {
      // Cap the photo stream at 12 MP.
      //
      // The largest dimensions a format supports are legal on a single
      // camera, but the session reserves bandwidth and ISP for whatever
      // photo stream is configured, and a 48 MP reservation on a live
      // multi-cam graph starves everything else — dropped video frames,
      // stereo that never commits, and a photo output that refuses every
      // capture.
      //
      // 12 MP is the size multi-cam graphs have sustained for a decade.
      // The committed dimensions state what actually arrived, so the cap
      // is visible in the record rather than a hidden downgrade.
      let maxArea = 12_600_000 // 4032×3024 class
      let supported = device.activeFormat.supportedMaxPhotoDimensions
      var best: CMVideoDimensions? = nil
      var bestArea = 0
      for dims in supported {
        // Promote to Int before multiplying; the 32-bit product would
        // overflow.
        let area = Int(dims.width) * Int(dims.height)
        if area > bestArea, area <= maxArea {
          best = dims
          bestArea = area
        }
      }
      if let best = best {
        // On by default; the flag is the escape hatch, not the switch.
        if ExhibitDebugFlags.photoMaxDimensionsPolicy {
          output.maxPhotoDimensions = best
        }
      }
      // Nothing under the cap: leave the format default. The committed
      // dimensions say what it turned out to be.
    }

    // Enable depth delivery on the output itself.
    //
    // The per-settings depth flag throws an uncatchable exception unless
    // the output's own flag is already on. Without this line, any path
    // whose format reports depth support aborts while building the
    // settings — before the capture, so the still never exists.
    //
    // It belongs here, at add time, inside the begin-and-commit.
    // requestDepthIfHonest keys on the output's flag rather than on mere
    // support. Depth is per-photo processing, not a standing reservation,
    // so it costs nothing while idle.
    if ExhibitDebugFlags.depthCapture, output.isDepthDataDeliverySupported {
      output.isDepthDataDeliveryEnabled = true
    }
  }

  /// Sets zoom immediately. A sweep that crossed an optical stop has to
  /// land on the new lens's factor now, not after a ramp. Pinch and wheel
  /// gestures go through setZoomSmooth instead.
  ///
  /// Clamped to the device's range. It never scales past the maximum and
  /// reports the larger number.
  func setZoom(_ factor: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // Some multi-cam formats pin zoom, with the maximum equal to the
    // minimum. Report applied:false with the real ceiling: the number on
    // screen must never claim a factor the hardware did not apply.
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
      // Read the value back. A set that does not stick is reported as a
      // failure, never as applied. The guard above does not catch every
      // case, and the range on this log line is what identifies why.
      let readback = device.videoZoomFactor
      device.unlockForConfiguration()
      if abs(readback - clamped) > 0.01 {
        logDiagnosticEvent("zoom set did not stick: requested=\(factor) clamped=\(Double(clamped)) readback=\(Double(readback)) range=\(Double(device.minAvailableVideoZoomFactor))-\(Double(device.maxAvailableVideoZoomFactor)) graph=\(virtualGraphActive ? "virtual-dual-wide" : "multi-input") format=\(formatID(for: device)) previewPort=\(previewView?.previewSourceDeviceType() ?? "no-view")")
        promise?.resolve([
          "applied": false,
          "reason": "zoom-readback-mismatch",
          "zoomFactor": Double(readback),
          "maxZoom": Double(device.maxAvailableVideoZoomFactor),
        ])
        return
      }
      // Log the first successful set for each graph and range per
      // session, not every one: logging on every gesture commit makes a
      // live pinch stutter. Failures always log.
      let zoomLogSignature = "\(virtualGraphActive ? "virtual-dual-wide" : "multi-input")|\(Double(device.minAvailableVideoZoomFactor))-\(Double(device.maxAvailableVideoZoomFactor))|\(formatID(for: device))"
      if lastZoomLogSignature != zoomLogSignature {
        lastZoomLogSignature = zoomLogSignature
        logDiagnosticEvent("zoom set: requested=\(factor) applied=\(Double(readback)) range=\(Double(device.minAvailableVideoZoomFactor))-\(Double(device.maxAvailableVideoZoomFactor)) graph=\(virtualGraphActive ? "virtual-dual-wide" : "multi-input") format=\(formatID(for: device)) previewPort=\(previewView?.previewSourceDeviceType() ?? "no-view") (first set on this graph/range/format this session; per-set logging throttled, failures always log)")
      }
      promise?.resolve([
        "applied": true,
        "zoomFactor": Double(readback),
        "clamped": clamped != CGFloat(factor),
        "maxZoom": Double(device.maxAvailableVideoZoomFactor),
      ])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Zoom failed: \(error.localizedDescription)"))
    }
  }

  /// Ramps zoom smoothly, for a pinch or a wheel. The rate is clamped so a
  /// caller cannot wedge the device at zero or slam it.
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

  /// Stores the flash preference. It is written into each capture's photo
  /// settings at shutter time and validated against the output's supported
  /// modes there.
  ///
  /// No device mode is touched, and the preference survives sessions, so a
  /// choice made once keeps applying.
  func setPhotoFlashMode(_ mode: ExhibitPhotoFlash, promise: Promise?) {
    photoFlashPreference = mode
    let device = primaryDevice
    let supported: [String] = primaryPhotoOutput?.supportedFlashModes.map {
      DeviceModeMapper.flashMode($0)
    } ?? []
    promise?.resolve([
      "applied": true,
      "photoFlash": mode.rawValue,
      // Reported, not implied: an empty list means no session yet, which
      // is unknown, not unsupported.
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
    // A front camera, or a device with no torch. Say nothing happened
    // rather than report it on.
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

  /// Tap to focus: turns a view point into the device's point of interest.
  /// Focus and exposure move together, and both fall back to their
  /// continuous modes. An unsupported mode does nothing and says so.
  func setFocusPoint(x: Double, y: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // The sensor is landscape-native and the preview is portrait, so the
    // axes swap: device x is view y, and device y is one minus view x.
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
      // Clamp to the device's range. The metadata reads the bias back off
      // the device, so what is recorded is what took effect.
      let clamped = min(max(bias, device.minExposureTargetBias), device.maxExposureTargetBias)
      device.setExposureTargetBias(clamped, completionHandler: nil)
      device.unlockForConfiguration()
      // the secondary runs its own AE — mirror the bias (clamped
      // to ITS range inside the mirror) so the lenses stay honest peers.
      mirrorProControlsToSecondary()
      promise?.resolve(["applied": true, "exposureBias": Double(clamped), "clamped": clamped != bias])
    } catch {
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Exposure bias failed: \(error.localizedDescription)"))
    }
  }
}

// MARK: - Heat, and lifecycle

extension ExhibitCameraModule {

  /// Responds to thermal pressure. Serious halves the pair cadence and
  /// sends an event; critical detaches the secondary camera and says so.
  /// Delivery never stops either way.
  ///
  /// Recovery is not automatic: stereo is probed again at the next
  /// configureSession, so nothing comes back silently.
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

  /// Removes the secondary input and output and rebuilds the synchronizer
  /// over the primary alone. The session keeps running single-cam, and
  /// later captures report the secondary as a thermal failure — something
  /// that was attempted and stopped, which is not the same as hardware that
  /// never had it.
  private func detachSecondaryForThermal() {
    guard let session = session else { return }
    session.beginConfiguration()
    detachSecondaryPipeline(in: session)
    session.commitConfiguration()
    rebuildSynchronizer()
    stereoDetachedForThermal = true
  }

  /// Whether heat should park the motion log. The same policy that halves
  /// the pair cadence and, further up, detaches stereo.
  private func sensorLogBlockedByThermal() -> Bool {
    let state = ProcessInfo.processInfo.thermalState
    return state == .serious || state == .critical
  }

  /// Parks the motion log for heat: stops the logger and marks it stopped,
  /// so captures report the log as unavailable rather than committing a
  /// partial one. CoreMotion is independent of the capture graph, so this
  /// is safe at any moment.
  ///
  /// Recovery works like the stereo detach: nothing restarts on its own.
  /// The logger comes back at the next configureSession, which re-reads
  /// the toggle.
  private func stopSensorLogForThermal() {
    guard let logger = sensorLogger else { return }
    logger.stop()
    sensorLogger = nil
    sensorLogThermalStopped = true
  }

  /// Stops the camera hardware — a blurred screen, an unmount — and resets
  /// the per-graph state. Safe to call with nothing running. A recording in
  /// flight is not torn out from under: an unfinished delivery file is
  /// worse than a stated rejection.
  ///
  /// The session object itself is not torn down. It is process-lifetime,
  /// the graph stays wired, and the next configureSession rewires it in
  /// place. A stopped session holds no camera, no microphone, and no
  /// recording indicator.
  func stopSession(promise: Promise) {
    // Guard the whole recording state machine, not just whether frames are
    // routing to the writer. Tearing down mid-seal orphans the stop already
    // in flight and leaks its writer.
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
    guard let session = session else {
      promise.resolve(["stopped": false, "reason": "no-session"])
      return
    }
    rejectStart(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Session stopped before the first frame"))
    // Stop through the exception shim. The graph, the preview layers'
    // session references, and the inset connection all stay wired: none of
    // them can hurt anything now that the session is never released. Blur
    // stops it; coming back rewires and starts it again.
    let stopError = ExhibitSessionControl.safelyStop(session)
    burstSinkWanted = false
    resetCaptureState()
    if let stopError = stopError {
      // The hardware is stopped either way. The rejection says the stop
      // itself threw.
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Session stop raised an exception: \(stopError.localizedDescription)"
      ))
      return
    }
    promise.resolve(["stopped": true])
  }

  /// What OnDestroy does: stop the hardware, and nothing else.
  ///
  /// There is nothing to drain and nothing to release, so the module dying
  /// is the boring case. Must run on sessionQueue, which OnDestroy
  /// guarantees through the specific-key check.
  private func stopForModuleDestroy() {
    guard let session = session else { return }
    if let stopError = ExhibitSessionControl.safelyStop(session) {
      logDiagnosticEvent("OnDestroy session stop raised: \(stopError.localizedDescription)")
    }
  }
  /// Strips the current graph off the permanent session so a configure can
  /// rebuild it in place.
  ///
  /// Called inside configureSession's begin-and-commit, so the strip and
  /// the new wiring apply atomically. It enumerates the session's own
  /// inputs and outputs — ground truth — so it also cleans up whatever a
  /// configure that failed mid-build left behind.
  ///
  /// The session object is never released. What dies here are the
  /// per-graph delegates, which is exactly the hygiene teardown used to do
  /// before releasing.
  private func unwireGraph(_ session: AVCaptureMultiCamSession) {
    // The inset's connection references a port on an input about to be
    // removed, so tear it down first. That call is exception-safe,
    // idempotent, and clears the property itself.
    teardownPipConnection(in: session)
    for output in session.outputs {
      if let video = output as? AVCaptureVideoDataOutput {
        video.setSampleBufferDelegate(nil, queue: nil)
      } else if let audio = output as? AVCaptureAudioDataOutput {
        audio.setSampleBufferDelegate(nil, queue: nil)
      }
      session.removeOutput(output)
    }
    for input in session.inputs { session.removeInput(input) }
    synchronizer = nil
  }

  /// Clears the per-graph and per-capture state — everything a fresh
  /// session used to clear by simply not existing yet.
  ///
  /// Called by stopSession on a blur, and by configureSession as it
  /// rewires. It resets everything the old teardown reset except four
  /// things: the session object, which is process-lifetime; the inset
  /// connection, owned by unwireGraph and ensurePipConnection;
  /// burstSinkWanted, owned by stopSession and configureSession's options;
  /// and the session-lifetime observers, which are attached once and live
  /// as long as the session. sessionQueue only.
  private func resetCaptureState() {
    connectionActiveObservers.forEach { $0.invalidate() }
    connectionActiveObservers.removeAll()
    sessionStartWallClock = nil
    syncHandler.onCollection = nil
    audioHandler.onAudio = nil
    audioOutput?.setSampleBufferDelegate(nil, queue: nil)
    secondaryDirectHandler.onFrame = nil
    secondaryDirectHandler.onDrop = nil
    secondaryVideoOutput?.setSampleBufferDelegate(nil, queue: nil)
    latestDirectSecondary = nil
    directSecondaryFrameCount = 0
    lastZoomLogSignature = nil
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
    // pipWanted and pipLayer survive a rebuild on purpose. The altPreview
    // prop handler only fires when the value changes, so clearing them here
    // would leave the inset black for good after any rebuild.
    // configureSession's ensurePipConnection re-attaches the same layer.
    // pipConnection itself is owned by unwireGraph.
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
    // Drop the ring and abandon any collection in progress. A capture
    // waiting on the burst settles through its own watchdog, like every
    // other teardown mid-capture.
    // burstSinkWanted is not touched here: a blur abandons the ring
    // through stopSession, and a configure re-arms it from its options.
    burstRing.removeAll()
    burstPostFrames.removeAll()
    burstPostTarget = 0
    lastBurstPTS = nil
    lastBurstRetainedAt = nil
    burstContinuation = nil
    burstTimeout?.cancel()
    burstTimeout = nil
    audioBufferCount = 0
    pcmFirstSampleWallClockUtcMs = nil
    pcmAnchorSource = ""
    // The secondary lens preference survives a rebuild on purpose: it
    // applies at the next configureSession unless that call overrides it.
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
    // Stop the motion log, drop its ring, release it. Safe from this
    // queue: the stop and the clear both take their own locks, and the
    // handlers hold the module weakly.
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
    // A stop in flight, or anything joined to one, must not dangle across
    // a teardown: reject every outstanding promise. The seal's late
    // completion checks writer identity and does nothing.
    if let pendingStop = stopPromise {
      pendingStop.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.noSession,
        "The camera session stopped while the delivery file was finalizing; file state unknown — stated, not guessed"
      ))
    }
    stopPromise = nil
    for waiter in stopWaiters {
      waiter.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.noSession,
        "The camera session stopped while the delivery file was finalizing; file state unknown — stated, not guessed"
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
  }
}

// MARK: - Pro controls
//
// Every setter here runs on sessionQueue, checks the capability first,
// clamps its input and reports the clamped value back, and does nothing
// while saying so when the hardware cannot do it. None of them throws into
// JS.
//
// These setters are intent. The committed metadata reads the device back at
// capture time, and that is the evidence.

extension ExhibitCameraModule {

  /// { mode: 'auto'|'locked'|'custom', iso?, durationSeconds? }.
  ///
  /// 'custom' needs both iso and durationSeconds. Each is clamped to the
  /// active format's range, not the device's overall one — formats differ —
  /// and the clamped values come back as what was applied.
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
        // Clamp to the active format's own ranges.
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
          // What was requested, clamped. What the device settled on is
          // committed per capture, read back from the device.
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
    // Hand the applied mode to the secondary too.
    mirrorProControlsToSecondary()
  }

  /// The exposure point, independent of the focus point.
  func setExposurePoint(x: Double, y: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    guard device.isExposurePointOfInterestSupported else {
      promise?.resolve(["applied": false, "reason": "exposure-point-unsupported"])
      return
    }
    // Same axis swap as setFocusPoint.
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
  ///
  /// 'manual' locks focus at an explicit lens position, 0 to 1, clamped.
  /// iOS exposes no focus distance, so lens position is the real manual
  /// control, and it is committed with every capture.
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
        // Supporting the locked mode does not mean supporting a custom
        // lens position: some devices report the first and throw an
        // uncatchable exception on the second. The custom-position bit is
        // the only real gate.
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
    // Hand the applied mode to the secondary too.
    mirrorProControlsToSecondary()
  }

  /// { mode: 'auto'|'locked'|'manual', temperature?, tint? }.
  ///
  /// 'manual' turns temperature and tint into gains using the device's own
  /// converter, clamps each gain to what the device allows, locks, and then
  /// converts the clamped gains back — so the caller is told the
  /// temperature and tint the hardware actually accepted, not the ones that
  /// were asked for.
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
        // Same as focus: supporting the locked mode does not mean
        // supporting custom gains, and asking anyway throws uncatchably.
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
        // Convert the clamped gains back, so the UI shows what was
        // applied rather than what was requested.
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
    // Hand the applied mode to the secondary too.
    mirrorProControlsToSecondary()
  }

  /// Sets the torch level. nil turns it off; any level is clamped to the
  /// documented ceiling of 1.0. A device with no torch does nothing and
  /// says so.
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
      // There is no torch-level maximum readable from Swift in this SDK.
      // 1.0 is the documented ceiling; a device that enforces a lower one
      // throws, and the catch below reports applied:false with its error.
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
        "maxTorchLevel": Double(1.0), // the documented ceiling; a lower device limit surfaces as a throw
      ])
    } catch {
      promise?.resolve(["applied": false, "reason": "torch-failed: \(error.localizedDescription)"])
    }
  }
}

// MARK: - Formats, stabilization, HDR, and capabilities

extension ExhibitCameraModule {

  /// Lists what each lens can do. No session needed.
  ///
  /// RAW support is a property of the output, not the format, and needs a
  /// photo output connected to the device. So it is reported from a running
  /// session when there is one, and null with a note otherwise — unknown
  /// rather than guessed.
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
        // This hardware does not have that lens.
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
      // A photo-output property, so null without a session.
      "rawSupported": primaryPhotoOutput.map { !$0.availableRawPhotoPixelFormatTypes.isEmpty } as Any? ?? NSNull(),
      "rawNote": "rawSupported requires a running session (photo-output query); null means unknown, not unsupported",
    ]
  }

  /// { formatID, frameRate? }, applied to the current primary device only —
  /// switch lenses first. Photo and video both come from the device format,
  /// so this one setter covers both, and the result says so. Rolls back and
  /// reports if it would exceed the hardware budget.
  func setFormat(opts: [String: Any], promise: Promise?) {
    guard let session = session, let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    guard let formatID = opts["formatID"] as? String else {
      promise?.resolve(["applied": false, "reason": "missing-formatID"])
      return
    }
    // Parse "<deviceType>:<index>".
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
        // Clamp the rate to the format's ranges, and pin the minimum and
        // maximum together so the synchronizer sees a steady stream.
        let maxFPS = target.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? fps
        let minFPS = target.videoSupportedFrameRateRanges.map { $0.minFrameRate }.min() ?? fps
        appliedFPS = min(max(fps, minFPS), maxFPS)
        let duration = CMTime(seconds: 1.0 / appliedFPS, preferredTimescale: 1_000_000_000)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
      }
      device.unlockForConfiguration()

      // A format that breaks the budget is rolled back and reported,
      // never quietly throttled.
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
        "appliesTo": "photo-and-video", // the device format feeds both
        "hardwareCost": Double(session.hardwareCost),
      ])
    } catch {
      promise?.resolve(["applied": false, "reason": "lock-failed: \(error.localizedDescription)"])
    }
  }

  /// Sets stabilization on the primary video connection. 'auto' hands the
  /// choice to the system, which is allowed — the committed metadata reads
  /// the connection back, so what was actually used is evidence rather than
  /// an assumption.
  func setVideoStabilizationMode(_ mode: String, promise: Promise?) {
    // The capability check lives on the active format; only the preferred
    // and active modes live on the connection.
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
      // Read back off the connection: what the pipeline has now.
      "activeMode": DeviceModeMapper.stabilizationMode(connection.preferredVideoStabilizationMode),
    ])
  }

  /// Reads whether HDR is on for a connection.
  ///
  /// The connection's HDR properties are marked unavailable in recent SDKs,
  /// so this goes through responds-to and key-value access instead: it
  /// compiles on any SDK and returns nil, meaning unknown, where the
  /// property is absent. The selector strings are not type-checked, so they
  /// have to be right by inspection.
  private func connectionVideoHDREnabled(_ connection: AVCaptureConnection) -> Bool? {
    guard connection.responds(to: Selector(("isVideoHDREnabled"))) else { return nil }
    return (connection.value(forKey: "videoHDREnabled") as? NSNumber)?.boolValue
  }

  /// Sets HDR explicitly on the primary video connection, so the committed
  /// metadata can state which it was rather than inheriting a system
  /// default. Turns automatic adjustment off first.
  ///
  /// A format without HDR support does nothing and says so, and where the
  /// control is absent entirely this reports applied:false.
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
    // Key-value writes behind a responds-to check — see
    // connectionVideoHDREnabled above.
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

  /// What this hardware can do, so the UI can hide controls that could not
  /// work. Device-level queries, so it works without a session by falling
  /// back to the rear wide camera. null means unknown without a session,
  /// never a guess.
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
    // The capability check reads the active format; the live-connection
    // gate stays so that no session still means an empty array, which is
    // unknown rather than unsupported.
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
        // Manual focus is locked plus a lens position, so the same gate.
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
        // 1.0 is the documented ceiling — see setTorchLevel. A device
        // enforces its own maximum by throwing, which surfaces there as
        // applied:false with the error.
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
        // min and max are the device's own supported range. qualityCap is
        // this app's ceiling on digital-zoom resampling — a quality
        // choice, not a hardware limit — and the UI clamps to whichever is
        // lower. switchOverFactors are the hand-off points of the virtual
        // device containing this lens, so the UI's optical stops land
        // exactly where the hardware's do.
        "min": Double(device.minAvailableVideoZoomFactor),
        "max": Double(device.maxAvailableVideoZoomFactor),
        "qualityCap": min(
          Double(device.maxAvailableVideoZoomFactor),
          ExhibitZoomCaps.qualityCap(for: device.deviceType)
        ),
        "switchOverFactors": virtualSwitchOverFactors(for: device),
      ],
      // Every rear lens this hardware actually has, each with its hardware
      // maximum and this app's quality cap. The UI picks its ceiling per
      // lens from here. A lens that is not present is absent from the list,
      // never listed with a zero.
      "lensZoomCaps": lensZoomCaps(),
      "zoomQualityNote": "qualityCap values are a conservative app-chosen ceiling for digital-zoom resampling quality — NOT hardware limits; hardwareMax is the device's own maxAvailableVideoZoomFactor",
      // Every rear lens available as a secondary, the current preference,
      // and the third-view probe — an untested extension point, off by
      // default.
      "secondaryLensOptions": rearStackOptions(),
      "secondaryLens": secondaryLensPreference?.rawValue ?? "auto",
      "thirdViewCapable": probeThirdViewSupport(),
    ]
  }

  /// The rear lenses present on this hardware, named the way the bridge
  /// names them. This is the option list for choosing a secondary.
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

  /// The zoom factors at which the hardware hands off between lenses, read
  /// from the virtual device that contains the active one. When the primary
  /// is a physical device — the usual case here — the factors come from the
  /// virtual device at the same position. Empty where no virtual device
  /// exists: single-lens hardware has nothing to hand off to.
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

  /// The zoom ceiling for each lens, keyed the way the bridge names lenses
  /// so the UI never parses a device type string. A lens that is not
  /// present is omitted; listFormats is where presence is stated.
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
