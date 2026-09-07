export { Anvil } from './Anvil';

export type { AnvilFactory } from './specs/AnvilFactory.nitro';

export type { AnvilRecorder } from './specs/AnvilRecorder.nitro';

export type { ListenerSubscription } from './types/ListenerSubscription';

export type { RecorderConfig } from './types/RecorderConfig';

export type { NotificationConfig } from './types/NotificationConfig';

export type { InterruptionPolicy } from './types/InterruptionPolicy';

export type { RecorderState } from './types/RecorderState';

export type { RecordingSegment } from './types/RecordingSegment';

export type { PCMChunk } from './types/PCMChunk';

export type { SpeakerWindow } from './types/SpeakerWindow';

export type {
  InterruptionEvent,
  InterruptionPhase,
  InterruptionReason,
} from './types/InterruptionEvent';

export type {
  RouteChangeEvent,
  RouteChangeReason,
} from './types/RouteChangeEvent';

export type { PermissionStatus } from './types/PermissionStatus';

export type { StorageWarningEvent } from './types/StorageWarningEvent';

export type { RecorderError, RecorderErrorCode } from './types/RecorderError';

export type { OrphanedRecording } from './types/OrphanedRecording';

export { createRecordingService } from './recovery/createRecordingService';

export { createFileMarkerStore } from './recovery/FileMarkerStore';

export type {
  RecordingService,
  MarkerStore,
} from './recovery/RecordingService';

export type {
  RecoveredRecording,
  RecoveredSession,
  RecoveryMarker,
} from './recovery/types';
