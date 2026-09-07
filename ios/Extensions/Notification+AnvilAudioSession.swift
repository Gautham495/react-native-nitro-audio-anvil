import AVFoundation
import Foundation

extension Notification {
  /// `AVAudioSessionInterruptionTypeKey` decoded.
  var anvilInterruptionType: AVAudioSession.InterruptionType? {
    guard let raw = userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return nil }
    return AVAudioSession.InterruptionType(rawValue: raw)
  }

  /// `AVAudioSessionInterruptionOptionKey` contains `.shouldResume`.
  var anvilShouldResume: Bool {
    guard let raw = userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt else { return false }
    return AVAudioSession.InterruptionOptions(rawValue: raw).contains(.shouldResume)
  }

  /// `AVAudioSessionInterruptionReasonKey` mapped to the Nitro enum (`.other` when absent).
  var anvilInterruptionReason: InterruptionReason {
    guard #available(iOS 14.5, *),
          let raw = userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
          let reason = AVAudioSession.InterruptionReason(rawValue: raw) else { return .other }
    return InterruptionReason.from(reason)
  }

  /// `AVAudioSessionRouteChangeReasonKey` decoded.
  var anvilRouteChangeReason: AVAudioSession.RouteChangeReason? {
    guard let raw = userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt else { return nil }
    return AVAudioSession.RouteChangeReason(rawValue: raw)
  }
}
