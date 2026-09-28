package com.margelo.nitro.audioanvil

import java.io.File

/**
 * Parses `manifest.m3u8` files Anvil wrote. Not a general HLS parser — only recognises
 * the tags Anvil emits.
 */
internal object HlsManifestReader {
  data class ParsedManifest(
    val targetDurationSeconds: Int,
    val entries: List<HlsManifestWriter.Entry>,
    val sealed: Boolean,
    /**
     * `true` when the LAST entry is preceded by a `#EXT-X-DISCONTINUITY` — the previous
     * run ended on an interruption or route change, not a clean rotation.
     */
    val lastEntryOnDiscontinuity: Boolean,
  )

  fun read(file: File): ParsedManifest? {
    if (!file.exists()) return null
    val contents = file.readText(Charsets.UTF_8)
    return parse(contents)
  }

  internal fun parse(contents: String): ParsedManifest? {
    val lines = contents.split('\n', '\r').filter { it.isNotEmpty() || it.isEmpty() /* keep index alignment */ }
    if (lines.firstOrNull() != "#EXTM3U") return null

    var targetDurationSeconds = 6
    val entries = ArrayList<HlsManifestWriter.Entry>()
    var sealed = false
    var pendingDiscontinuity = false
    var pendingDurationSeconds: Double? = null

    for (line in lines) {
      when {
        line.startsWith("#EXT-X-TARGETDURATION:") -> {
          val v = line.removePrefix("#EXT-X-TARGETDURATION:").trim()
          v.toIntOrNull()?.let { targetDurationSeconds = maxOf(1, it) }
        }
        line == "#EXT-X-DISCONTINUITY" -> {
          pendingDiscontinuity = true
        }
        line.startsWith("#EXTINF:") -> {
          val trimmed = line.removePrefix("#EXTINF:")
          val value = trimmed.split(',').firstOrNull() ?: trimmed
          pendingDurationSeconds = value.toDoubleOrNull()
        }
        line == "#EXT-X-ENDLIST" -> {
          sealed = true
        }
        line.isNotEmpty() && !line.startsWith("#") -> {
          entries.add(
            HlsManifestWriter.Entry(
              filename = line,
              durationSeconds = pendingDurationSeconds ?: 0.0,
              precededByDiscontinuity = pendingDiscontinuity,
            )
          )
          pendingDiscontinuity = false
          pendingDurationSeconds = null
        }
      }
    }

    val lastOnDiscontinuity = entries.lastOrNull()?.precededByDiscontinuity ?: false
    return ParsedManifest(
      targetDurationSeconds = targetDurationSeconds,
      entries = entries,
      sealed = sealed,
      lastEntryOnDiscontinuity = lastOnDiscontinuity,
    )
  }
}
