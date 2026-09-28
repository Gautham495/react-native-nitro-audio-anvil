import type { RecordingSegment } from './RecordingSegment';
import type { AnvilFactory } from '../specs/AnvilFactory.nitro';

/**
 * A recording folder found on disk whose `manifest.m3u8` is unsealed — the previous run
 * of the app died before `stop()` reached `#EXT-X-ENDLIST`.
 *
 * Returned by {@linkcode AnvilFactory.discoverOrphanedRecordings}. One folder = one
 * recording. The integrator's next step is exactly one of:
 * - Resume: `Anvil.createRecorder({ recordingId, resume: true, ... })` then `start()`.
 * - Finalize as-is: `Anvil.concatenate(outputDirectory, recordingId, dest)` then upload,
 *   then `Anvil.deleteRecording(outputDirectory, recordingId)`.
 * - Discard: `Anvil.deleteRecording(outputDirectory, recordingId)`.
 *
 * Before this object is returned Anvil has already:
 * - Verified every segment referenced by the manifest exists and has a valid ADTS header.
 * - Rolled any unreferenced trailing `.aac` file into the manifest if its ADTS frames
 *   parse cleanly, or deleted it if they do not.
 * - Fsynced the manifest if it was modified.
 *
 * @see {@linkcode AnvilFactory.discoverOrphanedRecordings}
 */
export interface RecoveredRecording {
  /**
   * The recording's id — the folder name under `outputDirectory`. Exactly the string the
   * integrator originally passed to `createRecorder`.
   */
  recordingId: string;
  /**
   * Absolute path of the recording folder, e.g.
   * `${outputDirectory}/${recordingId}`.
   */
  folderPath: string;
  /**
   * Absolute path of `manifest.m3u8` inside `folderPath`.
   */
  manifestPath: string;
  /**
   * Every segment referenced by the current manifest, in playback order.
   */
  segments: RecordingSegment[];
  /**
   * Sum of segment durations. Media time, not wall-clock.
   */
  totalDurationMs: number;
  /**
   * `true` when the manifest's last segment is followed by (or itself carries the flag of)
   * a `#EXT-X-DISCONTINUITY` — the previous run ended on an interruption or a route
   * change, not a clean rotation.
   */
  wasInterrupted: boolean;
}
