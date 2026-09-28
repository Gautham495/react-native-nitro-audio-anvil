package com.margelo.nitro.audioanvil

import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.facebook.react.bridge.ReactApplicationContext
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.File

/**
 * Autolinked root object. Creates recorders, answers permission questions, recovers
 * orphaned recordings, concatenates and deletes folders, drives the upload retry list.
 */
@Keep
@DoNotStrip
class HybridAnvilFactory : HybridAnvilFactorySpec() {
  private val context: ReactApplicationContext
    get() = NitroModules.applicationContext
      ?: throw AnvilException(RecorderErrorCode.STATE, "No ApplicationContext set!")

  override fun createRecorder(config: RecorderConfig): Promise<HybridAnvilRecorderSpec> {
    return Promise.parallel<HybridAnvilRecorderSpec> {
      RecorderConfigValidator.validate(config)

      val outputDirectory = AnvilPaths.directory(config.outputDirectory)
      val folder = File(outputDirectory, config.recordingId)
      val manifestFile = File(folder, HlsPaths.MANIFEST_NAME)
      val manifestExists = manifestFile.exists()

      val resume = config.resume ?: false

      if (manifestExists) {
        val parsed = HlsManifestReader.read(manifestFile)
          ?: throw AnvilException(
            RecorderErrorCode.STATE,
            "${config.recordingId}/manifest.m3u8 is present but unreadable"
          )
        if (parsed.sealed) {
          throw AnvilException(
            RecorderErrorCode.STATE,
            "${config.recordingId} is already sealed; use a fresh recordingId"
          )
        }
        if (!resume) {
          throw AnvilException(
            RecorderErrorCode.STATE,
            "${config.recordingId} has an unsealed manifest; pass resume: true or deleteRecording(...)"
          )
        }
        return@parallel buildResumedRecorder(config, folder, parsed)
      }

      if (resume) {
        throw AnvilException(
          RecorderErrorCode.STATE,
          "${config.recordingId} has no manifest to resume from"
        )
      }

      HybridAnvilRecorder(
        context = context,
        config = config,
        seededSegments = emptyList(),
        seededNextIndex = 0,
        seededMediaMs = 0.0,
        resumingFromExisting = false,
      )
    }
  }

  private fun buildResumedRecorder(
    config: RecorderConfig,
    folder: File,
    parsed: HlsManifestReader.ParsedManifest,
  ): HybridAnvilRecorderSpec {
    val segments = ArrayList<RecordingSegment>()
    var runningMediaStartMs = 0.0
    var runningIndex = 0
    var manifestSampleRate = 0

    for (entry in parsed.entries) {
      val file = File(folder, entry.filename)
      val scan = AdtsFrameScanner.scan(file) ?: continue
      if (scan.durationMs <= 0) continue
      if (manifestSampleRate == 0) manifestSampleRate = scan.sampleRate
      segments.add(
        FolderScanner.materializeSegment(
          file = file,
          index = runningIndex,
          sampleRate = scan.sampleRate,
          durationMs = scan.durationMs,
          mediaStartMs = runningMediaStartMs,
          precededByDiscontinuity = entry.precededByDiscontinuity,
        )
      )
      runningMediaStartMs += scan.durationMs
      runningIndex++
    }
    if (manifestSampleRate != 0 && manifestSampleRate != config.sampleRate.toInt()) {
      throw AnvilException(
        RecorderErrorCode.STATE,
        "resume: existing manifest is $manifestSampleRate Hz, config is ${config.sampleRate.toInt()} Hz"
      )
    }

    // Next write index from the highest filename number ON DISK, not the survivor count.
    // Reusing a filename makes AacSegmentWriter truncate an existing segment on open —
    // that is the bug that ate earlier segments across repeated recoveries.
    val nextIndex = highestSegmentIndexOnDisk(folder) + 1

    val recorder = HybridAnvilRecorder(
      context = context,
      config = config,
      seededSegments = segments,
      seededNextIndex = nextIndex,
      seededMediaMs = runningMediaStartMs,
      resumingFromExisting = true,
    )
    recorder.seedManifest(parsed.entries)
    return recorder
  }

  /** Highest numeric index among all NNNNN.aac files in the folder; -1 when none. */
  private fun highestSegmentIndexOnDisk(folder: File): Int {
    val files = folder.listFiles() ?: return -1
    var maxIndex = -1
    for (file in files) {
      if (file.extension != HlsPaths.SEGMENT_EXTENSION) continue
      val stem = file.nameWithoutExtension
      if (stem.isEmpty() || !stem.all { it.isDigit() }) continue
      val n = stem.toIntOrNull() ?: continue
      if (n > maxIndex) maxIndex = n
    }
    return maxIndex
  }

  override fun getPermissionStatus(): AnvilPermissionStatus {
    return AnvilPermission.status(context, context.currentActivity)
  }

  override fun requestPermission(): Promise<AnvilPermissionStatus> {
    return AnvilPermission.request(context, context.currentActivity)
  }

  override fun discoverOrphanedRecordings(outputDirectory: String): Promise<Array<RecoveredRecording>> {
    return Promise.parallel {
      FolderScanner.discover(AnvilPaths.directory(outputDirectory)).toTypedArray()
    }
  }

  override fun concatenate(
    outputDirectory: String,
    recordingId: String,
    outputPath: String,
  ): Promise<RecordingSegment> {
    return Promise.parallel {
      val folder = File(AnvilPaths.directory(outputDirectory), recordingId)
      AacConcatenator.concatenate(folder, AnvilPaths.directory(outputPath))
    }
  }

  override fun deleteRecording(outputDirectory: String, recordingId: String): Promise<Boolean> {
    return Promise.parallel {
      val folder = File(AnvilPaths.directory(outputDirectory), recordingId)
      if (!folder.exists()) return@parallel false
      folder.deleteRecursively() || throw AnvilException(
        RecorderErrorCode.IO,
        "Cannot fully remove ${folder.absolutePath}"
      )
      true
    }
  }

  override fun retryPendingUploads(outputDirectory: String): Promise<Array<PendingUpload>> {
    return Promise.parallel {
      UploadSentinelStore.listPending(AnvilPaths.directory(outputDirectory)).toTypedArray()
    }
  }

  override fun markSegmentUploaded(
    outputDirectory: String,
    recordingId: String,
    filename: String,
  ): Promise<Unit> {
    return Promise.parallel {
      val folder = File(AnvilPaths.directory(outputDirectory), recordingId)
      UploadSentinelStore.mark(folder, filename)
    }
  }
}
