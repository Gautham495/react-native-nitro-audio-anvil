import { useCallback, useState } from 'react';

import { StyleSheet, Text, View } from 'react-native';

import { Card } from './ui/Card';

import { Button, ButtonRow } from './ui/Button';

import { ProgressBar } from './ui/ProgressBar';

import { cancelUpload, uploadFile } from './uploaderBridge';

import { basename, colors, formatBytes, spacing } from './theme';

export interface UploadTarget {
  path: string;
  sizeBytes: number;
  durationMs: number;
}

type Status = 'idle' | 'uploading' | 'done' | 'error';

export function UploadCard({
  target,
  onUploaded,
  onPlayRemote,
  log,
}: {
  target: UploadTarget | null;
  onUploaded: (url: string) => void;
  onPlayRemote: (url: string) => void;
  log: (line: string) => void;
}) {
  const [status, setStatus] = useState<Status>('idle');
  const [fraction, setFraction] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [url, setUrl] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);

  const start = useCallback(async () => {
    if (!target) return;

    const id = `anvil-${Date.now()}`;
    setUploadId(id);
    setStatus('uploading');
    setFraction(0);
    setBytes(0);
    setUrl(null);
    log(
      `upload ${id} → ${basename(target.path)} (${formatBytes(target.sizeBytes)})`
    );

    const fileName = target.path.split('/').pop() ?? `${id}.wav`;

    try {
      const result = await uploadFile({
        uploadId: id,
        filePath: target.path,
        fileSize: target.sizeBytes,
        fileName: fileName,
        onProgress: (progress) => {
          setFraction(progress.fraction);
          setBytes(progress.bytesUploaded);
        },
      });
      setFraction(1);
      setUrl(result.url);
      setStatus('done');
      onUploaded(result.url);
      log(`uploaded → ${result.url}`);
    } catch (error) {
      setStatus('error');
      log(`upload failed: ${String(error)}`);
    }
  }, [target, onUploaded, log]);

  const cancel = useCallback(async () => {
    if (!uploadId) return;
    await cancelUpload(uploadId).catch(() => {});
    setStatus('idle');
    log(`upload ${uploadId} cancelled`);
  }, [uploadId, log]);

  const barColor =
    status === 'error'
      ? colors.danger
      : status === 'done'
        ? colors.play
        : colors.upload;

  return (
    <Card title="Upload" badge="react-native-nitro-cloud-uploader">
      <Text style={styles.file} numberOfLines={1}>
        {target
          ? `${basename(target.path)} · ${formatBytes(target.sizeBytes)}`
          : 'Stop a recording to get a file to upload'}
      </Text>
      <ProgressBar fraction={fraction} color={barColor} />
      <View style={styles.meta}>
        <Text style={styles.metaText}>{STATUS_LABEL[status]}</Text>
        <Text style={styles.metaText}>
          {status === 'uploading' && target
            ? `${formatBytes(bytes)} / ${formatBytes(target.sizeBytes)}`
            : `${Math.round(fraction * 100)}%`}
        </Text>
      </View>
      <ButtonRow>
        {status === 'uploading' ? (
          <Button title="Cancel" variant="danger" onPress={cancel} />
        ) : (
          <Button
            title={status === 'done' ? 'Upload again' : 'Upload'}
            variant="upload"
            onPress={start}
            disabled={!target}
          />
        )}
        <Button
          title="Play uploaded"
          variant="play"
          onPress={() => url && onPlayRemote(url)}
          disabled={!url}
        />
      </ButtonRow>
      {url ? (
        <Text style={styles.url} numberOfLines={2}>
          {url}
        </Text>
      ) : null}
    </Card>
  );
}

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Ready',
  uploading: 'Uploading…',
  done: 'Uploaded',
  error: 'Failed',
};

const styles = StyleSheet.create({
  file: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -spacing.xs,
  },
  metaText: {
    color: colors.muted,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  url: { color: colors.faint, fontSize: 11 },
});
