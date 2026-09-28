package com.margelo.nitro.audioanvil

/** Rejects configs that cannot work before any native resource is touched. */
internal object RecorderConfigValidator {
  private val supportedSampleRates = listOf(8000, 16000, 22050, 24000, 32000, 44100, 48000)
  private val badRecordingIdChars = charArrayOf('/', '\\', 0.toChar())

  /**
   * AAC-LC has per-channel bitrate ceilings that scale with sample rate. Exceeding these
   * causes the MediaCodec encoder to refuse configuration on some devices. We check
   * up-front so bad configs surface as clean rejections at `createRecorder` time.
   */
  private val maxBitrateForSampleRate = mapOf(
    8000 to 24000,
    16000 to 48000,
    22050 to 64000,
    24000 to 72000,
    32000 to 96000,
    44100 to 192000,
    48000 to 192000,
  )

  fun validate(config: RecorderConfig) {
    fail(config.outputDirectory.isEmpty(), "outputDirectory is required")
    fail(config.recordingId.isEmpty(), "recordingId is required")
    fail(
      config.recordingId.any { it in badRecordingIdChars } ||
        config.recordingId == "." ||
        config.recordingId == "..",
      "recordingId must be a single path component (no slashes, no .., no NUL)"
    )
    fail(config.sampleRate.toInt() !in supportedSampleRates, "sampleRate must be one of $supportedSampleRates")
    fail(
      config.aacBitrate.toInt() < 16000 || config.aacBitrate.toInt() > 320000,
      "aacBitrate must be between 16000 and 320000"
    )
    val cap = maxBitrateForSampleRate[config.sampleRate.toInt()]
    if (cap != null && config.aacBitrate.toInt() > cap) {
      throw AnvilException(
        RecorderErrorCode.STATE,
        "aacBitrate ${config.aacBitrate.toInt()} exceeds AAC-LC ceiling of $cap at ${config.sampleRate.toInt()} Hz mono"
      )
    }
    fail(config.segmentDurationMs < 1000, "segmentDurationMs must be >= 1000")
    fail(config.fsyncIntervalMs < 50, "fsyncIntervalMs must be >= 50")
    fail(config.segmentDurationMs < config.fsyncIntervalMs, "segmentDurationMs must be >= fsyncIntervalMs")
    fail(config.streamChunkMs < 10, "streamChunkMs must be >= 10")
    fail(config.speakerWindowMs < 100, "speakerWindowMs must be >= 100")
    fail(
      config.speakerWindowHopMs <= 0 || config.speakerWindowHopMs > config.speakerWindowMs,
      "speakerWindowHopMs must be > 0 and <= speakerWindowMs"
    )
    fail(config.storageWarningBytes < 0, "storageWarningBytes must be >= 0")
    fail(
      config.keepAwakeInBackground && config.notification == null,
      "notification is required on Android when keepAwakeInBackground is true"
    )
  }

  private fun fail(condition: Boolean, message: String) {
    if (condition) throw AnvilException(RecorderErrorCode.STATE, message)
  }
}