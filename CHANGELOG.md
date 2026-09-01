# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
