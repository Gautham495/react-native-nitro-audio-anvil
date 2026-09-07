package com.margelo.nitro.audioanvil

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import com.margelo.nitro.core.Promise

/** RECORD_AUDIO permission state and runtime request through React Native's PermissionAwareActivity. */
internal object AnvilPermission {
  private const val REQUEST_CODE = 0xA4A1

  fun status(context: Context, activity: Activity?): AnvilPermissionStatus {
    if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      return AnvilPermissionStatus.GRANTED
    }
    // Android cannot distinguish "never asked" from "permanently denied"; a prior denial shows rationale.
    if (activity != null && activity.shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) {
      return AnvilPermissionStatus.DENIED
    }
    return AnvilPermissionStatus.UNDETERMINED
  }

  fun request(context: Context, activity: Activity?): Promise<AnvilPermissionStatus> {
    val current = status(context, activity)
    if (current == AnvilPermissionStatus.GRANTED) return Promise.resolved(current)
    val permissionActivity = activity as? PermissionAwareActivity
      ?: return Promise.rejected(AnvilException(RecorderErrorCode.PERMISSION, "No PermissionAwareActivity to request RECORD_AUDIO from"))
    val promise = Promise<AnvilPermissionStatus>()
    val listener = PermissionListener { _, _, grantResults ->
      val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
      promise.resolve(if (granted) AnvilPermissionStatus.GRANTED else AnvilPermissionStatus.DENIED)
      true
    }
    Handler(Looper.getMainLooper()).post {
      try {
        permissionActivity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), REQUEST_CODE, listener)
      } catch (e: Exception) {
        promise.reject(AnvilException(RecorderErrorCode.PERMISSION, "requestPermissions failed: ${e.message}"))
      }
    }
    return promise
  }
}
