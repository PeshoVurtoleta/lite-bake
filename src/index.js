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
 *   R_UNKNOWN_FIELD   Reader asked for a field the baked schema does not have
 *   R_WRONG_TYPE      Reader asked for a field under the wrong lane width
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

// Detect platform endianness once so DataView writes match TypedArray reads.
const LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function inferType(records, key) {
  let allInt = true, min = Infinity, max = -Infinity, sawNumber = false;
  for (let i = 0; i < records.length; i++) {
    const v = records[i][key];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    sawNumber = true;
    if (!Number.isInteger(v)) allInt = false;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!sawNumber || !allInt) return F32;
  if (min >= 0) {
    if (max <= 0xff)   return U8;
    if (max <= 0xffff) return U16;
    return U32;
  }
  if (min >= -0x80   && max <= 0x7f)   return I8;
  if (min >= -0x8000 && max <= 0x7fff) return I16;
  return I32;
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

    // (3) drift door -- strict only. One pass over rec's own keys against the
    // record-0 keyset, counting matches; a stray key or a shortfall refuses.
    // Under coerce:'zero' the door is skipped: extras drop, absents read 0.
    if (strict) {
      let own = 0;
      for (const k in rec) {
        if (keyset[k] === undefined) {
          raise('E_UNEXPECTED_FIELD', `lite-bake: record ${i} has unknown field '${k}'`);
        }
        own++;
      }
      if (own < keys.length) {
        for (let m = 0; m < keys.length; m++) {
          if (!(keys[m] in rec)) {
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
      // through: float lanes DIRECT (NaN/-0/Infinity preserved), int lanes
      // keep their current mask semantics (range is B3's inference ladder).
      if (typeof v !== 'number') {
        if (strict) {
          raise('E_NON_NUMERIC', `lite-bake: record ${i} field '${f.name}' is not a number`);
        }
        v = 0;
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
  constructor(baked) {
    this.buffer    = baked.buffer;
    this.stride    = baked.stride;              // bytes
    this.count     = baked.count;
    this.strideF64 = baked.stride >> 3;
    this.strideF32 = baked.stride >> 2;
    this.strideU32 = baked.stride >> 2;
    this.strideU16 = baked.stride >> 1;

    this.dv  = new DataView(baked.buffer);
    this.f64 = new Float64Array(baked.buffer);
    this.f32 = new Float32Array(baked.buffer);
    this.i32 = new Int32Array(baked.buffer);
    this.u32 = new Uint32Array(baked.buffer);
    this.i16 = new Int16Array(baked.buffer);
    this.u16 = new Uint16Array(baked.buffer);
    this.u8  = new Uint8Array(baked.buffer);
    this.i8  = new Int8Array(baked.buffer);

    this._fields = Object.create(null);
    for (const f of baked.schema) this._fields[f.name] = f;
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

  /** Init/debug only — branches + string lookup, NOT for hot loops. */
  get(i, name) {
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

  /** Debug only — allocates a fresh object every call. Useful for console.log(reader.row(i)). */
  row(i) {
    const out = {};
    for (const name in this._fields) out[name] = this.get(i, name);
    return out;
  }
}

export const Types = { F32, F64, I32, I16, I8, U32, U16, U8 };
