# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.0] -- 2026-09-02

B3 -- the inference table becomes true for every value it can meet: `inferType()` gains the ladder (real inclusive ceilings on every 32-bit lane, an F64 rung exact to +/-(2^53-1), a refusal past it, and an `Math.fround` round-trip test deciding F32 vs F64 for fractions), the write path gains the int-lane fit door (`E_LANE_MISMATCH` -- the masks stay but are provably exact behind it), and the drift door gets own-key semantics (BK-29). The suite is 121 unit tests (95 unchanged + 26 new in `test/InferenceLadder.test.js`), all green; the ten-tier torture gate prints exactly `ok` in ~1.79-1.87 s wall (x3 stable; t1 promotes the last two todos -- BK-01/BK-02 -- to enforced checks plus the full degenerate matrix and a README-table pin, t5's oracles learn the fit door and gain F64 recipes plus big-int/fround-hostile value classes, t9 empties EXPECTED_TODOS, inverts Control 10 onto the fixed drift-door semantics, and adds Control 16 for the new breakLane knob; the error-code inventory gate agrees 22 == 22 == 22 across thrown/declared/pinned). The findings probes now print 13 NOT-REPRODUCED / 0 REPRODUCED -- every registered defect from the 2026-09-01 evaluation is closed. The Reader half of src is byte-identical (274-line extraction compare against 1.1.1); the src diff is confined to the write half and the comment block. Bench (50k records, one machine): init `bake()` 3.70 ms (1.1.1 recorded 4.38-4.45 ms; the scan gained one fround compare per value and stayed inside the historical run-to-run band); the bench now pins its `x`/`y` columns to F32 by explicit schema, because honest inference would widen arbitrary random doubles to F64 and double the stride -- the pin keeps the layout, the 4.0x memory ratio, and the throughput numbers comparable across versions, and demonstrates the documented override idiom.

### Added

- `E_UNSAFE_INTEGER` and `E_LANE_MISMATCH` error codes (src comment block + `BakeErrorCode` union, 20 -> 22).
- The F64 inference rung: for the first time `bake()` can infer `F64` (previously override-only) -- for all-integer columns beyond the 32-bit lanes (exact to +/-(2^53-1)) and for fractional columns F32 cannot represent exactly.
- `decisions/0005-inference-ladder.md`: the ladder, the int-lane fit door filling decisions/0001's deferred rows, the `[2^60]`-refuses vs `[0.5, 2^60]`-widens asymmetry rationale, the BK-29 own-enumerable keyset boundary, and four rejected alternatives.
- `test/InferenceLadder.test.js`: 26 tests -- rung boundaries (inclusive tops, +/-(2^53) refusals with +/-(2^53-1) twins), the fround rung, non-finite forcing, the fit door in all three modes, BK-29 precedence, and happy twins.

### Changed

- Type inference is a ladder with a top. Integer columns: U8/U16/U32 (to 4294967295 inclusive) or I8/I16/I32 (to +/-2^31 inclusive) as before, then `F64` to +/-(2^53-1), then refusal (`E_UNSAFE_INTEGER`) -- override the field to `Types.F64` to accept documented precision loss. Fractional columns: `F32` only when every value survives `Math.fround(v) === v`, else `F64` (`0.1` and `20000001` widen; `1.5`-class values keep F32, so in-envelope layouts are unchanged). A column carrying NaN/Infinity now takes a float lane -- `[1, NaN]` inferred `U8` and zeroed the NaN before; it infers `F32` and preserves both now. **Layouts widen for out-of-envelope inputs**: a column that silently wrapped in <= 1.1.1 now infers an 8-byte lane, so stride and buffer sizes change for such data. Anyone shipping baked buffers of it must re-bake -- those buffers held wrapped, corrupt values, which is precisely what this release stops.
- An explicit int-lane schema override now refuses any number the lane cannot represent exactly -- out of range, fractional, or non-finite -- with `E_LANE_MISMATCH`, in default, `validate: true`, AND `coerce: 'zero'` modes (numbers are never coerced; `coerce` remains type leniency only). Before, the write path masked silently (`>>> 0`, `| 0`, `& 0xffff`, `& 0xff`); the masks remain but are provably exact behind the door.
- `benchmark/bench.js` pins `x`/`y` to `Types.F32` by explicit schema (see the headline paragraph).

### Fixed

- **BK-01:** integer inference had no 32-bit ceiling -- `bake([{v: 2**32}])` read back `0`, `-(2**31)-1` read back `2147483647`, `2**53` read back `0` (bottomless U32/I32 fallbacks + `>>> 0`/`| 0` masks). Now: `4294967296` exact, `-2147483649` exact, and `E_UNSAFE_INTEGER` respectively.
- **BK-02:** "smallest type that fits" inferred F32 for doubles F32 cannot represent -- `0.1` read back `0.10000000149011612`; mixed `[0.5, 20000001]` read back `20000000`. Both columns now infer `F64` and read back exactly. The same rule closes the manufactured-value doors: `5e-324` no longer rounds to `0` (F64, exact); `1e39` alone is an unsafe integer-valued double and refuses, and in a float column it infers `F64` and reads back exactly instead of becoming `Infinity`.
- **BK-29:** the strict drift door counted own keys with `for..in` but confirmed presence with the prototype-inclusive `in` operator, so a record missing an own prototype-named field (`constructor`, `toString`) escaped `E_MISSING_FIELD` and refused `E_NON_NUMERIC` instead (JSON-reachable). Both walks now use own-key `hasOwnProperty` semantics; the missing case refuses `E_MISSING_FIELD`. Own non-enumerable keys are documented as outside the keyset contract (own-enumerable, symmetric with record 0 -- decisions/0005). The t5 oracle branch and t9 Control 10 flipped onto the fixed semantics in the same commit.

## [1.1.1] -- 2026-09-02

B2 -- the Reader trusts nothing: every incoherent `baked` object is refused at construction with a stable `R_*` code before any view is built, `get()`/`row()` enforce one bounds policy, and `Reader.fromBytes(bytes, meta)` reconstructs a Reader from disk bytes honoring `byteOffset`. The suite is 95 unit tests (63 unchanged + 32 new in `test/ReaderDoors.test.js`), all green, plus the ten-tier torture gate which prints exactly `ok` in ~1.55 s wall time (t3 goes live as the trust-nothing tier with the full corrupt-baked matrix, the row-bounds policy, and the fromBytes pooled round-trip; t2/t4 promote their BK-12/BK-10 todos to enforced checks; t9 shrinks EXPECTED_TODOS to the two deferred inference defects and adds Controls 13-15 that drive the new lanes' knobs; the error-code inventory gate agrees 20 == 20 == 20 across thrown/declared/pinned). `bake()` and the hot read lane are byte-untouched by diff -- the `git diff` on src is confined to the top-of-file comment block and the Reader half. Bench (50k records, warmed, one machine): init `bake()` 4.80/4.48 ms before -> 4.45/4.38 ms after; hot-loop baked read 5.96/6.01 ms before -> 5.85/5.93 ms after -- both within measurement noise, as expected since neither path changed. The Reader constructor gains the coherence-door pass; measured at ~0.35 us per `new Reader(baked)` for a four-field schema (door checks + eight views + a schema snapshot), a one-time cost at load, off every hot path.

### Added

- `Reader.fromBytes(bytes, meta)`: reconstruct a Reader from on-disk bytes. Accepts an `ArrayBuffer` or a `Uint8Array` (a Node `Buffer` is one), honors `byteOffset`/`byteLength` (pooled `readFileSync` Buffers are safe), reuses the buffer zero-copy for an ArrayBuffer or a full-span view, and copies only the viewed range otherwise -- so `reader.buffer` never exposes bytes outside the dataset.
- `BakedMeta` interface (`{ stride, count, schema }`) in `types/index.d.ts`, the shape `Reader.fromBytes` takes.
- Seven Reader-side error codes, added to the src comment block and the `BakeErrorCode` union: `R_INPUT`, `R_BAD_STRIDE`, `R_BAD_COUNT`, `R_BAD_LENGTH`, `R_TRUNCATED`, `R_BAD_SCHEMA`, `R_ROW_OUT_OF_RANGE`.
- `decisions/0002-row-bounds.md` (BK-10), `decisions/0003-view-honesty.md` (BK-05), `decisions/0004-stride-minimum.md` (BK-12): the three decision records B2's tests execute.
- `test/ReaderDoors.test.js`: 32 tests -- the constructor coherence matrix (one corruption per case), happy + frozen twins, schema-snapshot immunity, the `get()`/`row()` bounds policy (including the bounds-before-field-lookup precedence pin), `Reader.fromBytes` (real pooled Buffer, simulated offset copy, full-span zero-copy, refusals), and a no-raw-RangeError sweep.

### Changed

- `new Reader(baked)` now refuses an incoherent `baked` object with a stable `R_*` code instead of constructing silently (a lying `count`/`stride` that read `undefined` in the hot lane) or throwing a raw `RangeError` on an odd-length buffer. The constructor runs eight first-offender doors before any view is built, and snapshots each schema entry's `{name,type,offset}` so later mutation of `baked.schema` (or a getter TOCTOU) cannot move a field after validation.
- `get()`/`row()` now throw `R_ROW_OUT_OF_RANGE` for a non-integer or out-of-`[0, count)` index, instead of silent padding reads (`get(1)` on a count-1 table), silent fractional truncation (`get(0.5)` reading row 0), or a raw `RangeError` (`get(-1)`, `get(8)`). The raw typed-array lane stays caller-owned and unguarded by design.

### Fixed

- **BK-05** (recipe half): the README FAQ disk recipe silently misread through Node's Buffer pool -- `new Reader({ buffer: buf.buffer, ... })` on a pooled `readFileSync` Buffer (nonzero `byteOffset`) read the pool head, so `1234.5` came back as junk. `Reader.fromBytes` honors `byteOffset` and reads it correctly; the FAQ is rewritten onto it. The no-magic half (detecting a wrong FILE, not a wrong SHAPE) rides B4.
- **BK-09:** the Reader trusted `baked` blindly -- `{ buffer: new ArrayBuffer(8), stride: 16, count: 100, ... }` constructed cleanly and the hot lane read `undefined`; a 12-byte buffer threw a raw `RangeError` from `new Float64Array`. Both now refuse (`R_TRUNCATED` and `R_BAD_LENGTH`) at construction.
- **BK-10:** on a count-1 bake, `get(1)` read padding as `0`, `get(0.5)` truncated to row 0's `7`, and `get(-1)`/`get(8)` threw a raw `RangeError`; all four now refuse `R_ROW_OUT_OF_RANGE`, and `get(0)` still reads `7`.
- **BK-12:** the README claimed an all-`U8` schema gets "stride padded to 4 (the minimum)"; the code has no such minimum (three `U8` fields yield stride 3). The false line is removed and the truth documented (stride = max field alignment; `strideF32`/`strideU32` are `0` on sub-4-byte strides). The doc moved, not the code -- baked byte layouts are unchanged.

## [1.1.0] -- 2026-09-01

B1 -- the write-side doors: nothing on the write path accepts what it cannot store faithfully. `bake()` is now strict by default; every refusal is a `LiteBakeError` carrying a stable `code`. The full suite is 63 unit tests (36 in `Bake.test.js`, migrated from message-regex to `e.code` equality; 27 new door tests in `Doors.test.js`) plus the ten-tier torture gate, which prints exactly `ok` (t5 goes live as a seeded differential fuzz vs the decisions/0001 oracle, t1/t4 promote their B1 todos to enforced checks, t9 shrinks EXPECTED_TODOS to the six deferred defects and adds three controls). Bench init (50k records, warmed): 2.79 ms before -> 3.83 ms after, measured old-vs-new on one machine. That ~1 ms is the deliberate cost of the new default: strict mode now runs a per-record drift pass (one `for...in` per record) that 1.0.x's lenient default skipped. The per-value door itself is within noise -- `coerce: 'zero'` (which skips the drift pass) measures 2.85 ms -- so the increase is entirely fail-closed drift detection, not the mask replacement. The hot READ path is untouched by diff: Reader's get/row/offset bodies and the typed-array hot loop are byte-identical apart from a `code` argument added to their existing throws.

### Added

- `LiteBakeError extends Error` with a stable `.code` (BK-18), a module-level `raise(code, msg)`, and a top-of-file comment block documenting all 13 codes: `E_INPUT`, `E_NOT_A_RECORD`, `E_EMPTY_RECORD`, `E_NON_NUMERIC`, `E_MISSING_FIELD`, `E_UNEXPECTED_FIELD`, `E_UNKNOWN_OPTION`, `E_OPTION_VALUE`, `E_OPTION_CONFLICT`, `E_UNKNOWN_FIELD`, `E_BAD_TYPE` (write side) and `R_UNKNOWN_FIELD`, `R_WRONG_TYPE` (Reader side). Exported from `types/index.d.ts` as a `BakeErrorCode` string-literal union plus the class.
- `coerce: 'zero'` opts flag: restores the 1.0.x leniency (non-numbers and absent fields store `0`, extra fields drop) as a documented, per-call, opt-in escape hatch. Numbers are never coerced in any mode.
- `decisions/0001-value-policy.md`: the (lane x value-class x mode) decision record the tests execute; argues `coerce: 'zero'` and its rejected alternatives explicitly.
- `test/Doors.test.js`: 27 tests, banner-sectioned per finding, asserting exact codes and non-vacuous clean twins (including the prototype-named-field and opts-bag doors).
- t5 goes live: a seeded differential-fuzz tier comparing bake/Reader against a hand-written oracle over 300 iterations x 3 modes, with a BREAK canary that proves the tier can fail.
- An inline construction-time opts validator (ported in SHAPE from lite-bake-stream's `checkOpts` + `nearestKey` + two-row Levenshtein, right-sized to the three keys; allocates only on the throw path).

### Changed

- Non-numeric values now throw `E_NON_NUMERIC` instead of the silent `+v || 0` coercion (which made `true` -> `1`, `'42.5'` -> `42.5`, `[7]` -> `7`); remedy: `coerce: 'zero'` for exact `0`, or `Number()` at your boundary.
- Absent fields now throw `E_MISSING_FIELD` instead of reading back `0`; extra fields now throw `E_UNEXPECTED_FIELD` instead of dropping silently; remedy: `coerce: 'zero'` restores the record-0-keyset behavior.
- Non-object / array / null records now throw `E_NOT_A_RECORD` (naming the index) and a zero-key record 0 throws `E_EMPTY_RECORD`, instead of baking a 0-byte buffer with a lying count.
- `schema` override codes outside `0..7` now throw `E_BAD_TYPE` and override keys not in the records throw `E_UNKNOWN_FIELD`, instead of collapsing to a NaN-stride 0-byte container.
- Unknown `opts` keys now throw `E_UNKNOWN_OPTION` with a did-you-mean hint instead of silently disabling the feature they misspelled; out-of-domain values throw `E_OPTION_VALUE`; `validate: true` + `coerce: 'zero'` throws `E_OPTION_CONFLICT`.
- The old `if (opts.validate)` shape-only block is replaced by the default drift door; `validate: true` is now an explicit synonym of the strict default that also checks values.
- The `opts` bag itself is now validated: `null`/`undefined` mean "use defaults" (`bake(recs, null)` no longer throws a raw `TypeError` at `opts.schema`), and a primitive or array opts (`bake(recs, 42)`, `bake(recs, [])`) now throws `E_OPTION_VALUE` instead of being silently accepted as an empty options object.
- Unit tests migrated from bare message-regex `assert.throws` second arguments to `e.code` equality (message regex kept only where it adds value).

### Fixed

- **BK-03:** `NaN`, `-0`, `+Infinity` and `-Infinity` are preserved in float lanes. Under an explicit F64/F32 override or an inferred F32 lane, `NaN` stored `0` -> stores `NaN`; `-0` stored `+0` -> stores `-0` (Object.is exact). Numbers now write direct; `+v || 0` is gone.
- **BK-04:** `true` in an inferred lane stored `1` -> refuses `E_NON_NUMERIC` by default and stores exact `0` under `coerce: 'zero'` (not `1`); `'42.5'` stored `42.5` -> refuses / stores `0`.
- **BK-06:** `validate: true` with `{ v: null }` accepted (read back `0`) -> throws `E_NON_NUMERIC`.
- **BK-07:** `schema: { v: 99 }` baked a 0-byte buffer -> throws `E_BAD_TYPE`; `schema: { v: 'F64' }` baked garbage -> throws `E_BAD_TYPE`; `schema: { ghost: ... }` silently ignored -> throws `E_UNKNOWN_FIELD`.
- **BK-08:** `bake(recs, { shcema: ... })` silently disabled the override -> throws `E_UNKNOWN_OPTION` with `did you mean 'schema'`.
- **BK-11:** `bake([1,2,3])` baked a 0-byte, count-3 container -> throws `E_NOT_A_RECORD`; `bake([{},{}])` -> throws `E_EMPTY_RECORD`.
- **BK-13:** an extra field in a later record was dropped and its value lost -> throws `E_UNEXPECTED_FIELD`; a record missing a field read back `0` -> throws `E_MISSING_FIELD`; `coerce: 'zero'` restores both old behaviors on purpose.
- **Inherited-override hole:** a record-0 field named after an `Object.prototype` member (`constructor`, `toString`, `valueOf`, `hasOwnProperty`) with no explicit override resolved its `type` to the inherited function; `BYTES[type]` was `undefined` and the write switch stored nothing -- a silently garbage-typed column. Type resolution now consults a null-prototype copy of the validated override, so such a field infers a real lane and round-trips (verified: `bake(JSON.parse('[{"constructor":1,"toString":2}]'))` reads back `1` and `2`). An explicit `{ schema: { constructor: Types.F32 } }` still applies.

Not fixed, by design: integer-lane wrap (`2**32` -> `0`, BK-01) and F32 precision loss (`0.1` inferred as F32, BK-02) are untouched -- the int masks (`| 0`, `>>> 0`, `& 0xffff`, `& 0xff`) keep their exact 1.0.x semantics. Those are inference-ladder questions owned by session B3; their torture todos still reproduce at B1 exit.

## [1.0.2] -- 2026-09-01

B0 -- the gate, the changelog, and the provenance the pipeline law names, where none existed. This package shipped 1.0.1 to the registry with no torture gate, no changelog, no version history, and no provable zero-GC claim; the "ZERO allocations" hot-loop promise in `src/index.js` had never been gated. This release stands up the gate on the law's canonical path (`node --expose-gc test/torture.mjs` prints exactly `ok`, exit 0/1), registers every reproduced finding as a named `todo` so B1..B4 have targets, and gives the package a diffable history. No changes to src/index.js -- runtime behavior is identical to 1.0.1 (`git diff` on `src/` is empty; the 36-test suite is byte-identical, renamed only).

### Added

- Torture gate at the pipeline's canonical path: `test/torture.mjs` plus a `test/torture/` tier tree modeled line-for-line on `../LiteBvh/test/torture/`. Live tiers: t0 (metamorphic bake/read laws over an in-envelope corpus), t2 (layout laws over a seeded random schema space), t6 (the zero-alloc gate: `maxMajor: 0`, `maxPauseMs: 4`, `maxArrayBuffersGrowth: 0` via measureOps `stabilize: 'deep'` over a ~1M-cell container, with structural view-identity and buffer-length asserts and a bake() cold-path steady-state check), t7 (lite-leak retention soak: 4096 build/bake/read/drop cycles, tracker size 0, a WeakRef census proving bake() does not retain its input records, across-cycle heap growth bound), t9 (in-process controls for every live tier, each proven able to fail). Tiers t1/t3/t4/t5/t8 are registered stubs that fill in as B1..B4 land.
- `test/torture/harness.mjs`: seeded xorshift32 PRNG with `TORTURE_SEED` replay, `check(cond, msgThunk)` failure-only assertions, `RULES` (`{ maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 }`), `runOpsGate` with `stabilize: 'deep'`, the `BAKE_TORTURE_BREAK` control switch, a `checkLayout(baked)` coherence checker (returns the first violated layout law or null), and a `todoReproduced(id, probeFn)` registry so a fix can never land without flipping its todo.
- Thirteen registered known-defect todos, IDs in the test names: BK-01..BK-13, each reproducing via the probe body it was found with. Home tiers: t1 (BK-01, BK-02, BK-03), t2 (BK-12), t3 (BK-05, BK-09), t4 (BK-06, BK-07, BK-08, BK-10, BK-11, BK-13), t5 (BK-04). Fixes are scheduled B1 (write-side doors), B2 (Reader trust), B3 (inference ladder), B4 (wire format). While a defect still reproduces the gate stays neutral (stdout `ok`); the day a probe stops reproducing, its todo fails the run and demands promotion to an enforced check.
- `CHANGELOG.md` (this file) and its `files[]` entry, so it ships in the tarball. Suite law requires `llms.txt` + `CHANGELOG.md` per package; only the former existed.
- `npm run torture`, `npm run torture:control` (`BAKE_TORTURE_BREAK=1 ... || echo control-failed-as-expected`), and `npm run verify` (test + torture) scripts.
- devDependencies: `@zakkster/lite-gc-profiler` `^1.16.0` (the `stabilize: 'deep'` floor the t6 arrayBuffers gate needs) and `@zakkster/lite-leak` `^1.10.0` (the t7 retention witness). The package's runtime dependency count is unchanged at zero.

### Changed

- `npm test` now globs `test/*.test.js` instead of naming `./test/test.js`; a dropped `.test.js` file runs without editing package.json, making the README's "Adding your own tests" section true. `test:watch` uses the same glob. The glob excludes `test/torture.mjs` by construction, so `node --test` never sweeps the torture entry.
- `test/test.js` renamed to `test/Bake.test.js` (via `git mv`, history preserved). Content is byte-identical: exactly 36 passing tests, so the README/llms.txt "36 tests" claims stay honest until B5 regenerates the docs.
- The stale `package-lock.json` (unscoped name `lite-bake`, version `1.0.0`, disagreeing with `package.json` on both fields) is deleted; the fresh lockfile from `npm install` (scoped name, version 1.0.1, correct devDeps) stays gitignored per the sibling convention.
- `ROADMAP.md`, `BRIEF.md`, and `bench/findings-probes-*.mjs` are untracked as local-only working docs (gitignored); they remain on disk.

### Fixed

- LICENSE now carries the copyright holder: `Copyright (c) 2026 Zahary Shinikchiev` (was a bare `Copyright (c) 2026` with no name). Never "Karadjov".

## [1.0.1] -- 2026-04-24

No changelog was kept for this release and no record of its changes survives in `src/index.js`, `llms.txt`, or the git history (the package was published before this repository had any commits). Presumed docs/metadata only: the published `src/index.js` is functionally the 1.0.0 code. This entry is reconstructed and says so plainly.

## [1.0.0] -- 2026-04-24

First stable release. Reconstructed from the evidence that survives (`llms.txt` alludes to a pre-1.0.0 alignment fix and instructs consumers to "upgrade to 1.0.0+"); no changelog was kept at release time, so the detail below is inferred from the shipped code and that hint, not from a contemporaneous record.

### Fixed

- F64-view alignment. The baked `ArrayBuffer` byteLength is padded up to a multiple of 8 (`(rawBytes + 7) & ~7`) so a `Float64Array` view over the buffer is always constructible, even when the schema has no F64 field -- the pre-fix symptom was a raw `RangeError` from `new Float64Array(buffer)` in the Reader constructor for buffers whose length was not a multiple of 8. Fields are sorted by descending byte size before offset assignment, and the total stride is padded to the largest field alignment, so `i * strideF64 + offset` arithmetic stays consistent across records. The layout math (per-field alignment, stride padding, the multiple-of-8 buffer) is the correct-and-tested part of this package; the `llms.txt` "upgrade to 1.0.0+" line is the evidence this fix shipped here.
