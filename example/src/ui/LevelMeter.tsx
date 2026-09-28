import { StyleSheet, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

const BARS = 24;

/** Simple bar meter driven by the speaker-window RMS (0…1). */
export function LevelMeter({ rms, active }: { rms: number; active: boolean }) {
  // Speech RMS on 16-bit PCM usually lands around 0.01–0.15; scale so that range fills the meter.
  const level = Math.min(1, Math.sqrt(rms) * 2.2);
  const lit = Math.round(level * BARS);
  return (
    <View style={styles.meter}>
      {Array.from({ length: BARS }, (_, index) => {
        const on = active && index < lit;
        const tone =
          index > BARS * 0.8
            ? colors.record
            : index > BARS * 0.55
              ? colors.warn
              : colors.play;
        return (
          <View
            key={index}
            style={[
              styles.bar,
              { backgroundColor: on ? tone : colors.cardRaised },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  meter: {
    flexDirection: 'row',
    gap: 3,
    height: 18,
    alignItems: 'flex-end',
    marginTop: spacing.xs,
  },
  bar: { flex: 1, height: '100%', borderRadius: radius.sm },
});
