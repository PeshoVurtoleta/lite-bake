# stride = max field alignment; the false 4-byte-minimum doc line dies

Status: accepted / Date: 2026-09-02 / Finding: BK-12 / Session: B2

## Context

The README "Edge cases" section claimed: "An all-U8 schema gets stride padded to
4 (the minimum)." The code has no such minimum. `bake()` pads the stride to the
LARGEST field alignment and nothing else, so three `U8` fields yield stride 3,
not 4. Docs and code disagreed; one side had to move. The layout tier
(`checkLayout`, t2) pins "stride is a multiple of the max field alignment" as an
invariant over 200+ random schemas -- it is the code's actual, tested contract.

## Decision

The DOC moves; the code does not. `stride` = max field alignment is the
invariant. An all-`U8` table has max alignment 1, so its stride equals the field
count in bytes (three `U8` fields -> stride 3). The README line is corrected to
state this, and it now also documents the consequence: `strideF32` and
`strideU32` are computed by integer right-shift (`stride >> 2`) and are therefore
`0` on any sub-4-byte stride, so on such a table you read through `r.stride` and
the `u8` lane, never the F32/U32 shift lanes.

## Rejected: implement the 4-byte minimum

Forcing every stride up to at least 4 would change the byte layout of every
sub-4-byte table (all-`U8`, `U8`+`U8`, a lone `U16`) for zero benefit: there is
no aligned lane wider than the fields present, so the padding buys no alignment
and no faster read -- it only wastes 1..3 bytes per row on the smallest tables,
the ones most likely to be large in count. It would also break byte-compatibility
of every baked buffer already written under the real (max-alignment) rule. The
doc was wrong; making the code match a wrong doc is the wrong repair.

## Consequences

Documentation-only change on the code side (no `bake()` bytes move -- that half
is untouched this session). The corrected README/llms.txt tell the truth the
layout tier already enforces. Callers of sub-4-byte tables who read the false
line and reached for `strideF32` now have the `r.stride` + `u8` guidance spelled
out.
