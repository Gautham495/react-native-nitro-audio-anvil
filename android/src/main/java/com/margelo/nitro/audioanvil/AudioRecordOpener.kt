package com.margelo.nitro.audioanvil

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder

/** Opens AudioRecord at the preferred rate, falling back to rates the device does support. */
internal object AudioRecordOpener {
  private val fallbackRates = intArrayOf(48000, 44100, 32000, 22050, 16000, 8000)

  @SuppressLint("MissingPermission")
  fun open(preferredRate: Int, readMs: Int): OpenedAudioRecord {
    val candidates = listOf(preferredRate) + fallbackRates.filter { it != preferredRate }
    var lastError = "no supported sample rate"
    for (rate in candidates) {
      val minBuffer = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
      if (minBuffer <= 0) {
        lastError = "getMinBufferSize($rate) = $minBuffer"
        continue
      }
      val readBytes = rate * readMs / 1000 * 2
      val record = try {
        AudioRecord(
          MediaRecorder.AudioSource.VOICE_RECOGNITION,
          rate,
          AudioFormat.CHANNEL_IN_MONO,
          AudioFormat.ENCODING_PCM_16BIT,
          maxOf(minBuffer, readBytes * 4),
        )
      } catch (e: IllegalArgumentException) {
        lastError = e.message ?: "AudioRecord init failed at $rate Hz"
        continue
      }
      if (record.state == AudioRecord.STATE_INITIALIZED) {
        return OpenedAudioRecord(record, rate)
      }
      record.release()
      lastError = "AudioRecord not initialized at $rate Hz"
    }
    throw AnvilException(RecorderErrorCode.ENGINE, "Could not open the microphone ($lastError)")
  }
}
