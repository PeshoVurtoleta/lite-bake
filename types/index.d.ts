/**
 * lite-bake -- Compile JSON arrays into flat interleaved binary for zero-GC reads.
 */

export type FieldTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Stable `code` carried by every LiteBakeError. E_* on the write side, R_* on the Reader side. */
export type BakeErrorCode =
  | 'E_INPUT'
  | 'E_NOT_A_RECORD'
  | 'E_EMPTY_RECORD'
  | 'E_NON_NUMERIC'
  | 'E_MISSING_FIELD'
  | 'E_UNEXPECTED_FIELD'
  | 'E_UNKNOWN_OPTION'
  | 'E_OPTION_VALUE'
  | 'E_OPTION_CONFLICT'
  | 'E_UNKNOWN_FIELD'
  | 'E_BAD_TYPE'
  | 'E_UNSAFE_INTEGER'    // an all-integer column reaches past +/-(2^53-1) -- override to F64 to accept precision loss
  | 'E_LANE_MISMATCH'     // a number cannot be represented exactly by the field's integer lane (out of range, fractional, or non-finite)
  | 'R_UNKNOWN_FIELD'
  | 'R_WRONG_TYPE'
  | 'R_INPUT'             // baked/meta is not a non-null object, or buffer/bytes is not an accepted binary type
  | 'R_BAD_STRIDE'       // stride is not a positive integer, or is not a multiple of the schema's max lane alignment
  | 'R_BAD_COUNT'        // count is not a non-negative integer
  | 'R_BAD_LENGTH'       // buffer byteLength is not a multiple of 8
  | 'R_TRUNCATED'        // count rows at stride bytes do not fit in the buffer
  | 'R_BAD_SCHEMA'       // schema is not a non-empty array of well-formed, aligned, in-stride, non-overlapping fields
  | 'R_ROW_OUT_OF_RANGE'; // get()/row() index is not an integer in [0, count)

/** Error thrown by every bake()/Reader refusal; the `code` is the stable contract. */
export class LiteBakeError extends Error {
  readonly name: 'LiteBakeError';
  readonly code: BakeErrorCode;
  constructor(code: BakeErrorCode, message: string);
}

export interface Types {
  readonly F32: 0;
  readonly F64: 1;
  readonly I32: 2;
  readonly I16: 3;
  readonly I8:  4;
  readonly U32: 5;
  readonly U16: 6;
  readonly U8:  7;
}
export const Types: Types;

export interface Field {
  name: string;
  type: FieldTypeCode;
  offset: number;           // byte offset within one record
}

export interface Baked {
  buffer: ArrayBuffer;
  stride: number;           // bytes per record (padded to max field alignment)
  count: number;            // number of records
  schema: readonly Field[];
}

/** Metadata needed to reconstruct a Reader from raw bytes via Reader.fromBytes. */
export interface BakedMeta {
  stride: number;
  count: number;
  schema: readonly Field[];
}

export interface BakeOptions {
  /**
   * Override inferred types per field. Missing entries are still inferred. An
   * int-lane override refuses values the lane cannot represent exactly
   * (E_LANE_MISMATCH).
   */
  schema?: Record<string, FieldTypeCode>;
  /**
   * Explicit synonym of the strict default: assert that every record has exactly
   * the same keys as record 0, and also refuse non-numeric values (E_NON_NUMERIC).
   * Kept so 1.0.x call sites keep working and now mean what they say. Conflicts
   * with `coerce` (E_OPTION_CONFLICT). Default behavior is already strict.
   */
  validate?: boolean;
  /**
   * Restore 1.0.x leniency: non-number values (strings, booleans, null,
   * undefined, objects) and absent fields store as 0, and extra fields are
   * dropped, instead of refusing. Numbers are never coerced in any mode, so
   * NaN/-0/Infinity are still preserved in float lanes. Conflicts with
   * `validate: true` (E_OPTION_CONFLICT).
   */
  coerce?: 'zero';
}

/**
 * Compile an array of homogeneous records into a flat ArrayBuffer.
 * Throws if `records` is empty or not an array. Integer columns beyond
 * +/-(2^53-1) refuse E_UNSAFE_INTEGER unless overridden to F64.
 */
export function bake(records: ReadonlyArray<Record<string, unknown>>, opts?: BakeOptions): Baked;

export class Reader {
  /**
   * Trusts nothing: refuses an incoherent `baked` with a stable R_* code BEFORE
   * constructing any view (baked shape -> R_INPUT; buffer not an ArrayBuffer ->
   * R_INPUT; bad stride -> R_BAD_STRIDE; bad count -> R_BAD_COUNT; byteLength not
   * a multiple of 8 -> R_BAD_LENGTH; rows do not fit -> R_TRUNCATED; malformed
   * schema -> R_BAD_SCHEMA). The schema is snapshotted, so later caller mutation
   * cannot move a field after validation. A frozen valid baked object constructs.
   */
  constructor(baked: Baked);

  /**
   * Reconstruct a Reader from on-disk bytes, honoring byteOffset/byteLength.
   * Accepts pooled/offset views (a Node Buffer from readFileSync is safe) and
   * copies only when the view does not span its whole backing buffer; an
   * ArrayBuffer or a full-span Uint8Array is used zero-copy. Anything else
   * (DataView, other TypedArray, string, null) refuses R_INPUT. The resolved
   * buffer runs the SAME coherence doors as the constructor.
   */
  static fromBytes(bytes: ArrayBuffer | Uint8Array, meta: BakedMeta): Reader;

  readonly buffer: ArrayBuffer;
  readonly stride: number;           // bytes
  readonly count: number;

  /** Stride in 64-bit-float units. Use with `f64[i * strideF64 + off]`. */
  readonly strideF64: number;
  /** Stride in 32-bit (float or int) units. */
  readonly strideF32: number;
  readonly strideU32: number;
  /** Stride in 16-bit units. */
  readonly strideU16: number;

  readonly dv:  DataView;
  readonly f64: Float64Array;
  readonly f32: Float32Array;
  readonly i32: Int32Array;
  readonly u32: Uint32Array;
  readonly i16: Int16Array;
  readonly u16: Uint16Array;
  readonly u8:  Uint8Array;
  readonly i8:  Int8Array;

  /** Byte offset within a single record. Works for any field type. */
  offsetBytes(name: string): number;

  /** Offset in 64-bit-float units. Field must be declared/inferred as F64. */
  offsetF64(name: string): number;
  /** Offset in 32-bit-float units. Field must be declared/inferred as F32. */
  offsetF32(name: string): number;

  /** Offset in 32-bit units for I32 or U32 fields. */
  offsetI32(name: string): number;
  offsetU32(name: string): number;

  /** Offset in 16-bit units for I16 or U16 fields. */
  offsetI16(name: string): number;
  offsetU16(name: string): number;

  /** Byte offset for I8/U8 fields (they're already in byte units). */
  offsetI8(name: string): number;
  offsetU8(name: string): number;

  /**
   * Init/debug only -- branches and does a string lookup. Not for hot loops.
   * `i` must be an integer in [0, count) or it throws R_ROW_OUT_OF_RANGE (one
   * bounds policy: no silent padding read, no fractional truncation, no raw
   * RangeError). The raw typed-array lane is caller-owned and stays unguarded.
   */
  get(i: number, name: string): number;

  /**
   * Debug only -- allocates a plain object per call. Useful for `console.log`.
   * `i` must be an integer in [0, count) or it throws R_ROW_OUT_OF_RANGE.
   */
  row(i: number): Record<string, number>;
}
