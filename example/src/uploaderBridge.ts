import ReactNativeBlobUtil from 'react-native-blob-util';
import { CloudUploader } from 'react-native-nitro-cloud-uploader';
import {
  Anvil,
  type RecordingSegment,
  type PendingUpload,
} from 'react-native-nitro-audio-anvil';

// ---------------------------- config ----------------------------

const BASE_URL = 'https://api.gauthamvijay.com/r2-uploader';
const CHUNK_SIZE = 5 * 1024 * 1024;
const PARALLEL_CHUNKS = 3;

// Retries for per-file PUTs (both HLS and single archive). Backoff: 400ms, 1200ms, 3600ms.
const PUT_MAX_ATTEMPTS = 4;
const PUT_BACKOFF_BASE_MS = 400;

// ---------------------------- types ----------------------------

export interface UploadProgress {
  fraction: number;
  bytesUploaded: number;
  totalBytes: number;
}

export interface UploadOptions {
  uploadId: string;
  filePath: string;
  fileSize: number;
  fileName: string;
  onProgress: (progress: UploadProgress) => void;
}

export interface HlsPutInput {
  recordingId: string;
  filename: string;
  filePath: string;
  contentType?: string;
}

/** Thrown when a PUT fails after all retries. Includes context for logging. */
export class UploadError extends Error {
  readonly kind: 'hls' | 'single' | 'multipart';
  readonly recordingId?: string;
  readonly filename?: string;
  readonly status?: number;
  readonly attempts: number;
  readonly responseBody?: string;
  constructor(input: {
    kind: 'hls' | 'single' | 'multipart';
    recordingId?: string;
    filename?: string;
    status?: number;
    attempts: number;
    responseBody?: string;
    cause: unknown;
  }) {
    const label = input.filename ?? input.recordingId ?? '(archive)';
    super(
      `${input.kind} upload failed for ${label} ` +
        `after ${input.attempts} attempt(s)` +
        (input.status != null ? ` (last status: ${input.status})` : '') +
        (input.responseBody
          ? `: ${input.responseBody.slice(0, 200)}`
          : `: ${
              input.cause instanceof Error
                ? input.cause.message
                : String(input.cause)
            }`)
    );
    this.kind = input.kind;
    this.recordingId = input.recordingId;
    this.filename = input.filename;
    this.status = input.status;
    this.attempts = input.attempts;
    this.responseBody = input.responseBody;
  }
}

// ---------------------------- shared helpers ----------------------------

function stripFileScheme(path: string): string {
  return path.replace(/^file:\/\//, '');
}

function inferContentType(filename: string): string {
  if (filename.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (filename.endsWith('.aac')) return 'audio/aac';
  if (filename.endsWith('.wav')) return 'audio/wav';
  return 'application/octet-stream';
}

function shouldRetryStatus(status: number): boolean {
  // 5xx and 429 are worth retrying; other 4xx are permanent (bad presign, bad key,
  // missing bucket permission). 2xx obviously not.
  return status === 429 || (status >= 500 && status < 600);
}

async function readBodySafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// ---------------------------- HLS per-file upload ----------------------------

/**
 * Ask the backend for a presigned PUT URL for a single object inside a recording folder.
 * Backend contract (matches r2UploaderRoute):
 *   POST /hls-put-url { recordingId, filename, contentType }
 *   → 200 { recordingId, filename, objectKey, url, publicUrl, contentType }
 */
async function presignHlsPut(input: {
  recordingId: string;
  filename: string;
  contentType: string;
}): Promise<{ url: string; publicUrl: string }> {
  const response = await fetch(`${BASE_URL}/hls-put-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = await readBodySafe(response);
    throw new Error(
      `POST /hls-put-url → ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
    );
  }

  const parsed = (await response.json()) as {
    url: string;
    publicUrl: string;
  };

  if (!parsed.url || !parsed.publicUrl) {
    throw new Error(
      `POST /hls-put-url → 200 but missing url/publicUrl in body`
    );
  }
  return parsed;
}

/**
 * PUT one HLS artifact — a `.aac` segment or `manifest.m3u8` — to R2.
 *
 * Streams from disk via `ReactNativeBlobUtil.wrap`, no bytes cross the JS heap.
 * Retries on network errors, 5xx, and 429 with exponential backoff. 4xx (other than
 * 429) fails fast — those aren't going to become 200 by retrying.
 *
 * Does NOT write the `.uploaded` sentinel — call `syncSegment` / `syncManifest` for
 * that (they know the correct three-arg `Anvil.markSegmentUploaded` signature).
 */
export async function putHlsFile(input: HlsPutInput): Promise<{ url: string }> {
  const contentType = input.contentType ?? inferContentType(input.filename);
  const localPath = stripFileScheme(input.filePath);

  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= PUT_MAX_ATTEMPTS; attempt++) {
    try {
      const { url, publicUrl } = await presignHlsPut({
        recordingId: input.recordingId,
        filename: input.filename,
        contentType,
      });

      const response = await ReactNativeBlobUtil.fetch(
        'PUT',
        url,
        { 'Content-Type': contentType },
        ReactNativeBlobUtil.wrap(localPath)
      );

      const status = response.info().status;
      lastStatus = status;

      if (status >= 200 && status < 300) {
        return { url: publicUrl };
      }

      // Read the failed response for the error message — R2 usually returns XML
      // with an error code (SignatureDoesNotMatch, AccessDenied, NoSuchBucket…).
      try {
        lastBody = response.text();
      } catch {
        lastBody = undefined;
      }
      lastError = new Error(`PUT ${input.filename} → ${status}`);

      if (!shouldRetryStatus(status)) break;
    } catch (err) {
      lastError = err;
    }

    if (attempt < PUT_MAX_ATTEMPTS) {
      const delayMs = PUT_BACKOFF_BASE_MS * Math.pow(3, attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new UploadError({
    kind: 'hls',
    recordingId: input.recordingId,
    filename: input.filename,
    status: lastStatus,
    attempts: PUT_MAX_ATTEMPTS,
    responseBody: lastBody,
    cause: lastError,
  });
}

/**
 * Upload one `.aac` segment and write its `.uploaded` sentinel on success.
 *
 * This is what your `addSegmentCompletedListener` should call. On success, the sentinel
 * next to the segment tells `Anvil.retryPendingUploads()` (on next launch) that this
 * segment has confirmed shipped.
 *
 * `Anvil.markSegmentUploaded` here uses the (outputDirectory, recordingId, filename)
 * three-arg form — the "from-outside-a-recorder" variant — for consistency with
 * `drainPendingUploads` on launch, which has no live recorder in hand.
 */
export async function syncSegment(input: {
  outputDirectory: string;
  recordingId: string;
  segment: RecordingSegment;
}): Promise<{ url: string }> {
  const result = await putHlsFile({
    recordingId: input.recordingId,
    filename: input.segment.filename,
    filePath: input.segment.filePath,
    contentType: 'audio/aac',
  });
  await Anvil.markSegmentUploaded(
    input.outputDirectory,
    input.recordingId,
    input.segment.filename
  );
  return result;
}

/**
 * Upload the current `manifest.m3u8` and write its `.uploaded` sentinel on success.
 *
 * This is what your `addManifestUpdatedListener` should call. The manifest is small
 * (kilobytes), the PUT is fast, and every rewrite overwrites the last at the same
 * object key — which is exactly how a live HLS manifest is supposed to behave.
 */
export async function syncManifest(input: {
  outputDirectory: string;
  recordingId: string;
  manifestPath: string;
}): Promise<{ url: string }> {
  const result = await putHlsFile({
    recordingId: input.recordingId,
    filename: 'manifest.m3u8',
    filePath: input.manifestPath,
    contentType: 'application/vnd.apple.mpegurl',
  });
  await Anvil.markSegmentUploaded(
    input.outputDirectory,
    input.recordingId,
    'manifest.m3u8'
  );
  return result;
}

/**
 * Drain any pending uploads left over from a previous session — files written to disk
 * but never confirmed shipped (no `.uploaded` sentinel). Call once on app launch,
 * independent of `Anvil.discoverOrphanedRecordings`.
 *
 * Failures are collected per file and returned so the caller can decide (retry later,
 * surface to the user, log to analytics).
 */
export async function drainPendingUploads(outputDirectory: string): Promise<{
  succeeded: PendingUpload[];
  failed: Array<{ upload: PendingUpload; error: unknown }>;
}> {
  const pending = await Anvil.retryPendingUploads(outputDirectory);
  const succeeded: PendingUpload[] = [];
  const failed: Array<{ upload: PendingUpload; error: unknown }> = [];

  for (const upload of pending) {
    try {
      await putHlsFile({
        recordingId: upload.recordingId,
        filename: upload.filename,
        filePath: upload.filePath,
      });
      await Anvil.markSegmentUploaded(
        outputDirectory,
        upload.recordingId,
        upload.filename
      );
      succeeded.push(upload);
    } catch (error) {
      failed.push({ upload, error });
    }
  }

  return { succeeded, failed };
}

// ---------------------------- Single / multipart archive uploads ----------------------------
//
// These are for the "archive" path: after stop() + Anvil.concatenate(...), you have one
// large .aac file and want to upload it as a single object. Files under 5 MB take
// /single-upload (one presigned PUT); larger files use the multipart flow with the
// native nitro-cloud-uploader driving parallel PUTs. Unrelated to the live HLS path
// above — the archive lands in R2_TEST_BUCKET, the HLS stream in R2_STREAMING_BUCKET.

export async function uploadFile(
  options: UploadOptions
): Promise<{ url: string }> {
  return options.fileSize < CHUNK_SIZE
    ? uploadSingle(options)
    : uploadMultipart(options);
}

async function presignSingleUpload(input: {
  uploadId: string;
  fileName: string;
}): Promise<{ url: string; publicUrl: string }> {
  const response = await fetch(`${BASE_URL}/single-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await readBodySafe(response);
    throw new Error(
      `POST /single-upload → ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`
    );
  }
  const parsed = (await response.json()) as {
    url: string;
    publicUrl: string;
  };
  if (!parsed.url || !parsed.publicUrl) {
    throw new Error(
      `POST /single-upload → 200 but missing url/publicUrl in body`
    );
  }
  return parsed;
}

async function uploadSingle(options: UploadOptions): Promise<{ url: string }> {
  const contentType = inferContentType(options.fileName);
  const localPath = stripFileScheme(options.filePath);

  let lastStatus: number | undefined;
  let lastBody: string | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= PUT_MAX_ATTEMPTS; attempt++) {
    try {
      const { url, publicUrl } = await presignSingleUpload({
        uploadId: options.uploadId,
        fileName: options.fileName,
      });

      options.onProgress({
        fraction: 0,
        bytesUploaded: 0,
        totalBytes: options.fileSize,
      });

      const response = await ReactNativeBlobUtil.fetch(
        'PUT',
        url,
        { 'Content-Type': contentType },
        ReactNativeBlobUtil.wrap(localPath)
      ).uploadProgress({ interval: 100 }, (uploaded, total) => {
        const totalBytes = total > 0 ? total : options.fileSize;
        options.onProgress({
          fraction: totalBytes > 0 ? uploaded / totalBytes : 0,
          bytesUploaded: uploaded,
          totalBytes,
        });
      });

      const status = response.info().status;
      lastStatus = status;

      if (status >= 200 && status < 300) {
        options.onProgress({
          fraction: 1,
          bytesUploaded: options.fileSize,
          totalBytes: options.fileSize,
        });
        return { url: publicUrl };
      }

      try {
        lastBody = response.text();
      } catch {
        lastBody = undefined;
      }
      lastError = new Error(`PUT → ${status}`);

      if (!shouldRetryStatus(status)) break;
    } catch (err) {
      lastError = err;
    }

    if (attempt < PUT_MAX_ATTEMPTS) {
      const delayMs = PUT_BACKOFF_BASE_MS * Math.pow(3, attempt - 1);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw new UploadError({
    kind: 'single',
    filename: options.fileName,
    status: lastStatus,
    attempts: PUT_MAX_ATTEMPTS,
    responseBody: lastBody,
    cause: lastError,
  });
}

async function uploadMultipart(
  options: UploadOptions
): Promise<{ url: string }> {
  // The worker returns { uploadId, s3UploadId, parts: [{partNumber, url}], objectKey }.
  // Extract s3UploadId so we can forward it back to /complete-upload — the worker
  // uses it to identify the multipart upload session in R2.
  //
  // fileName is sent so the worker keys the object as `${uploadId}-${fileName}`
  // (matching /single-upload) AND passes Content-Type on the InitiateMultipartUpload
  // call. Without that, R2 stores the completed object with no `.aac` extension
  // and Content-Type: application/octet-stream — no player treats it as audio.
  const create = await fetch(`${BASE_URL}/create-and-start-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: options.uploadId,
      fileSize: options.fileSize,
      chunkSize: CHUNK_SIZE,
      fileName: options.fileName,
      contentType: inferContentType(options.fileName),
    }),
  });

  if (!create.ok) {
    const body = await readBodySafe(create);
    throw new UploadError({
      kind: 'multipart',
      filename: options.fileName,
      status: create.status,
      attempts: 1,
      responseBody: body,
      cause: new Error(`create-and-start-upload → ${create.status}`),
    });
  }

  const created = (await create.json()) as {
    uploadId: string;
    s3UploadId: string;
    parts: Array<{ partNumber: number; url: string }>;
    objectKey: string;
  };
  const uploadUrls = created.parts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => p.url);
  const s3UploadId = created.s3UploadId;

  CloudUploader.addListener('upload-progress', (event: any) => {
    if (event?.uploadId !== options.uploadId) return;
    const raw = typeof event.progress === 'number' ? event.progress : 0;
    options.onProgress({
      fraction: raw > 1 ? raw / 100 : raw,
      bytesUploaded: event.bytesUploaded ?? 0,
      totalBytes: event.totalBytes ?? options.fileSize,
    });
  });

  let parts: Array<{ partNumber: number; etag: string }> = [];
  try {
    // startUpload returns UploadResult { uploadId, success, etags: string[] }.
    // etags is a flat array in part order — one etag per uploaded part. Zip with
    // 1-indexed partNumber to build the shape /complete-upload expects.
    const result = await CloudUploader.startUpload(
      options.uploadId,
      options.filePath,
      uploadUrls,
      PARALLEL_CHUNKS,
      true
    );

    if (!result?.success) {
      throw new Error(
        `startUpload returned success=false for ${options.uploadId}`
      );
    }
    if (!Array.isArray(result.etags) || result.etags.length === 0) {
      throw new Error(
        `startUpload returned no etags for ${options.uploadId} — cannot complete multipart`
      );
    }
    if (result.etags.length !== uploadUrls.length) {
      throw new Error(
        `etag count (${result.etags.length}) does not match part count (${uploadUrls.length}) ` +
          `— some parts failed to upload; refusing to complete with a truncated part list`
      );
    }

    parts = result.etags.map((etag, i) => ({
      partNumber: i + 1,
      etag,
    }));
  } finally {
    CloudUploader.removeListener('upload-progress');
  }

  const complete = await fetch(`${BASE_URL}/complete-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: options.uploadId,
      s3UploadId,
      parts,
    }),
  });
  if (!complete.ok) {
    const body = await readBodySafe(complete);
    throw new UploadError({
      kind: 'multipart',
      filename: options.fileName,
      status: complete.status,
      attempts: 1,
      responseBody: body,
      cause: new Error(`complete-upload → ${complete.status}`),
    });
  }
  const completed = (await complete.json()) as { url: string; key?: string };
  return { url: completed.url };
}

export async function cancelUpload(uploadId: string): Promise<void> {
  await CloudUploader.cancelUpload(uploadId);
}
