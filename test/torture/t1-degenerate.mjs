/**
 * t1 -- degenerate values through bake + Reader. LIVE (promoted in B3).
 *
 * The inference ladder (decisions/0005) closed BK-01 and BK-02: integer columns
 * past the 32-bit lanes widen to F64 up to +/-(2^53-1) and refuse beyond it
 * (E_UNSAFE_INTEGER); the float rung is F32 only when every value survives
 * Math.fround, else F64. Both findings' todos are gone -- their probes are now
 * enforced checks below. BK-03 (NaN/-0/Infinity in float lanes) stays enforced.
 *
 * The full section-3 degenerate matrix rides along: the 32-bit ceilings, the
 * safe-integer extremes, the 2^24 fround boundary, subnormals, non-finite
 * forcing, and a README truth pin (the ladder is documented, the dead catchall
 * row is gone).
 */

import { readFileSync } from 'node:fs';
import { bake, Reader, Types } from '../../src/index.js';
import { check } from './harness.mjs';

function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

export function run() {
  // BK-01 PROMOTED: the integer ladder. No 32-bit lane silently wraps anymore.
  check(new Reader(bake([{ v: 2 ** 32 }])).get(0, 'v') === 4294967296,
    () => 't1.BK-01: 2**32 did not read back 4294967296 (F64 widening)');
  check(new Reader(bake([{ v: -(2 ** 31) - 1 }])).get(0, 'v') === -2147483649,
    () => 't1.BK-01: -(2**31)-1 did not read back -2147483649 (F64 widening)');
  const e2p53 = caught(() => bake([{ v: 2 ** 53 }]));
  check(!!e2p53 && e2p53.code === 'E_UNSAFE_INTEGER',
    () => 't1.BK-01: 2**53 did not refuse E_UNSAFE_INTEGER (code=' + (e2p53 && e2p53.code) + ')');

  // BK-02 PROMOTED: the fround rung. A double F32 cannot hold exactly widens.
  check(bake([{ v: 0.1 }]).schema[0].type === Types.F64,
    () => 't1.BK-02: 0.1 did not infer F64');
  check(new Reader(bake([{ v: 0.1 }])).get(0, 'v') === 0.1,
    () => 't1.BK-02: 0.1 did not read back exactly');
  check(bake([{ v: 0.5 }, { v: 20000001 }]).schema[0].type === Types.F64,
    () => 't1.BK-02: [0.5, 20000001] did not infer F64');
  check(new Reader(bake([{ v: 0.5 }, { v: 20000001 }])).get(1, 'v') === 20000001,
    () => 't1.BK-02: 20000001 did not read back exactly under F64');

  // Degenerate integer ceilings -- inclusive tops, then the F64 step past them.
  check(bake([{ v: 0 }, { v: 2 ** 32 - 1 }]).schema[0].type === Types.U32,
    () => 't1: [0, 2**32-1] did not infer U32 (inclusive top)');
  check(bake([{ v: 0 }, { v: 2 ** 32 }]).schema[0].type === Types.F64,
    () => 't1: [0, 2**32] did not infer F64');
  check(bake([{ v: -1 }, { v: 2 ** 31 }]).schema[0].type === Types.F64,
    () => 't1: [-1, 2**31] did not infer F64');
  check(new Reader(bake([{ v: 2 ** 53 - 1 }])).get(0, 'v') === 2 ** 53 - 1,
    () => 't1: 2**53-1 did not read back exactly under F64');
  check(new Reader(bake([{ v: -(2 ** 53 - 1) }])).get(0, 'v') === -(2 ** 53 - 1),
    () => 't1: -(2**53-1) did not read back exactly under F64');

  // The 2^24 fround boundary and a subnormal.
  check(bake([{ v: 0.5 }, { v: 2 ** 24 }]).schema[0].type === Types.F32,
    () => 't1: [0.5, 2**24] did not infer F32 (fround-exact)');
  check(bake([{ v: 0.5 }, { v: 2 ** 24 + 1 }]).schema[0].type === Types.F64,
    () => 't1: [0.5, 2**24+1] did not infer F64 (fround-hostile)');
  check(new Reader(bake([{ v: 5e-324 }])).get(0, 'v') === 5e-324,
    () => 't1: 5e-324 did not read back exactly under F64');
  // A huge double survives F64 exactly in a FLOAT column (double semantics).
  check(new Reader(bake([{ v: 0.5 }, { v: 1e39 }])).get(1, 'v') === 1e39,
    () => 't1: 1e39 did not read back exactly under F64 in a float column');

  // Non-finite forcing: a NaN/Infinity column can never take an integer lane.
  const infLit = new Reader(bake([{ v: 1e309 }]));   // 1e309 overflows to Infinity
  check(bake([{ v: 1e309 }]).schema[0].type === Types.F32,
    () => 't1: an Infinity-only column did not fall back to F32');
  check(infLit.get(0, 'v') === Infinity,
    () => 't1: F32 fallback lost the Infinity literal');
  const mix = new Reader(bake([{ v: 1 }, { v: NaN }]));
  check(bake([{ v: 1 }, { v: NaN }]).schema[0].type === Types.F32,
    () => 't1: [1, NaN] did not force the float rung (F32)');
  check(mix.get(0, 'v') === 1, () => 't1: [1, NaN] lost the finite 1');
  check(Number.isNaN(mix.get(1, 'v')), () => 't1: [1, NaN] lost the NaN');

  // BK-03 (B1, still enforced): NaN, -0 and +/-Infinity survive every float lane.
  const f64 = new Reader(bake(
    [{ v: NaN }, { v: -0 }, { v: Infinity }, { v: -Infinity }],
    { schema: { v: Types.F64 } }));
  check(Number.isNaN(f64.get(0, 'v')), () => 't1.BK-03: F64 override lost NaN');
  check(Object.is(f64.get(1, 'v'), -0), () => 't1.BK-03: F64 override lost -0');
  check(f64.get(2, 'v') === Infinity, () => 't1.BK-03: F64 override lost +Infinity');
  check(f64.get(3, 'v') === -Infinity, () => 't1.BK-03: F64 override lost -Infinity');

  const f32 = new Reader(bake(
    [{ v: NaN }, { v: -0 }, { v: Infinity }, { v: -Infinity }],
    { schema: { v: Types.F32 } }));
  check(Number.isNaN(f32.get(0, 'v')), () => 't1.BK-03: F32 override lost NaN');
  check(Object.is(f32.get(1, 'v'), -0), () => 't1.BK-03: F32 override lost -0');
  check(f32.get(2, 'v') === Infinity, () => 't1.BK-03: F32 override lost +Infinity');
  check(f32.get(3, 'v') === -Infinity, () => 't1.BK-03: F32 override lost -Infinity');

  // Inferred float lane: a fractional value forces F32, the sentinels ride it.
  const inf = new Reader(bake([{ v: 1.5 }, { v: NaN }, { v: -0 }, { v: Infinity }, { v: -Infinity }]));
  check(Number.isNaN(inf.get(1, 'v')), () => 't1.BK-03: inferred F32 lost NaN');
  check(Object.is(inf.get(2, 'v'), -0), () => 't1.BK-03: inferred F32 lost -0');
  check(inf.get(3, 'v') === Infinity, () => 't1.BK-03: inferred F32 lost +Infinity');
  check(inf.get(4, 'v') === -Infinity, () => 't1.BK-03: inferred F32 lost -Infinity');

  // README pin: the ladder is documented and the dead catchall row is gone.
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  check(readme.includes('E_UNSAFE_INTEGER'),
    () => 't1: README.md does not mention E_UNSAFE_INTEGER');
  check(readme.includes('fround'),
    () => 't1: README.md does not mention fround');
  check(!readme.includes('Any fractional value'),
    () => 't1: the dead "Any fractional value" catchall row is still in README.md');
}
