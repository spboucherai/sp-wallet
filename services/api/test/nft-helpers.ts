// NFT tests — replay of the recorded fixtures (scripts/record-nft-fixtures.mts): an `RpcFn` that answers a call with what the
// live endpoint answered when the fixture was recorded, matched on host + method + exact parameters. A call that was not
// recorded throws `unrecorded call` (the test then says which one): nothing is ever answered from imagination.
import { readFileSync } from 'node:fs';

export interface RecordedCall { host: string; method: string; params: unknown; result?: unknown; error?: { code?: number; message: string } }
export interface Fixture { recordedAt: string; note: string; calls: RecordedCall[]; [k: string]: unknown }
export const loadFixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`./fixtures/nft/${name}.json`, import.meta.url), 'utf8')) as Fixture;

export function replay(...fixtures: Fixture[]) {
  const calls = fixtures.flatMap((f) => f.calls), asked: { host: string; method: string; params: unknown }[] = [];
  const rpc = async (url: string, method: string, params: unknown): Promise<unknown> => {
    const host = new URL(url).host, p = JSON.stringify(params);
    asked.push({ host, method, params });
    const c = calls.find((x) => x.host === host && x.method === method && JSON.stringify(x.params) === p);
    if (!c) throw new Error(`unrecorded call ${host} ${method} ${p.slice(0, 200)}`);
    if (c.error) throw Object.assign(new Error(c.error.message), c.error.code !== undefined ? { rpcCode: c.error.code } : {});
    return structuredClone(c.result);
  };
  return { rpc, asked };
}
/** A fixed clock: recorded answers are replayed "at" the time they were recorded. */
export const clockOf = (f: Fixture) => () => new Date(f.recordedAt);
