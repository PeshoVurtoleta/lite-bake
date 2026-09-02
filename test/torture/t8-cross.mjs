/**
 * t8 -- cross-package parity (lite-bake <-> lite-bake-stream). LIVE as of B4.
 *
 * This tier pins the measured cross-package contract against the PINNED PUBLISHED
 * @zakkster/lite-bake-stream@1.6.0 (a dev-only, exact-pinned peer -- a range would
 * let the gate drift off the artifact it proves). The suite has ONE wire format,
 * LBK1, owned by the sibling; this package mints none (decisions/0006). t8 proves
 * the boundary so any future convergence is a deliberate diff, not silent drift.
 *
 * Checks (each die()s with named evidence on violation):
 *   a  LANE PARITY     -- F64 lane cells agree cell-for-cell through the B2
 *                         Reader.fromBytes seam, BOTH against the sibling's own
 *                         reader AND against the corpus source of truth.
 *   b  U32 SEMANTICS   -- the documented divergence: our reader sees the string-
 *                         table INDEX (a number); theirs resolves the interned
 *                         string.
 *   c  LANE-CODE TABLE -- the wire lane_kind bytes vs the Types enum: wire F64=1
 *                         is the ONLY shared code point; wire U32=3 vs Types.U32=5.
 *   d  WRONG-FILE      -- BK-05's no-magic half, made executable: a shape-coherent
 *                         but wrong-span view constructs and visibly misreads.
 *   e  EXPORT DRIFT    -- src value exports == {LiteBakeError,bake,Reader,Types},
 *                         each present in llms.txt and the d.ts (value exports).
 *   f  BYTES DRIFT     -- the BYTES table duplicated in harness.mjs vs src.
 *   g  DOCS PINS       -- the README/llms.txt ecosystem stanzas exist as written.
 *
 * DETERMINISM: fixed corpus, no PRNG anywhere in this file. IGNORES-BREAK: t8
 * does not import BAKE_TORTURE_BREAK and never consults it -- proving t8 itself
 * can fail is t9's job (Controls 17-23 drive each pure helper below with teeth +
 * a non-vacuity twin). t8 runs on the cold path with no runOpsGate, so it sits
 * OUTSIDE every gc-profiler measurement window.
 *
 * Style mirrors inventory.mjs: PURE exported helpers (plain values/text in ->
 * null-or-violation out, zero fs/network inside them) plus a run() that does all
 * IO and extraction and drives them. The sibling and src are imported dynamically
 * INSIDE run() so merely loading this module never requires the devDep --
 * torture.mjs's preflight owns that failure path.
 *
 * @license MIT
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { die } from './harness.mjs';

/** The fixed corpus. Deterministic; the ONE source of truth for cell values. */
const NDJSON = '{"x":1.5,"y":-3.25,"s":"zebra"}\n{"x":2.5,"y":7,"s":"ant"}\n{"x":-0.125,"y":1e6,"s":"zebra"}\n';

/** The sibling schema: two f64 lanes and a u32 (string-table index) lane. */
const SIB_SCHEMA = {
  writer: {
    schema: {
      fields: [
        { name: 'x', laneKind: 'f64' },
        { name: 'y', laneKind: 'f64' },
        { name: 's', laneKind: 'u32' },
      ],
    },
  },
};

/* -------------------------------------------------------------------------- *
 * Pure helpers -- exported so t9 can feed them synthetic inputs with no disk
 * touch. Each returns null/[] on agreement and a violation string / array on a
 * divergence. No fs, no imports of the sibling: text and plain values only.
 * -------------------------------------------------------------------------- */

/**
 * checkLaneParity(cellsA, cellsB) -> null | violation string.
 * Both are arrays-of-rows of F64 cell numbers. Reports the FIRST divergence
 * (row, field index, both values) under Object.is. A shape mismatch (differing
 * row or field counts) is itself a violation.
 */
export function checkLaneParity(cellsA, cellsB) {
  if (cellsA.length !== cellsB.length) {
    return 'row-count mismatch: ' + cellsA.length + ' vs ' + cellsB.length;
  }
  for (let i = 0; i < cellsA.length; i++) {
    const ra = cellsA[i];
    const rb = cellsB[i];
    if (ra.length !== rb.length) {
      return 'row ' + i + ' field-count mismatch: ' + ra.length + ' vs ' + rb.length;
    }
    for (let f = 0; f < ra.length; f++) {
      if (!Object.is(ra[f], rb[f])) {
        return 'row ' + i + ' field ' + f + ' diverges: ' + ra[f] + ' vs ' + rb[f];
      }
    }
  }
  return null;
}

/**
 * checkU32Semantics(idx, str) -> null | violation string. The documented
 * difference: our reader sees a numeric string-table INDEX; theirs resolves the
 * interned STRING. Null iff idx is an integer number and str is a non-empty
 * string.
 */
export function checkU32Semantics(idx, str) {
  if (typeof idx !== 'number' || !Number.isInteger(idx)) {
    return 'our u32 cell is not an integer index: ' + String(idx) + ' (' + typeof idx + ')';
  }
  if (typeof str !== 'string' || str.length === 0) {
    return 'sibling u32 cell is not a non-empty string: ' + String(str) + ' (' + typeof str + ')';
  }
  return null;
}

/**
 * checkLaneCodes({wireF64,wireU32,typesF64,typesU32}) -> null | violation string.
 * The lane-code table divergence, pinned as deliberate. Wire bytes come from the
 * LBK1 descriptors; the Types codes from this package. Null iff wire F64=1,
 * Types.F64=1 (the ONLY shared code point), wire U32=3, Types.U32=5.
 */
export function checkLaneCodes(c) {
  const bad = [];
  if (c.wireF64 !== 1) bad.push('wire F64 lane_kind expected 1, got ' + c.wireF64);
  if (c.typesF64 !== 1) bad.push('Types.F64 expected 1, got ' + c.typesF64);
  if (c.wireU32 !== 3) bad.push('wire U32 lane_kind expected 3, got ' + c.wireU32);
  if (c.typesU32 !== 5) bad.push('Types.U32 expected 5, got ' + c.typesU32);
  return bad.length === 0 ? null : bad.join('; ');
}

/**
 * checkWrongFile(misreadCells, trueCells) -> null | violation string. BK-05's
 * no-magic half: a wrong-span view of the container reads shape-coherent but
 * wrong. Null iff AT LEAST ONE cell differs (Object.is-wise) from the true
 * corpus cells; a violation if ALL match (that would mean accidental interop and
 * would falsify the documented "no detection" hazard).
 */
export function checkWrongFile(misreadCells, trueCells) {
  if (misreadCells.length !== trueCells.length) return null; // a shape divergence is itself a mismatch
  let anyDiff = false;
  for (let i = 0; i < misreadCells.length && !anyDiff; i++) {
    const m = misreadCells[i];
    const t = trueCells[i];
    if (m.length !== t.length) { anyDiff = true; break; }
    for (let f = 0; f < m.length; f++) {
      if (!Object.is(m[f], t[f])) { anyDiff = true; break; }
    }
  }
  if (!anyDiff) {
    return 'a wrong-span (wrong-file) read matched the true corpus cell-for-cell -- ' +
      'the documented no-detection hazard would be false';
  }
  return null;
}

/**
 * checkExports(srcText, dtsText, llmsText) -> array of violation strings.
 * The export set src declares must be exactly {LiteBakeError,bake,Reader,Types},
 * each must appear in llms.txt, and each must be declared as an export in the
 * d.ts. Only VALUE exports are checked on both sides: type-only d.ts exports
 * (BakeErrorCode, BakedMeta, Field, Baked, BakeOptions, FieldTypeCode,
 * interfaces) are EXEMPT by design -- they carry no runtime surface.
 */
export function checkExports(srcText, dtsText, llmsText) {
  const out = [];
  const EXPECTED = ['LiteBakeError', 'bake', 'Reader', 'Types'];

  // Extract src value-export names.
  const srcSet = Object.create(null);
  const reSrc = /^export (?:class|function|const) ([A-Za-z0-9_]+)/gm;
  let m;
  while ((m = reSrc.exec(srcText)) !== null) srcSet[m[1]] = true;

  // src set must equal EXPECTED exactly (order-free).
  for (let i = 0; i < EXPECTED.length; i++) {
    if (!srcSet[EXPECTED[i]]) out.push('src is missing expected export ' + EXPECTED[i]);
  }
  for (const name in srcSet) {
    if (EXPECTED.indexOf(name) === -1) out.push('src has unexpected export ' + name);
  }

  // Each expected export must be named in llms.txt and declared in the d.ts.
  for (let i = 0; i < EXPECTED.length; i++) {
    const name = EXPECTED[i];
    if (llmsText.indexOf(name) === -1) out.push('llms.txt does not mention export ' + name);
    const reDts = new RegExp('export (?:declare )?(?:class|function|const|interface|type)? ?\\b' + name + '\\b');
    if (!reDts.test(dtsText)) out.push('d.ts does not declare an export named ' + name);
  }

  // Every VALUE export declared in the d.ts must be in the src set. Value
  // exports only: `export class`, `export function`, `export const`. Type-only
  // exports (`export type`, `export interface`) are exempt.
  const reDtsVal = /^export (?:declare )?(?:class|function|const) ([A-Za-z0-9_]+)/gm;
  while ((m = reDtsVal.exec(dtsText)) !== null) {
    if (!srcSet[m[1]]) out.push('d.ts value export ' + m[1] + ' has no matching src export');
  }
  return out;
}

/**
 * checkBytesTables(harnessText, srcText) -> array of violation strings. The
 * BYTES table is duplicated in harness.mjs (by charter, harness.mjs:49-51) and
 * in src; they must stay element-for-element identical. harness.mjs itself stays
 * byte-untouched -- this guard reads its text.
 */
export function checkBytesTables(harnessText, srcText) {
  const out = [];
  const parse = (text, where) => {
    const mm = /const BYTES = \[([^\]]+)\]/.exec(text);
    if (mm === null) { out.push('no BYTES table found in ' + where); return null; }
    return mm[1].split(',').map((n) => Number(n.trim()));
  };
  const a = parse(harnessText, 'harness.mjs');
  const b = parse(srcText, 'src/index.js');
  if (a === null || b === null) return out;
  if (a.length !== b.length) {
    out.push('BYTES length differs: harness ' + a.length + ' vs src ' + b.length);
    return out;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push('BYTES[' + i + '] differs: harness ' + a[i] + ' vs src ' + b[i]);
  }
  return out;
}

/**
 * checkDocsPins(readmeText, llmsText) -> array of violation strings. The
 * ecosystem stanzas must exist as written; these pins are why README.md and
 * llms.txt ride the same commit as this tier.
 */
export function checkDocsPins(readmeText, llmsText) {
  const out = [];
  const readmePresent = ['## Ecosystem', 'lite-bake-stream', 'LBK1', '**not portable across endianness**'];
  for (let i = 0; i < readmePresent.length; i++) {
    if (readmeText.indexOf(readmePresent[i]) === -1) {
      out.push('README missing required text: ' + readmePresent[i]);
    }
  }
  const readmeAbsent = ['still on the roadmap', 'Round-trips work on both LE'];
  for (let i = 0; i < readmeAbsent.length; i++) {
    if (readmeText.indexOf(readmeAbsent[i]) !== -1) {
      out.push('README still carries stale text: ' + readmeAbsent[i]);
    }
  }
  if (llmsText.indexOf('lite-bake-stream') === -1) {
    out.push('llms.txt does not mention lite-bake-stream');
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Vendored LBK1 parser. Frozen format_version 1; a local helper so t8 pins the
 * wire bytes directly and never greps the sibling's SPEC/prose.
 * -------------------------------------------------------------------------- */

/**
 * parseLBK1(container) -> { rowStride, rowCount, payloadOff, payloadLen, descs }.
 * descs is [{ name, offsetInRow, laneKind }]. die()s (naming the tier and the
 * actual bytes) if the magic is wrong.
 */
function parseLBK1(container) {
  if (container[0] !== 0x4c || container[1] !== 0x42 ||
      container[2] !== 0x4b || container[3] !== 0x31) {
    die('t8 parseLBK1: bad magic -- expected LBK1, got bytes ' +
      container[0] + ',' + container[1] + ',' + container[2] + ',' + container[3]);
  }
  // Never assume byteOffset 0.
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const schemaOff = Number(dv.getBigUint64(8, true));
  const shardDirOff = Number(dv.getBigUint64(24, true));

  const fieldCount = dv.getUint32(schemaOff, true);
  const rowStride = dv.getUint32(schemaOff + 4, true);

  const descs = new Array(fieldCount);
  let p = schemaOff + 8;
  const nameStrOffs = new Array(fieldCount);
  const nameLens = new Array(fieldCount);
  for (let i = 0; i < fieldCount; i++) {
    nameLens[i] = dv.getUint16(p + 0, true);
    const offsetInRow = dv.getUint16(p + 2, true);
    const laneKind = dv.getUint8(p + 4);
    nameStrOffs[i] = Number(dv.getBigUint64(p + 8, true));
    descs[i] = { name: '', offsetInRow: offsetInRow, laneKind: laneKind };
    p += 24;
  }
  const nameBlobOff = p;
  const td = new TextDecoder();
  for (let i = 0; i < fieldCount; i++) {
    const start = nameBlobOff + 4 + nameStrOffs[i];
    descs[i].name = td.decode(container.subarray(start, start + nameLens[i]));
  }

  const payloadOff = Number(dv.getBigUint64(shardDirOff + 0, true));
  const payloadLen = dv.getUint32(shardDirOff + 8, true);
  const rowCount = dv.getUint32(shardDirOff + 12, true);

  return { rowStride: rowStride, rowCount: rowCount, payloadOff: payloadOff, payloadLen: payloadLen, descs: descs };
}

/** Find a descriptor by name; die if absent (fail closed). */
function descByName(descs, name) {
  for (let i = 0; i < descs.length; i++) {
    if (descs[i].name === name) return descs[i];
  }
  die('t8: LBK1 schema has no field named ' + name);
  return null;
}

/* -------------------------------------------------------------------------- *
 * run() -- owns all IO and extraction; drives every pure helper above.
 * Dynamic imports keep the devDep off this module's load path.
 * -------------------------------------------------------------------------- */

export async function run() {
  const { serialize, deserialize } = await import('@zakkster/lite-bake-stream');
  const { Reader, Types } = await import('../../src/index.js');

  // 1. serialize the corpus; parse the LBK1 container.
  const container = serialize(NDJSON, SIB_SCHEMA);
  const lbk = parseLBK1(container);

  // RECS: the corpus records, the source of truth for true values (derived).
  const RECS = [];
  const lines = NDJSON.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length === 0) continue;
    RECS.push(JSON.parse(lines[i]));
  }

  // 2. build lite-bake meta from the descriptors.
  const meta = {
    stride: lbk.rowStride,
    count: lbk.rowCount,
    schema: lbk.descs.map((d) => {
      if (d.laneKind !== 1 && d.laneKind !== 3) {
        die('t8: unexpected LBK1 lane_kind ' + d.laneKind + ' for field ' + d.name +
          ' (this corpus is f64/u32 only)');
      }
      return { name: d.name, type: d.laneKind === 1 ? Types.F64 : Types.U32, offset: d.offsetInRow };
    }),
  };

  // 3. LANE PARITY (check a). ours = the B2 fromBytes seam over the shard
  // payload; theirs = the sibling's own reader.
  const ours = Reader.fromBytes(container.subarray(lbk.payloadOff, lbk.payloadOff + lbk.payloadLen), meta);
  const theirs = deserialize(container);

  const F64_FIELDS = ['x', 'y'];
  const oursCells = new Array(lbk.rowCount);
  const theirsCells = new Array(lbk.rowCount);
  const trueCells = new Array(lbk.rowCount);
  for (let i = 0; i < lbk.rowCount; i++) {
    const ro = new Array(F64_FIELDS.length);
    const rt = new Array(F64_FIELDS.length);
    const rc = new Array(F64_FIELDS.length);
    for (let f = 0; f < F64_FIELDS.length; f++) {
      const name = F64_FIELDS[f];
      ro[f] = ours.get(i, name);
      rt[f] = theirs.get(i, name);
      rc[f] = RECS[i][name];
    }
    oursCells[i] = ro;
    theirsCells[i] = rt;
    trueCells[i] = rc;
  }
  const mutual = checkLaneParity(oursCells, theirsCells);
  if (mutual !== null) die('t8 check a (lane parity, ours vs sibling): ' + mutual);
  const toSource = checkLaneParity(oursCells, trueCells);
  if (toSource !== null) die('t8 check a (lane parity, ours vs corpus source): ' + toSource);

  // 4. U32 SEMANTICS (check b). Our reader sees the string-table index; theirs
  // resolves the interned string.
  const uIdx = ours.get(0, 's');
  const uStr = theirs.get(0, 's');
  const uViol = checkU32Semantics(uIdx, uStr);
  if (uViol !== null) die('t8 check b (u32 semantics): ' + uViol);

  // 5. LANE-CODE TABLE (check c). Wire bytes only.
  const dx = descByName(lbk.descs, 'x');
  const ds = descByName(lbk.descs, 's');
  const cViol = checkLaneCodes({
    wireF64: dx.laneKind, wireU32: ds.laneKind, typesF64: Types.F64, typesU32: Types.U32,
  });
  if (cViol !== null) die('t8 check c (lane-code table): ' + cViol);

  // 6. WRONG-FILE HONESTY (check d). A non-full-span view of the header region
  // forces fromBytes' copy path; it constructs (shape-coherent) and misreads
  // container HEADER bytes as rows.
  const naive = Reader.fromBytes(container.subarray(0, lbk.rowStride * lbk.rowCount), meta);
  const misreadCells = new Array(lbk.rowCount);
  for (let i = 0; i < lbk.rowCount; i++) {
    const mr = new Array(F64_FIELDS.length);
    for (let f = 0; f < F64_FIELDS.length; f++) mr[f] = naive.get(i, F64_FIELDS[f]);
    misreadCells[i] = mr;
  }
  const dViol = checkWrongFile(misreadCells, trueCells);
  if (dViol !== null) die('t8 check d (wrong-file honesty): ' + dViol);

  // 7. EXPORT DRIFT GUARD (check e).
  const here = dirname(fileURLToPath(import.meta.url));   // test/torture
  const root = join(here, '..', '..');                    // package root
  const srcText = readFileSync(join(root, 'src', 'index.js'), 'utf8');
  const dtsText = readFileSync(join(root, 'types', 'index.d.ts'), 'utf8');
  const llmsText = readFileSync(join(root, 'llms.txt'), 'utf8');
  const eViol = checkExports(srcText, dtsText, llmsText);
  if (eViol.length !== 0) die('t8 check e (export drift): ' + eViol.join('; '));

  // 8. BYTES DRIFT GUARD (check f).
  const harnessText = readFileSync(join(here, 'harness.mjs'), 'utf8');
  const fViol = checkBytesTables(harnessText, srcText);
  if (fViol.length !== 0) die('t8 check f (BYTES drift): ' + fViol.join('; '));

  // 9. DOCS-PRESENCE PINS (check g).
  const readmeText = readFileSync(join(root, 'README.md'), 'utf8');
  const gViol = checkDocsPins(readmeText, llmsText);
  if (gViol.length !== 0) die('t8 check g (docs pins): ' + gViol.join('; '));
}
