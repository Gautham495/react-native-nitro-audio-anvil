package com.margelo.nitro.audioanvil

import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** Builds, reads and patches the 44-byte canonical PCM WAV header (mono, 16-bit). */
internal object WavHeader {
  const val BYTE_COUNT = 44
  const val RIFF_SIZE_OFFSET = 4L
  const val DATA_SIZE_OFFSET = 40L

  fun bytes(sampleRate: Int, dataBytes: Int): ByteArray {
    val buffer = ByteBuffer.allocate(BYTE_COUNT).order(ByteOrder.LITTLE_ENDIAN)
    buffer.put("RIFF".toByteArray(Charsets.US_ASCII))
    buffer.putInt(36 + dataBytes)
    buffer.put("WAVE".toByteArray(Charsets.US_ASCII))
    buffer.put("fmt ".toByteArray(Charsets.US_ASCII))
    buffer.putInt(16)
    buffer.putShort(1)
    buffer.putShort(1)
    buffer.putInt(sampleRate)
    buffer.putInt(sampleRate * 2)
    buffer.putShort(2)
    buffer.putShort(16)
    buffer.put("data".toByteArray(Charsets.US_ASCII))
    buffer.putInt(dataBytes)
    return buffer.array()
  }

  /** Rewrites the two size fields so the header matches `dataBytes` of audio. */
  fun patch(file: RandomAccessFile, dataBytes: Int) {
    file.seek(RIFF_SIZE_OFFSET)
    file.writeInt(Integer.reverseBytes(36 + dataBytes))
    file.seek(DATA_SIZE_OFFSET)
    file.writeInt(Integer.reverseBytes(dataBytes))
  }

  /** Returns (sampleRate, declaredDataBytes), or null when the file is not a RIFF/WAVE file. */
  fun read(file: File): Pair<Int, Int>? {
    if (file.length() < BYTE_COUNT) return null
    RandomAccessFile(file, "r").use { input ->
      val header = ByteArray(BYTE_COUNT)
      input.readFully(header)
      val riff = String(header, 0, 4, Charsets.US_ASCII)
      val wave = String(header, 8, 4, Charsets.US_ASCII)
      if (riff != "RIFF" || wave != "WAVE") return null
      val buffer = ByteBuffer.wrap(header).order(ByteOrder.LITTLE_ENDIAN)
      return Pair(buffer.getInt(24), buffer.getInt(40))
    }
  }
}
