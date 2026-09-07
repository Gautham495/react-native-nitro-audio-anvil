import type { RecordingSegment } from '../types/RecordingSegment';
import type { OrphanedRecording } from '../types/OrphanedRecording';

/**
 * One logical recording as your app sees it — a "meeting", a "call", a "session" — that may span multiple
 * Anvil sessions because of app crashes, force-quits or reboots between them.
 *
 * The `logicalId` is your product-level id (meetingId, callId, whatever). Anvil doesn't
 * care what it means; it only uses it to group sessions on relaunch.
 */
export interface RecoveredRecording {
  /**
   * Your product-level id. The same id you passed to `beginRecording()` before the crash.
   */
  logicalId: string;
  /**
   * Every session that belonged to this logical recording, in wall-clock order.
   * A single logical recording has one session on the happy path; two or more when the
   * app crashed and was reopened.
   */
  sessions: RecoveredSession[];
  /**
   * Every segment file across every session, already in playback order.
   * Concatenate these on the server for the full recording.
   */
  segments: RecordingSegment[];
  /**
   * Sum of `durationMs` across all segments. Media time, not wall-clock.
   */
  totalDurationMs: number;
}

export interface RecoveredSession {
  sessionId: string;
  segments: RecordingSegment[];
  /** Wall-clock ms of the earliest segment's `startedAt`. */
  startedAt: number;
  /** Wall-clock ms of the latest segment's `endedAt`. */
  endedAt: number;
}

/**
 * State stored under `<outputDirectory>/<sessionId>.recording.json` — a tiny JSON marker
 * so `discoverRecoveredRecordings` can group Anvil sessions back into your product-level
 * logical recordings on relaunch. Written by `beginRecording()`, deleted by `endRecording()`.
 */
export interface RecoveryMarker {
  logicalId: string;
  sessionId: string;
  createdAt: number;
}

/**
 * Passed to `RecoveryStore.load` to build a `RecoveredRecording` from raw orphans.
 */
export interface OrphanWithMarker {
  orphan: OrphanedRecording;
  marker: RecoveryMarker | null;
}
