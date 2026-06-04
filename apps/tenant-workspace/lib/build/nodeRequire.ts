/**
 * Returns Node's genuine `createRequire`, obtained in a way the Next/webpack
 * bundler cannot statically rewrite.
 *
 * Why this exists: a normal `import { createRequire } from 'node:module'`
 * followed by `createRequire(<runtime path>)` makes webpack emit
 *   "module.createRequire failed parsing argument"
 * and replace the call with a stub that is NOT a function at runtime. That is
 * what silently disabled the /build semantic retriever — `createRequire(...)`
 * returned a non-function, init threw "req is not a function", and every
 * request fell back to lexical keyword matching (which can't match
 * "financial accounting system" to sdk-billing/meter/audit/…).
 *
 * `eval('require')` yields the real CommonJS require of the running module,
 * untouched by the bundler (Next's nodejs runtime is CJS under the hood); we
 * pull `node:module` through it to get an honest `createRequire`.
 */
import type { createRequire as CreateRequireFn } from 'node:module';

export function getCreateRequire(): typeof CreateRequireFn {
  // eslint-disable-next-line no-eval
  const nodeRequire = eval('require') as NodeRequire;
  return (nodeRequire('node:module') as typeof import('node:module')).createRequire;
}
