import { PlayerQueue, TrackPlayer } from 'react-native-nitro-player';

/**
 * Thin wrapper over react-native-nitro-player: one playlist for everything this app records,
 * tracks added as they appear (local file or remote URL), play by id.
 */
let playlistId: string | null = null;
const knownTrackIds = new Set<string>();

export interface PlayableTrack {
  id: string;
  title: string;
  url: string;
  durationSec: number;
}

async function ensurePlaylist(): Promise<string> {
  if (playlistId) return playlistId;
  await TrackPlayer.configure({
    androidAutoEnabled: false,
    carPlayEnabled: false,
    showInNotification: true,
  });
  playlistId = await PlayerQueue.createPlaylist(
    'Anvil recordings',
    'Recorded with react-native-nitro-audio-anvil'
  );
  return playlistId;
}

export function toFileUrl(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

export async function registerTrack(track: PlayableTrack): Promise<void> {
  const id = await ensurePlaylist();
  if (knownTrackIds.has(track.id)) return;
  knownTrackIds.add(track.id);
  await PlayerQueue.addTrackToPlaylist(id, {
    id: track.id,
    title: track.title,
    artist: 'Anvil',
    album: 'Recordings',
    duration: track.durationSec,
    url: track.url,
    artwork: null,
  });
}

export async function playTrack(track: PlayableTrack): Promise<void> {
  console.log('[player] playTrack', { id: track.id, url: track.url });
  await registerTrack(track);
  const id = await ensurePlaylist();
  await PlayerQueue.loadPlaylist(id);
  await TrackPlayer.playSong(track.id, id);
  console.log('[player] playSong sent');
}
