# Reader.fromBytes accepts ArrayBuffer | Uint8Array and copies only when it must

Status: accepted / Date: 2026-09-02 / Finding: BK-05 / Session: B2

## Context

The README FAQ told callers to persist a baked dataset by writing
`new Uint8Array(baked.buffer)` to a file and reconstructing the Reader from the
bytes read back. On Node, `fs.readFileSync` for a small file returns a `Buffer`
that is a VIEW into a shared internal pool -- `byteOffset` is often nonzero and
`buffer` is much larger than the file. The natural reconstruction
`new Reader({ buffer: buf.buffer, ... })` handed the Reader the whole pool,
starting at offset 0: it read the pool's head, not the file's bytes. `1234.5`
came back as junk, and with no format/magic nothing detected the misread.

There was no entry point that honored `byteOffset`. The recipe was a trap.

## Decision

Add `Reader.fromBytes(bytes, meta)`. It accepts an `ArrayBuffer` or a
`Uint8Array` (a Node `Buffer` IS a `Uint8Array`) and resolves the backing buffer
honestly:

- an `ArrayBuffer` -> used as-is (zero-copy);
- a `Uint8Array` spanning its ENTIRE backing buffer
  (`byteOffset === 0 && byteLength === buffer.byteLength`) -> `bytes.buffer`
  used directly (zero-copy);
- any other `Uint8Array` (pooled or offset view) -> the viewed range is COPIED
  into a fresh `ArrayBuffer` of exactly `bytes.byteLength`.

The resolved buffer is handed to the constructor, which is the ONLY validation
site; `fromBytes` adds zero duplicated checks. Invariant, pinned in tests:
`reader.buffer` never exposes bytes outside the dataset, so the write-back
recipe `new Uint8Array(reader.buffer)` stays safe on a reconstructed Reader.

Anything that is not an `ArrayBuffer` or a `Uint8Array` (a `DataView`, a
`Float32Array`, a string, `null`) refuses with `R_INPUT` naming what it got, and
a non-object `meta` refuses `R_INPUT`. This is the recipe half of BK-05; the
no-magic half -- detecting a WRONG FILE rather than a wrong SHAPE -- rides B4.

## Rejected: offset-threaded views (no copy for pooled buffers)

Store `byteOffset` and construct the eight views over the shared buffer at that
offset, to save the one cold-path copy. This re-exposes the surrounding pool
through `reader.buffer` -- the exact BK-05 disease reborn: `new Uint8Array(
reader.buffer)` would serialize the neighbouring pool bytes, not the dataset.
The copy costs one allocation once, at reconstruction time, off any hot path,
and it severs the source so the invariant holds. Honesty beats a saved copy.

## Rejected: accept every TypedArray

Accepting any TypedArray (an `Int32Array`, a `DataView`) as `bytes` invites a
caller to pass a view whose element width silently reinterprets the range. The
documented recipe writes and reads a `Uint8Array` of raw bytes; that is the one
binary shape `fromBytes` promises to honor. Everything else fails closed with
`R_INPUT`.

## Consequences

PATCH bump. Additive: `Reader.fromBytes` and `BakedMeta` are new surface; no
existing call changes. The FAQ recipe is rewritten onto `fromBytes`, and the
old raw-`.buffer` reconstruction is documented as unsafe on pooled reads.
