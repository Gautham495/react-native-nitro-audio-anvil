package com.margelo.nitro.audioanvil

import com.margelo.nitro.core.ArrayBuffer
import kotlin.math.sqrt

/** Assembles overlapping fixed-length windows from the PCM stream for speaker embedding. */
internal class SpeakerWindowAssembler(
  private val sampleRate: Int,
  windowMs: Double,
  hopMs: Double,
  private val onWindow: (SpeakerWindow) -> Unit,
) {
  private val windowSamples = maxOf(1, (sampleRate * windowMs / 1000.0).toInt())
  private val hopSamples = maxOf(1, (sampleRate * hopMs / 1000.0).toInt())
  private val ring = ShortArray(windowSamples)
  private var filled = 0
  private var writeIndex = 0
  private var samplesSinceEmit = 0
  private var endSamples = 0L
  private var primed = false

  /** `mediaSamples` is the timeline position of the first sample in `samples`. */
  fun append(samples: ShortArray, count: Int, mediaSamples: Long) {
    if (filled == 0) {
      endSamples = mediaSamples
    }
    for (i in 0 until count) {
      ring[writeIndex] = samples[i]
      writeIndex = (writeIndex + 1) % windowSamples
      if (filled < windowSamples) filled++
    }
    endSamples += count
    samplesSinceEmit += count
    if (filled < windowSamples) return
    if (!primed || samplesSinceEmit >= hopSamples) {
      primed = true
      samplesSinceEmit = 0
      emit()
    }
  }

  /** Drops buffered audio so a window never spans a pause or interruption. */
  fun reset() {
    filled = 0
    writeIndex = 0
    samplesSinceEmit = 0
    primed = false
  }

  private fun emit() {
    val bytes = ByteArray(windowSamples * 2)
    var sumSquares = 0.0
    for (i in 0 until windowSamples) {
      val sample = ring[(writeIndex + i) % windowSamples]
      val value = sample.toDouble()
      sumSquares += value * value
      bytes[i * 2] = (sample.toInt() and 0xFF).toByte()
      bytes[i * 2 + 1] = ((sample.toInt() shr 8) and 0xFF).toByte()
    }
    val rms = sqrt(sumSquares / windowSamples) / 32768.0
    val buffer = ArrayBuffer.allocate(bytes.size)
    buffer.getBuffer(false).put(bytes)
    val startSamples = endSamples - windowSamples
    onWindow(
      SpeakerWindow(
        buffer = buffer,
        startMs = startSamples / sampleRate.toDouble() * 1000.0,
        endMs = endSamples / sampleRate.toDouble() * 1000.0,
        rms = rms,
      )
    )
  }
}
