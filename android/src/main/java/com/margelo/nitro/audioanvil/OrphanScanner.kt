package com.margelo.nitro.audioanvil

import java.io.File
import java.io.RandomAccessFile

/**
 * Finds sessions whose `.recording` marker is still present (the app died before `stop()`),
 * repairs their WAV headers from the real file length, hashes them and removes the marker.
 */
internal object OrphanScanner {
  const val MARKER_EXTENSION = "recording"

  fun markerFile(directory: File, sessionId: String): File = File(directory, "$sessionId.$MARKER_EXTENSION")

  fun discover(directory: File): List<OrphanedRecording> {
    if (!directory.isDirectory) return emptyList()
    val entries = directory.listFiles()?.toList() ?: return emptyList()
    val markers = entries.filter { it.extension == MARKER_EXTENSION }
    val result = ArrayList<OrphanedRecording>()
    for (marker in markers) {
      val sessionId = marker.nameWithoutExtension
      val files = entries
        .filter { it.extension == "wav" && it.name.startsWith("$sessionId-") }
        .sortedBy { it.name }
      val segments = ArrayList<RecordingSegment>()
      var mediaStartMs = 0.0
      for ((index, file) in files.withIndex()) {
        val segment = repair(file, index, mediaStartMs) ?: continue
        segments.add(segment)
        mediaStartMs += segment.durationMs
      }
      marker.delete()
      result.add(OrphanedRecording(sessionId = sessionId, segments = segments.toTypedArray()))
    }
    return result
  }

  private fun repair(file: File, index: Int, mediaStartMs: Double): RecordingSegment? {
    val header = WavHeader.read(file) ?: return null
    val sampleRate = header.first
    val actualDataBytes = maxOf(0L, file.length() - WavHeader.BYTE_COUNT).toInt() and 1.inv()
    if (actualDataBytes != header.second) {
      RandomAccessFile(file, "rw").use { output ->
        WavHeader.patch(output, actualDataBytes)
        output.fd.sync()
      }
    }
    val modified = file.lastModified().toDouble()
    val durationMs = actualDataBytes / (sampleRate * 2.0) * 1000.0
    return RecordingSegment(
      index = index.toDouble(),
      filePath = file.absolutePath,
      sampleRate = sampleRate.toDouble(),
      durationMs = durationMs,
      fileSize = (WavHeader.BYTE_COUNT + actualDataBytes).toDouble(),
      mediaStartMs = mediaStartMs,
      startedAt = modified - durationMs,
      endedAt = modified,
      wasInterrupted = false,
      interruptionReason = null,
      routeChanged = false,
      sha256 = file.sha256Hex(),
    )
  }
}
