// Registration of the plugin chain families. Imported by ../index.ts so that every consumer of @spw/core has them.
import { registerFamily } from '../families.ts';
import { xrplPlugin } from './xrpl.ts';

registerFamily(xrplPlugin);

export * from './xrpl.ts';
