import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * Where a runtime failure came from.
 *
 * - `engine`: the native capture engine failed to (re)start
 * - `io`: writing to the segment file failed
 * - `storage`: the disk is full
 * - `session`: the OS audio session could not be configured/activated
 * - `permission`: microphone permission is missing or was revoked
 * - `state`: an operation was called in the wrong state
 *
 * @see {@linkcode RecorderError.code}
 */
export type RecorderErrorCode =
  'engine' | 'io' | 'storage' | 'session' | 'permission' | 'state';

/**
 * Emitted by {@linkcode AnvilRecorder.addErrorListener} for failures that happen
 * outside of a method call (inside the capture pipeline). Method-call failures reject their promise instead.
 */
export interface RecorderError {
  code: RecorderErrorCode;
  message: string;
  /**
   * Position on the recording timeline (media time) in milliseconds.
   */
  timestampMs: number;
}
