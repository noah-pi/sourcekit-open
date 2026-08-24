// NOT COMPILED BY CI. No Swift compiler runs against this file in this
// repository; it is exercised only by an on-device soak run. See
// docs/PROVENANCE.md for what the test lab does and does not reach.
import ExpoModulesCore
import AVFoundation
import CoreMedia
import CoreVideo
import CoreImage
import CryptoKit
import UIKit
import simd

/**
 * ExhibitCamera — the app's ONE camera session (Spec-Camera-Module-0.13).
 *
 * The camera commits, it never concludes: this module captures frames,
 * calibration, timestamps, and metadata. No analysis, no verdicts. Depth
 * (D1,): a depth map is committed when — and only when — the
 * hardware honestly delivers one with a photo; otherwise the payload
 * states depth-not-recorded with the reason. Every committed
 * artifact is an input the desk can re-derive from; nothing is a computed
 * answer.
 *
 * Architecture:
 *   - ONE AVCaptureMultiCamSession, unconditionally — single-cam devices
 *     run the same code path with one input/output (spec §1, §7).
 *   - Primary + secondary AVCaptureVideoDataOutput feed an
 *     AVCaptureDataOutputSynchronizer delivering hardware-synced frame
 *     pairs onto the serial sessionQueue (spec §4.1).
 *   - The native preview layer (ExhibitCameraPreviewView) binds to this
 *     same session — zero contention by construction.
 *   - Delivery video uses the CaptureKit AVAssetWriter pattern (H.264 +
 *     AAC); audio output sits OUTSIDE the synchronizer (synchronized
 *     audio/video collections are a known-flaky path — forums), on the
 *     same serial queue.
 *
 * Calibration strategy (REVIEW-CHECK — see spec §4.2 and the companion
 * report): per-frame intrinsics come from the DOCUMENTED attachment path
 * (connection.isCameraIntrinsicMatrixDeliveryEnabled → sample-buffer
 * attachment kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, iOS 11+).
 * Full calibration (extrinsics, distortion LUTs) comes from the DOCUMENTED
 * photo path (AVCapturePhotoSettings.isCameraCalibrationDataDeliveryEnabled
 * → photo.cameraCalibrationData), captured once per session configuration
 * via a dual photo capture, and from the RAW photo when opted in.
 * that one-shot is OFF BY DEFAULT (ExhibitDebugFlags
 * .sessionCalibrationPhoto) — the flood (primary-half drops
 * 0, secondary-half 100%, onset ~1 s into the session = the one-shot's
 * fire time) names its SECONDARY photo capture the primary suspect for
 * the dead secondary stream. With it off, calibrationSource commits
 * 'unavailable' — stated, never fabricated; per-frame intrinsics ride the
 * frame attachments, unaffected. The ≤12 MP maxPhotoDimensions clamp on
 * the photo outputs is likewise ON by default now (the unclamped 48 MP
 * photo-stream reservation on a live multi-cam graph was the
 * structural suspect); both flags were A/B-flippable from
 * Settings ▸ Diagnostics (the calibration switch and one-shot were later
 * retired outright — see below).
 * AVCaptureVideoDataOutput.isCameraCalibrationDataDeliveryEnabled is NOT
 * used: its presence/behavior on the video data output could not be
 * confirmed from public documentation at draft time. If on-device review
 * confirms a per-frame full-calibration path exists, it should replace the
 * session-photo path; the committed JSON's `calibrationSource` field is
 * designed so the desk can tell which path produced every matrix.
 *
 * additions:
 *   - Drop-flood diagnostics split: secondary-ABSENT (the synchronizer
 *     returned no data object) vs secondary-DROPPED (the platform marked
 *     the data dropped) vs complete pairs vs stale shutters — the
 *     flood could not be discriminated past "secondary-half N".
 *   - Secondary-output RESEAT (rung 2): one remove/re-add of the secondary
 *     video data output per session at 300 consecutive secondary drops
 *     (the 150-drop rebind cannot resurrect a parked stream).
 *   - Shutter-burst sink ("frames around the shutter"): opt-in via
 *     configureSession(opts.ring); a tiny retained ring (3 pre + 4 post,
 *     preview mode only, complete frames only) commits to
 *     evidenceDir/ring-<captureId>/ as ringBufferDir on the capture
 *     payload. Depth is deliberate — held frames hold pool buffers.
 *   - Raw-audio-master ENF anchor: rawPcmInfo on the stopVideo payload
 *     (firstSampleWallClockUtcMs, sampleCount, sampleRate, fileSha256) +
 *     the tap-alive counter (audioBufferCount) + the previously-silent
 *     converter-creation hole, now a stated E_SINK.
 *   - Selectable secondary stack (configureSession opts.secondaryLens /
 *     setSecondaryLens; 'auto' = the UW↔W/T pairing) and an inert,
 *     flag-gated, UNTESTED extension point for a third synchronized view
 *     (capabilities.thirdViewCapable reports the hardware probe).
 *
 * (iPhone 17 matrix verdict): the secondary AVCapturePhotoOutput
 * is GONE — never attached in any configuration. The 2026-08-17 matrix ran
 * all four 12MP-clamp × session-calibration combinations on the old build:
 * every session delivered ZERO secondary video frames from frame one with a
 * green census, pressure 0.69 (< 1.0), hardwareCost 0.5, and a LIVE PiP
 * (preview layer bound directly to the UW port, bypassing the data output).
 * Both debug flags, both costs, and the formats are exonerated; the photo
 * output's attachment was the last shared structural element. The stereo
 * still now derives from the retained synchronized pair's UW frame
 * (deriveSecondaryStillFromPair) at stream resolution — stated in the
 * outcome's flashNote, with no OS EXIF / strobe / depth (all three stated,
 * never faked). UW session calibration commits 'unavailable' (the one-shot
 * covers the primary only). If complete-pairs climb from zero on this
 * build, the photo output's mere attachment was the killer; if not, the
 * graph is minimal (video data outputs only) and the failure dump
 * exonerates outputs entirely.
 *
 * the session-calibration one-shot is RETIRED — no call site
 * remains and the settings switch is gone. With the secondary photo
 * output detached (above), the one-shot could only ever harvest a
 * primary-only calibration, and the committed rig extrinsic requires BOTH
 * lenses' full calibration — so its product was unreachable by any
 * commitment path while the capture itself remained the named
 * suspect. The calibration block commits 'unavailable' (stated, never
 * fabricated); per-frame intrinsics ride the frame attachments and were
 * never behind the switch. The 12 MP clamp stays ON by default behind
 * photoMaxDimensionsPolicy.
 *
 * additions (iPhone 17 / iOS 26 triage):
 *   - EXPLICIT multi-cam wiring everywhere the graph is built
 *     (addInputWithNoConnections / addOutputWithNoConnections + manual
 *     AVCaptureConnection per port — the WWDC19 249/225 pattern; implicit
 *     connection forming is Apple's documented multi-cam hazard). The
 *     signature was a secondary video data output ABSENT for
 *     the synchronizer's whole life while the explicitly-wired PiP preview
 *     on the SAME input port streamed fine.
 *   - Connection census diagnostics: a per-output
 *     enabled/active/port-device summary rides the configureSession resolve
 *     payload ("connections"), the onSyncStalled event, and every capture
 *     failure dump (primaryVideoConn/secondaryVideoConn).
 *   - Shutter-burst ring retains primary-valid frames even when the
 *     secondary half is absent (each ring index entry states its own
 *     completeness) — a secondary flood degrades the burst to primary-only
 *     frames honestly instead of committing no burst at all.
 *   - The zero-audio-buffer E_SINK now states the audio connection's
 *     liveness (audioConn=...) so the field can discriminate "no
 *     connection" from "connection live, no buffers".
 *
 * additions (iPhone 17 / iOS 26.6 triage, round 2 — the
 * explicit wiring shipped and the signature was UNCHANGED, which
 * exonerates connection forming and indicts the stream configuration):
 *   - configureFormat now filters isMultiCamSupported when a second camera
 *     will run (Apple: on AVCaptureMultiCamSession you may ONLY set
 *     multi-cam-flagged formats — the rule this module silently violated,
 *     and the top remaining suspect for the secondary stream never
 *     activating). Falls UP to the smallest multi-cam format rather than
 *     failing the attach; every pick/refusal is logged.
 *   - Every silent failure path in the graph build (wireOutput refusal
 *     stages, format picks, partner-attach rollback, reseat outcome) now
 *     writes to the persistent diagnostics log via onCameraDiagnostic.
 *   - The live connection census (enabled/active/port-device + each
 *     device's active format summary) rides: the configureSession log
 *     line, the first-frame log line, both stall-flood rungs, every
 *     capture payload ("connections"), and session interruption events
 *     (AVCaptureSessionWasInterrupted / InterruptionEnded / runtimeError
 *     observers, all logged).
 *   - Exposure/white-balance/focus parity: both devices are pinned to
 *     continuousAutoExposure + continuousAutoWhiteBalance at configure
 *     time, and pro controls (bias, exposure mode, WB mode, focus mode)
 *     mirror onto the secondary with per-device guards and clamps
 *     (mirrorProControlsToSecondary).
 *
 * Thread confinement: ALL mutable session state lives on `sessionQueue`.
 * The synchronizer and the audio output deliver onto that same queue.
 * Events are emitted from that queue (sendEvent is safe from any thread);
 * view-scoped events hop to main.
 *
 * Watchdogs: every native await has a timeout —
 * first frame 10 s, capture 10 s, stop 10 s. A hung native call must
 * never freeze the UI.
 *
 * No network I/O of any kind.
 */

/**
 * promise.reject(code, description) silently DROPS the description on
 * SDK 57 (see CaptureKitModule for the full audit note). This subclass
 * carries the message in `reason` so actionable errors reach JS.
 * Own copy — separate pod target.
 */
final class ExhibitCameraNamedException: Exception {
  private let message: String
  init(_ code: String, _ message: String) {
    self.message = message
    super.init(name: code, description: message, code: code)
  }
  override var reason: String { message }
}

/// AVCaptureDataOutputSynchronizerDelegate forwarder. The Module class is
/// not an NSObject, so delegate conformance lives here (CaptureKit pattern).
final class ExhibitSyncHandler: NSObject, AVCaptureDataOutputSynchronizerDelegate {
  var onCollection: ((AVCaptureSynchronizedDataCollection) -> Void)?

  func dataOutputSynchronizer(
    _ synchronizer: AVCaptureDataOutputSynchronizer,
    didOutput synchronizedDataCollection: AVCaptureSynchronizedDataCollection
  ) {
    onCollection?(synchronizedDataCollection)
  }
}

/// AVCaptureVideoDataOutputSampleBufferDelegate forwarder for the
/// MULTI-INPUT graph's secondary stream. On iPhone 17 / iOS 26.x
/// the AVCaptureDataOutputSynchronizer over two PHYSICAL devices never
/// surfaced a single secondary data object — not –, and not
/// in the retest with the graph minimal (green census, zero
/// callbacks, while the UW photo path, the PiP preview layer, and the same
/// output type on the VIRTUAL graph all streamed). The multi-input
/// secondary therefore delivers DIRECTLY — the AVMultiCamPiP topology —
/// and pairs by PTS in handleSynchronizedCollection. The Module class is
/// not an NSObject, so delegate conformance lives here (CaptureKit
/// pattern, same as ExhibitSyncHandler/ExhibitAudioHandler).
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

/// AVCapturePhotoCaptureDelegate forwarder — one per photo-output capture
/// (session calibration one-shot and RAW opt-in).
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

/// The latest valid synchronized pair, retained on sessionQueue. The pair
/// holds the sample buffers directly (ARC-managed CF references — see the
/// note below). We hold AT MOST ONE pair and release the previous
/// immediately —
/// capture pixel buffers come from a finite pool and holding several
/// starves the pipeline into frame drops (Apple doc note). Intrinsics are
/// NOT extracted here: the attachment rides the retained sample buffer, so
/// frameIntrinsics(from:) reads it lazily at commit time and the per-frame
/// delivery callback stays allocation-free ( Drop 2 — see
/// handleSynchronizedCollection).
// ROOT-CAUSE FIX (build-40 failure — the burst committed ONE
// image while the phone was deliberately moving): the pre-fix struct stored
// the synchronizer's WRAPPER objects. Apple's header contract
// (AVCaptureDataOutputSynchronizer.h) is explicit: "Synchronized sample
// buffer data is valid for the duration of AVCaptureDataOutputSynchronizer's
// -dataOutputSynchronizer:didOutputSynchronizedData: delegate callback. To
// extend the sample buffer data beyond the callback, you must CFRetain it,
// and later call CFRelease when you're done with it." Retaining the wrapper
// retains NOTHING of the payload — the sample buffer returns to the output
// pool after the callback and the pool recycles it, so every ring entry
// ended up aliasing the NEWEST delivered buffer: identical JPEGs no matter
// how the scene moved. The PTS-advance guard could not see this: the
// PTS was read at append time (inside the callback, where the wrapper is
// still valid), so the ring filled honestly — it was the commit-time reads
// (seconds later, on sinkIOQueue) that all landed on the same recycled
// buffer. The fix holds the CMSampleBuffers THEMSELVES, extracted inside
// the callback at construction. A Swift CMSampleBuffer is an ARC-managed CF
// reference: storing it IS the required retain, ring eviction / teardown
// nil-assignment is the release, and the pool cannot recycle a buffer a
// live reference still pins. Intrinsics are still NOT extracted here: the
// attachment rides the retained sample buffer, so frameIntrinsics(from:)
// reads it lazily at commit time and the per-frame delivery callback stays
// allocation-free ( Drop 2 — see handleSynchronizedCollection).
private struct RetainedPair {
  var primary: CMSampleBuffer
  var secondary: CMSampleBuffer?    // nil in single-cam mode
  var deltaMs: Double?              // secondary−primary PTS delta; nil single-cam
  var receivedAt: Date
}

public class ExhibitCameraModule: Module {

  // MARK: - Session state (ALL confined to sessionQueue)

  private let sessionQueue = DispatchQueue(label: "com.exhibit.camera.session")
  /// lets OnDestroy detect "already on sessionQueue" before
  /// sync-ing onto it — sync-ing from the queue itself would deadlock.
  /// Set once from OnCreate, before any AsyncFunction can fire.
  private let sessionQueueSpecificKey = DispatchSpecificKey<UInt8>()

  /// Dead sessions held for a grace window and released ON sessionQueue
  /// if ANY attachment outlives
  /// teardownSession's unbinds — a Fig-internal retain during an active
  /// interruption, a preview layer mid-rebind — the session's dealloc can
  /// land on a Fig workloop, where AVCaptureSession.dealloc →
  /// _makeConfigurationLive → detachFromFigCaptureSession barrier-syncs to
  /// the Fig sync queue and ASSERTS (SIGABRT) on the inconsistent state.
  /// The tomb guarantees OUR last release happens here, seconds after the
  /// teardown transient has settled, with every layer long unbound — so
  /// the dealloc-time detach finds nothing attached, on a queue we own.
  /// Entries release 5 s after teardown; a session Fig retains longer
  /// still deallocs with no layers attached, which is the assert's
  /// precondition, not merely the queue.
  /// The UUID tag exists so the 5 s release
  /// closure can capture ONLY the tag — a value type — leaving this array
  /// as the session's SOLE strong owner. The closure captured the
  /// session itself, and its dispatch-source handler dispose was the
  /// release chain in every one of those stacks (_dispatch_source_handler_
  /// dispose → _Block_release → _swift_release_dealloc → session dealloc →
  /// detach assert). A closure that cannot hold the session cannot be its
  /// last reference; the final release is now the array removal, ordered
  /// after the sweep, on this queue.
  private var sessionTomb: [(id: UUID, session: AVCaptureMultiCamSession, attempts: Int)] = []
  /// Every preview layer that has EVER
  /// been bound to a session, weakly held, sessionQueue-confined. The
  /// unbind reached layers only through `previewView`/`pipLayer` —
  /// both WEAK — so a view that died (or was replaced) before teardown was
  /// silently skipped, and its deinit's global-queue hop carried the still-
  /// attached layer past the tomb's 5 s release: the tomb's OWN capture
  /// release became the session's last, with a layer attached → assert.
  /// Registration happens at BIND time (the view is provably alive then),
  /// and both teardown AND the tomb sweep this registry — so no layer can
  /// be attached when the tomb drops the session, regardless of view
  /// dealloc timing. Weak entries: a truly gone layer self-removes.
  private let boundPreviewLayers = NSHashTable<AVCaptureVideoPreviewLayer>.weakObjects()
  /// (the crash reports: tomb
  /// timer → NSKVODeallocate → AVCaptureMultiCamSession dealloc →
  /// detachFromFigCaptureSession.cold.1 with a preview layer STILL
  /// attached): which session each registered layer was bound to, recorded
  /// by US at bind time. The sweep decided from `layer.session` —
  /// the layer's OWN getter — which can read nil/stale while Fig still
  /// considers the layer attached (parked Fig sync queue after hours in
  /// background; the 6h20m-lifetime report). A sweep that decides from a
  /// getter that lies can leave the exact attachment the assert catches.
  /// The sweep now decides from this bookkeeping and never asks the layer.
  /// Weak keys AND weak values: a dead layer self-removes, and the map
  /// never keeps a session alive (the tomb owns it during the sweep).
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
  // Drop-flood diagnostics: WHICH half of the pair the platform is
  // dropping. A chronic flood is the top suspect whenever stills wedge or
  // video stereo goes absent; these counts ride the stall event, the
  // degraded-capture reason, and the committed metadata so the next build's
  // field data can discriminate pool starvation on the primary stream from
  // the stereo half.
  private var droppedPrimaryCount = 0
  private var droppedSecondaryHalfCount = 0
  /// Consecutive secondary-half drops, reset by any complete pair. The
  /// stall watchdog only watches SILENCE (lastCollectionAt age) — a chronic
  /// secondary-half flood keeps collections arriving, so it never fires
  /// and stereo quietly goes absent for the whole session (an earlier build field
  /// report: video records, no pairs ever commit). 150 consecutive halves
  /// (~5 s at 30 fps) kicks ONE synchronizer rebind per streak.
  private var consecutiveSecondaryDrops = 0
  // Drop-flood diagnostics extension: the signature
  // was primary-half 0 / secondary-half 100% with fresh retained pairs —
  // the counters below split WHERE the secondary half dies so the next
  // field test discriminates the three hypotheses:
  //   secondaryAbsentCount — the synchronizer returned NO data object for
  //     the secondary output at the master's PTS ("output never delivered"
  //     when completePairCount stays 0).
  //   secondaryDroppedCount — a data object WAS present but
  //     sampleBufferWasDropped ("synchronizer/platform dropped it").
  //   completePairCount — pairs retained with BOTH halves. 0 while the
  //     absent/dropped counters climb == the secondary stream never lands.
  //   staleShutterCount — shutters that found no FRESH pair at fire
  //     time ("delivered but rejected as stale" is ruled in/out here).
  //   secondaryReseatDone — the rung-2 output reseat fired this session.
  private var secondaryAbsentCount = 0
  //   virtualGraphActive: rear stereo CAN ride the dual-wide
  //                          VIRTUAL device (one input, constituent "secret
  //                          ports", hardware-synced — Apple's AVDualCam
  //                          architecture, WWDC19-249) instead of two device
  //                          inputs.: no longer the DEFAULT — the
  //                          diagnostics caught it pinning the
  //                          zoom range to 2.0–4.0 on iPhone 17 (the UW
  //                          constituent's own stream removes the sub-2.0
  //                          region), which makes the product spec (primary
  //                          1x default + free sweep, secondary fixed 0.5x)
  //                          undeliverable. A/B via legacyVirtualGraph; see
  //                          configureSession's note for the full
  //                          trade reversal.
  //   virtualSecondaryPort — the ultra-wide constituent port of the virtual
  //                          input (requested by name, never from the ports
  //                          array). Drives the secondary output wiring, the
  //                          reseat/re-attach paths, and the PiP connection.
  private var virtualGraphActive = false
  private var virtualSecondaryPort: AVCaptureInput.Port? = nil
  // (external camera-pipeline review R1, hypothesis H3): isActive
  // settles ASYNCHRONOUSLY after startRunning, so the one-shot census reads
  // it too early. KVO observers on both video connections record the full
  // timeline (initial state + every transition) with ms timestamps relative
  // to sessionStartWallClock: never-active = graph-level reject; active then
  // inactive at t=+N s = evicted after start. Invalidated in teardownSession.
  private var connectionActiveObservers: [NSKeyValueObservation] = []
  private var sessionStartWallClock: Date? = nil
  private var secondaryDroppedCount = 0
  private var completePairCount = 0
  private var staleShutterCount = 0
  private var secondaryReseatDone = false
  /// One-shot guard for scheduleSecondaryDeliveryCheck: the
  /// "attached but zero complete pairs" finding is logged ONCE per session.
  private var secondaryDeliveryChecked = false
  // multi-input secondary delivery (bypasses the synchronizer — see
  // ExhibitSecondaryDirectHandler + handleSynchronizedCollection): the
  // newest directly-delivered UW frame, ARC-pinned (the pool cannot
  // recycle a pinned buffer; at most ONE is held, released on pair/commit/
  // teardown), plus the lifetime didOutput count — the watchdog's
  // discriminator between "the platform starved the output" and
  // "frames arrived but none pairable" (>0 with zero complete pairs).
  private let secondaryDirectHandler = ExhibitSecondaryDirectHandler()
  private var latestDirectSecondary: (buffer: CMSampleBuffer, pts: CMTime, receivedAt: Date)? = nil
  private var directSecondaryFrameCount = 0
  /// per-set zoom SUCCESS logging is throttled to the first set on
  /// each graph/range signature per session (the ungated log ran
  /// the full interpolate→bridge→store path on every commit — a jerkiness
  /// source on a live pinch). Failures still always log.
  private var lastZoomLogSignature: String? = nil
  private var stereoActive = false       // secondary input+output attached
  private var stereoDetachedForThermal = false
  private var sessionCalibration: [String: [String: Any]] = [:] // device rawValue → dict
  private var sessionCalibrationObjects: [String: AVCameraCalibrationData] = [:] // for metadata focal lengths
  private var calibrationCaptureInFlight = false

  // ---- pro-control state (spec §14). What the module last applied; the
  // metadata block reads the DEVICE back at capture time — these exist for
  // format/stabilization/HDR identity and rollback, not for reporting. ----
  private var currentFormatID: String?
  private var configuredFPS: Double = 30.0
  private var appliedStabilization: String = "auto"
  private var appliedHDR: Bool = false
  /// Photo-strobe preference (W2.2): the flashMode written into every
  /// full-res capture's AVCapturePhotoSettings. Distinct from the torch —
  /// the torch stays the video-only continuous light and is untouched here.
  /// Persists across sessions (a per-capture photoSettings value, not a
  /// device mode) so a fresh session honors the persisted JS preference.
  private var photoFlashPreference: ExhibitPhotoFlash = .off
  /// KVO on device.isAdjustingFocus → onAdjustingFocus event.
  private var focusObserver: NSKeyValueObservation?
  /// Photo-delegate forwarders retained until their capture completes —
  /// the CaptureKit pattern (a delegate the output doesn't retain would
  /// deallocate mid-capture).
  private var photoHandlers: [ExhibitPhotoHandler] = []

  // Video mode (delivery writer — CaptureKit pattern; the PCM master sink
  // ported 2026-08-10: the settings toggle was a dead control without it).
  private enum Mode { case preview, video }
  private var mode: Mode = .preview

  // Explicit recording state machine ( Drop 2 — the E_BUSY race fix).
  // `mode` routes FRAMES (flipped to.preview the instant stop begins so no
  // buffer is ever appended after markAsFinished); `videoState` owns the
  // LIFECYCLE and stays.stopping until the delivery file's seal settles.
  // The Drop-1 race: stop is async, so a startVideo that arrived
  // while the previous clip was still sealing hit E_BUSY (or, worse, two
  // writers overlapped). Now: startVideo during.stopping QUEUES behind the
  // seal (the user tapped record — don't lose the moment), stopVideo during
  // .stopping joins the in-flight stop (idempotent), and the seal's
  // completion is the only place the state returns to.idle.
  private enum VideoState { case idle, recording, stopping }
  private var videoState: VideoState = .idle
  /// A startVideo call waiting for the in-flight stop to finish sealing.
  /// At most one — a second one rejects E_BUSY, honestly stated.
  private var pendingStartVideo: (opts: [String: Any], promise: Promise)?
  /// Extra stopVideo promises attached to the in-flight stop; each settles
  /// with the SAME outcome (an idempotent stop is the same stop).
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
  // nil writer + enabled == enabled-but-failed (reported null at stop);
  // disabled is reported 'never-recorded' by the JS side, which owns the
  // toggle state. The sink never touches delivery (rule 4 tee).
  private var pcmEnabled = false
  private var pcmWriter: PcmMasterWriter?
  private var pcmConverter: AudioMasterConverter?
  // post-field: the default cadence drops
  // 5 s → 2 s, and start/stop both force a dump (below) — a short clip
  // must still commit a beginning AND an end, never zero pairs.
  private var pairIntervalSec: Double = 2.0
  private var lastPairDumpAt: Date = .distantPast
  private var pairIndex = 0
  private var pairsMissed = 0
  private var videoStartDate: Date?
  private var stopPromise: Promise?
  private var stopTimeout: DispatchWorkItem?

  // IMU evidence sink (0.15 — parity with CaptureKit SensorLogger and the
  // audio module's AudioMotionLog; the Settings sensor toggle was a dead
  // control without it). When sensorLogWanted (configureSession opts), the
  // logger samples accel+gyro at the 100 Hz target into a 60 s ring for the
  // WHOLE session so a still can slice [-2 s, +0.5 s] around the shutter
  // and stopVideo can slice the recording window. The logger reference is
  // sessionQueue-confined like everything above; the ring itself is
  // NSLock-confined inside the logger (appends land on its motionQueue).
  // Three-state honesty per capture: 'recorded' + path / 'unavailable'
  // (toggle off, no IMU hardware, or thermal-parked) / 'failed' + error —
  // a failed or absent log NEVER blocks a capture (rule 4).
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
  // interruption boundaries, logged to the persistent diagnostics
  // log — an interruption that parks the secondary stream must not be
  // invisible in the field.
  private var interruptionObserver: NSObjectProtocol?
  private var interruptionEndedObserver: NSObjectProtocol?
  private var firedErrorCodes = Set<String>()

  // Sync-pipeline health: the preview layer can keep painting
  // while the data-output pipeline is stalled — a live viewfinder with
  // stills rejecting E_STALE_PAIR. lastCollectionAt feeds the watchdog.
  private var lastCollectionAt: Date?
  private var stallRecovering = false    // rung 1: one cheap synchronizer rebind per stall
  private var stallBounced = false       // rung 2: one in-place session bounce per stall
  private var stallEscalated = false     // rung 3: one JS escalation per session

  // Alt-view PiP (transparency): the second camera's live feed on screen
  // exactly while it is attached. The VIEW owns the layer (display-only);
  // the module owns the AVCaptureConnection. pipWanted mirrors the
  // altPreview prop; pipLayer is weak — the view's layer tree owns it.
  private var pipWanted = false
  private weak var pipLayer: AVCaptureVideoPreviewLayer?
  private var pipConnection: AVCaptureConnection?

  // Selectable secondary stack: nil = 'auto' (the UW↔W/T pairing).
  // Set from configureSession(opts.secondaryLens) or setSecondaryLens; a
  // live change on a running back session detaches + re-attaches the
  // secondary pipeline. A preference that conflicts with the primary lens
  // or is absent on the hardware falls back to 'auto', stated in payloads.
  private var secondaryLensPreference: ExhibitLens?

  // Shutter-burst sink ("frames around the shutter", the JS
  // captureEvidence.ring toggle was a dead control; the native side never
  // existed and the record hardcoded 'never-recorded'). Opt-in via
  // configureSession(opts.ring). While wanted AND in preview mode, the
  // LAST few complete frames are retained in a tiny ring; at the shutter
  // the ring + the next few post-shutter frames are committed to
  // evidenceDir/ring-<captureId>/ as downsampled JPEGs + a JSON index.
  // DEPTH IS DELIBERATE AND SMALL: every retained frame holds capture-pool
  // buffers and holding several starved the pipeline into the 0.14.x drop
  // floods. 3 pre + 4 post ≈ the "~8 frames" the UI states.
  private var burstSinkWanted = false
  private var burstRing: [RetainedPair] = []
  private let burstPreCapacity = 3
  private let burstPostCapacity = 4
  private var burstPostFrames: [RetainedPair] = []
  private var burstPostTarget = 0        // >0 while collecting post-shutter frames
  private var burstContinuation: (() -> Void)?
  private var burstTimeout: DispatchWorkItem?
  // primary PTS of the last retained burst frame — the ring retains
  // only PTS-ADVANCING frames (see handleSynchronizedCollection).
  private var lastBurstPTS: CMTime? = nil
  // (field: the ring filled at full frame rate, so 3 pre + 4 post
  // spanned ~115 ms total — adjacent frames were sub-pixel identical and
  // the Motion Trace read "0 px per frame" while the UI advertised a
  // ±300 ms axis): the ring CADENCE-SAMPLES. A frame is retained only if
  // at least burstCadenceSeconds has passed since the last retained frame,
  // so 3 pre + 4 post actually span the stated axis. The PTS-advance guard
  // above still applies first — duplicates are never retained.
  private var lastBurstRetainedAt: Date? = nil
  private let burstCadenceSeconds: TimeInterval = 0.1

  // Audio-tap / PCM-master diagnostics + ENF anchor ( the raw
  // audio master never committed in the field and the failure was silent).
  private var audioBufferCount = 0
  private var pcmFirstSampleWallClockUtcMs: Int64?
  private var pcmAnchorSource = ""       // "source-pts" | "append-instant" — stated, honest

  /// The preview view registers here at prop-update time (main thread).
  /// Weak: the view is display-only.
  private weak var previewView: ExhibitCameraPreviewView?

  /// Shared CIContext for JPEG encode/downsample. CIContext is thread-safe
  /// for rendering (documented); it is used from sinkIOQueue (still commits
  /// + periodic pairs) and never contended with state mutations.
  private let ciContext = CIContext(options: [.cacheIntermediates: false])

  // MARK: - Module definition

  public func definition() -> ModuleDefinition {
    Name("ExhibitCamera")
    Events("onSessionError", "onHardwarePressure", "onStereoPairCaptured", "onAdjustingFocus", "onSyncStalled", "onCameraDiagnostic")

    // The definition body is a result builder — only definition components
    // are allowed here, so the queue tag is set from OnCreate (runs before
    // any AsyncFunction can fire).
    OnCreate {
      self.sessionQueue.setSpecific(key: self.sessionQueueSpecificKey, value: 1)
    }

    // module death must not strand a tomb. A tomb whose 5 s
    // asyncAfter closure fires after the module is gone hits the
    // `guard let self` early return and never sweeps, never releases —
    // the session's last strong ref would then live in a dead array
    // whose release point we no longer control (the same dealloc-assert
    // class the same class). Tear down and drain synchronously, on
    // sessionQueue, while both are known-live. The specific-key check
    // makes the sync path deadlock-proof if destruction itself ever
    // originates on sessionQueue.
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

    /// Probes hardware only; starts nothing. 'available' | 'unsupported' |
    /// 'unreached' (spec §7). Never throws — a probe failure IS 'unreached'.
    AsyncFunction("stereoAvailability") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.probeStereoAvailability().rawValue)
      }
    }

    /// Starts the one session (preview mode). Resolves on first frame or
    /// rejects via watchdog (10 s) — never hangs the UI.
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

    // ---- chrome (spec §3); all reconfigure on sessionQueue, all clamp,
    // all no-op honestly when the hardware lacks the capability ----

    AsyncFunction("setLens") { (lens: String, promise: Promise) in
      self.sessionQueue.async {
        self.setLens(ExhibitLens(jsValue: lens), promise: promise)
      }
    }

    /// Selectable secondary stack: 'auto' (default — the UW↔W/T
    /// pairing) or an explicit rear stack ('ultraWide'|'wide'|'telephoto',
    /// e.g. telephoto as the stereo partner on a triple-lens Pro). Applies
    /// live on a running back session; otherwise stored for the next
    /// configureSession. Never swaps silently: a conflict with the primary
    /// lens resolves applied:false with a stated reason.
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

    /// UI-driven zoom ramp (W2.3): ramp(toVideoZoomFactor:withRate:) with a
    /// clamped rate. Instant jumps (lens hand-off continuity) stay on setZoom.
    AsyncFunction("setZoomSmooth") { (factor: Double, rate: Double, promise: Promise) in
      self.sessionQueue.async {
        self.setZoomSmooth(factor, rate: rate, promise: promise)
      }
    }

    /// Photo-strobe preference (W2.2): flashMode for the photo output's
    /// stills captures — never the torch (the video-only continuous light).
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

    // ---- pro controls (spec §14): every setter no-ops safely (never
    // throws into JS) on hardware lacking the capability; availability is
    // reported by capabilities so the UI can hide what doesn't exist ----

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

    /// level nil → off; clamped to the documented 1.0 API ceiling (see setTorchLevel —
    /// not an AVCaptureDevice member; EAS build fix).
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

    /// Explicit HDR — never a silent system default (spec §14).
    AsyncFunction("setHDREnabled") { (enabled: Bool, promise: Promise) in
      self.sessionQueue.async {
        self.setHDREnabled(enabled, promise: promise)
      }
    }

    /// What this hardware can do — the UI hides what isn't here.
    AsyncFunction("capabilities") { (promise: Promise) in
      self.sessionQueue.async {
        promise.resolve(self.capabilities())
      }
    }

    // ---- debug flags (ExhibitDebugFlags). defaults: the W7
    // photoConnectionRotation key defaults false; photoMaxDimensionsPolicy
    // defaults TRUE (the 12 MP clamp is the shipped default — the flag is
    // the escape hatch); the D1 depthCapture key defaults TRUE; the
    // sessionCalibrationPhoto key defaults FALSE (the one-shot is the
    // primary suspect for the dead secondary stream); the thirdViewEnabled
    // key defaults FALSE (UNTESTED extension-point gate). Diagnostics-only;
    // only the known keys are writable, an unknown key resolves
    // applied:false, stated ----

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

      // Every prop handler attaches the module: props are the guaranteed
      // first contact between view and module under both Paper and Fabric.
      // The JS side always passes `lens`, so attach always happens.
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
      // Alt-view PiP (transparency,): the second camera's live feed
      // in a corner inset, exactly while it is attached. The view owns the
      // layer; the module owns the AVCaptureConnection to the secondary
      // input's video port.
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

  /// View attach (prop handler, main) → sessionQueue.: ALL preview-
  /// layer session binds/unbinds run on sessionQueue, serialized with
  /// configure/start/stop by construction — never on main, where setSession:
  /// can synchronously commit the capture graph and stall into the
  /// scene-update watchdog, and never via a fire-and-
  /// forget main hop that let a bound layer outlive its session on a Fig
  /// workloop.
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

  /// a dying view's unbind hop, onto sessionQueue — serial, so it is
  /// ordered ahead of any session tomb timer already pending (see the view's
  /// deinit and the boundPreviewLayers note).
  func enqueueLayerUnbind(preview: AVCaptureVideoPreviewLayer, pip: AVCaptureVideoPreviewLayer?) {
    sessionQueue.async {
      preview.session = nil
      pip?.session = nil
      self.boundSessionMap.removeObject(forKey: preview)
      if let pip = pip { self.boundSessionMap.removeObject(forKey: pip) }
    }
  }

  /// detach every layer OUR bookkeeping says was bound to `dead` —
  /// unconditionally, without consulting `layer.session`. The
  /// version filtered on the getter (`where layer.session === dead`); the
  /// crash reports show a layer still attached at session
  /// dealloc after that sweep ran, i.e. the getter read nil/stale while
  /// Fig's attachment survived. Setting `.session = nil` on an already-nil
  /// layer is a no-op, so sweeping by bookkeeping loses nothing and misses
  /// nothing we know about. Runs on sessionQueue — at teardown AND inside
  /// the tomb retry loop before any release.
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

  /// post-sweep verification. After detachRegisteredLayers +
  /// a Fig round-trip, no live layer may still report `dead` as its
  /// session. The getter is untrustworthy as a SWEEP FILTER (it can read
  /// stale-nil), but a non-nil read here is reliable evidence of a real
  /// attachment — so it is only ever used to PROVE dirtiness, never to
  /// prove cleanliness alone: the bookkeeping map is checked too, in case
  /// a bind re-registered against a session mid-teardown.
  private func layersStillAttached(to dead: AVCaptureMultiCamSession) -> Bool {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    for layer in boundPreviewLayers.allObjects {
      if layer.session === dead { return true }
      if boundSessionMap.object(forKey: layer) === dead { return true }
    }
    return false
  }

  /// the empty begin/commit pair the auditor prescribed. Detach
  /// work posted to the Fig capture-session sync queue can sit parked for
  /// as long as the process is backgrounded (the 6h20m-lifetime report);
  /// committing an (empty) configuration forces the session to drain that
  /// queue NOW, on our serial queue, before we judge cleanliness. Legal
  /// on a stopped session; both calls are synchronous.
  private func drainFigDetachQueue(of session: AVCaptureMultiCamSession) {
    session.beginConfiguration()
    session.commitConfiguration()
  }

  /// the ONLY place a tombed session is released. Order is
  /// sweep → Fig round-trip → prove clean → release. If any layer still
  /// provably points at the session, reschedule (10 s / 20 s / 40 s —
  /// bounded, so a permanently-stuck session cannot retry forever); after
  /// the last retry, graveyard it instead of releasing. The auditor's
  /// note on the reports: remove the assert's precondition
  /// rather than race the release — a layer that points at nothing cannot
  /// be detached during dealloc, and a session we cannot prove clean is
  /// never allowed to reach dealloc at all.
  private func releaseTombIfClean(at idx: Int) {
    dispatchPrecondition(condition: .onQueue(sessionQueue))
    let entry = sessionTomb[idx]
    detachRegisteredLayers(from: entry.session)
    drainFigDetachQueue(of: entry.session)
    guard layersStillAttached(to: entry.session) else {
      // PROVABLY clean: the final release is this array removal, on
      // sessionQueue, with nothing attached — the dealloc-time
      // detachFromFigCaptureSession finds no layer and cannot assert.
      // The invariant, stated where it is relied on: no preview layer may
      // reference a session that is about to deallocate. Debug builds trap
      // here if the proof above is ever weakened; release builds keep the
      // retry-and-graveyard path below.
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

  /// retain a session we cannot prove clean for the REST OF THE
  /// PROCESS. A session that never deallocs can never hit the dealloc-time
  /// detach assert — this converts a SIGABRT into a bounded, logged leak
  /// of one stopped session. The graveyard is a static (process-global),
  /// so it keeps holding even if this module instance is destroyed.
  private func graveyardSession(_ session: AVCaptureMultiCamSession, reason: String) {
    ExhibitCameraModule.sessionGraveyard.append(session)
    logDiagnosticEvent("Tombed capture session retained for process lifetime (\(reason)); it will never deallocate, by design")
  }

  /// Push the running session to the preview view.: enqueues the
  /// bind on sessionQueue (callers include the synchronizer's capture
  /// queue), so the bind is serialized with configure/start/stop — never a
  /// main-hop. Also delivers first-frame readiness.
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

  /// onSessionError dedupe: each code fires at most once per session
  /// (CaptureKit pattern — without this a failing sink floods the bridge).
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

  /// The preview view's altPreview prop → attach/detach the second camera's
  /// live feed. The connection binds the layer DIRECTLY to the secondary
  /// input's video port (the documented multi-cam PiP pattern), so the inset
  /// shows exactly what the evidence pipeline sees. Called on sessionQueue.
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
      // a no-connection PiP layer RETAINS its session; clear the
      // reference here, ordered after the commit on this serial queue, so
      // the discarded inset layer can never carry the session into a
      // workloop dealloc (the SIGABRT class).
      oldLayer?.session = nil
      if let oldLayer = oldLayer { boundSessionMap.removeObject(forKey: oldLayer) }
    }
  }

  /// Create/repair the PiP connection when (and only when) a secondary
  /// input is actually plumbed. Absence is honest: no partner, no inset
  /// feed — the view simply keeps an empty frame.
  func ensurePipConnection(in session: AVCaptureMultiCamSession) {
    guard pipWanted, pipConnection == nil, let layer = pipLayer else { return }
    // on the virtual graph the secondary port lives on the ONE
    // (virtual) input, requested by name — there is no secondaryInput.
    let pipPort: AVCaptureInput.Port?
    let pipDevice: AVCaptureDevice?
    if virtualGraphActive {
      pipPort = virtualSecondaryPort
      pipDevice = secondaryDevice
    } else {
      // (H4): the documented selector (AVMultiCamPiP sample form)
      // instead of scanning the ports array.
      pipPort = secondaryInput.flatMap { input in
        input.ports(for: .video, sourceDeviceType: input.device.deviceType, sourceDevicePosition: input.device.position).first
      }
      pipDevice = secondaryInput?.device
    }
    guard let port = pipPort else { return }
    layer.setSessionWithNoConnection(session)
    boundPreviewLayers.add(layer)
    boundSessionMap.setObject(session, forKey: layer)
    // Non-failable initializer on iOS (Apple's AVMultiCamPiP sample calls it
    // directly) — canAddConnection below is the real gate.
    let connection = AVCaptureConnection(inputPort: port, videoPreviewLayer: layer)
    session.beginConfiguration()
    guard session.canAddConnection(connection) else {
      session.commitConfiguration()
      return
    }
    session.addConnection(connection)
    session.commitConfiguration()
    if #available(iOS 17.0, *), let device = pipDevice {
      // Preview-bound connection: the coordinator's PREVIEW angle for the
      // secondary device, with the PiP layer ( never a constant).
      RotationPolicy.apply(to: connection, device: device, previewLayer: layer)
    } else if connection.isVideoOrientationSupported {
      connection.videoOrientation = .portrait
    }
    pipConnection = connection
  }

  func teardownPipConnection(in session: AVCaptureMultiCamSession) {
    guard let pip = pipConnection else { return }
    // CRASH FIX (the crash reports:
    // com.exhibit.camera.session): -[AVCaptureMultiCamSession
    // _removeConnection:] KVO-unregisters the connection and throws
    // NSInvalidArgumentException when the observer is already gone —
    // reachable when the graph was rebuilt under us or the session is
    // being torn down with the PiP connection already invalidated.
    // Removal is idempotent in intent (a connection we no longer hold is
    // gone either way), so: clear our reference in EVERY outcome, skip
    // the call when the session no longer holds the connection, and run
    // the removal through the NSException shim — a throw is stated via
    // sendError, never a crash.
    pipConnection = nil
    guard session.connections.contains(pip) else { return }
    if let removeError = ExhibitSessionControl.safelyRemoveConnection(session, connection: pip) {
      sendError(
        ExhibitCameraErrorCode.platform,
        "PiP connection removal raised an exception: \(removeError.localizedDescription)"
      )
    }
  }

  /// Sync-pipeline health. Every 2 s while the session lives: if frames
  /// have delivered before and have now gone quiet for >1.5 s, climb a
  /// three-rung ladder — rebind the synchronizer (cheap), bounce the session
  /// in place (blocks, but the pipeline is already dead), and only then
  /// escalate ONCE so JS can rebuild. Mid-recording only rung 1 runs: a
  /// bounce or rebuild would kill the take. Stated, never a silent wedge.
  func scheduleStallWatchdog() {
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 2.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      self.checkSyncStall()
      self.scheduleStallWatchdog()
    }
  }

  /// zero-delivery watchdog. The stall watchdog's job starts at
  /// "frames delivered before, now quiet" — it structurally cannot see the
  /// failure class (secondary attached, green census, ZERO frames
  /// ever, zero callbacks), which is the exact risk the graph default flip
  /// re-exposes. One shot at +4 s: stereo attached AND completePairCount
  /// still 0 means the secondary stream never landed — stated loudly with
  /// the live census and the A/B way out, once per session. NOT a verdict
  /// on the capture pipeline: single-half collections still seal honestly
  /// (secondary evidence records 'no-synchronized-pair-at-shutter').
  private func scheduleSecondaryDeliveryCheck() {
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 4.0) { [weak self] in
      guard let self = self, self.session != nil, self.sessionId == id else { return }
      guard !self.secondaryDeliveryChecked else { return }
      self.secondaryDeliveryChecked = true
      guard self.stereoActive, self.completePairCount == 0 else { return }
      // directFrames discriminates the failure layer on the
      // multi-input graph — 0 = the platform starved the OUTPUT itself
      // (nothing app-side left; flip legacyVirtualGraph), >0 = frames
      // arrived but none pairable (a PTS/tolerance finding, fixable).
      self.logDiagnosticEvent("secondary stream attached but ZERO complete pairs 4s after start (absent=\(self.secondaryAbsentCount) dropped=\(self.secondaryDroppedCount) directFrames=\(self.directSecondaryFrameCount) graph=\(self.virtualGraphActive ? "virtual-dual-wide" : "multi-input")) — the 0.18.3 silent-delivery class; the 0.18.4 virtual graph is one flip away (Settings ▸ Diagnostics ▸ legacyVirtualGraph). census=\(self.connectionCensus())")
    }
  }

  private func checkSyncStall() {
    guard let last = lastCollectionAt else { return } // never-delivered is the 10 s start watchdog's job
    // The calibration dual-photo one-shot legitimately starves the sync
    // pipeline for a moment — never treat it as a stall.
    guard !calibrationCaptureInFlight else { return }
    let age = Date().timeIntervalSince(last)
    guard age > 1.5 else {
      stallRecovering = false
      stallBounced = false
      return
    }
    if !stallRecovering {
      // Rung 1: rebind the synchronizer (cheap, no session reconfig). Also
      // the ONLY rung that runs mid-recording — a bounce or rebuild would
      // kill the take; recording failures surface through the writer path.
      stallRecovering = true
      rebuildSynchronizer()
    } else if mode != .video, !stallBounced {
      // Rung 2: bounce the session in place. startRunning blocks, but the
      // pipeline is already dead — this is the documented wedge recovery and
      // it beats a full JS rebuild.
      // NSException-safe + idempotent via the shim ( Drop 2): a thrown
      // exception becomes an onSessionError event and the ladder simply
      // climbs to rung 3 on the next tick — never a bridge crash.
      stallBounced = true
      if let live = session {
        if let stopError = ExhibitSessionControl.safelyStop(live) {
          sendError(ExhibitCameraErrorCode.platform, "Stall-recovery stop failed: \(stopError.localizedDescription)")
        } else if let startError = ExhibitSessionControl.safelyStart(live) {
          sendError(ExhibitCameraErrorCode.platform, "Stall-recovery start failed: \(startError.localizedDescription)")
        }
      }
    } else if mode != .video, !stallEscalated {
      // Rung 3 (last resort): escalate ONCE so JS can rebuild the session.
      stallEscalated = true
      sendEvent("onSyncStalled", [
        "ageSeconds": age,
        "droppedPairCount": droppedPairCount,
        "droppedPrimaryCount": droppedPrimaryCount,
        "droppedSecondaryHalfCount": droppedSecondaryHalfCount,
        // diagnostics extension (additive keys — see state notes):
        "secondaryAbsentCount": secondaryAbsentCount,
        "secondaryDroppedCount": secondaryDroppedCount,
        "completePairCount": completePairCount,
        "staleShutterCount": staleShutterCount,
        "secondaryReseatDone": secondaryReseatDone,
        // diagnostics (additive): live connection census at stall.
        "connections": connectionCensus(),
      ])
    }
  }

  /// The calibration one-shot rides the PHOTO outputs on the live multi-cam
  /// graph; fired on the very first frame it coincided with pipeline stalls
  /// on hardware (stale-pair rejections at shutter). Deferred 1.0 s
  /// so the streams reach steady state first; session-id guarded so a stale
  /// timer never fires into a new session.
  ///
  /// OFF BY DEFAULT behind ExhibitDebugFlags.sessionCalibrationPhoto.
  /// The signature (primary-half drops 0, secondary-half drops
  /// 100% of pairs, fresh retained pairs rejected E_STALE_PAIR) plus the
  /// note that the floods began "~1 s into every session — exactly
  /// when this one-shot fired" and the build-26 note that a photo capture
  /// under pressure "can refuse and leave the output unwilling to record
  /// afterward" name this one-shot — specifically its SECONDARY photo
  /// capture — as the primary suspect for the dead secondary stream.
  ///
  /// RETIRED — no call site remains. The graph change
  /// detached the secondary photo output, so UW session calibration commits
  /// 'unavailable' no matter what — and convertCalibrationJson requires BOTH
  /// lenses' full calibration, so the one-shot's primary-only result was
  /// already unreachable by any commitment path. What it could still do was
  /// fire the maximum-resource photo capture 1 s into every session on the
  /// live multi-cam graph — the named suspect above. Per-frame intrinsics
  /// ride the frame attachments and are unaffected. The "full" calibration
  /// block commits 'unavailable' (stated, never fabricated). The native
  /// flag key stays registered (inert) so a stale flipped value in the
  /// exhibit.debug suite reads as a no-op, not an error; the machinery
  /// below is kept for the record but is unreachable.
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

  /// Hardware probe only — no session objects, no side effects (spec §7).
  func probeStereoAvailability() -> StereoAvailability {
    guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
      return .unreached // permissions missing — not probed, never red
    }
    guard AVCaptureMultiCamSession.isMultiCamSupported else {
      return .unsupported // pre-A12 / OS limitation — unreached, never red
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

  /// The stereo partner's device type for a given primary (
  /// selectable secondary stack). The JS-selected preference wins when it
  /// is set, differs from the primary, and exists on this hardware;
  /// otherwise the automatic UW↔W/T pairing. A requested-but-absent stack
  /// degrades to 'auto' here, never to a failed session.
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

  /// Pick the largest format at or under maxWidth×maxHeight that supports
  /// ≥ 30 fps. Multicam does not honor session presets the way single-cam
  /// does; formats are chosen explicitly and committed in metadata.
  ///
  /// (iPhone 17 triage): when requireMultiCam is set, only
  /// isMultiCamSupported formats are eligible — Apple documents flatly that
  /// on AVCaptureMultiCamSession "you may only set the device's format to
  /// one in which isMultiCamSupported is true" (AVCaptureDevice.Format
  /// docs), and WWDC19's sample code filters on exactly that. The 0.18.x
  /// iPhone 17 signature (secondary stream ABSENT from frame one, zero
  /// dropped markers, PiP preview alive, wiring explicit and verified) is
  /// precisely what a silently violated format rule looks like. If nothing
  /// in-budget is multi-cam, fall UP to the smallest multi-cam format at
  /// ≥30fps rather than failing the attach — the hardware-cost gate after
  /// commit is the honest arbiter of the whole graph. Every pick (and every
  /// refusal) is written to the persistent diagnostics log.
  ///
  /// Also pins per-device AE/AWB to continuous auto: each physical camera
  /// in a multi-cam graph runs its OWN AE/AWB/AF, and the secondary used
  /// to sit on factory defaults (the "one lens underexposed" field
  /// report).
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
    // (field: "zoom number moves, camera doesn't zoom" with Multiple
    // Lenses on): some multi-cam formats pin the zoom ceiling at the floor
    // (per-format videoMaxZoomFactor, iOS 18+) while the UI sweeps. When
    // the pool offers ANY zoom-capable format, drop the pinned ones: a
    // smaller resolution with a real sweep beats a larger one locked at 1x.
    let zoomFloor = device.minAvailableVideoZoomFactor
    let zoomable = pool.filter { fmt in
      if #available(iOS 18.0, *) {
        return fmt.videoMaxZoomFactor > zoomFloor + 0.01
      }
      return true // no per-format zoom cap pre-iOS 18 — nothing to filter
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
      // log the top-3 candidates the pick came from — the field log
      // needs to show what the menu was (res / max fps / binned / multiCam),
      // not just the winner.
      let top3 = pool.sorted(by: byArea).suffix(3).reversed().map { self.formatSummary($0) }.joined(separator: " | ")
      logDiagnosticEvent("format chosen: device=\(device.deviceType.rawValue) \(self.formatSummary(best)) requireMultiCam=\(requireMultiCam) fellUp=\(fellUp) inBudget=\(inBudget.count) candidates=[\(top3)]")
      return true
    } catch {
      logDiagnosticEvent("format apply FAILED: device=\(device.deviceType.rawValue) error=\(error.localizedDescription)")
      return false
    }
  }

  /// Compact one-line format description for the diagnostics log, e.g.
  /// "1920x1440@<=60 binned:1 multiCam:1 zoomMax:4.00". String only —
  /// bridge-stable.
  private func formatSummary(_ format: AVCaptureDevice.Format) -> String {
    let dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
    let maxFPS = format.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
    // Per-format zoom ceiling exists only on iOS 18+; pre-18 shows n/a.
    let zoomMax: String
    if #available(iOS 18.0, *) {
      zoomMax = String(format: "%.2f", Double(format.videoMaxZoomFactor))
    } else {
      zoomMax = "n/a"
    }
    return "\(dims.width)x\(dims.height)@<=\(Int(maxFPS)) binned:\(format.isVideoBinned ? 1 : 0) multiCam:\(format.isMultiCamSupported ? 1 : 0) zoomMax:\(zoomMax)"
  }

  /// Native → persistent diagnostics log: the JS side forwards
  /// this event verbatim into the on-disk log the Settings screen shows.
  /// Fire-and-forget; never gates, delays, or fails a capture.
  private func logDiagnosticEvent(_ message: String) {
    sendEvent("onCameraDiagnostic", ["message": message])
  }

  /// (field report: "one lens is always underexposed"): with two
  /// physical cameras live, EACH runs its own AE/AWB/AF — pro controls hit
  /// the primary only, and the secondary sat on factory defaults. Mirror
  /// the primary's current exposure/WB/focus state onto the secondary,
  /// best-effort, with per-device capability guards and per-device range
  /// clamps; a device that can't take a mode keeps its own defaults, and
  /// the committed per-capture metadata states what each device ran.
  /// Nothing here can fail a capture: a lock failure leaves the secondary
  /// exactly as it was.
  private func mirrorProControlsToSecondary() {
    // skipped on the virtual graph — the virtual device owns
    // AE/AWB/AF for BOTH constituents (that unification is the point of the
    // architecture), and configuring a constituent directly while the
    // virtual device streams is not a supported pattern.
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
      // Exposure target bias rides the auto modes — mirrored clamped to
      // the secondary's own range.
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
        // custom-position support bit, not just mode support (see
        // setFocusMode's crash-fix note).
        if secondary.isFocusModeSupported(.locked),
           secondary.isLockingFocusWithCustomLensPositionSupported {
          secondary.setFocusModeLocked(lensPosition: primary.lensPosition, completionHandler: nil)
        }
      @unknown default:
        break
      }
    } catch {
      // Best-effort: the secondary keeps its own state; committed metadata
      // states what each device actually ran.
    }
  }

  /// Explicit multi-cam wiring. Apple forbids implicit connection
  /// forming on AVCaptureMultiCamSession (WWDC19 sessions 249/225; the
  /// AVMultiCamPiP sample uses addInputWithNoConnections /
  /// addOutputWithNoConnections plus a manually built AVCaptureConnection
  /// per port): with several same-media-type ports live, an implicitly
  /// formed connection can land on the wrong port or never materialize at
  /// all — silently. canAddOutput passes, the output is attached, and it
  /// simply never delivers. That is the iPhone 17 signature:
  /// the secondary video data output ABSENT for the synchronizer's whole
  /// life (secondary-absent == dropped-pairs, zero dropped markers) while
  /// the explicitly-wired PiP preview on the SAME input port streamed fine.
  /// Returns the live connection, nil on any refusal — callers keep their
  /// existing honest-degradation policy (single-cam fallback / rejection).
  /// every refusal stage is written to the persistent diagnostics
  /// log with the caller's label — NO silent unwinds anywhere in the graph
  /// build path.
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
    // (H4): the default path now uses the DOCUMENTED selector —
    // ports(for:sourceDeviceType:sourceDevicePosition:), the AVMultiCamPiP
    // sample form — instead of scanning the ports array by media type. An
    // explicit port still wires a virtual device's constituent by name
    // . The resolved candidate count is logged either way, so an
    // unexpected multi-port answer is visible in the field log.
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
    // Non-failable initializer on iOS (the preview-layer twin is called
    // directly in ensurePipConnection); canAddConnection is the real gate.
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

  /// Live connection census for the diagnostics payloads: per
  /// pipeline output, whether a connection to its intended input port
  /// exists, is enabled/active, and WHICH device that port belongs to — a
  /// silently absent or cross-wired connection shows up here immediately.
  /// String values only — type-stable for the bridge.
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
    // the format facts — the isMultiCamSupported violation theory
    // is confirmed or killed by these two lines in the field log.
    census["primaryFormat"] = primaryDevice.map { self.formatSummary($0.activeFormat) } ?? "none"
    census["secondaryFormat"] = secondaryDevice.map { self.formatSummary($0.activeFormat) } ?? "none"
    return census
  }

  private func connectionSummary(_ connection: AVCaptureConnection?) -> String {
    guard let connection = connection else { return "none" }
    let portDevice = connection.inputPorts.first?.sourceDeviceType?.rawValue ?? "unknown"
    return "enabled=\(connection.isEnabled),active=\(connection.isActive),port=\(portDevice)"
  }

  /// (H3): KVO on AVCaptureConnection.isActive with ms timestamps
  /// relative to startRunning. The census SAMPLES isActive once; this records
  /// the TIMELINE — a connection that never activates was rejected at the
  /// graph level, one that deactivates at t=+N s was evicted after start
  /// (pressure, a reservation). isActive is documented KVO-observable; the
  /// observer is invalidated in teardownSession. logDiagnosticEvent is
  /// fire-and-forget sendEvent, safe from the KVO delivery thread.
  private func observeConnectionActivity(_ connection: AVCaptureConnection?, label: String) {
    guard let connection = connection else { return }
    let observation = connection.observe(\.isActive, options: [.initial, .new]) { [weak self] conn, _ in
      let elapsed = self?.sessionStartWallClock.map { Date().timeIntervalSince($0) } ?? -1
      self?.logDiagnosticEvent("connection isActive: \(label)=\(conn.isActive) t=+\(String(format: "%.3f", elapsed))s")
    }
    connectionActiveObservers.append(observation)
  }

  /// Starts the session in preview mode. opts: { lens?, facing?, stereo?,
  /// sensorLog? }. Resolves on the first synchronized frame; the 10 s
  /// watchdog rejects otherwise. Hardware-cost refusal is a stated
  /// rejection, not a throttle (spec §6). sensorLog (default false) arms
  /// the IMU evidence sink (ExhibitSensorLogger) for the session.
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
    // selectable secondary stack ('auto' = the UW↔W/T pairing) +
    // shutter-burst sink opt-in ('ring'). Unknown lens strings fall back to
    // 'auto' (stated via capabilities.secondaryLens), never a hard
    // failure. An ABSENT key leaves a stored setSecondaryLens preference
    // intact (the photoFlashPreference persistence pattern).
    if let sl = opts["secondaryLens"] as? String {
      secondaryLensPreference = (sl == "auto") ? nil : ExhibitLens(rawValue: sl)
    }
    burstSinkWanted = (opts["ring"] as? Bool) ?? false
    burstRing.removeAll()
    burstPostFrames.removeAll()
    burstPostTarget = 0
    lastBurstPTS = nil
    lastBurstRetainedAt = nil

    // Device discovery. Primary follows the selected lens; the stereo
    // partner is wide+ultraWide on the back (spec §4.2). Front is always
    // single-cam — stated, never silently degraded.
    //
    // GRAPH DEFAULT FLIP: rear stereo rides the two-device-input
    // graph (physical wide primary + physical ultra-wide secondary) again.
    // The dual-wide VIRTUAL graph — one input whose constituent
    // ports stream both lenses — was preferred because the iPhone 17
    // field log showed the OS accepting the multi-input wiring while never
    // delivering a single secondary frame, with zero error callbacks. Two
    // field facts since then reversed the trade:
    //   1. named the prime suspect for the silent-delivery failure:
    //      the secondary AVCapturePhotoOutput, present in EVERY dead
    //      session. It has been detached from both graphs ever since —
    //      the multi-input path was never re-tested without it.
    //   2. an earlier build's zoom diagnostics caught the virtual device reporting
    //      range=2.0–4.0 on iPhone 17 (iOS 26.6): with the UW constituent
    //      streaming its own port for the secondary feed, the virtual
    //      device's available zoom collapses to the wide-only zone and
    //      every 0.5/1x request silently clamps to 2.0 ("zoom measure
    //      moves, image doesn't"; "stuck on 2 by default"). The product
    //      spec — primary wide at a true 1x default with a free sweep,
    //      secondary UW fixed at 0.5x — is undeliverable on that graph.
    // On the multi-input graph zoom targets the PHYSICAL wide device
    // (range 1.0…max, no constituent contention), the secondary UW stream
    // is immune to it, and the preview's implicit connection lands on the
    // wide port, so the viewfinder follows zoom by construction. The
    // virtual graph remains intact behind ExhibitDebugFlags
    // .legacyVirtualGraph for instant A/B; a zero-complete-pairs watchdog
    // (scheduleSecondaryDeliveryCheck) names the failure class in
    // Diagnostics within seconds if it ever reappears.
    // Ports are verified BEFORE the session is touched: any gap falls back
    // to the multi-input graph with a log line.
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
    // The ultra-wide half of a virtual graph as a DEVICE — for rotation
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
      // the partner stack is selectable (opts.secondaryLens /
      // setSecondaryLens); 'auto' keeps the UW↔W/T pairing. A preference
      // that conflicts with the primary or is absent on this hardware
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
      // Explicit multi-cam wiring — see wireOutput.
      session.addInputWithNoConnections(input)
      // dual-cam experiment (WWDC19-249, "How to Reduce Your
      // Hardware Cost"): promise no more than 30 fps so the session BILLS
      // this input at 30, not at the format's advertised max — without the
      // override "we must assume the worst case" and a 60-capable multiCam
      // format costs double what we ever use. Set AFTER the add: adding an
      // input resets the override to kCMTimeInvalid (documented).
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

    // Primary stream format: up to 2560×1440 at 30 fps. ran 4K
    // (~1 GB/s of BGRA) plus a 1080p partner through one serial queue and
    // stalled; 1440p keeps the stream honest and smooth. Sealed stills are
    // unaffected — photo outputs capture at full sensor resolution. The
    // committed format is recorded in every capture's metadata.
    // when a stereo partner will be attached, the primary's format
    // MUST be multi-cam-flagged (documented requirement) — see
    // configureFormat. Single-cam keeps the legacy pick (proven in field).
    if !configureFormat(device: primary, maxWidth: 2560, maxHeight: 1440, requireMultiCam: secondary != nil || virtualInput != nil) {
      session.commitConfiguration()
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No usable primary camera format at 30 fps"))
      return
    }

    // Secondary input (stereo), with honest single-cam fallback.
    // on the virtual graph the pair is inherent — both constituent
    // ports were verified before the session existed, so stereo starts
    // attached and the OUTPUTS wire to the ports below (no second input).
    var stereoAttached = virtualInput != nil
    if let secondary = secondary {
      // (review fix): validate the pair against the DOCUMENTED
      // supportedMultiCamDeviceSets before any wiring — the combinations the
      // hardware can actually stream together. An unsupported pair degrades
      // to honest single-cam HERE, stated, instead of failing obscurely
      // downstream.
      // build fix: supportedMultiCamDeviceSets exists ONLY on
      // AVCaptureDevice.DiscoverySession (sets of AVCaptureDevice) — not on
      // AVCaptureMultiCamSession at all. Compare by deviceType; a device is
      // not interchangeable with its type in the Set<AVCaptureDevice>.
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
          // Explicit multi-cam wiring — see wireOutput.
          session.addInputWithNoConnections(input)
          // dual-cam experiment: the 30 fps billing promise, same as
          // the primary input above. Set AFTER the add (adding resets it).
          input.videoMinFrameDurationOverride = CMTime(value: 1, timescale: 30)
          secondaryInput = input
          stereoAttached = true
        } else {
          // configureFormat logs its own refusal; a canAddInput=false
          // lands here ( no silent single-cam fallbacks).
          logDiagnosticEvent("secondary attach FAILED at configure: canAddInput=\(session.canAddInput(input)) device=\(secondary.deviceType.rawValue) — single-cam fallback")
        }
      } catch {
        // Secondary attach failure degrades to single-cam, stated in the
        // resolve payload as stereo:'unsupported' — never a hard failure.
        logDiagnosticEvent("secondary attach THREW at configure: \(error.localizedDescription) — single-cam fallback")
        stereoAttached = false
      } }
    }

    // Primary video output. NO forced pixel format ( Drop 2): leaving
    // videoSettings empty delivers buffers in the camera's NATIVE format
    // (420YpCbCr), which is Apple's multi-cam guidance — forcing 32BGRA made
    // the ISP convert every frame of BOTH streams (1440p + 720p @ 30 fps),
    // the top known source of steady-state dropped frames on a multi-cam
    // graph. Everything downstream is format-agnostic: CIImage renders 420
    // natively for the JPEG sinks, and the delivery writer takes its format
    // hint from the stream itself.
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
      // Native format — see the primary output above. Both synced outputs
      // MUST be configured alike or the graph converts one stream only.
      out.alwaysDiscardsLateVideoFrames = true
      // virtual graph wires to the UW constituent port on the ONE
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
        // Output refused or no live connection: drop back to single-cam
        // honestly (stated as stereo:'unsupported' in the resolve payload;
        // the refusal itself is logged inside wireOutput).
        logDiagnosticEvent("secondary video output unavailable at configure — single-cam fallback (see wire refusal above)")
        if let sInput = secondaryInput { session.removeInput(sInput) }
        secondaryInput = nil
        stereoAttached = false
      }
    }

    // Per-frame intrinsics via the documented attachment path (iOS 11+).
    // REVIEW-CHECK: enable BEFORE startRunning (documented requirement).
    for out in [primaryOut, secondaryOut].compactMap({ $0 }) {
      if let connection = out.connection(with: .video),
         connection.isCameraIntrinsicMatrixDeliverySupported {
        connection.isCameraIntrinsicMatrixDeliveryEnabled = true
      }
    }

    // Photo outputs: primary (RAW opt-in + session calibration + full-res
    // stills, W2.1), secondary (session calibration one-shot + stereo
    // full-res stills). Steady-state cost is real — the hardwareCost
    // watchdog below is the arbiter (spec §6). The outputs are added INSIDE
    // this configuration, before startRunning — never mid-flight.
    let primaryPhoto = AVCapturePhotoOutput()
    // field fix: on the virtual graph the photo output was REFUSED
    // (canAddConnection=false) when wired to the explicit WIDE constituent
    // port — a photo output binds the virtual device's own port, not a
    // constituent. Nil port = the documented selector resolves the virtual
    // device's video port. Legacy two-input graph keeps its explicit nil
    // already (virtualWidePort is nil there — same call either way).
    if let pInput = primaryInput,
       wireOutput(primaryPhoto, to: pInput, port: virtualInput != nil ? nil : virtualWidePort, mediaType: .video, in: session, label: "primary-photo") != nil {
      primaryPhotoOutput = primaryPhoto
      applyFullResPhotoPolicy(to: primaryPhoto, device: primary)
    }
    // NO secondary photo output is attached — anywhere, in any
    // configuration. The 2026-08-17 field matrix (iPhone 17, four sessions,
    // all four 12MP-clamp × session-calibration combinations) delivered
    // ZERO secondary video frames from the first frame of every session
    // with a green census, exonerated pressure (0.69 < 1.0), hardwareCost
    // (0.5), formats, and both debug flags — while the PiP (preview layer
    // bound directly to the UW port, bypassing the data output) stayed
    // LIVE. The one element present in every dead session was the
    // secondary AVCapturePhotoOutput wired to the same port/input as the
    // secondary video data output. Removing it tests the last structural
    // suspect; the stereo still is now derived from the synchronized
    // video pair (see attachFullResStills). Consequences, all stated:
    //   - fullResSecondary = the retained pair's UW frame at stream
    //     resolution (1280×720), hashed on disk as before — labeled
    //     'video-stream-derived' in its evidence metadata;
    //   - the session calibration one-shot covers the PRIMARY only —
    //     UW session calibration commits 'unavailable' (partial ≠
    //     fabricated; AVCameraCalibrationData only rides photo captures);
    //   - secondary depth stills: never-recorded 'no-photo-output'.
    // If complete-pairs climb from zero on this build, the photo output's
    // mere attachment was the killer and the derivation above is
    // permanent. If they don't, the graph is now minimal — video data
    // outputs only — and the dump exonerates outputs entirely.
    // FIELD VERDICT: they didn't (watchdog fired with
    // absent=118/complete=0 at +4 s, flood rungs failed) — the photo
    // output is exonerated. The last component standing in the dead path
    // was the AVCaptureDataOutputSynchronizer itself; bypasses it
    // on this graph (direct delegate — see ExhibitSecondaryDirectHandler).
    secondaryPhotoOutput = nil
    if stereoAttached {
      logDiagnosticEvent("0.18.5: secondary photo output NOT attached by design — stereo stills derive from the synced video pair; UW session calibration commits 'unavailable'")
    }

    session.commitConfiguration()

    // dual-cam census: after commit, log what the graph was BILLED —
    // hardwareCost and systemPressureCost are only truthful post-commit
    // (WWDC19-249: commit → read → roll back), plus each input's override as
    // applied. NOTE: the 26.5 SDK exposes systemPressureState on
    // AVCaptureSession but NOT on AVCaptureMultiCamSession (compile error if
    // read here) — multi-cam pressure arrives through systemPressureCost, so
    // the cost pair IS the whole pressure story for this session type. The
    // field log proved format+wiring innocent while zero secondary
    // frames ever arrived; these numbers are the next suspect list.
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

    // Hardware-cost watchdog (spec §6): refuse configurations the OS will
    // throttle. hardwareCost > 1.0 means the requested graph exceeds the
    // budget — tear down and say so.
    if session.hardwareCost > 1.0 {
      promise.reject(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.hardwareCost,
        "Camera graph cost \(session.hardwareCost) exceeds budget 1.0; refused rather than throttled"
      ))
      return
    }

    // (H2): systemPressureCost was LOGGED (census above) but never
    // GATED — an over-budget pressure cost sailed through the hardwareCost
    // watchdog, and the review ties exactly that to the silent
    // stream-shedding signature. Over-budget pressure declines STEREO
    // honestly — the single-cam graph continues and the resolve payload says
    // so — because pressure cost is dynamic and may settle; the whole
    // session is not refused. Runs pre-start, so the PiP connection does not
    // exist yet; outputs/input are removed directly (the local secondaryOut
    // hasn't become the secondaryVideoOutput property at this point).
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

    // Rotation + mirroring policy on every video connection (
    // per-device, NEVER a hardcoded angle): data outputs, photo outputs,
    // and (in the view/PiP) preview connections all ask the
    // AVCaptureDevice.RotationCoordinator for their horizon-level angle.
    // iPhone 17's Center Stage front camera has a PORTRAIT-mounted sensor
    // (WWDC 2026 session 341) — the legacy 90° constant produced sideways
    // front preview/video/stills there. The app is portrait-locked, so one
    // read per connection setup is the whole policy; lens swaps re-run
    // applyConnectionPolicies.
    //
    // ORIENTATION CONTRACT: on AVCaptureVideoDataOutput connections this
    // rotation is PHYSICAL — the delivered pixel buffers arrive rotated by
    // the connection's videoRotationAngle (CMVideoFormatDescriptionGetDimensions
    // returns the swapped dims). It is NOT display metadata; the-era
    // comment claiming "pixels are untouched" was wrong, and stamping a
    // second rotation into the writer's track transform on top of these
    // physically-upright frames was the sideways-media bug. Every consumer
    // of these buffers (writer input transform, JPEG sinks) must treat the
    // bytes as already upright — see handleVideoFrame and jpegData.
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
        // W7 isolation: default off — wave-5/6 suspect, flip via Settings ▸ Diagnostics when testing
        if ExhibitDebugFlags.photoConnectionRotation {
          RotationPolicy.apply(to: connection, device: primary)
        } else if connection.isVideoOrientationSupported {
          connection.videoOrientation = .portrait
        }
      }
      if stereoAttached, let secondary = (secondary ?? secondaryConstituent),
         let connection = secondaryPhotoOutput?.connection(with: .video) {
        // W7 isolation: default off — wave-5/6 suspect, flip via Settings ▸ Diagnostics when testing
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

    // Synchronizer over the video outputs (created AFTER commit so the
    // outputs are fully connected). Single-output synchronizer in
    // single-cam mode keeps one code path.
    // on the MULTI-INPUT graph the synchronizer carries the
    // primary ONLY — the secondary output gets a DIRECT sample-buffer
    // delegate (ExhibitSecondaryDirectHandler) and pairs by PTS in
    // handleSynchronizedCollection. The synchronizer over two PHYSICAL
    // devices never delivered one secondary frame on iPhone 17 / iOS 26.x
    // ( – + the retest: green census, zero callbacks,
    // UW photo path + PiP preview live). The virtual graph keeps both
    // outputs in the synchronizer — field-proven there.
    let outputs: [AVCaptureOutput] = virtualInput != nil
      ? [primaryOut, secondaryOut].compactMap { $0 }
      : [primaryOut]
    let sync = AVCaptureDataOutputSynchronizer(dataOutputs: outputs)
    sync.setDelegate(syncHandler, queue: sessionQueue)
    synchronizer = sync
    if virtualInput == nil, let secondaryOut = secondaryOut {
      secondaryOut.setSampleBufferDelegate(secondaryDirectHandler, queue: sessionQueue)
    }

    // Opportunistic third view ( extension point, UNTESTED on
    // hardware; inert unless ExhibitDebugFlags.thirdViewEnabled is ON).
    prepareThirdViewIfEnabled(in: session)

    // Wire state BEFORE startRunning so early frames land safely.
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

    // interruption boundaries into the persistent log. If the OS
    // interrupts (or never fully resumes) the graph, the secondary stream
    // can park while previews keep their last buffers — this is the
    // discriminate-or-exonerate evidence for the field.
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

    // (H3): record the isActive TIMELINE on both video
    // connections — isActive settles asynchronously, so the one-shot census
    // reads it too early. Never-active = rejected at the graph level; a
    // transition at t=+N s = evicted after start. The wall clock is set
    // first so the initial-state callbacks get a sane t=+0.000s.
    sessionStartWallClock = Date()
    observeConnectionActivity(primaryVideoOutput?.connection(with: .video), label: "primaryVideo")
    observeConnectionActivity(secondaryVideoOutput?.connection(with: .video), label: "secondaryVideo")

    // NSException-safe start ( Drop 2): a thrown ObjC exception from
    // startRunning can NEVER reach the bridge as a crash — the shim catches
    // it and we reject + tear down honestly instead.
    if let startError = ExhibitSessionControl.safelyStart(session) {
      rejectStart(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Session start failed: \(startError.localizedDescription)"
      ))
      teardownSession()
      return
    }

    // IMU evidence sink start (0.15): AFTER startRunning so a failed start
    // owns nothing to tear down. CoreMotion is independent of the capture
    // graph, and the session calibration one-shot fires ≥1 s later — the
    // logger never starts or stops inside calibrationCaptureInFlight, and
    // its stop (teardown/thermal) cannot disturb the photo pipeline. No IMU
    // hardware or serious/critical thermal pressure → no logger, and every
    // capture honestly reports sensorLogState 'unavailable'.
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

    // the post-start census into the persistent log (isActive is
    // only meaningful while running — the first-frame census below is the
    // ground truth; this one catches a graph that never delivers at all).
    logDiagnosticEvent("configureSession started: graph=\(virtualGraphActive ? "virtual-dual-wide" : "multi-input") stereoAttached=\(stereoAttached) census=\(connectionCensus())")

    // the secondary takes the primary's current AE/AWB/AF state
    // (fresh devices are already continuous-auto from configureFormat; a
    // re-configured session may carry stored pro controls).
    mirrorProControlsToSecondary()

    let timeout = DispatchWorkItem { [weak self] in
      guard let self = self, !self.startPromiseDone else { return }
      self.rejectStart(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "No video frames arrived within 10s of start"))
      self.teardownSession()
    }
    self.startTimeout = timeout
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: timeout)
  }

  /// Stable format identifier: "<deviceType.rawValue>:<index>" where index
  /// is the format's position in device.formats. Stable for a given device
  /// model + OS; committed in metadata so a capture is reproducible.
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

  /// One half of the pair missing: the pair is skipped honestly (spec §4.1)
  /// — never fabricate a "pair" from unpaired frames. ABSENT vs DROPPED
  /// (the diagnostics split the flood could not
  /// discriminate): on the virtual graph ABSENT = the synchronizer returned
  /// no data object at all and DROPPED = a data object exists but the
  /// platform marked it dropped; on the multi-input graph (direct delivery,
  /// A pairing miss counts absent — directSecondaryFrameCount and
  /// the didDrop callback carry the arrival evidence there. The silence
  /// watchdog cannot see a flood where the PRIMARY keeps arriving, so the
  /// 150/300-consecutive streaks kick one recovery rung each (~5 s / ~10 s)
  /// — a wedged secondary stream gets a chance to recover instead of stereo
  /// going quietly absent for the whole session.
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
      // the flood rungs into the persistent log WITH the live
      // census — the field run must show the connection state at the
      // moment the platform starves the secondary. Rung 1 names the
      // graph's actual mechanism: synchronizer rebuild (virtual) or direct
      // delegate re-attach (multi-input, inside rebuildSynchronizer).
      logDiagnosticEvent("secondary flood rung 1 (150 consecutive, \(virtualGraphActive ? "rebuild synchronizer" : "re-attach direct secondary delegate")): census=\(connectionCensus())")
      rebuildSynchronizer()
    } else if consecutiveSecondaryDrops == 300, !secondaryReseatDone {
      // Rung 2: a rebind cannot resurrect a secondary stream the
      // platform has parked — remove + re-add the secondary VIDEO DATA
      // OUTPUT once per session for a fresh connection and pool.
      secondaryReseatDone = true
      logDiagnosticEvent("secondary flood rung 2 (300 consecutive, reseat output): census=\(connectionCensus())")
      reseatSecondaryVideoOutput()
    }
  }

  /// multi-input stereo: the secondary UW output delivers DIRECTLY
  /// (the synchronizer is bypassed on that graph — see
  /// ExhibitSecondaryDirectHandler's doc for the field evidence). Runs on
  /// sessionQueue at frame rate and does NOTHING but count the arrival and
  /// pin the newest buffer (ARC — the pool cannot recycle a pinned buffer;
  /// at most ONE is held) with its PTS. Pairing happens on the primary's
  /// cadence in handleSynchronizedCollection; intrinsics ride the retained
  /// sample buffer and are read lazily at commit (the Drop 2
  /// frame-rate budget rule).
  private func handleDirectSecondaryFrame(_ buffer: CMSampleBuffer) {
    directSecondaryFrameCount += 1
    latestDirectSecondary = (buffer, CMSampleBufferGetPresentationTimeStamp(buffer), Date())
  }

  /// The platform dropped a directly-delivered secondary frame (
  /// multi-input only): counted as a platform drop, matching the virtual
  /// graph's sampleBufferWasDropped accounting.
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

    // the secondary half's SOURCE depends on the graph. Virtual
    // graph: the synchronizer carries both outputs (field-proven since
    // Multi-input graph: the synchronizer NEVER surfaced a
    // secondary data object on iPhone 17 / iOS 26.x ( –and the
    // retest — green census, zero callbacks, UW photo path + PiP
    // preview live), so the secondary rides its OWN delegate and pairs by
    // PTS here. The synchronizer contributed nothing we used — deltaMs was
    // always computed app-side.
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
        // Direct-delegate pairing: the newest UW frame within 25 ms of the
        // primary's PTS (hardware-synced multi-cam streams land far inside
        // one 33 ms frame; 25 ms tolerates phase skew without ever pairing
        // ACROSS frames at 30 fps) and fresh at the wall clock. A match is
        // CONSUMED — one UW frame can never pair two primary frames. A
        // miss counts absent; directSecondaryFrameCount + didDrop carry
        // the arrival evidence for the watchdog.
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

    // Retain the newest pair, release the previous (pool starvation guard).
    // This callback runs on the synchronizer's delivery queue at frame rate:
    // it does NOTHING but timestamp arithmetic and one struct store — no
    // intrinsics extraction (lazy at commit), no JSON, no allocation-heavy
    // work. Work done here delays the NEXT collection's delivery and is the
    // classic steady-state dropped-pair source ( Drop 2).
    let now = Date()
    lastCollectionAt = now
    if secondaryBuffer != nil {
      consecutiveSecondaryDrops = 0
    }
    // Extract the sample buffers HERE — inside the callback, the only
    // window in which the wrappers vend valid payloads (Apple's contract,
    // quoted on RetainedPair). Storing them in the pair ARC-retains the
    // buffers themselves; the wrappers are discarded when this scope ends.
    let pair = RetainedPair(
      primary: primaryData.sampleBuffer,
      secondary: secondaryBuffer,
      deltaMs: deltaMs,
      receivedAt: now
    )
    latestPair = pair

    // count pairs with BOTH halves — completePairCount == 0 while
    // the absent/dropped counters climb == the secondary stream never
    // landed this session.
    let frameComplete = secondaryBuffer != nil
    if stereoActive, frameComplete {
      completePairCount += 1
    }

    // Shutter-burst ring: preview mode only,
    // sink opt-in only. Appending releases the oldest frame, so the
    // steady-state held-buffer count stays bounded.: retain
    // primary-valid frames even when the secondary half is absent — the
    // per-frame index entry states completeness (secondaryPath null /
    // complete:false), so a secondary flood degrades the burst to
    // primary-only frames honestly instead of producing NO burst at all
    // (the failure: completePairCount == 0 forever meant the
    // ring never filled). Nothing is fabricated: every frame commits
    // exactly the halves it actually has.
    // (field: a starved pipeline redelivered collections built on
    // the SAME primary buffer — the ring filled with identical frames and
    // the burst read as "0 px per frame" while the gyro said the phone was
    // whipping): retain only PTS-ADVANCING frames. Duplicates are not
    // evidence; a starved pipeline now commits an honestly SHORTER burst,
    // or the existing zero-frame 'error' EvidencePath. The PTS read is a
    // struct field read — within this callback's frame-rate budget.
    if burstSinkWanted, mode == .preview {
      let framePTS = CMSampleBufferGetPresentationTimeStamp(primaryData.sampleBuffer)
      let advances = (!framePTS.isValid) || (lastBurstPTS.map { CMTimeCompare(framePTS, $0) > 0 } ?? true)
      // cadence gate — retain at most one frame per
      // burstCadenceSeconds so the burst spans the advertised ±300 ms
      // axis instead of ~115 ms of sub-pixel-identical frames.
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

    // First frame resolves configureSession / startVideo and reports
    // preview readiness — the payload states WHICH signal fired (spec §2).
    if !startPromiseDone {
      if mode == .video {
        videoStartDate = Date()
      }
      resolveStart([
        "sessionId": sessionId,
        "startedAtMs": currentEpochMs(),
        "stereo": stereoActive ? StereoAvailability.available.rawValue : StereoAvailability.unsupported.rawValue,
        // (additive): which rear-stereo graph this session runs —
        // "virtual-dual-wide" (one input, constituent ports) or
        // "multi-input" (two device inputs, pre-default).
        "graph": virtualGraphActive ? "virtual-dual-wide" : "multi-input",
        "hardwareCost": session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
        // diagnostics (additive): the live connection census at first
        // frame — a silently absent/cross-wired connection is visible here.
        "connections": connectionCensus(),
      ])
      // the same census into the persistent log at first frame —
      // isActive is the ground-truth "media is flowing through this
      // connection" signal for the secondary-absence triage.
      logDiagnosticEvent("first frame: census=\(connectionCensus())")
      pushSessionToPreview(readySignal: "first-synchronized-frame")
      // the session-calibration one-shot is RETIRED — no call site
      // remains (see scheduleSessionCalibrationCapture's doc).
    }

    // Video mode: feed the delivery writer + periodic pair cadence (spec §8).
    if mode == .video {
      handleVideoFrame(primaryData.sampleBuffer)
      maybeDumpPeriodicPair()
    }
  }

  /// Per-frame intrinsics from the documented sample-buffer attachment
  /// (iOS 11+; CFData encoding a matrix_float3x3). Row-major 9 floats.
  /// nil when the attachment is absent — stated, never fabricated.
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

// MARK: - Session calibration one-shot (spec §4.2 — full calibration via the documented photo path)

extension ExhibitCameraModule {

  /// Fires a dual photo capture once per session configuration to harvest
  /// full AVCameraCalibrationData (extrinsics, distortion LUTs) for both
  /// devices. The inter-camera extrinsic is a device-fixed property — it
  /// does not change frame to frame — so one capture per configuration is
  /// an honest commitment, labeled `session-photo-capture` so the desk can
  /// distinguish it from per-frame data. Failure leaves the map empty and
  /// every capture's calibration JSON says so (partial ≠ fabricated).
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
    // health gate: a calibration photo on a
    // graph that is ALREADY dropping frames is gasoline on the flood — and
    // the build-26 "Cannot Record" failures show a photo capture attempted
    // under pressure can refuse and leave the output unwilling to record
    // afterward. If the pipeline is unhealthy at fire time, SKIP this
    // session's one-shot: calibrationSource commits 'unavailable', which is
    // honest, and the graph keeps every buffer for actual evidence.
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
    // No flash for a calibration frame; we discard the pixels. The setter
    // validates against supportedFlashModes at SET time and throws an
    // uncatchable NSException on a mismatch — assign only when supported.
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
    // Retain the handler until the delegate fires (CaptureKit pattern:
    // the module holds it, the closure releases it on completion).
    photoHandlers.append(handler)
    // NSException-safe fire: settings validation against
    // the live multi-cam graph can throw — a thrown exception is a stated
    // skip, never a crash; the sequence continues with the next target.
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

// MARK: - capture — the commitment contract (spec §4/§5)

extension ExhibitCameraModule {

  /// opts: { deliveryPath, evidenceDir, raw?: Bool }.
  /// Delivery never dies: evidence artifacts degrade to stated three-state
  /// EvidencePath dicts; the primary still lands or the call rejects.
  func capture(opts: [String: Any], promise: Promise) {
    guard session != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.noSession, "No camera session is running"))
      return
    }
    guard !captureInFlight else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.busy, "A capture is already in flight"))
      return
    }
    // Validate-only: the URLs themselves are re-parsed by runCapture after
    // any freshness wait — binding them here produced unused-let warnings.
    guard let deliveryPath = opts["deliveryPath"] as? String,
          let evidenceDir = opts["evidenceDir"] as? String,
          exhibitCameraURL(for: deliveryPath) != nil,
          exhibitCameraURL(for: evidenceDir) != nil else {
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Malformed deliveryPath or evidenceDir"))
      return
    }
    // Freshness: a pair older than 500 ms at shutter time is stale (spec
    // §4.1) — a covered/transitioning camera must not mint old pixels as
    // "now". lesson (iPhone 17, dual-camera): a configuration hiccup
    // can stall the data pipeline while the preview layer keeps painting,
    // and a hard reject made stills unusable. So a stale/missing pair now
    // waits up to 900 ms for the NEXT fresh pair — old pixels are never
    // reused, the committed pair carries its own PTS — and only then
    // rejects, with the pipeline state in the message so the failure is
    // diagnosable from the error text alone.
    if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) < 0.5 {
      runCapture(opts: opts, promise: promise, pair: pair)
    } else {
      // diagnostics: the "delivered but rejected as stale" counter —
      // a shutter that found no fresh pair at fire time.
      staleShutterCount += 1
      awaitFreshPair(opts: opts, promise: promise, deadline: Date().addingTimeInterval(0.9))
    }
  }

  /// Polls sessionQueue every 50 ms for a fresh pair until the deadline.
  /// Everything here is sessionQueue-confined, so the check and the frame
  /// handler can never race.
  private func awaitFreshPair(opts: [String: Any], promise: Promise, deadline: Date) {
    if let pair = latestPair, Date().timeIntervalSince(pair.receivedAt) < 0.5 {
      runCapture(opts: opts, promise: promise, pair: pair)
      return
    }
    if Date() >= deadline {
      // GRACEFUL DEGRADATION ( approved fallback): a starved sync
      // pipeline must NEVER dead-end the shutter. Under a chronic drop
      // flood the retained pair is RELEASED at staleness (buffers returned
      // to the pools), so no fresh pair may ever arrive — the old hard
      // E_STALE_PAIR reject made every still unusable on exactly the
      // devices where the evidence matters. The photo output captures the
      // delivery still directly (full sensor resolution, the platform's
      // own ISP) and the commit states the degradation verbatim:
      // stereoStatus 'unavailable' + this reason, every pair-derived
      // artifact never-recorded('no-synchronized-pair-at-shutter'), stereo
      // geometry ABSENT — never fabricated. Genuine failures (no photo
      // delivered, write failure) still reject.
      let ageText: String
      if let pair = latestPair {
        ageText = String(format: "%.1fs", Date().timeIntervalSince(pair.receivedAt))
      } else if let last = lastCollectionAt {
        ageText = "\(String(format: "%.1fs", Date().timeIntervalSince(last))); stale pair released under drops"
      } else {
        ageText = "no frames yet"
      }
      let reason = "no fresh synchronized frame within 900ms at shutter (latest: \(ageText); dropped pairs: \(droppedPairCount), primary: \(droppedPrimaryCount), secondary-half: \(droppedSecondaryHalfCount); stereo: \(stereoActive ? "on" : "off"); secondary-absent: \(secondaryAbsentCount), secondary-dropped: \(secondaryDroppedCount), complete-pairs: \(completePairCount), stale-shutters: \(staleShutterCount), reseat: \(secondaryReseatDone ? 1 : 0))"
      // Kick a synchronizer rebind NOW so the pipeline is usually flowing
      // again by the next tap (the 2 s watchdog would eventually do this;
      // a shutter degradation is the user's own signal that it's needed).
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

  /// GRACEFUL DEGRADATION ( the approved stereo-off fallback).
  /// Fired from awaitFreshPair's deadline: the sync pipeline produced no
  /// fresh pair within the shutter window, so the photo OUTPUT captures the
  /// delivery still directly — full sensor resolution, the platform's own
  /// ISP and EXIF. The commit states the degradation verbatim:
  ///   - stereoStatus 'unavailable' + stereoUnavailableReason (the reason
  ///     string is machine-checkable fact, not a euphemism);
  ///   - every pair-derived artifact (secondary frame, calibration,
  ///     timestamps, metadata block) is never-recorded with the reason
  ///     'no-synchronized-pair-at-shutter' — the three-state contract stays
  ///     intact so the seal queue's fail-closed validation passes honestly;
  ///   - stereo geometry fields are ABSENT — never fabricated;
  ///   - captureSettings.deliveryStillSource says EXACTLY what the delivery
  ///     pixels are, and the photo's own OS-written EXIF + strobe outcome
  ///     merge in (the delivery still IS the photo on this path).
  /// The ONLY rejections left are genuine capture failures (no photo
  /// delivered, no photo output, write failure) — and every path settles
  /// the promise (10 s watchdog as the backstop), so the UI's capture state
  /// can never wedge.
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

    // Same settle/watchdog discipline as runCapture — every path settles
    // exactly once.
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
      // settings is declared below this closure (lexical scope) — the dump
      // reads the live output/connection state instead.
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
    // validated against THIS output's supportedFlashModes; an unsupported
    // mode degrades to off with the reason stated, never thrown. The
    // flashMode setter validates against supportedFlashModes at SET time
    // and raises an uncatchable NSException on a mismatch — the DECISION is
    // computed once here and only contained values are ever assigned (an
    // unassigned setting defaults to no flash).
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
      // this clamp is now ON by default (the flag is the escape
      // hatch — see ExhibitDebugFlags.photoMaxDimensionsPolicy).
      if ExhibitDebugFlags.photoMaxDimensionsPolicy, #available(iOS 16.0, *) {
        fresh.maxPhotoDimensions = photoOutput.maxPhotoDimensions
      }
      // D1: request depth delivery only when honest (flag + live-output
      // support for the current device/format); the reason rides the depth
      // fields when not requested, a delivery/extraction failure degrades to
      // depth-not-recorded, never to a failed capture.
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
          // one automatic retry after a beat — "Cannot Record" under
          // transient resource contention can clear; a wedged output fails
          // twice and the message says so. The handler stays retained for
          // the retry; it is released at either settle.
          if !retried {
            retried = true
            self.sessionQueue.asyncAfter(deadline: .now() + 1.5) { [weak self] in
              // Retry through handlerRef (the var is initialized before any
              // closure runs; capturing `handler` itself here would be a
              // capture-before-initialization compile error).
              guard let self = self, !settled, let delegateHandler = handlerRef else { return }
              // NSException-safe retry fire — a thrown
              // settings-validation exception settles as a stated failure.
              // the retry fires a FRESH settings object from the
              // factory — re-firing the first attempt's instance throws
              // "Settings may not be re-used" (Apple: one trip per object).
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
          // `try?`: on a fresh delivery path the remove throws "no such
          // file" (the every-still-fails lesson).
          try? FileManager.default.removeItem(at: deliveryURL)
          try data.write(to: deliveryURL, options: .atomic)
        } catch {
          settle(.failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.sink, "Cannot write delivery still: \(error.localizedDescription)")))
          return
        }

        // The delivery still IS this photo: its OS-written EXIF and strobe
        // outcome are the delivery's own facts, merged into captureSettings.
        let exif = PhotoExifExtractor.dictionary(from: photo)
        let fired = PhotoExifExtractor.flashFired(from: exif)
        // M1/C6: the stabilization mode ACTUALLY in force on this output's
        // connection at the commit instant (API-self-reported, not
        // measured); nil where the connection lacks stabilization — the
        // builder OMITS the key, never fabricates from the preferred mode.
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
        // Artifact-read color profile (M1/C6): out of the delivered JPEG's
        // own bytes. OMITTED when ImageIO reports no profile name — never
        // assumed from the request path.
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

        // D1 depth export: runs only AFTER the delivery still is safely on
        // disk — any depth failure degrades to a stated never-recorded or
        // error, NEVER to a failed capture (the photo is the artifact that
        // matters; depth failure must not regress sealing).
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

        // The mirroring truth: read the connection we explicitly configured
        // (RotationPolicy) — never implied from the device position.
        let mirrored = photoOutput.connection(with: .video)?.isVideoMirrored ?? false

        var payload: [String: Any] = [
          "captureId": captureId,
          "deliveryPath": deliveryURL.path,
          "capturedAtMs": capturedAtMs,
          // sealed projection inputs — which camera, and its real
          // horizontal field of view (device-reported, never assumed). The
          // desk's sun/horizon math is wrong without both (front looks out
          // device +Z; the old desk assumed a nominal 52° hfov).
          "facing": device.position == .front ? "front" : "back",
          "primaryHfovDeg": Double(device.activeFormat.videoFieldOfView),
          // D1: bytes on disk at the evidence path; mime/map semantics/
          // dimensions/accuracy in depthMetadata; sha256 of the exact
          // bytes — the JS commit layer takes these verbatim.
          "depth": depth.evidence,
          "depthSha256": depth.sha256 as Any? ?? NSNull(),
          "depthMetadata": depth.metadata as Any? ?? NSNull(),
          // Session CAPABILITY string, unchanged — the degradation is stated
          // by stereoStatus, not by rewriting what the session could do.
          "stereo": self.stereoActive ? "available" : (self.stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
          "stereoStatus": "unavailable",
          "stereoUnavailableReason": reason,
          "frontMirrored": mirrored,
          // Pair-derived artifacts: never-recorded, reason verbatim. The
          // three-state contract stays intact for the seal queue's
          // fail-closed validation; no geometry is fabricated.
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
          // The full-res slot stays honest: there is no SEPARATE full-sensor
          // artifact on this path — the delivery still is the photo.
          "fullResStill": EvidencePathBuilder.neverRecorded("delivery-still-is-the-full-sensor-photo"),
          "fullResStillSha256": NSNull(),
          "fullResStillDimensions": NSNull(),
          "fullResSecondary": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "fullResSecondarySha256": NSNull(),
          "fullResSecondaryDimensions": NSNull(),
          // Shutter burst: not attempted on the degraded path —
          // stated, consistent with the pair-derived artifacts above.
          "ringBufferDir": EvidencePathBuilder.neverRecorded("no-synchronized-pair-at-shutter"),
          "ringFrameCount": 0,
          // diagnostics (additive): the live connection census at
          // the moment of commit — every capture carries its graph truth.
          "connections": self.connectionCensus(),
        ]

        // IMU slice with a wall-clock shutter anchor (no pair PTS exists on
        // this path) — the file's window line states its own requested
        // bounds. A failed log never blocks the still.
        self.attachSensorLogFieldsDegraded(
          captureId: captureId,
          capturedAtMs: capturedAtMs,
          evidenceDirURL: evidenceDirURL
        ) { [weak self] sensorFields in
          guard let self = self else { return }
          for (key, value) in sensorFields { payload[key] = value }
          // RAW is a second photo-output capture; on the degraded path it
          // is not attempted — stated, not silently absent.
          payload["rawDng"] = EvidencePathBuilder.neverRecorded(wantRaw ? "degraded-single-lens-capture" : "not-requested")
          self.sessionQueue.async { settle(.success(payload)) }
        }
      }
    }
    handlerRef = handler
    photoHandlers.append(handler)
    // NSException-safe fire: capturePhoto validates the
    // settings against the LIVE multi-cam graph and raises an NSException
    // on a mismatch — Swift cannot catch one, so the fire goes through the
    // ObjC trampoline and a throw becomes this path's stated failure.
    if let captureError = ExhibitSessionControl.safelyCapturePhoto(output: photoOutput, settings: settings, delegate: handler) {
      photoHandlers.removeAll { $0 === handler }
      settle(.failure(ExhibitCameraNamedException(
        ExhibitCameraErrorCode.platform,
        "Single-lens fallback capture threw at fire time: \(captureError.localizedDescription); \(self.photoFailureDump(path: "degraded", settings: settings, output: photoOutput, device: device))"
      )))
    }
  }

  /// Degraded-path IMU slice: identical window ([-2.0 s, +0.5 s]) and
  /// three-state fields to attachSensorLogFields, but the shutter anchor is
  /// the mach clock at photo delivery — no pair PTS exists on this path.
  /// Always calls completion exactly once, on sessionQueue.
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
        // This path has no pair PTS — its shutter estimate IS the event
        // instant on the boot clock (: not the flush instant).
        anchorBootSec: shutterSec,
        logger: logger
      ))
    }
  }

  /// The capture body, run once a fresh pair is in hand (immediately when
  /// the pipeline is healthy, after a short wait when it hiccuped).
  private func runCapture(opts: [String: Any], promise: Promise, pair: RetainedPair) {
    // opts paths were validated by capture before the wait; re-parse —
    // a malformed path still rejects, never a crash.
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

    // 10 s capture watchdog (spec §6) — covers the RAW await too.
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
      // The full-res/RAW photo captures ride this chain — a wedged photo
      // output is one way to hit this timeout, so dump the photo state.
      promise.reject(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Capture timed out after 10s; \(self.photoFailureDump(path: "normal", settings: nil, output: self.primaryPhotoOutput, device: self.primaryDevice))"))
    }
    sessionQueue.asyncAfter(deadline: .now() + 10.0, execute: watchdog)

    // commitPair snapshots sessionQueue state, then encodes + writes on
    // sinkIOQueue (the delivery queue NEVER encodes — see commitPair). Its
    // completion hops back here, on sessionQueue.
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
        // Shutter-burst sink:
        // commits the pre-shutter ring + the next few post-shutter frames
        // to evidenceDir/ring-<captureId>/ BEFORE the full-res photo
        // captures fire (a photo capture on the live graph is the
        // documented maximum-resource moment and would starve the burst's
        // post-shutter frames). Never rejects the capture; the result is a
        // three-state EvidencePath in ringBufferDir + ringFrameCount.
        self.attachShutterBurst(
          shutterPair: pair,
          captureId: captureId,
          evidenceDirURL: evidenceDirURL,
          payload: payload
        ) { [weak self] burstPayload in
          guard let self = self else { return }
        // IMU sink slice (0.15): the three-state sensorLog* fields join the
        // payload before settle. When the sink is live this waits out a 0.55 s
        // post-shutter drain (well inside the 10 s capture watchdog); when it
        // is off/unavailable the completion fires synchronously and nothing
        // about the capture changes. A failed log NEVER blocks the still.
        self.attachSensorLogFields(
          pair: pair,
          captureId: captureId,
          capturedAtMs: capturedAtMs,
          evidenceDirURL: evidenceDirURL
        ) { [weak self] sensorFields in
          guard let self = self else { return }
          var final = burstPayload
          for (key, value) in sensorFields { final[key] = value }
          // Full-res stills (W2.1): photo-output captures at full sensor
          // resolution, SEQUENTIAL per output (the calibration one-shot's
          // starvation lesson), folding the strobe outcome + OS-written
          // EXIF into captureSettings (W2.4). A full-res failure NEVER
          // rejects the capture — the delivery still already landed; the
          // failure is a stated three-state EvidencePath.
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

  // MARK: - Shutter-burst sink

  /// Settles the post-shutter collection exactly once (early at the target
  /// count, or at the 1.5 s timeout), always on sessionQueue. A session
  /// rebuild clears burstContinuation in teardownSession — the in-flight
  /// capture then settles via its own 10 s watchdog, the existing
  /// discipline for teardown-mid-capture.
  private func finishBurstCollection() {
    guard let continuation = burstContinuation else { return }
    burstContinuation = nil
    burstTimeout?.cancel()
    burstTimeout = nil
    burstPostTarget = 0
    continuation()
  }

  /// Arms the post-shutter collection and, when it settles, commits the
  /// burst on sinkIOQueue. Completion fires exactly once, on sessionQueue.
  /// Frames older than 2 s before the shutter are EXCLUDED from the pre
  /// set — an old frame is never passed off as "around the shutter" (the
  /// no-stale-substitution rule); under a secondary-half flood that can
  /// leave zero frames, which commits as an honest 'error' EvidencePath.
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
    // The ring is preview-mode only by design (pool pressure during a
    // recording is not an acceptable trade) — stated, never implied.
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

  /// Encodes + writes the burst frames OFF the frame queue (sinkIOQueue —
  /// the commitPair discipline). Each frame contributes a downsampled
  /// primary JPEG and, when present, a secondary JPEG; the JSON index
  /// states per-frame PTS, host-clock delta, and shutter offset so the
  /// desk can verify "around the shutter" from the committed data itself.
  /// Partial failures degrade per frame (path null + note in the index);
  /// zero committed frames is an 'error' EvidencePath, never a rejection.
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
          // the ring may retain primary-only frames during a
          // secondary flood — each entry states its own completeness.
          "complete": frame.secondary != nil,
        ]
        // a secondary buffer enters the pair ONLY when the delivery
        // callback confirmed it wasn't a platform drop — no wrapper flag to
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
          // the frame's own 8×8 luma dHash rides the index — the
          // committed distinctness fact (see dHash64's header).
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

  // MARK: - IMU sink slice (0.15 — three-state honesty, audio-module precedent)

  /// The three-state vocabulary, shared by the photo and video paths:
  /// 'recorded' + path / 'unavailable' + null (toggle off, no IMU hardware,
  /// or thermal-parked — nothing was ever going to be recorded) / 'failed'
  /// + null + sensorLogError (requested and died — stated as a failure).
  /// sensorLogError rides ONLY in the failed case (the frozen JS contract
  /// marks it optional).
  private func sensorLogFields(state: String, path: String? = nil, error: String? = nil) -> [String: Any] {
    var fields: [String: Any] = [
      // Same `as Any? ?? NSNull` idiom as rawPcmPath/hardwareCost above:
      // mixed String/NSNull literals made the dictionary type ambiguous on
      // a past EAS build; the explicit cast resolves it.
      "sensorLogPath": path as Any? ?? NSNull(),
      "sensorLogState": state,
    ]
    if let error = error {
      fields["sensorLogError"] = error
    }
    return fields
  }

  /// Flush one window from the ring and fold the outcome into the
  /// three-state fields. Zero samples in the window writes NO file and
  /// reports 'unavailable' — an empty log is not evidence. A write failure
  /// reports 'failed' with the error text; it NEVER throws back into a
  /// capture path.
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

  /// Photo-path slice: [-2.0 s, +0.5 s] around the shutter, written next to
  /// the other evidence sinks (sensors-<captureId>.jsonl). Always calls
  /// completion exactly once, on sessionQueue: synchronously when the sink
  /// is off/unavailable (a disabled sink adds zero capture latency), after
  /// a 0.55 s post-shutter drain when it is live so the +0.5 s tail lands
  /// in the ring before slicing.
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
    // Shutter anchor: the primary frame's PTS is mach-clock-derived — the
    // SAME clock CMLogItem.timestamp rides, so the window needs no clock
    // conversion. The now fallback (invalid PTS) is stated honestly in
    // the file's window line via requestedStart/requestedEnd.
    let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(pair.primary))
    let shutterSec = pts.isFinite ? pts : ExhibitMachClock.ticksToBootSeconds(ExhibitMachClock.nowTicks())
    let windowStart = shutterSec - 2.0
    let windowEnd = shutterSec + 0.5
    let url = evidenceDirURL.appendingPathComponent("sensors-\(captureId).jsonl")
    let id = sessionId
    sessionQueue.asyncAfter(deadline: .now() + 0.55) { [weak self] in
      guard let self = self else { return } // module gone: the 10 s capture watchdog owns the promise
      guard self.sessionId == id else {
        // Session rebuilt mid-drain: nothing honest to slice — stated.
        completion(self.sensorLogFields(state: "unavailable"))
        return
      }
      completion(self.sensorWindowFields(
        url: url,
        from: windowStart,
        to: windowEnd,
        anchorStartedAtMs: capturedAtMs,
        // The anchor binds the SHUTTER's instant (the primary frame's PTS)
        // to the shutter's wall clock: not the flush instant.
        anchorBootSec: shutterSec,
        logger: logger
      ))
    }
  }

  /// Everything the pair commit needs out of sessionQueue-confined state,
  /// snapshotted up front so the encode + write phase can run on sinkIOQueue
  /// WITHOUT touching module state. Device/connection REFERENCES ride along
  /// (strong, memory-safe); their property reads in phase 2 are pure atomic
  /// getters — the same reads, just off the frame queue.
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
    // the drop SPLIT at the commit instant — total alone cannot
    // distinguish a primary-side flood (session-wide pressure) from a
    // secondary-half flood (the dual-capture path itself). Field report
    // 8/13 needed exactly this resolution.
    let droppedPrimaryCount: Int
    let droppedSecondaryHalfCount: Int
    // the absent/dropped/complete split at the commit instant.
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
    // M1/C6: the connection-REPORTED stabilization mode actually in force
    // (activeVideoStabilizationMode) — the *Stab fields above are the
    // PREFERRED mode. nil where the connection lacks stabilization.
    let primaryStabActive: String?
    let secondaryStabActive: String?
    let primaryHDR: Bool?
    let secondaryHDR: Bool?
    let configuredFPS: Double
    // W2.2/W2.4: the strobe preference + the output's supported modes,
    // snapshotted so the settings block is built from one instant.
    let photoFlashPreference: ExhibitPhotoFlash
    let flashSupportedModes: [String]
    /// The primary connection's ACTUAL mirroring state at the commit
    /// instant (RotationPolicy sets it explicitly — front mirrors, back
    /// doesn't). Committed as frontMirrored; nil only when no connection
    /// existed to read.
    let primaryConnectionMirrored: Bool?
  }

  /// Commits the pair artifacts in two phases ( Drop 2):
  ///   1. sessionQueue: snapshot all module state (cheap dictionary/scalar
  ///      assembly — NO encodes, NO file I/O).
  ///   2. sinkIOQueue: the two JPEG encodes (full-res delivery + quality-
  ///      stepped downsample) and every file write. A 1440p CIContext encode
  ///      plus up to four downsample attempts plus five writes can exceed
  ///      several frame intervals; run on sessionQueue (the synchronizer's
  ///      delivery queue) that stalls collection delivery and drops pairs —
  ///      the lesson sinkIOQueue was created for. The retained pair
  ///      keeps its sample buffers alive across the hop (the same pattern
  ///      the periodic-pair path already uses).
  /// Delivery failures reject via.failure; every evidence artifact degrades
  /// to a stated EvidencePath. Completion fires on sessionQueue.
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

    // Sync timestamps JSON: host-clock PTS pair + wall anchor + delta.
    //    The delta is the sync claim (~one frame period @ 30 fps); what it
    //    means is the desk's problem (spec §4.2).
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
    // REVIEW-CHECK (EAS build fix): connection.isVideoHDREnabled is marked
    // unavailable in recent SDKs (direct access failed this build). Read
    // through the responds(to:)+KVC helper — compiles on any SDK, nil
    // (stated unknown) where the feature is absent. Next build should
    // confirm this compiles.
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
      // 'available' | 'degraded-thermal' | 'unsupported' — degraded is a
      // stated mid-session event, unsupported is unreached-never-red (§7).
      stereoStateString: stereoActive ? "available" : (stereoDetachedForThermal ? "degraded-thermal" : "unsupported"),
      droppedPairCount: droppedPairCount,
      droppedPrimaryCount: droppedPrimaryCount,
      droppedSecondaryHalfCount: droppedSecondaryHalfCount,
      secondaryAbsentCount: secondaryAbsentCount,
      secondaryDroppedCount: secondaryDroppedCount,
      completePairCount: completePairCount,
      hardwareCost: Double(session?.hardwareCost ?? -1),
      hardwareCostPayload: session.map { Double($0.hardwareCost) } as Any? ?? NSNull(),
      // REVIEW-CHECK (EAS build fix): mixed String/NSNull values made the
      // literal type ambiguous to the compiler — the explicit
      // [String: Any] annotation resolves it. Next build should confirm.
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

  /// Phase 2 of the pair commit (sinkIOQueue ONLY — never sessionQueue).
  /// Identical artifacts, payload, and error strings to the pre
  /// synchronous commit; only the queue changed.
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

    // 1. Primary frame — full session resolution JPEG (the delivery still).
    guard let primaryBuffer = CMSampleBufferGetImageBuffer(pair.primary),
          let primaryJPEG = jpegData(from: primaryBuffer, quality: 0.9) else {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Primary frame could not be encoded"))
    }
    do {
      // `try?`: on a fresh delivery path the remove throws "no such file" —
      // and it did, failing EVERY still capture on TestFlight while
      // video worked (its writer path already used `try?`).
      try? FileManager.default.removeItem(at: deliveryURL)
      try primaryJPEG.write(to: deliveryURL, options: .atomic)
    } catch {
      return .failure(ExhibitCameraNamedException(ExhibitCameraErrorCode.platform, "Cannot write delivery still: \(error.localizedDescription)"))
    }

    // 2. Secondary frame — portrait-bounded ≤640×480 JPEG targeting
    // ~200 KB (spec §4.2: geometry input, not evidence for the eye; actual
    // bytes committed). Physically-upright in — physically-upright out.
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

    // 3. Calibration JSON (~2 KB): per-frame intrinsics + session-photo
    // full calibration, each with its source labeled (spec §4.2). The dict
    // was assembled in phase 1; only the write lands here.
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

    // 5. Metadata block (spec §5/§14 — commit inputs, never computed
    // answers). Pro-control values are read back from the device and the
    // connections, never from the module's request log. Device objects ride
    // the snapshot; these are pure reads.
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
    // diagnostics split (additive): WHERE the secondary half dies —
    // absent (no data object from the synchronizer) vs dropped (data
    // object marked dropped) vs complete pairs retained.
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

    // W2.4: the full committed camera-settings block — every value a
    // device read-back from this commit instant (flash/photo-EXIF facts
    // merge in later from the full-res photo's own metadata). Explicit
    // nulls state absence; nothing is synthesized. An absent primary
    // device (cannot happen with a running session) states itself.
    // Broken out of the payload literal: the inline map-closure + ?? +
    // `as [String: Any]` chain was a type-check-timeout risk (EAS 27).
    var captureSettingsBlock: [String: Any]
    if let commitDevice = snap.primaryDevice {
      captureSettingsBlock = CaptureSettingsBuilder.dictionary(
        for: commitDevice,
        photoFlash: snap.photoFlashPreference,
        flashSupportedModes: snap.flashSupportedModes,
        activeStabilizationMode: snap.primaryStabActive
      )
      // Artifact-first (M1/C6): the color profile name is read out of the
      // DELIVERED JPEG's own bytes (ImageIO) — the artifact speaks for
      // itself. The fallback is the encoder-fixed pipeline fact (jpegData
      // renders into CGColorSpace.sRGB whatever the source buffer's space),
      // stated as such — never a silent assumption.
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
      // sealed projection inputs (see the degraded path's note) —
      // from the snapshotted primary device, the commit-instant truth.
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
      // diagnostics (additive): the live connection census at the
      // moment of commit — every capture carries its own graph truth.
      "connections": connectionCensus(),
    ]
    // Per-capture stereo evidence state: 'ok' only when a
    // synchronized secondary frame was actually committed; on a stereo
    // session whose secondary half dropped at shutter, 'unavailable' with
    // the reason stated — the capture succeeds (the primary still is real)
    // but nothing stereo is implied. Absent on single-cam sessions, where
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
    // Per-frame intrinsics are extracted HERE (commit time), not in the
    // delivery callback: the attachment rides the retained sample buffer,
    // so the read is identical — just off the frame-rate hot path.
    let primaryIntrinsics = frameIntrinsics(from: pair.primary)
    let secondaryIntrinsics = pair.secondary.flatMap { frameIntrinsics(from: $0) }
    return [
      // Per-frame intrinsics: real per-frame data from the documented
      // attachment path. null when the attachment was absent.
      "primaryIntrinsicsRowMajor": primaryIntrinsics as Any? ?? NSNull(),
      "secondaryIntrinsicsRowMajor": secondaryIntrinsics as Any? ?? NSNull(),
      // Full calibration (extrinsics, distortion LUTs): from the session
      // one-shot photo capture (device-fixed properties), or null.
      "primaryFull": sessionCalibration[primaryLabel] as Any? ?? NSNull(),
      "secondaryFull": sessionCalibration[secondaryLabel] as Any? ?? NSNull(),
      // Source labels let the desk distinguish per-frame from session-fixed
      // and full from intrinsics-only. Partial ≠ fabricated.
      "calibrationSource": [
        "intrinsics": primaryIntrinsics != nil ? "frame-attachments" : "unavailable",
        "full": sessionCalibration.isEmpty ? "unavailable" : "session-photo-capture",
      ],
    ]
  }

  // MARK: - Encoding helpers (sinkIOQueue — never the frame delivery queue)

  /// BGRA/420 pixel buffer → JPEG. ORIENTATION: the data connection
  /// PHYSICALLY rotates delivered buffers by its videoRotationAngle (the
  /// RotationPolicy coordinator angle — see configureSession's orientation
  /// contract), so the bytes arrive ALREADY upright. Baking a second 90° here (.oriented(.right)) double-
  /// rotated every committed still and stereo secondary — the sideways-
  /// media bug. Encode exactly as delivered: jpegRepresentation bakes the
  /// CIImage's orientation into the pixels, so the written JPEG is upright
  /// with orientation 1 — no EXIF tag needed, no viewer discretion.
  /// Front cameras additionally mirror — committed implicitly by
  /// physicalDevice in metadata (mirroring policy unchanged by this fix).
  private func jpegData(from pixelBuffer: CVPixelBuffer, quality: CGFloat) -> Data? {
    let delivered = CIImage(cvPixelBuffer: pixelBuffer)
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    // REVIEW-CHECK (EAS): CIImageRepresentationOption wraps the
    // CGImageDestination key by raw value; if the SDK exposes a named
    // static (e.g..lossyCompressionQuality) prefer it.
    guard let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String) as CIImageRepresentationOption? else { return nil }
    return ciContext.jpegRepresentation(
      of: delivered,
      colorSpace: colorSpace,
      options: [qualityKey: quality]
    )
  }

  /// ≤640×480 downsample (portrait-bounded: the connection delivers
  /// physically-upright portrait buffers — see jpegData's orientation
  /// contract), quality stepped down until ≤ targetBytes or the 0.5 floor
  /// (spec §4.2: the target is a target; actual bytes committed).
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

  /// field adjudication (Noah: "I am 10000% certain you are not
  /// getting serial burst photography… literally pixel for pixel"): every
  /// committed ring frame now carries its own 8×8 luma difference hash —
  /// 64 bits, computed from the SAME pixel buffer the committed JPEG
  /// encodes, so distinctness is stated from committed data (N frames,
  /// M unique hashes) instead of argued about. The hash is a fact ABOUT
  /// the frame, never a verdict on it.
  private func dHash64(from pixelBuffer: CVPixelBuffer) -> String? {
    let source = CIImage(cvPixelBuffer: pixelBuffer)
    let extent = source.extent
    guard extent.width > 0, extent.height > 0 else { return nil }
    // 9×8 luma grid (aspect-stretched, the classic dHash geometry): 8 rows
    // × 8 horizontal neighbor comparisons = 64 bits.
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
  /// only — ProRAW is computationally processed by the platform and is NOT
  /// this path (spec §9). Completion hops back on sessionQueue.
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
      flashNote: "video-stream-derived still (0.18.5: no secondary photo output by design): stream-resolution UW frame from the synchronized pair — no strobe, no OS EXIF, no depth (stated, not faked)",
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
