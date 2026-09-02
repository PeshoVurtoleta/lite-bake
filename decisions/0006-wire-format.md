# lite-bake ships no wire format: LBK1 is the suite's container, and the raw lane says so out loud

Status: accepted / Date: 2026-09-02 / Findings: BK-05 (no-magic half) BK-14 BK-26 / Session: B4

## Context

The README's "serialize the baked buffer to disk" recipe has two halves of one
hazard. B2 fixed the first: a pooled `readFileSync` Buffer (nonzero `byteOffset`)
fed to `new Reader({ buffer: buf.buffer, ... })` read the pool head, so `1234.5`
came back as junk. `Reader.fromBytes(bytes, meta)` honors `byteOffset` and the
recipe was rewritten onto it. The second half remained open: a wrong FILE is
undetectable. `fromBytes` runs the constructor's coherence doors, which check
SHAPE (stride, count, buffer length, schema alignment) -- so a wrong SHAPE
refuses, but a wrong-content buffer of the right shape reads back plausible
garbage with no complaint. There is no magic and no marker to detect it.

BK-14: the baked bytes are native-endian and carry no byte-order marker. The old
README line -- "Round-trips work on both LE (99.99% of hardware) and BE" --
conflated an in-process bake-and-read (which works on either endianness) with a
cross-machine transfer (which does not: a buffer baked on one endianness reads
silently wrong on the other).

BK-26: the sibling `@zakkster/lite-bake-stream` names this package as a
destination for its data, while this package never stated the relationship. And
the old README roadmap promised a SECOND wire format from this package
(`serialize()` / `deserialize()`, "a self-describing container with the schema
embedded"). Two roadmaps drifting toward a collision.

The measured cross-package evidence at the published sibling 1.6.0 (t8 now pins
all of it): there is no API interop in either direction -- neither package reads
the other's format through its public API. Hand-parsing the LBK1 container and
carving its shard payload, this package's `Reader.fromBytes` reads the F64 lanes
cell-for-cell in agreement (6/6 across the fixed corpus at row stride 24). The
U32 lane diverges by design: this package reads the raw string-table INDEX (a
number); the sibling's reader resolves the interned STRING. The lane-code tables
diverge too: wire `lane_kind` F64=1 is the ONLY shared code point (wire U32=3 vs
`Types.U32`=5; LBK1 assigns 2/3/4 to F32/U32/U8 where `Types` assigns 2/3/4 to
I32/I16/I8). Note: the published sibling SPEC still carries a
"lane-values-match-`Types`" claim; that is corrected in the sibling's
authored-but-unreleased M7 (BS-29), where the relationship is restated as exactly
what t8 proves -- the F64 lane-width agreement. Sibling-side facts are recorded
here, never patched from this package.

## Decision

Option A, delegate, sharpened. There is ONE wire format in the suite: LBK1, owned
by the sibling. This package mints no format, no magic, no new API, no new error
codes; `src/` and `types/` are byte-identical this session.

The raw `Reader.fromBytes` lane STAYS as the exact-layout persistence seam --
caller-owned bytes plus external `meta` -- with its two hazards now documented in
bold: it is content-blind by design (SHAPE is checked, CONTENT is not, so a wrong
file or wrong `meta` reads back plausible garbage), and it is native-endian, so
it is not portable across endianness.

SCOPE NUANCE, stated plainly: LBK1 v1's numeric lanes are F64-only (plus the U32
string-table index; F32/U8 reserved, extended I64 lanes reserved for v2). LBK1 is
therefore NOT a container for arbitrary eight-lane baked layouts -- the raw lane
exists for exactly that job. "All persistence goes through LBK1" is NOT claimed.

BK-14 lands as documentation: the raw lane is same-endianness only; LBK1 is the
portable, little-endian-specified container.

The DONE-WHEN argument: after this session no DOCUMENTED path misreads silently.
The raw lane's non-detection is a stated contract, demonstrated true by an
executable t8 pin (a shape-plausible wrong read constructs and visibly misreads
inside the gate). The wrong-file-DETECTING container (magic at both ends, strict
decode, optional CRC-32C) exists in-suite one devDep away. t8 pins the boundary
permanently: lane parity, lane-code divergence, U32 semantics, the wrong-file
misread, and the docs stanzas themselves.

## Rejected: a mini-header format (Option B)

A second wire format in the suite is the exact invented-work collision BK-26
warned about. It would re-invent magic, versioning, CRC, and forward-compat seams
the sibling has already frozen (LBK1 reserves F32/U8 lane kinds and extended I64
lanes for exactly the growth a header would chase). And a self-describing header
contradicts `bake()`'s identity: its output is a live in-memory object, not a
file format.

## Rejected: status quo documented (Option C alone)

Documenting the hazards but leaving the `serialize()` / `deserialize()` promise
alive, and the ecosystem question unanswered, keeps the two roadmaps drifting
toward a collision. Option A subsumes C's documentation duties and additionally
answers the ownership question.

## Rejected: adopting LBK1 code points into Types

Renumbering `Types` to match the wire (or vice versa) breaks every persisted
`meta` JSON and every pinned test, for zero benefit. The divergence is harmless
once PINNED as deliberate (t8), because no byte crosses between the formats by
API.

## Rejected: an in-package LBK1 reader

Glue that duplicates readers the sibling already ships (`Reader`, `RangeReader`,
`MultiReader`). It would freeze this package to the sibling's format evolution and
violate the session's no-second-surface rule. The NON-GOALS line already bars the
writer; the reader falls with it.

## Consequences

v1.3.0 -- a MINOR bump per the roadmap's pre-assigned budget: this is the release
that ANSWERS the old README v1.3 `serialize()` promise, by DECIDING, not by
shipping it. The pack changes are docs-only plus the dev-only gate; there is no
API or behavior change, and the pack stays seven files.

Who this affects: nobody's code. Callers of the raw lane get honest, bold
hazards; callers who need detection or portability get a named in-suite path.

Future convergence (for example LBK1 gaining F32/U8 lanes, or an I64 lane on
either side) is a deliberate diff against t8's pins, not drift.
