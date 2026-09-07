import AVFoundation

extension AVAudioSession {
  /// Current microphone permission mapped to the Nitro enum.
  var anvilPermissionStatus: AnvilPermissionStatus {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: return .granted
      case .denied: return .denied
      default: return .undetermined
      }
    }
    switch recordPermission {
    case .granted: return .granted
    case .denied: return .denied
    default: return .undetermined
    }
  }

  /// Prompts if undetermined and returns the resulting status.
  static func anvilRequestPermission() async -> AnvilPermissionStatus {
    if #available(iOS 17.0, *) {
      let granted = await AVAudioApplication.requestRecordPermission()
      return granted ? .granted : .denied
    }
    return await withCheckedContinuation { continuation in
      sharedInstance().requestRecordPermission { granted in
        continuation.resume(returning: granted ? .granted : .denied)
      }
    }
  }
}
