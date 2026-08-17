// UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * ExhibitSessionControl — NSException-safe AVCaptureSession lifecycle
 * wrappers (0.15.0 Drop 2).
 *
 * A 0.14.2 crash log showed SIGABRT from an uncaught NSException raised
 * inside -[AVCaptureSession stopRunning] on com.exhibit.camera.session.
 * Pure Swift cannot catch NSException, so the catch lives here in ObjC:
 * every start/stop of the module's ONE session goes through these wrappers,
 * which (a) make the calls idempotent — never start a running session,
 * never stop a stopped one — and (b) convert a thrown ObjC exception into
 * an NSError the Swift side folds into a rejected promise or an
 * onSessionError event. A lifecycle exception must NEVER escape to the
 * React Native bridge as a crash.
 *
 * "Never mid-configuration" is guaranteed by the caller: every call site is
 * on the module's serial sessionQueue, and begin/commitConfiguration are
 * balanced on that same queue (audited 0.15.0 Drop 2), so no wrapper ever
 * runs inside an open configuration block.
 */
@interface ExhibitSessionControl : NSObject

/// Starts the session unless it is already running (never twice in a row).
/// Returns nil on success; the caught exception as NSError on failure.
/// NS_SWIFT_NAME pins the imported name — the importer's suffix-stripping
/// rule already renames this to safelyStart(_:) (base-name "Session"
/// matches the parameter type); the annotation makes that contract explicit
/// so a future SDK can never surprise the Swift call sites again.
+ (nullable NSError *)safelyStartSession:(AVCaptureSession *)session NS_SWIFT_NAME(safelyStart(_:));

/// Stops the session unless it is already stopped (never twice in a row).
/// Returns nil on success; the caught exception as NSError on failure.
+ (nullable NSError *)safelyStopSession:(AVCaptureSession *)session NS_SWIFT_NAME(safelyStop(_:));

@end

NS_ASSUME_NONNULL_END
