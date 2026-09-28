import type { HybridObject } from 'react-native-nitro-modules';
import type { AnvilListenerSubscription } from '../types/AnvilListenerSubscription';
import type { RecorderState } from '../types/RecorderState';
import type { RecordingSegment } from '../types/RecordingSegment';
import type { PCMChunk } from '../types/PCMChunk';
import type { SpeakerWindow } from '../types/SpeakerWindow';
import type { AnvilInterruptionEvent } from '../types/AnvilInterruptionEvent';
import type { RouteChangeEvent } from '../types/RouteChangeEvent';
import type { AnvilPermissionStatus } from '../types/AnvilPermissionStatus';
import type { StorageWarningEvent } from '../types/StorageWarningEvent';
import type { RecorderError } from '../types/RecorderError';

/**
 * A single recording.
 *
 * Every recorder owns one folder at `${outputDirectory}/${recordingId}/` and everything
 * about the recording lives inside it: `manifest.m3u8` and the `%05d.aac` segments the
 * manifest references. That is the entire durable state — no sidecar markers, no
 * cross-folder registry, no session ids anywhere the integrator sees.
 *
 * Three streams are fanned out from the same capture and never wait on each other:
 * - {@linkcode AnvilRecorder.addPCMListener} — raw PCM chunks for streaming
 *   speech-to-text.
 * - {@linkcode AnvilRecorder.addSpeakerWindowListener} — overlapping PCM windows for
 *   speaker embedding.
 * - The on-disk AAC pipeline — writes ADTS AAC segments and updates `manifest.m3u8`.
 *
 * Every segment close fires {@linkcode AnvilRecorder.addSegmentCompletedListener} with the
 * segment's `filePath`, and every manifest write fires
 * {@linkcode AnvilRecorder.addManifestUpdatedListener} with the manifest's `filePath`.
 * Bucket sync lives entirely in your JS: PUT the paths you receive, call
 * {@linkcode AnvilRecorder.markSegmentUploaded} when the segment PUT resolves.
 *
 * Create one with `Anvil.createRecorder(config)`.
 */
export interface AnvilRecorder
  extends HybridObject<{
    ios: 'swift';
    android: 'kotlin';
  }> {
  /**
   * The recording's id — the folder name and exactly the string you passed to
   * `createRecorder`.
   */
  readonly recordingId: string;
  /**
   * Absolute path of the recording folder,
   * `${outputDirectory}/${recordingId}/`.
   */
  readonly folderPath: string;
  /**
   * Absolute path of the folder's `manifest.m3u8`. Exists on disk from the moment the
   * first segment is finalized.
   */
  readonly manifestPath: string;
  /**
   * Current lifecycle state. Snapshot; may lag the native side by one buffer.
   */
  readonly state: RecorderState;
  /**
   * Total captured media time in milliseconds. Does not advance while paused or
   * interrupted.
   */
  readonly totalDurationMs: number;
  /**
   * Absolute path of the segment being written, or `''` when no segment is open.
   */
  readonly currentSegmentPath: string;

  /**
   * Activates the audio session, opens the first segment and starts capture. When the
   * recorder was created with `resume: true`, the first new segment is preceded by a
   * `#EXT-X-DISCONTINUITY` in the manifest.
   * Rejects if permission is not granted or the audio session cannot be configured.
   */
  start(): Promise<void>;
  /**
   * Finalizes the current segment, updates the manifest and stops capture. Media time
   * stops advancing.
   */
  pause(): Promise<void>;
  /**
   * Opens a new segment and restarts capture. Valid from `paused` and `interrupted`.
   * A `#EXT-X-DISCONTINUITY` is written before the new segment when resuming from
   * `interrupted`, not on a plain pause/resume.
   */
  resume(): Promise<void>;
  /**
   * Finalizes the open segment, appends `#EXT-X-ENDLIST` to the manifest, releases the
   * audio session and resolves with every segment of this recording (from index 0,
   * across resumes). The recorder cannot be started again afterwards.
   *
   * Resolves after the local seal completes. Any bucket uploads triggered by the final
   * manifest event run in your JS on their own — `stop()` does not wait for them.
   */
  stop(): Promise<RecordingSegment[]>;
  /**
   * Finalizes the current segment now and opens the next one. Resolves with the
   * finalized segment. No discontinuity marker is written for a manual rotation.
   */
  rotateSegment(): Promise<RecordingSegment>;

  /**
   * Writes a `${filename}.uploaded` sentinel file next to the segment. Call this after
   * your PUT to R2 / S3 / … resolves. On the next launch,
   * {@linkcode import('./AnvilFactory.nitro').AnvilFactory.retryPendingUploads} skips
   * segments that already have a sentinel and returns everything else.
   *
   * Idempotent — a duplicate call for an already-marked segment is a no-op.
   * Rejects only for I/O errors on the sentinel write itself; the recording is
   * unaffected either way.
   */
  markSegmentUploaded(filename: string): Promise<void>;

  /**
   * Live PCM chunks for streaming transcription. Do not block inside the listener.
   */
  addPCMListener(
    listener: (chunk: PCMChunk) => void
  ): AnvilListenerSubscription;
  /**
   * Overlapping PCM windows for speaker embedding.
   */
  addSpeakerWindowListener(
    listener: (window: SpeakerWindow) => void
  ): AnvilListenerSubscription;
  /**
   * OS interruptions (calls, Siri, alarms, focus loss, media-server reset).
   */
  addInterruptionListener(
    listener: (event: AnvilInterruptionEvent) => void
  ): AnvilListenerSubscription;
  /**
   * Input device changes (Bluetooth, headset, speaker). Rotates the current segment
   * when the active input actually changed.
   */
  addRouteChangeListener(
    listener: (event: RouteChangeEvent) => void
  ): AnvilListenerSubscription;
  /**
   * Microphone permission changes, checked whenever capture (re)starts.
   */
  addPermissionChangeListener(
    listener: (status: AnvilPermissionStatus) => void
  ): AnvilListenerSubscription;
  /**
   * Free disk space dropped below `storageWarningBytes`.
   */
  addStorageWarningListener(
    listener: (event: StorageWarningEvent) => void
  ): AnvilListenerSubscription;
  /**
   * A segment file was finalized (time rotation, pause, interruption, route change,
   * stop). The listener receives the finalized segment with its `filePath` and
   * `filename` — everything you need to PUT it to a bucket.
   */
  addSegmentCompletedListener(
    listener: (segment: RecordingSegment) => void
  ): AnvilListenerSubscription;
  /**
   * The `manifest.m3u8` file was rewritten atomically (tmp + rename + fsync). The
   * listener receives the manifest's absolute file path. Fires after every segment
   * close and once more on `stop()` when `#EXT-X-ENDLIST` is appended.
   *
   * Use this to PUT the manifest to your bucket alongside each segment upload — HLS
   * players will see the new segment as soon as the manifest that references it
   * lands remotely.
   */
  addManifestUpdatedListener(
    listener: (manifestPath: string) => void
  ): AnvilListenerSubscription;
  /**
   * Failures inside the capture pipeline.
   */
  addErrorListener(
    listener: (error: RecorderError) => void
  ): AnvilListenerSubscription;
}
