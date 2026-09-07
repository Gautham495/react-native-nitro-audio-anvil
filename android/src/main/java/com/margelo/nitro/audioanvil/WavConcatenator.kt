package com.margelo.nitro.audioanvil

import java.io.File
import java.io.RandomAccessFile

/** Streams the PCM payload of several WAV files into one WAV. Inputs must share a sample rate. */
internal object WavConcatenator {
  fun concatenate(inputs: List<File>, output: File): RecordingSegment {
    if (inputs.isEmpty()) throw AnvilException(RecorderErrorCode.STATE, "segmentPaths is empty")
    val startedAt = System.currentTimeMillis().toDouble()
    var sampleRate = 0
    var written = 0
    RandomAccessFile(output, "rw").use { out ->
      out.setLength(0)
      val buffer = ByteArray(1 shl 20)
      for (input in inputs) {
        val header = WavHeader.read(input) ?: throw AnvilException(RecorderErrorCode.IO, "${input.name} is not a WAV file")
        if (sampleRate == 0) {
          sampleRate = header.first
          out.write(WavHeader.bytes(sampleRate, 0))
        }
        if (header.first != sampleRate) {
          throw AnvilException(RecorderErrorCode.STATE, "${input.name} is ${header.first} Hz, expected $sampleRate Hz")
        }
        val available = maxOf(0L, input.length() - WavHeader.BYTE_COUNT).toInt() and 1.inv()
        var remaining = if (header.second > 0) minOf(header.second, available) else available
        RandomAccessFile(input, "r").use { reader ->
          reader.seek(WavHeader.BYTE_COUNT.toLong())
          while (remaining > 0) {
            val read = reader.read(buffer, 0, minOf(remaining, buffer.size))
            if (read <= 0) break
            out.write(buffer, 0, read)
            written += read
            remaining -= read
          }
        }
      }
      WavHeader.patch(out, written)
      out.fd.sync()
    }
    return RecordingSegment(
      index = 0.0,
      filePath = output.absolutePath,
      sampleRate = sampleRate.toDouble(),
      durationMs = written / (sampleRate * 2.0) * 1000.0,
      fileSize = (WavHeader.BYTE_COUNT + written).toDouble(),
      mediaStartMs = 0.0,
      startedAt = startedAt,
      endedAt = System.currentTimeMillis().toDouble(),
      wasInterrupted = false,
      interruptionReason = null,
      routeChanged = false,
      sha256 = output.sha256Hex(),
    )
  }
}
