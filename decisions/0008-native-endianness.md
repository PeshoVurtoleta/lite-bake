# bake() writes native byte order; the portable path is LBK1, spec'd little-endian

Status: accepted / Date: 2026-09-02 / Findings: BK-24 (retrofit) / Session: B5 / Cross-refs: BK-14, decisions/0006

## Context

`bake()` writes each value into the buffer through a `DataView` with an explicit
`littleEndian` flag detected once at module load. The READ side is different: a
`TypedArray` view (`f32[i]`, `u8[i]`) always reads in the platform's NATIVE byte
order, by the ECMAScript spec -- there is no endianness knob on a typed array.
So the write flag is set to match native order, and the in-process round-trip
(bake then read on the same machine) is exact on any endianness.

The consequence is that the baked BYTES are native-endian and carry no byte-order
marker. A buffer baked on a little-endian machine, shipped to a big-endian one,
and read through the same typed-array lanes reads silently wrong -- there is no
magic and nothing to detect the mismatch. Since decisions/0006 this is stated out
loud: `Reader.fromBytes` is the raw exact-layout lane, same-endianness BY
CONTRACT, and the suite's portable path is the LBK1 container (owned by
`@zakkster/lite-bake-stream`), which is specified little-endian and self-describes
with magic at both ends.

## Decision

Native byte order for the in-memory buffer. The zero-instruction hot loop --
`f32[i * strideF32 + off]` with no per-read transform -- IS the package; native
reads are what make it zero-instruction. `Reader.fromBytes` is same-endianness by
contract, and callers who need to move bytes between machines use LBK1, the
little-endian-specified, self-describing container. lite-bake mints no wire
format of its own (decisions/0006).

## Rejected: byteswap-on-read

Reading through a `DataView` with an explicit endianness on every field access
would make the buffer portable, but it puts a per-read branch and a swap on the
one lane whose entire value is that it has neither. That is a cost paid by 100%
of reads to serve the fraction of a percent of hardware that is big-endian, on a
path that is explicitly the raw same-machine escape hatch. The portable answer
already exists one package over.

## Rejected: canonical little-endian storage plus a big-endian load-time swap pass

Storing always-LE and swapping the whole buffer once at load on a BE host keeps
the hot loop native AND makes bytes portable. It was still rejected: it adds a
second code path (a full-buffer swap pass) and a second storage contract, both
exercised only on ~0% of real hardware, and it duplicates -- badly -- what LBK1
already does correctly and self-describingly. Complexity for a case the ecosystem
already answers is not worth carrying here.

## Consequences

No API change; this records the byte-order contract the package already ships and
0006 already narrates. The native-endianness hazard is now a written decision
with its rejected alternatives, so the raw lane's "same-endianness by contract"
line is backed by a stated rationale. Callers moving data across machines are
pointed, consistently across README, llms.txt, and here, at LBK1.
