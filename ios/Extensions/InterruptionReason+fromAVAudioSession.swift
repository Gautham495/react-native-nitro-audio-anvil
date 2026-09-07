import AVFoundation

extension InterruptionReason {
  /// Maps Apple's interruption reason to the Nitro enum. `call` is decided separately via CallKit.
  @available(iOS 14.5, *)
  static func from(_ reason: AVAudioSession.InterruptionReason) -> InterruptionReason {
    if reason == .builtInMicMuted {
      return .muted
    }
    if #available(iOS 17.0, *), reason == .routeDisconnected {
      return .route
    }
    return .other
  }
}
