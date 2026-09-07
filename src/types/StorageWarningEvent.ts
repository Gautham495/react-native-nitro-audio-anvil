import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * Emitted by {@linkcode AnvilRecorder.addStorageWarningListener} when free disk space
 * drops below the configured threshold. Checked at start and at every segment rotation.
 */
export interface StorageWarningEvent {
  freeBytes: number;
  thresholdBytes: number;
}
