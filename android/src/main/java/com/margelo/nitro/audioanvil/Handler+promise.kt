package com.margelo.nitro.audioanvil

import android.os.Handler
import com.margelo.nitro.core.Promise

/**
 * Runs `block` on this Handler's thread and resolves/rejects the returned Promise exactly once.
 * The single bridge between JS-facing methods and the recorder's owner thread.
 */
internal fun <T> Handler.promise(block: () -> T): Promise<T> {
  val promise = Promise<T>()
  val posted = post {
    try {
      promise.resolve(block())
    } catch (e: Throwable) {
      promise.reject(e)
    }
  }
  if (!posted) {
    promise.reject(AnvilException(RecorderErrorCode.STATE, "Recorder thread is no longer running"))
  }
  return promise
}
