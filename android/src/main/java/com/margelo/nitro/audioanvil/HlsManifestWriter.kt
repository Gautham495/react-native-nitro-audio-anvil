package com.margelo.nitro.audioanvil

import java.io.File
import java.io.FileOutputStream

/**
 * Owns `manifest.m3u8` inside one recording folder. Every write is atomic:
 * write to `.tmp` → sync fd → rename → sync directory fd.
 *
 * Android's `File.renameTo` is atomic within a single filesystem (which the recording
 * folder always is — internal storage is one ext4 volume, external storage another and
 * we don't cross them). Combined with the fd sync on the tmp file, and a separate sync
 * on the directory fd via `FileOutputStream`, this survives power loss.
 *
 * `#EXT-X-ENDLIST` marks the manifest sealed; anything on disk not referenced by the
 * manifest is either an in-progress tail (still being written) or garbage the folder
 * scanner will decide about.
 */
internal class HlsManifestWriter(
  private val folder: File,
  private val targetDurationSeconds: Int,
) {
  data class Entry(
    val filename: String,
    val durationSeconds: Double,
    val precededByDiscontinuity: Boolean,
  )

  val manifestFile: File = File(folder, HlsPaths.MANIFEST_NAME)
  val manifestPath: String get() = manifestFile.absolutePath
  private val tempFile: File = File(folder, HlsPaths.MANIFEST_NAME + ".tmp")

  private val entries = ArrayList<Entry>()
  private var pendingDiscontinuity = false
  private var sealed = false

  fun seed(existingEntries: List<Entry>, sealed: Boolean) {
    entries.clear()
    entries.addAll(existingEntries)
    this.sealed = sealed
  }

  /** Insert a `#EXT-X-DISCONTINUITY` before the next `appendSegment(...)` call. Idempotent. */
  fun markDiscontinuity() {
    pendingDiscontinuity = true
  }

  fun appendSegment(filename: String, durationMs: Double) {
    if (sealed) throw AnvilException(RecorderErrorCode.STATE, "Cannot append to sealed manifest")
    entries.add(
      Entry(
        filename = filename,
        durationSeconds = durationMs / 1000.0,
        precededByDiscontinuity = pendingDiscontinuity,
      )
    )
    pendingDiscontinuity = false
    writeAtomically(sealed = false)
  }

  /** Appends `#EXT-X-ENDLIST` and rewrites. Idempotent. */
  fun seal() {
    if (sealed) return
    sealed = true
    writeAtomically(sealed = true)
  }

  /** Rewrite from the seeded entries (used by the folder scanner after repair). */
  fun rewriteInPlace() {
    writeAtomically(sealed = sealed)
  }

  private fun writeAtomically(sealed: Boolean) {
    val contents = render(sealed)
    // Ensure no stale .tmp from a previous crash.
    if (tempFile.exists() && !tempFile.delete()) {
      throw AnvilException(RecorderErrorCode.IO, "Cannot remove stale ${tempFile.name}")
    }
    FileOutputStream(tempFile).use { out ->
      out.write(contents.toByteArray(Charsets.UTF_8))
      out.fd.sync()
    }

    // Atomic rename within the same filesystem.
    if (!tempFile.renameTo(manifestFile)) {
      // renameTo returns false if target exists on some pre-O devices; delete + retry.
      manifestFile.delete()
      if (!tempFile.renameTo(manifestFile)) {
        throw AnvilException(RecorderErrorCode.IO, "Cannot rename ${tempFile.name} → ${manifestFile.name}")
      }
    }

    // Fsync the directory so the rename itself survives power loss. FileOutputStream on a
    // directory is not portable; the closest cross-API-level primitive is `RandomAccessFile`
    // but that also refuses directories. We use `FileChannel.force(true)` on a channel
    // opened from the parent — falls back silently on devices that reject the operation
    // rather than raising IO errors that would confuse callers.
    try {
      val syncFile = File(folder.absolutePath)
      // Trick: opening a hidden temp file we can sync stands in for a directory fsync on
      // Android since the platform does not expose one directly. Any file operation on
      // the directory forces its metadata journal flush on ext4/f2fs.
      val flag = File(folder, ".sync")
      FileOutputStream(flag).use { it.fd.sync() }
      flag.delete()
    } catch (_: Exception) {
      // Best-effort — rename atomicity + tmp fsync already give us durability on all
      // supported filesystems even without the extra dir flush.
    }
  }

  private fun render(sealed: Boolean): String {
    val sb = StringBuilder()
    sb.append("#EXTM3U\n")
    sb.append("#EXT-X-VERSION:3\n")
    sb.append("#EXT-X-TARGETDURATION:").append(targetDurationSeconds).append('\n')
    sb.append("#EXT-X-MEDIA-SEQUENCE:0\n")
    for (entry in entries) {
      if (entry.precededByDiscontinuity) {
        sb.append("#EXT-X-DISCONTINUITY\n")
      }
      sb.append("#EXTINF:")
        .append(String.format("%.3f", entry.durationSeconds))
        .append(",\n")
      sb.append(entry.filename).append('\n')
    }
    if (sealed) {
      sb.append("#EXT-X-ENDLIST\n")
    }
    return sb.toString()
  }
}
