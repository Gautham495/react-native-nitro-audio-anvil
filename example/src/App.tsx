import React, { useCallback, useEffect, useRef, useState } from 'react';

import {
  Alert,
  Button,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import RNFS from 'react-native-nitro-fs';

import {
  Anvil,
  createFileMarkerStore,
  createRecordingService,
  type AnvilRecorder,
  type ListenerSubscription,
  type PermissionStatus,
  type RecorderConfig,
  type RecorderState,
  type RecordingSegment,
  type RecoveredRecording,
} from 'react-native-nitro-audio-anvil';

const OUTPUT_DIRECTORY = `${RNFS.DOCUMENT_DIR}/anvil-test`;

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
  notification: { title: 'Anvil test recording', text: 'Tap to return' },
};

const fileSystemBridge = {
  async readText(path: string) {
    try {
      return await RNFS.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async writeText(path: string, contents: string) {
    await RNFS.writeFile(path, contents, 'utf8');
  },
  async delete(path: string) {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  },
  async list(directory: string) {
    try {
      return (await RNFS.readdir(directory)).map((entry) => entry.path);
    } catch {
      return [];
    }
  },
};

const recorderService = createRecordingService({
  outputDirectory: OUTPUT_DIRECTORY,
  markerStore: createFileMarkerStore(fileSystemBridge, OUTPUT_DIRECTORY),
});

export default function App() {
  const [permission, setPermission] =
    useState<PermissionStatus>('undetermined');
  const [state, setState] = useState<RecorderState>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [segmentPath, setSegmentPath] = useState('');
  const [pcmCount, setPcmCount] = useState(0);
  const [pcmBytes, setPcmBytes] = useState(0);
  const [lastSequence, setLastSequence] = useState(-1);
  const [windowCount, setWindowCount] = useState(0);
  const [lastRms, setLastRms] = useState(0);
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  const [recovered, setRecovered] = useState<RecoveredRecording[]>([]);
  const [log, setLog] = useState<string[]>([]);

  const subscriptions = useRef<ListenerSubscription[]>([]);

  const addLog = useCallback((line: string) => {
    const stamp = new Date().toISOString().slice(11, 23);
    setLog((previous) => [`${stamp} ${line}`, ...previous].slice(0, 60));
  }, []);

  const runRecovery = useCallback(async () => {
    const found: RecoveredRecording[] = [];
    try {
      await recorderService.recoverPendingRecordings((recording) => {
        found.push(recording);
        addLog(
          `RECOVERED ${recording.logicalId}: ${recording.sessions.length} session(s), ` +
            `${recording.segments.length} segment(s), ${(recording.totalDurationMs / 1000).toFixed(1)} s`
        );
      });
      setRecovered(found);
      if (found.length === 0) addLog('recovery: nothing pending');
    } catch (error) {
      addLog(`recovery failed: ${String(error)}`);
    }
  }, [addLog]);

  // Startup: make the directory, read permission, run recovery.
  useEffect(() => {
    (async () => {
      await RNFS.mkdir(OUTPUT_DIRECTORY).catch(() => {});
      setPermission(Anvil.getPermissionStatus());
      await runRecovery();
    })();
  }, [runRecovery]);

  // Poll the snapshot properties while a recorder exists.
  useEffect(() => {
    const interval = setInterval(() => {
      const recorder = recorderService.active;
      if (!recorder) return;
      setState(recorder.state);
      setDurationMs(recorder.totalDurationMs);
      setSegmentPath(recorder.currentSegmentPath);
    }, 250);
    return () => clearInterval(interval);
  }, []);

  const requestPermission = useCallback(async () => {
    const status = await Anvil.requestPermission();
    setPermission(status);
    addLog(`permission: ${status}`);
  }, [addLog]);

  const wireListeners = useCallback(
    (recorder: AnvilRecorder) => {
      subscriptions.current.forEach((s) => s.remove());
      subscriptions.current = [
        // Stream 1: PCM chunks. Forward `chunk.buffer` to your streaming speech-to-text socket here.
        recorder.addPCMListener((chunk) => {
          setPcmCount((n) => n + 1);
          setPcmBytes((n) => n + chunk.buffer.byteLength);
          setLastSequence((previous) => {
            if (previous >= 0 && chunk.sequenceNumber !== previous + 1) {
              addLog(
                `PCM GAP: expected ${previous + 1}, got ${chunk.sequenceNumber}`
              );
            }
            return chunk.sequenceNumber;
          });
        }),
        // Stream 2: speaker windows. Send `window.buffer` to your speaker-embedding model here.
        recorder.addSpeakerWindowListener((window) => {
          setWindowCount((n) => n + 1);
          setLastRms(window.rms);
        }),
        recorder.addInterruptionListener((event) => {
          addLog(
            `INTERRUPTION ${event.phase} reason=${event.reason} shouldResume=${event.shouldResume}` +
              (event.segmentPath
                ? ` finalized=${basename(event.segmentPath)}`
                : '') +
              ` @${(event.timestampMs / 1000).toFixed(1)} s`
          );
        }),
        recorder.addRouteChangeListener((event) => {
          addLog(
            `ROUTE ${event.reason} input="${event.inputName}" changed=${event.inputChanged}`
          );
        }),
        recorder.addPermissionChangeListener((status) => {
          setPermission(status);
          addLog(`PERMISSION changed → ${status}`);
        }),
        recorder.addStorageWarningListener((event) => {
          addLog(
            `STORAGE WARNING free=${(event.freeBytes / 1e6).toFixed(0)} MB < ${(event.thresholdBytes / 1e6).toFixed(0)} MB`
          );
        }),
        recorder.addSegmentCompletedListener((segment) => {
          addLog(
            `SEGMENT #${segment.index} ${basename(segment.filePath)} ${(segment.durationMs / 1000).toFixed(1)} s ` +
              `${(segment.fileSize / 1024).toFixed(0)} KB sha=${segment.sha256.slice(0, 8)}` +
              (segment.wasInterrupted
                ? ` interrupted(${segment.interruptionReason ?? '?'})`
                : '') +
              (segment.routeChanged ? ' routeChanged' : '')
          );
        }),
        recorder.addErrorListener((error) => {
          addLog(`ERROR [${error.code}] ${error.message}`);
        }),
      ];
    },
    [addLog]
  );

  const start = useCallback(async () => {
    try {
      setPcmCount(0);
      setPcmBytes(0);
      setLastSequence(-1);
      setWindowCount(0);
      setSegments([]);
      const recorder = await recorderService.begin({
        logicalId: `recording-${Date.now()}`,
        config: RECORDER_CONFIG,
      });
      wireListeners(recorder);
      addLog(`started session ${recorder.sessionId}`);
    } catch (error) {
      addLog(`start failed: ${String(error)}`);
      Alert.alert('start failed', String(error));
    }
  }, [wireListeners, addLog]);

  const pause = useCallback(async () => {
    try {
      await recorderService.active?.pause();
      addLog('paused');
    } catch (error) {
      addLog(`pause failed: ${String(error)}`);
    }
  }, [addLog]);

  const resume = useCallback(async () => {
    try {
      await recorderService.active?.resume();
      addLog('resumed');
    } catch (error) {
      addLog(`resume failed: ${String(error)}`);
    }
  }, [addLog]);

  const rotate = useCallback(async () => {
    try {
      const segment = await recorderService.active?.rotateSegment();
      addLog(
        `rotated → #${segment?.index} ${basename(segment?.filePath ?? '')}`
      );
    } catch (error) {
      addLog(`rotate failed: ${String(error)}`);
    }
  }, [addLog]);

  const extractLast10s = useCallback(async () => {
    const recorder = recorderService.active;
    if (!recorder) return;
    const end = recorder.totalDurationMs;
    const startMs = Math.max(0, end - 10_000);
    try {
      const path = await recorder.extractRange(startMs, end);
      addLog(
        `extracted ${startMs.toFixed(0)}–${end.toFixed(0)} ms → ${basename(path)}`
      );
    } catch (error) {
      addLog(`extract failed: ${String(error)}`);
    }
  }, [addLog]);

  const stop = useCallback(async () => {
    try {
      const finished = await recorderService.end();
      subscriptions.current.forEach((s) => s.remove());
      subscriptions.current = [];
      setSegments(finished);
      const total = finished.reduce(
        (sum, segment) => sum + segment.durationMs,
        0
      );
      addLog(
        `stopped: ${finished.length} segment(s), total ${(total / 1000).toFixed(1)} s`
      );
    } catch (error) {
      addLog(`stop failed: ${String(error)}`);
    }
  }, [addLog]);

  const simulateCrash = useCallback(() => {
    addLog('crashing in 1 s — reopen the app and watch for RECOVERED');
    setTimeout(() => {
      throw new Error('Anvil crash test');
    }, 1000);
  }, [addLog]);

  const recording = state === 'recording';
  const canResume = state === 'paused' || state === 'interrupted';
  const hasRecorder = recorderService.active !== null && state !== 'stopped';

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>Anvil harness ({Platform.OS})</Text>

        <Row label="Permission" value={permission} />
        <Row label="State" value={state} />
        <Row label="Duration" value={`${(durationMs / 1000).toFixed(1)} s`} />
        <Row label="Segment" value={basename(segmentPath) || '—'} />
        <Row
          label="PCM chunks"
          value={`${pcmCount} · ${(pcmBytes / 1024).toFixed(0)} KB · seq ${lastSequence}`}
        />
        <Row
          label="Speaker windows"
          value={`${windowCount} · rms ${lastRms.toFixed(3)}`}
        />

        <View style={styles.buttons}>
          <Button
            title="Request permission"
            onPress={requestPermission}
            disabled={permission === 'granted'}
          />
          <Button title="Start" onPress={start} disabled={hasRecorder} />
          <Button title="Pause" onPress={pause} disabled={!recording} />
          <Button title="Resume" onPress={resume} disabled={!canResume} />
          <Button
            title="Rotate segment"
            onPress={rotate}
            disabled={!recording}
          />
          <Button
            title="Extract last 10 s"
            onPress={extractLast10s}
            disabled={!hasRecorder}
          />
          <Button
            title="Stop"
            onPress={stop}
            disabled={!hasRecorder}
            color="#c0392b"
          />
          <Button title="Run recovery now" onPress={runRecovery} />
          <Button
            title="Simulate crash (release builds)"
            onPress={simulateCrash}
            color="#7f8c8d"
          />
        </View>

        {segments.length > 0 && (
          <Section title={`Segments (${segments.length})`}>
            {segments.map((segment) => (
              <Text key={segment.filePath} style={styles.mono}>
                #{segment.index} {basename(segment.filePath)}{' '}
                {(segment.durationMs / 1000).toFixed(1)} s @
                {(segment.mediaStartMs / 1000).toFixed(1)} s
                {segment.wasInterrupted
                  ? ` interrupted(${segment.interruptionReason})`
                  : ''}
                {segment.routeChanged ? ' routeChanged' : ''}
              </Text>
            ))}
          </Section>
        )}

        {recovered.length > 0 && (
          <Section title={`Recovered (${recovered.length})`}>
            {recovered.map((recording) => (
              <Text key={recording.logicalId} style={styles.mono}>
                {recording.logicalId}: {recording.sessions.length} session(s),{' '}
                {recording.segments.length} segment(s),{' '}
                {(recording.totalDurationMs / 1000).toFixed(1)} s
              </Text>
            ))}
          </Section>
        )}

        <Section title="Log">
          {log.map((line, index) => (
            <Text key={index} style={styles.mono}>
              {line}
            </Text>
          ))}
        </Section>
      </ScrollView>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 50 },
  content: { padding: 16, gap: 8 },
  title: { fontSize: 20, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: '#555' },
  rowValue: { fontVariant: ['tabular-nums'] },
  buttons: { gap: 6, marginVertical: 12 },
  section: { marginTop: 12, gap: 2 },
  sectionTitle: { fontWeight: '600', marginBottom: 4 },
  mono: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 11,
  },
});
