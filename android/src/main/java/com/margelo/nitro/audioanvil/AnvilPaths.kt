package com.margelo.nitro.audioanvil

import android.net.Uri
import java.io.File

/** Accepts both plain paths and `file://` URLs. */
internal object AnvilPaths {
  fun directory(path: String): File {
    if (path.startsWith("file://")) {
      return File(Uri.parse(path).path ?: path)
    }
    return File(path)
  }
}
