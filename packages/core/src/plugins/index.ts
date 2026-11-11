// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.
import { registerFamily } from '../families.ts';
import { stellarPlugin } from './stellar.ts';
import { tronPlugin } from './tron.ts';
import { xrplPlugin } from './xrpl.ts';

for (const p of [stellarPlugin, tronPlugin, xrplPlugin]) registerFamily(p);

export * from './stellar.ts';
export * from './tron.ts';
export * from './xrpl.ts';
