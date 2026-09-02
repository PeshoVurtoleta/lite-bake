/**
 * t9 -- controls. Every gate must be provably able to fail.
 *
 * Each control runs a deliberately-broken variant IN PROCESS and asserts the
 * corresponding gate flags it. If a control slips through, t9 fails the run: a
 * gate that cannot fail is decorative. Where it matters, a control also proves
 * non-vacuity (the checker returns clean on a genuinely valid input, so "flags
 * the broken one" is a real property and not a checker that flags everything).
 *
 * The whole-suite control lives in t6: `BAKE_TORTURE_BREAK=1 node --expose-gc
 * test/torture.mjs` injects a retained allocation into the t6 hot loop, the
 * alloc gate rejects it, and the process exits non-zero; the torture entry then
 * re-checks that BREAK actually tripped. Control 1 below exercises the same alloc
 * lane in-process so a plain `npm run torture` already proves the gate bites.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { bake, Reader, Types } from '../../Bake.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { runOpsGate, checkLayout, die, todoIds } from './harness.mjs';
import { extractThrown, extractDeclared, extractPinned, diffInventory } from './inventory.mjs';
import { hostileOracle, shapeOracle, crossOracle } from './t5-fuzz.mjs';
import { checkRefusal, checkBounds, checkRoundTrip } from './t3-adversarial.mjs';
import {
  checkLaneParity, checkU32Semantics, checkLaneCodes, checkWrongFile,
  checkExports, checkBytesTables, checkDocsPins,
} from './t8-cross.mjs';

const NOOP = function () {};

/** Retained sink so the control's allocations survive GC (arrayBuffers grows). */
const leak = [];

// After B3 the last two deferred inference-ladder todos (BK-01, BK-02) are
// promoted to enforced checks in t1, so the registry is now empty: all thirteen
// findings are closed and the todo mechanism is dormant.
const EXPECTED_TODOS = [];

export function run() {
  // --- Control 1: the alloc gate. A hot body that retains an allocation every
  // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0). ---------
  const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
  if (report.ok) die('t9 control: an allocating hot loop passed the zero-alloc gate');
  leak.length = 0; // release the control's garbage

  // --- Control 2: the layout checker. A valid baked object returns null; three
  // hand-corrupted variants each return a non-null violation string. -----------
  const valid = bake([{ a: 1.5 }, { a: 2.5 }]); // F32, stride 4, count 2, 8-byte buffer
  if (checkLayout(valid) !== null) {
    die('t9 control: checkLayout flagged a valid baked object (checker is broken / vacuous)');
  }
  const overlap = {
    buffer: new ArrayBuffer(8), stride: 2, count: 1,
    schema: [{ name: 'x', type: Types.U8, offset: 0 }, { name: 'y', type: Types.U8, offset: 0 }],
  };
  if (checkLayout(overlap) === null) die('t9 control: checkLayout passed overlapping field offsets');
  const zeroStride = {
    buffer: new ArrayBuffer(8), stride: 0, count: 1,
    schema: [{ name: 'x', type: Types.U8, offset: 0 }],
  };
  if (checkLayout(zeroStride) === null) die('t9 control: checkLayout passed stride 0');
  const badLen = {
    buffer: new ArrayBuffer(6), stride: 2, count: 1,
    schema: [{ name: 'x', type: Types.U16, offset: 0 }],
  };
  if (checkLayout(badLen) === null) die('t9 control: checkLayout passed a byteLength not a multiple of 8');

  // --- Control 3: the t0 get-vs-record oracle. Corrupt ONE byte of a valid
  // buffer inside a known lane and require the same comparison t0 uses detects
  // the divergence; the uncorrupted container must show NO divergence so the
  // control is not vacuous. -----------------------------------------------------
  const oracleRecs = [{ q: 1.5 }, { q: 2.5 }, { q: 3.5 }]; // F32 lane, fround-exact
  const oracleBaked = bake(oracleRecs);
  const cleanReader = new Reader(oracleBaked);
  let cleanDiverges = false;
  for (let i = 0; i < oracleRecs.length; i++) {
    if (cleanReader.get(i, 'q') !== oracleRecs[i].q) { cleanDiverges = true; break; }
  }
  if (cleanDiverges) {
    die('t9 control: the get-vs-record oracle reported divergence on a clean container (vacuous/broken)');
  }
  // Flip one byte inside row 1's F32 lane, then re-run the same comparison.
  const laneOff = cleanReader.offsetBytes('q');
  const rawBytes = new Uint8Array(oracleBaked.buffer);
  rawBytes[1 * oracleBaked.stride + laneOff] ^= 0xff;
  const corruptReader = new Reader(oracleBaked);
  let corruptDiverges = false;
  for (let i = 0; i < oracleRecs.length; i++) {
    if (corruptReader.get(i, 'q') !== oracleRecs[i].q) { corruptDiverges = true; break; }
  }
  if (!corruptDiverges) die('t9 control: the get-vs-record oracle missed a one-byte buffer corruption');

  // --- Control 4: the lite-leak witness. A tracked, still-held target reads
  // size() 1 (the gate sees it); untrack returns it to 0 (non-vacuity). ---------
  const t = createLeakTracker({ name: 't9-control' });
  const held = { x: 1 };
  const h = t.track(held, NOOP, 't9');
  if (t.size() !== 1) die('t9 control: leak tracker did not see a tracked resource (size != 1)');
  t.untrack(h);
  if (t.size() !== 0) die('t9 control: leak tracker did not release on untrack (size != 0)');

  // --- Control 5: the todo registry. By the time t9 runs, every tier has run;
  // after B3 no tier registers a todo (all thirteen BK-01..BK-13 are promoted),
  // so the registry is empty. This mechanically proves "zero registered todos".
  const ids = todoIds();
  if (ids.length !== EXPECTED_TODOS.length) {
    die('t9 control: expected ' + EXPECTED_TODOS.length + ' registered todos, saw ' + ids.length);
  }
  for (const want of EXPECTED_TODOS) {
    if (ids.indexOf(want) === -1) die('t9 control: todo ' + want + ' was never registered');
  }
  for (const saw of ids) {
    if (EXPECTED_TODOS.indexOf(saw) === -1) die('t9 control: unexpected todo registered: ' + saw);
  }

  // --- Control 6: the opts door (BK-08). A typo'd key must throw
  // E_UNKNOWN_OPTION with a did-you-mean; a valid opts object must pass. --------
  let eOpt = null;
  try { bake([{ v: 1 }], { shcema: 1 }); } catch (e) { eOpt = e; }
  if (!eOpt || eOpt.code !== 'E_UNKNOWN_OPTION' || !/did you mean 'schema'/.test(eOpt.message)) {
    die('t9 control: opts door did not refuse {shcema} with a did-you-mean (code=' + (eOpt && eOpt.code) + ')');
  }
  let eValid = null;
  try { bake([{ v: 1 }, { v: 2 }], { validate: true }); } catch (e) { eValid = e; }
  if (eValid) die('t9 control: opts door refused a valid {validate:true} bake (' + eValid.code + ')');

  // --- Control 7: the value door (BK-04). {v:'x'} refuses by default;
  // coerce:'zero' stores exact 0, and {v:true} coerce stores 0 not 1. -----------
  let eVal = null;
  try { bake([{ v: 'x' }]); } catch (e) { eVal = e; }
  if (!eVal || eVal.code !== 'E_NON_NUMERIC') {
    die('t9 control: value door did not refuse {v:"x"} by default (code=' + (eVal && eVal.code) + ')');
  }
  const cz = new Reader(bake([{ v: 'x' }], { coerce: 'zero' }));
  if (cz.get(0, 'v') !== 0) die('t9 control: coerce:zero stored ' + cz.get(0, 'v') + ' for "x", expected 0');
  const czTrue = new Reader(bake([{ v: true }], { coerce: 'zero' }));
  if (czTrue.get(0, 'v') !== 0) die('t9 control: coerce:zero stored ' + czTrue.get(0, 'v') + ' for true, expected 0 (not 1)');

  // --- Control 8: the t5 cell comparison. A correct expectation must NOT
  // diverge; a wrong-for-one-class expectation (the refuted true->1 coercion)
  // MUST diverge. This exercises the same Object.is cell check t5 uses. ---------
  const oc = new Reader(bake([{ v: true }], { coerce: 'zero' }));
  const cell = oc.get(0, 'v');
  if (!Object.is(cell, 0)) {
    die('t9 control: the t5 cell comparison flagged a correct expectation (vacuous/broken)');
  }
  if (Object.is(cell, 1)) {
    die('t9 control: the t5 cell comparison missed a wrong-for-one-class expectation (true->1)');
  }

  // --- Control 9: the inventory gate. The THROWN (src), DECLARED (d.ts) and
  // PINNED (test scan set) code censuses must agree; diffInventory over the real
  // tree returns empty. This is both the non-vacuity run and the standing gate.
  // Three fail-arms then prove the diff bites each direction. ------------------
  const here = dirname(fileURLToPath(import.meta.url));   // test/torture
  const root = join(here, '..', '..');                    // package root
  const srcText = readFileSync(join(root, 'Bake.js'), 'utf8');
  const dtsText = readFileSync(join(root, 'types', 'index.d.ts'), 'utf8');
  const scanPaths = [];
  const testDir = join(root, 'test');
  const dtEntries = readdirSync(testDir);
  for (let i = 0; i < dtEntries.length; i++) {
    if (dtEntries[i].endsWith('.test.js')) scanPaths.push(join(testDir, dtEntries[i]));
  }
  const tortureEntries = readdirSync(here);
  for (let i = 0; i < tortureEntries.length; i++) {
    const f = tortureEntries[i];
    if (f.endsWith('.mjs') && f !== 'inventory.mjs') scanPaths.push(join(here, f));
  }
  const scanTexts = scanPaths.map((p) => readFileSync(p, 'utf8'));

  const thrown = extractThrown(srcText);
  const declared = extractDeclared(dtsText);
  const pinned = extractPinned(scanTexts);
  const violations = diffInventory(thrown, declared, pinned);
  if (violations.length !== 0) {
    die('t9 control 9: inventory gate is red -- ' + violations.join('; '));
  }
  // 9a: an undeclared, unpinned phantom throw must trip the diff.
  if (diffInventory(thrown.concat(['E_PHANTOM']), declared, pinned).length === 0) {
    die('t9 control 9a: an injected phantom throw did not trip the inventory diff');
  }
  // 9b: dropping a declaration leaves a live throw undeclared -- must trip.
  const cutDeclared = declared.filter((c) => c !== 'E_BAD_TYPE');
  if (diffInventory(thrown, cutDeclared, pinned).length === 0) {
    die('t9 control 9b: removing E_BAD_TYPE from the declared set did not trip the inventory diff');
  }
  // 9c: an alien (double-quoted) pin spelling must stay invisible to extractPinned.
  const alienText = 'if (e.code === "E_ALIEN_SPELL") { /* double-quoted, not a pin */ }';
  if (extractPinned([alienText]).indexOf('E_ALIEN_SPELL') !== -1) {
    die('t9 control 9c: extractPinned recognised an alien (double-quoted) spelling');
  }

  // --- Control 10: the hostile-name oracle, INVERTED after the BK-29 fix. A
  // dropped own prototype-named field ('constructor') now refuses at the drift
  // door (E_MISSING_FIELD) under fixed src's own-key semantics. The knob-off
  // hostileOracle uses hasOwnProperty too, so it MUST MATCH the actual bake.
  // breakHostile INVERTS to the old prototype-inclusive `in`, under which the
  // inherited 'constructor' counts as present, the value door is reached, and
  // E_NON_NUMERIC is predicted -- so it MUST diverge. -------------------------
  const hRec0 = {}; hRec0['constructor'] = 1; hRec0['x'] = 2;   // constructor is an own numeric field
  const hRec1 = {}; hRec1['x'] = 3;                             // constructor dropped -> inherited Function
  const hCorpus = [hRec0, hRec1];
  let hActual = null;
  try { bake(hCorpus); } catch (e) { hActual = e.code; }
  const hOff = hostileOracle(hCorpus, 'default', false);
  if (hOff.throws !== hActual) {
    die('t9 control 10: hostileOracle knob-off predicted ' + hOff.throws + ' but bake gave ' + hActual);
  }
  const hOn = hostileOracle(hCorpus, 'default', true);
  if (hOn.throws === hActual) {
    die('t9 control 10: breakHostile did not diverge from actual bake (both ' + hActual + ')');
  }

  // --- Control 11: the shape oracle. With a non-record at index 3, the full
  // pre-pass refuses E_NOT_A_RECORD before any per-record drift is seen.
  // breakShape (lazy per-index) reaches the drift at index 1 first and predicts
  // E_UNEXPECTED_FIELD, so it MUST diverge; knob off MUST match. ---------------
  const sValid1 = { sa: 1, sb: -200, sc: 0.5 };
  const sDrift = { sa: 1, sb: -200, sc: 0.5, extra: 9 };   // unexpected field at index 1
  const sValid2 = { sa: 2, sb: -201, sc: 1.5 };
  const sCorpus = [sValid1, sDrift, sValid2, 42];
  let sActual = null;
  try { bake(sCorpus); } catch (e) { sActual = e.code; }
  const sOff = shapeOracle(sCorpus, 'default', false);
  if (sOff.throws !== sActual) {
    die('t9 control 11: shapeOracle knob-off predicted ' + sOff.throws + ' but bake gave ' + sActual);
  }
  const sOn = shapeOracle(sCorpus, 'default', true);
  if (sOn.throws === sActual) {
    die('t9 control 11: breakShape did not diverge from actual bake (both ' + sActual + ')');
  }

  // --- Control 12: the cross oracle. An F32 lane fed 0.1 stores Math.fround(0.1).
  // breakCross treats F32 as exact F64 and predicts 0.1, so it MUST diverge from
  // the frounded cell; knob off MUST match. -----------------------------------
  const cSchema = { g0: Types.F32 };
  const cCorpus = [{ g0: 0.1 }, { g0: 0.2 }];
  const cReader = new Reader(bake(cCorpus, { schema: cSchema }));
  const cCell = cReader.get(0, 'g0');   // Math.fround(0.1)
  const cOff = crossOracle(cSchema, cCorpus, 'default', false);
  if (!Object.is(cOff.values[0].g0, cCell)) {
    die('t9 control 12: crossOracle knob-off did not match the frounded cell (' + cOff.values[0].g0 + ' vs ' + cCell + ')');
  }
  const cOn = crossOracle(cSchema, cCorpus, 'default', true);
  if (Object.is(cOn.values[0].g0, cCell)) {
    die('t9 control 12: breakCross did not diverge from the frounded cell (both ' + cCell + ')');
  }

  // --- Control 13: the matrix refusal checker (t3.checkRefusal). A corrupt
  // fixture (stride 0) run with the WRONG expected code passes under breakMatrix
  // (the knob accepts any throw) and is CAUGHT with the knob off (teeth); the
  // correct expected code passes (non-vacuity). ---------------------------------
  const c13Baked = bake([{ a: 1.5 }, { a: 2.5 }]);
  const c13corrupt = () => new Reader({ ...c13Baked, stride: 0 });
  if (checkRefusal(c13corrupt, 'R_BAD_COUNT', { breakMatrix: true }) !== null) {
    die('t9 control 13: breakMatrix did not accept a wrong expected code (knob broken)');
  }
  if (checkRefusal(c13corrupt, 'R_BAD_COUNT', {}) === null) {
    die('t9 control 13: checkRefusal accepted a wrong expected code without the knob (no teeth)');
  }
  if (checkRefusal(c13corrupt, 'R_BAD_STRIDE', {}) !== null) {
    die('t9 control 13: checkRefusal rejected the correct expected code (vacuous/broken)');
  }

  // --- Control 14: the bounds checker (t3.checkBounds). A real reader passes;
  // a fail-open mock (silent returns) is CAUGHT with the knob off (teeth) and
  // passes under breakBounds (the knob accepts a silent out-of-range return). ---
  const c14reader = new Reader(bake([{ a: 10 }, { a: 20 }]));
  const c14broken = { count: 2, get() { return 0; }, row() { return {}; } };
  if (checkBounds(c14reader, {}) !== null) {
    die('t9 control 14: checkBounds flagged a correct bounds policy (vacuous/broken)');
  }
  if (checkBounds(c14broken, {}) === null) {
    die('t9 control 14: checkBounds missed a fail-open reader (no teeth)');
  }
  if (checkBounds(c14broken, { breakBounds: true }) !== null) {
    die('t9 control 14: breakBounds did not accept a silent out-of-range return (knob broken)');
  }

  // --- Control 15: fromBytes honesty (t3.checkRoundTrip). The default factory
  // (Reader.fromBytes) passes the pooled/offset round-trip; a byteOffset-ignoring
  // factory (new Reader({buffer: bytes.buffer, ...})) reads the junk head and is
  // CAUGHT -- proving the gate would catch a BK-05-regressing fromBytes. --------
  const c15broken = (bytes, meta) =>
    new Reader({ buffer: bytes.buffer, stride: meta.stride, count: meta.count, schema: meta.schema });
  if (checkRoundTrip() !== null) {
    die('t9 control 15: the default fromBytes factory failed the honest round-trip (vacuous/broken)');
  }
  if (checkRoundTrip(c15broken) === null) {
    die('t9 control 15: a byteOffset-ignoring factory passed the round-trip (would not catch a BK-05 regression)');
  }

  // --- Control 16: the breakLane knob (the fit door). An explicit int-lane
  // override fed a value it cannot hold exactly refuses E_LANE_MISMATCH.
  // crossOracle with breakLane off predicts that refusal and MUST match the
  // actual bake; breakLane skips the fit door and predicts the old wrapped store
  // (no throw), so it MUST diverge. A non-vacuity twin proves the knob-off oracle
  // still passes an in-range corpus that genuinely bakes clean. -----------------
  const c16Schema = { g0: Types.U8 };
  const c16Corpus = [{ g0: 10 }, { g0: 256 }];   // 256 does not fit U8
  let c16Actual = null;
  try { bake(c16Corpus, { schema: c16Schema }); } catch (e) { c16Actual = e.code; }
  const c16Off = crossOracle(c16Schema, c16Corpus, 'default', false, false);
  if (c16Off.throws !== c16Actual) {
    die('t9 control 16: crossOracle knob-off predicted ' + c16Off.throws + ' but bake gave ' + c16Actual);
  }
  const c16On = crossOracle(c16Schema, c16Corpus, 'default', false, true);
  if (c16On.throws === c16Actual) {
    die('t9 control 16: breakLane did not diverge from the fit-door refusal (both ' + c16Actual + ')');
  }
  // Non-vacuity twin: an in-range corpus is predicted clean and bakes clean.
  const c16Good = [{ g0: 10 }, { g0: 20 }];
  const c16GoodExp = crossOracle(c16Schema, c16Good, 'default', false, false);
  if (c16GoodExp.throws) {
    die('t9 control 16: crossOracle predicted a throw on an in-range corpus (vacuous/broken)');
  }
  let c16GoodErr = null;
  try { bake(c16Good, { schema: c16Schema }); } catch (e) { c16GoodErr = e; }
  if (c16GoodErr) die('t9 control 16: bake refused an in-range corpus (' + c16GoodErr.code + ')');

  // --- Control 17: t8.checkLaneParity. Two identical rows-of-cells agree
  // (non-vacuity twin returns null); a single divergent cell is caught (teeth).
  // This is the same Object.is cell comparison t8's F64 lane-parity check uses. --
  if (checkLaneParity([[1.5, -3.25]], [[1.5, -3.25]]) !== null) {
    die('t9 control 17: checkLaneParity flagged identical cells (vacuous/broken)');
  }
  if (checkLaneParity([[1.5, -3.25]], [[1.5, -3.5]]) === null) {
    die('t9 control 17: checkLaneParity missed a divergent cell (no teeth)');
  }

  // --- Control 18: t8.checkU32Semantics. Our side must be a numeric string-table
  // index and the sibling side a non-empty string (twin returns null); a string
  // on our side (no numeric index) is caught (teeth). -------------------------
  if (checkU32Semantics(1, 'zebra') !== null) {
    die('t9 control 18: checkU32Semantics flagged a valid index/string pair (vacuous/broken)');
  }
  if (checkU32Semantics('zebra', 'zebra') === null) {
    die('t9 control 18: checkU32Semantics accepted a non-numeric our-side cell (no teeth)');
  }

  // --- Control 19: t8.checkLaneCodes. The pinned table (wire F64=1, U32=3;
  // Types.F64=1, U32=5) returns null (twin); a converged wire byte (U32=5,
  // matching Types) is flagged as the deliberate-diff event it must remain (teeth).
  if (checkLaneCodes({ wireF64: 1, wireU32: 3, typesF64: 1, typesU32: 5 }) !== null) {
    die('t9 control 19: checkLaneCodes flagged the pinned lane-code table (vacuous/broken)');
  }
  if (checkLaneCodes({ wireF64: 1, wireU32: 5, typesF64: 1, typesU32: 5 }) === null) {
    die('t9 control 19: checkLaneCodes missed a converged wire lane byte (no teeth)');
  }

  // --- Control 20: t8.checkWrongFile. A misread that differs from the true
  // corpus proves the hazard is real (twin returns null); identical arrays would
  // mean accidental interop and falsify the documented hazard, so they are
  // flagged (teeth). ------------------------------------------------------------
  if (checkWrongFile([[9, 9]], [[1.5, -3.25]]) !== null) {
    die('t9 control 20: checkWrongFile flagged a genuinely divergent misread (vacuous/broken)');
  }
  if (checkWrongFile([[1.5, -3.25]], [[1.5, -3.25]]) === null) {
    die('t9 control 20: checkWrongFile accepted an accidental-interop match (no teeth)');
  }

  // --- Control 21: t8.checkExports. The real three texts agree (twin returns
  // []); an injected ghost value export in the src text is named (teeth). The
  // fs reads here reuse Control 9's srcText/dtsText plus the real llms.txt. ------
  const c21Llms = readFileSync(join(root, 'llms.txt'), 'utf8');
  if (checkExports(srcText, dtsText, c21Llms).length !== 0) {
    die('t9 control 21: checkExports flagged the real export surface (vacuous/broken)');
  }
  const c21Ghost = checkExports(srcText + '\nexport const Ghost = 1;', dtsText, c21Llms);
  if (c21Ghost.length === 0 || c21Ghost.join('; ').indexOf('Ghost') === -1) {
    die('t9 control 21: checkExports did not name an injected ghost export (no teeth)');
  }

  // --- Control 22: t8.checkBytesTables. The real harness + src BYTES tables
  // match (twin returns []); a doctored harness text with a mutated element is
  // flagged (teeth). ------------------------------------------------------------
  const c22Harness = readFileSync(join(here, 'harness.mjs'), 'utf8');
  if (checkBytesTables(c22Harness, srcText).length !== 0) {
    die('t9 control 22: checkBytesTables flagged the real matching BYTES tables (vacuous/broken)');
  }
  if (checkBytesTables('const BYTES = [4, 8, 4, 2, 1, 4, 2, 2];', srcText).length === 0) {
    die('t9 control 22: checkBytesTables missed a mutated BYTES element (no teeth)');
  }

  // --- Control 23: t8.checkDocsPins. The real README + llms.txt carry every
  // present-pin and no absent-pin (twin returns []); a README missing the
  // Ecosystem heading is flagged (presence teeth), and one carrying the stale
  // roadmap phrase is flagged (absence teeth). ---------------------------------
  const c23Readme = readFileSync(join(root, 'README.md'), 'utf8');
  if (checkDocsPins(c23Readme, c21Llms).length !== 0) {
    die('t9 control 23: checkDocsPins flagged the real docs stanzas (vacuous/broken)');
  }
  const c23NoEco = c23Readme.replace('## Ecosystem', '## Elsewhere');
  if (checkDocsPins(c23NoEco, c21Llms).length === 0) {
    die('t9 control 23: checkDocsPins missed a README missing the Ecosystem heading (no presence teeth)');
  }
  if (checkDocsPins(c23Readme + '\nstill on the roadmap\n', c21Llms).length === 0) {
    die('t9 control 23: checkDocsPins missed a resurrected stale roadmap phrase (no absence teeth)');
  }
}
