import type { HybridObject } from 'react-native-nitro-modules';
import type { AnvilRecorder } from './AnvilRecorder.nitro';
import type { RecorderConfig } from '../types/RecorderConfig';
import type { AnvilPermissionStatus } from '../types/AnvilPermissionStatus';
import type { OrphanedRecording } from '../types/OrphanedRecording';
import type { RecordingSegment } from '../types/RecordingSegment';

/**
 * Root object of react-native-nitro-audio-anvil. Exported from the package as `Anvil`.
 *
 * @see {@linkcode AnvilFactory.createRecorder}
 */
export interface AnvilFactory extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  /**
   * Validates the config and creates a recorder in `idle` state. Call `start()` on the result.
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
   * Finds sessions in `directory` that never reached `stop()`, repairs their WAV headers,
   * clears their markers and resolves with them. Call once on app launch.
   */
  discoverOrphanedRecordings(directory: string): Promise<OrphanedRecording[]>;
  /**
   * Joins segment WAV files (same sample rate, in the order given) into one WAV at `outputPath`
   * and resolves with its metadata. Use after `stop()` or after recovery whenever you need a single
   * file for playback or upload. Streams from disk; no full-file memory use.
   */
  concatenate(
    segmentPaths: string[],
    outputPath: string
  ): Promise<RecordingSegment>;
}
