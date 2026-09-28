import { StyleSheet, Text, View } from 'react-native';
import type { RecordingSegment } from 'react-native-nitro-audio-anvil';
import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { basename, colors, formatBytes, formatClock, spacing } from './theme';

export function RecordingsList({
  fullFile,
  segments,
  hlsUrl,
  onPlayLocal,
  onCopyHlsUrl,
  onShare,
  onUploadTarget,
}: {
  fullFile: RecordingSegment | null;
  segments: RecordingSegment[];
  /** CDN URL of `manifest.m3u8` for the current recording, once any segment has uploaded. */
  hlsUrl: string | null;
  onPlayLocal: (segment: RecordingSegment, title: string) => void;
  onCopyHlsUrl: (url: string) => void;
  onShare: (fullFile: RecordingSegment) => void;
  onUploadTarget: (segment: RecordingSegment) => void;
}) {
  if (!fullFile && segments.length === 0 && !hlsUrl) return null;
  return (
    <Card
      title="Recordings"
      badge={`${segments.length} segment${segments.length === 1 ? '' : 's'}`}
    >
      {hlsUrl ? (
        <View style={[styles.row, styles.hlsRow]}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>HLS manifest on R2</Text>
            <Text style={styles.rowMeta} numberOfLines={2}>
              {hlsUrl}
            </Text>
          </View>
          <Button
            title="Copy"
            variant="upload"
            compact
            onPress={() => onCopyHlsUrl(hlsUrl)}
          />
        </View>
      ) : null}
      {fullFile ? (
        <View style={[styles.row, styles.fullRow]}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>Full recording (concatenated)</Text>
            <Text style={styles.rowMeta}>
              {formatClock(fullFile.durationMs)} ·{' '}
              {formatBytes(fullFile.fileSize)} · {basename(fullFile.filePath)}
            </Text>
          </View>
          <Button
            title="↑"
            variant="upload"
            compact
            onPress={() => onUploadTarget(fullFile)}
          />
          <Button
            title="⇪"
            variant="ghost"
            compact
            onPress={() => onShare(fullFile)}
          />
        </View>
      ) : null}
      {segments.map((segment) => (
        <View key={segment.filePath} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>
              {segment.filename}
              {segment.wasInterrupted
                ? `  ⚡ ${segment.interruptionReason ?? 'interrupted'}`
                : ''}
              {segment.routeChanged ? '  🎧 route' : ''}
            </Text>
            <Text style={styles.rowMeta}>
              {formatClock(segment.durationMs)} @{' '}
              {formatClock(segment.mediaStartMs)} ·{' '}
              {formatBytes(segment.fileSize)} · sha {segment.sha256.slice(0, 8)}
            </Text>
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hlsRow: {
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  fullRow: {
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: colors.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
});
