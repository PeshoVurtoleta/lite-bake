/**
 * lite-bake -- canonical example: baking a spawn-point table for a shooter.
 *
 * Run with: `node examples/basic.js`
 *
 * This is the pattern you repeat across every config type in your game:
 *   1. Load your JSON (or build the array in code).
 *   2. bake() it once at load time.
 *   3. Cache Reader offsets once.
 *   4. Iterate over raw typed arrays in the hot loop.
 */

import {bake, Reader, Types} from '../Bake.js';

// --- Input: what your level designer exports from the editor ---------------

const spawnPoints = [
    {x: 100, y: 200, type: 0, hp: 50, wave: 1},
    {x: 340, y: 180, type: 1, hp: 80, wave: 1},
    {x: 520, y: 400, type: 0, hp: 50, wave: 2},
    {x: 700, y: 650, type: 2, hp: 200, wave: 2},
    {x: 900, y: 800, type: 1, hp: 80, wave: 3},
];

// --- Bake once at load time ------------------------------------------------

// Inference would pick U16 for these small positive ints and store them exactly.
// The F32 override is here so fractional pixel coordinates keep working, the f32
// hot lane exists, and the layout stays stable as the values change over time.
const baked = bake(spawnPoints, {
    schema: {x: Types.F32, y: Types.F32},
    validate: true,                              // dev: catch missing/extra keys
});

console.log('Schema:');

for (const f of baked.schema) {
    const typeName = Object.entries(Types).find(([, v]) => v === f.type)[0];
    console.log(`  ${f.name.padEnd(6)} offset=${String(f.offset).padStart(3)}  type=${typeName}`);
}

console.log(`Stride: ${baked.stride} bytes, count: ${baked.count}, buffer: ${baked.buffer.byteLength} bytes\n`);

// --- Cache offsets once ----------------------------------------------------

const r = new Reader(baked);
const f32 = r.f32, u8 = r.u8;
const s32 = r.strideF32;
const sB = r.stride;
const OFF_X = r.offsetF32('x');
const OFF_Y = r.offsetF32('y');
const OFF_TYPE = r.offsetU8('type');
const OFF_HP = r.offsetU8('hp');
const OFF_WAVE = r.offsetU8('wave');

// --- Hot loop -- ZERO allocations -------------------------------------------

let spawned = 0;
const currentWave = 2;

for (let i = 0; i < r.count; i++) {
    const base32 = i * s32;
    const baseB = i * sB;
    if (u8[baseB + OFF_WAVE] !== currentWave) continue;

    const x = f32[base32 + OFF_X];
    const y = f32[base32 + OFF_Y];
    const type = u8 [baseB + OFF_TYPE];
    const hp = u8 [baseB + OFF_HP];

    console.log(`  spawn type=${type} at (${x}, ${y}) hp=${hp}`);
    spawned++;
}
console.log(`\n${spawned} spawners triggered for wave ${currentWave}.\n`);

// --- Debug convenience (NOT for hot loops) ---------------------------------

console.log('row(0) via debug helper:', r.row(0));
