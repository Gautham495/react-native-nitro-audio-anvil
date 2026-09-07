package com.margelo.nitro.audioanvil

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise

/** Autolinked root object. Creates recorders, answers permission questions, recovers orphaned sessions. */
@Keep
@DoNotStrip
class HybridAnvilFactory : HybridAnvilFactorySpec() {
  private val context: ReactApplicationContext
    get() = NitroModules.applicationContext ?: throw AnvilException(RecorderErrorCode.STATE, "No ApplicationContext set!")

  override fun createRecorder(config: RecorderConfig): Promise<HybridAnvilRecorderSpec> {
    return Promise.parallel<HybridAnvilRecorderSpec> {
      RecorderConfigValidator.validate(config)
      HybridAnvilRecorder(config)
    }
  }

  override fun getPermissionStatus(): PermissionStatus {
    return AnvilPermission.status(context, context.currentActivity)
  }

  override fun requestPermission(): Promise<PermissionStatus> {
    return AnvilPermission.request(context, context.currentActivity)
  }

  override fun discoverOrphanedRecordings(directory: String): Promise<Array<OrphanedRecording>> {
    return Promise.parallel {
      OrphanScanner.discover(AnvilPaths.directory(directory)).toTypedArray()
    }
  }

  override fun concatenate(segmentPaths: Array<String>, outputPath: String): Promise<RecordingSegment> {
    return Promise.parallel {
      WavConcatenator.concatenate(segmentPaths.map { AnvilPaths.directory(it) }, AnvilPaths.directory(outputPath))
    }
  }
}
