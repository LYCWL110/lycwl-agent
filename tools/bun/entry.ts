/**
 * Entry point for the standalone binaries built by `build.mjs`.
 *
 * The shim is imported first on purpose. ESM evaluates dependencies in import
 * order, and it has to finish before any module calls `koffi.load`; the platform
 * file lease does that at module scope.
 */

import "./native-shim.ts";
import "../../src/bootstrap/main.ts";
