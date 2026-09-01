/**
 * t1 -- degenerate values through bake + Reader. STUB.
 *
 * B1/B3 fill this tier with the full section-3 degenerate matrix (-0, NaN,
 * +/-Infinity, 2^24 +/- 1, 2^31/2^32/2^53 boundaries, 5e-324 and 1e39 under
 * F32, empty/proto keys, every Types override on every value class). For now it
 * registers the three write/inference S1 findings it owns as `todo`s that must
 * STILL reproduce: BK-01 (integer wrap), BK-02 (F32 precision loss), BK-03 (NaN
 * and -0 destroyed under an explicit F64 override). The probe bodies are ported
 * from bench/findings-probes-2026-09-01.mjs; each returns "still reproduced".
 *
 * BK-01 fixes in B3 (the inference ladder), BK-02 in B3, BK-03 in B1 (value
 * policy). When a probe stops reproducing, its todo fails the run and demands
 * promotion to an enforced check.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { todoReproduced } from './harness.mjs';

export function run() {
  // BK-01: integer inference has no 32-bit ceiling; values wrap silently.
  // The B3 fix refuses out-of-range integers (E_UNSAFE_INTEGER) or widens to
  // F64: either way the wrap stops. Catch our own expected throw here so a
  // fix-that-throws evaluates to NOT reproduced (returns false) rather than
  // propagating as a harness fault.
  todoReproduced('BK-01-int-ceiling-wrap', () => {
    let a, b, c;
    try {
      a = new Reader(bake([{ v: 2 ** 32 }])).get(0, 'v');        // U32 lane, >>> 0
      b = new Reader(bake([{ v: -(2 ** 31) - 1 }])).get(0, 'v'); // I32 lane, | 0
      c = new Reader(bake([{ v: 2 ** 53 }])).get(0, 'v');        // U32 lane, >>> 0
    } catch {
      return false; // a fix that refuses the value means the wrap no longer reproduces
    }
    return a === 0 && b === 2147483647 && c === 0;
  });

  // BK-02: "smallest type that fits" infers F32 for doubles F32 cannot represent.
  todoReproduced('BK-02-f32-precision-loss', () => {
    const b1 = bake([{ v: 0.1 }]);
    const t1 = b1.schema[0].type;
    const v1 = new Reader(b1).get(0, 'v');
    const b2 = bake([{ v: 0.5 }, { v: 20000001 }]);   // mixed column -> F32
    const v2 = new Reader(b2).get(1, 'v');
    return t1 === Types.F32 && v1 !== 0.1 && v2 === 20000000;
  });

  // BK-03: NaN and -0 destroyed even under an explicit F64 override (`+v || 0`).
  todoReproduced('BK-03-nan-negzero-destroyed', () => {
    const rNan = new Reader(bake([{ v: NaN }], { schema: { v: Types.F64 } })).get(0, 'v');
    const rNegZero = new Reader(bake([{ v: -0 }], { schema: { v: Types.F64 } })).get(0, 'v');
    return rNan === 0 && Object.is(rNegZero, 0) && !Object.is(rNegZero, -0);
  });
}
