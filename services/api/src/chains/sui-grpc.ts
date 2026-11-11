// Sui full-node API (sui.rpc.v2) over gRPC on HTTP/2, without any dependency: public Sui full nodes switched JSON-RPC off in 2026
// and answer only gRPC. This file holds (1) a unary / server-streaming gRPC call on node:http2, (2) a small schema-driven protobuf
// codec and (3) the handful of message layouts the adapter uses. Field numbers are those of the official .proto files
// (github.com/MystenLabs/sui-apis, proto/sui/rpc/v2); services/api/test/sui.test.ts checks every layout here against the
// message types generated from those files and shipped in @mysten/sui (devDependency).
import http2 from 'node:http2';

// ---------------------------------------------------------------- protobuf codec
export type Kind = 'string' | 'u64' | 'u32' | 'bool' | 'bytes' | Schema;
export interface Field { n: number; k: Kind; rep?: true }
export interface Schema { [name: string]: Field }

const U64_MAX = (1n << 64n) - 1n;
const utf8 = new TextEncoder(), utf8d = new TextDecoder('utf-8', { fatal: true });
function varint(v: bigint, out: number[]): void {
  if (v < 0n || v > U64_MAX) throw new Error('protobuf: varint out of range');
  while (v > 0x7fn) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
}
function put(out: number[], f: Field, v: unknown): void {
  const scalar = f.k === 'u64' || f.k === 'u32' || f.k === 'bool';
  varint(BigInt((f.n << 3) | (scalar ? 0 : 2)), out);
  if (f.k === 'u64' || f.k === 'u32') { const b = BigInt(v as bigint | number); if (f.k === 'u32' && b > 0xffff_ffffn) throw new Error('protobuf: uint32 out of range'); varint(b, out); return; }
  if (f.k === 'bool') { out.push(v ? 1 : 0); return; }
  const body = f.k === 'string' ? utf8.encode(v as string) : f.k === 'bytes' ? (v as Uint8Array) : encode(f.k, v as Record<string, unknown>);
  varint(BigInt(body.length), out);
  for (const b of body) out.push(b);
}
/** Encode an object. Absent (undefined) fields are omitted; repeated fields are arrays. Unknown property names throw. */
export function encode(s: Schema, v: Record<string, unknown>): Uint8Array {
  const out: number[] = [];
  for (const name of Object.keys(v)) if (!s[name]) throw new Error(`protobuf: unknown field ${name}`);
  for (const [name, f] of Object.entries(s).sort((a, b) => a[1].n - b[1].n)) {
    const val = v[name];
    if (val === undefined) continue;
    if (f.rep) for (const x of val as unknown[]) put(out, f, x); else put(out, f, val);
  }
  return Uint8Array.from(out);
}
/** Decode a message. Fields not in the schema are skipped; absent fields are undefined (repeated: []). u64 -> bigint, u32 -> number. */
export function decode<T = Record<string, unknown>>(s: Schema, b: Uint8Array, depth = 0): T {
  if (depth > 16) throw new Error('protobuf: nesting too deep');
  const byNum = new Map<number, [string, Field]>(Object.entries(s).map(([name, f]) => [f.n, [name, f]]));
  const out: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(s)) if (f.rep) out[name] = [];
  let o = 0;
  const rv = (): bigint => {
    let v = 0n, shift = 0n;
    for (;;) {
      if (o >= b.length || shift > 63n) throw new Error('protobuf: bad varint');
      const x = b[o++]!;
      v |= BigInt(x & 0x7f) << shift;
      if (!(x & 0x80)) return v & U64_MAX;
      shift += 7n;
    }
  };
  while (o < b.length) {
    const tag = rv(), num = Number(tag >> 3n), wire = Number(tag & 7n);
    let val: bigint | Uint8Array | null = null;
    if (wire === 0) val = rv();
    else if (wire === 2) { const len = Number(rv()); if (o + len > b.length) throw new Error('protobuf: truncated field'); val = b.subarray(o, o + len); o += len; }
    else if (wire === 1) { if (o + 8 > b.length) throw new Error('protobuf: truncated field'); o += 8; }
    else if (wire === 5) { if (o + 4 > b.length) throw new Error('protobuf: truncated field'); o += 4; }
    else throw new Error('protobuf: unsupported wire type');
    const hit = byNum.get(num);
    if (!hit) continue;
    const [name, f] = hit;
    const scalar = f.k === 'u64' || f.k === 'u32' || f.k === 'bool';
    if (scalar !== (wire === 0) || (!scalar && wire !== 2)) throw new Error(`protobuf: wrong wire type for ${name}`);
    let x: unknown;
    if (f.k === 'u64') x = val as bigint;
    else if (f.k === 'u32') { if ((val as bigint) > 0xffff_ffffn) throw new Error(`protobuf: ${name} out of range`); x = Number(val as bigint); }
    else if (f.k === 'bool') x = (val as bigint) !== 0n;
    else if (f.k === 'string') x = utf8d.decode(val as Uint8Array);
    else if (f.k === 'bytes') x = (val as Uint8Array).slice();
    else x = decode(f.k, val as Uint8Array, depth + 1);
    if (f.rep) (out[name] as unknown[]).push(x); else out[name] = x;
  }
  return out as T;
}

// ---------------------------------------------------------------- message layouts (sui.rpc.v2)
const FieldMask: Schema = { paths: { n: 1, k: 'string', rep: true } };
const Timestamp: Schema = { seconds: { n: 1, k: 'u64' }, nanos: { n: 2, k: 'u32' } };
const Bcs: Schema = { name: { n: 1, k: 'string' }, value: { n: 2, k: 'bytes' } };
const Owner: Schema = { kind: { n: 1, k: 'u32' }, address: { n: 2, k: 'string' } };
const SuiObject: Schema = { objectId: { n: 2, k: 'string' }, version: { n: 3, k: 'u64' }, digest: { n: 4, k: 'string' }, owner: { n: 5, k: Owner }, objectType: { n: 6, k: 'string' }, balance: { n: 101, k: 'u64' } };
const Transaction: Schema = { bcs: { n: 1, k: Bcs }, sender: { n: 5, k: 'string' } };
const UserSignature: Schema = { bcs: { n: 1, k: Bcs } };
const ExecutionError: Schema = { description: { n: 1, k: 'string' }, command: { n: 2, k: 'u64' }, kind: { n: 3, k: 'u32' } };
const ExecutionStatus: Schema = { success: { n: 1, k: 'bool' }, error: { n: 2, k: ExecutionError } };
const GasCostSummary: Schema = { computationCost: { n: 1, k: 'u64' }, storageCost: { n: 2, k: 'u64' }, storageRebate: { n: 3, k: 'u64' }, nonRefundableStorageFee: { n: 4, k: 'u64' } };
const Effects: Schema = { status: { n: 4, k: ExecutionStatus }, epoch: { n: 5, k: 'u64' }, gasUsed: { n: 6, k: GasCostSummary } };
const BalanceChange: Schema = { address: { n: 1, k: 'string' }, coinType: { n: 2, k: 'string' }, amount: { n: 3, k: 'string' } };
const ExecutedTransaction: Schema = { digest: { n: 1, k: 'string' }, transaction: { n: 2, k: Transaction }, effects: { n: 4, k: Effects }, checkpoint: { n: 6, k: 'u64' }, timestamp: { n: 7, k: Timestamp }, balanceChanges: { n: 8, k: BalanceChange, rep: true } };
const Epoch: Schema = { epoch: { n: 1, k: 'u64' }, firstCheckpoint: { n: 4, k: 'u64' }, lastCheckpoint: { n: 5, k: 'u64' }, start: { n: 6, k: Timestamp }, end: { n: 7, k: Timestamp }, referenceGasPrice: { n: 8, k: 'u64' } };
const Balance: Schema = { coinType: { n: 1, k: 'string' }, balance: { n: 3, k: 'u64' }, addressBalance: { n: 4, k: 'u64' }, coinBalance: { n: 5, k: 'u64' } };
const AddressFilter: Schema = { address: { n: 1, k: 'string' } };
const TxLiteral: Schema = { negated: { n: 1, k: 'bool' }, affectedAddress: { n: 3, k: AddressFilter } };
const TxFilter: Schema = { terms: { n: 1, k: { literals: { n: 1, k: TxLiteral, rep: true } }, rep: true } };
const QueryOptions: Schema = { limit: { n: 1, k: 'u32' }, ordering: { n: 4, k: 'u32' } };

export const M = {
  GetServiceInfoRequest: {} as Schema,
  GetServiceInfoResponse: { chainId: { n: 1, k: 'string' }, chain: { n: 2, k: 'string' }, epoch: { n: 3, k: 'u64' }, checkpointHeight: { n: 4, k: 'u64' }, timestamp: { n: 5, k: Timestamp }, lowestAvailableCheckpoint: { n: 6, k: 'u64' } } as Schema,
  GetEpochRequest: { epoch: { n: 1, k: 'u64' }, readMask: { n: 2, k: FieldMask } } as Schema,
  GetEpochResponse: { epoch: { n: 1, k: Epoch } } as Schema,
  GetBalanceRequest: { owner: { n: 1, k: 'string' }, coinType: { n: 2, k: 'string' } } as Schema,
  GetBalanceResponse: { balance: { n: 1, k: Balance } } as Schema,
  ListOwnedObjectsRequest: { owner: { n: 1, k: 'string' }, pageSize: { n: 2, k: 'u32' }, pageToken: { n: 3, k: 'bytes' }, readMask: { n: 4, k: FieldMask }, objectType: { n: 5, k: 'string' } } as Schema,
  ListOwnedObjectsResponse: { objects: { n: 1, k: SuiObject, rep: true }, nextPageToken: { n: 2, k: 'bytes' } } as Schema,
  GetObjectRequest: { objectId: { n: 1, k: 'string' }, readMask: { n: 3, k: FieldMask } } as Schema,
  GetObjectResponse: { object: { n: 1, k: SuiObject } } as Schema,
  GetTransactionRequest: { digest: { n: 1, k: 'string' }, readMask: { n: 2, k: FieldMask } } as Schema,
  GetTransactionResponse: { transaction: { n: 1, k: ExecutedTransaction } } as Schema,
  SimulateTransactionRequest: { transaction: { n: 1, k: Transaction }, readMask: { n: 2, k: FieldMask }, checks: { n: 3, k: 'u32' }, doGasSelection: { n: 4, k: 'bool' } } as Schema,
  SimulateTransactionResponse: { transaction: { n: 1, k: ExecutedTransaction } } as Schema,
  ExecuteTransactionRequest: { transaction: { n: 1, k: Transaction }, signatures: { n: 2, k: UserSignature, rep: true }, readMask: { n: 3, k: FieldMask } } as Schema,
  ExecuteTransactionResponse: { transaction: { n: 1, k: ExecutedTransaction } } as Schema,
  ListTransactionsRequest: { readMask: { n: 1, k: FieldMask }, startCheckpoint: { n: 2, k: 'u64' }, endCheckpoint: { n: 3, k: 'u64' }, filter: { n: 4, k: TxFilter }, options: { n: 5, k: QueryOptions } } as Schema,
  ListTransactionsResponse: { transaction: { n: 1, k: ExecutedTransaction }, watermark: { n: 2, k: { cursor: { n: 1, k: 'bytes' }, checkpoint: { n: 2, k: 'u64' } } }, end: { n: 3, k: { reason: { n: 1, k: 'u32' } } } } as Schema,
};

export interface TimestampMsg { seconds?: bigint; nanos?: number }
export interface ServiceInfo { chainId?: string; chain?: string; epoch?: bigint; checkpointHeight?: bigint; timestamp?: TimestampMsg; lowestAvailableCheckpoint?: bigint }
export interface EpochMsg { epoch?: bigint; firstCheckpoint?: bigint; lastCheckpoint?: bigint; start?: TimestampMsg; end?: TimestampMsg; referenceGasPrice?: bigint }
export interface BalanceMsg { coinType?: string; balance?: bigint; addressBalance?: bigint; coinBalance?: bigint }
export interface ObjectMsg { objectId?: string; version?: bigint; digest?: string; owner?: { kind?: number; address?: string }; objectType?: string; balance?: bigint }
export interface GasMsg { computationCost?: bigint; storageCost?: bigint; storageRebate?: bigint; nonRefundableStorageFee?: bigint }
export interface ExecutedTx {
  digest?: string; transaction?: { sender?: string }; checkpoint?: bigint; timestamp?: TimestampMsg;
  effects?: { status?: { success?: boolean; error?: { description?: string; command?: bigint; kind?: number } }; epoch?: bigint; gasUsed?: GasMsg };
  balanceChanges: { address?: string; coinType?: string; amount?: string }[];
}
export interface ListedTx { transaction?: ExecutedTx; watermark?: { checkpoint?: bigint }; end?: { reason?: number } }

// ---------------------------------------------------------------- transport
export const GRPC_NOT_FOUND = 5, GRPC_OUT_OF_RANGE = 11;
export class GrpcError extends Error {
  constructor(public grpcCode: number, message: string) { super(message); }
}
/** One gRPC call: request message bytes in, response message bytes out (one per message of the stream). Throws GrpcError on a gRPC status. */
export type GrpcCall = (base: string, method: string, request: Uint8Array, timeoutMs?: number) => Promise<Uint8Array[]>;

const MAX_RESPONSE = 8 * 1024 * 1024;
function once(base: string, method: string, request: Uint8Array, timeoutMs: number): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    if (u.protocol !== 'https:') { reject(new Error('grpc: https only')); return; }
    const session = http2.connect(u.origin);
    let done = false;
    const finish = (err: Error | null, frames?: Uint8Array[]) => {
      if (done) return;
      done = true; clearTimeout(timer);
      try { session.destroy(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(frames!);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('grpc: timeout'), { transport: true })), timeoutMs);
    session.on('error', (e) => finish(Object.assign(new Error(`grpc: ${e.message}`), { transport: true })));
    const frame = new Uint8Array(5 + request.length);
    new DataView(frame.buffer).setUint32(1, request.length); // byte 0 = 0: not compressed
    frame.set(request, 5);
    const req = session.request({ ':method': 'POST', ':path': method, 'content-type': 'application/grpc', te: 'trailers' });
    const chunks: Buffer[] = [];
    let size = 0, httpStatus = 0, status: string | undefined, message = '';
    const meta = (h: http2.IncomingHttpHeaders) => { if (h['grpc-status'] !== undefined) { status = String(h['grpc-status']); message = String(h['grpc-message'] ?? ''); } };
    req.on('response', (h) => { httpStatus = Number(h[':status']); meta(h); });
    req.on('trailers', meta);
    req.on('data', (d: Buffer) => { size += d.length; if (size > MAX_RESPONSE) finish(new Error('grpc: response too large')); else chunks.push(d); });
    req.on('error', (e) => finish(Object.assign(new Error(`grpc: ${e.message}`), { transport: true })));
    req.on('end', () => {
      if (httpStatus !== 200) return finish(new Error(`grpc: http ${httpStatus}`));
      if (status === undefined) return finish(new Error('grpc: no status'));
      if (status !== '0') { let m = message; try { m = decodeURIComponent(message); } catch { /* keep raw */ } return finish(new GrpcError(Number(status), m.slice(0, 300))); }
      const all = Buffer.concat(chunks), frames: Uint8Array[] = [];
      let o = 0;
      while (o < all.length) {
        if (o + 5 > all.length || all[o] !== 0) return finish(new Error('grpc: bad frame'));
        const len = all.readUInt32BE(o + 1);
        if (o + 5 + len > all.length) return finish(new Error('grpc: truncated frame'));
        frames.push(new Uint8Array(all.subarray(o + 5, o + 5 + len)));
        o += 5 + len;
      }
      finish(null, frames);
    });
    req.end(frame);
  });
}
/** gRPC over HTTP/2 with one retry on connection-level failures (never on an answer). Reads are safe to repeat; re-sending signed bytes is idempotent on-chain. */
export const grpcCall: GrpcCall = async (base, method, request, timeoutMs = 9000) => {
  try { return await once(base, method, request, timeoutMs); }
  catch (e) {
    if (!(e as { transport?: boolean }).transport) throw e;
    await new Promise((r) => setTimeout(r, 300));
    return once(base, method, request, timeoutMs);
  }
};
