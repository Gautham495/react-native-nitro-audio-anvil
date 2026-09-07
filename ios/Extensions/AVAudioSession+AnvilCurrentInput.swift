import AVFoundation

extension AVAudioSession {
  /// Stable identifier of the active input port, or `""` when there is none.
  var anvilCurrentInputUID: String {
    currentRoute.inputs.first?.uid ?? ""
  }

  /// Human-readable name of the active input port, or `""` when there is none.
  var anvilCurrentInputName: String {
    currentRoute.inputs.first?.portName ?? ""
  }
}
