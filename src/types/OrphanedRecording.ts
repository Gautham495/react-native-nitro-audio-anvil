import type { RecordingSegment } from './RecordingSegment';

import type { AnvilFactory } from '../specs/AnvilFactory.nitro';

/**
 * Segment files from a session that never reached `stop()` (app crash, force quit, battery death).
 * Headers are repaired before they are returned, so every file is playable.
 *
 * @see {@linkcode AnvilFactory.discoverOrphanedRecordings}
 */
export interface OrphanedRecording {
  sessionId: string;
  segments: RecordingSegment[];
}
