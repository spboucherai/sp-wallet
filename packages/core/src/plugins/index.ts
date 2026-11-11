// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.
import { registerFamily } from '../families.ts';
import { aptosPlugin } from './aptos.ts';
import { bchPlugin } from './bch.ts';
import { cosmosPlugin } from './cosmos.ts';
import { nearPlugin } from './near.ts';
import { stellarPlugin } from './stellar.ts';
import { suiPlugin } from './sui.ts';
import { tronPlugin } from './tron.ts';
import { xrplPlugin } from './xrpl.ts';

for (const p of [aptosPlugin, bchPlugin, cosmosPlugin, nearPlugin, stellarPlugin, suiPlugin, tronPlugin, xrplPlugin]) registerFamily(p);

export * from './aptos.ts';
export * from './bch.ts';
export * from './cosmos.ts';
export * from './near.ts';
export * from './stellar.ts';
export * from './sui.ts';
export * from './tron.ts';
export * from './xrpl.ts';
