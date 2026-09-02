/**
 * t2 -- layout laws over the schema space (property-based).
 *
 * For 200+ seeded random schemas (1..64 fields, every one of the 8 Types forced
 * via the override map, count 1..17), the baked object must be layout-coherent:
 * checkLayout() returns null. On top of that, the stride shift-arithmetic must be
 * exact for every lane width that appears -- strideF64/F32/U32/U16 are computed as
 * `stride >> 3/2/1`, which equals the byte stride divided by the element size only
 * when the stride is a multiple of that size (guaranteed because stride is padded
 * to the max field alignment).
 *
 * Not measured by lite-gc-profiler; allocation is free here.
 *
 * BK-12 CLOSED (B2): the doc moved, not the code. The false README stride-minimum
 * line is gone and stride equals the max field alignment (an all-U8 three-field
 * bake yields stride 3). Both facts are now enforced checks, not a todo.
 */

import { readFileSync } from 'node:fs';
import { bake, Reader, Types } from '../../Bake.js';
import { makePrng, SEED, check, checkLayout } from './harness.mjs';

const ITERS = 256;
const MAX_FIELDS = 64;
const MAX_COUNT = 17;

// Byte size per Types code (F32=0, F64=1, I32=2, I16=3, I8=4, U32=5, U16=6, U8=7).
const SIZE = [4, 8, 4, 2, 1, 4, 2, 1];

// An in-range value for a forced type, so the write path never masks/wraps.
function valueFor(type, prng) {
  switch (type) {
    case Types.F64: return (prng() % 100000) * 0.25;
    case Types.F32: return (prng() % 200) - 100 + 0.5;
    case Types.I32: return (prng() % 200000) - 100000;
    case Types.I16: return (prng() % 60000) - 30000;
    case Types.I8:  return (prng() % 200) - 100;
    case Types.U32: return prng() % 1000000;
    case Types.U16: return prng() % 60000;
    case Types.U8:  return prng() % 200;
  }
  return 0;
}

export function run() {
  const prng = makePrng(SEED);
  const TYPES = [Types.F32, Types.F64, Types.I32, Types.I16, Types.I8, Types.U32, Types.U16, Types.U8];

  for (let it = 0; it < ITERS; it++) {
    const nFields = 1 + (prng() % MAX_FIELDS);
    const count = 1 + (prng() % MAX_COUNT);

    // Force each field's type via the override map; values in-range for that type.
    const override = {};
    const fieldTypes = new Array(nFields);
    const names = new Array(nFields);
    for (let k = 0; k < nFields; k++) {
      const t = TYPES[prng() % TYPES.length];
      const name = 'f' + k;
      names[k] = name;
      fieldTypes[k] = t;
      override[name] = t;
    }

    const recs = new Array(count);
    for (let i = 0; i < count; i++) {
      const rec = {};
      for (let k = 0; k < nFields; k++) rec[names[k]] = valueFor(fieldTypes[k], prng);
      recs[i] = rec;
    }

    const baked = bake(recs, { schema: override });

    const violation = checkLayout(baked);
    check(violation === null,
      () => `t2.layout: iter ${it} nFields ${nFields} count ${count} violated: ${violation} (seed=${SEED})`);

    // Max field size decides which stride shifts are exact (stride is padded to it).
    let maxSize = 1;
    for (let k = 0; k < baked.schema.length; k++) {
      const s = SIZE[baked.schema[k].type];
      if (s > maxSize) maxSize = s;
    }
    const r = new Reader(baked);
    if (maxSize >= 8) {
      check(r.strideF64 * 8 === baked.stride,
        () => `t2.stride: strideF64 ${r.strideF64} * 8 != stride ${baked.stride} (iter ${it}, seed=${SEED})`);
    }
    if (maxSize >= 4) {
      check(r.strideF32 * 4 === baked.stride,
        () => `t2.stride: strideF32 ${r.strideF32} * 4 != stride ${baked.stride} (iter ${it}, seed=${SEED})`);
      check(r.strideU32 * 4 === baked.stride,
        () => `t2.stride: strideU32 ${r.strideU32} * 4 != stride ${baked.stride} (iter ${it}, seed=${SEED})`);
    }
    if (maxSize >= 2) {
      check(r.strideU16 * 2 === baked.stride,
        () => `t2.stride: strideU16 ${r.strideU16} * 2 != stride ${baked.stride} (iter ${it}, seed=${SEED})`);
    }
  }

  // BK-12 CLOSED (B2): the false README stride-minimum line is gone, and stride
  // equals the max field alignment -- three U8 fields yield stride 3, not 4.
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  check(!readme.includes('padded to 4 (the minimum)'),
    () => 't2.BK-12: the false "padded to 4 (the minimum)" line is still in README.md');
  check(bake([{ a: 1, b: 2, c: 3 }]).stride === 3,
    () => 't2.BK-12: three-U8 record stride ' + bake([{ a: 1, b: 2, c: 3 }]).stride + ' != 3 (max-alignment pin)');
}
