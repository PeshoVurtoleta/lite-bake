/**
 * t9 -- controls. Every gate must be provably able to fail.
 *
 * Each control runs a deliberately-broken variant IN PROCESS and asserts the
 * corresponding gate flags it. If a control slips through, t9 fails the run: a
 * gate that cannot fail is decorative. Where it matters, a control also proves
 * non-vacuity (the checker returns clean on a genuinely valid input, so "flags
 * the broken one" is a real property and not a checker that flags everything).
 *
 * The whole-suite control lives in t6: `BAKE_TORTURE_BREAK=1 node --expose-gc
 * test/torture.mjs` injects a retained allocation into the t6 hot loop, the
 * alloc gate rejects it, and the process exits non-zero; the torture entry then
 * re-checks that BREAK actually tripped. Control 1 below exercises the same alloc
 * lane in-process so a plain `npm run torture` already proves the gate bites.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { runOpsGate, checkLayout, die, todoIds } from './harness.mjs';

const NOOP = function () {};

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

const EXPECTED_TODOS = [
  'BK-01-int-ceiling-wrap',
  'BK-02-f32-precision-loss',
  'BK-03-nan-negzero-destroyed',
  'BK-04-truthy-coercion',
  'BK-05-pooled-buffer-recipe',
  'BK-06-validate-ignores-values',
  'BK-07-schema-override-failopen',
  'BK-08-opts-failopen',
  'BK-09-reader-trusts-baked',
  'BK-10-row-bounds-failopen',
  'BK-11-nonobject-records',
  'BK-12-stride-minimum-claim',
  'BK-13-dropped-and-absent-fields',
];

export function run() {
  // --- Control 1: the alloc gate. A hot body that retains an allocation every
  // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0). ---------
  const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
  if (report.ok) die('t9 control: an allocating hot loop passed the zero-alloc gate');
  leak.length = 0; // release the control's garbage

  // --- Control 2: the layout checker. A valid baked object returns null; three
  // hand-corrupted variants each return a non-null violation string. -----------
  const valid = bake([{ a: 1.5 }, { a: 2.5 }]); // F32, stride 4, count 2, 8-byte buffer
  if (checkLayout(valid) !== null) {
    die('t9 control: checkLayout flagged a valid baked object (checker is broken / vacuous)');
  }
  const overlap = {
    buffer: new ArrayBuffer(8), stride: 2, count: 1,
    schema: [{ name: 'x', type: Types.U8, offset: 0 }, { name: 'y', type: Types.U8, offset: 0 }],
  };
  if (checkLayout(overlap) === null) die('t9 control: checkLayout passed overlapping field offsets');
  const zeroStride = {
    buffer: new ArrayBuffer(8), stride: 0, count: 1,
    schema: [{ name: 'x', type: Types.U8, offset: 0 }],
  };
  if (checkLayout(zeroStride) === null) die('t9 control: checkLayout passed stride 0');
  const badLen = {
    buffer: new ArrayBuffer(6), stride: 2, count: 1,
    schema: [{ name: 'x', type: Types.U16, offset: 0 }],
  };
  if (checkLayout(badLen) === null) die('t9 control: checkLayout passed a byteLength not a multiple of 8');

  // --- Control 3: the t0 get-vs-record oracle. Corrupt ONE byte of a valid
  // buffer inside a known lane and require the same comparison t0 uses detects
  // the divergence; the uncorrupted container must show NO divergence so the
  // control is not vacuous. -----------------------------------------------------
  const oracleRecs = [{ q: 1.5 }, { q: 2.5 }, { q: 3.5 }]; // F32 lane, fround-exact
  const oracleBaked = bake(oracleRecs);
  const cleanReader = new Reader(oracleBaked);
  let cleanDiverges = false;
  for (let i = 0; i < oracleRecs.length; i++) {
    if (cleanReader.get(i, 'q') !== oracleRecs[i].q) { cleanDiverges = true; break; }
  }
  if (cleanDiverges) {
    die('t9 control: the get-vs-record oracle reported divergence on a clean container (vacuous/broken)');
  }
  // Flip one byte inside row 1's F32 lane, then re-run the same comparison.
  const laneOff = cleanReader.offsetBytes('q');
  const rawBytes = new Uint8Array(oracleBaked.buffer);
  rawBytes[1 * oracleBaked.stride + laneOff] ^= 0xff;
  const corruptReader = new Reader(oracleBaked);
  let corruptDiverges = false;
  for (let i = 0; i < oracleRecs.length; i++) {
    if (corruptReader.get(i, 'q') !== oracleRecs[i].q) { corruptDiverges = true; break; }
  }
  if (!corruptDiverges) die('t9 control: the get-vs-record oracle missed a one-byte buffer corruption');

  // --- Control 4: the lite-leak witness. A tracked, still-held target reads
  // size() 1 (the gate sees it); untrack returns it to 0 (non-vacuity). ---------
  const t = createLeakTracker({ name: 't9-control' });
  const held = { x: 1 };
  const h = t.track(held, NOOP, 't9');
  if (t.size() !== 1) die('t9 control: leak tracker did not see a tracked resource (size != 1)');
  t.untrack(h);
  if (t.size() !== 0) die('t9 control: leak tracker did not release on untrack (size != 0)');

  // --- Control 5: the todo registry. By the time t9 runs, every stub/property
  // tier has registered its todos: exactly the thirteen BK-01..BK-13 full names.
  // This mechanically proves "registered todos, IDs in the names". ---------------
  const ids = todoIds();
  if (ids.length !== EXPECTED_TODOS.length) {
    die('t9 control: expected ' + EXPECTED_TODOS.length + ' registered todos, saw ' + ids.length);
  }
  for (const want of EXPECTED_TODOS) {
    if (ids.indexOf(want) === -1) die('t9 control: todo ' + want + ' was never registered');
  }
  for (const saw of ids) {
    if (EXPECTED_TODOS.indexOf(saw) === -1) die('t9 control: unexpected todo registered: ' + saw);
  }
}
