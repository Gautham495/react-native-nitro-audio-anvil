import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  Anvil,
  type AnvilRecorder,
  type ListenerSubscription,
  type PermissionStatus,
  type RecorderConfig,
  type RecorderState,
  type RecordingSegment,
} from 'react-native-nitro-audio-anvil';

import Share from 'react-native-share';

import {
  OUTPUT_DIRECTORY,
  ensureOutputDirectory,
  recorderService,
} from './helpers/recorderService';
import { playTrack, toFileUrl } from './helpers/playerBridge';
import { Card, Row } from './helpers/ui/Card';
import { Button, ButtonRow } from './helpers/ui/Button';
import { LevelMeter } from './helpers/ui/LevelMeter';
import { PlayerCard } from './helpers/PlayerCard';
import { UploadCard, type UploadTarget } from './helpers/UploadCard';
import { RecordingsList } from './helpers/RecordingsList';
import { EventLog } from './helpers/EventLog';
import {
  basename,
  colors,
  formatBytes,
  formatClock,
  spacing,
} from './helpers/theme';

const RECORDER_CONFIG: RecorderConfig = {
  outputDirectory: OUTPUT_DIRECTORY,
  segmentDurationMs: 30_000,
  fsyncIntervalMs: 500,
  sampleRate: 16000,
  streamChunkMs: 100,
  speakerWindowMs: 1500,
  speakerWindowHopMs: 750,
  onInterruption: 'resume',
  keepAwakeInBackground: true,
  storageWarningBytes: 200 * 1024 * 1024,
  notification: { title: 'Recording', text: 'Anvil is capturing audio' },
};

const STATE_COLOR: Record<RecorderState, string> = {
  idle: colors.muted,
  recording: colors.record,
  paused: colors.warn,
  interrupted: colors.warn,
  stopped: colors.muted,
};

export default function App() {
  const [permission, setPermission] =
    useState<PermissionStatus>('undetermined');
  const [state, setState] = useState<RecorderState>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [segmentPath, setSegmentPath] = useState('');
  const [pcmCount, setPcmCount] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [windowCount, setWindowCount] = useState(0);
  const [rms, setRms] = useState(0);
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  const [fullFile, setFullFile] = useState<RecordingSegment | null>(null);
  const [uploadTarget, setUploadTarget] = useState<UploadTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const subscriptions = useRef<ListenerSubscription[]>([]);
  const lastSequence = useRef(-1);

  const addLog = useCallback((line: string) => {
    const stamp = new Date().toISOString().slice(11, 19);
    setLog((previous) => [`${stamp}  ${line}`, ...previous].slice(0, 80));
  }, []);

  // ---- stitching -------------------------------------------------------------------------------

  const buildFullFile = useCallback(
    async (parts: RecordingSegment[], name: string) => {
      if (parts.length === 0) return null;
      const outputPath = `${OUTPUT_DIRECTORY}/${name}-full.wav`;
      const stitched = await Anvil.concatenate(
        parts.map((segment) => segment.filePath),
        outputPath
      );
      setFullFile(stitched);
      setUploadTarget({
        path: stitched.filePath,
        sizeBytes: stitched.fileSize,
        durationMs: stitched.durationMs,
      });
      addLog(
        `full file ${basename(stitched.filePath)} ${formatClock(stitched.durationMs)} ${formatBytes(stitched.fileSize)}`
      );
      return stitched;
    },
    [addLog]
  );

  // ---- recovery --------------------------------------------------------------------------------

  const runRecovery = useCallback(async () => {
    try {
      let found = 0;
      await recorderService.recoverPendingRecordings(async (recording) => {
        found++;
        addLog(
          `RECOVERED ${recording.logicalId}: ${recording.sessions.length} session(s), ${recording.segments.length} segment(s), ${formatClock(recording.totalDurationMs)}`
        );
        setSegments(recording.segments);
        await buildFullFile(recording.segments, recording.logicalId);
      });
      if (found === 0) addLog('recovery: nothing pending');
    } catch (error) {
      addLog(`recovery failed: ${String(error)}`);
    }
  }, [addLog, buildFullFile]);

  useEffect(() => {
    (async () => {
      await ensureOutputDirectory();
      setPermission(Anvil.getPermissionStatus());
      await runRecovery();
    })();
  }, [runRecovery]);

  // ---- live snapshot ---------------------------------------------------------------------------

  useEffect(() => {
    const interval = setInterval(() => {
      const recorder = recorderService.active;
      if (!recorder) return;
      setState(recorder.state);
      setDurationMs(recorder.totalDurationMs);
      setSegmentPath(recorder.currentSegmentPath);
    }, 200);
    return () => clearInterval(interval);
  }, []);

  // ---- listeners -------------------------------------------------------------------------------

  const wireListeners = useCallback(
    (recorder: AnvilRecorder) => {
      subscriptions.current.forEach((s) => s.remove());
      lastSequence.current = -1;
      subscriptions.current = [
        // Stream 1 — PCM chunks. Forward `chunk.buffer` to your streaming speech-to-text socket.
        recorder.addPCMListener((chunk) => {
          setPcmCount((n) => n + 1);
          setPcmBytes((n) => n + chunk.buffer.byteLength);
          if (
            lastSequence.current >= 0 &&
            chunk.sequenceNumber !== lastSequence.current + 1
          ) {
            addLog(
              `PCM GAP expected ${lastSequence.current + 1} got ${chunk.sequenceNumber}`
            );
          }
          lastSequence.current = chunk.sequenceNumber;
        }),
        // Stream 2 — speaker windows. Send `window.buffer` to your speaker-embedding model.
        recorder.addSpeakerWindowListener((window) => {
          setWindowCount((n) => n + 1);
          setRms(window.rms);
        }),
        recorder.addInterruptionListener((event) => {
          addLog(
            `INTERRUPTION ${event.phase} ${event.reason} resume=${event.shouldResume}` +
              (event.segmentPath ? ` → ${basename(event.segmentPath)}` : '')
          );
        }),
        recorder.addRouteChangeListener((event) => {
          addLog(
            `ROUTE ${event.reason} "${event.inputName}" changed=${event.inputChanged}`
          );
        }),
        recorder.addPermissionChangeListener((status) => {
          setPermission(status);
          addLog(`PERMISSION → ${status}`);
        }),
        recorder.addStorageWarningListener((event) => {
          addLog(
            `STORAGE ${formatBytes(event.freeBytes)} free < ${formatBytes(event.thresholdBytes)}`
          );
        }),
        recorder.addSegmentCompletedListener((segment) => {
          setSegments((previous) => [
            ...previous.filter((s) => s.filePath !== segment.filePath),
            segment,
          ]);
          addLog(
            `SEGMENT #${segment.index} ${formatClock(segment.durationMs)} ${formatBytes(segment.fileSize)}` +
              (segment.wasInterrupted
                ? ` ⚡${segment.interruptionReason ?? ''}`
                : '') +
              (segment.routeChanged ? ' 🎧' : '')
          );
        }),
        recorder.addErrorListener((error) => {
          addLog(`ERROR [${error.code}] ${error.message}`);
        }),
      ];
    },
    [addLog]
  );

  // ---- controls --------------------------------------------------------------------------------

  const requestPermission = useCallback(async () => {
    const status = await Anvil.requestPermission();
    setPermission(status);
    addLog(`permission ${status}`);
  }, [addLog]);

  const record = useCallback(async () => {
    setBusy(true);
    try {
      setPcmCount(0);
      setPcmBytes(0);
      setWindowCount(0);
      setRms(0);
      setSegments([]);
      setFullFile(null);
      setUploadTarget(null);
      const recorder = await recorderService.begin({
        logicalId: `recording-${Date.now()}`,
        config: RECORDER_CONFIG,
      });
      wireListeners(recorder);
      setState('recording');
      addLog(`session ${recorder.sessionId}`);
    } catch (error) {
      addLog(`start failed: ${String(error)}`);
      Alert.alert('Could not start', String(error));
    } finally {
      setBusy(false);
    }
  }, [wireListeners, addLog]);

  const pause = useCallback(async () => {
    await recorderService.active
      ?.pause()
      .catch((error) => addLog(`pause failed: ${String(error)}`));
    setState('paused');
  }, [addLog]);

  const resume = useCallback(async () => {
    await recorderService.active
      ?.resume()
      .catch((error) => addLog(`resume failed: ${String(error)}`));
    setState('recording');
  }, [addLog]);

  const rotate = useCallback(async () => {
    try {
      const segment = await recorderService.active?.rotateSegment();
      if (segment) addLog(`rotated → #${segment.index}`);
    } catch (error) {
      addLog(`rotate failed: ${String(error)}`);
    }
  }, [addLog]);

  const stop = useCallback(async () => {
    setBusy(true);
    const logicalId =
      recorderService.activeLogicalId ?? `recording-${Date.now()}`;
    try {
      const finished = await recorderService.end();
      subscriptions.current.forEach((s) => s.remove());
      subscriptions.current = [];
      setState('stopped');
      setSegmentPath('');
      setRms(0);
      setSegments(finished);
      addLog(
        `stopped: ${finished.length} segment(s), ${formatClock(finished.reduce((sum, s) => sum + s.durationMs, 0))}`
      );
      await buildFullFile(finished, logicalId);
    } catch (error) {
      addLog(`stop failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [addLog, buildFullFile]);

  const playSegment = useCallback(
    async (segment: RecordingSegment, title: string) => {
      try {
        await playTrack({
          id: segment.filePath,
          title,
          url: toFileUrl(segment.filePath),
          durationSec: segment.durationMs / 1000,
        });
      } catch (error) {
        addLog(`play failed: ${String(error)}`);
      }
    },
    [addLog]
  );

  const playRemote = useCallback(
    async (url: string) => {
      addLog(`play uploaded: ${url}`);
      try {
        await playTrack({
          id: url,
          title: 'Uploaded recording',
          url,
          durationSec: (fullFile?.durationMs ?? 0) / 1000,
        });
      } catch (error) {
        addLog(`remote play failed: ${String(error)}`);
      }
    },
    [addLog, fullFile]
  );

  const shareFile = useCallback(
    async (segment: RecordingSegment) => {
      try {
        await Share.open({
          url: `file://${segment.filePath}`,
          type: 'audio/wav',
          filename: basename(segment.filePath),
          saveToFiles: Platform.OS === 'ios',
        });
        addLog(`shared ${basename(segment.filePath)}`);
      } catch (error) {
        if (String(error).includes('cancelled')) return;
        addLog(`share failed: ${String(error)}`);
      }
    },
    [addLog]
  );

  const recording = state === 'recording';
  const active =
    recorderService.active !== null && state !== 'stopped' && state !== 'idle';

  return (
    <View style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.brand}>ANVIL</Text>
          <Text style={styles.subtitle}>
            corruption-proof recording ·{' '}
            {Platform.OS === 'android' ? 'Android' : 'iOS'}
          </Text>
        </View>

        <Card title="Recorder" badge={permission}>
          <View style={styles.timerRow}>
            <View
              style={[styles.dot, { backgroundColor: STATE_COLOR[state] }]}
            />
            <Text style={styles.timer}>{formatClock(durationMs)}</Text>
            <Text style={[styles.stateLabel, { color: STATE_COLOR[state] }]}>
              {state}
            </Text>
          </View>
          <LevelMeter rms={rms} active={recording} />
          <Row label="Segment" value={basename(segmentPath) || '—'} mono />
          <Row
            label="PCM stream"
            value={`${pcmCount} chunks · ${formatBytes(pcmBytes)}`}
            mono
          />
          <Row
            label="Speaker windows"
            value={`${windowCount} · rms ${rms.toFixed(3)}`}
            mono
          />

          {permission !== 'granted' ? (
            <Button
              title="Allow microphone"
              variant="record"
              onPress={requestPermission}
            />
          ) : !active ? (
            <Button
              title="● Record"
              variant="record"
              onPress={record}
              disabled={busy}
            />
          ) : (
            <>
              <ButtonRow>
                {recording ? (
                  <Button title="Pause" variant="neutral" onPress={pause} />
                ) : (
                  <Button title="Resume" variant="neutral" onPress={resume} />
                )}
                <Button
                  title="Rotate"
                  variant="neutral"
                  onPress={rotate}
                  disabled={!recording}
                />
              </ButtonRow>
              <Button
                title="■ Stop"
                variant="danger"
                onPress={stop}
                disabled={busy}
              />
            </>
          )}
        </Card>

        <RecordingsList
          fullFile={fullFile}
          segments={segments}
          onPlay={playSegment}
          onShare={shareFile}
          onUploadTarget={(segment) =>
            setUploadTarget({
              path: segment.filePath,
              sizeBytes: segment.fileSize,
              durationMs: segment.durationMs,
            })
          }
        />

        <PlayerCard />

        <UploadCard
          target={uploadTarget}
          onUploaded={() => {}}
          onPlayRemote={playRemote}
          log={addLog}
        />

        <Card title="Tools">
          <ButtonRow>
            <Button
              title="Run recovery"
              variant="ghost"
              onPress={runRecovery}
            />
            <Button
              title="Simulate crash"
              variant="ghost"
              onPress={() => {
                addLog(
                  'crashing in 1 s — reopen and watch RECOVERED (release builds; dev shows a redbox)'
                );
                setTimeout(() => {
                  throw new Error('Anvil crash test');
                }, 1000);
              }}
            />
          </ButtonRow>
        </Card>

        <EventLog lines={log} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background, paddingTop: 60 },
  content: {
    padding: spacing.lg,
    gap: spacing.md,
    paddingBottom: spacing.xl * 2,
  },
  header: { paddingVertical: spacing.sm, gap: 2 },
  brand: {
    color: colors.text,
    fontSize: 28,
    fontWeight: '800',
    letterSpacing: 6,
  },
  subtitle: { color: colors.muted, fontSize: 13 },
  timerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: {
    color: colors.text,
    fontSize: 40,
    fontWeight: '300',
    fontVariant: ['tabular-nums'],
    flex: 1,
  },
  stateLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
});
