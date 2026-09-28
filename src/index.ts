export { Anvil } from './Anvil';

export type { AnvilFactory } from './specs/AnvilFactory.nitro';
export type { AnvilRecorder } from './specs/AnvilRecorder.nitro';

export type { RecorderConfig } from './types/RecorderConfig';
export type { NotificationConfig } from './types/NotificationConfig';
export type { InterruptionPolicy } from './types/InterruptionPolicy';
export type { RecorderState } from './types/RecorderState';
export type { RecordingSegment } from './types/RecordingSegment';
export type { RecoveredRecording } from './types/RecoveredRecording';
export type { PendingUpload, PendingUploadKind } from './types/PendingUpload';
export type { PCMChunk } from './types/PCMChunk';
export type { SpeakerWindow } from './types/SpeakerWindow';

export type {
  AnvilPermissionStatus,
  AnvilPermissionStatus as PermissionStatus,
} from './types/AnvilPermissionStatus';

export type {
  AnvilListenerSubscription,
  AnvilListenerSubscription as ListenerSubscription,
} from './types/AnvilListenerSubscription';

export type {
  AnvilInterruptionReason,
  AnvilInterruptionReason as InterruptionReason,
  AnvilInterruptionPhase as InterruptionPhase,
  AnvilInterruptionEvent,
} from './types/AnvilInterruptionEvent';

export type {
  RouteChangeEvent,
  RouteChangeReason,
} from './types/RouteChangeEvent';

export type { StorageWarningEvent } from './types/StorageWarningEvent';

export type { RecorderError, RecorderErrorCode } from './types/RecorderError';
