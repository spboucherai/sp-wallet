// Registers every plugin chain family. Imported by packages/core/src/index.ts so the signer, the API and the address
// validator all see the same set.
import { registerFamily } from '../families.ts';
import { tronPlugin } from './tron.ts';

registerFamily(tronPlugin);

export * from './tron.ts';
