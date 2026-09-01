/**
 * t5 -- differential fuzz vs the decisions/0001 value-policy oracle. LIVE (B1).
 *
 * A seeded generator emits per-iteration corpora mixing every B1 value class:
 * in-envelope finite numbers, the float sentinels (NaN / -0 / +/-Infinity), and
 * the non-number classes (string, numeric-string, boolean, null, undefined,
 * plain object, array), plus per-record structural drift (absent key, extra
 * key). Each corpus is baked under all three modes -- default, validate:true,
 * coerce:'zero'.
 *
 * The oracle is a hand-written function that applies the 0001 table by
 * inspecting the actual corpus: it returns {throws:'<code>'} (first offender
 * row-major: record order, then keyset order for a missing field, enumeration
 * order for an extra/value) or the expected per-cell values (Math.fround for F32
 * lanes, exact for F64, the CURRENT mask for int lanes -- B1 leaves BK-01/02).
 * A fixed schema override pins the lane types so inference (B3's subject) never
 * enters the comparison.
 *
 * BREAK lane: under BAKE_TORTURE_BREAK the oracle deliberately misapplies the
 * non-number class in the strict modes (expects a stored 0 where bake refuses),
 * so a canary corpus forces a divergence and the tier dies -- proving t5 can
 * fail. BK-04 is closed here too (its old todo is deleted) with an explicit
 * enforced check.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { makePrng, SEED, check, die, BREAK } from './harness.mjs';

// Fixed lanes, distinct byte sizes so the write-loop's size-descending sort
// equals insertion == enumeration order. Covers F64, F32, a signed int, an
// unsigned int.
const FIELDS = [
  { name: 'fb', type: Types.F64 },  // 8
  { name: 'fa', type: Types.F32 },  // 4
  { name: 'ic', type: Types.I16 },  // 2
  { name: 'ib', type: Types.U8 },   // 1
];
const FIELD_NAMES = ['fb', 'fa', 'ic', 'ib'];
const SCHEMA = { fb: Types.F64, fa: Types.F32, ic: Types.I16, ib: Types.U8 };

const KEYSET = Object.create(null);
for (let i = 0; i < FIELD_NAMES.length; i++) KEYSET[FIELD_NAMES[i]] = true;

// What the lane stores for a number v -- exactly what Reader.get reads back.
function laneStore(type, v) {
  switch (type) {
    case Types.F64: return v;
    case Types.F32: return Math.fround(v);
    case Types.I16: { const t = v | 0; return (t << 16) >> 16; }
    case Types.U8:  return v & 0xff;
  }
  return v;
}

function optsFor(mode) {
  if (mode === 'validate') return { schema: SCHEMA, validate: true };
  if (mode === 'coerce')   return { schema: SCHEMA, coerce: 'zero' };
  return { schema: SCHEMA };
}

// In-envelope finite value for a lane.
function genNumber(prng, type) {
  switch (type) {
    case Types.F64: return ((prng() % 2000000) - 1000000) * 0.0001;
    case Types.F32: return Math.fround(((prng() % 2000) - 1000) * 0.25);
    case Types.I16: return ((prng() % 65536) - 32768);
    case Types.U8:  return prng() % 256;
  }
  return 0;
}

const NON_NUMBERS = ['x', '42.5', true, false, null, undefined, {}, [7]];

// One cell value across all classes.
function pickValue(prng, type) {
  const r = prng() % 10;
  if (r < 5) return genNumber(prng, type);
  if (r === 5) return NaN;
  if (r === 6) return -0;
  if (r === 7) return (prng() % 2) ? Infinity : -Infinity;
  return NON_NUMBERS[prng() % NON_NUMBERS.length];
}

// Record 0 is always valid canonical. Later records may drop a field (absent)
// or gain an extra key, and carry any value class.
function genRecord(prng, isFirst) {
  const rec = {};
  const dropField = (!isFirst && (prng() % 5) === 0)
    ? FIELD_NAMES[prng() % FIELD_NAMES.length] : null;
  for (let i = 0; i < FIELDS.length; i++) {
    const f = FIELDS[i];
    if (f.name === dropField) continue;
    rec[f.name] = isFirst ? genNumber(prng, f.type) : pickValue(prng, f.type);
  }
  if (!isFirst && (prng() % 6) === 0) rec['zz' + (prng() % 3)] = prng() % 100;
  return rec;
}

function genCorpus(prng) {
  const n = 2 + (prng() % 4);   // 2..5 records
  const recs = new Array(n);
  for (let i = 0; i < n; i++) recs[i] = genRecord(prng, i === 0);
  return recs;
}

// The oracle. strict = default/validate; breakOn disables ONLY the value-door
// non-number check (the deliberate BREAK misapplication).
function oracle(records, strict, breakOn) {
  if (strict) {
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      for (const k in rec) {
        if (!(k in KEYSET)) return { throws: 'E_UNEXPECTED_FIELD' };
      }
      for (let j = 0; j < FIELD_NAMES.length; j++) {
        if (!(FIELD_NAMES[j] in rec)) return { throws: 'E_MISSING_FIELD' };
      }
      if (!breakOn) {
        for (let j = 0; j < FIELDS.length; j++) {
          if (typeof rec[FIELDS[j].name] !== 'number') return { throws: 'E_NON_NUMERIC' };
        }
      }
    }
  }
  const values = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const row = {};
    for (let j = 0; j < FIELDS.length; j++) {
      const f = FIELDS[j];
      let v = rec[f.name];
      if (typeof v !== 'number') v = 0;
      row[f.name] = laneStore(f.type, v);
    }
    values[i] = row;
  }
  return { values };
}

function fail(iter, mode, recIdx, field, detail) {
  return 't5.fuzz [' + mode + '] iter=' + iter + ' record=' + recIdx + " field='" + field +
    "': " + detail + ' (seed=' + SEED + ')\n' +
    '  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs';
}

function compareCorpus(iter, mode, records) {
  const strict = mode !== 'coerce';
  const breakOn = BREAK && strict;
  const exp = oracle(records, strict, breakOn);

  let baked = null, err = null;
  try { baked = bake(records, optsFor(mode)); } catch (e) { err = e; }

  if (exp.throws) {
    check(!!err, () => fail(iter, mode, -1, '-',
      'expected throw ' + exp.throws + ' but bake succeeded'));
    check(err.code === exp.throws, () => fail(iter, mode, -1, '-',
      'expected ' + exp.throws + ' got ' + err.code));
    return;
  }

  check(!err, () => fail(iter, mode, -1, '-',
    'unexpected throw ' + (err && err.code) + ' (' + (err && err.message) + ')'));

  const r = new Reader(baked);
  for (let i = 0; i < records.length; i++) {
    for (let j = 0; j < FIELDS.length; j++) {
      const f = FIELDS[j];
      const got = r.get(i, f.name);
      const want = exp.values[i][f.name];
      check(Object.is(got, want), () => fail(iter, mode, i, f.name,
        'got ' + String(got) + ' want ' + String(want)));
    }
  }
}

function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

const MODES = ['default', 'validate', 'coerce'];
const ITERS = 300;

export function run() {
  // BK-04 CLOSED (B1): {v:true} refuses by default; coerce stores 0, never 1.
  const e04 = caught(() => bake([{ v: true }]));
  check(!!e04 && e04.code === 'E_NON_NUMERIC',
    () => 't5.BK-04: {v:true} not refused by default (code=' + (e04 && e04.code) + ')');
  const r04 = new Reader(bake([{ v: true }], { coerce: 'zero' }));
  check(r04.get(0, 'v') === 0,
    () => 't5.BK-04: coerce:zero stored ' + r04.get(0, 'v') + ' for true, expected 0 (not 1)');

  // Canary: a non-number in a strict mode. Normal run matches (E_NON_NUMERIC);
  // under BREAK the oracle misapplies and this diverges -> die (trips first).
  const canary = [
    { fb: 1.5, fa: Math.fround(0.25), ic: 100, ib: 7 },
    { fb: 2.5, fa: Math.fround(0.5), ic: 50, ib: true },
  ];
  compareCorpus(-1, 'default', canary);

  // Seeded differential fuzz -- its own SEED-derived stream.
  const prng = makePrng((SEED ^ 0x517cc1b7) >>> 0);
  for (let iter = 0; iter < ITERS; iter++) {
    const corpus = genCorpus(prng);
    for (let m = 0; m < MODES.length; m++) compareCorpus(iter, MODES[m], corpus);
  }
}
