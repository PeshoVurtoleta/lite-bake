/**
 * t3 -- adversarial baked objects (the trust-nothing tier). STUB.
 *
 * B2 fills this tier with the full corrupt-baked matrix -- every lying `baked`
 * object must be refused at Reader construction with a stable R_* code. For now
 * it registers the two read-side S1/S2 findings it owns as `todo`s that must
 * STILL reproduce: BK-05 (the README's disk recipe misreads via Node's Buffer
 * pool -- no fromBytes honors byteOffset) and BK-09 (Reader trusts `baked`
 * blindly -- lying metadata reads undefined / throws a raw RangeError). Probe
 * bodies ported from bench/findings-probes-2026-09-01.mjs.
 *
 * Both fix in B2. BK-05 keeps its tmpdir file round-trip with cleanup in finally.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bake, Reader, Types } from '../../src/index.js';
import { todoReproduced } from './harness.mjs';

function caught(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

export function run() {
  // BK-05: the README FAQ disk recipe silently misreads a byteOffset-carrying
  // view. Node's Buffer pool is the wild source of a nonzero byteOffset, but it
  // is build-dependent, so we DETERMINISTICALLY simulate the pool: write the
  // baked bytes to disk (the documented recipe), read them back, then place the
  // file bytes at a NONZERO byteOffset inside a larger ArrayBuffer with a junked
  // head. The FAQ recipe passes `view.buffer` raw -- ignoring byteOffset -- so
  // the Reader reads the junk head, not the data. Reproduced = (misread observed)
  // AND (no Reader.fromBytes exists); B2's fromBytes flips the second half, so
  // the todo flip is deterministic regardless of pooling. fs failures propagate
  // (fail closed) via the caller's tier catch; the finally still cleans up.
  todoReproduced('BK-05-pooled-buffer-recipe', () => {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lbake-t3-'));
    try {
      const baked = bake([{ x: 1234.5, y: 42 }], { schema: { x: Types.F64 } });
      const file = path.join(TMP, 'baked.bin');
      fs.writeFileSync(file, new Uint8Array(baked.buffer));     // the documented write
      const raw = fs.readFileSync(file);                        // bytes back from disk
      const OFFSET = 128;
      const backing = new ArrayBuffer(OFFSET + raw.byteLength + 64);
      new Uint8Array(backing, 0, OFFSET).fill(0xAA);            // junk the pool head
      new Uint8Array(backing, OFFSET, raw.byteLength).set(raw); // data at nonzero offset
      const view = new Uint8Array(backing, OFFSET, raw.byteLength);
      const r2 = new Reader({ buffer: view.buffer, stride: baked.stride, count: baked.count, schema: baked.schema });
      const misread = r2.get(0, 'x') !== 1234.5;               // reads the junk head
      const noApi = typeof Reader.fromBytes !== 'function';
      return misread && noApi;
    } finally {
      fs.rmSync(TMP, { recursive: true, force: true });
    }
  });

  // BK-09: Reader trusts `baked` blindly -- lying metadata reads undefined.
  todoReproduced('BK-09-reader-trusts-baked', () => {
    let r = null, hot, eGet = null;
    const eCtor = caught(() => {
      r = new Reader({ buffer: new ArrayBuffer(8), stride: 16, count: 100, schema: [{ name: 'x', type: Types.F64, offset: 0 }] });
      hot = r.f64[1 * r.strideF64 + 0];     // documented hot-loop pattern, row 1 of "100"
      eGet = caught(() => r.get(1, 'x'));
    });
    const eOdd = caught(() => new Reader({ buffer: new ArrayBuffer(12), stride: 4, count: 3, schema: [{ name: 'x', type: Types.F32, offset: 0 }] }));
    // !! coerces the object-operand && chain to a strict boolean.
    return !!(!eCtor && hot === undefined && eGet && eGet.name === 'RangeError' && !eGet.code &&
              eOdd && eOdd.name === 'RangeError' && !eOdd.code);
  });
}
