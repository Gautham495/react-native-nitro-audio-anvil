import { NitroModules } from 'react-native-nitro-modules';
import type { NitroAudioAnvil } from './NitroAudioAnvil.nitro';

const NitroAudioAnvilHybridObject =
  NitroModules.createHybridObject<NitroAudioAnvil>('NitroAudioAnvil');

export function multiply(a: number, b: number): number {
  return NitroAudioAnvilHybridObject.multiply(a, b);
}
