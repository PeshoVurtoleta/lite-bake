# lite-bake -- enriched roadmap (v1.0.1 -> v1.3.1)

Six BRIEF sessions on one package, plus a torture-suite port to the
lite-bvh tier layout. Modeled on `../BLUEPRINT_ROADMAP.md` and on the
finished example of this genre, `../LiteBakeStream/ROADMAP.md`; the test
spec in section 3 is modeled on `../LiteBvh/test/torture/` (harness.mjs +
t0..t9).

**Why this exists.** This is the package's first evaluation since the 1.0.1
release, and the release is live: `@zakkster/lite-bake@1.0.1` is on the
registry right now, and the local tree is shasum-identical to the published
tarball (`70cc9604...`), so every finding below affects the installable
package byte-for-byte. I ran the code. The suite is green (36/36 in 45 ms),
the README's test counts are honest, the benchmark's performance claims are
unusually honest -- and none of that contradicts section 2, because the
findings live exactly where the suite does not look. Thirteen of the
twenty-six findings below were **reproduced by running probes**, not
inferred from reading; two more cross-package probes pin the contract with
`@zakkster/lite-bake-stream`. The probe script ships at
`bench/findings-probes-2026-09-01.mjs` and each table row names its probe.
The remaining thirteen are structural (grep/ls-verifiable) and each row
says so -- one of them (BK-26) is doubly anchored by the XP probes.

The package is small (227 lines), honest about performance, and its layout
math (offsets, alignment, stride padding, the multiple-of-8 buffer) is
genuinely correct -- the 1.0.0 F64-alignment fix is real and pinned by a
good test. The findings cluster is one instinct, missing in the same way
everywhere: **a mask is not a door**. Where the suite law says "fail closed
on every unverified state", this package coerces (`+v || 0`), wraps
(`>>> 0`, `| 0`), truncates (`& 0xff`), infers past its own documented
ranges, and trusts every byte of caller-supplied metadata. The same fix --
refuse what you cannot store -- lands in a dozen costumes.

| Aspect | State | What it needs |
| --- | --- | --- |
| Layout math | Strong: alignment, stride padding, mult-of-8 buffer all correct and tested | The false "padded to 4 minimum" doc line (BK-12) |
| Type inference | Boundary-tested inside 32 bits; silently wrong outside them | The F64 rung and real ceilings (BK-01, BK-02) |
| Write path | Fast, single-allocation | Value policy: refuse or store exactly, never mask (BK-03, BK-04) |
| Reader | Zero-GC hot pattern is real | Trust nothing: coherence checks, bounds policy, view honesty (BK-09, BK-10, BK-05) |
| Options / validate | Documented as the safety net | It fails open at every entry (BK-06, BK-07, BK-08) |
| Torture harness | Does not exist | All of section 3 (BK-16) |
| Docs | README is rich and mostly honest | Blueprint spine, ASCII, five falsifiable claims fixed (BK-17, BK-23) |
| Cross-package | Sibling names this package as its destination format | The actual contract, stated and pinned (BK-26, XP-01, XP-02) |

None of the sessions are padding. Every one is anchored to finding IDs.

---

## 0. Registry + metadata state (verified 2026-09-01)

| Check | Result |
| --- | --- |
| `@zakkster/lite-bake` on registry | 200, latest **1.0.1** -- matches package.json and the catalog |
| Local tree vs published tarball | `npm pack --dry-run` shasum `70cc9604748b96e66d4a6ffc93d43bb3a87c8e65` == registry `dist.shasum` -- **byte-identical**; findings apply to the live package |
| `package.json` repository/homepage/bugs | `PeshoVurtoleta/lite-bake` -- correct, no cross-wire (the lite-arena/lite-scheduler class of error is absent here) |
| `npm pack --dry-run` | 6 files, 13.4 kB tarball / 35.6 kB unpacked: LICENSE, README, llms.txt, package.json, src/index.js, types/index.d.ts. Clean -- no test/bench/example leak |
| Test suite | `npm test`: **36/36 pass, 8 suites, 45 ms**, node v26.3.1. README and llms.txt both claim "36 tests across 8 categories" -- **the counts are honest** (rare; keep it that way) |
| Torture gate | **Absent.** No `test/torture.mjs`, no `--expose-gc` anything, no lite-leak / lite-gc-profiler devDeps (package has zero devDeps), no controls (BK-16) |
| CHANGELOG.md | **Absent** (suite law: llms.txt + CHANGELOG.md per package) -- and `files[]` could not ship it if it existed (BK-15) |
| Version control | **`LiteBake/` is not a git repository** (nor under any parent repo). A published npm package with zero commit history or provenance (BK-21) |
| package-lock.json | Stale stub: `"name": "lite-bake"` (unscoped), `"version": "1.0.0"` -- disagrees with package.json on both fields; sibling convention gitignores the lockfile (BK-21) |
| LICENSE | `Copyright (c) 2026` -- **no holder name** (law: MIT (c) Zahary Shinikchiev) (BK-20) |
| `VERSION` const | None in src. Version lives in 2 places (package.json + the registry); llms.txt/README carry no version string. `/release` sync is trivial here -- keep it that way |
| node_modules at eval time | Absent (harmless: zero devDeps, `npm test` needs nothing). For the XP probes, `@zakkster/lite-bake-stream@1.3.0` was installed with `npm install --no-save --no-package-lock` -- package.json and lockfile verified untouched |

---

## 1. Shared law (holds in every session)

1. **The `baked` object is a public wire contract, not an internal.** The
   README's own FAQ tells users to write `baked.buffer` to disk and
   "reconstruct the Reader" from a saved schema -- so Reader input is
   user-space, unverified data, and every "bake() would never produce that"
   assumption is a hole (BK-05, BK-09). Verify at the door or refuse at the
   door.
2. **Fail closed on every unverified state. A mask is not a door.**
   `+v || 0`, `v >>> 0`, `v | 0`, `v & 0xff`, and `BYTES[type]` without a
   lookup check are all the same instinct: accept-and-mangle where the law
   says refuse. null is not zero (BK-06, BK-13); NaN is not zero (BK-03);
   2^32 is not zero (BK-01); a typo'd option is not a default (BK-08).
3. **Bytes in a hot body, not instructions.** Every door below lands in
   `bake()` or the `Reader` constructor -- init-time cold paths by this
   package's own design. The canonical hot loop is caller-side raw
   typed-array indexing and takes zero new instructions by construction;
   t6 exists to prove that stays true.
4. **Every gate must be provably able to fail.** No gate exists today
   (BK-16), so no gate has ever failed. Every tier B0 stands up ships with
   a deliberately-broken variant behind `BAKE_TORTURE_BREAK=1` that must
   exit non-zero.
5. **The GC gate must gate the memory the package actually uses.** The hot
   surface is one ArrayBuffer and eight typed views -- exactly where
   lite-gc-profiler documents the heap gate's ArrayBuffer blind spot.
   `maxArrayBuffersGrowth: 0` with `stabilize: 'deep'` is non-negotiable in
   t6 (see `../LiteBvh/test/torture/harness.mjs`).
6. **Coverage is not exercise.** 36 green tests never bake an integer above
   2^32, never store NaN under an explicit F64 override, never read back a
   field a record did not have, never reconstruct a Reader from disk, and
   never pass a typo'd option -- which is exactly where BK-01, BK-03,
   BK-05, BK-08 and BK-13 live. When a test names a hazard, the review
   question is "would this fail if the hazard were real".
7. **ASCII-only source and docs** (U+00D7 and U+00B5 excepted). Currently
   violated across 7 files, ~98 offending characters (BK-17).
8. **Reproduce, never infer.** Every finding in section 2 that could be
   run, was run (13 BK probes + 2 XP probes, all REPRODUCED on
   2026-09-01). Future sessions keep the habit: read the sibling's
   published llms.txt/SPEC.md for peer contracts instead of assuming, and
   probe before claiming.

---

## 2. Verified findings

Reproduced against the v1.0.1 tree (registry-identical) on 2026-09-01,
node v26.3.1. Severity: **S1** = silent data loss or corruption, **S2** =
broken documented guarantee or fail-open door, **S3** = hygiene/contract
gap. `probe:` names the PROBE id in `bench/findings-probes-2026-09-01.mjs`;
`grep:`/`ls:` marks structural findings verified by inspection.

### S1 -- silent wrong data

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **BK-01** | **S1** | **Integer inference has no 32-bit ceiling; values wrap silently.** `bake([{v: 2**32}])` infers U32 and reads back `0`; `-(2**31)-1` infers I32 and reads back `2147483647`; `2**53` reads back `0`. The README's inference table documents hard ranges (U32 caps at 4294967295, I32 at +/-2^31) but `inferType()` returns U32/I32 as bottomless fallbacks and the write path masks with `>>> 0` / `\| 0`. F64 is never inferred, so there is no wide rung to land on. Valid JSON integers silently become different integers. | probe: BK-01-int-ceiling-wrap |
| **BK-02** | **S1** | **"Smallest type that fits" infers F32 for doubles F32 cannot represent.** `0.1` -> F32 -> reads back `0.10000000149011612`; a mixed column `[0.5, 20000001]` -> F32 -> `20000001` reads back `20000000`. The docs' own definition ("picks the smallest typed array that fits every value") is violated -- F32 does not fit either value -- and inference can never choose F64 (override-only). Same class, unprobed but certain: `Math.fround(1e39)` = Infinity and `fround(5e-324)` = 0, so F32 inference can also silently manufacture Infinity and 0 (pinned in t1). | probe: BK-02-f32-precision-loss |
| **BK-03** | **S1** | **NaN and -0 are destroyed even under an explicit F64 override.** The float write path is `+v \|\| 0`; NaN and -0 are falsy, so both store as +0 in lanes that can represent them exactly -- even when the user forced `Types.F64` precisely to keep their values. A NaN-as-sentinel dataset silently reads back all-zero. | probe: BK-03-nan-negzero-destroyed |
| **BK-04** | **S1** | **Truthy non-numbers are silently COERCED, not zeroed as documented.** README: "Non-number (string, null, mixed) -> F32 (stored as 0)" and "Strings are silently ignored ... stored as F32 zeros". Actual: `true` -> 1, `"42.5"` -> 42.5, `[7]` -> 7 (`+v` coercion); only NaN-coercing values become 0. Both the documented row and the actual behavior are wrong answers to the same question -- the value policy (B1) decides refusal vs a written coercion table, then t5 enforces it. | probe: BK-04-truthy-coercion |
| **BK-05** | **S1** | **The README's own disk recipe silently misreads via Node's Buffer pool.** FAQ: write `new Uint8Array(baked.buffer)` to a file, keep the schema, "reconstruct the Reader". `readFileSync` returns a pooled Buffer (`byteOffset` 29552 in the probe run); `Reader` takes `.buffer` raw, so the reconstructed reader reads **pool garbage** (probe: x=1234.5 came back 2.8e+209) with nothing to notice -- the format has no magic, no header, no length check. There is no fromBuffer/deserialize that honors `byteOffset`/`byteLength`. | probe: BK-05-pooled-buffer-recipe |

### S2 -- broken documented guarantee / fail-open door

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **BK-06** | **S2** | **`validate: true` does not validate values, contradicting the README.** "Null / undefined / missing fields become 0 ... **unless** you pass `{ validate: true }`" -- but validate checks key sets only: `{v: null}` and all-string records pass validation and store 0. The documented safety net has a value-shaped hole, and there is no mode in which a wrong-typed value throws. | probe: BK-06-validate-ignores-values |
| **BK-07** | **S2** | **Schema overrides fail open on garbage.** `{schema: {v: 99}}` and `{schema: {v: 'F64'}}` (the natural string typo) both bake a **0-byte container** with stride 0 and `get()` = undefined -- `BYTES[badType]` is undefined and NaN stride arithmetic collapses to 0 with no error. An override for a field that does not exist in the records is silently ignored. | probe: BK-07-schema-override-failopen |
| **BK-08** | **S2** | **`bake()` opts fail open.** `{shcema: ..., validat: true}` is accepted without complaint; the typos silently disable both the override and validation. Suite law: unknown option key is an error with a did-you-mean hint. | probe: BK-08-opts-failopen |
| **BK-09** | **S2** | **Reader trusts `baked` blindly.** `{buffer: 8 bytes, stride: 16, count: 100}` constructs cleanly; the documented hot-loop pattern then reads `undefined` from row 1 onward (silent NaN math downstream); `get(1)` throws a raw RangeError. A 12-byte buffer throws a raw RangeError from `new Float64Array` in the constructor -- the pre-1.0.0 symptom llms.txt says was fixed, resurrected for any hand-loaded buffer. No coherence check exists: `count*stride <= byteLength`, `stride > 0`, `byteLength % 8`. | probe: BK-09-reader-trusts-baked |
| **BK-10** | **S2** | **Row indexes fail open three different ways.** With `count` 1: `get(1)` returns 0 silently (reads the padding bytes), `get(0.5)` returns row 0 silently (DataView ToIndex truncation), `get(-1)` and `get(8)` throw raw RangeErrors. No bounds policy, no coded refusal, and the silent branches return plausible numbers. | probe: BK-10-row-bounds-failopen |
| **BK-11** | **S2** | **Non-object and empty records bake into silent nonsense.** `bake([1,2,3])` -> count 3, 0-byte buffer, 0 fields (three records in, zero bytes out, count lies); `bake(['ab','cd'])` -> schema fields `'0','1'` from string indices; `bake([{},{}])` -> 0-byte container. Meanwhile `bake([])` and `bake({})` throw -- the door is half-built. | probe: BK-11-nonobject-records |
| **BK-12** | **S2** | **README claims a stride minimum that does not exist.** "An all-U8 schema gets stride padded to 4 (the minimum)" -- actual stride for a three-U8 record is **3** (code pads to max field alignment, which is 1). One side must move; note `strideF32` is 0 for such layouts, so the doc side is not obviously the wrong one. | probe: BK-12-stride-minimum-claim |
| **BK-13** | **S2** | **Fields beyond record 0 are silently dropped; absent fields read 0.** Keys come from `records[0]` only: record 1's extra field (value 99) is simply gone from the container; a record missing a field reads back 0 (absent is not 0). Documented as default behavior with validate opt-in -- the law says refuse by default, opt into leniency. | probe: BK-13-dropped-and-absent-fields |
| **BK-14** | **S2** | **Native-endian bytes with no endianness marker.** The buffer is written in platform byte order and carries no header, so the documented ship-to-disk recipe silently misreads across endianness; "Round-trips work on both LE ... and BE" conflates in-process round-trips (true) with cross-machine ones (false, undetectable). Cannot be probed on this LE-only machine -- code-read: `LE` detected at module load, used for every DataView write, never recorded anywhere. | grep: `const LE =` src/index.js:33; README "Native endianness" section |

### S3 -- hygiene / design / contract gap

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **BK-15** | S3 | No CHANGELOG.md (suite law: llms.txt + CHANGELOG.md per package); `files[]` does not list it either. 1.0.0's real fix (F64 alignment) and 1.0.1 exist only as prose hints in llms.txt. | ls: repo root; grep: package.json files[] |
| **BK-16** | S3 | **The torture gate does not exist.** No `test/torture.mjs`, no lite-leak or lite-gc-profiler anywhere (zero devDeps), no `--expose-gc` script, no controls -- the pipeline law's gate ("every module change is proven by `node --expose-gc test/torture.mjs`") has never run for this package, and the "ZERO allocations" hot-loop claim has never been gated. | ls: test/; grep: package.json scripts |
| **BK-17** | S3 | ASCII law violated across the package: ~98 offending characters in 7 files (src/index.js 9, types/index.d.ts 4, llms.txt 8, README.md 46, test/test.js 24, benchmark/bench.js 5, examples/basic.js 2): em-dashes, arrows, ellipses, superscripts (2^31 written with Unicode), checkmark/cross emoji in README tables, en-dashes in bench output. | grep: `[^\x00-\x7F]` minus U+00D7/U+00B5 |
| **BK-18** | S3 | No stable error codes: every throw is a bare `Error` with prose (`lite-bake: unknown field 'x'`). Siblings expose `.code` (E_*/W_*/R_*) as the programmatic contract; here tests and consumers must regex messages. | grep: `throw new Error` src/index.js (10 sites, zero codes) |
| **BK-19** | S3 | Main file is `src/index.js` -- the law says single **PascalCase** main file, and every measured sibling does it at the root: lite-bvh `./Bvh.js`, lite-sepforge `./Sepforge.js`, lite-arena `./Arena.js`. | grep: package.json main; sibling package.json files |
| **BK-20** | S3 | LICENSE reads `Copyright (c) 2026` with **no holder name** (law: MIT (c) Zahary Shinikchiev; package.json author field is correct). | grep: LICENSE line 3 |
| **BK-21** | S3 | No version control: the directory is not a git repository (no parent repo either) -- a published package with zero provenance. Plus a stale lockfile: name `lite-bake` (unscoped), version 1.0.0, disagreeing with package.json on both; sibling convention gitignores the lockfile entirely. | ls: `git status` -> fatal; grep: package-lock.json |
| **BK-22** | S3 | `npm test` runs `node --test ./test/test.js` -- a single named file. README "Adding your own tests" promises "Any file the `node --test` runner discovers will run"; a dropped `my.test.js` will silently not run. Directory form removes the class of error. | grep: package.json scripts.test; README line ~345 |
| **BK-23** | S3 | Docs drift, five falsifiable claims: examples/basic.js says inference "would pick U16 ... which would silently round" small ints (U16 stores them exactly -- the real hazards are elsewhere); test/test.js comments "non-finite -> 0 via +v\|\|0" (Infinity is truthy and stores as Infinity); README FAQ says "The hot loop is 2x faster in micro-benchmarks" while its own benchmark section says "within noise of each other (~0.9x-1.1x)"; llms.txt "~3 KB minified" is unverified by any script; README's stride-minimum line is BK-12. | grep: each file |
| **BK-24** | S3 | No `decisions/` directory. The big calls -- AoS over SoA, F32-as-float-default, native endianness, eager view construction, the `+v \|\| 0` coercion -- live in comments and FAQ prose where the next session cannot cite them. | ls |
| **BK-25** | S3 | `bundle-check` script bundles via `npx esbuild` (network-installed at run time, not a devDep) and writes `test-bundle.js` into the repo root, which .gitignore does not cover. | grep: package.json scripts; .gitignore |
| **BK-26** | S3 | **The ecosystem contract is one-directional and unstated.** `@zakkster/lite-bake-stream`'s llms.txt names this package as its destination ("the lite-bake LBK1 binary format", "the ... lite-bake reader API") -- but lite-bake's README/llms.txt never mention the sibling, have no Ecosystem section, and the README roadmap promises its own `serialize()/deserialize()` (v1.3) that would mint a SECOND wire format inside the suite unless the ownership question is settled first. The actual contract measured today: see the cross-package section below. | probe: XP-01, XP-02; grep: no `lite-bake-stream` hit in LiteBake docs |

### The worst one, in detail (BK-01)

```
new Reader(bake([{ v: 2 ** 32 }])).get(0, 'v')        -> 0
new Reader(bake([{ v: -(2 ** 31) - 1 }])).get(0, 'v') -> 2147483647
new Reader(bake([{ v: 2 ** 53 }])).get(0, 'v')        -> 0
```

The README's inference table publishes hard ranges ("All integers,
0..4_294_967_295 -> U32"), which reads as a contract: values in the range
get the type. But the implementation uses U32 and I32 as bottomless
fallbacks -- `if (min >= 0) { ...; return U32; }` -- so any non-negative
integer column that exceeds 65535 becomes U32 no matter how large its
values, and the write path's `v >>> 0` silently reduces every value mod
2^32. Database IDs, timestamps in microseconds, file sizes, hashes stored
as integers -- the most common large-integer payloads -- all read back as
different numbers with 36 green tests and no warning. It is invisible to
the current suite because the inference tests stop at the 65536 boundary
(coverage is not exercise, law 6).

The fix is an inference ladder with a top (B3): integers beyond the 32-bit
lanes infer **F64** (exact to 2^53 -- the same envelope JSON itself has in
JS), and integers beyond 2^53 are **refused** with `E_UNSAFE_INTEGER`
unless the user explicitly overrides F64 (accepting documented precision
loss). The fractional rung gets the same honesty via `Math.fround`: F32
only when every value survives the fround round-trip, else F64 (BK-02 --
this also closes the 1e39 -> Infinity and 5e-324 -> 0 doors). Do NOT fix
it by clamping at the write site, and do NOT fix it by documenting the
wrap: a clamp is still silent wrong data, and the README table already
documents ranges -- the door belongs where the type is chosen. Cost: one
extra comparison per value inside a scan that already computes min/max,
at bake time, which this package defines as cold.

### The one habit that catches five of these at once

BK-01, BK-03, BK-04, BK-07 and BK-11 are all the same line of code in
different costumes: a coercion operator standing where a door should be
(`>>> 0`, `\| 0`, `& 0xff`, `+v \|\| 0`, `BYTES[type]` unchecked). The B1
value-policy session writes the refusal helper once, and t5's differential
fuzz makes the decided coercion table executable -- an oracle applies the
documented table by hand and every cell must match. Any future "just
coerce it" line fails t5 on the first fuzz seed that walks through it.

### The cross-package contract (lite-bake <-> lite-bake-stream), measured

`@zakkster/lite-bake-stream@1.3.0` (published; installed for probing with
`npm install --no-save`) says in its llms.txt that it ingests JSON "into
the `lite-bake` LBK1 binary format" and is the "reference producer path
for downstream consumers of the flat, interleaved, zero-GC `lite-bake`
reader API". Probed reality (XP-01, XP-02):

| Question | Measured answer |
| --- | --- |
| Is LBK1 lite-bake's format? | **No.** LBK1 is defined in lite-bake-stream's SPEC.md and implemented only there. lite-bake has no container format at all: `bake()` returns a live `{buffer, stride, count, schema}` object; no magic, no header, no (de)serializer (its README even promises `serialize()` as future v1.3 work). |
| Can lite-bake read a container lite-bake-stream wrote? | **Not via any API.** Reader cannot take container bytes (probe: naive whole-container read yields garbage, x = 1.39e-309). After ~45 lines of hand-written SPEC parsing plus a payload copy, the **F64 lane cells agree 6/6** -- the interleaved stride-padded row layout IS lane-compatible -- but that is manual glue, not interop. |
| Do U32 lanes mean the same thing? | **No.** A stream U32 cell is a string-table index (reads back `"zebra"` through the stream Reader); lite-bake's U32 is a plain number (reads back `1`, the raw index). lite-bake has no string tables (README roadmap v1.2, unbuilt). |
| Do the lane type codes match? | **Only F64, by luck.** On the wire, LBK1 lane_kind: F64=1 (== `Types.F64`), U32=3 (!= `Types.U32`=5); LBK1 assigns 2/3/4 to F32/U32/U8 where lite-bake's `Types` assigns 2/3/4 to I32/I16/I8. |
| Can lite-bake-stream read a bake() result? | **No.** No stream entry point consumes `{buffer, stride, count, schema}`. |
| Who owns the format truth? | **lite-bake-stream owns the only wire format in the pair** (LBK1, frozen, versioned, strictly decoded since its M2). lite-bake owns the in-memory layout concept and the `Types` enum. The shared thing is the CONCEPT -- interleaved fixed-stride typed lanes -- not bytes, codes, or APIs. |

What this roadmap does about it (the lite-bake side only): B4 decides the
wire-format question WITH the sibling's frozen format on the table instead
of minting a second one, and B5's Ecosystem section states the
relationship in both docs' words. The t8 tier pins the F64 lane parity and
the code-point divergence so any future convergence is a deliberate diff,
not drift. Defects on the lite-bake-stream side of this contract are
recorded in the evaluation report, not in this file.

---

## 3. The torture suite port (`test/torture.mjs`) -- spec

Blueprint: `../LiteBvh/test/torture/`. Same layout, same harness
discipline, tiers renamed to this package's threat model. There is no
existing stress suite to port (BK-16) -- benchmark/bench.js stays a perf
tool and is not a gate. The gate lands where the pipeline law points:
`node --expose-gc test/torture.mjs` prints exactly "ok", exit 0/1.

```
test/
  torture.mjs           # entry: tiers in order, prints "ok", exit 0/1
  torture/
    harness.mjs         # xorshift32 PRNG (TORTURE_SEED replay), check() with
                        # message thunks, runOpsGate (stabilize:'deep'),
                        # BAKE_TORTURE_BREAK control switch, coercion-table oracle
    t0-laws.mjs         # metamorphic bake/read laws
    t1-degenerate.mjs   # nasty values through bake + Reader
    t2-layout.mjs       # offset/stride/alignment/padding laws over schema space
    t3-adversarial.mjs  # lying baked objects must ALL be refused with codes
    t4-abuse.mjs        # API misuse: every case has a decided policy
    t5-fuzz.mjs         # differential fuzz vs a JSON+coercion-table oracle
    t6-alloc.mjs        # zero-alloc gate incl. maxArrayBuffersGrowth: 0
    t7-soak.mjs         # lite-leak retention + bake/read/drop churn
    t8-cross.mjs        # lite-bake-stream lane parity + docs drift guards
    t9-controls.mjs     # every gate above, deliberately broken, exits non-zero
```

Harness rules (verbatim from the blueprint, they all apply here):

- All scratch allocated once, outside every loop. Assertion messages built
  only on failure (a template literal per iteration fails your own t6).
- Seeded xorshift32; any failure prints seed + op index, replayable via
  `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
- lite-gc-profiler is one-measurement-at-a-time; tiers run sequentially.
  Floor the devDep at `^1.16.0` (`stabilize: 'deep'` landed there -- the
  lite-bake-stream M0 log is the precedent; read
  `../lite-gc-profiler/llms.txt` before wiring, rule names from memory are
  how gates rot).
- lite-leak held-value contract: neither `cleanup` nor `tag` closes over
  the tracked target. Floor `^1.10.0`.
- Never resolve an unexpected `inconclusive` with `allowInconclusive`.
- `test/` never enters `files[]`. `npm pack --dry-run` proves it.

### t0 -- metamorphic bake/read laws

For any generated uniform corpus: `row(i)` deep-equals the oracle-coerced
record for every i (oracle = the B1-decided value table + `Math.fround`
for F32 lanes); `get(i, f)` equals the caller-side typed-array pattern
(`f32[i*s32+OFF]` et al.) for every field and every lane kind; bake is
deterministic (same records -> byte-identical buffer, same schema order);
reading by name is invariant to input field order; `offsetXxx(name)` and
`offsetBytes(name)` agree (`offsetF32(f) * 4 === offsetBytes(f)` etc.).

### t1 -- degenerate values

Numbers: -0 (decide: preserved in float lanes -- BK-03's fix pins it),
NaN (per the B1 policy), +/-Infinity, 2^24 +/- 1 (F32 integer-exactness
edge), 2^31 - 1, 2^32 - 1, 2^32 (must not wrap -- BK-01), 2^53 +/- 1,
5e-324 and 1e39 under F32 (must widen or refuse -- BK-02), 1e309
literals. Records: single record; single field; 64-field record;
`{"": 1}` (empty key -- pin it works); `__proto__`/`constructor` as field
names via `JSON.parse` (own-property keys; `_fields` is null-proto --
prove no pollution end to end); all-fields-absent-but-one. Overrides:
every `Types.*` on every value class per the decided table.

### t2 -- layout laws over schema space

Property-based over random schemas (1..64 fields, all 8 types, seeded):
`offset % size === 0` for every field; offsets strictly increase with no
overlap (`offset + size <= next.offset`); `stride % maxAlign === 0`;
`buffer.byteLength % 8 === 0` and `>= stride * count` with tail slack
`< 8`; `strideF64/F32/U16` arithmetic exact whenever a lane of that width
exists; the BK-12 decision (stride minimum: docs or code) pinned
whichever way B2 decides.

### t3 -- adversarial baked objects (the trust-nothing tier)

Start from a valid `baked`; corrupt one thing per case; every case must be
refused at Reader construction with a stable code (BK-09): buffer shorter
than `count * stride`; `stride: 0`, negative, fractional; `count`
negative, fractional, lying-large; `byteLength % 8 !== 0`; schema not an
array / entry missing name / unknown `type` code / `offset + size >
stride`; overlapping offsets; duplicate names; a Uint8Array where the
ArrayBuffer should be (decide: honor views via the B2 `fromBytes` path or
refuse with a pointer at it -- never read `.buffer` raw, BK-05); frozen
baked object (must still construct -- Reader writes nothing into it).

### t4 -- API abuse (every case gets a decided policy)

throw / documented no-op / documented value -- "silently returns
garbage" is not one of the three. `bake` non-array/empty (kept);
non-object records, `[{}]`, string records (BK-11); typo'd opts keys and
unknown schema-override fields (BK-07, BK-08); validate with wrong-typed
values (BK-06 policy); `get(-1)`, `get(0.5)`, `get(count)`, `get(2**53)`,
`row(-1)` (BK-10 policy: one coded refusal, not three behaviors);
`offsetF32` on a U8 field (kept); unknown field names (kept, but with the
B2 error code).

### t5 -- differential fuzz vs an oracle

Seeded generator produces record corpora that BY NAME include the hazard
shapes the current suite never emits (law 6): absent fields, extra
fields, null/undefined/bool/string/numeric-string/array/object values,
integers beyond 2^32 and 2^53, fractional values that do and do not
survive fround, NaN/-0/Infinity, single-record and 50k-record scales.
Oracle = plain JS objects + the decided coercion table applied by hand.
Every cell of every row compared through bake/Reader in both validate
modes; refusal cases assert the exact code. Divergence prints seed + row
+ field + a minimal replay.

### t6 -- the zero-alloc gate

```js
const { report, summary } = runOpsGate(fn, { ops });
// RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 }
```

Scenarios: the canonical hot loop (cached offsets, all four lane widths)
over a 1M-cell container, steady-state -- zero major, zero ArrayBuffer
growth; `offsetXxx` calls at init (allowed to allocate, budgeted);
`bake()` itself per-scenario budgeted (one buffer + schema per call, no
quadratic churn across repeated bakes); a NEGATIVE control proving the
gate sees `get()`/`row()` allocations (they are documented allocators --
the gate must fail on them, that is the proof it works). Structural
asserts no heap gate can substitute for: Reader constructs exactly 9
views + 1 DataView once; the hot loop body allocates no views.

### t7 -- soak and retention (lite-leak enters here)

4096 cycles of: build 1k records -> bake -> Reader -> read every cell ->
drop all refs. lite-leak tracker on the buffer and the Reader; cleanup
closures hold handles, never targets; `tracker.size()` returns to 0.
Assert bake's output graph does NOT retain the input records array
(schema field objects carry name/type/offset only). Repeated
bake-and-drop of 50 MB corpora holds RSS flat within the harness bound.

### t8 -- cross-package agreement (the XP probes become permanent)

Against the PUBLISHED `@zakkster/lite-bake-stream` (devDep, pinned): the
XP-01 body -- serialize a mixed f64/u32 corpus, hand-parse the container
per its SPEC.md, carve the shard payload, read it with THIS package's
Reader -- F64 lane cells must agree cell-for-cell (the lane-layout
parity that makes "same concept" true); the U32 index-vs-string
divergence pinned as a documented difference, not a bug; the XP-02
lane-code table divergence pinned (F64=1 the only shared code point) so
convergence is a deliberate diff. Plus drift guards: every export in
src appears in llms.txt and types/index.d.ts, and vice versa.

### t9 -- controls

`BAKE_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` must exit
non-zero via injected breakage: an allocating closure in the t6 hot loop;
an oracle that skips the coercion table for one value class in t5; a
lying-count case marked expected-pass in t3; a retained Reader ref in t7.
One control per tier minimum. A gate that cannot fail is decorative.

---

## 4. Session order

```
B0 --> B1 --> B3 --> B4 --> B5
  \--> B2 ----------^
        (read side; independent of B1,
         must land before B4 -- fromBytes
         is the seam the format decision uses)
```

- **B0 blocks everything**: no session's DONE-WHEN is checkable without
  the gate, and the package needs git + CHANGELOG before anything ships.
- **B1 before B3**: the refusal vocabulary (error class, codes, opts
  validator) is written in B1; B3's inference doors throw through it.
- **B2 is independent of B1** (pure read side) and may interleave; it must
  land before B4 because `fromBytes` (view-honest reconstruction) is the
  entry point any wire-format decision builds on.
- **B3 changes emitted layouts** (columns widen to F64 where the old code
  wrapped) -- the minor bump and the CHANGELOG honesty ride there.
- **B4 is the format-and-ecosystem session** and depends on the sibling's
  frozen LBK1 being on the table; it decides rather than assumes.
- **B5 last**: docs after the surface stops moving; the ASCII sweep and
  the PascalCase rename ride with the README rebuild.

---

## 5. The briefs

===============================================================================
# B0 -- v1.0.2 -- stand up the gate, the changelog, and the provenance
===============================================================================

```markdown
---
package: "@zakkster/lite-bake"
version_target: 1.0.2
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_hot_read: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [BK-15, BK-16, BK-20, BK-21, BK-22]
blocks: [B1, B2]
---

# lite-bake -- the gate the pipeline law names, where none exists at all

PURPOSE
  This package has never had a torture gate, a changelog, a version
  history, or a provable zero-GC claim. Stand all four up, and register
  every section-2 S1/S2 probe as a failing `todo` so B1..B4 have named
  targets.

TASKS
  - Pre-flight (environment, before any npm work): `git init`, commit the
    tree as-is ("v1.0.1 as published, registry-identical"), so every
    session after this one has a diffable base. Add a .gitignore matching
    the sibling convention (node_modules/, lockfile, ROADMAP.md, BRIEF.md,
    bench/findings-probes-*.mjs as local-only working docs).
  - Stand up test/torture.mjs + test/torture/ per section 3, modeled
    line-for-line on ../LiteBvh/test/torture/harness.mjs (PRNG, check()
    thunks, runOpsGate with stabilize:'deep', BAKE_TORTURE_BREAK switch).
    Tiers t0/t2/t6/t7/t9 live now; t1/t3/t4/t5/t8 registered as stubs
    that fill in as B1..B4 land.
  - devDeps: "@zakkster/lite-leak" ^1.10.0, "@zakkster/lite-gc-profiler"
    ^1.16.0 (stabilize 'deep' floor -- the lite-bake-stream M0 log is the
    precedent). Wire t7 per the torture-harness skill template.
  - t6 rules: { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 },
    stabilize 'deep'. The negative control (get()/row() allocate by
    documentation) proves the gate can see this package's failure mode.
  - t9 controls for every live tier; package.json:
      "torture": "node --expose-gc test/torture.mjs",
      "torture:control": "BAKE_TORTURE_BREAK=1 node --expose-gc test/torture.mjs || echo control-failed-as-expected"
  - Preflight in torture.mjs: exit 2 with a clear message when devDeps are
    not installed (the sibling learned this on a fresh clone).
  - "test": "node --test test/" (directory form) so a second test file
    runs (BK-22); README's "Adding your own tests" section becomes true.
  - CHANGELOG.md created (BK-15): reconstruct 1.0.0 (the F64-alignment
    fix llms.txt alludes to) and 1.0.1 honestly from what is known; add
    files[] entry so it ships.
  - LICENSE line 3 gains the holder: "Copyright (c) 2026 Zahary
    Shinikchiev" (BK-20). Never "Karadjov".
  - Lockfile: regenerate or delete per the sibling convention (BK-21) --
    recorded either way.
  - Register BK-01..BK-13 as named `todo` tests in their home tiers, each
    reproducing via the probe bodies in bench/findings-probes-2026-09-01.mjs.

ASSERTIONS
  - node --test green (36+), torture prints "ok" exit 0.
  - BAKE_TORTURE_BREAK=1 exits non-zero for EVERY live tier's control.
  - npm pack --dry-run ships CHANGELOG.md and still excludes test/,
    benchmark/, examples/, ROADMAP.md, bench/.
  - The thirteen probed findings are registered todos, IDs in the names.
  - `git log` exists and starts from the registry-identical tree.

NON-GOALS
  No behavior change in src/. No fixes -- findings become visible here,
  fixed in B1..B4.

DONE WHEN
  torture "ok" from the law's path; every control fails; S1/S2s registered;
  the package has a history
```

===============================================================================
# B1 -- v1.1.0 -- the write-side doors (a mask is not a door)
===============================================================================

```markdown
---
package: "@zakkster/lite-bake"
version_target: 1.1.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_hot_read: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [BK-03, BK-04, BK-06, BK-07, BK-08, BK-11, BK-13, BK-18]
depends_on: [B0]
blocks: [B3]
---

# lite-bake -- nothing on the write path accepts what it cannot store

PURPOSE
  Seven findings, one missing instinct: the write path coerces, defaults,
  or drops where it should refuse. Write the refusal vocabulary once (an
  error class with stable codes -- BK-18 rides along), then spend it at
  every door.

TASKS
  - LiteBakeError with stable `code` (BK-18): every existing throw gains a
    code (E_INPUT, E_UNKNOWN_FIELD, E_WRONG_TYPE...); messages keep their
    current prose. Tests migrate from regex-on-message to code equality.
  - Decision FIRST, decisions/0001-value-policy.md (BK-03, BK-04, BK-06):
    the full (lane x value-class) table. Recommended:
      - typeof number: stored exactly per lane semantics; NaN and -0
        PRESERVED in F32/F64 lanes (kill `+v || 0`; use explicit
        typeof-guarded conversion) -- BK-03 flips.
      - non-number values (string, bool, null, undefined, object, array):
        REFUSED by default with E_NON_NUMERIC naming record index + field;
        opt-in `coerce: 'zero'` restores the OLD DOCUMENTED behavior
        (actual 0, not `+v` coercion -- BK-04's true->1 door closes in
        both modes). README's table rewritten from the decided policy.
      - absent field (key not on record): REFUSED by default under the
        same door (E_MISSING_FIELD) unless `coerce: 'zero'` -- BK-13's
        read-0 becomes opt-in; validate:true stays the strict shape check
        it always was, now with values included (BK-06 flips: null under
        validate throws).
    This is breaking-for-sloppy-callers under contracts the README
    already claimed -- MINOR per suite convention; CHANGELOG states every
    edge honestly.
  - Opts law (BK-08): shared ~15-line validator; unknown keys throw
    E_UNKNOWN_OPTION with a did-you-mean (edit distance <= 2); schema
    override keys not present in the records throw E_UNKNOWN_FIELD;
    override values not in Types throw E_BAD_TYPE naming the enum
    (BK-07's 99/'F64' doors close; the NaN-stride collapse becomes
    unreachable).
  - Record-shape door (BK-11): non-object records (primitives, arrays,
    null) throw E_NOT_A_RECORD with the index; records with zero keys
    throw E_EMPTY_RECORD (or a recorded decision to allow all-defaults --
    either way, no more 0-byte containers with a lying count).
  - Field-set truth (BK-13 write half): keys become the UNION of all
    records' keys, or refusal on drift outside validate -- decided in
    0001 (recommended: refusal by default, `coerce:'zero'` unions to the
    record-0 set as before, documented).

HOT PATH
  Every door lands in bake() -- init-time by the package's own design.
  The per-value doors replace existing per-value coercion operators
  (same cost shape: one typeof + one branch where `+v || 0` stood).
  Prove it: benchmark/bench.js init cost within noise of the B0 baseline,
  recorded in the CHANGELOG; the READ path is untouched by diff.

ASSERTIONS
  - Every finding above has a named failing-before/passing-after test.
  - NaN and -0 round-trip through explicit and inferred float lanes.
  - {v: true} refuses E_NON_NUMERIC by default; coerce:'zero' stores 0
    (not 1) and the README table matches both modes.
  - {shcema: ...} throws E_UNKNOWN_OPTION naming 'schema'.
  - bake([1,2,3]) throws E_NOT_A_RECORD; no path returns count > 0 with
    an empty buffer.
  - torture "ok"; controls fail; t6 within noise.

NON-GOALS
  No inference change (B3). No Reader change (B2). No format work (B4).

DONE WHEN
  all seven doors refuse; the value table is a decision record the tests
  execute; probes BK-03/04/06/07/08/11/13 print NOT-REPRODUCED
```

===============================================================================
# B2 -- v1.1.1 -- the Reader trusts nothing (and views get honest)
===============================================================================

```markdown
---
package: "@zakkster/lite-bake"
version_target: 1.1.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_hot_read: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [BK-05, BK-09, BK-10, BK-12]
depends_on: [B0]
blocks: [B4]
---

# lite-bake -- a baked object is verified at the door or refused at the door

PURPOSE
  The README's FAQ makes `baked` a persistence contract, so Reader input
  is unverified user-space data. Today the constructor accepts anything
  and the documented hot loop reads undefined from it. Verify at
  construction -- the only cold moment the reader has.

TASKS
  - Coherence checks in the Reader constructor (BK-09), all with stable
    codes (R_*): buffer is an ArrayBuffer (see fromBytes below for
    views); byteLength % 8 === 0 (R_BAD_LENGTH -- replaces the raw
    Float64Array RangeError); stride a positive integer; count a
    non-negative integer; count * stride <= byteLength (R_TRUNCATED);
    schema an array of {name, type in Types, offset} with
    offset + size <= stride and no overlaps/duplicates (R_BAD_SCHEMA).
  - Bounds policy (BK-10), decided and recorded in
    decisions/0002-row-bounds.md: get()/row() are documented
    init/debug-tier (they branch already) -- recommended: non-integer or
    out-of-range i throws R_ROW_OUT_OF_RANGE; the raw-typed-array hot
    path stays caller-owned and unguarded BY DESIGN (document: bounds are
    the price of the raw lane; t6 proves get() still allocation-free
    aside from its documented behavior).
  - View honesty (BK-05, the API half): static Reader.fromBytes(view,
    {stride, count, schema}) accepting Uint8Array OR ArrayBuffer,
    honoring byteOffset/byteLength (aligned zero-copy when possible,
    copy otherwise -- recorded), running the same coherence checks.
    README FAQ rewritten onto fromBytes; the pooled-Buffer probe becomes
    the regression test. (The no-magic half of BK-05 waits for B4 --
    fromBytes cannot detect a wrong file, only a wrong shape.)
  - BK-12 decided: either implement the documented 4-byte stride minimum
    or fix the doc line. Recommended: fix the DOC (stride = max field
    alignment is the invariant the layout tests pin; a forced minimum
    wastes a byte per record on all-U8 tables for no aligned-lane
    benefit) -- and document that strideF32 is 0 on sub-4-byte strides.
  - Wire t3 fully (the corrupt-baked matrix) and the t4 bounds cases.

HOT PATH
  All validation at construction. get()/row() gain one integer/range
  check each -- they are documented debug-tier and already branch per
  call; the raw typed-array pattern is untouched by diff. t6 within
  noise, asserted.

ASSERTIONS
  - Every t3 case refused with its R_* code; no raw RangeError escapes
    the constructor or get().
  - readFileSync round-trip works via fromBytes on a pooled small file
    (byteOffset > 0) -- the BK-05 probe body, inverted.
  - get(1) on a count-1 container throws R_ROW_OUT_OF_RANGE (was:
    silent padding read); get(0.5) likewise (was: silent truncation).
  - torture "ok"; controls fail.

NON-GOALS
  No format/magic (B4). No write-side change (B1 owns those doors).

DONE WHEN
  no lying `baked` object survives construction; probes BK-05 (recipe
  half), BK-09, BK-10, BK-12 print NOT-REPRODUCED
```

===============================================================================
# B3 -- v1.2.0 -- inference truth: the F64 rung and real ceilings
===============================================================================

```markdown
---
package: "@zakkster/lite-bake"
version_target: 1.2.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_hot_read: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [BK-01, BK-02]
depends_on: [B1]
blocks: [B4]
---

# lite-bake -- the inference table becomes true for every value it can meet

PURPOSE
  The package's identity is "the smallest typed array that fits every
  value". Two rows of reality violate it: integers beyond 32 bits wrap
  (BK-01) and doubles get an F32 that does not fit them (BK-02). Both
  fixes change inferred layouts for existing inputs -- hence the minor
  bump and a rewritten README table.

TASKS
  - Decision FIRST, decisions/0003-inference-ladder.md:
      - Integer rung (BK-01): values outside U32/I32 ranges infer F64
        (exact to 2^53 -- JSON's own JS envelope); |v| > 2^53 REFUSES
        E_UNSAFE_INTEGER unless overridden to F64 (documented precision
        loss). Reject the clamp-at-write alternative in the record (a
        clamp is still silent wrong data); reject document-the-wrap (the
        table already documents ranges -- the door belongs at inference).
      - Fractional rung (BK-02): F32 only when EVERY value survives
        Math.fround round-trip (one compare inside the existing min/max
        scan); else F64. Closes 0.1-drift, 20000001 -> 20000000,
        1e39 -> Infinity, 5e-324 -> 0 in one rule.
      - Overrides keep full power (F32 on purpose stays legal); override
        + out-of-range value follows the B1 value policy (refuse by
        default).
  - README inference table rewritten from the decided ladder, including
    the new F64 rows and the refusal row.
  - t1 degenerate values wired (the full section-3 list); t5 generator
    gains big-int and fround-hostile classes; the BK-01/BK-02 todos flip.
  - CHANGELOG "Layouts widen" honesty: columns that silently wrapped
    before now infer F64 -- stride and buffer sizes change for such
    inputs; anyone shipping baked buffers must re-bake (they were
    corrupt anyway; say exactly that).

HOT PATH
  bake()-time only (cold by design). The fround check is one comparison
  per value inside a loop that already reads min/max. bench.js init
  numbers within noise, recorded.

ASSERTIONS
  - The three BK-01 probe lines read back 4294967296, -2147483649, and
    E_UNSAFE_INTEGER respectively.
  - 0.1 infers F64 and round-trips exactly; [0.5, 1.5] still infers F32
    (fround-exact values keep the small lane).
  - Layout laws (t2) hold over the new ladder; no existing green test
    for in-range values changes result.
  - torture "ok"; controls fail.

NON-GOALS
  No I64/BigInt lane. No string tables. No format work.

DONE WHEN
  the README table and inferType() are the same table; probes BK-01 and
  BK-02 print NOT-REPRODUCED
```

===============================================================================
# B4 -- v1.3.0 -- the wire-format decision, made with the sibling on the table
===============================================================================

```markdown
---
package: "@zakkster/lite-bake"
version_target: 1.3.0
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_hot_read: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak", "@zakkster/lite-bake-stream (dev, t8 only)"]
findings: [BK-05, BK-14, BK-26]
depends_on: [B2, B3]
blocks: [B5]
---

# lite-bake -- one suite, one wire format, stated in both directions

PURPOSE
  The README FAQ ships a disk recipe with no header, no endianness
  marker, and no way to detect a wrong file (BK-05's second half,
  BK-14); the README roadmap promises serialize()/deserialize() (v1.3);
  and the sibling package already OWNS a frozen, versioned, strictly
  decoded container format that names this package as its destination
  (BK-26, XP-01/02). Minting a second wire format inside the suite
  without deciding against the first would be invented work. Decide,
  record, and make the ecosystem claim true in both docs.

TASKS
  - Decision FIRST, decisions/0004-wire-format.md. Options:
      A. DELEGATE (recommended): lite-bake stays the in-memory compiler
         and hot-loop reader; ALL persistence goes through
         lite-bake-stream's LBK1 (which B-side sessions there make
         readable for this package's shapes). The README FAQ recipe and
         the serialize() roadmap entry are REPLACED by an Ecosystem
         pointer + a worked LBK1 example. Cheapest, one format, zero new
         surface -- but couples the story to the sibling's API (both
         packages are same-author; the coupling is the suite's point).
      B. MINI-HEADER: a 24-byte LBAK header (magic, version, endian
         byte, stride, count, schema blob) + fromBytes/toBytes. Solves
         BK-05/BK-14 entirely inside this package; second format in the
         suite; MUST NOT collide with LBK1 magic or reuse its lane codes
         ambiguously (XP-02's table is the collision map).
      C. STATUS QUO DOCUMENTED: no format; FAQ rewritten to name the
         hazards (pool offsets, endianness, no detection) and point at
         the sibling for real persistence. Weakest; only if A is blocked.
    Record why the losers lost. Whichever wins: the FAQ recipe as
    currently written DIES (it corrupts silently -- BK-05).
  - Ecosystem truth (BK-26): README gains the Ecosystem section (spine
    slot) stating the measured contract from section 2's cross-package
    table -- who owns the wire format, what "same lane concept" means,
    that lane CODES differ (F64=1 the only shared point), and what the
    U32 lane means on each side. llms.txt gains the same stanza. The
    v1.2 string-table roadmap entry is re-scoped or parked against the
    same question (stream U32 lanes already do interned strings).
  - t8 wired live (XP-01/XP-02 bodies as permanent tiers against the
    pinned published sibling).
  - BK-14 lands per the decision: endian byte in the header (B), or the
    constraint documented in BOLD in the FAQ replacement (A/C).

HOT PATH
  Untouched -- persistence is cold by definition. t6 unchanged, asserted.

ASSERTIONS
  - decisions/0004 exists with all three options weighed and the XP
    probe evidence cited.
  - The FAQ pooled-buffer recipe is gone from README; its replacement is
    runnable and either refuses or round-trips on a pooled Buffer.
  - t8 green against the pinned sibling version; lane-parity and
    code-divergence pins in place.
  - Probes BK-05 (both halves) and XP-01 print NOT-REPRODUCED or their
    documented-contract equivalents per the decision.
  - torture "ok"; controls fail.

NON-GOALS
  No SoA/columnar mode (README v1.1 promise -- parked, its own session
  when a consumer exists). No LBK1 writer inside this package.

DONE WHEN
  one wire-format story, recorded; both packages' docs tell it the same
  way; nothing in this package can silently misread a file
```

===============================================================================
# B5 -- v1.3.1 -- docs on the blueprint spine, ASCII everywhere, decisions on disk
===============================================================================

```markdown
---
package: "@zakkster/lite-bake"
version_target: 1.3.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_hot_read: 0
leak_cycles: 4096
peers: []
findings: [BK-12, BK-17, BK-19, BK-23, BK-24, BK-25]
depends_on: [B4]
---

# lite-bake -- the front page describes the package that exists

PURPOSE
  Docs last, after the surface stops moving. The README is rich but
  pre-blueprint; five of its claims are falsifiable today (four fixed by
  B1..B4, BK-12/BK-23 ride here); the ASCII law is violated in every
  file; the main file breaks the PascalCase law; the decisions that
  shaped the package live in FAQ prose.

TASKS
  - README rebuilt on the LiteSepforge spine, in order: title + one-line
    blockquote tagline; badges; positioning H2 ("The X the ecosystem was
    missing") with inline install + runnable quick-start; TOC; Why this
    exists; What you get; <details> deep-dive on the memory layout (the
    current mermaid material survives here, ASCII-safe); API reference
    (signatures + a constants table: Types codes, error codes from
    B1/B2, the inference ladder from B3); Composability (full pipeline
    with lite-bake-stream, runnable); <details> Zero-GC design notes
    with the allocation table + gated numbers from t6/t7 (provenance-
    stamped); Design decisions worth knowing (link decisions/); Testing
    (real counts + the command table incl. torture + controls); What
    this is not (not a wire format per B4, not SoA, not a string store,
    not faster-than-JIT -- keep the honest benchmark section);
    Ecosystem (from B4); License.
  - ASCII sweep (BK-17): all 7 offending files; `->` `<=` `x` "2^31"
    only; checkmark/cross tables become Do/Don't prose; keep U+00D7 only
    where genuinely multiplicative. Add the drift guard: a test greps
    the tree for non-ASCII outside the two exceptions and fails on hit
    (control: an injected em-dash must fail it).
  - PascalCase main (BK-19): src/index.js -> Bake.js at the package root
    (sibling convention: Bvh.js, Sepforge.js, Arena.js); package.json
    main/module/exports/types updated; consumers see no change (the "."
    export is the contract). files[] updated; pack diff proves 6->6.
  - decisions/ retrofit (BK-24): transcribe the already-made calls --
    0005-aos-over-soa.md (the FAQ already argues it), 0006-native-
    endianness.md (why no byteswap, what B4 decided about marking it),
    0007-eager-views.md (8 views in the constructor, ~600 B, why not
    lazy). Transcription, not invention.
  - Falsifiable-claims pass (BK-23): examples/basic.js U16-rounding
    comment corrected (the real hazard is fractional/big values, not
    small-int rounding); test comment about Infinity corrected; README
    FAQ "2x faster" reconciled with the honest benchmark section (keep
    the honest one); llms.txt "~3 KB minified" either measured by a
    script or deleted; llms.txt regenerated against the B1..B4 surface
    with the export drift guard from t8 keeping it true.
  - bundle-check (BK-25): drop the script or make esbuild a devDep with
    output to a gitignored path -- recorded either way.
  - BK-12 doc side lands (per B2's decision).

ASSERTIONS
  - README sections match the Sepforge spine in order (manual check
    against ../LiteSepforge/README.md).
  - The ASCII guard fails on an injected em-dash (control), passes the
    tree.
  - The llms.txt drift guard fails when an export is removed (control).
  - Every decisions/ file is linked from source header, README, or
    CHANGELOG.
  - npm pack --dry-run: LICENSE, README, CHANGELOG, llms.txt,
    package.json, Bake.js, types -- nothing else.

NON-GOALS
  No behavior change of any kind -- the diff contains no logic.

DONE WHEN
  README, llms.txt, d.ts, decisions/, and code agree; the two drift
  guards are in CI; the file layout matches the suite's own law
```

---

## 6. How to run it

In order: B0, B1, B2 (B2 may interleave with B1 -- it touches only the
Reader), B3, B4, B5. `status: planned -> shipped` after each `/release`.
Author the brief in the package, then planner -> coder -> reviewer -> qa,
then `/release <version>`. Reviewer REJECTED goes back to coder, never
forward. The budget frontmatter never moves: a budget that moves is not a
gate.

### If you only do a subset

1. **B0 + the BK-01 fix from B3, today.** The package is on npm; BK-01 is
   silent wrong data for the most ordinary large integers (IDs,
   timestamps), invisible to every green test. The fix is one inference
   rung and one refusal. Nothing else here has that severity-to-effort
   ratio.
2. **B1 is the teaching session.** Seven findings, one instinct ("a mask
   is not a door"), one refusal vocabulary. Doing it once well makes the
   suite's fail-closed law feel inevitable instead of imposed.
3. **B2 before anyone follows the FAQ.** The disk recipe corrupts
   silently on stock Node today; fromBytes is the smallest honest
   replacement.
4. **B4 before the ecosystem story drifts further.** The sibling
   already ships prose claiming this package as its destination; every
   month the relationship stays unstated, the two roadmaps (this v1.3
   serialize() vs LBK1) drift toward a collision.
5. **B5 is not optional forever.** A stale llms.txt is how a sibling
   package hallucinates this one's API.

### The habit this roadmap is built around

Every S1 finding in section 2 was invisible in the green suite and
obvious in a five-line probe. BK-01 hid behind inference tests that stop
at 65536; BK-03 hid behind a round-trip suite that never baked a NaN;
BK-05 hid behind an FAQ nobody executed. Coverage is not exercise. When a
session adds a test, the review question is "would this fail if the
finding were real" -- and t9 exists so that question has a mechanical
answer for the gates themselves.

The probes stay in `bench/findings-probes-2026-09-01.mjs` until every one
prints NOT-REPRODUCED, at which point their bodies live on as named
torture cases and the file is deleted in the same commit that closes the
last one.

---

## Progress log

**2026-09-01 -- evaluation session (this document).** Baseline: 36/36
tests green in 45 ms on node v26.3.1; no torture gate exists; registry
1.0.1 shasum-identical to the local tree; pack ships 6 files clean.
Probes written and run: 15/15 REPRODUCED (13 BK + 2 XP), 0 PARTIAL, 0
INCONCLUSIVE, exit 0. Cross-package contract measured against published
`@zakkster/lite-bake-stream@1.3.0` (installed `--no-save`, manifest
untouched): no API-level interop in either direction; F64 lane layout
agrees 6/6 cells after hand-carving; lane code tables diverge except
F64=1; LBK1 ownership sits entirely with the sibling. No src/, test/,
types/, docs, or package.json changes -- evaluation only. Next session:
B0.

MIT (c) Zahary Shinikchiev
