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

  /// Dead sessions, parked here for five seconds and released on
  /// sessionQueue.
  ///
  /// A session that deallocates while anything is still attached to it
  /// aborts the process: AVCaptureSession.dealloc reaches
  /// detachFromFigCaptureSession, which barrier-syncs to Fig's own queue
  /// and asserts. Teardown unbinds everything, but a retain can outlive
  /// that — Fig holds one during an interruption, a preview layer can be
  /// mid-rebind — and then the last release lands wherever that retain was
  /// dropped, on a queue nobody here owns.
  ///
  /// Parking the session guarantees the last release happens here instead:
  /// on our queue, seconds after teardown has settled, with every layer
  /// long since unbound.
  ///
  /// The UUID tag is what makes that true. The release closure captures
  /// only the tag, a value type, which leaves this array as the session's
  /// sole strong owner. A closure that captured the session could become
  /// its last reference and release it from the timer's own teardown; a
  /// closure that cannot hold it cannot. The final release is the array
  /// removal, ordered after the sweep, on this queue.
  private var sessionTomb: [(id: UUID, session: AVCaptureMultiCamSession, attempts: Int)] = []
  /// Every preview layer ever bound to a session. Weakly held, confined to
  /// sessionQueue.
  ///
  /// Reaching layers through `previewView` and `pipLayer` is not enough to
  /// unbind them: both are weak, so a view that died or was replaced before
  /// teardown is skipped, and its layer stays attached to a session already
  /// on its way out.
  ///
  /// Layers register here at bind time, when the view is provably alive.
  /// Teardown and the tomb both sweep this registry, so no layer can still
  /// be attached when a session is released, whatever order the views
  /// happened to die in. Entries are weak: a layer that is truly gone
  /// removes itself.
  private let boundPreviewLayers = NSHashTable<AVCaptureVideoPreviewLayer>.weakObjects()
  /// Which session each registered layer was bound to, recorded here at
  /// bind time.
  ///
  /// The sweep decides from this map and never asks `layer.session`. That
  /// getter can read nil or stale while Fig still considers the layer
  /// attached, and a sweep that trusts it leaves behind exactly the
  /// attachment the abort catches.
  ///
  /// Weak keys and weak values: a dead layer removes itself, and the map
  /// never keeps a session alive — the tomb owns it during the sweep.
  private let boundSessionMap = NSMapTable<AVCaptureVideoPreviewLayer, AVCaptureMultiCamSession>(
    keyOptions: .weakMemory, valueOptions: .weakMemory)
  /// process-GLOBAL last resort. A session whose attachments we
  /// cannot PROVE are gone after the sweep + Fig round-trip + bounded
  /// retries is retained for the lifetime of the process instead of being
  /// released: a session that never deallocs can never hit the dealloc-
  /// time detach assert. Static so it outlives this module instance
  /// (OnDestroy drains into it while the module is dying). Worst case is a
  /// bounded, logged leak of a stopped session — never a SIGABRT. All
  /// appends happen on sessionQueue (single module instance by design).
  private static var sessionGraveyard: [AVCaptureMultiCamSession] = []
  /// Serial queue for evidence-sink I/O (JPEG encodes + file writes). Kept
  /// OFF sessionQueue: a >33 ms encode on the frame queue drops synchronized
  /// pairs and was a stall source. RetainedPair holds ARC-retained
  /// sample buffers, so the hop is memory-safe.
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
  // after start. Invalidated in teardownSession.
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
        self.teardownAndDrainTombs()
      } else {
        self.sessionQueue.sync { self.teardownAndDrainTombs() }
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
        view.setAltPreviewEnabled(value)
        let layer = view.currentPipLayer()
        self.sessionQueue.async {
          self.previewView = view
          self.setPipWanted(value, layer: layer)
        }
      }
    }
  }

  /// Binds the view's layer to the running session, from a prop handler on
  /// main onto sessionQueue.
  ///
  /// Every preview-layer bind and unbind runs on sessionQueue, which puts
  /// them in order with configure, start, and stop by construction. Two
  /// things they must not do: run on main, where setSession: can commit the
  /// capture graph synchronously and stall into the scene-update watchdog;
  /// or run as a fire-and-forget hop, which lets a bound layer outlive the
  /// session it points at.
  func attachViewOnSessionQueue(_ view: ExhibitCameraPreviewView) {
    sessionQueue.async { [weak self, weak view] in
      guard let self = self, let view = view else { return }
      self.previewView = view
      if let session = self.session {
        view.bind(session: session)
        self.boundPreviewLayers.add(view.currentPreviewLayer())
        self.boundSessionMap.setObject(session, forKey: view.currentPreviewLayer())
        if let pip = view.currentPipLayer() {
          self.boundPreviewLayers.add(pip)
          self.boundSessionMap.setObject(session, forKey: pip)
        }
      }
    }
  }

  /// A dying view's unbind, hopped onto sessionQueue. The queue is serial,
  /// so this lands ahead of any release already scheduled for the session
  /// the layer points at.
  func enqueueLayerUnbind(preview: AVCaptureVideoPreviewLayer, pip: AVCaptureVideoPreviewLayer?) {
    sessionQueue.async {
      preview.session = nil
      pip?.session = nil
      self.boundSessionMap.removeObject(forKey: preview)
      if let pip = pip { self.boundSessionMap.removeObject(forKey: pip) }
    }
  }

  /// Detaches every layer this module's own bookkeeping says was bound to
  /// `dead`, without consulting `layer.session`.
  ///
  /// That getter can read nil while Fig still considers the layer attached,
  /// so filtering on it leaves behind exactly the attachment that aborts
  /// the process. Setting `.session = nil` on an already-detached layer
  /// does nothing, so sweeping from bookkeeping costs nothing and misses
  /// nothing this module knows about.
  ///
  /// Runs on sessionQueue, at teardown and again before every release
  /// attempt.
  private func detachRegisteredLayers(from dead: AVCaptureMultiCamSession) {
    // The registry is sessionQueue-confined. A caller on another queue races
    // the sweep against a bind and can leave a layer attached — the exact
    // precondition AVFoundation asserts on. Debug builds say so here first.
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    for layer in boundPreviewLayers.allObjects {
      if boundSessionMap.object(forKey: layer) === dead {
        layer.session = nil
        boundSessionMap.removeObject(forKey: layer)
      }
    }
  }

  /// Checks whether anything still points at `dead`, after the sweep and a
  /// round trip through Fig.
  ///
  /// `layer.session` is unreliable as a filter because it can read nil too
  /// early, but a non-nil read is real evidence of a real attachment. So it
  /// is used here only to prove the session is dirty, never to prove it is
  /// clean. The bookkeeping map is checked as well, in case a bind
  /// re-registered a layer mid-teardown.
  private func layersStillAttached(to dead: AVCaptureMultiCamSession) -> Bool {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    for layer in boundPreviewLayers.allObjects {
      if layer.session === dead { return true }
      if boundSessionMap.object(forKey: layer) === dead { return true }
    }
    return false
  }

  /// Forces Fig to drain any detach work it has parked.
  ///
  /// Work posted to Fig's own queue can sit there for as long as the app is
  /// backgrounded — hours. An empty begin-and-commit pair makes the session
  /// drain that queue now, on our queue, before anything judges whether it
  /// is clean. Both calls are synchronous and legal on a stopped session.
  private func drainFigDetachQueue(of session: AVCaptureMultiCamSession) {
    session.beginConfiguration()
    session.commitConfiguration()
  }

  /// The only place a parked session is released. Sweep, round-trip
  /// through Fig, prove clean, then release.
  ///
  /// The point is to remove the abort's precondition rather than to race
  /// it. A layer pointing at nothing cannot be detached during dealloc, and
  /// a session that cannot be proven clean never reaches dealloc at all.
  ///
  /// If something still provably points at the session, this retries after
  /// 10, 20, and 40 seconds. The retries are bounded so a permanently stuck
  /// session cannot loop forever; after the last one it goes to the
  /// graveyard instead.
  private func releaseTombIfClean(at idx: Int) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    let entry = sessionTomb[idx]
    detachRegisteredLayers(from: entry.session)
    drainFigDetachQueue(of: entry.session)
    guard layersStillAttached(to: entry.session) else {
      // Proven clean. The array removal below is the final release: on
      // sessionQueue, with nothing attached, so the detach that runs during
      // dealloc finds no layer and cannot abort.
      //
      // The rule, stated where it is relied on: no preview layer may
      // reference a session that is about to deallocate. Debug builds trap
      // here if the proof above is ever weakened. Release builds fall
      // through to the retry and graveyard path.
      assert(!layersStillAttached(to: entry.session),
             "tomb released a session with a preview layer still bound")
      sessionTomb.remove(at: idx)
      return
    }
    let attempt = entry.attempts + 1
    let retryDelays: [Double] = [10.0, 20.0, 40.0]
    if attempt <= retryDelays.count {
      sessionTomb[idx] = (id: entry.id, session: entry.session, attempts: attempt)
      let delay = retryDelays[attempt - 1]
      let tombId = entry.id
      logDiagnosticEvent("Preview layer still attached to tombed session after sweep (attempt \(attempt)); retrying release in \(Int(delay)) s")
      sessionQueue.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self = self else { return }
        guard let i = self.sessionTomb.firstIndex(where: { $0.id == tombId }) else { return }
        self.releaseTombIfClean(at: i)
      }
    } else {
      graveyardSession(entry.session, reason: "still attached after \(entry.attempts) release retries")
      sessionTomb.remove(at: idx)
    }
  }

  /// Holds a session that cannot be proven clean for the rest of the
  /// process.
  ///
  /// A session that never deallocates can never abort during dealloc. This
  /// trades a crash for a bounded, logged leak of one stopped session. The
  /// graveyard is static, so it keeps holding even if this module instance
  /// is destroyed.
  private func graveyardSession(_ session: AVCaptureMultiCamSession, reason: String) {
    ExhibitCameraModule.sessionGraveyard.append(session)
    logDiagnosticEvent("Tombed capture session retained for process lifetime (\(reason)); it will never deallocate, by design")
  }

  /// Pushes the running session to the preview view, and reports
  /// first-frame readiness. The bind is enqueued on sessionQueue — callers
  /// include the synchronizer's own queue — so it stays in order with
  /// configure, start, and stop.
  private func pushSessionToPreview(readySignal: String? = nil) {
    sessionQueue.async { [weak self] in
      guard let self = self, let session = self.session, let view = self.previewView else { return }
      view.bind(session: session)
      self.boundPreviewLayers.add(view.currentPreviewLayer())
      self.boundSessionMap.setObject(session, forKey: view.currentPreviewLayer())
      if let pip = view.currentPipLayer() {
        self.boundPreviewLayers.add(pip)
        self.boundSessionMap.setObject(session, forKey: pip)
      }
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
      if let oldLayer = oldLayer { boundSessionMap.removeObject(forKey: oldLayer) }
    }
  }

  /// Creates or repairs the inset's connection, only when a secondary input
  /// is actually plumbed. No partner means no inset: the view keeps an
  /// empty frame rather than showing something that is not the second
  /// camera.
  func ensurePipConnection(in session: AVCaptureMultiCamSession) {
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
    boundPreviewLayers.add(layer)
    boundSessionMap.setObject(session, forKey: layer)
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
  /// teardownSession, and the log call is fire-and-forget, so it is safe
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

    // Focus-settling signal (spec §14): KVO-compliant per AVFoundation
    // docs; emitted so the UI can avoid capturing mid-adjustment.
    focusObserver = primary.observe(\.isAdjustingFocus, options: [.new]) { [weak self] _, change in
      let adjusting = change.newValue ?? false
      self?.sendEvent("onAdjustingFocus", ["adjusting": adjusting])
    }

    syncHandler.onCollection = { [weak self] collection in
      self?.handleSynchronizedCollection(collection)
    }
    // the multi-input secondary's direct delegate closures (nil'd
    // in teardownSession alongside syncHandler.onCollection).
    secondaryDirectHandler.onFrame = { [weak self] buffer in
      self?.handleDirectSecondaryFrame(buffer)
    }
    secondaryDirectHandler.onDrop = { [weak self] in
      self?.handleDirectSecondaryDrop()
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
      teardownSession()
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
      self.teardownSession()
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

    // SEQUENTIAL captures, one photo at a time ( Drop 2): the old code
    // fired capturePhoto on BOTH photo outputs back-to-back. A photo capture
    // on a live multi-cam graph is the documented maximum-resource moment —
    // the video data outputs drop frames for its duration — and doubling it
    // is what wedged the sync pipeline on hardware (stale-pair
    // rejections at shutter; dropped-pair floods starting ~1 s into every
    // session — exactly when this one-shot fired). One at a time halves the
    // spike; when the LAST capture returns we rebind the synchronizer once
    // so any residual delivery weirdness from the stills disruption is reset
    // instead of lingering for the whole session.
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
    guard session != nil else {
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
  /// A session rebuild clears the continuation in teardownSession, and the
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
    // REVIEW-CHECK (EAS build fix): availableRawPhotoPixelFormatTypes
    // elements are already OSType (UInt32) — no.uint32Value. The RAW
    // settings initializer label is rawPixelFormatType: (per the SDK's
    // photoSettingsWithRawPixelFormatType:), and flashMode is fully
    // qualified so the.off member can't lose its contextual base. Next
    // build should confirm all three sites compile.
    guard let rawFormat = photoOutput.availableRawPhotoPixelFormatTypes.first else {
      // Unsupported hardware: unreached, never red (spec §7/§9).
      completion(EvidencePathBuilder.neverRecorded("raw-unsupported"))
      return
    }
    let settings = AVCapturePhotoSettings(rawPixelFormatType: rawFormat)
    if photoOutput.isCameraCalibrationDataDeliverySupported {
      settings.isCameraCalibrationDataDeliveryEnabled = true
    }
    // Setter validates against supportedFlashModes at SET time (uncatchable
    // NSException on a mismatch) — assign only when contained.
    if photoOutput.supportedFlashModes.contains(AVCaptureDevice.FlashMode.off) {
      settings.flashMode = AVCaptureDevice.FlashMode.off
    }
    let dngURL = evidenceDirURL.appendingPathComponent("primary-\(captureId).dng")
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      // The settings requested RAW, so a delivered photo IS the Bayer RAW
      // capture; fileDataRepresentation is the DNG. (No isRawPhoto
      // re-check — the request path is the claim, and it is stated.)
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
      // Release the retained delegate forwarder (sessionQueue hop to keep
      // photoHandlers single-threaded).
      self?.sessionQueue.async {
        if let handlerRef = handlerRef {
          self?.photoHandlers.removeAll { $0 === handlerRef }
        }
      }
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // NSException-safe fire: a settings-validation throw
    // becomes the stated RAW error, never a crash.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      completion(EvidencePathBuilder.error(
        ExhibitCameraErrorCode.platform,
        "RAW capture threw at fire time: \(captureError.localizedDescription)"
      ))
    }
  }
}

// MARK: - Full-res stills (W2.1) — photo-output captures at full sensor resolution

extension ExhibitCameraModule {

  /// One full-res capture's outcome: the three-state evidence path plus the
  /// facts only the photo itself can prove (its own hash, dimensions,
  /// OS-written EXIF, strobe-fired bit).
  private struct FullResOutcome {
    let evidence: [String: Any]        // EvidencePath dict
    let sha256: String?                // hex of the exact bytes on disk
    let dimensions: [String: Int]?     // resolved photo dimensions (iOS 16+)
    let photoExif: [String: Any]?      // OS-written EXIF numbers, verbatim
    let flashFired: Bool?
    let flashRequested: String
    let flashApplied: Bool
    let flashNote: String?
    // M1/C1: device-reported videoZoomFactor at capture-FIRE time — the
    // still is center-cropped/upscaled by it while its EXIF FocalLength
    // stays the physical lens; the crop inputs make the delivered image's
    // effective geometry derivable. nil only with no device reference.
    let zoomFactor: Double?
    // M1/C6: color profile name read out of the delivered JPEG's own bytes
    // (ImageIO) — the artifact speaks for itself; nil = omitted, never
    // assumed from the request path.
    let colorSpace: String?
    // D1: the depth artifact's three-state evidence, the sha256 of its
    // exact bytes, and its metadata (map semantics, dimensions, accuracy,
    // normalization window, calibration when delivered). never-recorded
    // with the reason whenever depth is absent — an honest absence, never
    // a silent gap or a fabricated map.
    let depthEvidence: [String: Any]
    let depthSha256: String?
    let depthMetadata: [String: Any]?
  }

  /// Fires the full-res still captures and folds their outcomes into the
  /// capture payload. Runs on sessionQueue; the completion ALSO fires on
  /// sessionQueue (the photo delegate callback hops) so the downstream
  /// RAW/settle chain keeps its single-queue confinement. The outputs are
  /// captured SEQUENTIALLY — back-to-back photo captures on a live
  /// multi-cam graph are the/pipeline-starvation lesson. A
  /// full-res failure is a stated EvidencePath, never a capture rejection.
  private func attachFullResStills(
    captureId: String,
    evidenceDirURL: URL,
    payload: [String: Any],
    completion: @escaping ([String: Any]) -> Void
  ) {
    // Video mode: the delivery mp4 owns the pipeline; a photo capture
    // mid-recording would starve the writer. Stated, never attempted.
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
        // the stereo still derives from the retained SYNCHRONIZED
        // pair's UW frame — there is no secondary photo output anymore
        // (see configureSession's note). This still is the same buffer the
        // geometry evidence already commits, at stream resolution, encoded
        // once more at full quality. Honest deltas vs the old photo-output
        // still: stream resolution (1280×720 UW), no OS EXIF block, no
        // strobe, no depth — each stated in the outcome below.
        self.deriveSecondaryStillFromPair(
          fileStem: "fullres-secondary-\(captureId)",
          evidenceDirURL: evidenceDirURL
        ) { [weak self] secondaryResult in
          guard let self = self else { return }
          self.mergeFullRes(&out, key: "fullResSecondary", result: secondaryResult)
          completion(out)
        }
      } else {
        // Same never-recorded vocabulary as the video-frame secondary:
        // thermal detach is a stated mid-session event, unsupported is
        // unreached-never-red.
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

  /// One full-sensor JPEG capture on a photo output. The strobe preference
  /// is validated against THIS output's supportedFlashModes (W2.2) — an
  /// unsupported mode degrades to off with the reason stated, never thrown.
  /// The completion always fires exactly once, on sessionQueue.
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
    // The flashMode setter validates against supportedFlashModes at SET time
    // and raises an uncatchable NSException on a mismatch — assign ONLY
    // contained values (an unassigned setting defaults to no flash).
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

    // M1/C1: the zoom factor in force as this capture FIRES (sessionQueue)
    // — real capture-time state, never the configure-time log. The still
    // is center-cropped/upscaled by this same device property; committing
    // it makes the delivered image's effective focal length and FOV
    // derivable (the photo's EXIF FocalLength stays the physical lens).
    let zoomDevice = output === self.primaryPhotoOutput ? self.primaryDevice : self.secondaryDevice
    let zoomFactor = zoomDevice.map { Double($0.videoZoomFactor) }

    // D1: request depth delivery only when honest (flag + live-output
    // support for the current device/format). The reason rides the depth
    // fields when not requested; a delivery/extraction failure later
    // degrades to depth-not-recorded, never to a failed still.
    let depthNotRequestedReason = self.requestDepthIfHonest(settings: settings, output: output)

    let url = evidenceDirURL.appendingPathComponent("\(fileStem).jpg")
    var handlerRef: ExhibitPhotoHandler?
    let handler = ExhibitPhotoHandler { [weak self] photo, error in
      // Release the retained delegate forwarder on sessionQueue (the
      // CaptureKit pattern — photoHandlers is sessionQueue-confined).
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
      // The committed hash binds the EXACT bytes on disk (CryptoKit SHA-256).
      let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
      var dimensions: [String: Int]? = nil
      if #available(iOS 16.0, *) {
        let d = photo.resolvedSettings.photoDimensions
        if d.width > 0, d.height > 0 {
          dimensions = ["width": Int(d.width), "height": Int(d.height)]
        }
      }
      // EXIF: only what the OS wrote into THIS photo's metadata (W2.4);
      // the strobe-fired bit comes from that same metadata, never inferred.
      let exif = PhotoExifExtractor.dictionary(from: photo)
      let fired = PhotoExifExtractor.flashFired(from: exif)
      // D1: depth rides the delivered photo — extracted, written, hashed
      // AFTER the still is safe on disk; any failure here states itself in
      // the depth evidence and NEVER touches the photo's own outcome.
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
    // NSException-safe fire:
    // capturePhoto validates settings against the LIVE multi-cam graph and
    // raises an NSException on any mismatch; Swift cannot catch one, so the
    // fire goes through the ObjC trampoline and a throw becomes this still's
    // stated failure outcome (the delivery still already committed — the
    // full-res block degrades, the capture survives).
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

  /// stereo still WITHOUT a photo output — encode the retained
  /// synchronized pair's secondary (UW) frame at full stream resolution.
  /// The buffer is physically-upright already (the connection's rotation
  /// policy is physical — see configureSession's ORIENTATION CONTRACT).
  /// Runs on sessionQueue (its caller's confinement); the CIContext encode
  /// of a 720p frame is ~5 ms, and captureFullResStill's primary encode
  /// precedes us on the same queue. The completion fires exactly once, on
  /// sessionQueue. Absence states reuse the three-state vocabulary: the
  /// pair's secondary half missing is stalePair (the same reason the
  /// geometry evidence reports); an encode/write failure is sink.
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
    // Same commitment contract as the photo-output still: the hash binds
    // the exact bytes on disk; dimensions are read from the buffer itself.
    let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    let dimensions = [
      "width": CVPixelBufferGetWidth(buffer),
      "height": CVPixelBufferGetHeight(buffer),
    ]
    completion(FullResOutcome(
      evidence: EvidencePathBuilder.path(url.path),
      sha256: digest, dimensions: dimensions,
      // No OS EXIF exists for a video frame — the field is nil (omitted),
      // never a fabricated block. The metadata JSON's source label below
      // states the derivation.
      photoExif: nil, flashFired: nil,
      flashRequested: photoFlashPreference.rawValue, flashApplied: false,
      flashNote: "video-stream-derived still (no secondary photo output by design): stream-resolution UW frame from the synchronized pair — no strobe, no OS EXIF, no depth (stated, not faked)",
      zoomFactor: secondaryDevice.map { Double($0.videoZoomFactor) },
      colorSpace: JpegColorSpaceReader.profileName(from: data),
      depthEvidence: depthNA, depthSha256: nil, depthMetadata: nil
    ))
  }

  /// W7 isolation: compact verbatim state dump appended to every photo-
  /// capture failure message — `key=value` pairs joined by "; ", readable
  /// when pasted from a toast. Reads LIVE connection/device state at
  /// failure time (sessionQueue-confined, like its callers); nothing here
  /// is from the module's request log.
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
    // the VIDEO connections decide whether the pair pipeline can
    // live at all — a silently absent secondary video connection (the
    // iPhone 17 signature) is now visible in every capture failure.
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
    // EVERY debug flag, sorted — not a curated pair. A persisted
    // non-default flag in the exhibit.debug suite survives TestFlight
    // updates (only app deletion clears it) and silently contaminates field
    // runs; a failure dump must carry the whole flag state so a reviewer can
    // see the uncontrolled variable without asking for a second run.
    for (key, value) in ExhibitDebugFlags.all().sorted(by: { $0.key < $1.key }) {
      parts.append("flag.\(key)=\(value)")
    }
    return parts.joined(separator: "; ")
  }

  /// D1 gating: request depth delivery with a photo ONLY when it can be
  /// honest — the escape-hatch flag is ON (default true; depth is a
  /// feature) AND the LIVE output reports support for the CURRENT
  /// device/format configuration (the only real per-lens answer; there is
  /// no session-free depth-support query). Returns the never-recorded
  /// REASON when not requested, nil when requested. Never throws: depth
  /// problems degrade to depth-not-recorded, never to a failed photo. The
  /// RAW path never calls this — RAW + depth delivery are mutually
  /// exclusive.
  private func requestDepthIfHonest(settings: AVCapturePhotoSettings, output: AVCapturePhotoOutput) -> String? {
    guard ExhibitDebugFlags.depthCapture else { return "depth-disabled" }
    // key on the output-level ENABLEMENT, not mere support — the
    // settings setter throws (uncatchable) when delivery isn't enabled on
    // the output (Apple's header). Enablement happens once at addOutput
    // time (applyFullResPhotoPolicy); an output that got here without it
    // (unsupported format, flag off at configure) must never see the
    // per-request flag.
    guard output.isDepthDataDeliveryEnabled else { return "depth-unsupported" }
    settings.isDepthDataDeliveryEnabled = true
    if output.isCameraCalibrationDataDeliverySupported {
      // D1's committed extrinsics ride the same delivery; under the same
      // flag so a regression is isolable on device.
      settings.isCameraCalibrationDataDeliveryEnabled = true
    }
    return nil
  }

  /// D1 depth export: when (and ONLY when) depth data genuinely arrived
  /// with a delivered photo, canonicalize it (ExhibitDepthMapExtractor),
  /// write the PNG, hash the exact bytes the JS commit layer will receive.
  /// Absence is stated three-state, never a silent gap; any failure here
  /// degrades to never-recorded/error — NEVER to a failed photo (the
  /// still is already safe on disk before this runs).
  private func commitDepthArtifact(
    from photo: AVCapturePhoto,
    depthURL: URL,
    device: AVCaptureDevice?,
    photoWidth: Int?,
    photoHeight: Int?
  ) -> (evidence: [String: Any], sha256: String?, metadata: [String: Any]?) {
    guard let depthData = photo.depthData else {
      // Requested but the pipeline produced none (scene-dependent) —
      // stated, never fabricated.
      return (EvidencePathBuilder.neverRecorded("depth-not-delivered"), nil, nil)
    }
    guard let outcome = ExhibitDepthMapExtractor.extract(from: depthData, photoWidth: photoWidth, photoHeight: photoHeight) else {
      return (EvidencePathBuilder.error(ExhibitCameraErrorCode.platform, "Depth data arrived but PNG export failed"), nil, nil)
    }
    var metadata = outcome.metadata
    if let calibration = photo.cameraCalibrationData {
      // The committed extrinsics D1 signs ride the depth metadata when the
      // OS delivered them with this photo.
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
    // The committed hash binds the EXACT bytes on disk (CryptoKit SHA-256)
    // — the JS layer commits this verbatim, no re-hashing ambiguity.
    let digest = SHA256.hash(data: outcome.png).map { String(format: "%02x", $0) }.joined()
    return (EvidencePathBuilder.path(depthURL.path), digest, metadata)
  }

  /// Folds one full-res outcome into the payload. The PRIMARY still also
  /// merges its OS-written EXIF + strobe outcome into captureSettings
  /// (W2.4) — photo metadata is the only honest source for flash-fired.
  private func mergeFullRes(_ payload: inout [String: Any], key: String, result: FullResOutcome) {
    payload[key] = result.evidence
    payload["\(key)Sha256"] = result.sha256 as Any? ?? NSNull()
    payload["\(key)Dimensions"] = result.dimensions as Any? ?? NSNull()
    // M1/C1 + M1/C6: the capture-fire zoom factor and the artifact-read
    // color profile ride beside the hash/dimensions for BOTH full-res
    // artifacts — OMITTED when the source reported nothing, never
    // fabricated (unavailable → omit).
    if let zoomFactor = result.zoomFactor {
      payload["\(key)ZoomFactor"] = zoomFactor
    }
    if let colorSpace = result.colorSpace {
      payload["\(key)ColorSpace"] = colorSpace
    }
    // D1: the depth artifact's three-state evidence + sha256 of its exact
    // bytes + metadata (bytes on disk at the evidence path; mime/map
    // semantics/dimensions/accuracy in the metadata). Absence is stated
    // via the evidence reason — an honest gap, never silent.
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

  /// opts: { deliveryPath, evidenceDir, pairIntervalSec? }. Requires a
  /// running session (configureSession first) — the same session records.
  /// Resolves on the first synchronized frame (shared with the preview
  /// start promise only when the session started in video mode — here the
  /// session is already running, so we arm the writer and resolve once the
  /// writer is accepting frames).
  func startVideo(opts: [String: Any], promise: Promise) {
    guard session != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "configureSession must run before startVideo"))
      return
    }
    // The explicit state machine owns this decision ( Drop 2 — the
    // E_BUSY race). A start that arrives while the previous clip is still
    // sealing QUEUES behind it instead of rejecting: the user tapped record
    // — don't lose the moment. The seal owns a 10 s watchdog, so a queued
    // start can never hang; it re-enters this function once the state
    // returns to.idle.
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

    // Audio input+output are added to the RUNNING session inside a
    // configuration — the synchronizer is untouched (audio sits outside
    // it; synchronized audio/video collections are a known-flaky path).
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
      // Explicit multi-cam wiring — see wireOutput. iOS 26 reworked
      // the audio data output path (WWDC25 session 251: spatial-audio ADOs);
      // an implicitly formed mic connection on a running multi-cam graph is
      // exactly the class of silent dead-end this removes.
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
    // Raw-audio-master sink: creation failure is a SINK failure (onError
    // E_SINK, rawPcmPath:null at stop) — delivery is already safe above.
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
      // the failable converter init previously failed SILENTLY —
      // writer live + nil converter meant every tee no-oped, framesWritten
      // stayed 0, and stop reported rawPcmPath:null with no error anywhere.
      // A nil converter now fails the sink exactly like a creation throw
      // (nil writer + enabled == enabled-but-failed, stated at stop).
      if pcmWriter != nil, pcmConverter == nil {
        sendError(ExhibitCameraErrorCode.sink, "PCM master converter creation failed (format init returned nil) — sink disabled for this take")
        pcmWriter = nil
      }
    }
    // per-take audio diagnostics + ENF anchor state.
    audioBufferCount = 0
    pcmFirstSampleWallClockUtcMs = nil
    pcmAnchorSource = ""
    // post-field: default cadence 2 s (was 5 s); the floor stays 2 s.
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
    // post-field: the FIRST video frame dumps a pair immediately —
    // the record-start anchor is the one moment a reviewer always weighs.
    self.lastPairDumpAt = .distantPast
    self.videoStartDate = Date()
    // IMU sink (0.15): the recording window starts NOW on the mach/boot
    // clock — the same clock the ring's sample timestamps ride, so stopVideo
    // slices [this instant, stop instant] with no conversion. The logger
    // itself started at configureSession (CoreMotion is capture-graph
    // independent) and simply keeps running through the take.
    self.videoSensorStartBootSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    self.videoStartEpochMs = currentEpochMs()

    audioHandler.onAudio = { [weak self] buffer in
      self?.handleAudioSample(buffer)
    }

    // Resolve immediately: the session was already proven live by
    // configureSession's first-frame watchdog. Writer failures surface via
    // onSessionError (E_WRITER) and the stopVideo payload — delivery never
    // dies silently.
    promise.resolve([
      "sessionId": sessionId,
      "startedAtMs": currentEpochMs(),
      "pairIntervalSec": pairIntervalSec,
      "stereo": stereoActive ? "available" : (stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
    ])
  }

  /// Primary video frames → delivery writer (CaptureKit pattern: lazy
  /// input creation from the real stream format; pre-startSession buffers
  /// are dropped, never appended illegally).
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
      // ORIENTATION CONTRACT (double-rotation fix): the capture connection
      // PHYSICALLY rotates these buffers by its videoRotationAngle (the
      // RotationPolicy coordinator angle — see configureSession's
      // orientation contract), so the frames are already upright and `dims`
      // above already reads the rotated dims. The track
      // transform MUST be identity: stamping the connection's rotation
      // angle here was a second rotation on top of physically-upright bytes —
      // sideways playback and sideways thumbnails everywhere the track
      // metadata is honored. videoRotationTransform is only ever valid for
      // connections that do NOT physically rotate (metadata-only outputs);
      // this is not one of them.
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

  /// Rule 4 tee: the delivery AAC writer consumes the native buffers; the
  /// PCM master consumes the converted canonical representation of the SAME
  /// buffers. Runs from the first audio frame (it has its own clock domain —
  /// no coupling to the delivery writer's session-start timing). Any failure
  /// fails the SINK (onError E_SINK, rawPcmPath:null at stop), never delivery.
  private func teeToPcmMaster(_ sampleBuffer: CMSampleBuffer) {
    guard let pcmWriter = pcmWriter, !pcmWriter.failed else { return }
    do {
      if let converted = try pcmConverter?.convert(sampleBuffer) {
        try pcmWriter.append(pcmBuffer: converted)
        if pcmFirstSampleWallClockUtcMs == nil {
          // ENF anchor: the absolute wall-clock time of the FIRST
          // audio sample written to the master. The source buffer's PTS is
          // mach-clock host seconds — the SAME clock the session's video
          // PTS and the sensor ring ride (ExhibitMachClock) — so the
          // host→wall conversion is one subtraction at one instant: the
          // wall clock NOW minus how long ago the source buffer's PTS was.
          // (The written frames trail the source PTS by the converter's
          // SRC delay line — single-digit ms; the anchor is labeled
          // 'source-pts' so the desk knows which instant is committed.)
          let nowHostSec = ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
          let nowMs = currentEpochMs()
          let ptsSec = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
          if ptsSec.isFinite {
            pcmFirstSampleWallClockUtcMs = nowMs - Int64(((nowHostSec - ptsSec) * 1000.0).rounded())
            pcmAnchorSource = "source-pts"
          } else {
            // PTS invalid: the append instant is the honest anchor, labeled.
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

  /// diagnostics (the "export WAV doesn't work" report): the
  /// committed master's CONTAINER facts, read back from the finalized CAF —
  /// the desc ASBD fields and the frame count the payload itself implies.
  /// A build-40 field master showed a container frame count exactly 2×
  /// framesWritten — a divergence no code path here can produce on paper —
  /// so the container truth is now committed WITH the record as data
  /// (framesMatchContainer), never guessed at after the fact. Pure
  /// container walk: no decode, no interpretation, no claims.
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
    // diagnostics: the tap-alive counter. pcmEnabled && this stays
    // 0 for a whole take == the audio tap never delivered (audio-session
    // configuration / permission suspect) — stated at stop.
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
    // fired — drop late audio honestly; stopVideo reports audioTrack:false.
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

  /// Dead mic must not kill delivery (rule 4): video-only start ~500 ms
  /// after the first video frame, stated as audioTrack:false at stop.
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

  /// Periodic stereo pairs, not continuous (spec §8): thermal/power
  /// headroom is real, and a burst of timestamped pairs is enough geometry.
  /// Missed cadence is counted and committed at stop as pairsMissed.
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
    // Built here on sessionQueue: it reads sessionQueue-confined calibration
    // state, and it's cheap (dictionary assembly, no encoding).
    let calibrationDict = buildCalibrationDict(pair: pair)

    // Encode + write on the sink I/O queue — JPEG encoding a 720p buffer
    // plus two file writes can exceed a frame interval and must never run
    // on sessionQueue.
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

  /// Stops video, finalizes the delivery file, returns to preview mode on
  /// the SAME session (audio input/output removed — they were video-only).
  /// IDEMPOTENT ( Drop 2): a second stop while the seal is in flight
  /// joins the in-flight stop and settles with the SAME outcome — it is the
  /// same stop, never a new one. The seal itself is asynchronous and never
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
      // State said recording but the writer is gone — stated, never guessed.
      videoState = .idle
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No video is recording"))
      return
    }
    videoState = .stopping

    audioHandler.onAudio = nil
    let durationMs = videoStartDate.map { Int((Date().timeIntervalSince($0) * 1000.0).rounded()) } ?? 0
    let audioTrack = writerAudioInput != nil && writerStarted
    let deliveryPath = deliveryURL?.path ?? ""
    // post-field: the record-END anchor — force one final pair dump
    // before the counts are read (the encode/write rides sinkIOQueue like
    // every periodic dump; the event reaches the seal alongside the rest).
    maybeDumpPeriodicPair(force: true)
    let pairs = pairIndex
    let missed = pairsMissed

    // PCM sink finalize: drain the SRC delay line, close the CAF, fold into
    // the three-state vocabulary. A zero-frame master is NOT evidence —
    // reported via the failed path (null), never as a recorded file. The
    // disabled case never reaches here as a claim: JS owns the toggle and
    // states 'never-recorded' itself.
    var rawPcmPath: String? = nil
    // ENF anchor + integrity summary: exposed as rawPcmInfo in the
    // stop payload whenever the master commits — the anchor lets the desk
    // cross-correlate the 50/60 Hz mains trace (EvidencePathBuilder.mainsHz
    // states the region's grid) against a reference ENF series in absolute
    // time; the sha256 binds the analysis to the exact committed bytes.
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
        // finish finalized the CAF header (AVAudioFile deinit semantics —
        // the audio-capture module relies on the same behavior), so the
        // bytes hashed here are the committed bytes.
        var sha: String? = nil
        if let bytes = try? Data(contentsOf: pcmWriter.url) {
          sha = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        }
        // Explicit locals: the ternary + `as Any? ?? NSNull` idiom parses
        // the cast onto the ternary's String? and the compiler rejects
        // String? ?? NSNull.
        let anchorSource: String? = pcmAnchorSource.isEmpty ? nil : pcmAnchorSource
        rawPcmInfo = [
          "firstSampleWallClockUtcMs": (pcmFirstSampleWallClockUtcMs as Any?) ?? NSNull(),
          "firstSampleAnchor": (anchorSource as Any?) ?? NSNull(),
          "sampleCount": Int(pcmWriter.framesWritten),
          "sampleRate": Int(PcmMasterWriter.sampleRate),
          "fileSha256": (sha as Any?) ?? NSNull(),
        ]
        // commit the container's own readback alongside the writer's
        // counters — a divergence (like an earlier build's exact 2×) is then a
        // committed fact in the sealed record, not a post-hoc riddle.
        if var info = rawPcmInfo, let facts = cafContainerFacts(pcmWriter.url) {
          for (key, value) in facts { info[key] = value }
          info["framesMatchContainer"] = (facts["containerFrames"] as? Int) == Int(pcmWriter.framesWritten)
          rawPcmInfo = info
        }
      }
    }
    // diagnostics: distinguish WHY the master is absent. The sink
    // was requested but the audio tap delivered nothing all take == an
    // audio-session/tap problem, not a conversion problem — said out loud.
    if pcmEnabled, audioBufferCount == 0 {
      // state the audio connection's liveness so the field run
      // discriminates "no connection" from "connection live, no buffers"
      // (the latter points at the audio session, not the graph).
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

    // IMU sink finalize (0.15): slice the recording window
    // [videoSensorStartBootSec, now] from the ring, written next to the PCM
    // master (sensors-<sessionId>.jsonl). A recording longer than the 60 s
    // ring span commits its TAIL with truncated:true in the file's window
    // line — stated, never implied to be whole. Same three-state vocabulary
    // as the still path; a failed log never blocks the stop. The logger
    // keeps running after the take (the session returns to preview and a
    // still may follow) — only teardown/thermal stops it.
    var sensorFields = sensorLogFields(state: "unavailable")
    if sensorLogWanted, !sensorLogThermalStopped, let logger = sensorLogger, let evidenceDir = evidenceDirURL {
      sensorFields = sensorWindowFields(
        url: evidenceDir.appendingPathComponent("sensors-\(sessionId).jsonl"),
        from: videoSensorStartBootSec,
        to: ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks()),
        anchorStartedAtMs: videoStartEpochMs,
        // The anchor binds the RECORDING START's instant to its wall clock —
        // not the flush instant (the video motion card re-zeroes on it).
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
      // finishWriting's callback fires on an internal writer queue; hop.
      // The seal NEVER blocks the state machine — settlement is a single
      // sessionQueue hop with no I/O in it.
      self.sessionQueue.async {
        if writer.status == .completed {
          var payload: [String: Any] = [
            "deliveryPath": deliveryPath,
            "durationMs": durationMs,
            // sealed projection inputs — the session's primary
            // device, read at finalize on sessionQueue.
            "facing": self.primaryDevice.map { $0.position == .front ? "front" : "back" } as Any? ?? NSNull(),
            "primaryHfovDeg": self.primaryDevice.map { Double($0.activeFormat.videoFieldOfView) } as Any? ?? NSNull(),
            // Structural audio absence is stated EXPLICITLY — never a
            // silently missing track (rules 3/4).
            "audioTrack": audioTrack,
            "pairsCommitted": pairs,
            "pairsMissed": missed,
            // Three-state raw-audio sink: path string = recorded; null =
            // enabled but failed (the disabled case is stated
            // 'never-recorded' by JS, which owns the toggle).
            "rawPcmPath": rawPcmPath as Any? ?? NSNull(),
            // (additive): ENF anchor + integrity summary for the
            // committed master, and the tap-alive counter for diagnostics.
            "rawPcmInfo": rawPcmInfo as Any? ?? NSNull(),
            "audioBufferCount": self.audioBufferCount,
            "hardwareCost": self.session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
          ]
          // IMU sink (0.15), computed above on sessionQueue before the
          // finishWriting hop: sensorLogPath / sensorLogState (+
          // sensorLogError only when 'failed').
          for (key, value) in sensorFields { payload[key] = value }
          self.settleVideoStop(writer: writer, outcome: .success(payload))
        } else {
          let message = writer.error?.localizedDescription ?? "writer did not complete"
          self.settleVideoStop(writer: writer, outcome: .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.writer, "Delivery finalize failed: \(message)")))
        }
      }
    }
  }

  /// The ONE stop-settlement path ( Drop 2): resolves or rejects the
  /// stop promise AND every joined waiter with the same outcome, tears down
  /// writer state, returns the machine to.idle, and releases a queued
  /// startVideo. sessionQueue only. The identity guard is the race fix: a
  /// stale finishWriting/timeout from the PREVIOUS writer must never touch
  /// a NEW recording's state — the old code nil'ed self.writer
  /// unconditionally, which orphaned the new writer when a start had
  /// already re-armed one.
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
  /// sessionQueue only. Re-enters startVideo so every guard and honest
  /// rejection of the normal path applies verbatim — a queued start is a
  /// real start, just later.
  private func flushPendingStartVideo() {
    guard videoState == .idle, let pending = pendingStartVideo else { return }
    pendingStartVideo = nil
    startVideo(opts: pending.opts, promise: pending.promise)
  }

  /// ORIENTATION CONTRACT — READ BEFORE CALLING: this transform may ONLY
  /// ever be applied to a connection whose rotation is METADATA-ONLY (an
  /// output that tags orientation without touching pixels, e.g. a movie-
  /// file output). AVCaptureVideoDataOutput connections PHYSICALLY rotate
  /// their delivered buffers (the RotationPolicy coordinator angle applied
  /// in configureSession / applyConnectionPolicies), so their frames are
  /// already upright — passing
  /// such a connection here and stamping the result on a writer input was
  /// the double-rotation bug (sideways playback + thumbnails). Currently
  /// has NO call sites: every writer/sink in this module consumes physically
  /// rotated buffers and must use.identity / no extra rotation. Kept (and
  /// documented) for any future metadata-only output; if you add a call
  /// site, prove the connection does not physically rotate first.
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

// MARK: - Chrome (spec §3) — all sessionQueue, all clamped, all honest no-ops

extension ExhibitCameraModule {

  /// Lens switch on the RUNNING session: swap the primary input, then
  /// re-derive the stereo partner around it (UW↔W, UW↔T). The bug
  /// (iPhone 17, dual-camera): the old code asked canAddInput BEFORE
  /// removing anything — and the requested lens was the STEREO PARTNER,
  /// already in the session. A session can never hold two inputs for one
  /// device, so every switch on dual-camera hardware failed E_PLATFORM.
  /// The swap now runs as two atomic configurations: detach the
  /// partner if it conflicts + swap the primary, best-effort re-attach
  /// the re-derived partner. Failure at restores the old primary AND
  /// its partner; failure at is an honest single-cam session, stated
  /// in the resolve payload. Never a dead session.
  func setLens(_ lens: ExhibitLens, promise: Promise?) {
    guard let session = session, facing == .back else {
      promise?.resolve(["applied": false, "reason": "no-session-or-front-facing"])
      return
    }
    // on the virtual graph the primary IS the dual-wide virtual
    // device — wide and ultra-wide are both live at once, so a "wide"
    // request is already satisfied and any other primary-lens swap would
    // tear down the working pair. Refused with a stated reason; the
    // ultra-wide view is the 0.5x zoom stop on the same live graph.
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
      // Requested lens not present on this hardware — stated, not faked.
      promise?.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Lens \(lens.rawValue) is not available on this device"))
      return
    }
    do {
      let newInput = try AVCaptureDeviceInput(device: newDevice)
      let oldInput = primaryInput
      let oldDevice = current
      // If the requested device is plumbed as the stereo partner it must
      // leave the session before it can become the primary — duplicate-
      // device inputs are illegal.
      let partnerConflict = secondaryDevice?.deviceType == newDevice.deviceType
      // Rollback helper: put the old partner back AND rebind the
      // synchronizer to the restored topology (a synchronizer left pointing
      // at a removed output stalls the whole frame pipeline).
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
      // the 30 fps billing promise follows the new input too —
      // adding an input resets the override (documented), so a mid-session
      // lens swap would silently return to worst-case billing without it.
      newInput.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
      // requireMultiCam mirrors configureSession: whenever stereo is on,
      // the new primary's format must be multi-cam-legal so the partner
      // re-attach right after this swap can actually stream.
      if configureFormat(device: newDevice, maxWidth: 3840, maxHeight: 2160, requireMultiCam: stereoActive) == false {
        // Roll back: restore the old primary AND its partner.
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
      // The input swap recreates the outputs' connections: re-apply the
      // rotation + mirroring + per-frame intrinsics policies on them.
      if let primaryOut = primaryVideoOutput { applyConnectionPolicies(to: primaryOut, device: newDevice) }
      if #available(iOS 17.0, *), let photoConnection = primaryPhotoOutput?.connection(with: .video) {
        // W7 isolation: default off — wave-5/6 suspect, flip via Settings ▸ Diagnostics when testing
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: photoConnection, device: newDevice)
        } else if photoConnection.isVideoOrientationSupported {
          photoConnection.videoOrientation = .portrait
        }
      }
      // Re-derive the partner around the NEW primary. When the swap
      // consumed the old partner (dual-camera hardware), this is what
      // restores stereo; when attach fails the payload says single-cam.
      let stereoNote: String
      if stereoDetachedForThermal {
        stereoNote = "degraded-thermal"
      } else {
        stereoNote = ensureStereoPartner(excluding: newDevice.deviceType) ? "available" : "unsupported"
      }
      // The synchronizer cannot track topology changes — recreate it over
      // the CURRENT outputs after any swap/detach/attach.
      rebuildSynchronizer()
      // no scheduleSessionCalibrationCapture — the one-shot is
      // retired (see its doc).
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

  /// Best-effort stereo partner attach around the CURRENT primary — the
  /// same plumbing as configureSession's secondary block, factored so a
  /// lens swap can re-pair. Own begin/commit; failures degrade to honest
  /// single-cam (false), never a thrown error. Over-budget graphs are
  /// refused, per spec §6.
  @discardableResult
  private func ensureStereoPartner(excluding primaryType: AVCaptureDevice.DeviceType) -> Bool {
    guard let session = session, facing == .back else { return false }
    if stereoActive, secondaryDevice != nil { return true } // already paired
    // on the virtual graph the pair is inherent to the one input —
    // there is no partner device to attach. A detached stereo (thermal)
    // re-wires fresh outputs to the UW constituent port. The selectable
    // partner preference doesn't apply: the virtual pair is fixed W+UW.
    if virtualGraphActive {
      guard secondaryLensPreference == nil || secondaryLensPreference == .ultraWide else {
        logDiagnosticEvent("stereo partner attach refused on the virtual graph: fixed wide+ultra-wide pair, preference not applicable")
        return false
      }
      guard let vInput = primaryInput, let port = virtualSecondaryPort else { return false }
      let constituent = vInput.device.constituentDevices.first(where: { $0.deviceType == .builtInUltraWideCamera })
      session.beginConfiguration()
      let out = AVCaptureVideoDataOutput()
      // Native format — see configureSession's primary output ( Drop 2).
      out.alwaysDiscardsLateVideoFrames = true
      let videoOK = wireOutput(out, to: vInput, port: port, mediaType: .video, in: session, label: "partner-video") != nil
      // no partner photo output — see configureSession's note.
      session.commitConfiguration()
      guard videoOK else {
        logDiagnosticEvent("stereo partner attach FAILED on the virtual graph: UW port would not re-wire (see wire refusal above)")
        return false
      }
      secondaryDevice = constituent
      secondaryVideoOutput = out
      secondaryPhotoOutput = nil // by design, see configureSession
      stereoActive = true
      if let constituent = constituent {
        applyConnectionPolicies(to: out, device: constituent)
      }
      ensurePipConnection(in: session)
      logDiagnosticEvent("stereo partner attached on the virtual graph: UW constituent port census=\(connectionCensus())")
      return true
    }
    // honor the selectable secondary stack; 'auto' = UW↔W/T.
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
      // configureFormat logs its own failure; a canAddInput refusal lands
      // here silently otherwise — stated either way.
      logDiagnosticEvent("stereo partner attach FAILED: canAddInput=\(session.canAddInput(input)) (see format log lines)")
      return false
    }
    // Explicit multi-cam wiring — see wireOutput.
    session.addInputWithNoConnections(input)
    // the 30 fps billing promise on the partner too — set AFTER the
    // add, which resets the override (documented).
    input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
    let out = AVCaptureVideoDataOutput()
    // Native format — see configureSession's primary output ( Drop 2).
    out.alwaysDiscardsLateVideoFrames = true
    guard wireOutput(out, to: input, mediaType: .video, in: session, label: "partner-video") != nil else {
      session.removeInput(input)
      session.commitConfiguration()
      return false
    }
    // no partner photo output — see configureSession's note.
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
    secondaryPhotoOutput = nil // by design, see configureSession
    stereoActive = true
    applyConnectionPolicies(to: out, device: partner)
    ensurePipConnection(in: session)
    // a mid-session partner takes the primary's current AE/AWB/AF
    // state instead of factory defaults.
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

  /// The synchronizer cannot track output topology changes; recreate it
  /// over the CURRENT outputs after any swap/detach/attach. Cheap — no
  /// session reconfiguration.
  /// on the multi-input graph the synchronizer carries the PRIMARY
  /// ONLY (the secondary delivers directly — see
  /// ExhibitSecondaryDirectHandler); a rebuild then also re-kicks the
  /// direct delegate attachment, so flood rung 1 is meaningful on both
  /// graphs.
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

  /// Rung 2 for a chronic secondary-half flood: the 150-drop
  /// rebind cannot resurrect a secondary stream the platform has parked
  /// (the signature: primary-half 0, secondary-half 100% from
  /// the calibration one-shot onward — a photo capture under pressure can
  /// leave an output unwilling to deliver, an earlier build). Removing and
  /// re-adding the SECONDARY VIDEO DATA OUTPUT forces a fresh connection
  /// and buffer pool without touching the input or the photo output. Once
  /// per session, never mid-recording or mid-capture; whether it worked is
  /// stated by the counters (completePairCount resumes climbing) in the
  /// next degraded reason / stall event.
  private func reseatSecondaryVideoOutput() {
    guard let session = session, stereoActive, secondaryVideoOutput != nil,
          mode != .video, !captureInFlight, !calibrationCaptureInFlight else { return }
    let newOut = AVCaptureVideoDataOutput()
    // Native format — see configureSession's primary output ( Drop 2).
    newOut.alwaysDiscardsLateVideoFrames = true
    session.beginConfiguration()
    // The old output holds the secondary port's video-data-output slot —
    // it must go BEFORE the new one can connect (same-type fan-out from
    // one camera is forbidden). Explicit wiring — see wireOutput.
    if let oldOut = secondaryVideoOutput { session.removeOutput(oldOut) }
    var rewired = false
    // the virtual graph re-wires to the UW constituent port on the
    // ONE input; the multi-input graph re-wires to the secondary input.
    if virtualGraphActive, let port = virtualSecondaryPort, let vInput = primaryInput {
      rewired = wireOutput(newOut, to: vInput, port: port, mediaType: .video, in: session, label: "secondary-video-reseat") != nil
    } else if let sInput = secondaryInput {
      rewired = wireOutput(newOut, to: sInput, mediaType: .video, in: session, label: "secondary-video-reseat") != nil
    }
    session.commitConfiguration()
    guard rewired else {
      // Could not re-wire: the secondary video pipeline is honestly
      // detached and stated — captures degrade via the existing
      // E_STALE_PAIR path; nothing is hidden.
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
    // the multi-input graph's secondary delivers DIRECTLY — the
    // fresh output needs its delegate before the rebuild (which also
    // re-kicks it; setting it here keeps the attachment adjacent to the
    // wiring).
    if !virtualGraphActive {
      latestDirectSecondary = nil
      newOut.setSampleBufferDelegate(secondaryDirectHandler, queue: sessionQueue)
    }
    rebuildSynchronizer()
    logDiagnosticEvent("secondary reseat OK: census=\(connectionCensus())")
  }

  /// Selectable secondary stack — live apply on a running back
  /// session: detach the current secondary pipeline and re-pair around the
  /// CURRENT primary with the new preference. 'auto' (nil preference)
  /// restores the UW↔W/T pairing. Never swaps silently: a preference equal
  /// to the primary lens resolves applied:false with a stated reason.
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
    // no scheduleSessionCalibrationCapture — the one-shot is
    // retired (see its doc).
    promise?.resolve([
      "applied": true,
      "secondaryLens": prefValue,
      "secondaryLensApplied": (secondaryDevice?.deviceType.rawValue as Any?) ?? NSNull(),
      "stereo": attached ? "available" : "unsupported",
      "hardwareCost": Double(session.hardwareCost),
    ])
  }

  /// Front/back flip: front is single-cam, stated (spec §3). Implemented
  /// as a session rebuild — a flip mid-session is a rare, user-visible
  /// transition; rebuilding is simpler than re-plumbing, and the 10 s
  /// first-frame watchdog still guards it. The caller (JS) re-invokes
  /// configureSession with the new facing; this function only validates.
  func setFacing(_ newFacing: ExhibitFacing, promise: Promise?) {
    promise?.resolve([
      "applied": false,
      "reason": "rebuild-required",
      "note": "flip by re-invoking configureSession with facing:'\(newFacing.rawValue)'; front is single-cam, stated",
    ])
  }

  /// Full-sensor stills (W2.1): cap the photo output at its LARGEST
  /// supported dimensions (iOS 16+; older OSes keep the format default and
  /// the committed dimensions say what actually arrived). Set once at
  /// addOutput time — inside the session's begin/commit discipline.
  /// supportedMaxPhotoDimensions is a property of the DEVICE'S ACTIVE
  /// FORMAT (not the photo output); the device is passed explicitly from
  /// each creation site. The "largest" pick is an explicit loop — the
  /// chained max(by:) closure hit the type-checker's time limit (EAS 27).
  private func applyFullResPhotoPolicy(to output: AVCapturePhotoOutput, device: AVCaptureDevice) {
    if #available(iOS 16.0, *) {
      // CLAMP: the largest format-supported
      // dimensions (48 MP-class on iPhone 17) are legal single-cam, but a
      // photo stream that size attached to a LIVE MULTI-CAM graph was the
      // structural suspect for BOTH field failures — the chronic video-
      // frame starvation (356+ dropped pairs, stereo never committing) and
      // AVCapturePhotoOutput failing every capture with "Cannot Record".
      // The session reserves bandwidth/ISP for the configured photo
      // stream; a 48 MP reservation on a multi-cam graph starves the rest.
      // Cap at 12 MP-class — the classic iPhone still size multi-cam
      // graphs have sustained for a decade. The committed
      // fullResStillDimensions state what actually arrived, so the clamp
      // is honest evidence, never a hidden downgrade.
      let maxArea = 12_600_000 // 4032×3024 class
      let supported = device.activeFormat.supportedMaxPhotoDimensions
      var best: CMVideoDimensions? = nil
      var bestArea = 0
      for dims in supported {
        // width/height are Int32 — promote to Int before multiplying so a
        // 12 MP sensor never overflows the comparison.
        let area = Int(dims.width) * Int(dims.height)
        if area > bestArea, area <= maxArea {
          best = dims
          bestArea = area
        }
      }
      if let best = best {
        // ON by default — the unclamped 48 MP photo-stream
        // reservation on a live multi-cam graph was the structural
        // suspect for the secondary-stream flood; the flag is now the
        // escape hatch (see ExhibitDebugFlags).
        if ExhibitDebugFlags.photoMaxDimensionsPolicy {
          output.maxPhotoDimensions = best
        }
      }
      // Nothing under the cap (exotic small format): leave the format
      // default — the committed dimensions say what it is.
    }

    // CRASH FIX (field: "front camera sometimes crashes" + the
    // degraded-path capture crash with depthCapture on): Apple's header
    // for AVCapturePhotoSettings.isDepthDataDeliveryEnabled is explicit —
    // the setter THROWS an uncatchable NSException unless the OUTPUT's own
    // isDepthDataDeliveryEnabled is already YES. The output flag was never
    // set anywhere, so every path whose format reported depth SUPPORT
    // (the TrueDepth front camera; the degraded single-lens path's
    // format) crashed at capture-settings time — the setter ran before
    // the capture itself, which is why the still never existed. Enable
    // output-level delivery here, at addOutput time inside the begin/
    // commit discipline, when the debug flag and the hardware allow;
    // requestDepthIfHonest now keys on the output-level truth. Depth is
    // per-photo processing, not a standing stream reservation — no
    // multi-cam bandwidth cost while idle.
    if ExhibitDebugFlags.depthCapture, output.isDepthDataDeliverySupported {
      output.isDepthDataDeliveryEnabled = true
    }
  }

  /// Instant device-zoom set (W2.3): lens-jump continuity — a sweep that
  /// crossed an optical stop must land on the new stack's factor NOW, not
  /// after a ramp. UI-driven ramps (wheel/pinch scrub) go through
  /// setZoomSmooth. Clamp to the device's supported range; NEVER upscale
  /// past the max and claim it.
  func setZoom(_ factor: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // honesty: the ACTIVE format can pin zoom (multi-cam formats
    // whose max == min). Resolve applied:false with the real ceiling —
    // the UI number must never claim a factor the hardware didn't apply.
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
      // READBACK TRUTH (field,, iPhone 17 / iOS 26.6:
      // "zoom measure moves, image doesn't" with rear Multiple Lenses on —
      // the pinned-format guard didn't cover it). An instant set
      // that doesn't stick is a stated failure, never an applied:true;
      // every commit is logged on BOTH graphs so the field log
      // names the failure class instead of the symptom — the range= fact
      // on these lines is what root-caused the virtual graph's 2.0–4.0
      // pin and drove the graph default flip.
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
      // per-set SUCCESS logging is throttled to the FIRST set on
      // each graph/range signature per session — the ungated log
      // ran the full interpolate→bridge→store path on every gesture
      // commit, a jerkiness source on a live pinch. Failures (the readback
      // mismatch above) still always log. The range= fact on this line is
      // what root-caused the virtual graph's 2.0–4.0 pin and drove the
      // graph default flip.
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

  /// Ramped device-zoom set (W2.3): ramp(toVideoZoomFactor:withRate:) for
  /// UI-driven scrub ramps. The rate is clamped to a sane band so a hostile
  /// or buggy caller can't wedge the device at rate 0 or slam it at 1000.
  func setZoomSmooth(_ factor: Double, rate: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // honesty: same zoom-locked-format guard as setZoom.
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

  /// Photo-strobe preference (W2.2): stored and written into every full-res
  /// capture's photoSettings at shutter time (validated against the output's
  /// supportedFlashModes there). No device mode is touched — flashMode on
  /// photo settings is a safe property set, and the preference survives
  /// sessions so the persisted JS preference always applies.
  func setPhotoFlashMode(_ mode: ExhibitPhotoFlash, promise: Promise?) {
    photoFlashPreference = mode
    let device = primaryDevice
    let supported: [String] = primaryPhotoOutput?.supportedFlashModes.map {
      DeviceModeMapper.flashMode($0)
    } ?? []
    promise?.resolve([
      "applied": true,
      "photoFlash": mode.rawValue,
      // Strobe hardware presence/support is reported, never implied: an
      // empty list means "no session yet" (unknown), not "unsupported".
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
    // Front cameras and devices without torch hardware: stated no-op,
    // never a fabricated "on".
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

  /// Tap-to-focus (spec §3): normalized view point → device point of
  /// interest. Focus AND exposure move together; both fall back to
  /// continuous modes. Unsupported focus mode is a stated no-op.
  func setFocusPoint(x: Double, y: Double, promise: Promise?) {
    guard let device = primaryDevice else {
      promise?.resolve(["applied": false, "reason": "no-session"])
      return
    }
    // The preview layer converts view→device coordinates; with a
    // landscape-native sensor and portrait preview, device x = view y and
    // device y = 1 − view x. REVIEW-CHECK on device for both facings.
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
      // Clamp inside the device's reported range; the committed metadata
      // reads back exposureTargetBias so the actual value is recorded.
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

// MARK: - Thermal policy (spec §6) + lifecycle

extension ExhibitCameraModule {

  /// serious → cadence halves (applied in maybeDumpPeriodicPair) + event.
  /// critical → secondary DETACHED, stated; delivery never dies. Recovery
  /// is not silent: stereo re-probes on the next configureSession (spec §6).
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

  /// Removes the secondary input/output and rebuilds the synchronizer over
  /// the primary output alone. The session keeps running single-cam;
  /// subsequent captures report secondary as E_THERMAL errors (attempted
  /// path, stated) — distinct from unsupported hardware.
  private func detachSecondaryForThermal() {
    guard let session = session else { return }
    session.beginConfiguration()
    detachSecondaryPipeline(in: session)
    session.commitConfiguration()
    rebuildSynchronizer()
    stereoDetachedForThermal = true
  }

  /// Thermal gate for the IMU sink: serious/critical pressure parks the
  /// logger — the same policy that halves pair cadence (serious) and
  /// detaches stereo (critical) (spec §6).
  private func sensorLogBlockedByThermal() -> Bool {
    let state = ProcessInfo.processInfo.thermalState
    return state == .serious || state == .critical
  }

  /// IMU sink thermal park (0.15): stops the logger and marks the sink
  /// thermal-stopped so captures report sensorLogState 'unavailable' — a
  /// stated degradation, never a fabricated log. CoreMotion is independent
  /// of the capture graph, so this is safe even mid-calibration one-shot.
  /// Recovery mirrors the stereo detach: not silent — the logger restarts
  /// only on the next configureSession, which re-reads the toggle.
  private func stopSensorLogForThermal() {
    guard let logger = sensorLogger else { return }
    logger.stop()
    sensorLogger = nil
    sensorLogThermalStopped = true
  }

  /// Stops the session entirely (screen blur / unmount). Safe to call with
  /// nothing running. In-flight video is finalized first honestly: an
  /// unfinished delivery file is worse than a stated rejection.
  func stopSession(promise: Promise) {
    // Guard the WHOLE recording state machine ( Drop 2): tearing down
    // mid-seal orphaned the in-flight stop promise and leaked the writer —
    // the old mode==.video check couldn't see a stop that was still sealing.
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
    // teardownSession unbinds both preview layers synchronously on this
    // queue before releasing the session — no separate hop here.
    let stopError = teardownSession()
    if let stopError = stopError {
      // The session is torn down either way; the rejection states that the
      // stop itself threw.
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Session stop raised an exception: \(stopError.localizedDescription)"
      ))
      return
    }
    promise.resolve(["stopped": true])
  }

  /// full teardown plus IMMEDIATE tomb drain. Must be called ON
  /// sessionQueue (OnDestroy guarantees this via the specific-key check).
  /// Module death cannot strand a tombed session whose 5 s release closure
  /// would early-return on `guard let self`: every layer is swept and every
  /// tomb entry released here, on the queue the tomb contract requires.
  private func teardownAndDrainTombs() {
    _ = teardownSession()
    // same contract as the tomb timer — sweep, drain the Fig
    // queue, PROVE clean before releasing. Module death leaves no time
    // for the retry ladder, so a still-dirty session goes straight to
    // the process-lifetime graveyard (which outlives this module) rather
    // than being released into a dealloc we cannot make safe.
    for entry in sessionTomb {
      detachRegisteredLayers(from: entry.session)
      drainFigDetachQueue(of: entry.session)
      if layersStillAttached(to: entry.session) {
        graveyardSession(entry.session, reason: "still attached at module destroy")
      }
    }
    sessionTomb.removeAll()
  }

  /// Releases all session state. Idempotent; sessionQueue only. Returns the
  /// error from an NSException-safe stopRunning ( Drop 2 — the
  /// SIGABRT path): nil on a clean stop, so stopSession can reject
  /// honestly instead of crashing the bridge. The error is also surfaced as
  /// an onSessionError event (deduped) regardless of caller. Typed (any
  /// Error)? to match the shim's imported return exactly — Swift imports
  /// the ObjC nullable-NSError return as (any Error)? under the pinned
  /// NS_SWIFT_NAME, and a mismatch here was EAS round-2's lone error.
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
    // the isActive timeline observers die with the session.
    connectionActiveObservers.forEach { $0.invalidate() }
    connectionActiveObservers.removeAll()
    sessionStartWallClock = nil
    syncHandler.onCollection = nil
    audioHandler.onAudio = nil
    audioOutput?.setSampleBufferDelegate(nil, queue: nil)
    // the multi-input secondary's direct delegate dies with the
    // session, and the pinned UW frame returns to the pool.
    secondaryDirectHandler.onFrame = nil
    secondaryDirectHandler.onDrop = nil
    secondaryVideoOutput?.setSampleBufferDelegate(nil, queue: nil)
    latestDirectSecondary = nil
    directSecondaryFrameCount = 0
    lastZoomLogSignature = nil
    let deadSession = session
    if let deadSession = deadSession { teardownPipConnection(in: deadSession) }
    // NSException-safe, idempotent stop ( Drop 2): never twice in a
    // row, never reentrant (sessionQueue is serial and this is the only
    // teardown path), and a thrown ObjC exception comes back as an NSError
    // instead of escaping to the bridge as SIGABRT.
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
    // TEARDOWN CRASH FIX (the watchdog logs watchdog + /
    //  SIGABRT, unbind BOTH preview layers HERE,
    // synchronously, on sessionQueue, while `deadSession` still strongly
    // holds the session — so no layer is attached when the last reference
    // drops at the end of this function.
    //   • The main.async hops left every layer attached until the
    //     main queue drained; the layer (which RETAINS its session) could
    //     then die with the session on a Fig workloop, where the session's
    //     dealloc re-entered detachFromFigCaptureSession on its own sync
    //     queue → assert/SIGABRT.
    //   • The same hops put setSession: on MAIN, where it can synchronously
    //     commit the capture graph (_commitConfiguration → _buildAndRunGraph
    //     → AVRunLoopCondition wait) and block past the 8 s scene-update
    //     watchdog while sessionQueue was mid-configuration → SIGKILL.
    // AVCaptureVideoPreviewLayer serializes session attachment internally on
    // its Fig sync queue, so the setter is safe from any OTHER queue; from
    // sessionQueue it is trivially ordered against stopRunning above and
    // against any begin/commit on this serial queue. After these two calls
    // no layer retains the session, so its final release happens right here
    // with nothing attached.
    if let dead = deadSession {
      // Module-held PiP ref first (survives a view swap); the view's own
      // pipLayer is normally the same object — detach is idempotent.
      pipLayer?.session = nil
      if let view = previewView {
        view.detachPipFromSession()
        view.bind(session: nil)
      }
      // `previewView`/`pipLayer` are WEAK — a view that died or was
      // replaced before teardown is skipped by the two unbinds above while
      // its layer may still point at `dead`
      // Sweep the bind-time registry: every layer
      // that ever bound is detached NOW, while deadSession strongly holds
      // the session.
      detachRegisteredLayers(from: dead)
      // tomb the dead session (see the property's note) — our
      // last release happens on sessionQueue 5 s from now, never on a
      // Fig workloop mid-interruption.
      // the closure captures ONLY `tombId` (a value type) — never
      // `dead`. The tomb array is the session's sole strong owner from
      // here, so a dispatch-source handler dispose has nothing to release
      // the
      // closure's strong capture of `dead` was the exact release chain
      // _dispatch_source_handler_dispose → _Block_release →
      // _swift_release_dealloc → session dealloc → detach assert).
      let tombId = UUID()
      sessionTomb.append((id: tombId, session: dead, attempts: 0))
      sessionQueue.asyncAfter(deadline: .now() + 5.0) { [weak self] in
        guard let self = self else { return }
        // A stale token (entry already drained by OnDestroy) is a no-op.
        guard let idx = self.sessionTomb.firstIndex(where: { $0.id == tombId }) else { return }
        // sweep + Fig round-trip + PROVE clean before releasing;
        // bounded retries, then the process-lifetime graveyard. The final
        // release only ever happens after verification (see
        // releaseTombIfClean) — never blindly on a timer.
        self.releaseTombIfClean(at: idx)
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
    // pipWanted/pipLayer intentionally survive a rebuild: the RN altPreview
    // prop handler only refires when the value CHANGES, so clearing them here
    // left the inset permanently black after any session rebuild (bug).
    // configureSession's ensurePipConnection reattaches to the same layer.
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
    // Shutter-burst teardown: drop the ring + abandon any
    // collection. A capture waiting on the burst settles via its own 10 s
    // watchdog — the existing teardown-mid-capture discipline.
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
    // secondaryLensPreference intentionally survives a rebuild (the
    // photoFlashPreference pattern): a stored preference applies at the
    // next configureSession unless that call's opts override it.
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
    // IMU sink teardown (0.15): stop delivery, drop the ring, nil the
    // reference. Safe from sessionQueue (CoreMotion stop + lock-confined
    // clear; handlers are [weak self]).
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
    // A stop in flight (or joined to one) must never dangle across a
    // teardown: reject every outstanding promise honestly — the seal's
    // late finishWriting completion is identity-guarded and becomes a no-op.
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
    // A queued start (E_BUSY race fix, Drop 2) must never dangle
    // across a teardown: reject it honestly.
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
// Every setter: sessionQueue-confined, capability-guarded, clamps applied
// and REPORTED BACK, and a safe stated no-op (never a JS-visible throw)
// when the hardware lacks the capability. The committed metadata reads the
// device back at capture time — these setters are intent, the metadata
// block is evidence.

extension ExhibitCameraModule {

  /// { mode: 'auto'|'locked'|'custom', iso?, durationSeconds? }.
  /// 'custom' requires both iso and durationSeconds; each is clamped to the
  /// ACTIVE FORMAT's min/max (not the device's global range — formats
  /// differ) and the clamped values are reported back as applied values.
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
        // Clamp to the active format's actual ranges (spec §14).
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
          // The REQUESTED-clamped values; the device-settled values are
          // committed in the metadata block at capture (device-reported).
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
    // mirror the applied exposure mode onto the secondary.
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
    // Same view→device mapping as setFocusPoint (REVIEW-CHECK on device).
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
  /// 'manual' = focus locked at an explicit lensPosition (0–1, clamped).
  /// iOS has no focus-distance API; lensPosition is the honest manual
  /// control and it is committed per capture (spec §5).
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
        // crash fix: isFocusModeSupported(.locked) is NOT sufficient
        // for the custom-lens-position API — the virtual DualWide device
        // reports.locked supported yet setFocusModeLocked(lensPosition:)
        // throws an NSException (one report). Swift cannot
        // catch ObjC exceptions; the custom-position support bit is the
        // only honest gate.
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
    // mirror the applied focus mode onto the secondary.
    mirrorProControlsToSecondary()
  }

  /// { mode: 'auto'|'locked'|'manual', temperature?, tint? }.
  /// 'manual' converts temperature+tint → gains via the device's own
  /// converter, clamps each gain to [1, maxWhiteBalanceGain], locks, and
  /// reports the round-tripped temperature/tint of the CLAMPED gains so
  /// the caller sees what the hardware actually accepted.
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
        // crash fix: same class as focus —.locked mode support does
        // NOT imply custom-gains locking; the virtual device throws an
        // uncatchable NSException. Gate on the custom-gains bit.
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
        // Round-trip: what temperature/tint do the clamped gains
        // correspond to? Reported so the UI shows what was applied.
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
    // mirror the applied white-balance mode onto the secondary.
    mirrorProControlsToSecondary()
  }

  /// Torch with level: nil → off; otherwise setTorchModeOn(level:)
  /// clamped to the documented 1.0 API ceiling. Missing torch hardware is a
  /// stated no-op, never a throw (spec §14 guardrail).
  // REVIEW-CHECK (EAS build fix): maxTorchLevel is NOT an AVCaptureDevice
  // member — the documented surface is the global constant
  // the 1.0 API ceiling (compiler confirmed neither maxTorchLevel symbol exists
  // exist). Argument label is level:, not withLevel:. Next build should
  // confirm all three maxTorchLevel sites compile.
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
      // REVIEW-CHECK (EAS build fix 2): neither AVCaptureDevice.maxTorchLevel nor
      // the global AVCaptureMaxTorchLevel is visible to Swift in this SDK. 1.0 is
      // the documented torch-level ceiling; if a device enforces a lower maximum,
      // setTorchModeOn(level:) throws and the catch below returns applied:false
      // with the native error — the failure is surfaced, never hidden.
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

  /// Per-lens format inventory. No session required — device-level query.
  /// formatID is "<deviceType.rawValue>:<index>" (stable per device model
  /// + OS). RAW support is per-OUTPUT, not per-format: it requires a photo
  /// output connected to the device, so it is reported from the running
  /// session when available and null with a note otherwise — stated,
  /// never guessed.
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
        // Lens absent on this hardware: present:false — unreached, never red.
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
      // RAW is a photo-output property; honest null without a session.
      "rawSupported": primaryPhotoOutput.map { !$0.availableRawPhotoPixelFormatTypes.isEmpty } as Any? ?? NSNull(),
      "rawNote": "rawSupported requires a running session (photo-output query); null means unknown, not unsupported",
    ]
  }

  /// { formatID, frameRate? } — applies to the CURRENT primary device
  /// only (switch lenses first). Both photo and video flow from the device
  /// format, so one setter covers both — stated in the result. Rolls back
  /// and reports if the hardware-cost budget would be exceeded (spec §6).
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
        // Clamp the requested frame rate into the format's supported
        // ranges; pin min==max so the synchronizer sees a steady stream.
        let maxFPS = target.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? fps
        let minFPS = target.videoSupportedFrameRateRanges.map { $0.minFrameRate }.min() ?? fps
        appliedFPS = min(max(fps, minFPS), maxFPS)
        let duration = CMTime(seconds: 1.0 / appliedFPS, preferredTimescale: 1_000_000_000)
        device.activeVideoMinFrameDuration = duration
        device.activeVideoMaxFrameDuration = duration
      }
      device.unlockForConfiguration()

      // Hardware-cost watchdog (spec §6): a format that breaks the budget
      // is rolled back and reported, never silently throttled.
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

  /// Video stabilization on the primary video connection. 'auto' is the
  /// system choice — allowed, but the committed metadata reads the
  /// connection back so the applied mode is evidence, not assumption.
  func setVideoStabilizationMode(_ mode: String, promise: Promise?) {
    // REVIEW-CHECK (EAS build fix): connection-level
    // isVideoStabilizationModeSupported(_:) no longer exists in recent
    // SDKs — the documented capability check is
    // AVCaptureDevice.Format.isVideoStabilizationModeSupported(_:) on the
    // active format. preferredVideoStabilizationMode /
    // activeVideoStabilizationMode stay on the connection. Next build
    // should confirm this compiles.
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
      // Connection read-back: what the pipeline actually has now.
      "activeMode": DeviceModeMapper.stabilizationMode(connection.preferredVideoStabilizationMode),
    ])
  }

  /// REVIEW-CHECK (EAS build fix): the iOS 13-era connection HDR
  /// properties (automaticallyAdjustsVideoHDREnabled / isVideoHDREnabled)
  /// are marked unavailable in recent SDKs — direct member access failed
  /// this build. All access goes through responds(to:) + KVC
  /// (value(forKey:) / setValue(_:forKey:)) so it compiles on any SDK and
  /// returns nil (stated unknown) where the feature is absent. The
  /// selector strings are never type-checked by the compiler; next build
  /// should confirm this compiles, and the on-device soak should confirm
  /// the selectors respond on HDR-capable hardware.
  private func connectionVideoHDREnabled(_ connection: AVCaptureConnection) -> Bool? {
    guard connection.responds(to: Selector(("isVideoHDREnabled"))) else { return nil }
    return (connection.value(forKey: "videoHDREnabled") as? NSNumber)?.boolValue
  }

  /// Explicit HDR on the primary video connection — never a silent system
  /// default (spec §14). Disables automatic adjustment first; a format
  /// without HDR support is a stated no-op. Where the connection HDR
  /// control surface is absent (SDK-gated), this honestly degrades to
  /// applied:false — the TS bridge already handles that.
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
    // Selector-gated KVC writes — see connectionVideoHDREnabled above.
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
  /// (spec §14 guardrail). Device-level queries; works without a session
  /// (falls back to the back wide camera). null means "unknown without a
  /// session", stated — never guessed.
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
    // REVIEW-CHECK (EAS build fix): capability check moved to the active
    // format (the connection-level API was removed in recent SDKs). The
    // live-connection gate is kept so "unknown without a session → empty
    // array" semantics hold unchanged.
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
        // Manual focus = locked + lensPosition; same support gate.
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
        // REVIEW-CHECK (EAS build fix 2): documented API ceiling is 1.0 — see
        // the setTorchLevel note above. The device enforces its own maximum by
        // throwing, which setTorchLevel surfaces as applied:false + native error.
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
        // min/max are the ACTIVE device's own supported range, unchanged
        // (W2.3 keeps the field's hardware semantics). qualityCap is the
        // app-chosen digital-quality ceiling for this device (see
        // ExhibitZoomCaps — a quality choice, NOT a hardware limit); the
        // UI clamps to min(max, qualityCap). switchOverFactors are the
        // hardware hand-off points of the virtual device that contains
        // this stack, so the UI's optical stops match them exactly.
        "min": Double(device.minAvailableVideoZoomFactor),
        "max": Double(device.maxAvailableVideoZoomFactor),
        "qualityCap": min(
          Double(device.maxAvailableVideoZoomFactor),
          ExhibitZoomCaps.qualityCap(for: device.deviceType)
        ),
        "switchOverFactors": virtualSwitchOverFactors(for: device),
      ],
      // Per-constituent-device ceilings (W2.3): every back stack this
      // hardware actually has, each with its hardware max AND the
      // app-chosen quality cap. The UI picks its ceiling per lens from
      // this; an absent lens is absent (unreached, never a zero).
      "lensZoomCaps": lensZoomCaps(),
      "zoomQualityNote": "qualityCap values are a conservative app-chosen ceiling for digital-zoom resampling quality — NOT hardware limits; hardwareMax is the device's own maxAvailableVideoZoomFactor",
      // (additive): the selectable secondary stack — every rear
      // stack present on this hardware, the current preference, and the
      // third-view hardware probe (UNTESTED extension point; the flag is
      // off by default — see ExhibitDebugFlags.thirdViewEnabled).
      "secondaryLensOptions": rearStackOptions(),
      "secondaryLens": secondaryLensPreference?.rawValue ?? "auto",
      "thirdViewCapable": probeThirdViewSupport(),
    ]
  }

  /// The rear stacks present on this hardware, in the bridge's lens
  /// vocabulary ( the selectable secondary stack's option list).
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

  /// Hardware hand-off points (W2.3): virtualDeviceSwitchOverVideoZoomFactors
  /// of the virtual device containing the active stack. When the primary IS
  /// a physical device (the usual case here), the factors are read from the
  /// virtual device (triple/dual-wide/dual) at the same position. Empty
  /// when no virtual device exists — single-stack hardware has no hand-off.
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

  /// Per-constituent-device zoom ceilings (W2.3). Keyed by the bridge's
  /// lens vocabulary so the UI never parses deviceType rawValues. Devices
  /// not present are omitted entirely (absence stated by omission — the
  /// lens inventory in listFormats is the presence source).
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
