// Registration of the plugin chain families (imported for its side effect by ../index.ts).
import { registerFamily } from '../families.ts';
import { bchPlugin } from './bch.ts';

registerFamily(bchPlugin);
