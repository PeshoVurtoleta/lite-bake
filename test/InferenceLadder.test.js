/**
 * lite-bake -- inference ladder + fit-door tests (B3, v1.2.0).
 *
 * The inference ladder (decisions/0005) picks the smallest lane that holds a
 * column EXACTLY, widening integers past the 32-bit lanes to F64 and refusing
 * beyond +/-(2^53-1) with E_UNSAFE_INTEGER; the float rung is F32 only when
 * every value survives Math.fround, else F64. The fit door refuses any number
 * an int lane cannot represent exactly (E_LANE_MISMATCH) in ALL modes. Every
 * code is pinned via the recognised spellings: an isCode(<code>) helper, a code
 * equality against a single-quoted literal, and a code: <code> object property.
 * BK-29: the drift door now uses own-key semantics.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bake, Reader, Types } from '../src/index.js';

const isCode = (code) => (e) => e.code === code;

const typeOf = (recs, opts) => bake(recs, opts).schema[0].type;
const readback = (recs, opts) => new Reader(bake(recs, opts)).get(0, 'v');

// ============================================================================
// A. integer rung -- boundary tops inclusive, F64 widening, unsafe refusal
// ============================================================================

describe('A. integer rung', () => {
  test('unsigned lanes and inclusive tops', () => {
    assert.equal(typeOf([{ v: 0 }, { v: 255 }]), Types.U8);
    assert.equal(typeOf([{ v: 0 }, { v: 256 }]), Types.U16);
    assert.equal(typeOf([{ v: 0 }, { v: 65535 }]), Types.U16);
    assert.equal(typeOf([{ v: 0 }, { v: 65536 }]), Types.U32);
    assert.equal(typeOf([{ v: 0 }, { v: 0xffffffff }]), Types.U32); // inclusive top
  });

  test('past U32 widens to F64 with exact readback', () => {
    assert.equal(typeOf([{ v: 0 }, { v: 2 ** 32 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: 2 ** 32 }])).get(0, 'v'), 4294967296);
  });

  test('signed lanes and inclusive tops', () => {
    assert.equal(typeOf([{ v: -1 }, { v: 2 ** 31 - 1 }]), Types.I32);
    assert.equal(typeOf([{ v: -(2 ** 31) }, { v: 0 }]), Types.I32); // inclusive bottom
  });

  test('past I32 widens to F64 with exact readback', () => {
    assert.equal(typeOf([{ v: -1 }, { v: 2 ** 31 }]), Types.F64);
    assert.equal(typeOf([{ v: -(2 ** 31) - 1 }, { v: 0 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: -(2 ** 31) - 1 }])).get(0, 'v'), -2147483649);
  });

  test('safe-integer extremes stay F64 exact', () => {
    assert.equal(typeOf([{ v: 0 }, { v: 2 ** 53 - 1 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: 2 ** 53 - 1 }])).get(0, 'v'), 2 ** 53 - 1);
    assert.equal(typeOf([{ v: -(2 ** 53 - 1) }, { v: 0 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: -(2 ** 53 - 1) }])).get(0, 'v'), -(2 ** 53 - 1));
  });

  test('beyond +/-(2^53-1) refuses E_UNSAFE_INTEGER', () => {
    assert.throws(() => bake([{ v: 2 ** 53 }]), isCode('E_UNSAFE_INTEGER'));
    assert.throws(() => bake([{ v: -(2 ** 53) }]), isCode('E_UNSAFE_INTEGER'));
    assert.throws(() => bake([{ v: 2 ** 60 }]), isCode('E_UNSAFE_INTEGER'));
  });

  test('the E_UNSAFE_INTEGER message names the F64 escape', () => {
    assert.throws(() => bake([{ v: 2 ** 60 }]),
      (e) => e.code === 'E_UNSAFE_INTEGER' && e.message.includes('F64'));
  });
});

// ============================================================================
// B. fround rung -- F32 only when every value survives the round-trip
// ============================================================================

describe('B. fround rung', () => {
  test('0.1 widens to F64 and reads back exact', () => {
    assert.equal(typeOf([{ v: 0.1 }]), Types.F64);
    assert.equal(readback([{ v: 0.1 }]), 0.1);
  });

  test('fround-exact fractions stay F32', () => {
    assert.equal(typeOf([{ v: 1.5 }]), Types.F32);   // the B1 pin twin
    assert.equal(typeOf([{ v: 0.5 }, { v: 1.5 }]), Types.F32);
  });

  test('a fround-hostile mixed column widens to F64 with exact readback', () => {
    assert.equal(typeOf([{ v: 0.5 }, { v: 20000001 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: 0.5 }, { v: 20000001 }])).get(1, 'v'), 20000001);
  });

  test('the 2^24 fround boundary', () => {
    assert.equal(typeOf([{ v: 0.5 }, { v: 2 ** 24 }]), Types.F32);
    assert.equal(typeOf([{ v: 0.5 }, { v: 2 ** 24 + 1 }]), Types.F64);
  });

  test('a subnormal double widens to F64 exact', () => {
    assert.equal(typeOf([{ v: 5e-324 }]), Types.F64);
    assert.equal(readback([{ v: 5e-324 }]), 5e-324);
  });

  // 1e39 is Number.isInteger-true (all doubles past 2^52 are integers), so it is
  // an integer column beyond +/-(2^53-1) -- ambiguous, and refused, exactly like
  // 2**60. It is only in a FLOAT column (a fractional value present) that a huge
  // double stays F64 exact, since a float column carries double semantics and has
  // no safe-integer door (decisions/0005). See DEVIATIONS in the B3 report.
  test('a lone huge integer-valued double refuses E_UNSAFE_INTEGER', () => {
    assert.throws(() => bake([{ v: 1e39 }]), isCode('E_UNSAFE_INTEGER'));
  });

  test('a huge double in a float column stays F64 exact', () => {
    assert.equal(typeOf([{ v: 0.5 }, { v: 1e300 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: 0.5 }, { v: 1e300 }])).get(1, 'v'), 1e300);
    assert.equal(typeOf([{ v: 0.5 }, { v: 1e39 }]), Types.F64);
    assert.equal(new Reader(bake([{ v: 0.5 }, { v: 1e39 }])).get(1, 'v'), 1e39);
  });
});

// ============================================================================
// C. non-finite forcing -- a NaN/Infinity column can never take an int lane
// ============================================================================

describe('C. non-finite forcing', () => {
  test('[1, NaN] infers F32 and preserves both', () => {
    const r = new Reader(bake([{ v: 1 }, { v: NaN }]));
    assert.equal(typeOf([{ v: 1 }, { v: NaN }]), Types.F32);
    assert.equal(r.get(0, 'v'), 1);
    assert.ok(Number.isNaN(r.get(1, 'v')));
  });

  test('[2, Infinity] infers F32 and preserves Infinity', () => {
    const r = new Reader(bake([{ v: 2 }, { v: Infinity }]));
    assert.equal(typeOf([{ v: 2 }, { v: Infinity }]), Types.F32);
    assert.equal(r.get(1, 'v'), Infinity);
  });

  test('[NaN] alone falls back to F32', () => {
    assert.equal(typeOf([{ v: NaN }]), Types.F32);
  });
});

// ============================================================================
// D. fit door -- an int-lane override refuses inexact numbers in ALL modes
// ============================================================================

describe('D. fit door (override)', () => {
  test('out-of-range / fractional / non-finite refuse E_LANE_MISMATCH', () => {
    assert.throws(() => bake([{ v: 256 }], { schema: { v: Types.U8 } }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: -1 }], { schema: { v: Types.U8 } }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: 0.5 }], { schema: { v: Types.U8 } }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: NaN }], { schema: { v: Types.I32 } }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: 2 ** 32 }], { schema: { v: Types.U32 } }), isCode('E_LANE_MISMATCH'));
  });

  test('the fit door fires in validate and coerce modes too (numbers never coerced)', () => {
    assert.throws(() => bake([{ v: 0.5 }], { schema: { v: Types.U8 }, validate: true }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: 0.5 }], { schema: { v: Types.U8 }, coerce: 'zero' }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: 2 ** 32 }], { schema: { v: Types.U32 }, validate: true }), isCode('E_LANE_MISMATCH'));
    assert.throws(() => bake([{ v: 2 ** 32 }], { schema: { v: Types.U32 }, coerce: 'zero' }), isCode('E_LANE_MISMATCH'));
  });

  test('in-range twins bake fine', () => {
    assert.equal(new Reader(bake([{ v: 255 }], { schema: { v: Types.U8 } })).get(0, 'v'), 255);
    assert.equal(new Reader(bake([{ v: 0 }], { schema: { v: Types.U8 } })).get(0, 'v'), 0);
    assert.equal(new Reader(bake([{ v: 0xffffffff }], { schema: { v: Types.U32 } })).get(0, 'v'), 0xffffffff);
  });

  test('a float override accepts values an int lane would refuse', () => {
    assert.equal(new Reader(bake([{ v: 2 ** 60 }], { schema: { v: Types.F64 } })).get(0, 'v'), 2 ** 60);
    assert.equal(new Reader(bake([{ v: 0.1 }], { schema: { v: Types.F32 } })).get(0, 'v'), Math.fround(0.1));
  });

  test('coerce still zeroes a non-number into an int lane (type leniency intact)', () => {
    assert.equal(new Reader(bake([{ v: 'x' }], { schema: { v: Types.U8 }, coerce: 'zero' })).get(0, 'v'), 0);
  });
});

// ============================================================================
// E. BK-29 -- own-key semantics at the drift door
// ============================================================================

describe('E. BK-29 own-key drift door', () => {
  test('an own prototype-named field dropped in record N refuses E_MISSING_FIELD', () => {
    const rec0 = JSON.parse('{"constructor": 1, "x": 2}');
    const rec1 = JSON.parse('{"x": 3}');
    assert.throws(() => bake([rec0, rec1]), (e) => e.code === 'E_MISSING_FIELD');
  });

  test('both records carrying an own constructor field round-trip', () => {
    const rec0 = JSON.parse('{"constructor": 10, "x": 20}');
    const rec1 = JSON.parse('{"constructor": 30, "x": 40}');
    const r = new Reader(bake([rec0, rec1]));
    assert.equal(r.get(0, 'constructor'), 10);
    assert.equal(r.get(1, 'constructor'), 30);
    assert.equal(r.get(1, 'x'), 40);
  });
});

// ============================================================================
// F. precedence twins -- door order pins
// ============================================================================

describe('F. precedence', () => {
  test('an unknown extra field beats the value doors (E_UNEXPECTED_FIELD)', () => {
    assert.throws(() => bake([{ v: 1 }, { v: 2, extra: 0.5 }]), isCode('E_UNEXPECTED_FIELD'));
  });

  test('a string into an overridden int lane is E_NON_NUMERIC, not E_LANE_MISMATCH', () => {
    assert.throws(() => bake([{ v: 'nope' }], { schema: { v: Types.U8 } }), isCode('E_NON_NUMERIC'));
  });
});
