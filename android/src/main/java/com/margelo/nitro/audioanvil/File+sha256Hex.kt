package com.margelo.nitro.audioanvil

import java.io.File
import java.security.MessageDigest

/** Streams the file through SHA-256 and returns lowercase hex. */
internal fun File.sha256Hex(): String {
  val digest = MessageDigest.getInstance("SHA-256")
  inputStream().use { input ->
    val buffer = ByteArray(1 shl 16)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}
