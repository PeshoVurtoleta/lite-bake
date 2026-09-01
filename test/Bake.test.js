/**
 * lite-bake test suite — uses Node's built-in `node:test` runner.
 * Run with: `npm test` (requires Node >= 18).
 *
 * These tests prove three things:
 *   1. Correctness  — bake() then Reader reads back the input faithfully
 *   2. Safety       — edge inputs throw predictably, never silently corrupt
 *   3. Layout       — stride/alignment math matches the contract in README.md
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bake, Reader, Types } from '../src/index.js';

// ============================================================================
// GROUP 1 — Input validation
// ============================================================================

describe('bake() input validation', () => {
  test('throws on empty array', () => {
    assert.throws(() => bake([]), /non-empty/);
  });

  test('throws on non-array', () => {
    assert.throws(() => bake(null),      /expected non-empty array/);
    assert.throws(() => bake(undefined), /expected non-empty array/);
    assert.throws(() => bake({}),        /expected non-empty array/);
    assert.throws(() => bake('nope'),    /expected non-empty array/);
  });

  test('accepts a single record', () => {
    const b = bake([{ x: 1, y: 2 }]);
    assert.equal(b.count, 1);
  });

  test('accepts a single field', () => {
    const b = bake([{ v: 1 }, { v: 2 }, { v: 3 }]);
    assert.equal(b.count, 3);
  });
});

// ============================================================================
// GROUP 2 — Type inference (smallest-fitting int, float fallback)
// ============================================================================

describe('type inference', () => {
  const pickType = (records, key) => {
    const b = bake(records);
    return b.schema.find(f => f.name === key).type;
  };

  test('all small non-negative ints → U8', () => {
    assert.equal(pickType([{v:0},{v:255},{v:128}], 'v'), Types.U8);
  });

  test('U8 → U16 boundary at 256', () => {
    assert.equal(pickType([{v:0},{v:256}], 'v'), Types.U16);
  });

  test('U16 → U32 boundary at 65536', () => {
    assert.equal(pickType([{v:0},{v:65536}], 'v'), Types.U32);
  });

  test('negative in range → I8', () => {
    assert.equal(pickType([{v:-128},{v:127}], 'v'), Types.I8);
  });

  test('I8 → I16 boundary at -129', () => {
    assert.equal(pickType([{v:-129},{v:0}], 'v'), Types.I16);
  });

  test('I16 → I32 boundary at -32769', () => {
    assert.equal(pickType([{v:-32769},{v:0}], 'v'), Types.I32);
  });

  test('any fractional value → F32', () => {
    assert.equal(pickType([{v:1},{v:1.5}], 'v'), Types.F32);
  });

  test('non-numeric field → F32 (stored as 0)', () => {
    const b = bake([{s:'hi'},{s:'world'}]);
    const f = b.schema.find(f => f.name === 's');
    assert.equal(f.type, Types.F32);
    const r = new Reader(b);
    assert.equal(r.get(0, 's'), 0);
    assert.equal(r.get(1, 's'), 0);
  });

  test('NaN and Infinity ignored by inference, stored as 0 for ints', () => {
    // NaN / Infinity aren't finite, so inference skips them. If no finite
    // number was seen, field falls back to F32 (then non-finite → 0 via +v||0).
    const b = bake([{v: NaN}, {v: Infinity}]);
    const r = new Reader(b);
    assert.equal(r.get(0, 'v'), 0);
  });
});

// ============================================================================
// GROUP 3 — Round-trip correctness (bake → read back)
// ============================================================================

describe('round-trip correctness', () => {
  test('F32 values preserve within float precision', () => {
    const records = [
      { x: 1.5, y: -2.25, z: 0 },
      { x: 100.125, y: 0.5, z: -0.5 },
      { x: 3.14159, y: 2.71828, z: 1.41421 },
    ];
    const b = bake(records);
    const r = new Reader(b);
    for (let i = 0; i < records.length; i++) {
      assert.ok(Math.abs(r.get(i, 'x') - records[i].x) < 1e-5);
      assert.ok(Math.abs(r.get(i, 'y') - records[i].y) < 1e-5);
      assert.ok(Math.abs(r.get(i, 'z') - records[i].z) < 1e-5);
    }
  });

  test('all integer types round-trip exactly', () => {
    const records = [
      { u8: 255, u16: 65535, u32: 0xffffffff, i8: -128, i16: -32768, i32: -2147483648 },
      { u8: 0,   u16: 0,     u32: 0,          i8: 127,  i16: 32767,  i32: 2147483647 },
    ];
    const b = bake(records);
    const r = new Reader(b);
    for (let i = 0; i < records.length; i++) {
      for (const k of Object.keys(records[i])) {
        assert.equal(r.get(i, k), records[i][k], `${k}[${i}]`);
      }
    }
  });

  test('F64 round-trip (tests stride alignment!)', () => {
    // F64 (8) + U32 (4) → stride must pad to 8, not 4.
    const records = [
      { bigFloat: Math.PI,    tag: 1 },
      { bigFloat: Math.E,     tag: 2 },
      { bigFloat: 1e300,      tag: 3 },
      { bigFloat: -1.7e-308,  tag: 4 },
    ];
    const b = bake(records, { schema: { bigFloat: Types.F64 } });

    // Stride must be a multiple of 8 (max field alignment).
    assert.equal(b.stride % 8, 0, `stride ${b.stride} not multiple of 8`);

    const r = new Reader(b);
    for (let i = 0; i < records.length; i++) {
      assert.equal(r.get(i, 'bigFloat'), records[i].bigFloat);
      assert.equal(r.get(i, 'tag'),      records[i].tag);
    }
  });

  test('F64 offset via typed-array read matches DataView read', () => {
    // The critical test: f64[i * strideF64 + off] must hit the same bytes as
    // DataView.getFloat64(i * stride + offBytes). This is what would break
    // if stride weren't padded to 8.
    const records = [];
    for (let i = 0; i < 8; i++) records.push({ bigFloat: i * 0.125, tag: i });

    const b = bake(records, { schema: { bigFloat: Types.F64 } });
    const r = new Reader(b);
    const OFF = r.offsetF64('bigFloat');

    for (let i = 0; i < records.length; i++) {
      const viaTyped = r.f64[i * r.strideF64 + OFF];
      const viaDV    = r.dv.getFloat64(i * r.stride + r.offsetBytes('bigFloat'), true);
      assert.equal(viaTyped, viaDV, `record ${i}`);
      assert.equal(viaTyped, records[i].bigFloat);
    }
  });

  test('null/undefined values become 0', () => {
    const b = bake([{ v: null }, { v: undefined }, { v: 5 }]);
    const r = new Reader(b);
    assert.equal(r.get(0, 'v'), 0);
    assert.equal(r.get(1, 'v'), 0);
    assert.equal(r.get(2, 'v'), 5);
  });
});

// ============================================================================
// GROUP 4 — Layout & alignment
// ============================================================================

describe('layout and alignment', () => {
  test('fields sorted by descending size', () => {
    const b = bake([{ flag: 1, pos: 1.5, id: 1000000 }]);
    // Expected order by size: pos (F32=4), id (U32=4), flag (U8=1).
    // Ties by size preserve insertion order in stable sort.
    const sizes = b.schema.map(f => f.offset);
    for (let i = 1; i < sizes.length; i++) {
      assert.ok(sizes[i] > sizes[i-1], 'offsets strictly increase');
    }
  });

  test('each field offset is aligned to its own size', () => {
    const b = bake(
      [{ x: 1.5, y: 2.5, tag: 1 }],
      { schema: { x: Types.F64, y: Types.F32, tag: Types.U8 } }
    );
    for (const f of b.schema) {
      const size = [4, 8, 4, 2, 1, 4, 2, 1][f.type];
      assert.equal(f.offset % size, 0, `field ${f.name} offset ${f.offset} not aligned to ${size}`);
    }
  });

  test('stride is padded to max field alignment', () => {
    // F64 + U8 → natural end is 9, must pad to 16.
    const b = bake(
      [{ big: 1.5, tag: 1 }],
      { schema: { big: Types.F64, tag: Types.U8 } }
    );
    assert.equal(b.stride % 8, 0);
    assert.ok(b.stride >= 16);
  });

  test('buffer size holds stride * count (padded up to multiple of 8)', () => {
    const records = Array.from({ length: 17 }, (_, i) => ({ a: i, b: i * 2 }));
    const b = bake(records);
    const dataBytes = b.stride * b.count;
    assert.ok(b.buffer.byteLength >= dataBytes, 'buffer fits the data');
    assert.ok(b.buffer.byteLength - dataBytes < 8, 'padding < 8 bytes');
    assert.equal(b.buffer.byteLength % 8, 0, 'buffer is multiple of 8 for Float64Array view');
  });
});

// ============================================================================
// GROUP 5 — Schema overrides
// ============================================================================

describe('schema overrides', () => {
  test('forces type regardless of inferred value range', () => {
    const b = bake(
      [{ x: 1 }, { x: 2 }],                          // would infer U8
      { schema: { x: Types.F32 } }
    );
    assert.equal(b.schema[0].type, Types.F32);
  });

  test('partial override leaves other fields inferred', () => {
    const b = bake(
      [{ x: 1.5, y: 100 }],
      { schema: { x: Types.F64 } }
    );
    const byName = Object.fromEntries(b.schema.map(f => [f.name, f.type]));
    assert.equal(byName.x, Types.F64);
    assert.equal(byName.y, Types.U8);                // still inferred
  });
});

// ============================================================================
// GROUP 6 — Validate mode
// ============================================================================

describe('opts.validate', () => {
  test('off by default: heterogeneous records silently coerce', () => {
    // Without validate, extra keys are ignored, missing keys become 0.
    assert.doesNotThrow(() => bake([{ x: 1 }, { x: 2, extra: 99 }]));
  });

  test('throws when validate:true and record missing a field', () => {
    assert.throws(
      () => bake([{ x: 1, y: 2 }, { x: 3 }], { validate: true }),
      /missing field 'y'/
    );
  });

  test('throws when validate:true and record has unknown field', () => {
    assert.throws(
      () => bake([{ x: 1 }, { x: 2, y: 3 }], { validate: true }),
      /unknown field 'y'/
    );
  });

  test('passes when validate:true and all records match', () => {
    assert.doesNotThrow(() =>
      bake([{ x: 1, y: 2 }, { x: 3, y: 4 }], { validate: true })
    );
  });
});

// ============================================================================
// GROUP 7 — Reader offset helpers & type checks
// ============================================================================

describe('Reader offset helpers', () => {
  const mkReader = () => new Reader(bake(
    [{ px: 1.5, py: 2.5, tag: 7, id: 100000 }],
    { schema: { px: Types.F32, py: Types.F32, tag: Types.U8, id: Types.U32 } }
  ));

  test('offsetF32 works for F32 fields', () => {
    const r = mkReader();
    assert.equal(typeof r.offsetF32('px'), 'number');
    assert.equal(typeof r.offsetF32('py'), 'number');
  });

  test('offsetF32 throws on wrong-type field', () => {
    const r = mkReader();
    assert.throws(() => r.offsetF32('tag'), /wrong type/);
  });

  test('offsetU8 works, throws on non-8-bit', () => {
    const r = mkReader();
    assert.equal(r.offsetU8('tag'), r.offsetBytes('tag'));
    assert.throws(() => r.offsetU8('id'), /not 8-bit/);
  });

  test('offsetU32 and offsetI32 both accept 32-bit int fields', () => {
    // They're bit-identical at the memory level; the choice is interpretive.
    const r = mkReader();
    assert.equal(r.offsetU32('id'), r.offsetI32('id'));
  });

  test('unknown field name throws with useful message', () => {
    const r = mkReader();
    assert.throws(() => r.offsetF32('nope'),  /unknown field/);
    assert.throws(() => r.offsetBytes('nope'), /unknown field/);
    assert.throws(() => r.get(0, 'nope'),     /unknown field/);
  });

  test('row(i) returns an object with all declared fields', () => {
    const r = mkReader();
    const row = r.row(0);
    assert.equal(row.px, 1.5);
    assert.equal(row.py, 2.5);
    assert.equal(row.tag, 7);
    assert.equal(row.id, 100000);
  });
});

// ============================================================================
// GROUP 8 — Hot-loop pattern smoke test
// ============================================================================

describe('hot-loop pattern (integration)', () => {
  test('reading via cached offsets + typed arrays matches .get()', () => {
    const N = 1000;
    const records = [];
    for (let i = 0; i < N; i++) records.push({ x: i * 0.5, y: -i * 0.25, type: i % 5 });

    const r = new Reader(bake(records));

    const f32 = r.f32, u8 = r.u8;
    const s32 = r.strideF32, sB = r.stride;
    const OX = r.offsetF32('x');
    const OY = r.offsetF32('y');
    const OT = r.offsetU8('type');

    for (let i = 0; i < N; i++) {
      const x = f32[i * s32 + OX];
      const y = f32[i * s32 + OY];
      const t = u8 [i * sB  + OT];
      assert.ok(Math.abs(x - records[i].x) < 1e-5);
      assert.ok(Math.abs(y - records[i].y) < 1e-5);
      assert.equal(t, records[i].type);
    }
  });

  test('large buffer: 50k records bake and read correctly', () => {
    const N = 50000;
    const records = [];
    for (let i = 0; i < N; i++) records.push({ x: i, y: i * 2, z: i % 256 });
    const r = new Reader(bake(records));
    assert.equal(r.count, N);
    // Spot-check first, middle, last
    assert.equal(r.get(0, 'x'),       0);
    assert.equal(r.get(N/2, 'y'),     N);
    assert.equal(r.get(N-1, 'z'),     (N-1) % 256);
  });
});
