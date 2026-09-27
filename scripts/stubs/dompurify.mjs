/**
 * DOMPurify stand-in for the offline panel checks.
 *
 * The real DOMPurify refuses to initialize without a browser DOM: with no
 * `window.document` it exports a factory function instead of a sanitizer, and
 * `common/tools/markdown.ts` calls `DOMPurify.sanitize` directly — so importing
 * the panel composition root under a stub DOM would throw from inside the
 * assistant row renderer.
 *
 * The checks that alias this file are about panel control flow (submit gating,
 * queueing, replay), not about sanitization. Sanitization has its own policy in
 * `common/tools/markdown.ts` and is exercised in a real browser; here the goal is
 * only to keep `marked`'s markup intact so assistant rows have content.
 *
 * Aliased by esbuild in `scripts/check-composer-submit-gating.mjs`; never part of
 * the shipped extension bundle.
 */
export default {
  sanitize: (html) => html,
  addHook() {},
  removeHook() {},
  removeAllHooks() {},
  setConfig() {},
  clearConfig() {},
  isValidAttribute: () => true,
  removed: [],
  isSupported: true,
  version: 'stub',
}
