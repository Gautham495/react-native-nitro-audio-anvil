import {
  type AnvilRecorder,
  type RecorderConfig,
  type RecordingSegment,
} from '../index';

import type { RecoveryMarker } from './types';

/**
 * Reads and writes the recovery marker files that let `discoverRecoveredRecordings` group
 * Anvil sessions back into your product-level logical recordings after a crash.
 *
 * Uses the filesystem (not a key-value store) so recovery works even if app storage corrupts, and so
 * markers travel with the audio files if the user relocates them.
 */
export interface MarkerStore {
  write(marker: RecoveryMarker): Promise<void>;
  read(sessionId: string): Promise<RecoveryMarker | null>;
  delete(sessionId: string): Promise<void>;
  list(): Promise<RecoveryMarker[]>;
}

/**
 * The single entry point for recording a "meeting" (or whatever your app calls it) with
 * crash-recovery baked in. Owns one active `AnvilRecorder` at a time.
 *
 * Usage:
 *   const service = createRecordingService({ outputDirectory, markerStore })
 *   await service.recoverPendingRecordings((rec) => uploadStitched(rec))
 *   const recorder = await service.begin({ logicalId: meetingId, config })
 *   const segments = await service.end()
 */
export interface RecordingService {
  /** The active recorder, or null when nothing is being recorded. */
  readonly active: AnvilRecorder | null;
  /** The logical id passed to `begin()`, or null when nothing is being recorded. */
  readonly activeLogicalId: string | null;

  /**
   * Creates a recorder, writes the recovery marker and starts capture.
   * Rejects if another recording is already active (call `end()` first).
   */
  begin(input: {
    logicalId: string;
    config: RecorderConfig;
  }): Promise<AnvilRecorder>;

  /**
   * Stops the active recorder, deletes its recovery marker and resolves with the segments.
   */
  end(): Promise<RecordingSegment[]>;

  /**
   * On app launch: finds every logical recording that never called `end()`, groups the
   * Anvil sessions by `logicalId`, and calls `onRecovered` once per logical recording so you
   * can upload / stitch / prompt the user.
   *
   * Safe to call on every launch — it's a no-op when there is nothing pending.
   */
  recoverPendingRecordings(
    onRecovered: (
      recording: import('./types').RecoveredRecording
    ) => Promise<void> | void
  ): Promise<void>;
}
