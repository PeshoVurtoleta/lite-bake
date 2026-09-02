/**
 * t6 -- the zero-alloc gate.
 *
 * The package's whole promise is that the caller-side hot loop -- raw typed-array
 * indexing with cached offsets and strides -- allocates nothing. This tier gates
 * that at maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0 (stabilize:'deep',
 * via runOpsGate). The last rule is the one that bites: the baked ArrayBuffer and
 * its eight typed views live OUTSIDE the V8 heap, invisible to a heapUsed gate.
 *
 * Container: 131072 records x 8 fields (two each of F64/F32/U32/U16) = ~1M cells,
 * a power-of-two row count so the hot body masks its index with `& MASK` and
 * never branches. Everything the hot body touches -- the typed views, the four
 * cached element offsets, the four strides, the mask, and a Float64Array(1) sink
 * that defeats dead-code elimination -- is hoisted before the window.
 *
 * Three gates, three separate windows (one measurement at a time):
 *   Gate 1: the canonical hot read loop -- must be zero-alloc.
 *   Gate 2: the offsetXxx init-tier accessors -- measured under the SAME RULES;
 *           they do throw-free lookups and should pass at zero major.
 *   Gate 3: bake()'s cold path -- bake legitimately allocates its output, so it
 *           CANNOT run under maxArrayBuffersGrowth:0; instead a plain re-bake loop
 *           with a gc'd before/after arrayBuffers delta proves no cross-call
 *           retention (see the comment on that gate).
 *
 * BAKE_TORTURE_BREAK=1 injects a retained allocation into this hot body so the
 * gate rejects the window. Under a normal top-to-bottom run t5's oracle-misapply
 * canary now dies before this tier is reached, so this injection is not what
 * trips first; it stays live as t9's Control 1 exercises the same alloc lane
 * in-process, and it guards any future tier reordering.
 */

import { bake, Reader, Types } from '../../Bake.js';
import { runOpsGate, BREAK, check, die } from './harness.mjs';

const COUNT = 131072;          // 2^17 rows
const MASK = COUNT - 1;
const OPS = 60000;
const WARMUP = 2000;

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

// Hoisted so the hot body closes over primitives/views, never allocates.
const sink = new Float64Array(1);

export async function run() {
  // Build the ~1M-cell container once. Two fields per lane width, forced by the
  // override map so the layout is fixed regardless of the values.
  const schema = {
    a: Types.F64, b: Types.F64,
    c: Types.F32, d: Types.F32,
    e: Types.U32, f: Types.U32,
    g: Types.U16, h: Types.U16,
  };
  const recs = new Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    recs[i] = {
      a: i * 0.5, b: (i & 1023) * 0.25,
      c: (i & 255) + 0.5, d: (i & 63) - 32 + 0.5,
      e: i & 0xffffff, f: (i * 7) & 0xffff,
      g: i & 0xffff, h: (i * 3) & 0xffff,
    };
  }
  const baked = bake(recs, { schema });
  const r = new Reader(baked);

  // Cache everything the hot body reads -- one value from each lane width.
  const f64 = r.f64, f32 = r.f32, u32 = r.u32, u16 = r.u16;
  const sF64 = r.strideF64, sF32 = r.strideF32, sU32 = r.strideU32, sU16 = r.strideU16;
  const offF64 = r.offsetF64('a');
  const offF32 = r.offsetF32('c');
  const offU32 = r.offsetU32('e');
  const offU16 = r.offsetU16('g');

  const hot = (i) => {
    const idx = i & MASK;
    const vf64 = f64[idx * sF64 + offF64];
    const vf32 = f32[idx * sF32 + offF32];
    const vu32 = u32[idx * sU32 + offU32];
    const vu16 = u16[idx * sU16 + offU16];
    sink[0] += vf64 + vf32 + vu32 + vu16;
    if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
  };

  // Sample the identity-stable structural facts a heap gate cannot check.
  const refF64 = r.f64, refF32 = r.f32, refI32 = r.i32, refU32 = r.u32;
  const refI16 = r.i16, refU16 = r.u16, refU8 = r.u8, refI8 = r.i8, refDv = r.dv;
  const bufBytesBefore = r.buffer.byteLength;

  // --- Gate 1: the canonical hot read loop -------------------------------------
  const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

  check(r.f64 === refF64 && r.f32 === refF32 && r.i32 === refI32 && r.u32 === refU32 &&
        r.i16 === refI16 && r.u16 === refU16 && r.u8 === refU8 && r.i8 === refI8 && r.dv === refDv,
    () => 'T6: a Reader view (or dv) was reallocated across the hot window');
  check(r.buffer.byteLength === bufBytesBefore,
    () => 'T6: buffer.byteLength grew ' + bufBytesBefore + ' -> ' + r.buffer.byteLength);

  if (!report.ok) {
    const g = summary.gc;
    die('T6 alloc gate rejected -- verdict=' + report.verdict +
        ' source=' + summary.source +
        ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
        (BREAK ? ' (BAKE_TORTURE_BREAK control -- expected)' : ''));
  }

  // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
  // injected allocations slipped through, which is itself a failure.
  if (BREAK) die('T6: BAKE_TORTURE_BREAK injected allocations but the gate passed');

  // --- Gate 2: the offsetXxx init-tier accessors -------------------------------
  // These do a null-proto map lookup + a shift; no get()/row() (documented
  // allocators) are called. Measured under the SAME RULES: they must pass at
  // zero major. If a machine ever trips maxPauseMs here we DROP this gate rather
  // than widen RULES -- but it is expected to pass, so it stays.
  const hot2 = (i) => {
    sink[0] += r.offsetF64('a') + r.offsetF32('c') + r.offsetU32('e') + r.offsetU16('g');
  };
  const g2 = runOpsGate(hot2, { ops: 2000, warmup: 200 });
  if (!g2.report.ok) {
    const g = g2.summary.gc;
    die('T6 offset-accessor gate rejected -- verdict=' + g2.report.verdict +
        ' source=' + g2.summary.source +
        ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
  }

  // --- Gate 3: bake()'s cold path (cross-call retention) -----------------------
  // bake() allocates one ArrayBuffer + a schema per call BY DESIGN, so it cannot
  // run under maxArrayBuffersGrowth:0 -- checkNoGc's all-zero RULES would (rightly)
  // reject legitimate output allocation. The honest question for the cold path is
  // narrower: does bake() RETAIN anything across calls (quadratic churn, a leaked
  // buffer)? Answer it directly: re-bake a small corpus many times, dropping each
  // result, then gc and bound the net arrayBuffers delta. A steady stream of
  // transient buffers collects back to baseline; a retention bug does not.
  // process.memoryUsage().arrayBuffers reconciles external memory lazily: a
  // single gc() frees the backing stores but may not update the counter before
  // it is read. Force settlement with a double gc + a macrotask tick on BOTH
  // samples (symmetry, and it lets the reconciliation run), so a near-zero
  // steady state reads as near-zero. This is not a budget being widened -- the
  // bound stays 1 MB; the settle removes accounting noise, not real growth.
  const small = new Array(64);
  for (let i = 0; i < 64; i++) small[i] = { x: i * 0.5, y: i & 0xff, z: (i * 3) & 0xffff };
  let bakeSink = null; // holds only the latest result, so prior buffers are collectable
  await settleGc();
  const abBefore = process.memoryUsage().arrayBuffers;
  for (let it = 0; it < 4000; it++) {
    bakeSink = bake(small);
  }
  bakeSink = null;
  await settleGc();
  const abAfter = process.memoryUsage().arrayBuffers;
  const grewKB = (abAfter - abBefore) / 1024;
  check(grewKB < 1024,
    () => 'T6: bake() arrayBuffers grew ' + grewKB.toFixed(1) + ' KB across 4000 re-bakes (cross-call retention)');
}

/** Force full GC + external-memory reconciliation before an arrayBuffers read. */
async function settleGc() {
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 20));
  globalThis.gc();
}
