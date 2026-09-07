import ReactNativeBlobUtil from 'react-native-blob-util';

import {
  createFileMarkerStore,
  createRecordingService,
} from 'react-native-nitro-audio-anvil';

const fs = ReactNativeBlobUtil.fs;
export const OUTPUT_DIRECTORY = `${fs.dirs.DocumentDir}/anvil-recordings`;

const fileSystemBridge = {
  async readText(path: string) {
    try {
      return await fs.readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  async writeText(path: string, contents: string) {
    await fs.writeFile(path, contents, 'utf8');
  },
  async delete(path: string) {
    if (await fs.exists(path)) await fs.unlink(path);
  },
  async list(directory: string) {
    try {
      const names = await fs.ls(directory);
      return names.map((name) => `${directory}/${name}`);
    } catch {
      return [];
    }
  },
};

export const recorderService = createRecordingService({
  outputDirectory: OUTPUT_DIRECTORY,
  markerStore: createFileMarkerStore(fileSystemBridge, OUTPUT_DIRECTORY),
});

export async function ensureOutputDirectory(): Promise<void> {
  if (!(await fs.exists(OUTPUT_DIRECTORY))) await fs.mkdir(OUTPUT_DIRECTORY);
}
