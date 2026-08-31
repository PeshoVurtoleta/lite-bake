/**
 * lite-bake — Compile JSON arrays into flat interleaved binary for zero-GC reads.
 */

export type FieldTypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

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

export interface BakeOptions {
  /** Override inferred types per field. Missing entries are still inferred. */
  schema?: Record<string, FieldTypeCode>;
  /**
   * Assert that every record has exactly the same keys as record 0.
   * Dev/QA only — has O(n * fields) cost. Default: false.
   */
  validate?: boolean;
}

/**
 * Compile an array of homogeneous records into a flat ArrayBuffer.
 * Throws if `records` is empty or not an array.
 */
export function bake(records: ReadonlyArray<Record<string, unknown>>, opts?: BakeOptions): Baked;

export class Reader {
  constructor(baked: Baked);

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

  /** Init/debug only — branches and does a string lookup. Not for hot loops. */
  get(i: number, name: string): number;

  /** Debug only — allocates a plain object per call. Useful for `console.log`. */
  row(i: number): Record<string, number>;
}
