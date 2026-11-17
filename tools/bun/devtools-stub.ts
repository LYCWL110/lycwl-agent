/**
 * Stand-in for `react-devtools-core` when bundling.
 *
 * Ink imports the real package from `devtools.js`. The import is guarded by
 * `process.env.DEV === 'true'`, but the bundler resolves it statically, so a
 * build fails when the dev-only package is absent. `build.mjs` resolves the
 * specifier to this module instead of adding the package as a dependency.
 *
 * The guarded branch is never taken in a shipped binary, so the methods are
 * unreachable; they exist only so the default export has the expected shape.
 */

export default {
  initialize(): void {},
  connectToDevTools(): void {},
};
