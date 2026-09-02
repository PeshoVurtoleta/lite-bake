/**
 * @zakkster/lite-bake -- torture harness.
 *
 * The shared spine every tier imports from. Four disciplines are enforced here
 * in one place so no tier can drift from them:
 *
 *   1. SCRATCH ONCE. All scratch is allocated by the tier OUTSIDE every loop.
 *      This module hands out helpers and gate wrappers, never per-call
 *      allocations on a measured hot path.
 *   2. FAILURE-ONLY MESSAGES. `check(cond, msgThunk)` builds its string ONLY on
 *      failure -- a template literal per iteration is an allocation and would
 *      fail the t6 gate. Pass a thunk, never a pre-built string.
 *   3. SEEDED REPLAY. The PRNG is a seeded xorshift32 (`TORTURE_SEED` env with a
 *      0-guard to 1). Every failing message carries the seed so a case replays
 *      via `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
 *   4. ONE MEASUREMENT WINDOW AT A TIME. lite-gc-profiler shares one heap across
 *      lanes; `runOpsGate` opens and closes a single window per call and tiers
 *      run strictly sequentially -- never nested, never concurrent.
 *
 * RULES is the base zero-GC budget. `maxArrayBuffersGrowth` gates net growth of
 * ArrayBuffer backing stores, which live OUTSIDE the V8 heap and are invisible
 * to a heapUsed gate -- exactly the memory this package uses (one buffer + eight
 * typed views). It requires measureOps `stabilize:'deep'`, which `runOpsGate`
 * supplies. A budget that moves is not a gate: RULES never widens to pass.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
  const raw = process.env.TORTURE_SEED;
  if (raw === undefined) return 0x9e3779b9;
  const n = Number(raw) >>> 0;
  return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into the t6 hot loop. */
export const BREAK = process.env.BAKE_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Field byte sizes indexed by the Types enum in Bake.js:
 *   F32=0, F64=1, I32=2, I16=3, I8=4, U32=5, U16=6, U8=7
 * Duplicated locally on purpose so the harness imports nothing from src on this
 * path. B4's t8 cross tier will drift-guard this table against the source.
 */
const BYTES = [4, 8, 4, 2, 1, 4, 2, 1];

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
  let x = (seed >>> 0) || 1;
  return function next() {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x >>> 0;
  };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
  process.stderr.write('torture: FAIL -- ' + msg + '\n');
  process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
  if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so the `maxArrayBuffersGrowth` rule
 * is resolvable (ArrayBuffer backing stores live outside the V8 heap). Returns
 * the checkNoGc report plus the raw summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
  const res = measureOps(fn, {
    ops: opts.ops,
    warmup: opts.warmup === undefined ? 0 : opts.warmup,
    stabilize: 'deep',
  });
  return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/**
 * Layout-coherence checker. Returns a STRING describing the first violated
 * layout law, or null if the baked object is coherent. Written as a plain
 * evidence-returning function so t2 can check() its result on every generated
 * schema AND t9 can call it directly on hand-fabricated broken objects
 * (polarity inversion: a valid object must return null, a corrupt one must not).
 *
 * The invariants (every one is the package's own documented layout contract):
 *   - schema is an array
 *   - every field has a defined BYTES-size, an aligned offset (offset % size),
 *     and fits inside the stride (offset + size <= stride)
 *   - no two fields share a name; no two fields overlap in the row
 *   - stride is a positive integer that is a multiple of the max field alignment
 *   - buffer.byteLength is a multiple of 8, is at least stride * count, and its
 *     tail slack (byteLength - stride*count) is under 8 bytes
 */
export function checkLayout(baked) {
  if (!baked || typeof baked !== 'object') return 'baked is not an object';
  const schema = baked.schema;
  if (!Array.isArray(schema)) return 'schema is not an array';

  const stride = baked.stride;
  if (!Number.isInteger(stride) || stride <= 0) {
    return 'stride is not a positive integer: ' + stride;
  }
  const count = baked.count;
  if (!Number.isInteger(count) || count < 0) {
    return 'count is not a non-negative integer: ' + count;
  }
  const buffer = baked.buffer;
  if (!buffer || typeof buffer.byteLength !== 'number') {
    return 'buffer is missing or has no byteLength';
  }

  let maxAlign = 1;
  const seenNames = Object.create(null);
  for (let i = 0; i < schema.length; i++) {
    const f = schema[i];
    if (!f || typeof f.name !== 'string') return 'field ' + i + ' has no name';
    if (seenNames[f.name]) return "duplicate field name '" + f.name + "'";
    seenNames[f.name] = true;
    const size = BYTES[f.type];
    if (size === undefined) return "field '" + f.name + "' has unknown type " + f.type;
    if (!Number.isInteger(f.offset) || f.offset < 0) {
      return "field '" + f.name + "' offset is not a non-negative integer: " + f.offset;
    }
    if (f.offset % size !== 0) {
      return "field '" + f.name + "' offset " + f.offset + ' not aligned to size ' + size;
    }
    if (f.offset + size > stride) {
      return "field '" + f.name + "' offset+size " + (f.offset + size) + ' exceeds stride ' + stride;
    }
    if (size > maxAlign) maxAlign = size;
  }

  // Overlap check over fields sorted by offset (a fresh sort array is allowed
  // here: checkLayout is a cold-path evidence function, never a hot body).
  const sorted = schema.slice().sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    const prevEnd = prev.offset + BYTES[prev.type];
    if (prevEnd > cur.offset) {
      return "fields '" + prev.name + "' and '" + cur.name + "' overlap at offset " + cur.offset;
    }
  }

  if (stride % maxAlign !== 0) {
    return 'stride ' + stride + ' not a multiple of max alignment ' + maxAlign;
  }
  if (buffer.byteLength % 8 !== 0) {
    return 'buffer.byteLength ' + buffer.byteLength + ' not a multiple of 8';
  }
  const need = stride * count;
  if (buffer.byteLength < need) {
    return 'buffer.byteLength ' + buffer.byteLength + ' < stride*count ' + need;
  }
  if (buffer.byteLength - need >= 8) {
    return 'buffer tail slack ' + (buffer.byteLength - need) + ' >= 8 bytes';
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 * Todo registry.
 *
 * The suite has no fix mechanism of its own (LiteBvh has none either). This
 * package shipped thirteen reproduced defects (BK-01..BK-13) whose fixes landed
 * across B1..B3; as of B3 all thirteen are promoted to enforced checks and the
 * registry is DORMANT (no tier registers a todo anymore). The mechanism stays
 * wired for future findings: a `todo` runs the probe body it was found with and
 * must STILL reproduce the defect. While it reproduces, the gate stays neutral
 * (no stdout, "ok" is preserved). The day a probe stops reproducing, the todo
 * fails the whole run and demands its promotion to an enforced check.
 *
 * Reproduced-detection rule (documented so no future session weakens it):
 *   - probeFn MUST return a BOOLEAN.
 *   - true  -> defect still reproduces -> gate-neutral.
 *   - false -> defect no longer reproduces -> die() ("promote its todo").
 *   - a THROW out of probeFn is an UNEXPECTED harness fault and PROPAGATES:
 *     torture.mjs's per-tier try/catch surfaces it with the replay seed and
 *     exits 1. This is fail-CLOSED and load-bearing. Several of these fixes
 *     will land as coded throws (E_UNSAFE_INTEGER, E_NON_NUMERIC,
 *     R_ROW_OUT_OF_RANGE); a probe body must catch its OWN expected throw with
 *     the caught() pattern and return false, so a fix-that-throws evaluates to
 *     "not reproduced" and correctly dies. Folding every throw to "reproduced"
 *     here would mask exactly those fixes -- the opposite of what a todo is for.
 * -------------------------------------------------------------------------- */

const TODOS = [];

/**
 * Register + run one known-defect probe.
 * @param {string} id           the finding id (must carry the probe name)
 * @param {() => boolean} probeFn returns true while the defect still reproduces
 */
export function todoReproduced(id, probeFn) {
  TODOS.push(id);
  const reproduced = probeFn();
  if (typeof reproduced !== 'boolean') {
    die(id + ' probe returned a non-boolean (' + typeof reproduced +
      ') -- a todo probe must return true (reproduced) or false (fixed)');
  }
  if (!reproduced) {
    die(id + ' no longer reproduces -- promote its todo to an enforced check and flip the finding');
  }
}

/** A copy of every registered todo id, so t9 can assert the full set. */
export function todoIds() {
  return TODOS.slice();
}
