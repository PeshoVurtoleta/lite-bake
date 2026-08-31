// @zakkster/lite-bake / findings probes (2026-09-01)
// Copyright (c) 2026 Zahary Shinikchiev. MIT.
//
// Reproduction probes behind every runnable BK-* finding in /ROADMAP.md
// section 2, plus the XP-* cross-package contract probes against the
// PUBLISHED @zakkster/lite-bake-stream (1.3.0, installed with
// `npm install --no-save --no-package-lock` -- package.json untouched).
//
// Run:  node bench/findings-probes-2026-09-01.mjs
//
// Every probe prints "PROBE <id>: <verdict> -- <evidence>" against the
// published v1.0.1 bytes (local tree shasum-identical to the registry
// tarball at eval time). As roadmap sessions land, probes flip to
// NOT-REPRODUCED; B0 ports each one into the torture tiers as a named
// (initially `todo`) test. This file is a record, not a gate; the gate
// will be test/torture.mjs.
//
// Structural findings (BK-14..BK-26) are verified by grep/ls; evidence is
// in ROADMAP.md section 2 and is not duplicated here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { bake, Reader, Types } from '../src/index.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lbake-probes-'));
let reproduced = 0, notReproduced = 0, partial = 0, inconclusive = 0;

function report(id, verdict, evidence) {
  if (verdict.startsWith('REPRODUCED')) reproduced++;
  else if (verdict.startsWith('NOT-REPRODUCED')) notReproduced++;
  else if (verdict.startsWith('PARTIAL')) partial++;
  else inconclusive++;
  console.log('PROBE ' + id + ': ' + verdict + ' -- ' + evidence);
}
function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

// ---------- BK-01: integer inference has no 32-bit ceiling; values wrap silently ----------
{
  const a = new Reader(bake([{ v: 2 ** 32 }])).get(0, 'v');            // U32 lane, >>> 0
  const b = new Reader(bake([{ v: -(2 ** 31) - 1 }])).get(0, 'v');     // I32 lane, | 0
  const c = new Reader(bake([{ v: 2 ** 53 }])).get(0, 'v');            // U32 lane, >>> 0
  const wrapped = a === 0 && b === 2147483647 && c === 0;
  report('BK-01-int-ceiling-wrap', wrapped ? 'REPRODUCED' : (a === 2 ** 32 ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'bake([{v:2**32}]) reads back ' + a + '; bake([{v:-(2**31)-1}]) reads back ' + b +
    '; bake([{v:2**53}]) reads back ' + c +
    ' (README table caps U32 at 4294967295 and I32 at -2**31, but inferType() has no upper door;' +
    ' the write path masks with >>>0 / |0; F64 is never inferred)');
}

// ---------- BK-02: "smallest type that FITS" infers F32 for doubles it cannot represent ----------
{
  const b1 = bake([{ v: 0.1 }]);
  const t1 = b1.schema[0].type;
  const v1 = new Reader(b1).get(0, 'v');
  const b2 = bake([{ v: 0.5 }, { v: 20000001 }]);      // mixed column -> F32, int > 2^24 loses a digit
  const v2 = new Reader(b2).get(1, 'v');
  const lossy = t1 === Types.F32 && v1 !== 0.1 && v2 === 20000000;
  report('BK-02-f32-precision-loss', lossy ? 'REPRODUCED' : ((t1 === Types.F64 && v1 === 0.1) ? 'NOT-REPRODUCED' : 'PARTIAL'),
    '0.1 infers F32 (type=' + t1 + ') and reads back ' + v1 +
    '; mixed [0.5, 20000001] reads back ' + v2 +
    ' (docs promise the smallest type that fits every value; F32 does not fit either value,' +
    ' F64 is unreachable by inference -- override-only)');
}

// ---------- BK-03: NaN and -0 destroyed even under an explicit F64 override ----------
{
  const rNan = new Reader(bake([{ v: NaN }], { schema: { v: Types.F64 } })).get(0, 'v');
  const rNegZero = new Reader(bake([{ v: -0 }], { schema: { v: Types.F64 } })).get(0, 'v');
  const destroyed = rNan === 0 && Object.is(rNegZero, 0) && !Object.is(rNegZero, -0);
  report('BK-03-nan-negzero-destroyed', destroyed ? 'REPRODUCED'
      : (Number.isNaN(rNan) && Object.is(rNegZero, -0) ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'explicit F64 lane: NaN stores as ' + rNan + ', -0 stores as ' + (Object.is(rNegZero, -0) ? '-0' : '+0') +
    ' (the write path is `+v || 0`: NaN and -0 are falsy, so two values the F64 lane CAN represent' +
    ' are silently replaced by +0 even when the user forced the widest lane)');
}

// ---------- BK-04: truthy non-numbers are silently COERCED, not zeroed as documented ----------
{
  const r = new Reader(bake([{ v: true }, { v: '42.5' }, { v: [7] }, { v: 'abc' }, { v: {} }]));
  const got = [r.get(0, 'v'), r.get(1, 'v'), r.get(2, 'v'), r.get(3, 'v'), r.get(4, 'v')];
  const coerced = got[0] === 1 && got[1] === 42.5 && got[2] === 7 && got[3] === 0 && got[4] === 0;
  report('BK-04-truthy-coercion', coerced ? 'REPRODUCED' : (got.every((x) => x === 0) ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'true -> ' + got[0] + ', "42.5" -> ' + got[1] + ', [7] -> ' + got[2] + ', "abc" -> ' + got[3] + ', {} -> ' + got[4] +
    ' (README: "Non-number (string, null, mixed) -> F32 (stored as 0)" and "Strings are silently ignored ...' +
    ' stored as F32 zeros" -- `+v` coerces booleans, numeric strings, and single-element arrays to their' +
    ' numeric values instead)');
}

// ---------- BK-05: the README FAQ disk recipe silently misreads via Node's Buffer pool ----------
{
  const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
  const fileA = path.join(TMP, 'junk.bin');
  const fileB = path.join(TMP, 'baked.bin');
  fs.writeFileSync(fileA, Uint8Array.from({ length: 16 }, () => 0xAA));
  fs.writeFileSync(fileB, new Uint8Array(baked.buffer));               // the documented write
  fs.readFileSync(fileA);                                              // occupies the pool head
  const buf = fs.readFileSync(fileB);                                  // small file -> pooled, byteOffset > 0
  if (buf.byteOffset === 0) {
    report('BK-05-pooled-buffer-recipe', 'INCONCLUSIVE', 'readFileSync returned an unpooled Buffer on this node build');
  } else {
    // The natural reconstruction of the FAQ recipe ("record the schema ... to reconstruct the Reader"):
    const r2 = new Reader({ buffer: buf.buffer, stride: baked.stride, count: baked.count, schema: baked.schema });
    const got = r2.get(0, 'x');
    report('BK-05-pooled-buffer-recipe', got !== 1234.5 ? 'REPRODUCED' : 'PARTIAL',
      'baked x=1234.5 written to disk per the FAQ; readFileSync returns a pooled view (byteOffset=' + buf.byteOffset +
      '); Reader({buffer: buf.buffer, ...}) reads ' + got +
      ' -- pool bytes, not file bytes. No fromBuffer/deserialize honors byteOffset, and with no magic/header' +
      ' in the format nothing detects the misread');
  }
}

// ---------- BK-06: validate:true does not validate values (README says it catches null) ----------
{
  let v0 = null, v1 = null;
  const e1 = caught(() => { const r = new Reader(bake([{ v: null }, { v: 2 }], { validate: true })); v0 = r.get(0, 'v'); v1 = r.get(1, 'v'); });
  const e2 = caught(() => bake([{ v: 'boom' }, { v: 'x' }], { validate: true }));
  report('BK-06-validate-ignores-values', (!e1 && !e2 && v0 === 0) ? 'REPRODUCED' : ((e1 || e2) ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'validate:true accepts {v:null} (reads back ' + v0 + ', sibling value ' + v1 + ') and all-string records' +
    ' without a throw (README: "Null / undefined / missing fields become 0 ... unless you pass' +
    ' { validate: true }" -- validate checks key sets only, never values or types)');
}

// ---------- BK-07: schema override fails open on garbage type codes and unknown fields ----------
{
  let b1 = null, g1;
  const e1 = caught(() => { b1 = bake([{ v: 1.5 }], { schema: { v: 99 } }); g1 = new Reader(b1).get(0, 'v'); });
  let b2 = null;
  const e2 = caught(() => { b2 = bake([{ v: 1.5 }], { schema: { v: 'F64' } }); });
  let b3 = null;
  const e3 = caught(() => { b3 = bake([{ a: 1 }], { schema: { ghost: Types.F32 } }); });
  const open = !e1 && b1.buffer.byteLength === 0 && g1 === undefined &&
               !e2 && b2.buffer.byteLength === 0 &&
               !e3 && !b3.schema.some((f) => f.name === 'ghost');
  report('BK-07-schema-override-failopen', open ? 'REPRODUCED' : ((e1 && e2 && e3) ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'type code 99 -> ' + (e1 ? 'throws ' + e1.name : 'bakes a ' + b1.buffer.byteLength + '-byte buffer, stride ' + b1.stride + ', get() = ' + g1) +
    "; string code 'F64' -> " + (e2 ? 'throws' : b2.buffer.byteLength + '-byte buffer') +
    '; override for a field not in the records -> ' + (e3 ? 'throws' : 'silently ignored') +
    ' (BYTES[badType] is undefined; NaN stride arithmetic collapses to a 0-byte container with no error)');
}

// ---------- BK-08: bake() opts fail open -- typo'd keys silently disable features ----------
{
  let b = null;
  const e = caught(() => { b = bake([{ v: 1.5 }], { shcema: { v: Types.F64 }, validat: true, strict: true }); });
  const open = !e && b.schema[0].type === Types.F32;
  report('BK-08-opts-failopen', open ? 'REPRODUCED' : (e ? 'NOT-REPRODUCED' : 'PARTIAL'),
    "opts { shcema, validat, strict } accepted without complaint; field inferred F32 (type=" +
    (b ? b.schema[0].type : 'n/a') + ') -- the typo silently disabled both the override and validation' +
    ' (suite law: unknown option key is an error with a did-you-mean hint)');
}

// ---------- BK-09: Reader trusts `baked` blindly -- lying metadata reads undefined ----------
{
  let r = null, hot, eGet = null;
  const eCtor = caught(() => {
    r = new Reader({ buffer: new ArrayBuffer(8), stride: 16, count: 100, schema: [{ name: 'x', type: Types.F64, offset: 0 }] });
    hot = r.f64[1 * r.strideF64 + 0];             // the documented hot-loop pattern, row 1 of "100"
    eGet = caught(() => r.get(1, 'x'));
  });
  const eOdd = caught(() => new Reader({ buffer: new ArrayBuffer(12), stride: 4, count: 3, schema: [{ name: 'x', type: Types.F32, offset: 0 }] }));
  const open = !eCtor && hot === undefined && eGet && eGet.name === 'RangeError' && !eGet.code &&
               eOdd && eOdd.name === 'RangeError' && !eOdd.code;
  report('BK-09-reader-trusts-baked', open ? 'REPRODUCED' : (eCtor ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'count=100 x stride=16 over an 8-byte buffer constructs cleanly; hot-loop read of row 1 = ' + hot +
    ' (silent undefined -> NaN math downstream); get(1) -> raw ' + (eGet ? eGet.name : 'ok') +
    '; a 12-byte buffer -> raw ' + (eOdd ? eOdd.name : 'ok') + ' from Float64Array in the constructor' +
    ' (no coherence check: count*stride <= byteLength, stride > 0, byteLength % 8)');
}

// ---------- BK-10: row index fails open -- padding reads as rows, fractions truncate ----------
{
  const r = new Reader(bake([{ a: 7 }]));         // U8, stride 1, rawBytes 1, buffer padded to 8
  const pad = r.get(1, 'a');                      // count is 1; rows 1..7 are padding bytes
  const frac = r.get(0.5, 'a');                   // ToIndex truncation
  const eNeg = caught(() => r.get(-1, 'a'));
  const ePast = caught(() => r.get(8, 'a'));
  const open = pad === 0 && frac === 7 && eNeg && eNeg.name === 'RangeError' && !eNeg.code &&
               ePast && ePast.name === 'RangeError' && !ePast.code;
  report('BK-10-row-bounds-failopen', open ? 'REPRODUCED' : 'PARTIAL',
    'count=1: get(1) = ' + pad + ' (silent padding read), get(0.5) = ' + frac + ' (silent truncation to row 0),' +
    ' get(-1) -> ' + (eNeg ? 'raw ' + eNeg.name : 'no error') + ', get(8) -> ' + (ePast ? 'raw ' + ePast.name : 'no error') +
    ' (no bounds policy: three different behaviors, none of them a coded refusal)');
}

// ---------- BK-11: non-object and empty records bake into silent nonsense ----------
{
  let b1 = null, b2 = null, b3 = null;
  const e1 = caught(() => { b1 = bake([1, 2, 3]); });
  const e2 = caught(() => { b2 = bake(['ab', 'cd']); });
  const e3 = caught(() => { b3 = bake([{}, {}]); });
  const open = !e1 && b1.count === 3 && b1.buffer.byteLength === 0 && b1.schema.length === 0 &&
               !e2 && b2.schema.some((f) => f.name === '0') &&
               !e3 && b3.buffer.byteLength === 0;
  report('BK-11-nonobject-records', open ? 'REPRODUCED' : ((e1 && e2 && e3) ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'bake([1,2,3]) -> ' + (e1 ? 'throws' : 'count=' + b1.count + ', ' + b1.buffer.byteLength + '-byte buffer, ' + b1.schema.length + ' fields') +
    "; bake(['ab','cd']) -> " + (e2 ? 'throws' : 'schema fields [' + b2.schema.map((f) => f.name).join(',') + '] from string indices') +
    '; bake([{},{}]) -> ' + (e3 ? 'throws' : b3.buffer.byteLength + '-byte buffer') +
    ' (three records in, zero bytes out, count says 3 -- while bake({}) and bake([]) throw; the door is' +
    ' only half-built)');
}

// ---------- BK-12: README "all-U8 stride padded to 4 (the minimum)" -- no such minimum ----------
{
  const b = bake([{ a: 1, b: 2, c: 3 }]);         // three U8 fields
  report('BK-12-stride-minimum-claim', b.stride === 3 ? 'REPRODUCED' : (b.stride === 4 ? 'NOT-REPRODUCED' : 'PARTIAL'),
    'three-U8 record bakes with stride ' + b.stride +
    ' (README "Edge cases": "An all-U8 schema gets stride padded to 4 (the minimum)" -- the code pads to' +
    ' max field alignment, which is 1 here; one side of docs-vs-code must move)');
}

// ---------- BK-13: fields beyond record 0 silently dropped; absent fields read 0 ----------
{
  const b1 = bake([{ a: 1 }, { a: 2, b: 99 }]);
  const dropped = !b1.schema.some((f) => f.name === 'b');
  const r2 = new Reader(bake([{ a: 1, b: 5 }, { a: 2 }]));
  const absent = r2.get(1, 'b');
  report('BK-13-dropped-and-absent-fields', (dropped && absent === 0) ? 'REPRODUCED' : 'PARTIAL',
    "record 1's extra field 'b' (=99) is " + (dropped ? 'absent from the schema -- the value is gone' : 'present') +
    "; a record missing 'b' reads back " + absent +
    ' (keys come from record 0 only; absent is not 0, and validate is opt-in where the law says refuse' +
    ' by default)');
}

// ---------- XP-01: cross-package -- can lite-bake read what lite-bake-stream writes? ----------
{
  const { serialize: lbsSerialize, deserialize: lbsDeserialize, VERSION: LBS_VERSION } =
    await import('@zakkster/lite-bake-stream');
  const ndjson = '{"x":1.5,"y":-3.25,"s":"zebra"}\n{"x":2.5,"y":7,"s":"ant"}\n{"x":-0.125,"y":1e6,"s":"zebra"}\n';
  const container = lbsSerialize(ndjson, { writer: { schema: { fields: [
    { name: 'x', laneKind: 'f64' }, { name: 'y', laneKind: 'f64' }, { name: 's', laneKind: 'u32' },
  ] } } });
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const magic = String.fromCharCode(container[0], container[1], container[2], container[3]);
  if (magic !== 'LBK1') {
    report('XP-01-container-interop', 'INCONCLUSIVE', 'unexpected magic ' + JSON.stringify(magic));
  } else {
    // Hand-parse per the stream package's SPEC.md sections 3.1-4.2 (LiteBake has no
    // parser for this -- that absence is the finding).
    const schemaOff = Number(dv.getBigUint64(8, true));
    const fieldCount = dv.getUint32(schemaOff, true);
    const rowStride = dv.getUint32(schemaOff + 4, true);
    const nameBlobOff = schemaOff + 8 + fieldCount * 24;
    const nameBlobLen = dv.getUint32(nameBlobOff, true);
    if (nameBlobLen === 0) throw new Error('probe: empty name blob');
    const td = new TextDecoder();
    const descs = [];
    for (let i = 0; i < fieldCount; i++) {
      const d = schemaOff + 8 + i * 24;
      const nameLen = dv.getUint16(d, true);
      const offsetInRow = dv.getUint16(d + 2, true);
      const laneKind = dv.getUint8(d + 4);
      const nameStrOff = Number(dv.getBigUint64(d + 8, true));
      const name = td.decode(container.subarray(nameBlobOff + 4 + nameStrOff, nameBlobOff + 4 + nameStrOff + nameLen));
      descs.push({ name, offsetInRow, laneKind });
    }
    const shardDirOff = Number(dv.getBigUint64(24, true));
    const payloadOff = Number(dv.getBigUint64(shardDirOff, true));
    const payloadLen = dv.getUint32(shardDirOff + 8, true);
    const rowCount = dv.getUint32(shardDirOff + 12, true);
    // Carve the shard payload into a fresh, 8-aligned ArrayBuffer (lite-bake's Reader
    // cannot take a byteOffset -- BK-05 -- so a copy is mandatory glue).
    const ab = new ArrayBuffer((payloadLen + 7) & ~7);
    new Uint8Array(ab).set(container.subarray(payloadOff, payloadOff + payloadLen));
    const lbSchema = descs.map((d) => ({ name: d.name, type: d.laneKind === 1 ? Types.F64 : Types.U32, offset: d.offsetInRow }));
    const lb = new Reader({ buffer: ab, stride: rowStride, count: rowCount, schema: lbSchema });
    const lbs = lbsDeserialize(container);
    let f64Agree = 0, f64Total = 0;
    for (let i = 0; i < rowCount; i++) {
      for (const f of ['x', 'y']) { f64Total++; if (lb.get(i, f) === lbs.get(i, f)) f64Agree++; }
    }
    const u32AsNumber = lb.get(0, 's');            // lite-bake sees the string-table INDEX
    const u32AsString = lbs.get(0, 's');           // stream resolves it to the interned string
    // The naive consumer move: hand the whole container to lite-bake's Reader.
    const naiveAb = new ArrayBuffer((container.byteLength + 7) & ~7);
    new Uint8Array(naiveAb).set(container);
    const naive = new Reader({ buffer: naiveAb, stride: rowStride, count: rowCount, schema: lbSchema });
    const naiveX = naive.get(0, 'x');
    const noApi = f64Agree === f64Total && naiveX !== 1.5 && typeof u32AsNumber === 'number' && u32AsString === 'zebra';
    report('XP-01-container-interop', noApi ? 'REPRODUCED' : 'PARTIAL',
      'lite-bake-stream@' + LBS_VERSION + ' container: lite-bake CANNOT open it via any API (Reader takes a live' +
      ' {buffer,stride,count,schema} object; naive whole-container read yields x=' + naiveX + ', garbage).' +
      ' After ~45 lines of hand-written SPEC parsing + payload copy: F64 lane cells agree ' + f64Agree + '/' + f64Total +
      ' (interleaved stride-' + rowStride + ' layout IS lane-compatible); U32 lane diverges semantically:' +
      ' lite-bake reads index ' + u32AsNumber + ' where stream reads ' + JSON.stringify(u32AsString) +
      ' (string tables exist only on the stream side). Interop today is manual glue, not an API.');
  }
}

// ---------- XP-02: cross-package -- the two packages disagree on lane type codes ----------
{
  const { serialize: lbsSerialize } = await import('@zakkster/lite-bake-stream');
  const container = lbsSerialize('{"n":1,"s":"x"}\n', { writer: { schema: { fields: [
    { name: 'n', laneKind: 'f64' }, { name: 's', laneKind: 'u32' },
  ] } } });
  const dv = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const schemaOff = Number(dv.getBigUint64(8, true));
  const laneF64 = dv.getUint8(schemaOff + 8 + 4);          // field 0 lane_kind byte
  const laneU32 = dv.getUint8(schemaOff + 8 + 24 + 4);     // field 1 lane_kind byte
  let specQuote = false;
  try {
    const spec = fs.readFileSync(new URL('../node_modules/@zakkster/lite-bake-stream/SPEC.md', import.meta.url), 'utf8');
    specQuote = /Matches lite-bake's `Types\.F64`/.test(spec) && /matching `Types\.\*`/.test(spec);
  } catch { /* SPEC not shipped -- quote check skipped */ }
  const diverge = laneF64 === 1 && laneF64 === Types.F64 && laneU32 === 3 && laneU32 !== Types.U32;
  report('XP-02-lane-code-tables', diverge ? 'REPRODUCED' : 'PARTIAL',
    'LBK1 lane_kind bytes on the wire: F64=' + laneF64 + ' (equals lite-bake Types.F64=' + Types.F64 +
    ' -- the one agreement), U32=' + laneU32 + ' vs lite-bake Types.U32=' + Types.U32 +
    '. LBK1 assigns 2/3/4 to F32/U32/U8 while lite-bake Types assigns 2/3/4 to I32/I16/I8' +
    (specQuote ? '; the stream SPEC claims lane values match/reserve `Types.*`, which the tables contradict' : '') +
    '. No lite-bake-stream entry point consumes a bake() result either (reverse interop: none).' +
    ' Only the CONCEPT (interleaved fixed-stride lanes) is shared; the code points are not.');
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\nprobes done: ' + reproduced + ' REPRODUCED, ' + notReproduced + ' NOT-REPRODUCED, ' +
  partial + ' PARTIAL, ' + inconclusive + ' INCONCLUSIVE');
console.log('(BK-14..BK-26 are structural: grep/ls evidence lives in ROADMAP.md section 2)');
