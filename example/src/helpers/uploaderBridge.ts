import ReactNativeBlobUtil from 'react-native-blob-util';
import { CloudUploader } from 'react-native-nitro-cloud-uploader';

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

const CHUNK_SIZE = 5 * 1024 * 1024;
const PARALLEL_CHUNKS = 3;
const BASE_URL = 'https://api.gauthamvijay.com/r2-uploader';

export async function uploadFile(
  options: UploadOptions
): Promise<{ url: string }> {
  return options.fileSize < CHUNK_SIZE
    ? uploadSingle(options)
    : uploadMultipart(options);
}

async function uploadSingle(options: UploadOptions): Promise<{ url: string }> {
  const create = await fetch(`${BASE_URL}/single-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: options.uploadId,
      fileName: options.fileName,
    }),
  });
  if (!create.ok) throw new Error(`single-upload → ${create.status}`);
  const { url, publicUrl } = (await create.json()) as {
    url: string;
    publicUrl: string;
  };

  options.onProgress({
    fraction: 0,
    bytesUploaded: 0,
    totalBytes: options.fileSize,
  });

  const path = options.filePath.replace(/^file:\/\//, '');
  const response = await ReactNativeBlobUtil.fetch(
    'PUT',
    url,
    { 'Content-Type': 'audio/wav' },
    ReactNativeBlobUtil.wrap(path)
  ).uploadProgress({ interval: 100 }, (uploaded, total) => {
    const totalBytes = total > 0 ? total : options.fileSize;
    options.onProgress({
      fraction: totalBytes > 0 ? uploaded / totalBytes : 0,
      bytesUploaded: uploaded,
      totalBytes,
    });
  });

  const status = response.info().status;
  if (status < 200 || status >= 300) throw new Error(`PUT → ${status}`);

  options.onProgress({
    fraction: 1,
    bytesUploaded: options.fileSize,
    totalBytes: options.fileSize,
  });
  return { url: publicUrl };
}

async function uploadMultipart(
  options: UploadOptions
): Promise<{ url: string }> {
  const create = await fetch(`${BASE_URL}/create-and-start-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uploadId: options.uploadId,
      fileSize: options.fileSize,
      chunkSize: CHUNK_SIZE,
    }),
  });
  if (!create.ok) throw new Error(`create-and-start-upload → ${create.status}`);
  const { uploadUrls, key } = (await create.json()) as {
    uploadUrls: string[];
    key: string;
  };

  CloudUploader.addListener('upload-progress', (event: any) => {
    if (event?.uploadId !== options.uploadId) return;
    const raw = typeof event.progress === 'number' ? event.progress : 0;
    options.onProgress({
      fraction: raw > 1 ? raw / 100 : raw,
      bytesUploaded: event.bytesUploaded ?? 0,
      totalBytes: event.totalBytes ?? options.fileSize,
    });
  });

  try {
    await CloudUploader.startUpload(
      options.uploadId,
      options.filePath,
      uploadUrls,
      PARALLEL_CHUNKS,
      true
    );
  } finally {
    CloudUploader.removeListener('upload-progress');
  }

  const complete = await fetch(`${BASE_URL}/complete-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: options.uploadId, key }),
  });
  if (!complete.ok) throw new Error(`complete-upload → ${complete.status}`);
  return (await complete.json()) as { url: string };
}

export async function cancelUpload(uploadId: string): Promise<void> {
  await CloudUploader.cancelUpload(uploadId);
}
