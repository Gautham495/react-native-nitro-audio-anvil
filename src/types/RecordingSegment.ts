import type { AnvilInterruptionReason } from './AnvilInterruptionEvent';
import type { AnvilRecorder } from '../specs/AnvilRecorder.nitro';

/**
 * One finalized ADTS AAC segment on disk. Every segment file is a valid, playable AAC
 * stream in isolation (mono, `sampleRate` Hz, LC profile, ADTS-framed).
 *
 * The segment lives at `${folderPath}/${filename}`. Both are absolute-path safe:
 * `filename` is what appears in the manifest, `filePath` is what you hand to an
 * HTTP client or file API. You never need to reconstruct one from the other.
 *
 * @see {@linkcode AnvilRecorder.addSegmentCompletedListener}
 */
export interface RecordingSegment {
  /**
   * Zero-based index across the LIFETIME of the recording, in monotonic order.
   * Continues across resumes — `00007.aac` follows `00006.aac` regardless of which
   * run session captured it.
   */
  index: number;
  /**
   * The segment's file name relative to the recording folder — always
   * `${index}.aac` zero-padded to five digits, e.g. `00003.aac`. This is exactly the
   * string that appears after the segment's `#EXTINF` line in `manifest.m3u8`.
   */
  filename: string;
  /**
   * Absolute path of the segment file, ready to hand to `fetch`/`react-native-blob-util`
   * for a PUT to a bucket.
   */
  filePath: string;
  sampleRate: number;
  durationMs: number;
  fileSize: number;
  /**
   * Where this segment starts on the recording timeline (media time) in milliseconds.
   * Media time only advances while capturing, so it matches the audio your PCM listener
   * received.
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
   * `true` when this segment was closed because the OS interrupted capture. A
   * `#EXT-X-DISCONTINUITY` is written before the next segment.
   */
  wasInterrupted: boolean;
  interruptionReason?: AnvilInterruptionReason;
  /**
   * `true` when this segment was closed because the input device changed. A
   * `#EXT-X-DISCONTINUITY` is written before the next segment.
   */
  routeChanged: boolean;
  /**
   * Lowercase hex SHA-256 of the finalized file. Useful for upload integrity checks
   * (`If-Match`, `Content-MD5` equivalents) and dedup on the bucket side.
   */
  sha256: string;
}
