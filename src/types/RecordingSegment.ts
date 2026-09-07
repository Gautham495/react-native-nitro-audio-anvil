import type { AnvilInterruptionReason } from './AnvilInterruptionEvent';
import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * One finalized WAV file on disk. Mono, 16-bit PCM, header valid.
 *
 * @see {@linkcode AnvilRecorder.stop}
 */
export interface RecordingSegment {
  /**
   * Zero-based index within the session, in recording order.
   */
  index: number;
  /**
   * Absolute file path.
   */
  filePath: string;
  sampleRate: number;
  durationMs: number;
  fileSize: number;
  /**
   * Where this segment starts on the recording timeline (media time) in milliseconds.
   * Media time only advances while capturing, so it matches the audio you streamed.
   */
  mediaStartMs: number;
  /**
   * Wall-clock start, Unix epoch milliseconds.
   */
  startedAt: number;
  /**
   * Wall-clock end, Unix epoch milliseconds.
   */
  endedAt: number;
  /**
   * `true` when this segment was closed because the OS interrupted capture.
   */
  wasInterrupted: boolean;
  interruptionReason?: AnvilInterruptionReason;
  /**
   * `true` when this segment was closed because the input device changed.
   */
  routeChanged: boolean;
  /**
   * Lowercase hex SHA-256 of the finalized file, for upload integrity checks.
   */
  sha256: string;
}
