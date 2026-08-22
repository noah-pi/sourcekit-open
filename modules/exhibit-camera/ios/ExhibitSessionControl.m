// UNBUILT — rides EAS build 2; validated by on-device soak checklist, not CI.
#import "ExhibitSessionControl.h"

/// The exception name + reason are committed verbatim into the NSError so
/// the eventual rejection/event text says EXACTLY what the OS threw —
/// stated, never guessed.
static NSError *ExhibitSessionLifecycleError(NSString *operation, NSException *exception) {
  NSString *reason = exception.reason ?: @"no reason given";
  NSString *message = [NSString stringWithFormat:
      @"AVCaptureSession %@ threw %@: %@ (session state unknown — stated, not guessed)",
      operation, exception.name, reason];
  return [NSError errorWithDomain:@"com.exhibit.camera.session-lifecycle"
                             code:1
                         userInfo:@{ NSLocalizedDescriptionKey: message }];
}

@implementation ExhibitSessionControl

+ (nullable NSError *)safelyStartSession:(AVCaptureSession *)session {
  @try {
    if (session.isRunning) {
      return nil; // never start twice in a row — a stated no-op, not an error
    }
    [session startRunning];
    return nil;
  } @catch (NSException *exception) {
    return ExhibitSessionLifecycleError(@"startRunning", exception);
  }
}

+ (nullable NSError *)safelyStopSession:(AVCaptureSession *)session {
  @try {
    if (!session.isRunning) {
      return nil; // never stop twice in a row — a stated no-op, not an error
    }
    [session stopRunning];
    return nil;
  } @catch (NSException *exception) {
    return ExhibitSessionLifecycleError(@"stopRunning", exception);
  }
}

+ (nullable NSError *)safelyCapturePhotoWithOutput:(AVCapturePhotoOutput *)output
                                          settings:(AVCapturePhotoSettings *)settings
                                          delegate:(id<AVCapturePhotoCaptureDelegate>)delegate {
  @try {
    [output capturePhotoWithSettings:settings delegate:delegate];
    return nil;
  } @catch (NSException *exception) {
    return ExhibitSessionLifecycleError(@"capturePhotoWithSettings", exception);
  }
}

@end
