package com.margelo.nitro.audioanvil

import android.media.AudioManager
import android.media.AudioRecord
import android.os.Handler

/**
 * Reads the microphone in fixed steps on the recorder's HandlerThread. Each read re-posts itself,
 * so control messages (pause/stop/rotate) interleave with capture without locks.
 */
internal class AnvilCaptureLoop(
  private val handler: Handler,
  private val targetSampleRate: Int,
  private val readMs: Int,
  private val onPcm: (ShortArray, Int) -> Unit,
  private val onError: (AnvilException) -> Unit,
) {
  private var record: AudioRecord? = null
  private var resampler: PcmResampler? = null
  private var readBuffer = ShortArray(0)
  private var running = false

  val audioSessionId: Int
    get() = record?.audioSessionId ?: AudioManager.AUDIO_SESSION_ID_GENERATE

  val isRunning: Boolean
    get() = running

  private val step = object : Runnable {
    override fun run() {
      if (!running) return
      val current = record ?: return
      val read = current.read(readBuffer, 0, readBuffer.size, AudioRecord.READ_BLOCKING)
      if (read < 0) {
        running = false
        onError(AnvilException(RecorderErrorCode.ENGINE, "AudioRecord.read failed with $read"))
        return
      }
      if (read > 0) {
        val converter = resampler
        if (converter == null) {
          onPcm(readBuffer, read)
        } else {
          val converted = converter.resample(readBuffer, read)
          onPcm(converted, converted.size)
        }
      }
      if (running) handler.post(this)
    }
  }

  fun start() {
    val opened = AudioRecordOpener.open(targetSampleRate, readMs)
    record = opened.record
    resampler = if (opened.sampleRate == targetSampleRate) null else PcmResampler(opened.sampleRate, targetSampleRate)
    readBuffer = ShortArray(maxOf(1, opened.sampleRate * readMs / 1000))
    opened.record.startRecording()
    if (opened.record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
      stop()
      throw AnvilException(RecorderErrorCode.ENGINE, "AudioRecord did not start recording")
    }
    running = true
    handler.post(step)
  }

  fun stop() {
    running = false
    val current = record ?: return
    try {
      current.stop()
    } catch (_: IllegalStateException) {
    }
    current.release()
    record = null
    resampler = null
  }
}
