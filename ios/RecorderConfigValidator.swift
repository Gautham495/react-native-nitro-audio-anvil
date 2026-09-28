import Foundation

/// Rejects configs that cannot work before any native resource is touched.
enum RecorderConfigValidator {
  static let supportedSampleRates: [Int] = [8000, 16000, 22050, 24000, 32000, 44100, 48000]

  /// AAC-LC has per-channel bitrate ceilings that scale with sample rate. Exceeding these
  /// causes `AudioCodecInitialize` to fail on device with a useless C++ error dumped to
  /// the console. We check up-front so bad configs surface as clean rejections at
  /// `createRecorder` time, not as opaque native failures partway through recording.
  static let maxBitrateForSampleRate: [Int: Int] = [
    8000: 24000,
    16000: 48000,
    22050: 64000,
    24000: 72000,
    32000: 96000,
    44100: 192000,
    48000: 192000,
  ]

  static func validate(_ config: RecorderConfig) throws {
    guard !config.outputDirectory.isEmpty else {
      throw AnvilError(.state, "outputDirectory is required")
    }
    guard !config.recordingId.isEmpty else {
      throw AnvilError(.state, "recordingId is required")
    }
    guard !config.recordingId.contains("/"),
          !config.recordingId.contains("\\"),
          config.recordingId != ".",
          config.recordingId != "..",
          !config.recordingId.contains("\0") else {
      throw AnvilError(.state, "recordingId must be a single path component (no slashes, no .., no NUL)")
    }
    guard supportedSampleRates.contains(Int(config.sampleRate)) else {
      throw AnvilError(.state, "sampleRate must be one of \(supportedSampleRates)")
    }
    guard config.aacBitrate >= 16000, config.aacBitrate <= 320000 else {
      throw AnvilError(.state, "aacBitrate must be between 16000 and 320000")
    }
    if let cap = maxBitrateForSampleRate[Int(config.sampleRate)],
       Int(config.aacBitrate) > cap {
      throw AnvilError(
        .state,
        "aacBitrate \(Int(config.aacBitrate)) exceeds AAC-LC ceiling of \(cap) at \(Int(config.sampleRate)) Hz mono"
      )
    }
    guard config.segmentDurationMs >= 1000 else {
      throw AnvilError(.state, "segmentDurationMs must be >= 1000")
    }
    guard config.fsyncIntervalMs >= 50 else {
      throw AnvilError(.state, "fsyncIntervalMs must be >= 50")
    }
    guard config.segmentDurationMs >= config.fsyncIntervalMs else {
      throw AnvilError(.state, "segmentDurationMs must be >= fsyncIntervalMs")
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