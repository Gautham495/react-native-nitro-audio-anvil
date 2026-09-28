import { StyleSheet, Text, View } from 'react-native';
import type { RecoveredRecording } from 'react-native-nitro-audio-anvil';

import { Card } from './ui/Card';
import { Button } from './ui/Button';
import { colors, formatClock, spacing } from './theme';

export function RecoveryCard({
  orphans,
  onResume,
  onFinalize,
  onDiscard,
}: {
  orphans: RecoveredRecording[];
  onResume: (orphan: RecoveredRecording) => void;
  onFinalize: (orphan: RecoveredRecording) => void;
  onDiscard: (orphan: RecoveredRecording) => void;
}) {
  if (orphans.length === 0) return null;
  return (
    <Card
      title="Recovered recordings"
      badge={`${orphans.length} unsealed folder${orphans.length === 1 ? '' : 's'}`}
    >
      {orphans.map((orphan) => (
        <View key={orphan.recordingId} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.rowTitle}>{orphan.recordingId}</Text>
            <Text style={styles.rowMeta} numberOfLines={2}>
              {orphan.segments.length} segments ·{' '}
              {formatClock(orphan.totalDurationMs)}
              {orphan.wasInterrupted ? '  ⚡ interrupted' : ''}
            </Text>
            <Text style={styles.rowSub} numberOfLines={1}>
              {orphan.folderPath}
            </Text>
          </View>
          <View style={styles.actions}>
            <Button
              title="Resume"
              variant="record"
              compact
              onPress={() => onResume(orphan)}
            />
            <Button
              title="Finalize"
              variant="upload"
              compact
              onPress={() => onFinalize(orphan)}
            />
            <Button
              title="Discard"
              variant="danger"
              compact
              onPress={() => onDiscard(orphan)}
            />
          </View>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  rowMeta: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  rowSub: { color: colors.faint, fontSize: 10 },
  actions: { flexDirection: 'column', gap: spacing.xs },
});
