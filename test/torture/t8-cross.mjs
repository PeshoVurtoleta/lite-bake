/**
 * t8 -- cross-package agreement (lite-bake <-> lite-bake-stream). INERT STUB.
 *
 * B4 wires this tier live against the PUBLISHED @zakkster/lite-bake-stream (a
 * dev-only, pinned peer): the XP-01 body (serialize a mixed f64/u32 corpus,
 * hand-parse the LBK1 container per its SPEC.md, carve the shard payload, read
 * it with THIS package's Reader) pins the F64 lane parity cell-for-cell; the
 * XP-02 body pins the lane-code divergence (F64=1 the only shared code point) so
 * any future convergence is a deliberate diff, not drift; plus a drift guard for
 * the BYTES table duplicated in the harness against src.
 *
 * That devDep and those pins belong to B4, not B0, so this tier is a deliberate
 * no-op today. It exists so the tier list is complete and the wiring point is
 * named. run() registers no todos and asserts nothing.
 */

export function run() {
  // No-op until B4. See the header for what lands here.
}
