/**
 * @zakkster/lite-bake -- torture gate.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Ten tiers share one shape (see ROADMAP.md section 3). The harness wires the
 * tiers this package needs now:
 *
 *     t0  metamorphic bake/read laws   t1  degenerate values (live -- B1)
 *     t2  layout laws over schema space t3  adversarial baked objects (stub -> B2)
 *     t4  API abuse (live -- B1)        t5  differential fuzz (live -- B1)
 *     t6  the zero-alloc gate           t7  soak + retention witness
 *     t8  cross-package parity (stub -> B4)  t9  controls + inventory gate
 *
 * Live now: t0, t1, t2, t4, t5, t6, t7, t9. t5 is the fixed differential lane
 * plus B6's hostile-name / shape / schema-cross lanes. The remaining stubs (t3,
 * t8) and the property tiers still register the open reproduced findings as
 * `todo`s that must keep reproducing; each fills in as B2/B4 land. t8 is an inert
 * prose marker until the lite-bake-stream devDep and the XP-01/XP-02 pins arrive
 * in B4. t9 now also hosts the error-code inventory gate (Control 9): the
 * thrown (src) vs declared (d.ts) vs pinned (test scan set) censuses must agree.
 *
 * lite-gc-profiler is one-measurement-at-a-time, so tiers run STRICTLY
 * SEQUENTIALLY -- never nested, never concurrent.
 *
 * PREFLIGHT: the two peers (lite-gc-profiler, lite-leak) are devDependencies. A
 * fresh clone that skipped `npm install` must fail loudly (exit 2) with a remedy,
 * not a raw ERR_MODULE_NOT_FOUND. The peers -- and, via the harness, every tier --
 * are DYNAMICALLY imported here AFTER the check (static imports would hoist past
 * it and make the exit-2 path unreachable).
 *
 * Controls: `BAKE_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` must exit
 * non-zero. Under a normal top-to-bottom run t5's fixed-lane oracle-misapply
 * canary trips first (it expects a stored 0 where the strict default refuses a
 * non-number, so the differential comparison diverges and dies); t6's
 * retained-allocation injection into its hot loop remains live behind it (and is
 * what t9's Control 1 exercises in-process), so the alloc gate is still provably
 * able to fail. The B6 lanes (hostile-name, shape, schema-cross) and the
 * inventory gate ignore BREAK -- their failability is proven in-process by t9's
 * Controls 9-12, each of which drives an oracle misapply knob and asserts the
 * divergence is caught. The invariant is unchanged: a BREAK run exits non-zero, a
 * normal run exits 0. A gate that cannot fail is decorative. Replay a failing
 * seed with `TORTURE_SEED=<n> node --expose-gc test/torture.mjs`.
 *
 * @license MIT
 */

async function main() {
  // --- guard: the GC gate is meaningless without --expose-gc ----------------
  if (typeof globalThis.gc !== 'function') {
    process.stderr.write(
      'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
    process.exit(1);
  }

  // --- preflight: peers must be installed before any tier is imported --------
  for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
    try {
      await import(pkg);
    } catch {
      process.stderr.write(
        'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
      process.exit(2);
    }
  }

  // Dynamic imports so preflight owns the failure path. The harness (and via it
  // the profiler) is loaded only after both peers were confirmed present.
  const { SEED, BREAK } = await import('./torture/harness.mjs');
  const { run: t0 } = await import('./torture/t0-laws.mjs');
  const { run: t1 } = await import('./torture/t1-degenerate.mjs');
  const { run: t2 } = await import('./torture/t2-layout.mjs');
  const { run: t3 } = await import('./torture/t3-adversarial.mjs');
  const { run: t4 } = await import('./torture/t4-abuse.mjs');
  const { run: t5 } = await import('./torture/t5-fuzz.mjs');
  const { run: t6 } = await import('./torture/t6-alloc.mjs');
  const { run: t7 } = await import('./torture/t7-soak.mjs');
  const { run: t8 } = await import('./torture/t8-cross.mjs');
  const { run: t9 } = await import('./torture/t9-controls.mjs');

  const TIERS = [
    ['t0 laws', t0],
    ['t1 degenerate', t1],
    ['t2 layout', t2],
    ['t3 adversarial', t3],
    ['t4 abuse', t4],
    ['t5 fuzz', t5],
    ['t6 alloc', t6],
    ['t7 soak', t7],
    ['t8 cross', t8],
    ['t9 controls', t9],
  ];

  for (const [name, run] of TIERS) {
    try {
      // Tiers normally fail via die() (which exits). A thrown error is an
      // unexpected fault -- surface it with the replay seed and stop.
      await run();
    } catch (err) {
      process.stderr.write(
        'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
      process.exit(1);
    }
  }

  // Reaching here in BREAK mode means the t6 control did not trip -- a fault.
  if (BREAK) {
    process.stderr.write(
      'torture: FAIL -- BAKE_TORTURE_BREAK set but the gate still passed\n');
    process.exit(1);
  }

  process.stdout.write('ok\n');
  process.exit(0);
}

main();
