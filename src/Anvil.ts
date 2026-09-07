import { NitroModules } from 'react-native-nitro-modules';

import type { AnvilFactory } from './specs/AnvilFactory.nitro';

export const Anvil =
  NitroModules.createHybridObject<AnvilFactory>('AnvilFactory');
