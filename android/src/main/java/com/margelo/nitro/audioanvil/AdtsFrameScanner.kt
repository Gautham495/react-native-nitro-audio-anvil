package com.margelo.nitro.audioanvil

import java.io.File
import java.io.RandomAccessFile

/**
 * Reads an ADTS AAC file's frame headers to measure its duration and detect corruption.
 * Used by the folder scanner to salvage unreferenced tail segments left behind by a
 * crash.
 */
internal object AdtsFrameScanner {
  data class Scan(
    /** Sample rate parsed from the first frame's ADTS header. */
    val sampleRate: Int,
    /** Total decoded audio duration in milliseconds (1024 samples per frame). */
    val durationMs: Double,
    /**
     * Byte offset at which frames stopped parsing cleanly. On a torn tail this is short
     * of the file size — everything up to it is playable, everything after is garbage.
     */
    val validByteCount: Int,
  )

  private val samplingFrequencyTable = mapOf(
    0 to 96000, 1 to 88200, 2 to 64000, 3 to 48000, 4 to 44100, 5 to 32000,
    6 to 24000, 7 to 22050, 8 to 16000, 9 to 12000, 10 to 11025, 11 to 8000,
  )

  fun scan(file: File): Scan? {
    if (file.length() < 7) return null
    RandomAccessFile(file, "r").use { input ->
      val data = ByteArray(file.length().toInt())
      input.readFully(data)
      return scan(data)
    }
  }

  internal fun scan(data: ByteArray): Scan? {
    var offset = 0
    var sampleRate = 0
    var frameCount = 0

    while (offset + 7 <= data.size) {
      val b0 = data[offset].toInt() and 0xFF
      val b1 = data[offset + 1].toInt() and 0xFF
      if (b0 != 0xFF || (b1 and 0xF0) != 0xF0) break

      val length = frameLength(data, offset)
      if (length < 7 || offset + length > data.size) break

      if (sampleRate == 0) {
        val b2 = data[offset + 2].toInt() and 0xFF
        val sfi = (b2 and 0x3C) shr 2
        sampleRate = samplingFrequencyTable[sfi] ?: return null
      }
      frameCount++
      offset += length
    }

    if (frameCount == 0 || sampleRate == 0) return null
    val durationMs = frameCount * 1024.0 / sampleRate * 1000.0
    return Scan(sampleRate = sampleRate, durationMs = durationMs, validByteCount = offset)
  }

  private fun frameLength(data: ByteArray, offset: Int): Int {
    val b3 = data[offset + 3].toInt() and 0xFF
    val b4 = data[offset + 4].toInt() and 0xFF
    val b5 = data[offset + 5].toInt() and 0xFF
    return ((b3 and 0x03) shl 11) or (b4 shl 3) or ((b5 and 0xE0) shr 5)
  }
}
