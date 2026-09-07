package com.margelo.nitro.audioanvil

import java.io.File
import java.io.RandomAccessFile

/** Copies a media-time range out of one or more segment files into a new WAV. */
internal object RangeExtractor {
  fun extract(sources: List<RangeSource>, sampleRate: Int, startMs: Double, endMs: Double, target: File) {
    if (endMs <= startMs) throw AnvilException(RecorderErrorCode.STATE, "endMs must be greater than startMs")
    val bytesPerMs = sampleRate * 2 / 1000.0
    RandomAccessFile(target, "rw").use { output ->
      output.setLength(0)
      output.write(WavHeader.bytes(sampleRate, 0))
      var written = 0
      for (source in sources) {
        val sourceEndMs = source.mediaStartMs + source.dataBytes / bytesPerMs
        val overlapStart = maxOf(startMs, source.mediaStartMs)
        val overlapEnd = minOf(endMs, sourceEndMs)
        if (overlapEnd <= overlapStart) continue
        val fromByte = ((overlapStart - source.mediaStartMs) * bytesPerMs).toInt() and 1.inv()
        val toByte = minOf(source.dataBytes, ((overlapEnd - source.mediaStartMs) * bytesPerMs).toInt() and 1.inv())
        if (toByte <= fromByte) continue
        val bytes = ByteArray(toByte - fromByte)
        RandomAccessFile(source.file, "r").use { input ->
          input.seek((WavHeader.BYTE_COUNT + fromByte).toLong())
          input.readFully(bytes)
        }
        output.write(bytes)
        written += bytes.size
      }
      WavHeader.patch(output, written)
      output.fd.sync()
    }
  }
}
