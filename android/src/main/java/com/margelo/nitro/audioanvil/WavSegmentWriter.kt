package com.margelo.nitro.audioanvil

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * One open WAV segment. Appends PCM, patches the header and fsyncs on an interval,
 * so the file on disk is a valid WAV at every flush point.
 */
internal class WavSegmentWriter(
  val file: File,
  val index: Int,
  val sampleRate: Int,
  val mediaStartMs: Double,
  fsyncIntervalMs: Double,
) {
  val startedAt: Double = System.currentTimeMillis().toDouble()
  var wasInterrupted = false
  var interruptionReason: InterruptionReason? = null
  var routeChanged = false

  private val output = RandomAccessFile(file, "rw")
  private val fsyncEveryBytes = maxOf(2, (sampleRate * 2 / 1000.0 * fsyncIntervalMs).toInt())
  private var bytesSinceFlush = 0

  var dataBytes = 0
    private set

  init {
    output.setLength(0)
    output.write(WavHeader.bytes(sampleRate, 0))
    output.fd.sync()
  }

  val durationMs: Double
    get() = dataBytes / (sampleRate * 2.0) * 1000.0

  fun append(bytes: ByteArray, count: Int) {
    output.seek(output.length())
    output.write(bytes, 0, count)
    dataBytes += count
    bytesSinceFlush += count
    if (bytesSinceFlush >= fsyncEveryBytes) {
      flush()
    }
  }

  /** Patches the header, then fsyncs. Header and data are consistent on disk afterwards. */
  fun flush() {
    WavHeader.patch(output, dataBytes)
    output.fd.sync()
    bytesSinceFlush = 0
  }

  fun complete(): RecordingSegment {
    flush()
    output.close()
    return RecordingSegment(
      index = index.toDouble(),
      filePath = file.absolutePath,
      sampleRate = sampleRate.toDouble(),
      durationMs = durationMs,
      fileSize = (WavHeader.BYTE_COUNT + dataBytes).toDouble(),
      mediaStartMs = mediaStartMs,
      startedAt = startedAt,
      endedAt = System.currentTimeMillis().toDouble(),
      wasInterrupted = wasInterrupted,
      interruptionReason = interruptionReason,
      routeChanged = routeChanged,
      sha256 = file.sha256Hex(),
    )
  }

  /** Best-effort close when `complete()` itself failed. The file stays valid up to the last flush. */
  fun abandon() {
    try {
      flush()
    } catch (_: IOException) {
    }
    try {
      output.close()
    } catch (_: IOException) {
    }
  }
}
