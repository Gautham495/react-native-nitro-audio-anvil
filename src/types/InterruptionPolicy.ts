import type { RecorderConfig } from './RecorderConfig';

/**
 * What the recorder does when an OS interruption ends and the OS says capture may resume.
 *
 * - `resume`: automatically open a new segment and continue recording
 * - `hold`: stay in `interrupted` state until the app calls `resume()` or `stop()`
 *
 * @see {@linkcode RecorderConfig.onInterruption}
 */
export type InterruptionPolicy = 'resume' | 'hold';
