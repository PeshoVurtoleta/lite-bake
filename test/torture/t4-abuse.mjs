/**
 * t4 -- API abuse (every case gets a decided policy). LIVE.
 *
 * Every misuse gets a decided policy (throw / documented no-op / documented
 * value -- "silently returns garbage" is not one of the three). B1 closed the
 * write-side fail-opens (BK-06 validate ignores values, BK-07 schema override
 * fails open, BK-08 opts fail open on typos, BK-11 non-object/empty records,
 * BK-13 drift); B2 closes BK-10 -- out-of-range/non-integer row indices refuse
 * with R_ROW_OUT_OF_RANGE instead of failing open three ways. Every case is an
 * enforced check pinning the exact code plus a non-vacuous clean twin.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { check } from './harness.mjs';

function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

export function run() {
  // BK-06 CLOSED (B1): validate:true now inspects values. {v:null} refuses with
  // E_NON_NUMERIC; a clean numeric corpus still passes (non-vacuous twin).
  const e06 = caught(() => bake([{ v: null }, { v: 2 }], { validate: true }));
  check(!!e06 && e06.code === 'E_NON_NUMERIC',
    () => 't4.BK-06: validate:true accepted {v:null} (code=' + (e06 && e06.code) + ')');
  check(caught(() => bake([{ v: 1 }, { v: 2 }], { validate: true })) === null,
    () => 't4.BK-06: validate:true rejected a clean numeric corpus');

  // BK-07 CLOSED (B1): schema override door refuses bad codes and ghost fields.
  const e07a = caught(() => bake([{ v: 1.5 }], { schema: { v: 99 } }));
  check(!!e07a && e07a.code === 'E_BAD_TYPE',
    () => 't4.BK-07: type code 99 not refused (code=' + (e07a && e07a.code) + ')');
  const e07b = caught(() => bake([{ v: 1.5 }], { schema: { v: 'F64' } }));
  check(!!e07b && e07b.code === 'E_BAD_TYPE',
    () => 't4.BK-07: string code not refused (code=' + (e07b && e07b.code) + ')');
  const e07c = caught(() => bake([{ a: 1 }], { schema: { ghost: Types.F32 } }));
  check(!!e07c && e07c.code === 'E_UNKNOWN_FIELD',
    () => 't4.BK-07: ghost override not refused (code=' + (e07c && e07c.code) + ')');
  check(caught(() => bake([{ v: 1.5 }], { schema: { v: Types.F64 } })) === null,
    () => 't4.BK-07: a valid override was refused');

  // BK-08 CLOSED (B1): opts door refuses typos with a did-you-mean; valid passes.
  const e08 = caught(() => bake([{ v: 1.5 }], { shcema: { v: Types.F64 } }));
  check(!!e08 && e08.code === 'E_UNKNOWN_OPTION' && /did you mean 'schema'/.test(e08.message),
    () => 't4.BK-08: typo shcema not refused (code=' + (e08 && e08.code) + ')');
  check(caught(() => bake([{ v: 1.5 }], { validate: true })) === null,
    () => 't4.BK-08: a valid opts object was refused');

  // BK-11 CLOSED (B1): record-shape door refuses non-objects and empty records.
  const e11a = caught(() => bake([1, 2, 3]));
  check(!!e11a && e11a.code === 'E_NOT_A_RECORD',
    () => 't4.BK-11: bake([1,2,3]) not refused (code=' + (e11a && e11a.code) + ')');
  const e11b = caught(() => bake(['ab', 'cd']));
  check(!!e11b && e11b.code === 'E_NOT_A_RECORD',
    () => 't4.BK-11: bake(strings) not refused (code=' + (e11b && e11b.code) + ')');
  const e11c = caught(() => bake([{}, {}]));
  check(!!e11c && e11c.code === 'E_EMPTY_RECORD',
    () => 't4.BK-11: bake([{},{}]) not refused (code=' + (e11c && e11c.code) + ')');
  check(caught(() => bake([{ a: 1 }, { a: 2 }])) === null,
    () => 't4.BK-11: a valid record array was refused');

  // BK-13 CLOSED (B1): drift door refuses extras and absents by default; the
  // coerce:'zero' twin reproduces the old record-0-keyset behavior.
  const e13a = caught(() => bake([{ a: 1 }, { a: 2, b: 99 }]));
  check(!!e13a && e13a.code === 'E_UNEXPECTED_FIELD',
    () => 't4.BK-13: extra field not refused (code=' + (e13a && e13a.code) + ')');
  const e13b = caught(() => bake([{ a: 1, b: 5 }, { a: 2 }]));
  check(!!e13b && e13b.code === 'E_MISSING_FIELD',
    () => 't4.BK-13: absent field not refused (code=' + (e13b && e13b.code) + ')');
  const bDrop = bake([{ a: 1 }, { a: 2, b: 99 }], { coerce: 'zero' });
  check(!bDrop.schema.some((f) => f.name === 'b'),
    () => 't4.BK-13: coerce:zero did not drop the extra field');
  const rAbs = new Reader(bake([{ a: 1, b: 5 }, { a: 2 }], { coerce: 'zero' }));
  check(rAbs.get(1, 'b') === 0,
    () => 't4.BK-13: coerce:zero absent field did not read 0');

  // BK-10 CLOSED (B2): out-of-range/non-integer row indices refuse with one code.
  // On a count-1 bake, padding reads, fractional truncation, negatives, past-count
  // and 2**53-class indices all throw R_ROW_OUT_OF_RANGE; get(0) still reads 7
  // (the non-vacuous twin). Both get() and row() carry the policy.
  const rb = new Reader(bake([{ a: 7 }]));   // U8, stride 1, count 1, buffer padded to 8
  const e10pad  = caught(() => rb.get(1, 'a'));      // count is 1; row 1 is padding
  check(!!e10pad && e10pad.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: get(1) padding read not refused (code=' + (e10pad && e10pad.code) + ')');
  const e10frac = caught(() => rb.get(0.5, 'a'));    // fractional index
  check(!!e10frac && e10frac.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: get(0.5) fractional index not refused (code=' + (e10frac && e10frac.code) + ')');
  const e10neg  = caught(() => rb.get(-1, 'a'));
  check(!!e10neg && e10neg.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: get(-1) not refused (code=' + (e10neg && e10neg.code) + ')');
  const e10past = caught(() => rb.get(8, 'a'));
  check(!!e10past && e10past.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: get(8) past-buffer not refused (code=' + (e10past && e10past.code) + ')');
  const e10huge = caught(() => rb.get(2 ** 53, 'a'));
  check(!!e10huge && e10huge.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: get(2**53) not refused (code=' + (e10huge && e10huge.code) + ')');
  const e10rowPast = caught(() => rb.row(1));
  check(!!e10rowPast && e10rowPast.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: row(1) past-count not refused (code=' + (e10rowPast && e10rowPast.code) + ')');
  const e10rowNeg = caught(() => rb.row(-1));
  check(!!e10rowNeg && e10rowNeg.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: row(-1) not refused (code=' + (e10rowNeg && e10rowNeg.code) + ')');
  // Bounds are checked BEFORE the field lookup: a bad index on a ghost field is
  // R_ROW_OUT_OF_RANGE, not R_UNKNOWN_FIELD (precedence pin).
  const e10ghost = caught(() => rb.get(-1, 'ghost'));
  check(!!e10ghost && e10ghost.code === 'R_ROW_OUT_OF_RANGE',
    () => 't4.BK-10: get(-1, "ghost") bounds precedence (code=' + (e10ghost && e10ghost.code) + ')');
  check(rb.get(0, 'a') === 7,
    () => 't4.BK-10: get(0) did not read 7 (got ' + rb.get(0, 'a') + ')');
}
