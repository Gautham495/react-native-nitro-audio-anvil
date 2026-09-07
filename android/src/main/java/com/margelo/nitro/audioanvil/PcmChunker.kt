package com.margelo.nitro.audioanvil

import com.margelo.nitro.core.ArrayBuffer

/** Batches PCM into fixed-size chunks for the streaming listener. Sequence numbers span the whole session. */
internal class PcmChunker(
  private val sampleRate: Int,
  chunkMs: Double,
  private val onChunk: (PCMChunk) -> Unit,
) {
  private val chunkBytes = maxOf(2, ((sampleRate * 2) * chunkMs / 1000.0).toInt() and 1.inv())
  private var pending = ByteArray(chunkBytes * 4)
  private var pendingLength = 0
  private var pendingStartSamples = 0L
  private var sequence = 0L

  /** `mediaSamples` is the timeline position of the first sample in `bytes`. */
  fun append(bytes: ByteArray, count: Int, mediaSamples: Long) {
    if (pendingLength == 0) {
      pendingStartSamples = mediaSamples
    }
    if (pendingLength + count > pending.size) {
      pending = pending.copyOf(maxOf(pending.size * 2, pendingLength + count))
    }
    System.arraycopy(bytes, 0, pending, pendingLength, count)
    pendingLength += count
    var offset = 0
    while (pendingLength - offset >= chunkBytes) {
      emit(pending, offset, chunkBytes)
      offset += chunkBytes
      pendingStartSamples += chunkBytes / 2
    }
    if (offset > 0) {
      System.arraycopy(pending, offset, pending, 0, pendingLength - offset)
      pendingLength -= offset
    }
  }

  /** Emits whatever is pending. Called on pause, interruption and stop so no audio is withheld. */
  fun flush() {
    if (pendingLength == 0) return
    emit(pending, 0, pendingLength)
    pendingLength = 0
  }

  private fun emit(source: ByteArray, offset: Int, length: Int) {
    val buffer = ArrayBuffer.allocate(length)
    buffer.getBuffer(false).put(source, offset, length)
    val chunk = PCMChunk(
      buffer = buffer,
      timestampMs = pendingStartSamples / sampleRate.toDouble() * 1000.0,
      durationMs = (length / 2) / sampleRate.toDouble() * 1000.0,
      sequenceNumber = sequence.toDouble(),
    )
    sequence++
    onChunk(chunk)
  }
}
