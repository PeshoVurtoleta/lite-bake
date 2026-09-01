/**
 * t7 -- soak + retention witness (lite-leak enters here).
 *
 * `leak_cycles` (4096) cycles of build -> bake -> Reader -> read every cell ->
 * drop. Two independent witnesses run so a leak cannot hide behind either:
 *
 *   - lite-leak tracks a per-cycle resource ({cycle} target, NOOP cleanup,
 *     numeric tag) and untracks it in the same cycle. Neither cleanup nor tag
 *     closes over the target (the held-value contract). tracker.size() must
 *     return to 0.
 *   - a WeakRef census proves bake()'s output graph does NOT retain its input
 *     records array: bake a dedicated array, keep only a WeakRef to it plus the
 *     baked result, null the strong binding, gc + settle, and assert it collected
 *     while the baked object is still alive.
 *
 * The records array (1000 objects) is hoisted and its values mutated each cycle,
 * so the per-cycle churn under test is bake()'s OUTPUT (a fresh buffer + eight
 * views), not the records. Heap is sampled ACROSS cycles, after a settling gc.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { makePrng, SEED, check } from './harness.mjs';

const CYCLES = 4096;
const ROWS = 1000;
const NOOP = function () {};

const SCHEMA = { se: Types.F64 };

// Read one cell via the documented raw typed-array pattern, by lane kind.
function rawRead(r, i, f) {
  switch (f.type) {
    case Types.F64: return r.f64[i * r.strideF64 + r.offsetF64(f.name)];
    case Types.F32: return r.f32[i * r.strideF32 + r.offsetF32(f.name)];
    case Types.U32: return r.u32[i * r.strideU32 + r.offsetU32(f.name)];
    case Types.U16: return r.u16[i * r.strideU16 + r.offsetU16(f.name)];
    case Types.I16: return r.i16[i * r.strideU16 + r.offsetI16(f.name)];
    case Types.U8:  return r.u8[i * r.stride + r.offsetU8(f.name)];
  }
  return 0;
}

export async function run() {
  const prng = makePrng(SEED);
  const tracker = createLeakTracker({ name: 'bake-soak' });
  const sink = new Float64Array(1);

  // Hoisted records array: 1000 objects, refilled (not reallocated) each cycle.
  const recs = new Array(ROWS);
  for (let i = 0; i < ROWS; i++) {
    recs[i] = { sa: 0, sb: 0, sc: 0, sd: 0, se: 0, sf: 0 };
  }

  // --- WeakRef census: bake must not retain its input records array -----------
  let dedicated = new Array(64);
  for (let i = 0; i < 64; i++) {
    dedicated[i] = { sa: i & 0xff, sb: 256 + i, sc: 65536 + i, sd: i + 0.5, se: i * 0.25, sf: -129 - i };
  }
  const census = bake(dedicated, { schema: SCHEMA }); // kept alive across the check
  const ref = new WeakRef(dedicated);
  dedicated = null; // drop the only strong ref; the baked graph must not hold it

  // A WeakRef keeps its target live for the whole current Job, so gc() must run
  // AFTER an await crosses a Job boundary or it cannot collect the array. Settle
  // across the boundary first, then force a full collection, then read.
  await new Promise((r) => setTimeout(r, 50));
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 20));
  globalThis.gc();
  check(ref.deref() === undefined,
    () => `t7: bake retained its input records array (seed=${SEED})`);
  check(census.count === 64, () => `t7: census baked count ${census.count} != 64 (seed=${SEED})`);

  // Sample heap at a cycle boundary, after settling, so intra-cycle churn is
  // never misread as growth.
  globalThis.gc();
  const heapBefore = process.memoryUsage().heapUsed;

  for (let c = 0; c < CYCLES; c++) {
    // Mutate the hoisted records in place -- in-envelope values.
    for (let i = 0; i < ROWS; i++) {
      const rec = recs[i];
      rec.sa = prng() % 256;
      rec.sb = 256 + (prng() % 1000);
      rec.sc = 65536 + (prng() % 1000000);
      rec.sd = (prng() % 200) - 100 + 0.5;
      rec.se = (prng() % 100000) * 0.25;
      rec.sf = -129 - (prng() % 1000);
    }

    const baked = bake(recs, { schema: SCHEMA });
    const r = new Reader(baked);

    // Read every cell via the raw pattern.
    for (let k = 0; k < r.count; k++) {
      for (let fi = 0; fi < baked.schema.length; fi++) {
        sink[0] += rawRead(r, k, baked.schema[fi]);
      }
    }

    // A tracked external resource modelling a per-cycle allocation. Neither the
    // cleanup (NOOP) nor the tag (the number c) closes over the target.
    const h = tracker.track({ cycle: c }, NOOP, c);
    tracker.untrack(h);
  }

  check(tracker.size() === 0, () => `t7: lite-leak tracker leaked ${tracker.size()} resources (seed=${SEED})`);

  globalThis.gc();
  await new Promise((r) => setTimeout(r, 50));
  const heapAfter = process.memoryUsage().heapUsed;
  const grewKB = (heapAfter - heapBefore) / 1024;
  check(grewKB < 512, () => `t7: heap grew ${grewKB.toFixed(1)} KB over ${CYCLES} cycles (seed=${SEED})`);
}
