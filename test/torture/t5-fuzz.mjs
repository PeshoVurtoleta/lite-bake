/**
 * t5 -- differential fuzz vs a JSON + coercion-table oracle. STUB.
 *
 * B1 fills this tier: a seeded generator emits the hazard shapes the current
 * suite never produces, and an oracle applies the DECIDED coercion table by hand
 * so every cell of every row is comparable through bake/Reader. For now it
 * registers the one coercion S1 finding it owns as a `todo` that must STILL
 * reproduce: BK-04 (truthy non-numbers are silently COERCED via `+v`, not zeroed
 * as the README documents). Probe body ported from
 * bench/findings-probes-2026-09-01.mjs.
 *
 * BK-04 fixes in B1 (the value policy decides refusal vs a written coercion
 * table); t5's differential fuzz then makes that table executable.
 */

import { bake, Reader } from '../../src/index.js';
import { todoReproduced } from './harness.mjs';

export function run() {
  // BK-04: truthy non-numbers are silently COERCED, not zeroed as documented.
  // The B1 value policy refuses non-numeric values by default (E_NON_NUMERIC),
  // so a fix throws at bake(); catch our own expected throw and return false.
  todoReproduced('BK-04-truthy-coercion', () => {
    let got;
    try {
      const r = new Reader(bake([{ v: true }, { v: '42.5' }, { v: [7] }, { v: 'abc' }, { v: {} }]));
      got = [r.get(0, 'v'), r.get(1, 'v'), r.get(2, 'v'), r.get(3, 'v'), r.get(4, 'v')];
    } catch {
      return false; // a fix that refuses non-numeric values means coercion no longer reproduces
    }
    return got[0] === 1 && got[1] === 42.5 && got[2] === 7 && got[3] === 0 && got[4] === 0;
  });
}
