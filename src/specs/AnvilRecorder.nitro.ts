import type { HybridObject } from 'react-native-nitro-modules';

import type { ListenerSubscription } from '../types/ListenerSubscription';

import type { RecorderState } from '../types/RecorderState';

import type { RecordingSegment } from '../types/RecordingSegment';

import type { PCMChunk } from '../types/PCMChunk';

import type { SpeakerWindow } from '../types/SpeakerWindow';

import type { InterruptionEvent } from '../types/InterruptionEvent';

import type { RouteChangeEvent } from '../types/RouteChangeEvent';

import type { PermissionStatus } from '../types/PermissionStatus';

import type { StorageWarningEvent } from '../types/StorageWarningEvent';

import type { RecorderError } from '../types/RecorderError';

/**
 * A corruption-proof microphone recorder.
 *
 * PCM goes straight to disk as WAV, the header is patched and the file is `fsync`ed every
 * `fsyncIntervalMs`, and files are rotated every `segmentDurationMs`. Every file on disk is
 * playable at every instant, so a crash, kill, call, or power loss can never corrupt a recording.
 *
 * Two live streams are fanned out from the same capture:
 * - {@linkcode AnvilRecorder.addPCMListener} — small chunks for streaming speech-to-text
 * - {@linkcode AnvilRecorder.addSpeakerWindowListener} — overlapping windows for speaker embedding
 *
 * Create one with `Anvil.createRecorder(config)`.
 */
export interface AnvilRecorder extends HybridObject<{
  ios: 'swift';
  android: 'kotlin';
}> {
  /**
   * Unique id of this session. Segment files are named `<sessionId>-<index>.wav`.
   */
  readonly sessionId: string;
  /**
   * Current lifecycle state. Snapshot; may lag the native side by one buffer.
   */
  readonly state: RecorderState;
  /**
   * Total captured media time in milliseconds (does not advance while paused or interrupted).
   */
  readonly totalDurationMs: number;
  /**
   * Path of the segment being written, or `''` when no segment is open.
   */
  readonly currentSegmentPath: string;

  /**
   * Activates the audio session, opens the first segment and starts capture.
   * Rejects if permission is not granted or the session cannot be configured.
   */
  start(): Promise<void>;
  /**
   * Finalizes the current segment and stops capture. Media time stops advancing.
   */
  pause(): Promise<void>;
  /**
   * Opens a new segment and restarts capture. Valid from `paused` and `interrupted`.
   */
  resume(): Promise<void>;
  /**
   * Finalizes the open segment, releases the audio session and resolves with every segment of this session.
   * The recorder cannot be started again afterwards.
   */
  stop(): Promise<RecordingSegment[]>;
  /**
   * Finalizes the current segment now and opens the next one. Resolves with the finalized segment.
   */
  rotateSegment(): Promise<RecordingSegment>;
  /**
   * Writes the audio between two media-time positions into a new WAV file and resolves with its path.
   * Use it to re-send audio after a streaming socket disconnect. Works while recording.
   */
  extractRange(startMs: number, endMs: number): Promise<string>;

  /**
   * Live PCM chunks for streaming transcription. Do not block inside the listener.
   */
  addPCMListener(listener: (chunk: PCMChunk) => void): ListenerSubscription;
  /**
   * Overlapping PCM windows for speaker embedding.
   */
  addSpeakerWindowListener(
    listener: (window: SpeakerWindow) => void
  ): ListenerSubscription;
  /**
   * OS interruptions (calls, Siri, alarms, focus loss, media-server reset).
   */
  addInterruptionListener(
    listener: (event: InterruptionEvent) => void
  ): ListenerSubscription;
  /**
   * Input device changes (Bluetooth, headset, speaker).
   */
  addRouteChangeListener(
    listener: (event: RouteChangeEvent) => void
  ): ListenerSubscription;
  /**
   * Microphone permission changes, checked whenever capture (re)starts.
   */
  addPermissionChangeListener(
    listener: (status: PermissionStatus) => void
  ): ListenerSubscription;
  /**
   * Free disk space dropped below `storageWarningBytes`.
   */
  addStorageWarningListener(
    listener: (event: StorageWarningEvent) => void
  ): ListenerSubscription;
  /**
   * A segment file was finalized (time rotation, pause, interruption, route change, stop).
   */
  addSegmentCompletedListener(
    listener: (segment: RecordingSegment) => void
  ): ListenerSubscription;
  /**
   * Failures inside the capture pipeline.
   */
  addErrorListener(
    listener: (error: RecorderError) => void
  ): ListenerSubscription;
}
