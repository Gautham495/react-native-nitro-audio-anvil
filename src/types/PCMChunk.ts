import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * A chunk of the live PCM stream. Mono, 16-bit little-endian PCM at the configured sample rate —
 * send `buffer` directly to a streaming speech-to-text socket.
 *
 * @see {@linkcode AnvilRecorder.addPCMListener}
 */
export interface PCMChunk {
  buffer: ArrayBuffer;
  /**
   * Position of the first sample on the recording timeline (media time) in milliseconds.
   */
  timestampMs: number;
  durationMs: number;
  /**
   * Monotonic counter starting at 0. A gap means you missed a chunk; recover it with `extractRange`.
   */
  sequenceNumber: number;
}
