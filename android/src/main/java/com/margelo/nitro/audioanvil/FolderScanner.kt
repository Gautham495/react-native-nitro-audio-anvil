package com.margelo.nitro.audioanvil

import java.io.File

/**
 * Walks `outputDirectory` for unsealed recording folders and returns them as
 * `RecoveredRecording`s. Repairs manifests on the way: verifies every referenced
 * segment exists and is valid ADTS, rolls unreferenced trailing `.aac` files into the
 * manifest if they parse, deletes them if they don't.
 */
internal object FolderScanner {
  fun discover(outputDirectory: File): List<RecoveredRecording> {
    if (!outputDirectory.isDirectory) return emptyList()
    val subfolders = outputDirectory.listFiles()?.filter { it.isDirectory } ?: return emptyList()
    val recovered = ArrayList<RecoveredRecording>()
    for (folder in subfolders) {
      recoverFolder(folder)?.let { recovered.add(it) }
    }
    return recovered
  }

  private fun recoverFolder(folder: File): RecoveredRecording? {
    val manifestFile = File(folder, HlsPaths.MANIFEST_NAME)
    val parsed = HlsManifestReader.read(manifestFile) ?: return null
    if (parsed.sealed) return null

    val aacFiles = folder.listFiles()?.filter { it.extension == HlsPaths.SEGMENT_EXTENSION } ?: emptyList()

    // Preserve discontinuity flags by filename, independent of order.
    val discontinuityByName = parsed.entries.associate { it.filename to it.precededByDiscontinuity }

    data class Candidate(
      val index: Int,
      val file: File,
      val scan: AdtsFrameScanner.Scan,
      val precededByDiscontinuity: Boolean,
    )

    val candidates = ArrayList<Candidate>()
    var manifestDirty = false

    for (file in aacFiles) {
      val index = segmentIndex(file.name) ?: continue  // not our NNNNN.aac scheme
      val scan = runCatching { AdtsFrameScanner.scan(file) }.getOrNull()
      if (scan == null || scan.durationMs <= 0) {
        val wasReferenced = discontinuityByName.containsKey(file.name)
        if (wasReferenced) manifestDirty = true
        // Delete only unreferenced garbage; a referenced-but-broken file might be
        // mid-write elsewhere — too risky to remove.
        if (!wasReferenced) file.delete()
        continue
      }

      // Torn tail → truncate so disk == manifest == what readers see. Idempotent.
      if (scan.validByteCount < file.length()) {
        truncate(file, scan.validByteCount.toLong())
        manifestDirty = true
      }

      val wasReferenced = discontinuityByName.containsKey(file.name)
      if (!wasReferenced) manifestDirty = true  // salvaged a new tail

      candidates.add(
        Candidate(
          index = index,
          file = file,
          scan = scan,
          precededByDiscontinuity = discontinuityByName[file.name] ?: false,
        )
      )
    }

    if (candidates.isEmpty()) return null

    // THE FIX: order by numeric index only. Idempotent across repeated recoveries.
    candidates.sortBy { it.index }

    val validEntries = ArrayList<HlsManifestWriter.Entry>()
    val segments = ArrayList<RecordingSegment>()
    var runningMediaStartMs = 0.0
    var outIndex = 0

    for (c in candidates) {
      validEntries.add(
        HlsManifestWriter.Entry(
          filename = c.file.name,
          durationSeconds = c.scan.durationMs / 1000.0,
          precededByDiscontinuity = c.precededByDiscontinuity,
        )
      )
      segments.add(
        materializeSegment(
          file = c.file,
          index = outIndex,
          sampleRate = c.scan.sampleRate,
          durationMs = c.scan.durationMs,
          mediaStartMs = runningMediaStartMs,
          precededByDiscontinuity = c.precededByDiscontinuity,
        )
      )
      runningMediaStartMs += c.scan.durationMs
      outIndex++
    }

    if (parsed.entries.map { it.filename } != validEntries.map { it.filename }) {
      manifestDirty = true
    }

    if (manifestDirty) {
      val writer = HlsManifestWriter(folder = folder, targetDurationSeconds = parsed.targetDurationSeconds)
      writer.seed(existingEntries = validEntries, sealed = false)
      writer.rewriteInPlace()
    }

    val totalDurationMs = segments.fold(0.0) { acc, s -> acc + s.durationMs }
    val wasInterrupted = validEntries.any { it.precededByDiscontinuity }
    return RecoveredRecording(
      recordingId = folder.name,
      folderPath = folder.absolutePath,
      manifestPath = manifestFile.absolutePath,
      segments = segments.toTypedArray(),
      totalDurationMs = totalDurationMs,
      wasInterrupted = wasInterrupted,
    )
  }

  /** Parses the numeric index from "NNNNN.aac". Null for names that don't match. */
  private fun segmentIndex(filename: String): Int? {
    if (!filename.endsWith(".${HlsPaths.SEGMENT_EXTENSION}")) return null
    val stem = filename.removeSuffix(".${HlsPaths.SEGMENT_EXTENSION}")
    if (stem.isEmpty() || !stem.all { it.isDigit() }) return null
    return stem.toIntOrNull()
  }

  private fun truncate(file: File, length: Long) {
    java.io.RandomAccessFile(file, "rw").use { raf ->
      raf.setLength(length)
      raf.fd.sync()
    }
  }

  /**
   * Public seam used by resume-from-existing-manifest in the factory: builds a
   * `RecordingSegment` from a file that's already on disk, using its ADTS scan.
   */
  fun materializeSegment(
    file: File,
    index: Int,
    sampleRate: Int,
    durationMs: Double,
    mediaStartMs: Double,
    precededByDiscontinuity: Boolean,
  ): RecordingSegment {
    val modified = file.lastModified().toDouble()
    return RecordingSegment(
      index = index.toDouble(),
      filename = file.name,
      filePath = file.absolutePath,
      sampleRate = sampleRate.toDouble(),
      durationMs = durationMs,
      fileSize = file.length().toDouble(),
      mediaStartMs = mediaStartMs,
      startedAt = modified - durationMs,
      endedAt = modified,
      wasInterrupted = precededByDiscontinuity,
      interruptionReason = null,
      routeChanged = false,
      sha256 = file.sha256Hex(),
    )
  }
}
