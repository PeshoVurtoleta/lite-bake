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
import { todoReproduced } from './harness.mjs';

function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

export function run() {
  // BK-06: validate:true does not validate values (README says it catches null).
  todoReproduced('BK-06-validate-ignores-values', () => {
    let v0 = null;
    const e1 = caught(() => {
      const r = new Reader(bake([{ v: null }, { v: 2 }], { validate: true }));
      v0 = r.get(0, 'v'); r.get(1, 'v');
    });
    const e2 = caught(() => bake([{ v: 'boom' }, { v: 'x' }], { validate: true }));
    return !e1 && !e2 && v0 === 0;
  });

  // BK-07: schema override fails open on garbage type codes and unknown fields.
  todoReproduced('BK-07-schema-override-failopen', () => {
    let b1 = null, g1;
    const e1 = caught(() => { b1 = bake([{ v: 1.5 }], { schema: { v: 99 } }); g1 = new Reader(b1).get(0, 'v'); });
    let b2 = null;
    const e2 = caught(() => { b2 = bake([{ v: 1.5 }], { schema: { v: 'F64' } }); });
    let b3 = null;
    const e3 = caught(() => { b3 = bake([{ a: 1 }], { schema: { ghost: Types.F32 } }); });
    return !e1 && b1.buffer.byteLength === 0 && g1 === undefined &&
           !e2 && b2.buffer.byteLength === 0 &&
           !e3 && !b3.schema.some((f) => f.name === 'ghost');
  });

  // BK-08: bake() opts fail open -- typo'd keys silently disable features.
  todoReproduced('BK-08-opts-failopen', () => {
    let b = null;
    const e = caught(() => { b = bake([{ v: 1.5 }], { shcema: { v: Types.F64 }, validat: true, strict: true }); });
    return !e && b.schema[0].type === Types.F32;
  });

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

  // BK-11: non-object and empty records bake into silent nonsense.
  todoReproduced('BK-11-nonobject-records', () => {
    let b1 = null, b2 = null, b3 = null;
    const e1 = caught(() => { b1 = bake([1, 2, 3]); });
    const e2 = caught(() => { b2 = bake(['ab', 'cd']); });
    const e3 = caught(() => { b3 = bake([{}, {}]); });
    return !e1 && b1.count === 3 && b1.buffer.byteLength === 0 && b1.schema.length === 0 &&
           !e2 && b2.schema.some((f) => f.name === '0') &&
           !e3 && b3.buffer.byteLength === 0;
  });

  // BK-13: fields beyond record 0 silently dropped; absent fields read 0.
  // The B1 field-set door refuses key drift by default (throws), so both bakes
  // throw after the fix. Catch our own expected throws and return false.
  todoReproduced('BK-13-dropped-and-absent-fields', () => {
    let dropped, absent;
    const eDrop = caught(() => {
      const b1 = bake([{ a: 1 }, { a: 2, b: 99 }]);
      dropped = !b1.schema.some((f) => f.name === 'b');
    });
    const eAbsent = caught(() => {
      const r2 = new Reader(bake([{ a: 1, b: 5 }, { a: 2 }]));
      absent = r2.get(1, 'b');
    });
    return !eDrop && dropped === true && !eAbsent && absent === 0;
  });
}
