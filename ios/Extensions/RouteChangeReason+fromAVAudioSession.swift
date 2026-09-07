import AVFoundation

extension RouteChangeReason {
  /// Maps Apple's route change reason to the Nitro enum.
  static func from(_ reason: AVAudioSession.RouteChangeReason?) -> RouteChangeReason {
    switch reason {
    case .newDeviceAvailable: return .connected
    case .oldDeviceUnavailable: return .disconnected
    case .categoryChange: return .category
    case .override: return .forced
    case .wakeFromSleep: return .wake
    default: return .unknown
    }
  }
}
