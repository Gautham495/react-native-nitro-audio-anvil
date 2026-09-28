package com.margelo.nitro.audioanvil

import java.io.File

/**
 * Tiny zero-byte marker files that record which segments have been PUT to the bucket.
 * `${filename}.uploaded` sits next to `${filename}` and its mere presence is the signal.
 *
 * The manifest gets one too — `manifest.m3u8.uploaded` — but manifests are re-PUT on
 * every segment upload anyway, so its role is only to close out fully-uploaded sealed
 * folders for local cleanup.
 */
internal object UploadSentinelStore {
  fun sentinelFile(folder: File, filename: String): File =
    File(folder, filename + HlsPaths.SENTINEL_SUFFIX)

  fun exists(folder: File, filename: String): Boolean =
    sentinelFile(folder, filename).exists()

  /** Idempotent. */
  fun mark(folder: File, filename: String) {
    val file = sentinelFile(folder, filename)
    if (file.exists()) return
    if (!file.createNewFile()) {
      throw AnvilException(RecorderErrorCode.IO, "Cannot create sentinel ${file.name}")
    }
  }

  fun listPending(outputDirectory: File): List<PendingUpload> {
    if (!outputDirectory.isDirectory) return emptyList()
    val subfolders = outputDirectory.listFiles()?.filter { it.isDirectory } ?: return emptyList()
    val out = ArrayList<PendingUpload>()
    for (folder in subfolders) {
      val recordingId = folder.name
      val manifestFile = File(folder, HlsPaths.MANIFEST_NAME)
      val parsed = HlsManifestReader.read(manifestFile) ?: continue

      for (entry in parsed.entries) {
        if (exists(folder, entry.filename)) continue
        val seg = File(folder, entry.filename)
        if (!seg.exists()) continue
        out.add(
          PendingUpload(
            recordingId = recordingId,
            kind = PendingUploadKind.SEGMENT,
            filename = entry.filename,
            filePath = seg.absolutePath,
            fileSize = seg.length().toDouble(),
          )
        )
      }

      if (!exists(folder, HlsPaths.MANIFEST_NAME) && manifestFile.exists()) {
        out.add(
          PendingUpload(
            recordingId = recordingId,
            kind = PendingUploadKind.MANIFEST,
            filename = HlsPaths.MANIFEST_NAME,
            filePath = manifestFile.absolutePath,
            fileSize = manifestFile.length().toDouble(),
          )
        )
      }
    }
    return out
  }
}
