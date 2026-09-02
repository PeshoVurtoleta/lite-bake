/**
 * lite-bake -- Reader coherence-door tests (B2, v1.1.1).
 *
 * The Reader trusts nothing. One banner section per door group; every assertion
 * pins an exact LiteBakeError.code (the stable R_* contract), plus non-vacuous
 * happy twins. The base fixture is a valid two-record baked object (F64 b@0,
 * U8 a@8, stride 16, count 2, 32-byte buffer); each constructor case spreads it
 * and corrupts exactly ONE thing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bake, Reader, Types, LiteBakeError } from '../Bake.js';

const isCode = (code) => (e) => e.code === code;

// F64 b@0, U8 a@8, stride 16, count 2, buffer 32.
function baseFixture() {
  return bake([{ a: 1, b: 2.5 }, { a: 3, b: 4.5 }], { schema: { b: Types.F64 } });
}

// ============================================================================
// Constructor matrix -- one corruption per case, first-offender door order
// ============================================================================

describe('Reader constructor: baked shape (R_INPUT)', () => {
  test('null baked throws R_INPUT', () => {
    assert.throws(() => new Reader(null), isCode('R_INPUT'));
  });
  test('a primitive baked throws R_INPUT', () => {
    assert.throws(() => new Reader(42), isCode('R_INPUT'));
  });
  test('a typed-array view as .buffer throws R_INPUT naming fromBytes', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, buffer: new Uint8Array(b.buffer) }),
      (e) => e.code === 'R_INPUT' && /fromBytes/.test(e.message));
  });
  test('a string as .buffer throws R_INPUT', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, buffer: 'bytes' }), isCode('R_INPUT'));
  });
});

describe('Reader constructor: stride (R_BAD_STRIDE)', () => {
  test('stride 0 / -16 / 2.5 / "16" all throw R_BAD_STRIDE', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, stride: 0 }),   isCode('R_BAD_STRIDE'));
    assert.throws(() => new Reader({ ...b, stride: -16 }), isCode('R_BAD_STRIDE'));
    assert.throws(() => new Reader({ ...b, stride: 2.5 }), isCode('R_BAD_STRIDE'));
    assert.throws(() => new Reader({ ...b, stride: '16' }), isCode('R_BAD_STRIDE'));
  });
  test('stride not a multiple of max field alignment throws R_BAD_STRIDE', () => {
    // Doors 1-7 pass; 12 % 8 !== 0 (an F64 field needs an 8-aligned stride).
    assert.throws(() => new Reader({
      buffer: new ArrayBuffer(24), stride: 12, count: 1,
      schema: [{ name: 'x', type: Types.F64, offset: 0 }],
    }), isCode('R_BAD_STRIDE'));
  });
});

describe('Reader constructor: count (R_BAD_COUNT)', () => {
  test('count -1 / 1.5 / NaN all throw R_BAD_COUNT', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, count: -1 }),  isCode('R_BAD_COUNT'));
    assert.throws(() => new Reader({ ...b, count: 1.5 }), isCode('R_BAD_COUNT'));
    assert.throws(() => new Reader({ ...b, count: NaN }), isCode('R_BAD_COUNT'));
  });
});

describe('Reader constructor: byteLength (R_BAD_LENGTH)', () => {
  test('a buffer byteLength not a multiple of 8 throws R_BAD_LENGTH', () => {
    // Replaces the old raw Float64Array RangeError.
    assert.throws(() => new Reader({
      buffer: new ArrayBuffer(12), stride: 4, count: 1,
      schema: [{ name: 'x', type: Types.F32, offset: 0 }],
    }), isCode('R_BAD_LENGTH'));
  });
});

describe('Reader constructor: truncation (R_TRUNCATED)', () => {
  test('count 100 over a 2-row buffer throws R_TRUNCATED', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, count: 100 }), isCode('R_TRUNCATED'));
  });
  test('count 2**53 throws R_TRUNCATED (division form, not count*stride)', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, count: 2 ** 53 }), isCode('R_TRUNCATED'));
  });
});

describe('Reader constructor: schema (R_BAD_SCHEMA)', () => {
  test('schema null / {} / [] all throw R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: null }), isCode('R_BAD_SCHEMA'));
    assert.throws(() => new Reader({ ...b, schema: {} }),   isCode('R_BAD_SCHEMA'));
    assert.throws(() => new Reader({ ...b, schema: [] }),   isCode('R_BAD_SCHEMA'));
  });
  test('a null schema entry throws R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: [null] }), isCode('R_BAD_SCHEMA'));
  });
  test('a non-string field name throws R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: [{ name: 7, type: Types.F64, offset: 0 }] }),
      isCode('R_BAD_SCHEMA'));
  });
  test('duplicate field names throw R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b,
      schema: [{ name: 'x', type: Types.U8, offset: 0 }, { name: 'x', type: Types.U8, offset: 1 }],
    }), isCode('R_BAD_SCHEMA'));
  });
  test('type 8 / 1.5 / "F64" all throw R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: [{ name: 'x', type: 8, offset: 0 }] }),
      isCode('R_BAD_SCHEMA'));
    assert.throws(() => new Reader({ ...b, schema: [{ name: 'x', type: 1.5, offset: 0 }] }),
      isCode('R_BAD_SCHEMA'));
    assert.throws(() => new Reader({ ...b, schema: [{ name: 'x', type: 'F64', offset: 0 }] }),
      isCode('R_BAD_SCHEMA'));
  });
  test('offset -8 throws R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.U8, offset: -8 }] }),
      isCode('R_BAD_SCHEMA'));
  });
  test('a misaligned F64 offset (3) throws R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.F64, offset: 3 }] }),
      isCode('R_BAD_SCHEMA'));
  });
  test('an F64 field at offset stride-1 (exceeds stride) throws R_BAD_SCHEMA', () => {
    const b = baseFixture();
    assert.throws(() => new Reader({ ...b, schema: [{ name: 'x', type: Types.F64, offset: b.stride - 1 }] }),
      isCode('R_BAD_SCHEMA'));
  });
  test('overlapping fields (F32@0 + U16@2) throw R_BAD_SCHEMA', () => {
    assert.throws(() => new Reader({
      buffer: new ArrayBuffer(8), stride: 4, count: 1,
      schema: [{ name: 'x', type: Types.F32, offset: 0 }, { name: 'y', type: Types.U16, offset: 2 }],
    }), isCode('R_BAD_SCHEMA'));
  });
});

// ============================================================================
// Happy twins -- the valid fixture (and a frozen copy) constructs and reads
// ============================================================================

describe('Reader constructor: happy path', () => {
  test('the valid fixture constructs and reads exactly', () => {
    const r = new Reader(baseFixture());
    assert.equal(r.count, 2);
    assert.equal(r.stride, 16);
    assert.equal(r.get(0, 'b'), 2.5);
    assert.equal(r.get(0, 'a'), 1);
    assert.equal(r.get(1, 'b'), 4.5);
    assert.equal(r.get(1, 'a'), 3);
  });

  test('a frozen baked object (and frozen schema + entries) still constructs and reads', () => {
    const b = baseFixture();
    for (const f of b.schema) Object.freeze(f);
    Object.freeze(b.schema);
    Object.freeze(b);
    const r = new Reader(b);
    assert.equal(r.get(0, 'b'), 2.5);
    assert.equal(r.get(1, 'a'), 3);
  });
});

// ============================================================================
// Post-mutation immunity -- snapshots make the Reader immune to later mutation
// ============================================================================

describe('Reader constructor: schema snapshot immunity', () => {
  test('mutating baked.schema after construction does not move a field', () => {
    const b = baseFixture();
    const r = new Reader(b);
    b.schema[0].offset = 9999; // b: F64@0
    b.schema[1].type = 0;      // a: U8 -> F32 (would corrupt reads if trusted)
    assert.equal(r.offsetBytes('b'), 0);
    assert.equal(r.get(0, 'b'), 2.5);
    assert.equal(r.get(0, 'a'), 1);
  });
});

// ============================================================================
// Row bounds (R_ROW_OUT_OF_RANGE) -- one policy on get()/row()
// ============================================================================

describe('Reader.get/row bounds', () => {
  test('get(-1)/get(0.5)/get(2)/get(2**53) throw R_ROW_OUT_OF_RANGE', () => {
    const r = new Reader(baseFixture());
    assert.throws(() => r.get(-1, 'a'),      isCode('R_ROW_OUT_OF_RANGE'));
    assert.throws(() => r.get(0.5, 'a'),     isCode('R_ROW_OUT_OF_RANGE'));
    assert.throws(() => r.get(2, 'a'),       isCode('R_ROW_OUT_OF_RANGE'));
    assert.throws(() => r.get(2 ** 53, 'a'), isCode('R_ROW_OUT_OF_RANGE'));
  });
  test('row(-1)/row(2) throw R_ROW_OUT_OF_RANGE', () => {
    const r = new Reader(baseFixture());
    assert.throws(() => r.row(-1), isCode('R_ROW_OUT_OF_RANGE'));
    assert.throws(() => r.row(2),  isCode('R_ROW_OUT_OF_RANGE'));
  });
  test('bounds are checked before the field lookup: get(-1, "ghost") is R_ROW_OUT_OF_RANGE', () => {
    const r = new Reader(baseFixture());
    assert.throws(() => r.get(-1, 'ghost'), isCode('R_ROW_OUT_OF_RANGE'));
  });
  test('get(0)/get(1)/row(1) read exact values', () => {
    const r = new Reader(baseFixture());
    assert.equal(r.get(0, 'b'), 2.5);
    assert.equal(r.get(1, 'a'), 3);
    assert.deepEqual(r.row(1), { b: 4.5, a: 3 });
  });
});

// ============================================================================
// Reader.fromBytes -- honors byteOffset, copies only when it must
// ============================================================================

describe('Reader.fromBytes', () => {
  test('(a) a real readFileSync Buffer reads every cell exactly', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lbake-rd-'));
    try {
      const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
      const junk = path.join(TMP, 'junk.bin');
      const file = path.join(TMP, 'baked.bin');
      fs.writeFileSync(junk, Uint8Array.from({ length: 16 }, () => 0xAA));
      fs.writeFileSync(file, new Uint8Array(baked.buffer));
      fs.readFileSync(junk);                 // occupy the pool head
      const buf = fs.readFileSync(file);     // may be a pooled view (byteOffset > 0)
      if (buf.byteOffset > 0) assert.ok(buf.byteOffset > 0);
      const r = Reader.fromBytes(buf, { stride: baked.stride, count: baked.count, schema: baked.schema });
      assert.equal(r.get(0, 'x'), 1234.5);
      assert.equal(r.get(0, 'y'), 42);
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  });

  test('(b) an offset view is copied: reads exactly, buffer is severed and dataset-sized', () => {
    const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
    const len = baked.buffer.byteLength;
    const OFFSET = 128;
    const backing = new ArrayBuffer(OFFSET + len + 64);
    new Uint8Array(backing, 0, OFFSET).fill(0xAA);
    new Uint8Array(backing, OFFSET, len).set(new Uint8Array(baked.buffer));
    const view = new Uint8Array(backing, OFFSET, len);
    const r = Reader.fromBytes(view, { stride: baked.stride, count: baked.count, schema: baked.schema });
    assert.equal(r.get(0, 'x'), 1234.5);
    assert.equal(r.get(0, 'y'), 42);
    assert.notEqual(r.buffer, backing);
    assert.equal(r.buffer.byteLength, view.byteLength);
  });

  test('(c) a full-span view and a raw ArrayBuffer are zero-copy', () => {
    const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
    const meta = { stride: baked.stride, count: baked.count, schema: baked.schema };
    const u8 = new Uint8Array(baked.buffer);
    assert.equal(Reader.fromBytes(u8, meta).buffer, baked.buffer);
    assert.equal(Reader.fromBytes(baked.buffer, meta).buffer, baked.buffer);
  });

  test('(d) DataView/Float32Array/string/null bytes and null/42 meta throw R_INPUT', () => {
    const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
    const meta = { stride: baked.stride, count: baked.count, schema: baked.schema };
    assert.throws(() => Reader.fromBytes(new DataView(baked.buffer), meta),      isCode('R_INPUT'));
    assert.throws(() => Reader.fromBytes(new Float32Array(baked.buffer), meta),  isCode('R_INPUT'));
    assert.throws(() => Reader.fromBytes('bytes', meta),                         isCode('R_INPUT'));
    assert.throws(() => Reader.fromBytes(null, meta),                            isCode('R_INPUT'));
    assert.throws(() => Reader.fromBytes(new Uint8Array(baked.buffer), null),    isCode('R_INPUT'));
    assert.throws(() => Reader.fromBytes(new Uint8Array(baked.buffer), 42),      isCode('R_INPUT'));
  });

  test('(d) a view whose byteLength % 8 !== 0 fails closed with R_BAD_LENGTH', () => {
    const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
    const meta = { stride: baked.stride, count: baked.count, schema: baked.schema };
    const truncated = new Uint8Array(baked.buffer).subarray(0, 12); // not full span -> copied
    assert.throws(() => Reader.fromBytes(truncated, meta), isCode('R_BAD_LENGTH'));
  });
});

// ============================================================================
// No-raw-RangeError sweep -- every refusal is a LiteBakeError with an R_ code
// ============================================================================

describe('Reader doors never leak a raw RangeError', () => {
  test('every refusal is a LiteBakeError whose code starts with R_', () => {
    const b = baseFixture();
    const meta = { stride: b.stride, count: b.count, schema: b.schema };
    const thunks = [
      () => new Reader(null),
      () => new Reader(42),
      () => new Reader({ ...b, buffer: new Uint8Array(b.buffer) }),
      () => new Reader({ ...b, buffer: 'bytes' }),
      () => new Reader({ ...b, stride: 0 }),
      () => new Reader({ ...b, count: -1 }),
      () => new Reader({ buffer: new ArrayBuffer(12), stride: 4, count: 1, schema: [{ name: 'x', type: Types.F32, offset: 0 }] }),
      () => new Reader({ ...b, count: 100 }),
      () => new Reader({ ...b, count: 2 ** 53 }),
      () => new Reader({ ...b, schema: [] }),
      () => new Reader({ buffer: new ArrayBuffer(24), stride: 12, count: 1, schema: [{ name: 'x', type: Types.F64, offset: 0 }] }),
      () => new Reader(b).get(2, 'a'),
      () => new Reader(b).row(-1),
      () => Reader.fromBytes(new DataView(b.buffer), meta),
      () => Reader.fromBytes(new Uint8Array(b.buffer), null),
    ];
    for (const thunk of thunks) {
      let e = null;
      try { thunk(); } catch (err) { e = err; }
      assert.ok(e instanceof LiteBakeError, 'expected a LiteBakeError');
      assert.ok(e.code.startsWith('R_'), 'expected an R_ code, got ' + e.code);
    }
  });
});
