import type { AnvilFactory } from '../specs/AnvilFactory.nitro';

/**
 * Microphone permission state.
 *
 * @see {@linkcode AnvilFactory.getPermissionStatus}
 */
export type AnvilPermissionStatus = 'granted' | 'denied' | 'undetermined';
