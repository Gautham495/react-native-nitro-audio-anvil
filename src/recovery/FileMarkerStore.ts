import type { MarkerStore } from './RecordingService';

import type { RecoveryMarker } from './types';

/**
 * Marker store backed by JSON files under `<outputDirectory>/<sessionId>.recording.json`.
 * The default for `createRecordingService`. Works with `react-native-blob-util`, `expo-file-system` or any file API;
 * you inject the four file ops so this package stays dependency-free.
 */
export interface FileSystemBridge {
  /** Reads a UTF-8 file, resolves to `null` when it does not exist. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, contents: string): Promise<void>;
  delete(path: string): Promise<void>;
  /** Returns absolute paths (or `file://` URLs) of every entry in `directory`. */
  list(directory: string): Promise<string[]>;
}

export function createFileMarkerStore(
  bridge: FileSystemBridge,
  directory: string
): MarkerStore {
  const normalizedDir = directory.replace(/\/$/, '');
  const pathFor = (sessionId: string) =>
    `${normalizedDir}/${sessionId}.recording.json`;

  return {
    async write(marker: RecoveryMarker): Promise<void> {
      await bridge.writeText(pathFor(marker.sessionId), JSON.stringify(marker));
    },

    async read(sessionId: string): Promise<RecoveryMarker | null> {
      const contents = await bridge.readText(pathFor(sessionId));
      if (contents === null) return null;
      try {
        const parsed = JSON.parse(contents) as RecoveryMarker;
        if (
          typeof parsed.logicalId !== 'string' ||
          typeof parsed.sessionId !== 'string'
        )
          return null;
        return parsed;
      } catch {
        return null;
      }
    },

    async delete(sessionId: string): Promise<void> {
      await bridge.delete(pathFor(sessionId));
    },

    async list(): Promise<RecoveryMarker[]> {
      const entries = await bridge.list(normalizedDir);
      const markerPaths = entries.filter((entry) =>
        entry.endsWith('.recording.json')
      );
      const markers: RecoveryMarker[] = [];
      for (const path of markerPaths) {
        const contents = await bridge.readText(path);
        if (contents === null) continue;
        try {
          const parsed = JSON.parse(contents) as RecoveryMarker;
          if (
            typeof parsed.logicalId === 'string' &&
            typeof parsed.sessionId === 'string'
          ) {
            markers.push(parsed);
          }
        } catch {
          // Corrupted marker — ignore. The orphan scanner will still recover the audio.
        }
      }
      return markers;
    },
  };
}
