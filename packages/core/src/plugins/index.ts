// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.
import { registerFamily } from '../families.ts';
import { bchPlugin } from './bch.ts';
import { stellarPlugin } from './stellar.ts';
import { tonPlugin } from './ton.ts';
import { tronPlugin } from './tron.ts';
import { xrplPlugin } from './xrpl.ts';

for (const p of [bchPlugin, stellarPlugin, tonPlugin, tronPlugin, xrplPlugin]) registerFamily(p);

export * from './bch.ts';
export * from './stellar.ts';
export * from './ton.ts';
export * from './tron.ts';
export * from './xrpl.ts';
