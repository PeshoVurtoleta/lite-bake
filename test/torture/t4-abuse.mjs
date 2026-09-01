/**
 * t4 -- API abuse (every case gets a decided policy). STUB.
 *
 * B1/B2 fill this tier: every misuse gets a decided policy (throw / documented
 * no-op / documented value -- "silently returns garbage" is not one of the
 * three). For now it registers the six fail-open S2 findings it owns as `todo`s
 * that must STILL reproduce: BK-06 (validate ignores values), BK-07 (schema
 * override fails open), BK-08 (opts fail open on typos), BK-10 (row index fails
 * open three ways), BK-11 (non-object/empty records), BK-13 (fields beyond
 * record 0 dropped, absent fields read 0). Probe bodies ported from
 * bench/findings-probes-2026-09-01.mjs.
 *
 * BK-06/07/08/11/13 fix in B1 (write-side doors + opts validator); BK-10 in B2.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { todoReproduced, check } from './harness.mjs';

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

  // BK-10: row index fails open -- padding reads as rows, fractions truncate.
  // The B2 bounds policy makes out-of-range/non-integer i throw R_ROW_OUT_OF_RANGE,
  // so a fix throws where today it silently returns a number. Catch the silent
  // reads via caught(): after the fix they carry a code (or throw), flipping the
  // todo. eNeg/ePast use caught() because today they already throw a raw error.
  todoReproduced('BK-10-row-bounds-failopen', () => {
    const r = new Reader(bake([{ a: 7 }]));   // U8, stride 1, buffer padded to 8
    let pad, frac;
    const ePad = caught(() => { pad = r.get(1, 'a'); });   // count is 1; rows 1..7 are padding
    const eFrac = caught(() => { frac = r.get(0.5, 'a'); }); // ToIndex truncation
    const eNeg = caught(() => r.get(-1, 'a'));
    const ePast = caught(() => r.get(8, 'a'));
    // !! coerces the object-operand && chain to a strict boolean.
    return !!(!ePad && pad === 0 && !eFrac && frac === 7 &&
              eNeg && eNeg.name === 'RangeError' && !eNeg.code &&
              ePast && ePast.name === 'RangeError' && !ePast.code);
  });
}
