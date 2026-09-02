# bake() lays records out interleaved (array-of-structs); columnar SoA is parked

Status: accepted / Date: 2026-09-02 / Findings: BK-24 (retrofit) / Session: B5

## Context

A baked buffer holds N records, each with the same set of fields. There are two
ways to place them. Interleaved (array-of-structs, AoS): record 0's fields, then
record 1's fields, then record 2's, each record a contiguous run of `stride`
bytes. Columnar (struct-of-arrays, SoA): all of field `x` across every record,
then all of field `y`, then all of field `type`.

The choice is dictated by the access pattern, and lite-bake has one canonical
one: a game loop that touches MOST fields of record `i` per iteration -- read
`x`, `y`, `type`, `hp` of the same spawn point, do something, move to record
`i+1`. Under AoS all of record `i`'s fields share a cache line (an F64+U32+U8
record is well under 64 bytes), so the loop pays one cache miss per record and
the next record is often already prefetched. Under SoA the same loop strides
across four separate arrays, touching four distant cache lines per iteration to
assemble one record -- the exact pointer-chasing cost bake() exists to remove,
reintroduced in a different shape.

SoA wins for the opposite pattern: scanning ONE field across ALL records (sum
every `hp`, filter by `type`). That is a real pattern, but it is not the one this
package was built for, and no consumer has asked for it.

## Decision

Interleaved AoS, always. One record is one contiguous `stride`-byte run; the hot
loop reads `f32[i * strideF32 + off]` and gets the whole record from one cache
line. This is the layout the mermaid diagrams, the Reader offset model, and every
gate measure. A columnar SoA mode is PARKED -- deferred until a real workload
needs the single-field-scan pattern enough to justify a second layout.

## Rejected: shipping both layouts now

An AoS-or-SoA switch would double the surface that matters most: two hot-loop
contracts to document and teach, two offset models in the Reader, two sets of
layout laws in the torture tiers (t2), and two allocation profiles to gate --
all for a scan pattern no current consumer runs. The zero-GC hot loop is the
product; a second layout that no one exercises is test surface and doc weight
with zero demand behind it. When a consumer needs SoA, it gets its own session,
its own decision record, and its own gates -- not a speculative knob today.

## Consequences

No API change; this records the layout the package already ships. The AoS
contract is now a written decision rather than an implicit one, so a future SoA
proposal is a deliberate diff against a stated baseline, not a silent drift. The
parking is explicit: "not yet, and here is why" rather than "never" -- the door
stays open on evidence, closed on speculation.
