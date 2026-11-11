// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.
import { registerFamily } from '../families.ts';
import { stellarPlugin } from './stellar.ts';
import { xrplPlugin } from './xrpl.ts';

for (const p of [stellarPlugin, xrplPlugin]) registerFamily(p);

export * from './stellar.ts';
export * from './xrpl.ts';
