import { Platform, StyleSheet, Text } from 'react-native';
import { Card } from './ui/Card';
import { colors } from './theme';

export function EventLog({ lines }: { lines: string[] }) {
  return (
    <Card title="Events" badge={`${lines.length}`}>
      {lines.length === 0 ? (
        <Text style={styles.empty}>Listener output appears here.</Text>
      ) : null}
      {lines.map((line, index) => (
        <Text key={index} style={[styles.line, index === 0 && styles.latest]}>
          {line}
        </Text>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  empty: { color: colors.faint, fontSize: 12 },
  line: {
    color: colors.muted,
    fontSize: 11,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
  },
  latest: { color: colors.text },
});
