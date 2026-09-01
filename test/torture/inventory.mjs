/**
 * inventory -- the error-code census. Pure string functions, no imports, no fs.
 *
 * Three sources of truth about the refusal vocabulary must agree, or a door has
 * silently drifted:
 *
 *   THROWN    the codes src actually raises at runtime.
 *   DECLARED  the codes the public d.ts BakeErrorCode union promises.
 *   PINNED    the codes a test somewhere asserts on, via a recognised spelling.
 *
 * diffInventory() reports every disagreement; an empty result is the standing
 * gate (t9 Control 9 runs it against the real tree). t9 owns all fs reads and
 * passes the raw texts in -- this module stays a set of deterministic pure
 * functions so its own controls can feed it synthetic text with no disk touch.
 *
 * @license MIT
 */

/**
 * extractThrown(srcText) -> sorted unique array of codes src raises.
 *
 * Scans for the `raise('CODE'` call form only. This is deliberate and its blind
 * spot is documented: a direct `new LiteBakeError('X', ...)` construction would
 * be INVISIBLE here. Today src funnels every refusal through raise(), so the
 * scan is complete; if that style ever changes, the declared-vs-thrown diff
 * (a DECLARED code that stops being thrown becomes a 'dead declaration') is the
 * backstop that surfaces the drift.
 */
export function extractThrown(srcText) {
  const out = Object.create(null);
  const re = /raise\(\s*'([A-Z0-9_]+)'/g;
  let m;
  while ((m = re.exec(srcText)) !== null) out[m[1]] = true;
  return Object.keys(out).sort();
}

/**
 * extractDeclared(dtsText) -> sorted unique array of codes the d.ts declares.
 *
 * Slices the text from the `BakeErrorCode` alias declaration to its terminating
 * `;`, and collects the single-quoted [A-Z0-9_]+ literals inside that slice ONLY.
 * Bounding to the alias body is what keeps unrelated quoted strings elsewhere in
 * the d.ts (JSDoc examples, other unions) from being mistaken for declared codes.
 */
export function extractDeclared(dtsText) {
  const start = dtsText.indexOf('BakeErrorCode');
  if (start === -1) return [];
  const end = dtsText.indexOf(';', start);
  const slice = end === -1 ? dtsText.slice(start) : dtsText.slice(start, end);
  const out = Object.create(null);
  const re = /'([A-Z0-9_]+)'/g;
  let m;
  while ((m = re.exec(slice)) !== null) out[m[1]] = true;
  return Object.keys(out).sort();
}

/**
 * extractPinned(testTexts) -> sorted unique array of codes a test pins.
 *
 * STRICT single-quote registry -- a code counts as pinned only when it appears
 * in EXACTLY one of these three spellings:
 *
 *     isCode('X')   |   code === 'X'   |   code: 'X'
 *
 * The registry is deliberately narrow and fail-closed: a pin written any other
 * way (double quotes, a different helper, a regex on the message) stays INVISIBLE,
 * which makes the gate FAIL on that code and forces either a spelling fix or a
 * deliberate widening of this registry -- never a silent pass. The inverse risk,
 * a junk match from a control string literal in some test file, is harmless by
 * construction: only THROWN-set membership drives a failure in diffInventory, so
 * a stray pin for a code src never raises can never turn the gate red.
 */
export function extractPinned(testTexts) {
  const out = Object.create(null);
  const res = [
    /isCode\(\s*'([A-Z0-9_]+)'/g,
    /code\s*===\s*'([A-Z0-9_]+)'/g,
    /code:\s*'([A-Z0-9_]+)'/g,
  ];
  for (let t = 0; t < testTexts.length; t++) {
    const text = testTexts[t];
    for (let r = 0; r < res.length; r++) {
      const re = res[r];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) out[m[1]] = true;
    }
  }
  return Object.keys(out).sort();
}

/**
 * diffInventory(thrown, declared, pinned) -> array of violation strings.
 * Empty array is green. Three independent directions of drift:
 *
 *   undeclared throw:  X   a code src raises that the d.ts union omits
 *   dead declaration:  X   a code the d.ts declares that src never raises
 *   unpinned door:     X   a code src raises that no test asserts on
 */
export function diffInventory(thrown, declared, pinned) {
  const declaredSet = Object.create(null);
  for (let i = 0; i < declared.length; i++) declaredSet[declared[i]] = true;
  const pinnedSet = Object.create(null);
  for (let i = 0; i < pinned.length; i++) pinnedSet[pinned[i]] = true;
  const thrownSet = Object.create(null);
  for (let i = 0; i < thrown.length; i++) thrownSet[thrown[i]] = true;

  const out = [];
  for (let i = 0; i < thrown.length; i++) {
    if (!declaredSet[thrown[i]]) out.push('undeclared throw: ' + thrown[i]);
  }
  for (let i = 0; i < declared.length; i++) {
    if (!thrownSet[declared[i]]) out.push('dead declaration: ' + declared[i]);
  }
  for (let i = 0; i < thrown.length; i++) {
    if (!pinnedSet[thrown[i]]) out.push('unpinned door: ' + thrown[i]);
  }
  return out;
}
