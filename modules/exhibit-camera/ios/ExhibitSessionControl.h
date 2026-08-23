#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * NSException-safe wrappers around the AVCaptureSession calls that can throw.
 *
 * Swift cannot catch an ObjC exception, so the @try/@catch lives here. Each
 * wrapper returns nil on success and the caught exception as an NSError
 * otherwise, which the Swift side turns into a rejected promise or an
 * onSessionError event rather than a crash.
 *
 * Callers must be on the module's serial sessionQueue, and must not be
 * inside an open beginConfiguration block.
 */
@interface ExhibitSessionControl : NSObject

/// Starts the session if it is not already running. Idempotent.
/// NS_SWIFT_NAME pins the imported name so an SDK change cannot rename it.
+ (nullable NSError *)safelyStartSession:(AVCaptureSession *)session NS_SWIFT_NAME(safelyStart(_:));

/// Stops the session if it is running. Idempotent.
+ (nullable NSError *)safelyStopSession:(AVCaptureSession *)session NS_SWIFT_NAME(safelyStop(_:));

/// Fires capturePhotoWithSettings:delegate: inside @try/@catch. Settings
/// validation against a running multi-cam graph can throw.
+ (nullable NSError *)safelyCapturePhotoWithOutput:(AVCapturePhotoOutput *)output
                                          settings:(AVCapturePhotoSettings *)settings
                                          delegate:(id<AVCapturePhotoCaptureDelegate>)delegate
    NS_SWIFT_NAME(safelyCapturePhoto(output:settings:delegate:));

/// Removes a connection from the session inside @try/@catch. removeConnection:
/// raises when the session no longer holds the connection, which Swift cannot
/// catch. The Swift side clears its own reference either way.
+ (nullable NSError *)safelyRemoveConnectionFromSession:(AVCaptureSession *)session
                                             connection:(AVCaptureConnection *)connection
    NS_SWIFT_NAME(safelyRemoveConnection(_:connection:));

@end

NS_ASSUME_NONNULL_END
