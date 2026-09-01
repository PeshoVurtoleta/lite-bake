# bake() refuses any value it cannot store faithfully; leniency is opt-in

Status: accepted / Date: 2026-09-01 / Findings: BK-03 BK-04 BK-06 BK-13 (+BK-18 vocabulary) / Session: B1

## Context

Through 1.0.x, `bake()` stored something for every input. A string became 0
(`+v || 0`). `true` became 1. A missing key became 0. An extra key was dropped
without a word unless `validate: true` was set, and even then `validate` only
compared key sets -- it never looked at a value. In the float lanes the same
`+v || 0` also destroyed three legitimate IEEE-754 values: `NaN`, `-0`, and
`+/-Infinity` all landed as `+0` (Infinity survived by accident of truthiness;
NaN and -0 did not).

The result was a library whose failure mode is silently wrong data in a binary
buffer that no longer remembers what it came from. A reader gets `0` and cannot
distinguish "the value was zero", "the value was a string", "the field was
absent", and "the value was NaN". That violates the suite law: fail closed on
every unverified state, null is not zero.

The fix is a door, not a heuristic. `bake()` is an init-time call -- it is
already the cold path -- so refusal costs nothing in the hot loop, and the
write loop keeps exactly one `typeof` test where each silent mask stood.

## Decision

Three modes. `default` is strict. `validate: true` is an explicit synonym of
the strict default, kept so 1.0.x call sites that already ask for checking keep
working and keep meaning what they say. `coerce: 'zero'` is the documented
escape hatch that reproduces 1.0.x leniency on purpose. `validate: true`
together with `coerce: 'zero'` is a contradiction and is refused at the opts
prologue with `E_OPTION_CONFLICT`.

The keyset is the key set of record 0 (its own enumerable string keys, as
today), in every mode. Record 0 declares the schema; later records are
measured against it. The drift door keeps the 1.0.x `validate` lookup
semantics (enumerable keys, `in`-style membership), now on by default.

### Float lanes (F32, F64) and record shape

| value class (as seen at write time) | default (strict) | coerce: 'zero' | validate: true |
| --- | --- | --- | --- |
| finite number | stored exactly | stored exactly | stored exactly |
| `NaN` | stored as NaN | stored as NaN | stored as NaN |
| `-0` | stored as -0 | stored as -0 | stored as -0 |
| `Infinity` / `-Infinity` | stored as +/-Infinity | stored as +/-Infinity | stored as +/-Infinity |
| string, boolean, object, symbol, bigint | `E_NON_NUMERIC` | stored as +0 | `E_NON_NUMERIC` |
| `null` (key present) | `E_NON_NUMERIC` | stored as +0 | `E_NON_NUMERIC` |
| `undefined` (key present) | `E_NON_NUMERIC` | stored as +0 | `E_NON_NUMERIC` |
| key absent from record N | `E_MISSING_FIELD` | stored as +0 | `E_MISSING_FIELD` |
| extra key in record N | `E_UNEXPECTED_FIELD` | dropped silently | `E_UNEXPECTED_FIELD` |
| record N is not a non-null, non-array object | `E_NOT_A_RECORD` | `E_NOT_A_RECORD` | `E_NOT_A_RECORD` |
| record 0 has zero own keys | `E_EMPTY_RECORD` | `E_EMPTY_RECORD` | `E_EMPTY_RECORD` |

`E_NOT_A_RECORD` and `E_EMPTY_RECORD` are structural, not value policy: there
is no record to be lenient about, so `coerce: 'zero'` does not soften them.
Fail closed on every unverified state.

Storing numbers exactly is what kills `+v || 0`. `NaN`, `-0` and `Infinity`
are values a physics or animation table legitimately carries; flattening them
to `+0` is data loss dressed up as robustness (BK-03).

### Integer lanes (I32, I16, I8, U32, U16, U8) -- DEFERRED TO B3

| value class | default | coerce: 'zero' | validate: true |
| --- | --- | --- | --- |
| in-range integer | exact, unchanged | exact, unchanged | exact, unchanged |
| out-of-range integer | wraps (`\|0`, `>>> 0`, `& 0xffff`, `& 0xff`) -- UNCHANGED, B3 | wraps -- UNCHANGED, B3 | wraps -- UNCHANGED, B3 |
| fractional/NaN/Infinity number reaching an int lane | truncates/zeroes -- UNCHANGED, B3 | truncates/zeroes -- UNCHANGED, B3 | truncates/zeroes -- UNCHANGED, B3 |
| non-number in an int lane | `E_NON_NUMERIC` | stored as 0 | `E_NON_NUMERIC` |

The non-number door is uniform across all lanes -- it is a type question, and
B1 owns type questions. Range and precision are inference questions: the wrap
at `2**32` and the F32 precision loss are BK-01 and BK-02, and the correct fix
is the inference ladder, which is session B3's subject. Closing them here would
change what `inferType` is allowed to pick while B3 is still deciding it, and
would flip the BK-01 and BK-02 todos before the session that owns them exists.
Those two todos must still reproduce at the end of B1. The rows above are
written down so B3 inherits a table, not a memory.

## Rejected: no leniency escape hatch (strict only)

Cleanest table, and wrong. 1.0.x documented the lenient behavior (README's
inference table and edge-case sections; llms.txt's "values come back as 0"
row), so consumers built on it deliberately. A strict-only 1.1.0 is a MAJOR
break wearing a MINOR number and it strands those callers with no one-line
migration. `coerce: 'zero'` costs one opts branch in the cold path and turns a
break into an opt-in. No sibling package carries a leniency opt -- this is a
suite-first surface, added here deliberately and recorded here.

## Rejected: keep `+v` coercion, just add the checks

`+v` maps `true` to 1, `'42'` to 42, `[]` to 0 and `['7']` to 7. Every one of
those is a plausible bug in the caller's data pipeline being laundered into a
plausible-looking number in a binary buffer. `true` becoming a valid-looking
`1` in a damage column is precisely the failure this decision exists to end.
If a caller wants numbers from strings, `Number()` at their boundary is one map
away and is visible in their code.

## Rejected: clamp at write (saturate out-of-range instead of wrapping)

Forbidden by the roadmap, and rightly. Clamping is a second silent-wrong-data
policy: `2**32` becoming `0xffffffff` is no more true than it becoming `0`, it
is merely less obviously false, which makes it harder to find. Range belongs to
the inference ladder in B3 -- the fix is picking a lane that fits, not bending
the value to the lane.

## Rejected: close the integer-lane doors now

Range and truncation doors would flip BK-01 and BK-02 in B1. Those todos are
B3's targets and the todo registry exists so a fix cannot land without the
session that owns it flipping it deliberately. Crossing the boundary also means
B1 would be choosing inference policy (which lane a value is allowed to reach)
while writing value policy (what a lane may store). Two decisions, two records.

## Rejected: union of all record keys as the default keyset

Taking the union makes every record shape "valid" by construction: a typo'd
key in record 900 becomes a new column that is absent -- and therefore zero --
in the other 899 records. That hides drift instead of refusing it, and it makes
the buffer's width depend on the worst record in the input. Record 0 declares
the schema; `E_MISSING_FIELD` and `E_UNEXPECTED_FIELD` report the drift with an
index and a field name.

## Consequences

MINOR bump, 1.0.2 -> 1.1.0. New codes and options are additive; the behavior
change is that inputs which previously produced a buffer may now throw.

Who breaks: callers passing non-numeric values (strings, booleans, `null`,
`undefined`) and relying on them landing as 0; callers passing ragged records
and relying on missing fields being 0 and extra fields being dropped; callers
who relied on `NaN` or `-0` collapsing to `+0` in a float lane. Callers passing
well-formed uniform numeric records -- the documented use -- see no behavior
change at all.

Migration: add `coerce: 'zero'` to the `bake()` call to restore 1.0.x shape and
type leniency. Note that numbers are never coerced in any mode, so `NaN`, `-0`
and `Infinity` are preserved in float lanes even under `coerce: 'zero'`; a
caller who depended on those becoming 0 must do it in their own data.
`validate: true` call sites keep working and now also check values. Every
refusal carries a stable `code` on a `LiteBakeError` (BK-18): `E_*` for
bake-side doors, `R_*` for the Reader's existing lookup throws; messages keep
their 1.0.x prose.
