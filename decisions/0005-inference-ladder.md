# bake() infers the smallest lane that holds a column EXACTLY; it never wraps

Status: accepted / Date: 2026-09-02 / Findings: BK-01 BK-02 (+BK-29 drift-door rider) / Session: B3

## Context

Through 1.1.x, `inferType` had two bottomless fallbacks. On the integer side it
picked `U32`/`I32` and stopped: a column reaching `2**32` was still called `U32`
and the write loop's `>>> 0` silently wrapped it to `0` (BK-01). On the float
side it had exactly one rung -- any non-integer column became `F32` -- so `0.1`,
`20000001.5`, and every other double `F32` cannot represent exactly landed in a
4-byte lane and read back changed (BK-02). Both are the same bug wearing two
hats: a lane was chosen that the value does not fit, and the mask made the
mismatch silent. That is the failure decisions/0001 exists to end, one level up:
0001 stopped `bake()` storing a wrong *type* faithlessly; the wrong *range* and
wrong *precision* were explicitly deferred here.

`F32` cannot be the float catch-all, because `F32` is the SMALLER float. A
"smallest type that fits" rule that never widens past `F32` does not fit -- it
truncates. And an integer ladder with no ceiling does not fit either -- it wraps.

A separate asymmetry surfaced while auditing the strict drift door (BK-29): the
door tested field membership with the `in` operator, which walks the prototype
chain. A record missing its own `constructor` field (one that record 0 declared)
would find the inherited `Object.prototype.constructor`, pass the membership
check, and then fail one step later at the value door as `E_NON_NUMERIC` -- the
wrong code for what is really a missing field. The keyset contract is own keys;
the door was reading inherited ones.

## Decision

### The ladder (one pass per column, zero allocation)

Scan every value in the column once. `typeof v !== 'number'` is skipped (a type
question, owned by 0001's value door). A non-finite number (`NaN`, `+/-Infinity`)
sets a `sawNonFinite` flag and is otherwise skipped. A finite number feeds four
trackers: `sawNumber`, `allInt` (`Number.isInteger`), `min`/`max`, and
`allFround` (`Math.fround(v) === v`).

Rung selection after the scan:

- **No finite number seen** (`!sawNumber`) -> `F32`. This is the unchanged
  fallback: an empty column, an all-non-number column, or an all-non-finite
  column (`[NaN]`) rides `F32`, which preserves `NaN`/`Infinity` exactly.
- **A non-finite value present** -> the FLOAT rung, regardless of `allInt`. A
  column carrying `NaN` or `Infinity` can never take an integer lane: `[1, NaN]`
  used to infer `U8` and zero the `NaN`. Now it takes the float rung and keeps it.
- **All integers, no non-finite** -> the INTEGER rung:
  - `min >= 0`: `U8` (`max <= 0xff`), `U16` (`max <= 0xffff`), `U32`
    (`max <= 0xffffffff`).
  - `min < 0`: `I8` (`-0x80..0x7f`), `I16` (`-0x8000..0x7fff`), `I32`
    (`-0x80000000..0x7fffffff`).
  - Past the 32-bit lanes: `F64` if `Number.isSafeInteger(min)` and
    `Number.isSafeInteger(max)` -- an `F64` holds every integer up to
    `+/-(2^53-1)` exactly. Beyond that, `E_UNSAFE_INTEGER`.
  - ALL boundary tops are INCLUSIVE: `0xffffffff` -> `U32`, `-(2**31)` and
    `2**31-1` -> `I32`, `+/-(2^53-1)` -> `F64`, `+/-(2^53)` -> refused.
- **The float rung**: `F32` if `allFround` (every value survives the
  `Math.fround` round-trip), else `F64`.

### The fit door (the write loop, all int lanes)

Inference chooses a fitting lane, but an explicit `opts.schema` override does
not. So the write loop gained one door on the int lanes (type codes `2..7`),
after 0001's non-number door and before the store: a number that is fractional,
out of the lane's range, or non-finite refuses `E_LANE_MISMATCH` in ALL three
modes -- numbers are never coerced (decisions/0001). A coerced `0` (a non-number
under `coerce: 'zero'`) is an integer inside every lane and passes trivially.
Behind this door the store masks (`| 0`, `>>> 0`, `& 0xffff`, `& 0xff`) are
provably exact, never a silent wrap.

The 0001 integer-lane table, its deferred rows now filled:

| value class | default | coerce: 'zero' | validate: true |
| --- | --- | --- | --- |
| in-range integer | exact (provably, behind the fit door) | exact | exact |
| out-of-range / fractional / non-finite number in an int lane | E_LANE_MISMATCH | E_LANE_MISMATCH | E_LANE_MISMATCH |
| non-number in an int lane | E_NON_NUMERIC | stored as 0 | E_NON_NUMERIC |

(The last row is unchanged from 0001: it is a type question. The fit door sits
strictly after it, so a string into an int lane is `E_NON_NUMERIC`, never
`E_LANE_MISMATCH`.)

### The E_UNSAFE_INTEGER asymmetry (inference path only)

`E_UNSAFE_INTEGER` fires only on the inference path -- never on an override.
`[2**60]` refuses: it is an all-integer column, so it carries integer-identity
semantics, and a received `2^60` is upstream-ambiguous (the double `2^60` stands
for a whole ULP-band of integers, and no wider integer lane exists to hold the
one that was meant). `[0.5, 2**60]` does NOT refuse: the `0.5` makes it a FLOAT
column, which carries double semantics, so `2^60` is simply the exact double it
is and stores in `F64` verbatim. A column is what its values make it; the same
magnitude is ambiguous as an integer and unambiguous as a double.

A lone huge integer-valued double (`1e39`) is `Number.isInteger`-true, so it is
an integer column beyond `+/-(2^53-1)` and refuses, exactly like `2^60`. Only in
a float column (`[0.5, 1e300]`) does a huge double stay `F64` exact.

### Non-finite forces the float rung

Restated because it is load-bearing: any `NaN`/`Infinity` in a column bars every
integer lane. This is what closes the `[1, NaN]` -> `U8` -> zeroed-`NaN` silent
data loss.

### BK-29: own-key semantics at the drift door

Both drift walks (the extra-key count and the missing-key check) now guard with
`Object.prototype.hasOwnProperty.call(rec, k)`, matching the two other own-key
walks in the file. An absent own prototype-named field now refuses
`E_MISSING_FIELD`, not `E_NON_NUMERIC`. The keyset contract is own-ENUMERABLE
keys, symmetric for record N. This is manifestation 1. Manifestation 2 -- a
record crafted with `Object.defineProperty` to make a prototype name a
non-enumerable own property -- sits OUTSIDE the contract boundary: the keyset is
built from `Object.keys(record[0])` (own enumerable), and a non-enumerable own
field is not part of it, by the same definition on both sides.

## Rejected: clamp at write (saturate out-of-range instead of wrapping)

Already rejected in 0001 and rejected again here. Clamping `2**32` to
`0xffffffff` is a second silent-wrong-data policy: it is no more true than
wrapping to `0`, only less obviously false, which makes it harder to find. The
fix is picking a lane that fits, not bending the value to the lane.

## Rejected: document the wrap

Keeping the wrap and writing it down ("values past 2^32 wrap; that is your
problem") is the 1.0.x contract that produced BK-01. A binary buffer that no
longer remembers `2**32` went in is silently-wrong data regardless of a README
paragraph. Fail closed: widen to `F64`, or refuse.

## Rejected: a safe-integer door on the float rung

The unsafe-integer refusal belongs only to the INTEGER rung. Applying a
safe-integer check on the float rung would refuse `1e300` in a float column --
where the double IS the value and stores exactly. A float column carries double
semantics; there is nothing ambiguous to refuse.

## Rejected: a BigInt lane

A true 64-bit or arbitrary-precision integer lane would hold `2**60` losslessly.
It is a non-goal: no consumer asks for it, `BigInt` does not ride a `TypedArray`
without `BigInt64Array` (a different read model and a per-element boxing cost),
and the escape hatch already exists -- override to `F64` to accept documented
precision loss.

## Consequences

MINOR bump, 1.1.1 -> 1.2.0. The ladder is additive as an API (same signature,
same return shape) but the inferred LAYOUT widens for out-of-envelope inputs: a
column that used to infer `F32`/`U32` may now infer `F64`, changing stride and
offsets, and inputs that used to bake now throw (`E_UNSAFE_INTEGER`,
`E_LANE_MISMATCH`).

Who breaks: callers who relied on integers past `2**32` wrapping, on doubles
snapping to `F32`, or on out-of-range values riding an overridden int lane.
Callers baking in-envelope uniform numeric records -- the documented use -- see
the same lanes as before, now provably exact.

Migration: re-bake (offsets/stride may have widened, so persisted buffers must
be regenerated); override a column to `F64` to accept an unsafe integer with
documented precision loss; `coerce: 'zero'` never softens a number-fit failure
(numbers are never coerced), so a caller depending on the old wrap must round or
clamp in their own data before `bake()`.
