import type { HybridObject } from 'react-native-nitro-modules';
import type { AnvilRecorder } from './AnvilRecorder.nitro';
import type { RecorderConfig } from '../types/RecorderConfig';
import type { AnvilPermissionStatus } from '../types/AnvilPermissionStatus';
import type { RecoveredRecording } from '../types/RecoveredRecording';
import type { PendingUpload } from '../types/PendingUpload';
import type { RecordingSegment } from '../types/RecordingSegment';

/**
 * Root object of `react-native-nitro-audio-anvil`. Exported from the package as `Anvil`.
 *
 * The factory owns the shape of the on-disk tree — one folder per recording under
 * `outputDirectory`, each folder containing `manifest.m3u8` and its `%05d.aac` segments.
 * Every method here operates on that layout; nothing touches sidecar state, sessionIds,
 * or a marker store.
 *
 * @see {@linkcode AnvilFactory.createRecorder}
 */
export interface AnvilFactory extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  /**
   * Validates the config and returns a recorder in `idle` state at
   * `${outputDirectory}/${config.recordingId}/`. Call `start()` on the result.
   *
   * The folder is created lazily on first segment write — a rejected
   * `createRecorder` never leaves an empty folder behind.
   *
   * Rejects when:
   * - Microphone permission is not granted.
   * - `${outputDirectory}/${recordingId}/manifest.m3u8` exists with `#EXT-X-ENDLIST` —
   *   the recording is already sealed and its id cannot be reused.
   * - `${outputDirectory}/${recordingId}/manifest.m3u8` exists WITHOUT
   *   `#EXT-X-ENDLIST` and `resume` is not `true` — pass `resume: true` to continue
   *   into it, or `deleteRecording(...)` to discard it first.
   * - `resume` is `true` but no manifest is present.
   * - `resume` is `true` and the existing manifest's sample rate differs from
   *   `config.sampleRate`.
   */
  createRecorder(config: RecorderConfig): Promise<AnvilRecorder>;

  /**
   * Current microphone permission without prompting.
   */
  getPermissionStatus(): AnvilPermissionStatus;
  /**
   * Prompts for microphone permission if undetermined and resolves with the result.
   */
  requestPermission(): Promise<AnvilPermissionStatus>;

  /**
   * Lists every subfolder of `outputDirectory` whose `manifest.m3u8` is unsealed (has
   * no `#EXT-X-ENDLIST` line). Each result is one recording the previous run of the
   * app did not `stop()`.
   *
   * Before returning, for each folder:
   * 1. Every segment referenced by the manifest is verified to exist and to have a
   *    valid ADTS header. Broken references are dropped.
   * 2. Every `.aac` in the folder NOT referenced by the manifest is examined. If its
   *    ADTS frames parse cleanly it is appended to the manifest with its measured
   *    duration; if not, it is deleted.
   * 3. If the manifest was modified, it is rewritten via tmp + rename + fsync.
   *
   * Sealed folders (`#EXT-X-ENDLIST` present) are ignored; the integrator already
   * finished with them. Call this once on app launch.
   */
  discoverOrphanedRecordings(
    outputDirectory: string
  ): Promise<RecoveredRecording[]>;

  /**
   * Joins every segment referenced by the recording's manifest into a single ADTS AAC
   * file at `outputPath`. Byte-copy — no re-encoding, no header manipulation beyond
   * concatenating already-valid ADTS frame streams. `#EXT-X-DISCONTINUITY` markers are
   * irrelevant to concatenation; ADTS frames self-describe.
   *
   * Streams from disk; safe for hour-long recordings. The source folder is untouched —
   * call `deleteRecording(...)` yourself once the concatenated file has been uploaded.
   */
  concatenate(
    outputDirectory: string,
    recordingId: string,
    outputPath: string
  ): Promise<RecordingSegment>;

  /**
   * Removes the entire recording folder. Use for both "user discarded" and "everything
   * has been uploaded, nuke the local copy".
   *
   * Rejects only if the folder cannot be removed (permissions, still-open file
   * descriptors). Resolves with `true` when the folder was present and removed,
   * `false` when it was not present to begin with.
   */
  deleteRecording(
    outputDirectory: string,
    recordingId: string
  ): Promise<boolean>;

  /**
   * Walks every folder under `outputDirectory` and returns one entry for every file that
   * needs a PUT: every segment referenced by a manifest that does not yet have a
   * `${filename}.uploaded` sentinel next to it, plus one `'manifest'` entry per folder
   * whose manifest itself is unsent (the manifest sentinel is `manifest.m3u8.uploaded`).
   *
   * Call this on launch after a crash, and after long offline periods. Sealed folders
   * are included until every one of their entries has a sentinel — at which point they
   * become eligible for local cleanup by your app.
   *
   * The returned list is a snapshot; nothing native is retried by Anvil itself. Your JS
   * loops the list, PUTs each `filePath` to the bucket, and calls
   * `markSegmentUploaded` (for segments) after each success. Fire and forget the
   * manifest PUT — subsequent segment PUTs will retry it implicitly.
   */
  retryPendingUploads(outputDirectory: string): Promise<PendingUpload[]>;

  /**
   * Writes the `${filename}.uploaded` sentinel in the recording's folder from OUTSIDE
   * a recorder instance — pair with `retryPendingUploads` on launch, where no
   * `AnvilRecorder` exists yet. During active capture, prefer
   * {@linkcode AnvilRecorder.markSegmentUploaded} which is equivalent and doesn't
   * require `outputDirectory` + `recordingId`.
   *
   * Idempotent.
   */
  markSegmentUploaded(
    outputDirectory: string,
    recordingId: string,
    filename: string
  ): Promise<void>;
}
