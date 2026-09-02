/**
 * Micro-benchmark: JSON object access vs baked binary access.
 *
 * Run with: `node benchmark/bench.js`
 *
 * IMPORTANT -- READ THIS BEFORE CITING NUMBERS:
 *
 * V8's JIT is *extremely* good at monomorphic object access. When every
 * record has the same hidden class and the dataset fits in L2, object
 * field access can match or BEAT typed-array indexing in a tight loop.
 * That's not a lite-bake bug; that's JIT engineering working as intended.
 *
 * The reliable wins of lite-bake are:
 *   - Memory footprint: consistently ~4× smaller (run this bench to confirm)
 *   - Performance consistency: baked throughput is low-variance across runs;
 *     object throughput swings wildly depending on JIT state
 *   - Zero GC pressure: no small-object churn from ongoing `.parse()` loads
 *   - Binary ready: `baked.buffer` uploads directly to GPU / writes to disk
 *
 * This harness does 5 trials and reports median + spread so you can see the
 * JIT variance for yourself.
 */

// Post-1.2.0 inference widens arbitrary doubles to F64, so the bench pins x/y to
// F32 explicitly (positions tolerate quantization) to keep the layout and claims
// comparable with earlier runs.
import { performance } from 'node:perf_hooks';
import { bake, Reader, Types } from '../Bake.js';

const BENCH_SCHEMA = { x: Types.F32, y: Types.F32 };

const N = 50_000;
const LOOPS = 100;
const TRIALS = 5;
const WARMUP = 3;

function makeRecords() {
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = {
      x: Math.random() * 4000,
      y: Math.random() * 4000,
      type: i % 16,
      hp: 50 + (i % 50),
    };
  }
  return out;
}

function format(n) {
  if (n > 1_000_000) return (n / 1_000_000).toFixed(2) + ' Mop/s';
  if (n > 1_000)     return (n / 1_000).toFixed(2) + ' Kop/s';
  return n.toFixed(0) + ' op/s';
}

function bytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
  if (n > 1024)        return (n / 1024).toFixed(2) + ' KB';
  return n + ' B';
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return {
    min:    sorted[0],
    median: sorted[Math.floor(sorted.length / 2)],
    max:    sorted[sorted.length - 1],
  };
}

console.log(`\nlite-bake benchmark: ${N.toLocaleString()} records, ${LOOPS} loop passes × ${TRIALS} trials\n`);

// --- Build data and bake once ----------------------------------------------

const records = makeRecords();
const baked = bake(records, { schema: BENCH_SCHEMA });
const approxObjBytes = N * (16 + 4 * 8);

// --- Init cost (single measurement; init is not in the per-frame path) -----

const t0Parse = performance.now();
const parsed = JSON.parse(JSON.stringify(records));
const parseMs = performance.now() - t0Parse;

const t0Bake = performance.now();
bake(records, { schema: BENCH_SCHEMA });
const bakeMs = performance.now() - t0Bake;

console.log('INIT COST (one-time, at level load)');
console.log(`  JSON.parse:  ${parseMs.toFixed(2)} ms`);
console.log(`  bake():      ${bakeMs.toFixed(2)} ms`);
console.log();

console.log('MEMORY FOOTPRINT');
console.log(`  JS object graph (approx):  ${bytes(approxObjBytes)}`);
console.log(`  Baked ArrayBuffer:         ${bytes(baked.buffer.byteLength)}`);
console.log(`  Ratio:                     ${(approxObjBytes / baked.buffer.byteLength).toFixed(1)}× smaller`);
console.log();

// --- Hot-loop: multiple trials ---------------------------------------------

function objTrial() {
  let sum = 0;
  for (let loop = 0; loop < LOOPS; loop++) {
    for (let i = 0; i < parsed.length; i++) {
      const r = parsed[i];
      sum += r.x + r.y + r.type + r.hp;
    }
  }
  return sum;
}

const r = new Reader(baked);
const f32 = r.f32, u8 = r.u8;
const s32 = r.strideF32, sB = r.stride;
const OX = r.offsetF32('x');
const OY = r.offsetF32('y');
const OT = r.offsetU8('type');
const OH = r.offsetU8('hp');

function bakedTrial() {
  let sum = 0;
  for (let loop = 0; loop < LOOPS; loop++) {
    for (let i = 0; i < r.count; i++) {
      const b32 = i * s32, bB = i * sB;
      sum += f32[b32 + OX] + f32[b32 + OY] + u8[bB + OT] + u8[bB + OH];
    }
  }
  return sum;
}

// Warmup both paths so JIT stabilises.
for (let w = 0; w < WARMUP; w++) { objTrial(); bakedTrial(); }

const objTimes = [], bakedTimes = [];
let lastObjSum = 0, lastBakedSum = 0;
for (let t = 0; t < TRIALS; t++) {
  let s = performance.now(); lastObjSum   = objTrial();   objTimes.push(performance.now() - s);
  s     = performance.now(); lastBakedSum = bakedTrial(); bakedTimes.push(performance.now() - s);
}

const totalOps = LOOPS * N;
const obj = stats(objTimes);
const bkd = stats(bakedTimes);

console.log('HOT-LOOP THROUGHPUT -- 5 trials, median (min-max)');
console.log(`  Object access: median ${obj.median.toFixed(2)} ms   (${format(totalOps / (obj.median / 1000))})   range ${obj.min.toFixed(1)}-${obj.max.toFixed(1)} ms`);
console.log(`  Baked access:  median ${bkd.median.toFixed(2)} ms   (${format(totalOps / (bkd.median / 1000))})   range ${bkd.min.toFixed(1)}-${bkd.max.toFixed(1)} ms`);
console.log(`  Median speedup:   ${(obj.median / bkd.median).toFixed(2)}×`);
console.log(`  Object variance:  ${((obj.max - obj.min) / obj.median * 100).toFixed(0)}%`);
console.log(`  Baked variance:   ${((bkd.max - bkd.min) / bkd.median * 100).toFixed(0)}%`);
console.log();

const delta = Math.abs(lastObjSum - lastBakedSum) / lastObjSum;
console.log(`Consistency check: sum delta ${(delta * 100).toFixed(6)}% (should be ~0)`);
console.log('Note: on this workload, V8 object JIT can match or beat baked access.');
console.log('The reliable wins are memory footprint and performance consistency.\n');
