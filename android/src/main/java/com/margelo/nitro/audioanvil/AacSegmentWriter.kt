package com.margelo.nitro.audioanvil

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

/**
 * One open ADTS AAC segment file. Appends encoded frames and fsyncs on an interval.
 * Every fsync point produces a valid, playable AAC stream — ADTS is self-synchronising
 * so a torn write at the tail is ignored by decoders.
 */
internal class AacSegmentWriter(
  val file: File,
  val index: Int,
  val sampleRate: Int,
  val mediaStartMs: Double,
  fsyncIntervalMs: Double,
  aacBitrate: Int,
) {
  val startedAt: Double = System.currentTimeMillis().toDouble()
  var wasInterrupted = false
  var interruptionReason: AnvilInterruptionReason? = null
  var routeChanged = false

  private val output = RandomAccessFile(file, "rw")
  private val fsyncEveryBytes: Int
  private var bytesSinceFlush = 0

  var dataBytes = 0
    private set
  var pcmSamples = 0
    private set

  init {
    output.setLength(0)
    // Bytes/ms at encoded bitrate.
    val bytesPerMs = aacBitrate / 8000.0
    fsyncEveryBytes = maxOf(1024, (bytesPerMs * fsyncIntervalMs).toInt())
  }

  /** Duration derived from PCM samples (exact) rather than bytes (varies with bitrate). */
  val durationMs: Double
    get() = pcmSamples / sampleRate.toDouble() * 1000.0

  fun append(frame: AacEncoder.Frame) {
    output.seek(output.length())
    output.write(frame.bytes)
    dataBytes += frame.bytes.size
    pcmSamples += frame.pcmSamples
    bytesSinceFlush += frame.bytes.size
    if (bytesSinceFlush >= fsyncEveryBytes) {
      flush()
    }
  }

  /** Actually pushes bytes to storage. */
  fun flush() {
    output.fd.sync()
    bytesSinceFlush = 0
  }

  fun complete(): RecordingSegment {
    flush()
    output.close()
    return RecordingSegment(
      index = index.toDouble(),
      filename = file.name,
      filePath = file.absolutePath,
      sampleRate = sampleRate.toDouble(),
      durationMs = durationMs,
      fileSize = dataBytes.toDouble(),
      mediaStartMs = mediaStartMs,
      startedAt = startedAt,
      endedAt = System.currentTimeMillis().toDouble(),
      wasInterrupted = wasInterrupted,
      interruptionReason = interruptionReason,
      routeChanged = routeChanged,
      sha256 = file.sha256Hex(),
    )
  }

  /** Best-effort close when `complete()` failed. Bytes up to the last flush stay playable. */
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
