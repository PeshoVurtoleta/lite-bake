/**
 * lite-bake — Compile JSON arrays into flat interleaved binary for zero-GC reads.
 *
 * Workflow:
 *   const baked = bake(records, { validate: true });   // init-time; validate optional
 *   const r     = new Reader(baked);
 *   const f32   = r.f32;
 *   const u8    = r.u8;
 *   const s32   = r.strideF32;
 *   const sB    = r.stride;
 *   const OFF_X = r.offsetF32('x');
 *   const OFF_Y = r.offsetF32('y');
 *   const OFF_T = r.offsetU8('type');
 *
 *   for (let i = 0; i < r.count; i++) {                // ZERO allocations
 *     const x = f32[i * s32 + OFF_X];
 *     const y = f32[i * s32 + OFF_Y];
 *     const t = u8 [i * sB  + OFF_T];
 *   }
 *
 * Notes:
 *   - Stride is padded to the LARGEST field alignment (F64 → 8, F32/I32 → 4, …).
 *     This keeps `i * strideF64 + off` arithmetic consistent across records.
 *   - DataView writes use the platform's native endianness, matching the endianness
 *     that TypedArrays read with. Round-trip works on LE (99.99%) and BE alike.
 *   - `get(i, name)` and `row(i)` are INIT/DEBUG ONLY. They branch/allocate.
 */

/*
 * Refusal vocabulary. Every door on the write side throws a LiteBakeError whose
 * `code` is one of these; the Reader's existing lookup throws carry an R_ code.
 * Prose is unchanged from 1.0.x where a throw already existed; the code is the
 * stable, greppable contract.
 *
 *   E_INPUT           records is not a non-empty array
 *   E_NOT_A_RECORD    a record is not a non-null, non-array object
 *   E_EMPTY_RECORD    record 0 has zero own keys (no schema to declare)
 *   E_NON_NUMERIC     a field value is not a number (strict mode)
 *   E_MISSING_FIELD   a record is missing a field record 0 declares
 *   E_UNEXPECTED_FIELD a record carries a field record 0 does not declare
 *   E_UNKNOWN_OPTION  opts has a key that is not schema/validate/coerce
 *   E_OPTION_VALUE    an opts value is out of its domain
 *   E_OPTION_CONFLICT validate:true and coerce:'zero' cannot both be set
 *   E_UNKNOWN_FIELD   schema override names a field not present in the records
 *   E_BAD_TYPE        schema override value is not a Types code 0..7
 *   E_UNSAFE_INTEGER  an all-integer column reaches past +/-(2^53-1) where integer identity is ambiguous; override to F64 to accept precision loss
 *   E_LANE_MISMATCH   a number cannot be represented exactly by the field's integer lane (out of range, fractional, or non-finite)
 *   R_UNKNOWN_FIELD   Reader asked for a field the baked schema does not have
 *   R_WRONG_TYPE      Reader asked for a field under the wrong lane width
 *   R_INPUT            baked/meta is not a non-null object, or buffer/bytes is not an accepted binary type
 *   R_BAD_STRIDE       stride is not a positive integer, or is not a multiple of the schema's max lane alignment
 *   R_BAD_COUNT        count is not a non-negative integer
 *   R_BAD_LENGTH       buffer byteLength is not a multiple of 8
 *   R_TRUNCATED        count rows at stride bytes do not fit in the buffer
 *   R_BAD_SCHEMA       schema is not a non-empty array of well-formed, aligned, in-stride, non-overlapping fields
 *   R_ROW_OUT_OF_RANGE get()/row() index is not an integer in [0, count)
 */
export class LiteBakeError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
    this.name = 'LiteBakeError';
  }
}

function raise(code, msg) {
  throw new LiteBakeError(code, msg);
}

// Known opts keys, in declaration order (nearestKey ties break on this order).
const OPT_KEYS = ['schema', 'validate', 'coerce'];

// Construction-time opts validator. Cold path: allocates only when it throws
// (the did-you-mean Levenshtein). Ported in SHAPE from lite-bake-stream's
// checkOpts, right-sized to the three keys bake() accepts.
function checkBakeOpts(opts) {
  if (opts === undefined || opts === null) return;   // absent opts == use defaults
  if (typeof opts !== 'object' || Array.isArray(opts)) {
    raise('E_OPTION_VALUE',
      'lite-bake: options must be a plain object (schema/validate/coerce); got ' + showOpt(opts));
  }
  for (const key in opts) {
    if (!Object.prototype.hasOwnProperty.call(opts, key)) continue;
    if (key !== 'schema' && key !== 'validate' && key !== 'coerce') {
      const near = nearestOptKey(key);
      if (near !== null) {
        raise('E_UNKNOWN_OPTION',
          "lite-bake: unknown option '" + key + "' -- did you mean '" + near + "'?");
      }
      raise('E_UNKNOWN_OPTION',
        "lite-bake: unknown option '" + key + "' (known: " + OPT_KEYS.join(', ') + ')');
    }
    const v = opts[key];
    if (v === undefined) continue;   // explicit undefined == use default
    if (key === 'schema') {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        raise('E_OPTION_VALUE',
          "lite-bake: option 'schema' must be a non-null object; got " + showOpt(v));
      }
    } else if (key === 'validate') {
      if (typeof v !== 'boolean') {
        raise('E_OPTION_VALUE',
          "lite-bake: option 'validate' must be a boolean; got " + showOpt(v));
      }
    } else {   // coerce
      if (v !== 'zero') {
        raise('E_OPTION_VALUE',
          "lite-bake: option 'coerce' must be 'zero'; got " + showOpt(v));
      }
    }
  }
  if (opts.validate === true && opts.coerce === 'zero') {
    raise('E_OPTION_CONFLICT',
      "lite-bake: option 'validate: true' conflicts with 'coerce: zero' -- " +
      "drop validate to coerce non-numbers to 0, or drop coerce to refuse them (E_NON_NUMERIC)");
  }
}

function showOpt(v) {
  if (typeof v === 'string') return "'" + v + "'";
  if (v === null) return 'null';
  if (typeof v === 'object') return Array.isArray(v) ? 'array' : 'object';
  return String(v);
}

// Nearest known opts key by Levenshtein distance, returned only when <= 2.
// Ties break by declaration order (strict < keeps the first candidate).
function nearestOptKey(key) {
  let best = null;
  let bestDist = 3;
  const klen = key.length;
  for (let k = 0; k < OPT_KEYS.length; k++) {
    const cand = OPT_KEYS[k];
    const diff = klen - cand.length;
    if (diff > 2 || diff < -2) continue;   // length delta alone exceeds the cap
    const dist = levOpt(key, cand);
    if (dist < bestDist) { bestDist = dist; best = cand; }
  }
  return bestDist <= 2 ? best : null;
}

// Two-row Levenshtein. Allocates two small arrays; reached only on the throw
// path (nearestOptKey runs only when an unknown key is being reported).
function levOpt(a, b) {
  const n = a.length, m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;
  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      let vv = prev[j] + 1;
      const del = curr[j - 1] + 1;
      if (del < vv) vv = del;
      const sub = prev[j - 1] + cost;
      if (sub < vv) vv = sub;
      curr[j] = vv;
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[m];
}

const F32 = 0, F64 = 1, I32 = 2, I16 = 3, I8 = 4, U32 = 5, U16 = 6, U8 = 7;
const BYTES = [4, 8, 4, 2, 1, 4, 2, 1];

// Fit-door bounds and names, indexed by the type code (F32,F64,I32,I16,I8,
// U32,U16,U8). The float lanes carry no integer fit constraint (+/-Infinity
// bounds), so the door -- gated `f.type >= 2` -- only fires on int lanes. Used
// on the cold write path; TYPE_NAMES is for refusal messages only.
const LO = [-Infinity, -Infinity, -0x80000000, -0x8000, -0x80, 0, 0, 0];
const HI = [Infinity, Infinity, 0x7fffffff, 0x7fff, 0x7f, 0xffffffff, 0xffff, 0xff];
const TYPE_NAMES = ['F32', 'F64', 'I32', 'I16', 'I8', 'U32', 'U16', 'U8'];

// Detect platform endianness once so DataView writes match TypedArray reads.
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

// The inference ladder (decisions/0005). One pass per column, zero allocation.
// A finite number feeds the min/max/allInt/allFround trackers; a non-finite
// number (NaN, +/-Infinity) sets sawNonFinite and forces the float rung so an
// integer lane can never zero it. inferType runs ONLY for un-overridden fields,
// so E_UNSAFE_INTEGER fires only on the inference path.
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
  // No finite number seen -> the F32 fallback (NaN/Infinity ride F32 exactly).
  if (!sawNumber) return F32;
  // A non-finite value bars every integer lane: take the float rung.
  if (!sawNonFinite && allInt) {
    if (min >= 0) {
      if (max <= 0xff)         return U8;
      if (max <= 0xffff)       return U16;
      if (max <= 0xffffffff)   return U32;
    } else {
      if (min >= -0x80        && max <= 0x7f)         return I8;
      if (min >= -0x8000      && max <= 0x7fff)       return I16;
      if (min >= -0x80000000  && max <= 0x7fffffff)   return I32;
    }
    // Past the 32-bit lanes: an F64 holds any integer up to +/-(2^53-1) exactly.
    if (Number.isSafeInteger(min) && Number.isSafeInteger(max)) return F64;
    const bad = Number.isSafeInteger(max) ? min : max;
    raise('E_UNSAFE_INTEGER',
      "lite-bake: field '" + key + "' integer " + bad +
      ' is beyond +/-(2^53-1) where integer identity is ambiguous -- ' +
      'override the field to Types.F64 to accept documented precision loss');
  }
  // Float rung: F32 when every value survives the fround round-trip, else F64.
  return allFround ? F32 : F64;
}

/**
 * bake(records, opts?)
 *   opts.schema:   { fieldName: Types.F32, ... }   override inferred types
 *   opts.validate: boolean                          explicit synonym of the strict default
 *   opts.coerce:   'zero'                           restore 1.0.x leniency (non-numbers -> 0)
 * Strict by default: non-numeric values, missing fields and extra fields refuse
 * with a coded LiteBakeError. Numbers always write through (NaN/-0/Infinity kept
 * in float lanes). Unknown opts keys throw E_UNKNOWN_OPTION with a did-you-mean.
 */
export function bake(records, opts = {}) {
  // (0) opts prologue -- unknown keys, out-of-domain values, and the
  // validate/coerce conflict all refuse here, before any work. null/undefined
  // opts mean "use defaults"; a non-plain-object opts raises E_OPTION_VALUE.
  checkBakeOpts(opts);
  if (opts === null || opts === undefined) opts = {};

  if (!Array.isArray(records) || records.length === 0) {
    raise('E_INPUT', 'lite-bake: expected non-empty array of records');
  }

  // (1) records-shape pre-pass: every record is a non-null, non-array object.
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
      raise('E_NOT_A_RECORD', `lite-bake: record ${i} is not a non-null object`);
    }
  }
  const keys = Object.keys(records[0]);
  if (keys.length === 0) {
    raise('E_EMPTY_RECORD', 'lite-bake: record 0 has no fields');
  }

  const override = opts.schema || {};
  const coerceZero = opts.coerce === 'zero';
  const strict = !coerceZero;

  // Null-prototype keyset of record 0, built ONCE. Reused by the override door
  // and the per-record drift door; maps field name -> its index in `keys`.
  const keyset = Object.create(null);
  for (let k = 0; k < keys.length; k++) keyset[keys[k]] = k;

  // (2) override door: every schema key must name a real field and carry a
  // Types code 0..7. Validated codes are copied into a null-prototype map so
  // type resolution consults OWN override keys only -- never an inherited
  // Object.prototype member (e.g. a field named 'constructor' or 'toString').
  // After this door BYTES[type] is always defined.
  const ownOverride = Object.create(null);
  for (const key in override) {
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
    if (keyset[key] === undefined) {
      raise('E_UNKNOWN_FIELD', `lite-bake: schema override names unknown field '${key}'`);
    }
    const t = override[key];
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > 7) {
      raise('E_BAD_TYPE',
        `lite-bake: schema override for '${key}' must be a Types code 0..7 ` +
        '(F32,F64,I32,I16,I8,U32,U16,U8)');
    }
    ownOverride[key] = t;
  }

  const fields = keys.map(name => ({
    name,
    type: ownOverride[name] !== undefined ? ownOverride[name] : inferType(records, name),
    offset: 0,
  }));
  fields.sort((a, b) => BYTES[b.type] - BYTES[a.type]);

  // Assign per-field offsets AND track the max alignment required by any field.
  let stride = 0;
  let maxAlign = 1;
  for (const f of fields) {
    const sz = BYTES[f.type];
    if (sz > maxAlign) maxAlign = sz;
    stride = (stride + sz - 1) & ~(sz - 1);
    f.offset = stride;
    stride += sz;
  }
  // Pad total stride to max field alignment — keeps record N's fields correctly
  // aligned under `i * stride + offset` AND keeps strideF64/strideF32 exact.
  stride = (stride + maxAlign - 1) & ~(maxAlign - 1);

  // Pad total buffer size up to a multiple of 8 so Float64Array view is always
  // constructible, even when the schema has no F64 field. Costs 0–7 unused
  // trailing bytes per baked dataset — negligible.
  const rawBytes = stride * records.length;
  const paddedBytes = (rawBytes + 7) & ~7;
  const ab = new ArrayBuffer(paddedBytes);
  const dv = new DataView(ab);

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const base = i * stride;

    // (3) drift door -- strict only. One pass over rec's OWN keys against the
    // record-0 keyset, counting matches; a stray key or a shortfall refuses.
    // The keyset contract is own-ENUMERABLE keys: both walks skip inherited
    // members via hasOwnProperty, so an absent own prototype-named field (e.g.
    // 'constructor' present in record 0, dropped in record N) now refuses
    // E_MISSING_FIELD -- it no longer slips through an inherited value into the
    // E_NON_NUMERIC value door (finding BK-29, fixed in B3). Under coerce:'zero'
    // the door is skipped: extras drop, absents read 0.
    if (strict) {
      let own = 0;
      for (const k in rec) {
        if (!Object.prototype.hasOwnProperty.call(rec, k)) continue;
        if (keyset[k] === undefined) {
          raise('E_UNEXPECTED_FIELD', `lite-bake: record ${i} has unknown field '${k}'`);
        }
        own++;
      }
      if (own < keys.length) {
        for (let m = 0; m < keys.length; m++) {
          if (!Object.prototype.hasOwnProperty.call(rec, keys[m])) {
            raise('E_MISSING_FIELD', `lite-bake: record ${i} missing field '${keys[m]}'`);
          }
        }
      }
    }

    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      const addr = base + f.offset;
      let v = rec[f.name];
      // Per-value door where each silent mask stood: one typeof + branch.
      // Strict refuses a non-number; coerce writes exact 0. Numbers write
      // through: float lanes DIRECT (NaN/-0/Infinity preserved).
      if (typeof v !== 'number') {
        if (strict) {
          raise('E_NON_NUMERIC', `lite-bake: record ${i} field '${f.name}' is not a number`);
        }
        v = 0;
      }
      // (4) fit door -- int lanes (codes 2..7) only. A number that the lane
      // cannot represent EXACTLY (fractional, out of range, or non-finite)
      // refuses in ALL modes: numbers are never coerced (decisions/0001). A
      // coerced 0 is an integer inside every lane, so it passes trivially.
      // Behind this door the store masks below (|0, >>>0, &0xffff, &0xff) are
      // provably exact, never a silent wrap.
      if (f.type >= 2 && (!Number.isInteger(v) || v < LO[f.type] || v > HI[f.type])) {
        raise('E_LANE_MISMATCH',
          "lite-bake: record " + i + " field '" + f.name + "' value " + v +
          ' does not fit lane ' + TYPE_NAMES[f.type] +
          ' -- choose a wider lane or a float override (Types.F32/F64)');
      }
      switch (f.type) {
        case F32: dv.setFloat32(addr, v,        LE);     break;
        case F64: dv.setFloat64(addr, v,        LE);     break;
        case I32: dv.setInt32  (addr, v | 0,    LE);     break;
        case I16: dv.setInt16  (addr, v | 0,    LE);     break;
        case I8:  dv.setInt8   (addr, v | 0);            break;
        case U32: dv.setUint32 (addr, v >>> 0,  LE);     break;
        case U16: dv.setUint16 (addr, v & 0xffff, LE);   break;
        case U8:  dv.setUint8  (addr, v & 0xff);         break;
      }
    }
  }

  return { buffer: ab, stride, count: records.length, schema: fields };
}

export class Reader {
  /**
   * Coherence-door constructor -- the Reader trusts NOTHING. Every incoherent
   * `baked` is refused with a stable R_* code BEFORE any view is constructed, so
   * no raw RangeError can escape. Door order (first-offender; ALL doors run
   * before ANY view construction):
   *   (1) baked is a non-null, non-array object          -> R_INPUT
   *   (2) baked.buffer is an ArrayBuffer                  -> R_INPUT
   *       (a typed-array view names Reader.fromBytes)
   *   (3) stride is a positive integer                   -> R_BAD_STRIDE
   *   (4) count is a non-negative integer                -> R_BAD_COUNT
   *   (5) buffer byteLength is a multiple of 8           -> R_BAD_LENGTH
   *   (6) count rows fit (DIVISION form)                 -> R_TRUNCATED
   *   (7) schema is well-formed, aligned, in-stride,
   *       non-overlapping -- each entry SNAPSHOTTED       -> R_BAD_SCHEMA
   *   (8) stride is a multiple of max field alignment     -> R_BAD_STRIDE
   * The schema is snapshotted into fresh plain objects, so later caller mutation
   * of baked.schema (or a getter TOCTOU) cannot move a field after validation. A
   * FROZEN valid baked object constructs; the argument is never written to. The
   * raw typed-array lane stays caller-owned by design (see decisions/0002).
   */
  constructor(baked) {
    // (1) baked shape
    if (baked === null || typeof baked !== 'object' || Array.isArray(baked)) {
      raise('R_INPUT', 'lite-bake: Reader(baked) expects a non-null object; got ' + readerShow(baked));
    }
    // (2) buffer must be an ArrayBuffer -- a view is fromBytes' job, not raw .buffer.
    const buffer = baked.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      if (ArrayBuffer.isView(buffer)) {
        raise('R_INPUT',
          'lite-bake: baked.buffer is a typed-array view, not an ArrayBuffer -- ' +
          'use Reader.fromBytes(view, meta), never .buffer raw');
      }
      raise('R_INPUT', 'lite-bake: baked.buffer is not an ArrayBuffer; got ' + readerShow(buffer));
    }
    // (3) stride
    const stride = baked.stride;
    if (typeof stride !== 'number' || !Number.isInteger(stride) || stride <= 0) {
      raise('R_BAD_STRIDE', 'lite-bake: baked.stride must be a positive integer; got ' + readerShow(stride));
    }
    // (4) count
    const count = baked.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      raise('R_BAD_COUNT', 'lite-bake: baked.count must be a non-negative integer; got ' + readerShow(count));
    }
    // (5) byteLength multiple of 8 (so every typed-array view is constructible).
    const byteLength = buffer.byteLength;
    if (byteLength % 8 !== 0) {
      raise('R_BAD_LENGTH', 'lite-bake: baked.buffer byteLength ' + byteLength + ' is not a multiple of 8');
    }
    // (6) truncation -- DIVISION form: count*stride loses float precision for
    // 2^53-class lying counts and would fail OPEN. floor(byteLength/stride) is exact.
    if (count > Math.floor(byteLength / stride)) {
      raise('R_TRUNCATED',
        'lite-bake: ' + count + ' rows at stride ' + stride + ' do not fit in ' + byteLength + ' bytes');
    }
    // (7) schema walk -- SNAPSHOT each entry's {name,type,offset} primitives into
    // a fresh object and validate/keep ONLY the snapshots (immune to later mutation).
    const schema = baked.schema;
    if (!Array.isArray(schema) || schema.length === 0) {
      raise('R_BAD_SCHEMA', 'lite-bake: baked.schema must be a non-empty array; got ' + readerShow(schema));
    }
    const snaps = new Array(schema.length);
    const seen = Object.create(null);
    let maxAlign = 1;
    for (let k = 0; k < schema.length; k++) {
      const f = schema[k];
      if (f === null || typeof f !== 'object') {
        raise('R_BAD_SCHEMA', 'lite-bake: schema[' + k + '] is not a non-null object');
      }
      const name = f.name;
      if (typeof name !== 'string') {
        raise('R_BAD_SCHEMA', 'lite-bake: schema[' + k + '].name must be a string; got ' + readerShow(name));
      }
      if (seen[name]) {
        raise('R_BAD_SCHEMA', "lite-bake: duplicate field name '" + name + "'");
      }
      const type = f.type;
      if (typeof type !== 'number' || !Number.isInteger(type) || type < 0 || type > 7) {
        raise('R_BAD_SCHEMA',
          "lite-bake: schema field '" + name + "' type must be a Types code 0..7; got " + readerShow(type));
      }
      const size = BYTES[type];
      const offset = f.offset;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        raise('R_BAD_SCHEMA',
          "lite-bake: schema field '" + name + "' offset must be a non-negative integer; got " + readerShow(offset));
      }
      if (offset % size !== 0) {
        raise('R_BAD_SCHEMA',
          "lite-bake: schema field '" + name + "' offset " + offset + ' is not aligned to size ' + size);
      }
      if (offset + size > stride) {
        raise('R_BAD_SCHEMA',
          "lite-bake: schema field '" + name + "' offset+size " + (offset + size) + ' exceeds stride ' + stride);
      }
      seen[name] = true;
      if (size > maxAlign) maxAlign = size;
      snaps[k] = { name: name, type: type, offset: offset };
    }
    // Overlap check over a scratch copy sorted by offset (cold path; alloc fine).
    const sorted = snaps.slice().sort((a, b) => a.offset - b.offset);
    for (let k = 1; k < sorted.length; k++) {
      const prev = sorted[k - 1];
      const cur = sorted[k];
      if (prev.offset + BYTES[prev.type] > cur.offset) {
        raise('R_BAD_SCHEMA',
          "lite-bake: fields '" + prev.name + "' and '" + cur.name + "' overlap at offset " + cur.offset);
      }
    }
    // (8) stride must be a multiple of the max field alignment (else strideF64/F32
    // shift arithmetic is silently wrong on the documented hot lane).
    if (stride % maxAlign !== 0) {
      raise('R_BAD_STRIDE',
        'lite-bake: stride ' + stride + ' is not a multiple of max field alignment ' + maxAlign);
    }

    // All doors passed -- construct dv + the 8 views + strides exactly as before.
    this.buffer    = buffer;
    this.stride    = stride;              // bytes
    this.count     = count;
    this.strideF64 = stride >> 3;
    this.strideF32 = stride >> 2;
    this.strideU32 = stride >> 2;
    this.strideU16 = stride >> 1;

    this.dv  = new DataView(buffer);
    this.f64 = new Float64Array(buffer);
    this.f32 = new Float32Array(buffer);
    this.i32 = new Int32Array(buffer);
    this.u32 = new Uint32Array(buffer);
    this.i16 = new Int16Array(buffer);
    this.u16 = new Uint16Array(buffer);
    this.u8  = new Uint8Array(buffer);
    this.i8  = new Int8Array(buffer);

    this._fields = Object.create(null);
    for (let k = 0; k < snaps.length; k++) this._fields[snaps[k].name] = snaps[k];
  }

  /**
   * Reconstruct a Reader from on-disk bytes, honoring byteOffset/byteLength.
   * Accepts an ArrayBuffer or a Uint8Array (a Node Buffer IS a Uint8Array);
   * anything else (DataView, other TypedArray, string, null, ...) refuses with
   * R_INPUT. Resolution:
   *   - ArrayBuffer                                       -> use as-is (zero-copy)
   *   - Uint8Array spanning its ENTIRE backing buffer     -> use .buffer (zero-copy)
   *   - any other Uint8Array (pooled / offset view)       -> COPY the viewed range
   *     into a fresh ArrayBuffer of exactly bytes.byteLength
   * The resolved buffer is handed to the constructor, which is the ONLY
   * validation site (fromBytes adds ZERO duplicated checks). Invariant:
   * reader.buffer never exposes bytes outside the dataset -- the write-back
   * recipe `new Uint8Array(reader.buffer)` stays safe (see decisions/0003).
   */
  static fromBytes(bytes, meta) {
    if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) {
      raise('R_INPUT',
        'lite-bake: Reader.fromBytes(bytes, meta) expects meta to be a non-null object; got ' + readerShow(meta));
    }
    let buffer;
    if (bytes instanceof ArrayBuffer) {
      buffer = bytes;                                        // zero-copy
    } else if (bytes instanceof Uint8Array) {
      if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
        buffer = bytes.buffer;                              // full span -> zero-copy
      } else {
        // Pooled / offset view: copy exactly the viewed range, nothing around it.
        buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
    } else {
      raise('R_INPUT',
        'lite-bake: Reader.fromBytes(bytes, ...) expects an ArrayBuffer or a Uint8Array; got ' + readerShow(bytes));
    }
    return new Reader({ buffer: buffer, stride: meta.stride, count: meta.count, schema: meta.schema });
  }

  /** Raw byte offset within one record. Works for any field type. */
  offsetBytes(name) {
    const f = this._fields[name];
    if (!f) raise('R_UNKNOWN_FIELD', `lite-bake: unknown field '${name}'`);
    return f.offset;
  }

  offsetF64(name) { return this._requireType(name, F64).offset >> 3; }
  offsetF32(name) { return this._requireType(name, F32).offset >> 2; }

  offsetU32(name) { return this._require32(name).offset >> 2; }
  offsetI32(name) { return this._require32(name).offset >> 2; }
  offsetU16(name) { return this._require16(name).offset >> 1; }
  offsetI16(name) { return this._require16(name).offset >> 1; }
  offsetU8 (name) { return this._require8 (name).offset; }
  offsetI8 (name) { return this._require8 (name).offset; }

  _requireType(name, t) {
    const f = this._fields[name];
    if (!f) raise('R_UNKNOWN_FIELD', `lite-bake: unknown field '${name}'`);
    if (f.type !== t) raise('R_WRONG_TYPE', `lite-bake: field '${name}' has wrong type`);
    return f;
  }
  _require32(name) {
    const f = this._fields[name];
    if (!f) raise('R_UNKNOWN_FIELD', `lite-bake: unknown field '${name}'`);
    if (f.type !== U32 && f.type !== I32) raise('R_WRONG_TYPE', `lite-bake: '${name}' is not 32-bit int`);
    return f;
  }
  _require16(name) {
    const f = this._fields[name];
    if (!f) raise('R_UNKNOWN_FIELD', `lite-bake: unknown field '${name}'`);
    if (f.type !== U16 && f.type !== I16) raise('R_WRONG_TYPE', `lite-bake: '${name}' is not 16-bit int`);
    return f;
  }
  _require8(name) {
    const f = this._fields[name];
    if (!f) raise('R_UNKNOWN_FIELD', `lite-bake: unknown field '${name}'`);
    if (f.type !== U8 && f.type !== I8) raise('R_WRONG_TYPE', `lite-bake: '${name}' is not 8-bit int`);
    return f;
  }

  /**
   * Init/debug only -- branches + string lookup, NOT for hot loops. `i` must be
   * an integer in [0, count) or it refuses R_ROW_OUT_OF_RANGE (one bounds policy;
   * no silent padding read, no fractional truncation, no raw RangeError). The raw
   * typed-array lane is caller-owned by design and stays unguarded.
   */
  get(i, name) {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      raise('R_ROW_OUT_OF_RANGE', 'lite-bake: row index ' + i + ' is not an integer in [0, ' + this.count + ')');
    }
    const f = this._fields[name];
    if (!f) raise('R_UNKNOWN_FIELD', `lite-bake: unknown field '${name}'`);
    const addr = i * this.stride + f.offset;
    switch (f.type) {
      case F32: return this.dv.getFloat32(addr, LE);
      case F64: return this.dv.getFloat64(addr, LE);
      case I32: return this.dv.getInt32  (addr, LE);
      case I16: return this.dv.getInt16  (addr, LE);
      case I8:  return this.dv.getInt8   (addr);
      case U32: return this.dv.getUint32 (addr, LE);
      case U16: return this.dv.getUint16 (addr, LE);
      case U8:  return this.dv.getUint8  (addr);
    }
  }

  /**
   * Debug only -- allocates a fresh object every call. Useful for
   * console.log(reader.row(i)). `i` must be an integer in [0, count) or it
   * refuses R_ROW_OUT_OF_RANGE (checked before the loop).
   */
  row(i) {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      raise('R_ROW_OUT_OF_RANGE', 'lite-bake: row index ' + i + ' is not an integer in [0, ' + this.count + ')');
    }
    const out = {};
    for (const name in this._fields) out[name] = this.get(i, name);
    return out;
  }
}

// Cold-path describer for Reader door messages: names a value's kind for the
// refusal string. Reached only on a throw, so allocation here is free.
function readerShow(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'object') {
    if (Array.isArray(v)) return 'array';
    const c = v.constructor;
    return c && typeof c.name === 'string' && c.name ? c.name : 'object';
  }
  if (t === 'string') return "'" + v + "'";
  return String(v);
}

export const Types = { F32, F64, I32, I16, I8, U32, U16, U8 };
