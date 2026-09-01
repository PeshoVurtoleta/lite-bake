# get()/row() refuse an out-of-range index; the raw lane stays caller-owned

Status: accepted / Date: 2026-09-02 / Finding: BK-10 / Session: B2

## Context

Through 1.0.x, `Reader.get(i, name)` and `Reader.row(i)` did the address
arithmetic `i * stride + offset` on whatever `i` they were handed. Three
different wrong things happened depending on the value:

- `get(1, 'a')` on a count-1 table read row 1 -- which is padding, not data --
  and returned a plausible `0`. Padding read as a row.
- `get(0.5, 'a')` truncated through the typed-array/DataView index coercion and
  silently returned row 0's value. A fraction became a neighbour.
- `get(-1, 'a')` and `get(8, 'a')` (past the buffer) threw a raw `RangeError`
  with no `code` -- the same uncoded fault the write side spent B1 eliminating.

A reader could not tell "row 3 holds 0" from "row 3 does not exist". That is the
suite law violated: fail closed on every unverified state, null is not zero.

## Decision

One coded refusal. `get(i, name)` and `row(i)` throw `R_ROW_OUT_OF_RANGE` when
`i` is not an integer in `[0, count)` -- checked with
`!Number.isInteger(i) || i < 0 || i >= this.count` before any lookup or loop.
Non-integer, negative, past-count, and `2**53`-class indices all take the same
door with the same code. `get(0)`, `get(count-1)`, `row(count-1)` read exactly
as before; the check is one branch on the cold init/debug path and evaluates its
message string only on the throw.

The raw typed-array lane -- `f64[i * strideF64 + off]` and its siblings -- stays
unguarded BY DESIGN. That lane is the package's reason to exist: a zero-branch,
zero-instruction hot read. Bounds are the price of the raw lane; the caller who
takes the raw lane takes the bounds. `get`/`row` are the guarded, debug-tier
door for callers who want the check.

## Rejected: clamp the index

Clamping `i` into `[0, count)` (or returning a documented sentinel) is a second
silent-wrong-data policy, exactly the one B1's value doors were built to end.
`get(1)` returning row 0 on a count-1 table is not more true than returning
padding -- it is just harder to notice. A wrong row is wrong data.

## Rejected: guard the raw typed-array lane

Adding a bounds branch to `f64[i * strideF64 + off]` would cost the package its
reason to exist. There is no way to bounds-check a raw typed-array index without
a branch in the hot loop, and a branch in the hot loop is the instruction the
raw lane exists to avoid. The guarded door already exists (`get`/`row`); callers
who need it use it. The raw lane is documented as caller-owned and unguarded.

## Consequences

PATCH bump, 1.1.0 -> 1.1.1. Callers who relied on `get()` reading padding as a
zero row, on a fractional index truncating, or on catching a raw `RangeError`
by name now catch a `LiteBakeError` with `code === 'R_ROW_OUT_OF_RANGE'`. Callers
passing valid integer indices, and callers reading through the raw typed-array
lane, see no change at all.
