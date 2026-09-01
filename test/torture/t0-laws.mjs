/**
 * t0 -- metamorphic bake/read laws over an IN-ENVELOPE seeded corpus.
 *
 * The corpus stays inside the currently-correct envelope (in-range integers per
 * the documented U8/U16/U32/I8/I16/I32 ranges, fround-exact floats, an explicit
 * F64 override column), so every value round-trips EXACTLY at B0. The known bugs
 * (wrapping, F32 drift, NaN/-0 destruction) live in the t1/t5 todos, not here.
 *
 * This tier is not measured by lite-gc-profiler, so it may allocate freely
 * (records, oracles, sort scratch). Only t6 runs under a zero-alloc window.
 *
 * Laws:
 *   1. determinism        -- bake twice -> byte-identical buffer, same schema order
 *   2. row oracle         -- row(i) deep-equals the plain-record oracle for every i
 *   3. get vs raw pattern -- get(i, f) === the caller-side typed-array pattern
 *   4. field-order         -- read-by-name is invariant to key insertion order;
 *                            byte-identity holds when field sizes are distinct
 *   5. offset agreement   -- offsetXxx(f) * size === offsetBytes(f) for every field
 */

import { bake, Reader, Types } from '../../src/index.js';
import { makePrng, SEED, check } from './harness.mjs';

const N = 400;

// Six fields, all four lane widths: U8 (1), U16/I16 (2), U32/F32 (4), F64 (8).
// Value generators pin each inferred type by construction (min/max bounds),
// so the corpus is deterministic regardless of PRNG luck.
function buildCorpus(prng) {
  const recs = new Array(N);
  for (let i = 0; i < N; i++) {
    recs[i] = {
      wa: prng() % 256,                       // U8:  0..255
      wb: 256 + (prng() % 1000),              // U16: 256..1255 (min > 255)
      wc: 65536 + (prng() % 1000000),         // U32: >= 65536
      wd: (prng() % 200) - 100 + 0.5,         // F32: always x.5 (non-int, fround-exact)
      we: (prng() % 100000) * 0.25,           // F64 (override): exact quarter-integer
      wf: -129 - (prng() % 1000),             // I16: -1128..-129 (< -128, negative)
    };
  }
  return recs;
}

const SCHEMA = { we: Types.F64 };

// The caller-side raw typed-array pattern for one field, by lane kind.
function rawRead(r, i, f) {
  switch (f.type) {
    case Types.F64: return r.f64[i * r.strideF64 + r.offsetF64(f.name)];
    case Types.F32: return r.f32[i * r.strideF32 + r.offsetF32(f.name)];
    case Types.U32: return r.u32[i * r.strideU32 + r.offsetU32(f.name)];
    case Types.I32: return r.i32[i * r.strideU32 + r.offsetI32(f.name)];
    case Types.U16: return r.u16[i * r.strideU16 + r.offsetU16(f.name)];
    case Types.I16: return r.i16[i * r.strideU16 + r.offsetI16(f.name)];
    case Types.U8:  return r.u8[i * r.stride + r.offsetU8(f.name)];
    case Types.I8:  return r.i8[i * r.stride + r.offsetI8(f.name)];
  }
  return undefined;
}

// offsetXxx(name) * size === offsetBytes(name), by lane kind.
function offsetElem(r, f) {
  switch (f.type) {
    case Types.F64: return r.offsetF64(f.name) * 8;
    case Types.F32: return r.offsetF32(f.name) * 4;
    case Types.U32: return r.offsetU32(f.name) * 4;
    case Types.I32: return r.offsetI32(f.name) * 4;
    case Types.U16: return r.offsetU16(f.name) * 2;
    case Types.I16: return r.offsetI16(f.name) * 2;
    case Types.U8:  return r.offsetU8(f.name);
    case Types.I8:  return r.offsetI8(f.name);
  }
  return -1;
}

export function run() {
  const prng = makePrng(SEED);
  const recs = buildCorpus(prng);

  // --- Law 1: determinism -- bake twice, byte-identical buffer + schema order.
  const b1 = bake(recs, { schema: SCHEMA });
  const b2 = bake(recs, { schema: SCHEMA });
  check(b1.buffer.byteLength === b2.buffer.byteLength,
    () => `t0.determinism: buffer length ${b1.buffer.byteLength} != ${b2.buffer.byteLength} (seed=${SEED})`);
  const u1 = new Uint8Array(b1.buffer);
  const u2 = new Uint8Array(b2.buffer);
  for (let k = 0; k < u1.length; k++) {
    check(u1[k] === u2[k],
      () => `t0.determinism: byte ${k} diverged ${u1[k]} != ${u2[k]} (seed=${SEED})`);
  }
  check(b1.schema.length === b2.schema.length,
    () => `t0.determinism: schema length ${b1.schema.length} != ${b2.schema.length} (seed=${SEED})`);
  for (let k = 0; k < b1.schema.length; k++) {
    check(b1.schema[k].name === b2.schema[k].name && b1.schema[k].type === b2.schema[k].type &&
          b1.schema[k].offset === b2.schema[k].offset,
      () => `t0.determinism: schema entry ${k} diverged (seed=${SEED})`);
  }

  const r = new Reader(b1);

  // --- Law 2 + Law 3: row oracle deep-equality and get vs raw pattern.
  for (let i = 0; i < N; i++) {
    const rec = recs[i];
    const rowObj = r.row(i);
    for (let k = 0; k < b1.schema.length; k++) {
      const f = b1.schema[k];
      const expect = rec[f.name];
      // Law 2: row(i) round-trips the in-envelope value exactly.
      check(rowObj[f.name] === expect,
        () => `t0.row: field '${f.name}' row ${i} got ${rowObj[f.name]} expected ${expect} (seed=${SEED})`);
      // Law 3: get() equals the documented caller-side raw typed-array read.
      const got = r.get(i, f.name);
      const raw = rawRead(r, i, f);
      check(got === raw,
        () => `t0.get-vs-raw: field '${f.name}' row ${i} get ${got} != raw ${raw} (seed=${SEED})`);
      check(got === expect,
        () => `t0.get: field '${f.name}' row ${i} got ${got} expected ${expect} (seed=${SEED})`);
    }
  }

  // --- Law 4a: read-by-name is invariant to key insertion order.
  // Build the same records with REVERSED key insertion order; every get() by
  // name must still return the oracle value even though the byte layout among
  // equal-size fields may differ (bake sorts by size with a stable tie-break).
  const revRecs = new Array(N);
  for (let i = 0; i < N; i++) {
    const rec = recs[i];
    revRecs[i] = { wf: rec.wf, we: rec.we, wd: rec.wd, wc: rec.wc, wb: rec.wb, wa: rec.wa };
  }
  const rRev = new Reader(bake(revRecs, { schema: SCHEMA }));
  for (let i = 0; i < N; i++) {
    const rec = recs[i];
    for (const name of ['wa', 'wb', 'wc', 'wd', 'we', 'wf']) {
      check(rRev.get(i, name) === rec[name],
        () => `t0.field-order: reversed-key '${name}' row ${i} got ${rRev.get(i, name)} expected ${rec[name]} (seed=${SEED})`);
    }
  }

  // --- Law 4b: byte-identity under key reorder holds when sizes are DISTINCT.
  // With one field per lane width the sort order is fully determined by size, so
  // insertion order cannot change offsets -- the buffers are byte-identical.
  const dRecs = new Array(64);
  const dRev = new Array(64);
  for (let i = 0; i < 64; i++) {
    const p = { s8: prng() % 256, s16: 256 + (prng() % 1000), s32: 65536 + (prng() % 100000), s64: (prng() % 1000) * 0.5 };
    dRecs[i] = { s8: p.s8, s16: p.s16, s32: p.s32, s64: p.s64 };
    dRev[i] = { s64: p.s64, s32: p.s32, s16: p.s16, s8: p.s8 };
  }
  const dSchema = { s64: Types.F64 };
  const db1 = bake(dRecs, { schema: dSchema });
  const db2 = bake(dRev, { schema: dSchema });
  check(db1.buffer.byteLength === db2.buffer.byteLength,
    () => `t0.field-order: distinct-size buffers differ in length (seed=${SEED})`);
  const d1 = new Uint8Array(db1.buffer);
  const d2 = new Uint8Array(db2.buffer);
  for (let k = 0; k < d1.length; k++) {
    check(d1[k] === d2[k],
      () => `t0.field-order: distinct-size byte ${k} diverged under key reorder (seed=${SEED})`);
  }

  // --- Law 5: offsetXxx(f) * size === offsetBytes(f) for every field.
  for (let k = 0; k < b1.schema.length; k++) {
    const f = b1.schema[k];
    const elemBytes = offsetElem(r, f);
    check(elemBytes === r.offsetBytes(f.name),
      () => `t0.offset: field '${f.name}' offsetXxx*size ${elemBytes} != offsetBytes ${r.offsetBytes(f.name)} (seed=${SEED})`);
  }
}
