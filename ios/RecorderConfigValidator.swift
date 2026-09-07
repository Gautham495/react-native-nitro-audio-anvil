import Foundation

/// Rejects configs that cannot work before any native resource is touched.
enum RecorderConfigValidator {
  static let supportedSampleRates: [Int] = [8000, 16000, 22050, 24000, 32000, 44100, 48000]

  static func validate(_ config: RecorderConfig) throws {
    guard !config.outputDirectory.isEmpty else {
      throw AnvilError(.state, "outputDirectory is required")
    }
    guard supportedSampleRates.contains(Int(config.sampleRate)) else {
      throw AnvilError(.state, "sampleRate must be one of \(supportedSampleRates)")
    }
    guard config.segmentDurationMs >= 1000 else {
      throw AnvilError(.state, "segmentDurationMs must be >= 1000")
    }
    guard config.fsyncIntervalMs >= 50 else {
      throw AnvilError(.state, "fsyncIntervalMs must be >= 50")
    }
    guard config.streamChunkMs >= 10 else {
      throw AnvilError(.state, "streamChunkMs must be >= 10")
    }
    guard config.speakerWindowMs >= 100 else {
      throw AnvilError(.state, "speakerWindowMs must be >= 100")
    }
    guard config.speakerWindowHopMs > 0, config.speakerWindowHopMs <= config.speakerWindowMs else {
      throw AnvilError(.state, "speakerWindowHopMs must be > 0 and <= speakerWindowMs")
    }
    guard config.storageWarningBytes >= 0 else {
      throw AnvilError(.state, "storageWarningBytes must be >= 0")
    }
  }
}
