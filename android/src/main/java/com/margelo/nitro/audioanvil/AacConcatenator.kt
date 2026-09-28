package com.margelo.nitro.audioanvil

import java.io.File
import java.io.RandomAccessFile

/**
 * Joins every segment referenced by a recording's manifest into a single ADTS AAC file.
 * Byte-copy — ADTS is self-synchronising so concatenating frame streams is legal.
 */
internal object AacConcatenator {
  fun concatenate(folder: File, output: File): RecordingSegment {
    val manifestFile = File(folder, HlsPaths.MANIFEST_NAME)
    val parsed = HlsManifestReader.read(manifestFile)
      ?: throw AnvilException(RecorderErrorCode.STATE, "${folder.name}/manifest.m3u8 is missing or invalid")
    if (parsed.entries.isEmpty()) {
      throw AnvilException(RecorderErrorCode.STATE, "${folder.name} has no segments")
    }

    val startedAt = System.currentTimeMillis().toDouble()
    var totalBytes = 0
    var totalDurationMs = 0.0
    var sampleRate = 0

    RandomAccessFile(output, "rw").use { out ->
      out.setLength(0)
      val buffer = ByteArray(1 shl 20)
      for (entry in parsed.entries) {
        val segFile = File(folder, entry.filename)
        val scan = AdtsFrameScanner.scan(segFile)
          ?: throw AnvilException(RecorderErrorCode.IO, "${entry.filename} is not a valid ADTS AAC file")
        if (sampleRate == 0) sampleRate = scan.sampleRate
        if (scan.sampleRate != sampleRate) {
          throw AnvilException(
            RecorderErrorCode.STATE,
            "${entry.filename} is ${scan.sampleRate} Hz, expected $sampleRate Hz"
          )
        }
        RandomAccessFile(segFile, "r").use { reader ->
          var remaining = scan.validByteCount
          while (remaining > 0) {
            val read = reader.read(buffer, 0, minOf(remaining, buffer.size))
            if (read <= 0) break
            out.write(buffer, 0, read)
            totalBytes += read
            remaining -= read
          }
        }
        totalDurationMs += scan.durationMs
      }
      out.fd.sync()
    }

    return RecordingSegment(
      index = 0.0,
      filename = output.name,
      filePath = output.absolutePath,
      sampleRate = sampleRate.toDouble(),
      durationMs = totalDurationMs,
      fileSize = totalBytes.toDouble(),
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
