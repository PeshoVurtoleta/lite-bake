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
 *   opts.validate: boolean                          assert record shape uniformity (dev)
 */
export function bake(records, opts = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error('lite-bake: expected non-empty array of records');
  }
  const override = opts.schema || {};
  const keys = Object.keys(records[0]);

  if (opts.validate) {
    for (let i = 1; i < records.length; i++) {
      const r = records[i];
      for (let k = 0; k < keys.length; k++) {
        if (!(keys[k] in r)) {
          throw new Error(`lite-bake: record ${i} missing field '${keys[k]}'`);
        }
      }
      for (const k in r) {
        if (keys.indexOf(k) === -1) {
          throw new Error(`lite-bake: record ${i} has unknown field '${k}'`);
        }
      }
    }
  }

  const fields = keys.map(name => ({
    name,
    type: override[name] != null ? override[name] : inferType(records, name),
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
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      const addr = base + f.offset;
      const v = rec[f.name];
      switch (f.type) {
        case F32: dv.setFloat32(addr, +v || 0, LE);      break;
        case F64: dv.setFloat64(addr, +v || 0, LE);      break;
        case I32: dv.setInt32  (addr, v | 0,   LE);      break;
        case I16: dv.setInt16  (addr, v | 0,   LE);      break;
        case I8:  dv.setInt8   (addr, v | 0);            break;
        case U32: dv.setUint32 (addr, v >>> 0, LE);      break;
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
    if (!f) throw new Error(`lite-bake: unknown field '${name}'`);
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
    if (!f) throw new Error(`lite-bake: unknown field '${name}'`);
    if (f.type !== t) throw new Error(`lite-bake: field '${name}' has wrong type`);
    return f;
  }
  _require32(name) {
    const f = this._fields[name];
    if (!f) throw new Error(`lite-bake: unknown field '${name}'`);
    if (f.type !== U32 && f.type !== I32) throw new Error(`lite-bake: '${name}' is not 32-bit int`);
    return f;
  }
  _require16(name) {
    const f = this._fields[name];
    if (!f) throw new Error(`lite-bake: unknown field '${name}'`);
    if (f.type !== U16 && f.type !== I16) throw new Error(`lite-bake: '${name}' is not 16-bit int`);
    return f;
  }
  _require8(name) {
    const f = this._fields[name];
    if (!f) throw new Error(`lite-bake: unknown field '${name}'`);
    if (f.type !== U8 && f.type !== I8) throw new Error(`lite-bake: '${name}' is not 8-bit int`);
    return f;
  }

  /** Init/debug only — branches + string lookup, NOT for hot loops. */
  get(i, name) {
    const f = this._fields[name];
    if (!f) throw new Error(`lite-bake: unknown field '${name}'`);
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
