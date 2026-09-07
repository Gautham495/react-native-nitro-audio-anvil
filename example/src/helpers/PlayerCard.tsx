import { useCallback } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  TrackPlayer,
  useOnChangeTrack,
  useOnPlaybackProgressChange,
  useOnPlaybackStateChange,
} from 'react-native-nitro-player';
import { Card } from './ui/Card';
import { Button, ButtonRow } from './ui/Button';
import { ProgressBar } from './ui/ProgressBar';
import { colors, formatClock, spacing } from './theme';

export function PlayerCard() {
  const { track } = useOnChangeTrack();
  const { state } = useOnPlaybackStateChange();
  const { position, totalDuration } = useOnPlaybackProgressChange();

  const playing = state === 'playing';
  const fraction = totalDuration > 0 ? position / totalDuration : 0;

  const toggle = useCallback(async () => {
    if (!track) return;
    if (playing) await TrackPlayer.pause();
    else await TrackPlayer.play();
  }, [playing, track]);

  const seek = useCallback(
    async (target: number) => {
      if (totalDuration > 0) await TrackPlayer.seek(target * totalDuration);
    },
    [totalDuration]
  );

  return (
    <Card title="Player" badge="react-native-nitro-player">
      <Text style={styles.title} numberOfLines={1}>
        {track?.title ?? 'Nothing loaded — tap ▶ on a recording'}
      </Text>
      <ProgressBar
        fraction={fraction}
        color={colors.play}
        onSeek={track ? seek : undefined}
      />
      <View style={styles.times}>
        <Text style={styles.time}>{formatClock(position * 1000)}</Text>
        <Text style={styles.time}>{formatClock(totalDuration * 1000)}</Text>
      </View>
      <ButtonRow>
        <Button
          title={playing ? 'Pause' : 'Play'}
          variant="play"
          onPress={toggle}
          disabled={!track}
        />
        <Button
          title="−10 s"
          variant="neutral"
          onPress={() => TrackPlayer.seek(Math.max(0, position - 10))}
          disabled={!track}
        />
        <Button
          title="+10 s"
          variant="neutral"
          onPress={() =>
            TrackPlayer.seek(Math.min(totalDuration, position + 10))
          }
          disabled={!track}
        />
      </ButtonRow>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: 15, fontWeight: '600' },
  times: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -spacing.xs,
  },
  time: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
});
