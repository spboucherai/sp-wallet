// Provider registry. One file per provider in this directory; each exports a factory returning a SwapProvider.
import type { SwapProvider } from '../types.ts';
import { createLifiProvider } from './lifi.ts';
import { createDebridgeProvider } from './debridge.ts';

export interface ProviderEnv { [key: string]: string | undefined }
/** Every real provider adapter, in a fixed order. A provider that needs a key reports `configured: false` without one. */
export function createProviders(env: ProviderEnv = {}): SwapProvider[] {
  return [createLifiProvider(env), createDebridgeProvider(env)];
}
