import ReactNativeBlobUtil from 'react-native-blob-util';

import {
  Anvil,
  type AnvilRecorder,
  type RecorderConfig,
  type RecordingSegment,
  type RecoveredRecording,
} from 'react-native-nitro-audio-anvil';

const fs = ReactNativeBlobUtil.fs;

export const OUTPUT_DIRECTORY = `${fs.dirs.DocumentDir}/anvil-recordings`;

export async function ensureOutputDirectory(): Promise<void> {
  if (!(await fs.exists(OUTPUT_DIRECTORY))) await fs.mkdir(OUTPUT_DIRECTORY);
}

export const recorderService = {
  active: null as AnvilRecorder | null,
  activeRecordingId: null as string | null,

  async begin(input: {
    recordingId: string;
    config: Omit<RecorderConfig, 'outputDirectory' | 'recordingId'>;
  }): Promise<AnvilRecorder> {
    if (this.active) {
      throw new Error(
        `Recording ${this.activeRecordingId ?? '?'} is already active — call end() first`
      );
    }
    const recorder = await Anvil.createRecorder({
      ...input.config,
      outputDirectory: OUTPUT_DIRECTORY,
      recordingId: input.recordingId,
    });
    await recorder.start();
    this.active = recorder;
    this.activeRecordingId = input.recordingId;
    return recorder;
  },

  async end(): Promise<RecordingSegment[]> {
    const recorder = this.active;
    if (!recorder) return [];
    try {
      return await recorder.stop();
    } finally {
      this.active = null;
      this.activeRecordingId = null;
    }
  },

  /**
   * Every folder under OUTPUT_DIRECTORY whose manifest is unsealed. On next launch,
   * decide per entry: resume, finalize + upload, or discard.
   */
  async recoverPending(): Promise<RecoveredRecording[]> {
    return Anvil.discoverOrphanedRecordings(OUTPUT_DIRECTORY);
  },

  async deleteRecording(recordingId: string): Promise<boolean> {
    return Anvil.deleteRecording(OUTPUT_DIRECTORY, recordingId);
  },

  async concatenate(
    recordingId: string,
    outputPath: string
  ): Promise<RecordingSegment> {
    return Anvil.concatenate(OUTPUT_DIRECTORY, recordingId, outputPath);
  },
};

export function makeRecordingId(): string {
  // Compact and sortable — folder listing groups by time. No slashes / dots.
  const iso = new Date()
    .toISOString()
    .replace(/[^0-9]/g, '')
    .slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rec-${iso}-${rand}`;
}
