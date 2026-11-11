// Chain family plugins. Importing this module registers every plugin with the registry in families.ts.
import { registerFamily } from '../families.ts';
import { stellarPlugin } from './stellar.ts';

registerFamily(stellarPlugin);

export * from './stellar.ts';
