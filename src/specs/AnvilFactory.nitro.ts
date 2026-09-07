import type { HybridObject } from 'react-native-nitro-modules';

import type { AnvilRecorder } from './AnvilRecorder.nitro';

import type { RecorderConfig } from '../types/RecorderConfig';

import type { PermissionStatus } from '../types/PermissionStatus';

import type { OrphanedRecording } from '../types/OrphanedRecording';

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
  getPermissionStatus(): PermissionStatus;
  /**
   * Prompts for microphone permission if undetermined and resolves with the result.
   */
  requestPermission(): Promise<PermissionStatus>;
  /**
   * Finds sessions in `directory` that never reached `stop()`, repairs their WAV headers,
   * clears their markers and resolves with them. Call once on app launch.
   */
  discoverOrphanedRecordings(directory: string): Promise<OrphanedRecording[]>;
}
