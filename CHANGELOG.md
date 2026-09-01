# Changelog

All notable changes to this project will be documented in this file. This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
