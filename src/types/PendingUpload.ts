import type { AnvilFactory } from '../specs/AnvilFactory.nitro';

/**
 * What kind of file a `PendingUpload` refers to.
 *
 * - `'segment'` — an `.aac` file inside the recording folder.
 * - `'manifest'` — the folder's `manifest.m3u8`.
 */
export type PendingUploadKind = 'segment' | 'manifest';

/**
 * One file that should be re-PUT to the bucket. Returned by
 * {@linkcode AnvilFactory.retryPendingUploads} for every segment referenced by a
 * folder's manifest that does not yet have a `.uploaded` sentinel next to it, plus
 * one entry per unsealed manifest.
 *
 * `kind` tells your uploader which endpoint / content-type to use.
 *
 * When your uploader succeeds:
 * - For `'segment'`: call `Anvil.markSegmentUploaded(outputDirectory, recordingId, filename)`.
 * - For `'manifest'`: nothing to do — the manifest is idempotently re-uploaded on the
 *   next segment success anyway, and once the recording is sealed and every segment has
 *   its sentinel, the whole folder becomes eligible for local cleanup.
 */
export interface PendingUpload {
  recordingId: string;
  kind: PendingUploadKind;
  /**
   * Name relative to the recording folder — `00007.aac` or `manifest.m3u8`. The exact
   * key you should use on the bucket (`${recordingId}/${filename}`).
   */
  filename: string;
  /**
   * Absolute path of the file to upload, ready for a file-streaming HTTP client.
   */
  filePath: string;
  /**
   * File size in bytes at the time of listing. May be slightly stale for a manifest that
   * is being rewritten concurrently — retry on next launch if the PUT rejects.
   */
  fileSize: number;
}
