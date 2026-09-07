import React from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { colors, radius } from '../theme';

export function ProgressBar({
  fraction,
  color,
  onSeek,
}: {
  fraction: number;
  color: string;
  onSeek?: (fraction: number) => void;
}) {
  const widthRef = React.useRef(1);
  const clamped = Math.min(1, Math.max(0, fraction));
  return (
    <Pressable
      onLayout={(event: LayoutChangeEvent) => {
        widthRef.current = Math.max(1, event.nativeEvent.layout.width);
      }}
      onPress={(event) =>
        onSeek?.(event.nativeEvent.locationX / widthRef.current)
      }
      disabled={!onSeek}
      style={styles.track}
    >
      <View
        style={[
          styles.fill,
          { width: `${clamped * 100}%`, backgroundColor: color },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.cardRaised,
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.pill },
});
