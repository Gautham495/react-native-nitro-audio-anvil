package com.margelo.nitro.audioanvil

/** Rejects configs that cannot work before any native resource is touched. */
internal object RecorderConfigValidator {
  private val supportedSampleRates = listOf(8000, 16000, 22050, 24000, 32000, 44100, 48000)

  fun validate(config: RecorderConfig) {
    fail(config.outputDirectory.isEmpty(), "outputDirectory is required")
    fail(config.sampleRate.toInt() !in supportedSampleRates, "sampleRate must be one of $supportedSampleRates")
    fail(config.segmentDurationMs < 1000, "segmentDurationMs must be >= 1000")
    fail(config.fsyncIntervalMs < 50, "fsyncIntervalMs must be >= 50")
    fail(config.streamChunkMs < 10, "streamChunkMs must be >= 10")
    fail(config.speakerWindowMs < 100, "speakerWindowMs must be >= 100")
    fail(config.speakerWindowHopMs <= 0 || config.speakerWindowHopMs > config.speakerWindowMs, "speakerWindowHopMs must be > 0 and <= speakerWindowMs")
    fail(config.storageWarningBytes < 0, "storageWarningBytes must be >= 0")
    fail(config.keepAwakeInBackground && config.notification == null, "notification is required on Android when keepAwakeInBackground is true")
  }

  private fun fail(condition: Boolean, message: String) {
    if (condition) throw AnvilException(RecorderErrorCode.STATE, message)
  }
}
