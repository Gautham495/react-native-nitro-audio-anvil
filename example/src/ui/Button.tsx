import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { colors, radius, spacing } from '../theme';

type Variant = 'record' | 'play' | 'upload' | 'neutral' | 'danger' | 'ghost';

export function Button({
  title,
  onPress,
  variant = 'neutral',
  disabled = false,
  compact = false,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  compact?: boolean;
  style?: ViewStyle;
}) {
  const tone = TONES[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        compact ? styles.compact : styles.regular,
        { backgroundColor: tone.background, borderColor: tone.border },
        pressed && !disabled && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}
    >
      <Text
        style={[
          styles.label,
          compact && styles.labelCompact,
          { color: tone.text },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export function ButtonRow({ children }: { children: React.ReactNode }) {
  return <View style={styles.row}>{children}</View>;
}

const TONES: Record<
  Variant,
  { background: string; border: string; text: string }
> = {
  record: { background: colors.record, border: colors.record, text: '#1A0B07' },
  play: { background: colors.play, border: colors.play, text: '#06180D' },
  upload: { background: colors.upload, border: colors.upload, text: '#06122B' },
  neutral: {
    background: colors.cardRaised,
    border: colors.border,
    text: colors.text,
  },
  danger: {
    background: 'transparent',
    border: colors.danger,
    text: colors.danger,
  },
  ghost: {
    background: 'transparent',
    border: colors.border,
    text: colors.muted,
  },
};

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  regular: {
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    flexGrow: 1,
    flexBasis: 0,
  },
  compact: { paddingVertical: 8, paddingHorizontal: spacing.md },
  pressed: { opacity: 0.8, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.35 },
  label: { fontSize: 15, fontWeight: '700', letterSpacing: 0.2 },
  labelCompact: { fontSize: 13 },
  row: { flexDirection: 'row', gap: spacing.sm },
});
