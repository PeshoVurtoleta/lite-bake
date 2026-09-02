/**
 * lite-bake -- write-side door tests (B1, v1.1.0).
 *
 * One banner section per finding closed in this session. Every assertion pins an
 * exact LiteBakeError.code (the stable contract), plus a non-vacuous clean twin
 * where the finding has one. These execute the decisions/0001 value policy.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bake, Reader, Types, LiteBakeError } from '../Bake.js';

const isCode = (code) => (e) => e.code === code;

// ============================================================================
// BK-04 -- non-numbers refuse by default; coerce:'zero' stores 0 (not +v)
// ============================================================================

describe('BK-04 non-numeric values', () => {
  test('default refuses booleans, numeric strings, arrays, objects', () => {
    assert.throws(() => bake([{ v: true }]),   isCode('E_NON_NUMERIC'));
    assert.throws(() => bake([{ v: '42.5' }]), isCode('E_NON_NUMERIC'));
    assert.throws(() => bake([{ v: [7] }]),    isCode('E_NON_NUMERIC'));
    assert.throws(() => bake([{ v: {} }]),     isCode('E_NON_NUMERIC'));
  });

  test('coerce:zero stores exact 0, never the +v coercion (1/42.5/7)', () => {
    const cases = [{ v: true }, { v: '42.5' }, { v: [7] }, { v: {} }];
    for (const rec of cases) {
      const r = new Reader(bake([rec], { coerce: 'zero' }));
      assert.equal(r.get(0, 'v'), 0);
    }
  });
});

// ============================================================================
// BK-03 -- NaN / -0 / +/-Infinity survive the value door (numbers write direct)
// ============================================================================

describe('BK-03 float sentinels round-trip', () => {
  test('explicit F64 override preserves NaN, -0, +/-Infinity', () => {
    const r = new Reader(bake(
      [{ v: NaN }, { v: -0 }, { v: Infinity }, { v: -Infinity }],
      { schema: { v: Types.F64 } }
    ));
    assert.ok(Number.isNaN(r.get(0, 'v')));
    assert.ok(Object.is(r.get(1, 'v'), -0));
    assert.equal(r.get(2, 'v'), Infinity);
    assert.equal(r.get(3, 'v'), -Infinity);
  });

  test('explicit F32 override preserves NaN, -0, +/-Infinity', () => {
    const r = new Reader(bake(
      [{ v: NaN }, { v: -0 }, { v: Infinity }, { v: -Infinity }],
      { schema: { v: Types.F32 } }
    ));
    assert.ok(Number.isNaN(r.get(0, 'v')));
    assert.ok(Object.is(r.get(1, 'v'), -0));
    assert.equal(r.get(2, 'v'), Infinity);
    assert.equal(r.get(3, 'v'), -Infinity);
  });

  test('inferred float lane preserves NaN, -0, +/-Infinity', () => {
    // A fractional value forces F32 inference; the sentinels ride the same lane.
    const b = bake([{ v: 1.5 }, { v: NaN }, { v: -0 }, { v: Infinity }, { v: -Infinity }]);
    const r = new Reader(b);
    assert.equal(b.schema[0].type, Types.F32);
    assert.ok(Number.isNaN(r.get(1, 'v')));
    assert.ok(Object.is(r.get(2, 'v'), -0));
    assert.equal(r.get(3, 'v'), Infinity);
    assert.equal(r.get(4, 'v'), -Infinity);
  });
});

// ============================================================================
// BK-06 -- validate:true now inspects values, not just key sets
// ============================================================================

describe('BK-06 validate:true refuses non-numeric values', () => {
  test('{v:null} under validate:true throws E_NON_NUMERIC', () => {
    assert.throws(() => bake([{ v: null }, { v: 2 }], { validate: true }),
      isCode('E_NON_NUMERIC'));
  });

  test('validate:true passes a clean uniform numeric corpus', () => {
    assert.doesNotThrow(() => bake([{ v: 1 }, { v: 2 }], { validate: true }));
  });
});

// ============================================================================
// BK-07 -- schema override door: bad type codes and ghost fields refuse
// ============================================================================

describe('BK-07 schema override door', () => {
  test('numeric out-of-range code throws E_BAD_TYPE', () => {
    assert.throws(() => bake([{ v: 1.5 }], { schema: { v: 99 } }), isCode('E_BAD_TYPE'));
  });

  test('string type code throws E_BAD_TYPE', () => {
    assert.throws(() => bake([{ v: 1.5 }], { schema: { v: 'F64' } }), isCode('E_BAD_TYPE'));
  });

  test('override for a field not in the records throws E_UNKNOWN_FIELD', () => {
    assert.throws(() => bake([{ a: 1 }], { schema: { ghost: Types.F32 } }),
      isCode('E_UNKNOWN_FIELD'));
  });

  test('a valid override still bakes', () => {
    const b = bake([{ v: 1.5 }], { schema: { v: Types.F64 } });
    assert.equal(b.schema[0].type, Types.F64);
  });
});

// ============================================================================
// BK-08 -- opts door: unknown keys, out-of-domain values, conflicts
// ============================================================================

describe('BK-08 opts door', () => {
  test("typo'd key throws E_UNKNOWN_OPTION with a did-you-mean 'schema'", () => {
    assert.throws(() => bake([{ v: 1 }], { shcema: { v: Types.F64 } }),
      (e) => e.code === 'E_UNKNOWN_OPTION' && /did you mean 'schema'/.test(e.message));
  });

  test('far-off key falls to the (known: ...) branch', () => {
    assert.throws(() => bake([{ v: 1 }], { zzz_totally_wrong: 1 }),
      (e) => e.code === 'E_UNKNOWN_OPTION' && /\(known: schema, validate, coerce\)/.test(e.message));
  });

  test('non-boolean validate throws E_OPTION_VALUE', () => {
    assert.throws(() => bake([{ v: 1 }], { validate: 'yes' }), isCode('E_OPTION_VALUE'));
  });

  test('validate:true + coerce:zero throws E_OPTION_CONFLICT', () => {
    assert.throws(() => bake([{ v: 1 }], { validate: true, coerce: 'zero' }),
      isCode('E_OPTION_CONFLICT'));
  });

  test('coerce with an unknown value throws E_OPTION_VALUE', () => {
    assert.throws(() => bake([{ v: 1 }], { coerce: 'zip' }), isCode('E_OPTION_VALUE'));
  });
});

// ============================================================================
// BK-11 -- record-shape door: non-objects and empty records refuse
// ============================================================================

describe('BK-11 record-shape door', () => {
  test('primitive, string, array, and null records throw E_NOT_A_RECORD', () => {
    assert.throws(() => bake([1, 2, 3]),      isCode('E_NOT_A_RECORD'));
    assert.throws(() => bake(['ab', 'cd']),   isCode('E_NOT_A_RECORD'));
    assert.throws(() => bake([[1, 2]]),       isCode('E_NOT_A_RECORD'));
    assert.throws(() => bake([null]),         isCode('E_NOT_A_RECORD'));
  });

  test('a record 0 with zero keys throws E_EMPTY_RECORD', () => {
    assert.throws(() => bake([{}, {}]), isCode('E_EMPTY_RECORD'));
  });
});

// ============================================================================
// BK-13 -- drift door: extra/missing fields refuse; coerce restores rec-0 keyset
// ============================================================================

describe('BK-13 field drift', () => {
  test('an extra field in a later record throws E_UNEXPECTED_FIELD', () => {
    assert.throws(() => bake([{ a: 1 }, { a: 2, b: 99 }]), isCode('E_UNEXPECTED_FIELD'));
  });

  test('a missing field in a later record throws E_MISSING_FIELD', () => {
    assert.throws(() => bake([{ a: 1, b: 5 }, { a: 2 }]), isCode('E_MISSING_FIELD'));
  });

  test('coerce:zero reproduces record-0-keyset behavior', () => {
    // Extra field 'b' is dropped (keyset comes from record 0).
    const bDrop = bake([{ a: 1 }, { a: 2, b: 99 }], { coerce: 'zero' });
    assert.ok(!bDrop.schema.some((f) => f.name === 'b'));
    // Absent field 'b' reads 0.
    const r = new Reader(bake([{ a: 1, b: 5 }, { a: 2 }], { coerce: 'zero' }));
    assert.equal(r.get(1, 'b'), 0);
  });
});

// ============================================================================
// Inherited-override hole -- type resolution consults OWN override keys only
// ============================================================================

describe('prototype-named fields', () => {
  test('constructor/toString infer to real lanes and round-trip exactly', () => {
    // JSON.parse gives own keys named after Object.prototype members. With no
    // override, type resolution must NOT read the inherited function.
    const recs = JSON.parse('[{"constructor":1,"toString":2}]');
    const b = bake(recs);
    const r = new Reader(b);
    for (const f of b.schema) assert.equal(typeof f.type, 'number');
    assert.equal(r.get(0, 'constructor'), 1);
    assert.equal(r.get(0, 'toString'), 2);
  });

  test('an explicit override on a prototype-named field still applies', () => {
    const b = bake(JSON.parse('[{"constructor":1,"x":2}]'), { schema: { constructor: Types.F32 } });
    assert.equal(b.schema.find((f) => f.name === 'constructor').type, Types.F32);
  });
});

// ============================================================================
// Opts-bag door -- null/undefined use defaults; other non-plain-objects refuse
// ============================================================================

describe('opts-bag door', () => {
  test('null and undefined opts behave as no-opts', () => {
    assert.doesNotThrow(() => bake([{ v: 1 }], null));
    assert.doesNotThrow(() => bake([{ v: 1 }], undefined));
  });

  test('a primitive or array opts throws E_OPTION_VALUE', () => {
    assert.throws(() => bake([{ v: 1 }], 42), isCode('E_OPTION_VALUE'));
    assert.throws(() => bake([{ v: 1 }], 'foo'), isCode('E_OPTION_VALUE'));
    assert.throws(() => bake([{ v: 1 }], true), isCode('E_OPTION_VALUE'));
    assert.throws(() => bake([{ v: 1 }], []), isCode('E_OPTION_VALUE'));
  });
});

// ============================================================================
// BK-18 -- the refusal vocabulary itself
// ============================================================================

describe('BK-18 LiteBakeError shape', () => {
  test('a caught refusal is a LiteBakeError with name and code', () => {
    let caught = null;
    try { bake([{ v: true }]); } catch (e) { caught = e; }
    assert.ok(caught instanceof LiteBakeError);
    assert.ok(caught instanceof Error);
    assert.equal(caught.name, 'LiteBakeError');
    assert.equal(caught.code, 'E_NON_NUMERIC');
    assert.equal(typeof caught.message, 'string');
  });
});

// ============================================================================
// Behavior pin -- a well-formed uniform numeric bake is unchanged
// ============================================================================

describe('happy-path behavior pin', () => {
  test('uniform numeric records bake with unchanged stride and values', () => {
    const recs = [{ x: 1.5, y: 3, t: 2 }, { x: -2.25, y: 10, t: 0 }];
    const b = bake(recs);
    const r = new Reader(b);
    // y (small non-negative ints) -> U8, t -> U8, x -> F32; stride packs F32(4)+U8+U8.
    assert.equal(b.stride, 8);
    assert.equal(r.get(0, 'x'), 1.5);
    assert.equal(r.get(1, 'x'), -2.25);
    assert.equal(r.get(0, 'y'), 3);
    assert.equal(r.get(1, 't'), 0);
  });
});
