/**
 * t3 -- adversarial baked objects (the trust-nothing tier). LIVE (B2).
 *
 * Every lying `baked` object is refused at Reader construction with a stable R_*
 * code; every out-of-range get()/row() index is R_ROW_OUT_OF_RANGE; and the
 * write-back round-trip through Reader.fromBytes reads exactly through a pooled /
 * offset view (BK-05 recipe half). Structured like t5: pure exported pieces plus
 * run() composing them, so t9's Controls 13-15 can drive the knobs.
 *
 * The exported pieces return a divergence STRING (or null) instead of calling
 * die() directly. That is what lets t9 drive them in-process: a die() exits the
 * process and could never be observed by a control. run() wraps each return in
 * harness check()/die (message thunks name the tier.case + got-vs-expected for
 * replay). e.code is read as a plain property, so this module still LOADS against
 * a pre-B2 src (LiteBakeError is never imported).
 *
 * These lanes IGNORE BAKE_TORTURE_BREAK: their failability is proven in-process
 * by t9 (Controls 13-15), not by the BREAK path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bake, Reader, Types } from '../../Bake.js';
import { SEED, check } from './harness.mjs';

// F64 b@0, U8 a@8, stride 16, count 2, 32-byte buffer. Spread + corrupt one
// thing per matrix case; baseFixture() itself is never mutated.
function baseFixture() {
  return bake([{ a: 1, b: 2.5 }, { a: 3, b: 4.5 }], { schema: { b: Types.F64 } });
}

/**
 * Run `thunk`, expect a LiteBakeError-shaped throw whose `code` === expectedCode.
 * Returns null on the expected outcome, or a got-vs-expected divergence string.
 * opts.breakMatrix === true SKIPS the code-equality comparison (accepts any
 * throw) -- the default-off misapply knob t9 Control 13 drives.
 */
export function checkRefusal(thunk, expectedCode, opts = {}) {
  let e = null;
  try { thunk(); } catch (err) { e = err; }
  if (e === null) return 'expected throw ' + expectedCode + ' but none thrown';
  if (typeof e.code !== 'string') return 'throw for ' + expectedCode + ' carried no string code';
  if (opts.breakMatrix === true) return null;   // knob: any throw accepted
  if (e.code !== expectedCode) return 'expected ' + expectedCode + ' got ' + e.code;
  return null;
}

/**
 * Drive get()/row() over out-of-range indices (each must throw
 * R_ROW_OUT_OF_RANGE) plus in-range twins (must not throw). Returns null when
 * the bounds policy holds, or a divergence string. opts.breakBounds === true
 * treats a silent return (no throw) on an out-of-range call as acceptable -- the
 * default-off knob t9 Control 14 drives. The reader's first field must be 'a'.
 */
export function checkBounds(reader, opts = {}) {
  const count = reader.count;
  const oob = [
    () => reader.get(-1, 'a'),
    () => reader.get(0.5, 'a'),
    () => reader.get(count, 'a'),
    () => reader.get(2 ** 53, 'a'),
    () => reader.row(-1),
    () => reader.row(count),
  ];
  for (let k = 0; k < oob.length; k++) {
    let e = null;
    try { oob[k](); } catch (err) { e = err; }
    if (e === null) {
      if (opts.breakBounds === true) continue;   // knob: silent return accepted
      return 'out-of-range call ' + k + ' did not throw R_ROW_OUT_OF_RANGE';
    }
    if (e.code !== 'R_ROW_OUT_OF_RANGE') {
      return 'out-of-range call ' + k + ' threw ' + e.code + ' not R_ROW_OUT_OF_RANGE';
    }
  }
  // In-range twins must not throw (non-vacuity).
  let inRangeErr = null;
  try { reader.get(0, 'a'); reader.row(0); } catch (err) { inRangeErr = err; }
  if (inRangeErr !== null) return 'an in-range call threw ' + (inRangeErr.code || inRangeErr.name);
  return null;
}

/**
 * The BK-05 simulated-pool body INVERTED: write baked bytes to disk, read them
 * back, place the bytes at a nonzero byteOffset inside a junked backing buffer,
 * and reconstruct through `factory`. Returns null when every cell reads exactly
 * AND the reconstructed buffer is exactly the dataset size (the honest recipe),
 * or a divergence string. factory defaults to Reader.fromBytes; a factory that
 * ignores byteOffset (reads .buffer raw) reads the junk head and is caught.
 *
 * The fromBytes-honesty knob is FACTORY INJECTION, not a boolean: t9 Control 15
 * passes a raw-.buffer factory to prove the gate catches a BK-05 regression. This
 * is a deliberate deviation from the chartered breakRawBuffer boolean -- injecting
 * the whole reconstruction path exercises more of the honesty contract than a flag.
 */
export function checkRoundTrip(factory = (bytes, meta) => Reader.fromBytes(bytes, meta)) {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lbake-t3-'));
  try {
    const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
    const file = path.join(TMP, 'baked.bin');
    fs.writeFileSync(file, new Uint8Array(baked.buffer));
    const raw = fs.readFileSync(file);
    const len = raw.byteLength;
    const OFFSET = 128;
    const backing = new ArrayBuffer(OFFSET + len + 64);
    new Uint8Array(backing, 0, OFFSET).fill(0xAA);          // junk the pool head
    new Uint8Array(backing, OFFSET, len).set(raw);          // data at nonzero offset
    const view = new Uint8Array(backing, OFFSET, len);
    const meta = { stride: baked.stride, count: baked.count, schema: baked.schema };
    let r2 = null, e = null;
    try { r2 = factory(view, meta); } catch (err) { e = err; }
    if (e !== null) return 'factory threw ' + (e.code || e.name) + ': ' + e.message;
    const x = r2.get(0, 'x');
    if (x !== 1234.5) return 'x read back ' + x + ' not 1234.5 (pool-head misread)';
    if (r2.get(0, 'y') !== 42) return 'y read back ' + r2.get(0, 'y') + ' not 42';
    if (r2.buffer.byteLength !== view.byteLength) {
      return 'r2.buffer.byteLength ' + r2.buffer.byteLength + ' != view.byteLength ' + view.byteLength +
        ' (the junk head is reachable)';
    }
    return null;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

/**
 * The copy path severs the source: fromBytes an offset view of a 1 MB backing,
 * hold only the Reader, drop the backing + view, and prove the backing collects.
 */
async function sourceSevered() {
  if (typeof globalThis.gc !== 'function') return;   // torture runs with --expose-gc
  const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
  const len = baked.buffer.byteLength;
  const OFFSET = 128;
  let backing = new ArrayBuffer(1 << 20);            // 1 MB
  new Uint8Array(backing, OFFSET, len).set(new Uint8Array(baked.buffer));
  let view = new Uint8Array(backing, OFFSET, len);
  const meta = { stride: baked.stride, count: baked.count, schema: baked.schema };
  const r = Reader.fromBytes(view, meta);            // copy path (offset view)
  check(r.get(0, 'x') === 1234.5, () => 't3.severed: copy misread x (seed=' + SEED + ')');
  const wr = new WeakRef(backing);
  backing = null; view = null;                       // drop the only strong refs
  // A WeakRef keeps its target live for the whole current Job, so gc() must run
  // AFTER an await crosses a Job boundary or it cannot collect (see t7).
  await new Promise((res) => setTimeout(res, 50));
  globalThis.gc();
  await new Promise((res) => setTimeout(res, 20));
  globalThis.gc();
  check(wr.deref() === undefined,
    () => 't3.severed: the 1 MB backing was retained by the Reader -- the copy did not sever the source (seed=' + SEED + ')');
}

// The full constructor matrix from ReaderDoors.test.js, one corruption per case.
function runMatrix(opts = {}) {
  const b = baseFixture();
  const expect = (thunk, code, name) => {
    const d = checkRefusal(thunk, code, opts);
    check(d === null, () => 't3.matrix [' + name + ']: ' + d + ' (seed=' + SEED + ')');
  };

  // (1) baked shape
  expect(() => new Reader(null), 'R_INPUT', 'baked null');
  expect(() => new Reader(42), 'R_INPUT', 'baked 42');
  // (2) buffer
  expect(() => new Reader({ ...b, buffer: new Uint8Array(b.buffer) }), 'R_INPUT', 'buffer view');
  expect(() => new Reader({ ...b, buffer: 'bytes' }), 'R_INPUT', 'buffer string');
  // (3) stride
  expect(() => new Reader({ ...b, stride: 0 }), 'R_BAD_STRIDE', 'stride 0');
  expect(() => new Reader({ ...b, stride: -16 }), 'R_BAD_STRIDE', 'stride -16');
  expect(() => new Reader({ ...b, stride: 2.5 }), 'R_BAD_STRIDE', 'stride 2.5');
  expect(() => new Reader({ ...b, stride: '16' }), 'R_BAD_STRIDE', 'stride "16"');
  // (4) count
  expect(() => new Reader({ ...b, count: -1 }), 'R_BAD_COUNT', 'count -1');
  expect(() => new Reader({ ...b, count: 1.5 }), 'R_BAD_COUNT', 'count 1.5');
  expect(() => new Reader({ ...b, count: NaN }), 'R_BAD_COUNT', 'count NaN');
  // (5) byteLength
  expect(() => new Reader({ buffer: new ArrayBuffer(12), stride: 4, count: 1, schema: [{ name: 'x', type: Types.F32, offset: 0 }] }),
    'R_BAD_LENGTH', 'byteLength 12');
  // (6) truncation (division form)
  expect(() => new Reader({ ...b, count: 100 }), 'R_TRUNCATED', 'count 100');
  expect(() => new Reader({ ...b, count: 2 ** 53 }), 'R_TRUNCATED', 'count 2**53');
  // (7) schema
  expect(() => new Reader({ ...b, schema: null }), 'R_BAD_SCHEMA', 'schema null');
  expect(() => new Reader({ ...b, schema: {} }), 'R_BAD_SCHEMA', 'schema {}');
  expect(() => new Reader({ ...b, schema: [] }), 'R_BAD_SCHEMA', 'schema []');
  expect(() => new Reader({ ...b, schema: [null] }), 'R_BAD_SCHEMA', 'schema [null]');
  expect(() => new Reader({ ...b, schema: [{ name: 7, type: Types.F64, offset: 0 }] }), 'R_BAD_SCHEMA', 'name 7');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.U8, offset: 0 }, { name: 'x', type: Types.U8, offset: 1 }] }),
    'R_BAD_SCHEMA', 'duplicate names');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: 8, offset: 0 }] }), 'R_BAD_SCHEMA', 'type 8');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: 1.5, offset: 0 }] }), 'R_BAD_SCHEMA', 'type 1.5');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: 'F64', offset: 0 }] }), 'R_BAD_SCHEMA', 'type "F64"');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.U8, offset: -8 }] }), 'R_BAD_SCHEMA', 'offset -8');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.F64, offset: 3 }] }), 'R_BAD_SCHEMA', 'offset 3 misaligned');
  expect(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.F64, offset: b.stride - 1 }] }), 'R_BAD_SCHEMA', 'offset exceeds stride');
  expect(() => new Reader({ buffer: new ArrayBuffer(8), stride: 4, count: 1, schema: [{ name: 'x', type: Types.F32, offset: 0 }, { name: 'y', type: Types.U16, offset: 2 }] }),
    'R_BAD_SCHEMA', 'overlap F32@0+U16@2');
  // (8) stride not a multiple of max field alignment
  expect(() => new Reader({ buffer: new ArrayBuffer(24), stride: 12, count: 1, schema: [{ name: 'x', type: Types.F64, offset: 0 }] }),
    'R_BAD_STRIDE', 'stride 12 not 8-aligned');

  // Happy twins.
  const r = new Reader(baseFixture());
  check(r.get(0, 'b') === 2.5 && r.get(0, 'a') === 1 && r.get(1, 'b') === 4.5 && r.get(1, 'a') === 3,
    () => 't3.matrix: valid fixture misread (seed=' + SEED + ')');
  const fb = baseFixture();
  for (const f of fb.schema) Object.freeze(f);
  Object.freeze(fb.schema);
  Object.freeze(fb);
  const rf = new Reader(fb);
  check(rf.get(0, 'b') === 2.5 && rf.get(1, 'a') === 3,
    () => 't3.matrix: frozen fixture misread (seed=' + SEED + ')');

  // Post-mutation immunity (snapshots).
  const mb = baseFixture();
  const rm = new Reader(mb);
  mb.schema[0].offset = 9999;
  mb.schema[1].type = 0;
  check(rm.offsetBytes('b') === 0 && rm.get(0, 'b') === 2.5 && rm.get(0, 'a') === 1,
    () => 't3.matrix: schema snapshot not immune to post-construction mutation (seed=' + SEED + ')');
}

function runBounds(opts = {}) {
  const r = new Reader(bake([{ a: 10 }, { a: 20 }]));   // U8, count 2
  const d = checkBounds(r, opts);
  check(d === null, () => 't3.bounds: ' + d + ' (seed=' + SEED + ')');
  check(r.get(0, 'a') === 10, () => 't3.bounds: get(0) != 10 (seed=' + SEED + ')');
  check(r.get(1, 'a') === 20, () => 't3.bounds: get(1) != 20 (seed=' + SEED + ')');
}

export async function run() {
  runMatrix();
  runBounds();
  const rt = checkRoundTrip();
  check(rt === null, () => 't3.roundtrip: ' + rt + ' (seed=' + SEED + ')');
  await sourceSevered();
}
