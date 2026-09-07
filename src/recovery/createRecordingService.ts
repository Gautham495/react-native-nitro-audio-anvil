import { Anvil } from '../Anvil';

import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

import type { RecorderConfig } from '../types/RecorderConfig';

import type { RecordingSegment } from '../types/RecordingSegment';

import type { MarkerStore, RecordingService } from './RecordingService';

import type { RecoveredRecording, RecoveredSession } from './types';

/**
 * Concrete implementation of `RecordingService`. Owns one active recorder and one marker
 * per logical recording. Not thread-safe on the JS side — treat it as a singleton.
 */
export function createRecordingService(options: {
  outputDirectory: string;
  markerStore: MarkerStore;
}): RecordingService {
  let activeRecorder: AnvilRecorder | null = null;
  let activeLogicalId: string | null = null;
  let activeSessionId: string | null = null;

  return {
    get active() {
      return activeRecorder;
    },
    get activeLogicalId() {
      return activeLogicalId;
    },

    async begin(input: {
      logicalId: string;
      config: RecorderConfig;
    }): Promise<AnvilRecorder> {
      if (activeRecorder !== null) {
        throw new Error(
          `Recording ${activeLogicalId ?? '?'} is already active — call end() first`
        );
      }
      const recorder = await Anvil.createRecorder(input.config);
      // Marker written BEFORE start(): a crash in the millisecond between now and start()
      // still leaves a marker for a session that produced no audio, which the recovery loop
      // treats as "empty session" and ignores.
      await options.markerStore.write({
        logicalId: input.logicalId,
        sessionId: recorder.sessionId,
        createdAt: Date.now(),
      });
      try {
        await recorder.start();
      } catch (error) {
        await options.markerStore.delete(recorder.sessionId).catch(() => {});
        throw error;
      }
      activeRecorder = recorder;
      activeLogicalId = input.logicalId;
      activeSessionId = recorder.sessionId;
      return recorder;
    },

    async end(): Promise<RecordingSegment[]> {
      const recorder = activeRecorder;
      const sessionId = activeSessionId;
      if (recorder === null || sessionId === null) return [];
      let segments: RecordingSegment[];
      try {
        segments = await recorder.stop();
      } finally {
        activeRecorder = null;
        activeLogicalId = null;
        activeSessionId = null;
      }
      // Delete marker only after stop() resolved — if stop() throws, the marker stays and
      // the next launch picks up whatever the native side already fsynced.
      await options.markerStore.delete(sessionId).catch(() => {});
      return segments;
    },

    async recoverPendingRecordings(
      onRecovered: (recording: RecoveredRecording) => Promise<void> | void
    ): Promise<void> {
      const [markers, orphans] = await Promise.all([
        options.markerStore.list(),
        Anvil.discoverOrphanedRecordings(options.outputDirectory),
      ]);
      const markerBySession = new Map(
        markers.map((marker) => [marker.sessionId, marker])
      );

      // Group orphaned Anvil sessions by their product-level logicalId.
      const groups = new Map<string, RecoveredSession[]>();
      const unrecognized: RecoveredSession[] = [];
      for (const orphan of orphans) {
        if (orphan.segments.length === 0) {
          // Empty session from a crash between marker-write and first fsync — clean up its marker.
          await options.markerStore.delete(orphan.sessionId).catch(() => {});
          continue;
        }
        const session = toRecoveredSession(orphan.sessionId, orphan.segments);
        const marker = markerBySession.get(orphan.sessionId);
        if (marker === undefined) {
          unrecognized.push(session);
          continue;
        }
        const bucket = groups.get(marker.logicalId);
        if (bucket === undefined) {
          groups.set(marker.logicalId, [session]);
        } else {
          bucket.push(session);
        }
      }

      // Deliver every logical recording (marker-backed first, then unrecognized as their own).
      for (const [logicalId, sessions] of groups) {
        sessions.sort((a, b) => a.startedAt - b.startedAt);
        await onRecovered(toRecoveredRecording(logicalId, sessions));
      }
      for (const session of unrecognized) {
        await onRecovered(
          toRecoveredRecording(`orphan:${session.sessionId}`, [session])
        );
      }

      // Clean up markers only after the callback has resolved for each logical recording.
      // If your callback threw, markers stay and you get another try on the next launch.
      for (const [, sessions] of groups) {
        for (const session of sessions) {
          await options.markerStore.delete(session.sessionId).catch(() => {});
        }
      }
    },
  };
}

function toRecoveredSession(
  sessionId: string,
  segments: RecordingSegment[]
): RecoveredSession {
  const sorted = [...segments].sort((a, b) => a.mediaStartMs - b.mediaStartMs);
  const startedAt = sorted[0]?.startedAt ?? 0;
  const endedAt = sorted[sorted.length - 1]?.endedAt ?? startedAt;
  return { sessionId, segments: sorted, startedAt, endedAt };
}

function toRecoveredRecording(
  logicalId: string,
  sessions: RecoveredSession[]
): RecoveredRecording {
  const segments = sessions.flatMap((session) => session.segments);
  const totalDurationMs = segments.reduce(
    (sum, segment) => sum + segment.durationMs,
    0
  );
  return { logicalId, sessions, segments, totalDurationMs };
}
