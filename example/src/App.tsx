import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
} from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';

import {
  Anvil,
  type AnvilListenerSubscription,
  type AnvilRecorder,
  type PCMChunk,
  type RecorderState,
  type RecordingSegment,
  type RecoveredRecording,
  type SpeakerWindow,
} from 'react-native-nitro-audio-anvil';

import { Card, Row } from './ui/Card';
import { Button, ButtonRow } from './ui/Button';
import { LevelMeter } from './ui/LevelMeter';
import { EventLog } from './EventLog';
import { RecordingsList } from './RecordingsList';
import { RecoveryCard } from './RecoveryCard';
import { UploadCard, type UploadTarget } from './UploadCard';
import {
  attachHlsSync,
  drainPendingUploads,
  type HlsSyncEvent,
} from './hlsSyncAgent';
import {
  OUTPUT_DIRECTORY,
  ensureOutputDirectory,
  makeRecordingId,
  recorderService,
} from './recorderService';
import { basename, colors, formatBytes, formatClock, spacing } from './theme';

const CONFIG = {
  segmentDurationMs: 3000,
  fsyncIntervalMs: 500,
  sampleRate: 48000,
  aacBitrate: 96000,
  streamChunkMs: 100,
  speakerWindowMs: 1500,
  speakerWindowHopMs: 750,
  onInterruption: 'resume' as const,
  keepAwakeInBackground: true,
  storageWarningBytes: 100 * 1024 * 1024,
  notification: {
    title: 'Recording',
    text: 'Anvil is capturing audio',
  },
};

export default function App() {
  const [permission, setPermission] = useState<string>('undetermined');
  const [recordingState, setRecordingState] = useState<RecorderState>('idle');
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [rms, setRms] = useState(0);
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  const [fullFile, setFullFile] = useState<RecordingSegment | null>(null);
  const [hlsUrl, setHlsUrl] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<UploadTarget | null>(null);
  const [orphans, setOrphans] = useState<RecoveredRecording[]>([]);
  const [eventLines, setEventLines] = useState<string[]>([]);

  const listenerSubs = useRef<AnvilListenerSubscription[]>([]);
  const detachSync = useRef<(() => void) | null>(null);
  const pcmSequence = useRef(0);

  const log = useCallback((line: string) => {
    setEventLines((prev) =>
      [`${formatClock(Date.now() % 86400000)} ${line}`, ...prev].slice(0, 40)
    );
  }, []);

  const copyToClipboard = useCallback(
    (value: string, label: string) => {
      Clipboard.setString(value);
      log(`copied ${label} to clipboard`);
    },
    [log]
  );

  const teardownRecorder = useCallback(() => {
    detachSync.current?.();
    detachSync.current = null;
    setIsStreaming(false);
    for (const sub of listenerSubs.current) sub.remove();
    listenerSubs.current = [];
  }, []);

  const attachRecorderListeners = useCallback(
    (recorder: AnvilRecorder) => {
      // Recording-side listeners only — no HLS sync here. Streaming is a
      // separate toggle so the user can record locally without pushing to R2.
      for (const sub of listenerSubs.current) sub.remove();
      listenerSubs.current = [
        recorder.addPCMListener((chunk: PCMChunk) => {
          if (chunk.sequenceNumber !== pcmSequence.current) {
            log(
              `pcm gap: expected ${pcmSequence.current} got ${chunk.sequenceNumber}`
            );
            pcmSequence.current = chunk.sequenceNumber;
          }
          pcmSequence.current += 1;
        }),
        recorder.addSpeakerWindowListener((window: SpeakerWindow) => {
          setRms(window.rms);
        }),
        recorder.addSegmentCompletedListener((segment) => {
          setSegments((prev) => [...prev, segment]);
          setDurationMs(recorder.totalDurationMs);
          log(
            `segment ${segment.filename} · ${formatClock(segment.durationMs)}`
          );
        }),
        recorder.addManifestUpdatedListener((path) => {
          log(`manifest ${basename(path)} rewritten`);
        }),
        recorder.addInterruptionListener((event) => {
          log(
            `interruption ${event.phase} · ${event.reason} · resume=${event.shouldResume}`
          );
        }),
        recorder.addRouteChangeListener((event) => {
          log(`route ${event.reason} → ${event.inputName || '?'}`);
        }),
        recorder.addStorageWarningListener((event) => {
          log(`storage warn: ${formatBytes(event.freeBytes)} free`);
        }),
        recorder.addErrorListener((error) => {
          log(`error [${error.code}] ${error.message}`);
        }),
      ];
    },
    [log]
  );

  // Initial load: permission + directory + recovery scan + retry queue.
  useEffect(() => {
    (async () => {
      await ensureOutputDirectory();
      const status = await Anvil.getPermissionStatus();
      setPermission(status);
      log(`init: permission=${status} dir=${OUTPUT_DIRECTORY}`);

      const found = await recorderService.recoverPending();
      setOrphans(found);
      if (found.length > 0) {
        log(`recovery: ${found.length} unsealed folder(s)`);
      }

      await drainPendingUploads((event) => reportSyncEvent(event, log));
    })().catch((error) => log(`init failed: ${String(error)}`));

    return () => {
      teardownRecorder();
    };
  }, [log, teardownRecorder]);

  // Duration + state poll while recording. Owns its own interval.
  useEffect(() => {
    if (recordingState !== 'recording' && recordingState !== 'paused') return;
    const tick = setInterval(() => {
      const recorder = recorderService.active;
      if (!recorder) return;
      setDurationMs(recorder.totalDurationMs);
      setRecordingState(recorder.state);
    }, 500);
    return () => clearInterval(tick);
  }, [recordingState]);

  const requestPermission = useCallback(async () => {
    const status = await Anvil.requestPermission();
    setPermission(status);
    log(`requestPermission → ${status}`);
  }, [log]);

  const startRecording = useCallback(async () => {
    try {
      const id = makeRecordingId();
      setRecordingId(id);
      setSegments([]);
      setFullFile(null);
      setHlsUrl(null);
      setUploadTarget(null);
      pcmSequence.current = 0;
      log(`start recording → ${id}`);

      const recorder = await recorderService.begin({
        recordingId: id,
        config: CONFIG,
      });
      attachRecorderListeners(recorder);
      setRecordingState('recording');
    } catch (error) {
      log(`start failed: ${String(error)}`);
      Alert.alert('Start failed', String(error));
    }
  }, [attachRecorderListeners, log]);

  const stopRecording = useCallback(async () => {
    try {
      log('stop recording');
      const finalSegments = await recorderService.end();
      teardownRecorder();
      setSegments(finalSegments);
      setRecordingState('stopped');
      setDurationMs(finalSegments.reduce((acc, s) => acc + s.durationMs, 0));
      log(`stopped · ${finalSegments.length} segments`);
    } catch (error) {
      log(`stop failed: ${String(error)}`);
    }
  }, [log, teardownRecorder]);

  const pauseOrResume = useCallback(async () => {
    const recorder = recorderService.active;
    if (!recorder) return;
    try {
      if (recorder.state === 'recording') {
        await recorder.pause();
        log('paused');
      } else {
        await recorder.resume();
        log('resumed');
      }
      setRecordingState(recorder.state);
    } catch (error) {
      log(`pause/resume failed: ${String(error)}`);
    }
  }, [log]);

  // Streaming toggle — attaches the HLS sync agent to the active recorder.
  // Can be turned on at any point during a recording; when off, segments are
  // still written to disk but nothing goes to the bucket.
  const startStreaming = useCallback(() => {
    const recorder = recorderService.active;
    if (!recorder) {
      Alert.alert('Not recording', 'Start a recording first.');
      return;
    }
    if (detachSync.current) return;
    log(`start streaming to R2 → recording ${recorder.recordingId}`);
    detachSync.current = attachHlsSync(recorder, (event) => {
      reportSyncEvent(event, log);
      if (event.kind === 'manifest' && event.url) {
        setHlsUrl(event.url);
      }
    });
    setIsStreaming(true);
  }, [log]);

  const stopStreaming = useCallback(() => {
    if (!detachSync.current) return;
    log('stop streaming to R2');
    detachSync.current();
    detachSync.current = null;
    setIsStreaming(false);
  }, [log]);

  const concatenate = useCallback(async () => {
    if (!recordingId) return;
    try {
      const outputPath = `${OUTPUT_DIRECTORY}/${recordingId}.aac`;
      log(`concatenating → ${basename(outputPath)}`);
      const result = await recorderService.concatenate(recordingId, outputPath);
      setFullFile(result);
      setUploadTarget({
        path: result.filePath,
        sizeBytes: result.fileSize,
        durationMs: result.durationMs,
      });
      log(
        `concatenated: ${formatBytes(result.fileSize)} · ${formatClock(result.durationMs)}`
      );
    } catch (error) {
      log(`concatenate failed: ${String(error)}`);
    }
  }, [recordingId, log]);

  const discardCurrent = useCallback(async () => {
    if (!recordingId) return;
    try {
      const removed = await recorderService.deleteRecording(recordingId);
      log(`delete ${recordingId} → ${removed}`);
      setRecordingId(null);
      setSegments([]);
      setFullFile(null);
      setHlsUrl(null);
      setUploadTarget(null);
      setRecordingState('idle');
    } catch (error) {
      log(`delete failed: ${String(error)}`);
    }
  }, [recordingId, log]);

  // Recovery flow: three verbs, all self-contained.
  const resumeOrphan = useCallback(
    async (orphan: RecoveredRecording) => {
      try {
        log(`resume orphan → ${orphan.recordingId}`);
        pcmSequence.current = 0;
        const recorder = await recorderService.begin({
          recordingId: orphan.recordingId,
          config: { ...CONFIG, resume: true },
        });
        attachRecorderListeners(recorder);
        setRecordingId(orphan.recordingId);
        setSegments(orphan.segments);
        setDurationMs(orphan.totalDurationMs);
        setFullFile(null);
        setHlsUrl(null);
        setUploadTarget(null);
        setOrphans((prev) =>
          prev.filter((o) => o.recordingId !== orphan.recordingId)
        );
        setRecordingState('recording');
      } catch (error) {
        log(`resume failed: ${String(error)}`);
        Alert.alert('Resume failed', String(error));
      }
    },
    [attachRecorderListeners, log]
  );

  const finalizeOrphan = useCallback(
    async (orphan: RecoveredRecording) => {
      try {
        const outputPath = `${OUTPUT_DIRECTORY}/${orphan.recordingId}.aac`;
        log(`finalize orphan → ${basename(outputPath)}`);
        const result = await recorderService.concatenate(
          orphan.recordingId,
          outputPath
        );
        setRecordingId(orphan.recordingId);
        setSegments(orphan.segments);
        setFullFile(result);
        setUploadTarget({
          path: result.filePath,
          sizeBytes: result.fileSize,
          durationMs: result.durationMs,
        });
        setDurationMs(result.durationMs);
        setRecordingState('stopped');
        setOrphans((prev) =>
          prev.filter((o) => o.recordingId !== orphan.recordingId)
        );
        log(
          `finalized: ${formatBytes(result.fileSize)} · ${formatClock(result.durationMs)}`
        );
      } catch (error) {
        log(`finalize failed: ${String(error)}`);
        Alert.alert('Finalize failed', String(error));
      }
    },
    [log]
  );

  const discardOrphan = useCallback(
    async (orphan: RecoveredRecording) => {
      try {
        const removed = await recorderService.deleteRecording(
          orphan.recordingId
        );
        log(`discard orphan ${orphan.recordingId} → ${removed}`);
        setOrphans((prev) =>
          prev.filter((o) => o.recordingId !== orphan.recordingId)
        );
      } catch (error) {
        log(`discard orphan failed: ${String(error)}`);
      }
    },
    [log]
  );

  const shareFile = useCallback(
    async (segment: RecordingSegment) => {
      try {
        const uri = segment.filePath.startsWith('file://')
          ? segment.filePath
          : `file://${segment.filePath}`;
        await Share.share({ url: uri, message: segment.filename });
      } catch (error) {
        log(`share failed: ${String(error)}`);
      }
    },
    [log]
  );

  const canStream =
    recordingState === 'recording' || recordingState === 'paused';

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title}>Anvil 2.0</Text>
        <Text style={styles.subtitle}>
          HLS-native recorder · stream to R2 · live listen anywhere
        </Text>

        <RecoveryCard
          orphans={orphans}
          onResume={resumeOrphan}
          onFinalize={finalizeOrphan}
          onDiscard={discardOrphan}
        />

        <Card title="Recorder" badge={recordingState}>
          <Row label="permission" value={permission} />
          <Row label="recording id" value={recordingId ?? '—'} mono />
          <Row label="duration" value={formatClock(durationMs)} mono />
          <Row label="segments" value={`${segments.length}`} mono />
          <Row
            label="streaming"
            value={isStreaming ? 'live to R2' : 'off'}
            mono
          />
          <LevelMeter rms={rms} active={recordingState === 'recording'} />
          <ButtonRow>
            {permission !== 'granted' ? (
              <Button
                title="Grant mic"
                variant="record"
                onPress={requestPermission}
              />
            ) : recordingState === 'idle' || recordingState === 'stopped' ? (
              <Button
                title="Record"
                variant="record"
                onPress={startRecording}
              />
            ) : (
              <>
                <Button
                  title={recordingState === 'recording' ? 'Pause' : 'Resume'}
                  variant="neutral"
                  onPress={pauseOrResume}
                />
                <Button title="Stop" variant="danger" onPress={stopRecording} />
              </>
            )}
          </ButtonRow>
          {canStream ? (
            <ButtonRow>
              {isStreaming ? (
                <Button
                  title="Stop streaming"
                  variant="danger"
                  onPress={stopStreaming}
                />
              ) : (
                <Button
                  title="Start streaming to R2"
                  variant="upload"
                  onPress={startStreaming}
                />
              )}
            </ButtonRow>
          ) : null}
          {recordingId ? (
            <ButtonRow>
              <Button
                title="Copy recording id"
                variant="ghost"
                onPress={() =>
                  copyToClipboard(recordingId, `recording id ${recordingId}`)
                }
              />
            </ButtonRow>
          ) : null}
          {recordingState === 'stopped' && recordingId ? (
            <ButtonRow>
              <Button
                title="Concatenate → archive"
                variant="upload"
                onPress={concatenate}
              />
              <Button
                title="Discard folder"
                variant="danger"
                onPress={discardCurrent}
              />
            </ButtonRow>
          ) : null}
        </Card>

        <RecordingsList
          fullFile={fullFile}
          segments={segments}
          hlsUrl={hlsUrl}
          onPlayLocal={() => {}}
          onCopyHlsUrl={(url) => copyToClipboard(url, 'HLS URL')}
          onShare={shareFile}
          onUploadTarget={(segment) =>
            setUploadTarget({
              path: segment.filePath,
              sizeBytes: segment.fileSize,
              durationMs: segment.durationMs,
            })
          }
        />

        <UploadCard
          target={uploadTarget}
          onUploaded={(url) => {
            log(`archive URL: ${url}`);
            copyToClipboard(url, 'archive URL');
          }}
          log={log}
        />

        <EventLog lines={eventLines} />
      </ScrollView>
    </SafeAreaView>
  );
}

function reportSyncEvent(event: HlsSyncEvent, log: (line: string) => void) {
  if (event.error) {
    log(`sync ${event.kind} ${event.filename} failed: ${event.error}`);
  } else {
    log(`sync ${event.kind} ${event.filename} → ${event.url ?? 'ok'}`);
  }
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  scroll: {
    padding: spacing.lg,
    gap: spacing.lg,
    paddingBottom: Platform.select({ ios: 40, default: 24 }),
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  subtitle: { color: colors.muted, fontSize: 13, marginTop: -spacing.md },
});
