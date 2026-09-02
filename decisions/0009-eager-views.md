# Reader builds all 8 typed views eagerly in the constructor, after every door passes

Status: accepted / Date: 2026-09-02 / Findings: BK-24 (retrofit) / Session: B5

## Context

`new Reader(baked)` builds eight typed-array views (`f32`, `f64`, `i32`, `u32`,
`i16`, `u16`, `i8`, `u8`) plus one `DataView`, all over the same `ArrayBuffer`.
Eight views is not eight buffers: each is a small header (offset, length, a
reference to the shared buffer), so the whole set costs a constant ~600 bytes
regardless of record count -- the same for two records or two million.

The question is WHEN to build them. Eagerly, all nine in the constructor, or
lazily, each one on first access behind a getter or a null-check. The hot loop
reads a view thousands of times per frame, so any indirection on the accessor
path is paid per read, forever; a one-time construction cost is paid once.

There is a second constraint: a view must never exist over an unvalidated buffer.
The constructor is a coherence door (decisions/0002, /0003) -- it refuses an
incoherent `baked` (bad buffer/stride/count/length/schema) with a stable `R_*`
code. A view built before those checks would be a live typed array over bytes the
Reader has not vouched for.

## Decision

Eager. All eight views and the `DataView` are built in the constructor, ~600 B
constant, AFTER every coherence door has passed -- so no view ever exists over a
buffer the Reader has not validated. The accessor path is then a plain property
read (`r.f32`) with no branch, no getter, no lazy-init check: the hot loop reads
the view directly. Build cost is one-time and dwarfed by the buffer it views.

## Rejected: lazy per-lane getters

A getter (or a `this._f32 ||= new Float32Array(...)` on first touch) saves the
construction of lanes a given dataset never reads. But it puts a branch or a
getter-function indirection on EVERY access to that lane, including the millions
inside the hot loop -- taxing the one path that must stay bare to save a one-time
~600 B that is already negligible against the buffer. Wrong trade for this
package: the accessor is hot, the construction is cold.

## Rejected: build-on-first-use caching

Same cost profile as the getter (a presence check on the accessor path) with more
state to reason about -- a half-built Reader whose lane set depends on which
fields have been touched, complicating the "views only exist over a validated
buffer" invariant. It buys nothing the eager build does not already give at a
lower steady-state cost.

## Consequences

No API change; this records the construction strategy the Reader already ships.
The ~600 B one-time cost appears in the README zero-GC allocation table as
Reader construction, explicitly built only after the doors pass. A future
proposal to make views lazy is now a deliberate diff against a stated rationale:
the accessor path is hot and must stay branch-free.
