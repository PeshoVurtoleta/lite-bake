/**
 * t5 -- differential fuzz vs the decisions/0001 value-policy oracle. LIVE (B1).
 *
 * run() composes five lanes IN THIS ORDER:
 *   runEnforcedChecks() -- the BK-04 enforced checks + the BREAK canary. Under
 *     BAKE_TORTURE_BREAK the fixed-lane oracle misapplies the non-number class in
 *     the strict modes and the canary diverges and dies first (this is what makes
 *     t5 provably able to fail).
 *   runFixedLane()      -- the original 300-iter differential fuzz over a fixed
 *     four-field schema (F64/F32/I16/U8). Its seed derivation and stream
 *     consumption are unchanged, so a pre-B6 TORTURE_SEED replays byte-for-byte.
 *   runHostileNameLane()  -- prototype-named fields (constructor/toString/
 *     hasOwnProperty/valueOf/__proto__) through both the override-present and
 *     override-absent arms.
 *   runShapeLane()        -- non-record splices, empty record 0, empty-record
 *     twins at i>0.
 *   runSchemaCrossLane()  -- random 1..16-field schemas over all eight Types with
 *     explicit overrides and a wide numeric + drift value mix.
 *
 * The three B6 lanes each derive their own PRNG with a distinct documented XOR
 * constant on SEED, and each carries a pure exported oracle with a default-off
 * misapply knob so t9's Controls 10-12 can prove the lane fails. The B6 lanes do
 * NOT read BREAK: under a normal top-to-bottom run the fixed-lane canary trips
 * first, so the B6 lanes never see BREAK in the full harness -- their failability
 * is proven in-process by t9, not by the BREAK path.
 *
 * The oracle is a hand-written function that applies the 0001 table by inspecting
 * the actual corpus: it returns {throws:'<code>'} (first offender row-major:
 * record order, then keyset order for a missing field, enumeration order for an
 * extra/value) or the expected per-cell values (Math.fround for F32 lanes, exact
 * for F64, the CURRENT mask for int lanes). Fixed schema overrides pin lane types
 * so inference (B3's subject) never enters the comparison.
 *
 * Imports stay minimal: { bake, Reader, Types } from src plus harness helpers.
 * LiteBakeError is NEVER imported -- a caught error's code is read as a plain
 * property, so this module still LOADS against a pre-B1 src.
 */

import { bake, Reader, Types } from '../../src/index.js';
import { makePrng, SEED, check, die, BREAK } from './harness.mjs';

// Field byte sizes indexed by the Types enum (F32=0,F64=1,I32=2,I16=3,I8=4,
// U32=5,U16=6,U8=7). Duplicated locally so this module imports nothing but the
// public surface from src.
const BYTES = [4, 8, 4, 2, 1, 4, 2, 1];

// Fit-door bounds indexed by type code, mirroring src. int lanes are codes 2..7;
// a number that is fractional, out of range, or non-finite cannot ride an int
// lane exactly, so src refuses it E_LANE_MISMATCH in ALL modes (numbers are
// never coerced). fitBad() is the oracle predicate for that door.
const LO = [-Infinity, -Infinity, -0x80000000, -0x8000, -0x80, 0, 0, 0];
const HI = [Infinity, Infinity, 0x7fffffff, 0x7fff, 0x7f, 0xffffffff, 0xffff, 0xff];

function fitBad(type, v) {
  return type >= 2 && (!Number.isInteger(v) || v < LO[type] || v > HI[type]);
}

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
// Generalized to all eight types (mirrors src 314-322). The four fixed-lane
// cases (F64/F32/I16/U8) are byte-identical to the pre-B6 version. `breakFround`
// is the cross-lane misapply knob: when set, an F32 lane is treated as exact F64.
function laneStore(type, v, breakFround) {
  switch (type) {
    case Types.F64: return v;
    case Types.F32: return breakFround ? v : Math.fround(v);
    case Types.I32: return v | 0;
    case Types.I16: { const t = v | 0; return (t << 16) >> 16; }
    case Types.I8:  { const t = v | 0; return (t << 24) >> 24; }
    case Types.U32: return v >>> 0;
    case Types.U16: return v & 0xffff;
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

// The fixed-lane oracle. strict = default/validate; breakOn disables ONLY the
// value-door non-number check (the deliberate BREAK misapplication). RECORD-
// MAJOR, mirroring src exactly: per record, the drift doors (unexpected then
// missing) run, then the value loop in the size-descending field order does the
// non-number door THEN the fit door. The fit door (E_LANE_MISMATCH) fires in
// ALL modes -- a number is never coerced -- so a NaN/Infinity/out-of-range value
// reaching the I16/U8 lanes refuses even under coerce. FIELDS is already in
// descending byte size (8,4,2,1) with distinct sizes, so array order equals src's
// stable sort order.
function oracle(records, strict, breakOn) {
  const values = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (strict) {
      for (const k in rec) {
        if (!(k in KEYSET)) return { throws: 'E_UNEXPECTED_FIELD' };
      }
      for (let j = 0; j < FIELD_NAMES.length; j++) {
        if (!(FIELD_NAMES[j] in rec)) return { throws: 'E_MISSING_FIELD' };
      }
    }
    const row = {};
    for (let j = 0; j < FIELDS.length; j++) {
      const f = FIELDS[j];
      let v = rec[f.name];
      if (typeof v !== 'number') {
        if (strict && !breakOn) return { throws: 'E_NON_NUMERIC' };
        v = 0;   // coerce (or the breakOn misapply) stores exact 0
      }
      if (fitBad(f.type, v)) return { throws: 'E_LANE_MISMATCH' };
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

/* -------------------------------------------------------------------------- *
 * Shared B6 oracle core -- replicates the src door order exactly.
 *
 * Precedence (mirrors src bake()):
 *   P1 full shape pre-pass over ALL records (a non-record at index 3 beats drift
 *      at index 1) -> E_NOT_A_RECORD
 *   P2 record 0 has zero own keys -> E_EMPTY_RECORD
 *   P3 (cross lane) overrides -- the lanes always pass VALID overrides, so the
 *      oracle assumes them valid and models no E_UNKNOWN_FIELD/E_BAD_TYPE.
 *   P4 per record in index order: if strict, extras in for..in order
 *      (E_UNEXPECTED_FIELD); on own-count shortfall, missing in keys[] order via
 *      hasOwnProperty (own-key semantics -- BK-29 fixed in B3: an absent own
 *      prototype-named field refuses E_MISSING_FIELD, it no longer slips an
 *      inherited value into the value door); then values in the size-sorted
 *      field order (stable sort by BYTES desc, replicating src): a non-number is
 *      E_NON_NUMERIC (strict) or 0 (coerce); then the fit door -- a number an
 *      int lane cannot hold exactly is E_LANE_MISMATCH in ALL modes -- else
 *      laneStore(type, v).
 *
 * cfg knobs (all default off):
 *   typeOf(name)  -> the resolved Types code for a field.
 *   breakMissing  -> INVERT the missing check to the OLD prototype-inclusive `in`
 *                    operator (predicts E_NON_NUMERIC where fixed src, using own
 *                    keys, gives E_MISSING_FIELD).
 *   breakShape    -> evaluate P1 lazily per record index instead of as a pre-pass.
 *   breakFround   -> treat the F32 lane as exact F64 (skip fround) in laneStore.
 *   breakLane     -> skip the fit door and fall back to the old mask-store
 *                    semantics (predicts a wrapped value where src refuses).
 * -------------------------------------------------------------------------- */

function notRecord(rec) {
  return typeof rec !== 'object' || rec === null || Array.isArray(rec);
}

// Mirror of src inferType -- the IDENTICAL ladder (decisions/0005). The mirror
// cannot raise a LiteBakeError, so on the unsafe-integer rung it throws an
// ordinary Error: the inference-driven lanes (hostile, shape) are in-envelope by
// construction and never reach it, so any reach here is a loud harness fault.
function inferType(records, key) {
  let allInt = true, allFround = true, min = Infinity, max = -Infinity;
  let sawNumber = false, sawNonFinite = false;
  for (let i = 0; i < records.length; i++) {
    const v = records[i][key];
    if (typeof v !== 'number') continue;
    if (!Number.isFinite(v)) { sawNonFinite = true; continue; }
    sawNumber = true;
    if (!Number.isInteger(v)) allInt = false;
    if (v < min) min = v;
    if (v > max) max = v;
    if (allFround && Math.fround(v) !== v) allFround = false;
  }
  if (!sawNumber) return Types.F32;
  if (!sawNonFinite && allInt) {
    if (min >= 0) {
      if (max <= 0xff)         return Types.U8;
      if (max <= 0xffff)       return Types.U16;
      if (max <= 0xffffffff)   return Types.U32;
    } else {
      if (min >= -0x80        && max <= 0x7f)         return Types.I8;
      if (min >= -0x8000      && max <= 0x7fff)       return Types.I16;
      if (min >= -0x80000000  && max <= 0x7fffffff)   return Types.I32;
    }
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) return Types.F64;
    throw new Error('t5 mirror: unsafe integer reached an inference-driven lane');
  }
  return allFround ? Types.F32 : Types.F64;
}

function coreOracle(records, mode, cfg) {
  const strict = mode !== 'coerce';

  // P1: full shape pre-pass over ALL records, unless breakShape defers it.
  if (!cfg.breakShape) {
    for (let i = 0; i < records.length; i++) {
      if (notRecord(records[i])) return { throws: 'E_NOT_A_RECORD' };
    }
  }
  // Under breakShape the pre-pass did not run; record 0 must still be a record.
  if (cfg.breakShape && notRecord(records[0])) return { throws: 'E_NOT_A_RECORD' };

  const keys = Object.keys(records[0]);
  if (keys.length === 0) return { throws: 'E_EMPTY_RECORD' };  // P2

  const keyset = Object.create(null);
  for (let k = 0; k < keys.length; k++) keyset[keys[k]] = k;

  // Resolve field types then replicate src:252 stable size-descending sort.
  const fields = new Array(keys.length);
  for (let k = 0; k < keys.length; k++) fields[k] = { name: keys[k], type: cfg.typeOf(keys[k]) };
  fields.sort((a, b) => BYTES[b.type] - BYTES[a.type]);

  // P4: per record in index order.
  const rows = new Array(records.length);
  for (let i = 0; i < records.length; i++) {
    if (cfg.breakShape && notRecord(records[i])) return { throws: 'E_NOT_A_RECORD' };
    const rec = records[i];

    if (strict) {
      for (const k in rec) {
        if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
        if (keyset[k] === undefined) return { throws: 'E_UNEXPECTED_FIELD' };
      }
      let own = 0;
      for (const k in rec) {
        if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
        own++;
      }
      if (own < keys.length) {
        for (let m = 0; m < keys.length; m++) {
          // Fixed src (B3) uses OWN-key semantics -- hasOwnProperty -- so an
          // absent own prototype-named field refuses E_MISSING_FIELD (BK-29
          // fixed). breakMissing INVERTS this to the OLD prototype-inclusive
          // `in`, under which an inherited member counts as present, the value
          // door is reached, and E_NON_NUMERIC is predicted instead.
          const present = cfg.breakMissing
            ? (keys[m] in rec)
            : Object.prototype.hasOwnProperty.call(rec, keys[m]);
          if (!present) return { throws: 'E_MISSING_FIELD' };
        }
      }
    }

    const row = Object.create(null);
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      let v = rec[f.name];
      if (typeof v !== 'number') {
        if (strict) return { throws: 'E_NON_NUMERIC' };
        v = 0;
      }
      // Fit door -- mirrors src: after the non-number door, before the store, a
      // number an int lane cannot hold exactly refuses in ALL modes. breakLane
      // skips it and falls back to the old mask-store semantics.
      if (!cfg.breakLane && fitBad(f.type, v)) return { throws: 'E_LANE_MISMATCH' };
      row[f.name] = laneStore(f.type, v, cfg.breakFround);
    }
    rows[i] = row;
  }
  return { values: rows };
}

/** Hostile-name lane oracle. Types resolve by inference (the absent arm). */
export function hostileOracle(records, mode, breakHostile) {
  return coreOracle(records, mode, {
    typeOf: (name) => inferType(records, name),
    breakMissing: !!breakHostile,
    breakShape: false,
    breakFround: false,
    breakLane: false,
  });
}

/** Shape lane oracle. Types resolve by inference (no override in the lane). */
export function shapeOracle(records, mode, breakShape) {
  return coreOracle(records, mode, {
    typeOf: (name) => inferType(records, name),
    breakMissing: false,
    breakShape: !!breakShape,
    breakFround: false,
    breakLane: false,
  });
}

/** Schema-cross oracle. Types resolve straight from the explicit override map. */
export function crossOracle(schemaFields, records, mode, breakCross, breakLane) {
  return coreOracle(records, mode, {
    typeOf: (name) => schemaFields[name],
    breakMissing: false,
    breakShape: false,
    breakFround: !!breakCross,
    breakLane: !!breakLane,
  });
}

/* -------------------------------------------------------------------------- *
 * B6 lane machinery.
 * -------------------------------------------------------------------------- */

function laneFail(lane, mode, iter, detail) {
  return 't5.' + lane + ' [' + mode + '] iter=' + iter + ': ' + detail + ' (seed=' + SEED + ')\n' +
    '  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs';
}

// The eight recipe types. Each recipe pins inferType to its own type. F64 is now
// included: the ladder infers it for a big-safe-integer column (past U32, still
// inside +/-(2^53-1)) and for a fround-hostile double column -- recipeValue picks
// between those two deterministic classes from the stream.
const RECIPE_TYPES = [Types.U8, Types.U16, Types.U32, Types.I8, Types.I16, Types.I32, Types.F32, Types.F64];

function recipeValue(prng, type) {
  switch (type) {
    case Types.U8:  return prng() % 256;
    case Types.U16: return 256 + (prng() % 1000);
    case Types.U32: return 65536 + (prng() % 1000000);
    case Types.I8:  return -(1 + (prng() % 127));
    case Types.I16: return -129 - (prng() % 1000);
    case Types.I32: return -32769 - (prng() % 100000);
    case Types.F32: return (prng() % 200) - 100 + 0.5;
    case Types.F64: return (prng() % 2)
      ? (2 ** 32 + (prng() % 1000000))     // big safe integer -> F64 (past U32)
      : ((prng() % 1000) + 0.1);           // fround-hostile double -> F64
  }
  return 0;
}

// Set a field as an OWN key. Plain assignment already creates own enumerable
// data properties for constructor/toString/valueOf/hasOwnProperty (they are
// writable data props up the chain); __proto__ is the one accessor that must be
// defined explicitly so it lands as an own data property and never hits the
// prototype setter.
function putOwn(rec, name, value) {
  if (name === '__proto__') {
    Object.defineProperty(rec, '__proto__',
      { value: value, writable: true, enumerable: true, configurable: true });
  } else {
    rec[name] = value;
  }
}

/* ---- hostile-name lane --------------------------------------------------- */

const HOSTILE_POOL = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__', 'x', 'y'];

function pickHostileSchema(prng) {
  // Fisher-Yates a copy of the pool, take a 2..5 prefix, assign recipe types.
  const pool = HOSTILE_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = prng() % (i + 1);
    const t = pool[i]; pool[i] = pool[j]; pool[j] = t;
  }
  const count = 2 + (prng() % 4);   // 2..5 fields
  const names = pool.slice(0, count);
  const types = new Array(count);
  for (let k = 0; k < count; k++) types[k] = RECIPE_TYPES[prng() % RECIPE_TYPES.length];
  return { names, types };
}

function hostileCell(prng, type) {
  const r = prng() % 12;
  if (r < 6) return recipeValue(prng, type);  // clean, in-recipe number
  if (r === 6) return NaN;
  if (r === 7) return -0;
  if (r === 8) return (prng() % 2) ? Infinity : -Infinity;
  return NON_NUMBERS[prng() % NON_NUMBERS.length];
}

function buildHostileRecord(prng, names, types, isFirst) {
  const rec = {};
  let dropIdx = -1;
  if (!isFirst && (prng() % 4) === 0) dropIdx = prng() % names.length;
  for (let k = 0; k < names.length; k++) {
    if (k === dropIdx) continue;
    const v = isFirst ? recipeValue(prng, types[k]) : hostileCell(prng, types[k]);
    putOwn(rec, names[k], v);
  }
  if (!isFirst && (prng() % 5) === 0) {
    const extra = HOSTILE_POOL[prng() % HOSTILE_POOL.length];
    if (names.indexOf(extra) === -1) putOwn(rec, extra, prng() % 100);
  }
  return rec;
}

function optsAbsent(mode) {
  if (mode === 'validate') return { validate: true };
  if (mode === 'coerce')   return { coerce: 'zero' };
  return {};
}

function optsPresent(mode, override) {
  if (mode === 'validate') return { schema: override, validate: true };
  if (mode === 'coerce')   return { schema: override, coerce: 'zero' };
  return { schema: override };
}

function compareHostile(iter, mode, arm, recs, names, opts, exp) {
  let baked = null, err = null;
  try { baked = bake(recs, opts); } catch (e) { err = e; }
  if (exp.throws) {
    check(!!err, () => laneFail('hostile', mode, iter, arm + ': expected throw ' + exp.throws + ' but bake succeeded'));
    check(err.code === exp.throws, () => laneFail('hostile', mode, iter, arm + ': expected ' + exp.throws + ' got ' + err.code));
    return;
  }
  check(!err, () => laneFail('hostile', mode, iter, arm + ': unexpected throw ' + (err && err.code)));
  const r = new Reader(baked);
  for (let i = 0; i < recs.length; i++) {
    for (let k = 0; k < names.length; k++) {
      const got = r.get(i, names[k]);
      const want = exp.values[i][names[k]];
      check(Object.is(got, want), () => laneFail('hostile', mode, iter,
        arm + " record " + i + " field '" + names[k] + "' got " + String(got) + ' want ' + String(want)));
    }
  }
}

export function runHostileNameLane() {
  const prng = makePrng((SEED ^ 0x2545f491) >>> 0);   // distinct hostile-lane XOR
  for (let iter = 0; iter < 30; iter++) {
    const sch = pickHostileSchema(prng);
    const names = sch.names, types = sch.types;
    const n = 2 + (prng() % 4);   // 2..5 records
    const recs = new Array(n);
    for (let i = 0; i < n; i++) recs[i] = buildHostileRecord(prng, names, types, i === 0);

    // Own-ness assertion once per corpus: record 0 is canonical (all fields).
    for (let k = 0; k < names.length; k++) {
      check(Object.prototype.hasOwnProperty.call(recs[0], names[k]),
        () => laneFail('hostile', '-', iter, "field '" + names[k] + "' is not an own key of record 0"));
    }

    const override = Object.create(null);
    for (let k = 0; k < names.length; k++) override[names[k]] = types[k];

    for (let m = 0; m < MODES.length; m++) {
      const mode = MODES[m];
      // Absent arm resolves types by inference; present arm resolves them from
      // the explicit override. On a clean corpus the two agree, but a non-finite
      // value forces inference to a float rung while the override keeps the int
      // recipe lane (which the fit door then refuses) -- so each arm carries its
      // own oracle rather than sharing one.
      const expAbsent = hostileOracle(recs, mode, false);
      compareHostile(iter, mode, 'absent', recs, names, optsAbsent(mode), expAbsent);
      const expPresent = coreOracle(recs, mode, {
        typeOf: (name) => override[name],
        breakMissing: false, breakShape: false, breakFround: false, breakLane: false,
      });
      compareHostile(iter, mode, 'present', recs, names, optsPresent(mode, override), expPresent);
    }
  }
}

/* ---- shape lane ---------------------------------------------------------- */

const SHAPE_NAMES = ['sa', 'sb', 'sc'];   // distinct sizes: U8(1), I16(2), F32(4)
const SHAPE_BAD = [null, [1, 2], 42, 'str', true];

function buildShapeRecord(prng) {
  return {
    sa: prng() % 256,               // U8
    sb: -129 - (prng() % 1000),     // I16
    sc: (prng() % 200) - 100 + 0.5, // F32
  };
}

function compareShape(iter, mode, recs, exp) {
  let baked = null, err = null;
  try { baked = bake(recs, optsAbsent(mode)); } catch (e) { err = e; }
  if (exp.throws) {
    check(!!err, () => laneFail('shape', mode, iter, 'expected throw ' + exp.throws + ' but bake succeeded'));
    check(err.code === exp.throws, () => laneFail('shape', mode, iter, 'expected ' + exp.throws + ' got ' + err.code));
    return;
  }
  check(!err, () => laneFail('shape', mode, iter, 'unexpected throw ' + (err && err.code)));
  const r = new Reader(baked);
  for (let i = 0; i < recs.length; i++) {
    for (let k = 0; k < SHAPE_NAMES.length; k++) {
      const got = r.get(i, SHAPE_NAMES[k]);
      const want = exp.values[i][SHAPE_NAMES[k]];
      check(Object.is(got, want), () => laneFail('shape', mode, iter,
        "record " + i + " field '" + SHAPE_NAMES[k] + "' got " + String(got) + ' want ' + String(want)));
    }
  }
}

export function runShapeLane() {
  const prng = makePrng((SEED ^ 0x9e3779b1) >>> 0);   // distinct shape-lane XOR
  for (let iter = 0; iter < 60; iter++) {
    const n = 3 + (prng() % 4);   // 3..6 records
    const recs = new Array(n);
    for (let i = 0; i < n; i++) recs[i] = buildShapeRecord(prng);

    const kind = prng() % 4;
    if (kind === 1) {
      const j = prng() % n;                          // splice a non-record (incl index 0)
      recs[j] = SHAPE_BAD[prng() % SHAPE_BAD.length];
    } else if (kind === 2) {
      recs[0] = {};                                  // empty record 0 -> E_EMPTY_RECORD (all modes)
    } else if (kind === 3 && n > 1) {
      const j = 1 + (prng() % (n - 1));              // empty twin at i>0
      recs[j] = {};
    }
    // kind 0 (or the n===1 fallthrough) leaves a clean corpus -- the non-vacuity
    // case that must pass in every mode.

    for (let m = 0; m < MODES.length; m++) {
      const mode = MODES[m];
      const exp = shapeOracle(recs, mode, false);
      compareShape(iter, mode, recs, exp);
    }
  }
}

/* ---- schema-cross lane --------------------------------------------------- */

const ALL_TYPES = [Types.F32, Types.F64, Types.I32, Types.I16, Types.I8, Types.U32, Types.U16, Types.U8];

function wideNumber(prng) {
  const r = prng() % 8;
  if (r === 0) return (prng() % 200000) - 100000;           // wide int, out of small ranges
  if (r === 1) return ((prng() % 200000) - 100000) * 0.5;   // fractional
  if (r === 2) return prng() >>> 0;                         // up to ~4e9
  if (r === 3) return -((prng() >>> 0) % 2000000000);       // large negative
  if (r === 4) return 2 ** 33 + (prng() % 1000000);         // big int beyond 2**32
  if (r === 5) return (prng() % 2) ? 2 ** 60 : -(2 ** 60);  // big int beyond 2**53
  if (r === 6) return (prng() % 1000) + 0.1;                // fround-hostile double
  return ((prng() % 2000) - 1000) + 0.25;                   // small fractional
}

function crossCell(prng) {
  const r = prng() % 14;
  if (r < 7) return wideNumber(prng);
  if (r === 7) return NaN;
  if (r === 8) return -0;
  if (r === 9) return (prng() % 2) ? Infinity : -Infinity;
  return NON_NUMBERS[prng() % NON_NUMBERS.length];
}

function buildCrossRecord(prng, names, isFirst) {
  const rec = {};
  let dropIdx = -1;
  if (!isFirst && (prng() % 5) === 0) dropIdx = prng() % names.length;
  for (let k = 0; k < names.length; k++) {
    if (k === dropIdx) continue;
    rec[names[k]] = isFirst ? wideNumber(prng) : crossCell(prng);
  }
  if (!isFirst && (prng() % 6) === 0) rec['x' + (prng() % 4)] = prng() % 100;   // extra (not g-named)
  return rec;
}

function compareCross(iter, mode, schema, recs, names, exp) {
  const opts = mode === 'validate' ? { schema: schema, validate: true }
    : mode === 'coerce' ? { schema: schema, coerce: 'zero' }
    : { schema: schema };
  let baked = null, err = null;
  try { baked = bake(recs, opts); } catch (e) { err = e; }
  if (exp.throws) {
    check(!!err, () => laneFail('cross', mode, iter, 'expected throw ' + exp.throws + ' but bake succeeded'));
    check(err.code === exp.throws, () => laneFail('cross', mode, iter, 'expected ' + exp.throws + ' got ' + err.code));
    return;
  }
  check(!err, () => laneFail('cross', mode, iter, 'unexpected throw ' + (err && err.code) + ' (' + (err && err.message) + ')'));
  const r = new Reader(baked);
  for (let i = 0; i < recs.length; i++) {
    for (let k = 0; k < names.length; k++) {
      const got = r.get(i, names[k]);
      const want = exp.values[i][names[k]];
      check(Object.is(got, want), () => laneFail('cross', mode, iter,
        "record " + i + " field '" + names[k] + "' got " + String(got) + ' want ' + String(want)));
    }
  }
}

export function runSchemaCrossLane() {
  const prng = makePrng((SEED ^ 0x27d4eb2f) >>> 0);   // distinct cross-lane XOR
  for (let iter = 0; iter < 120; iter++) {
    const nf = 1 + (prng() % 16);   // 1..16 fields
    const names = new Array(nf);
    const schema = {};
    for (let k = 0; k < nf; k++) {
      names[k] = 'g' + k;
      schema[names[k]] = ALL_TYPES[prng() % ALL_TYPES.length];
    }
    const n = 2 + (prng() % 4);   // 2..5 records
    const recs = new Array(n);
    for (let i = 0; i < n; i++) recs[i] = buildCrossRecord(prng, names, i === 0);

    for (let m = 0; m < MODES.length; m++) {
      const mode = MODES[m];
      const exp = crossOracle(schema, recs, mode, false);
      compareCross(iter, mode, schema, recs, names, exp);
    }
  }
}

/* ---- enforced checks + fixed lane (verbatim behavior) -------------------- */

export function runEnforcedChecks() {
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
}

export function runFixedLane() {
  // Seeded differential fuzz -- its own SEED-derived stream. This derivation and
  // stream consumption are frozen so pre-B6 TORTURE_SEED replays reproduce.
  const prng = makePrng((SEED ^ 0x517cc1b7) >>> 0);
  for (let iter = 0; iter < ITERS; iter++) {
    const corpus = genCorpus(prng);
    for (let m = 0; m < MODES.length; m++) compareCorpus(iter, MODES[m], corpus);
  }
}

export function run() {
  runEnforcedChecks();
  runFixedLane();
  runHostileNameLane();
  runShapeLane();
  runSchemaCrossLane();
}
