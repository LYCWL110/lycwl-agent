#!/usr/bin/env bun
/**
 * Builds standalone binaries with `bun build --compile`.
 *
 * Usage:
 *   bun tools/bun/build.mjs                 # every target
 *   bun tools/bun/build.mjs --host          # the host platform only
 *   bun tools/bun/build.mjs --target=linux-x64 --target=windows-x64
 *   bun tools/bun/build.mjs --outdir=/tmp/lycwl-release
 *
 * Two things here are not obvious and are covered by the plugin below.
 *
 * 1. Koffi ships its native module per platform, and `require` cannot load a
 *    `.node` from Bun's `/$bunfs`. The module is imported with `{ type: "file" }`
 *    so the compiler embeds it, and `native-shim.ts` extracts it at startup.
 * 2. Ink imports `react-devtools-core` from a branch guarded by `DEV`. The
 *    bundler resolves that import statically, so the specifier is redirected to
 *    a stub rather than adding a dev-only package to the dependency list.
 */

import { existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const BINARY = "lycwl";
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const ENTRY = path.join(import.meta.dirname, "entry.ts");
const DEVTOOLS_STUB = path.join(import.meta.dirname, "devtools-stub.ts");

/**
 * Bun below this version panics with `napi_reference_unref` during garbage
 * collection as soon as Koffi has registered its finalizers, which makes every
 * built binary unusable. The failure is in Bun, not in this project, and it is
 * not detectable at build time, so the version is checked instead.
 */
const MINIMUM_BUN = [1, 4, 4];

/** Windows and Linux only; the application has no other platform adapters. */
const TARGETS = [
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", avx2: false },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64", abi: "musl" },
  { os: "linux", arch: "x64", abi: "musl", avx2: false },
  { os: "linux", arch: "arm64", abi: "musl" },
  { os: "win32", arch: "x64" },
  { os: "win32", arch: "x64", avx2: false },
  { os: "win32", arch: "arm64" },
];

const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);

assertBunVersion();

const requested = argv
  .filter((argument) => argument.startsWith("--target="))
  .map((argument) => argument.slice("--target=".length));
const outdir = path.resolve(
  ROOT,
  argv.find((argument) => argument.startsWith("--outdir="))?.slice("--outdir=".length) ?? "release",
);

const selected = selectTargets();
const plans = selected.map((item) => ({ item, name: targetName(item), native: koffiNative(item) }));

for (const plan of plans) {
  const outfile = path.join(outdir, plan.name, plan.item.os === "win32" ? `${BINARY}.exe` : BINARY);
  await mkdir(path.dirname(outfile), { recursive: true });
  process.stdout.write(`building ${plan.name}\n`);

  const result = await Bun.build({
    entrypoints: [ENTRY],
    format: "esm",
    minify: true,
    bytecode: true,
    plugins: [nativePlugin(plan.native)],
    compile: {
      outfile,
      target: `bun-${plan.name}`,
      // A shipped binary must not pick up configuration from whatever directory
      // it happens to be started in.
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
  });

  if (!result.success) {
    for (const log of result.logs) process.stderr.write(`${log}\n`);
    process.exit(1);
  }

  const { size } = await stat(outfile);
  process.stdout.write(
    `  ${path.relative(ROOT, outfile)} (${(size / (1024 * 1024)).toFixed(1)} MiB)\n`,
  );
}

function assertBunVersion() {
  const actual = Bun.version.split(".").map((part) => Number.parseInt(part, 10));
  const older = compareVersions(actual, MINIMUM_BUN) < 0;
  if (!older) return;
  process.stderr.write(
    [
      `bun ${Bun.version} cannot build this project.`,
      "",
      `Use bun >= ${MINIMUM_BUN.join(".")}. Older versions panic in \`napi_reference_unref\``,
      "during garbage collection once Koffi is loaded, so the resulting binary",
      "crashes shortly after startup.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function compareVersions(actual, minimum) {
  const length = Math.max(actual.length, minimum.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function selectTargets() {
  if (requested.length > 0) {
    const unknown = requested.filter((name) => !TARGETS.some((item) => targetName(item) === name));
    if (unknown.length > 0) {
      process.stderr.write(
        `unknown target: ${unknown.join(", ")}\nknown targets: ${TARGETS.map(targetName).join(", ")}\n`,
      );
      process.exit(1);
    }
    return TARGETS.filter((item) => requested.includes(targetName(item)));
  }
  if (!argv.includes("--host")) return TARGETS;
  // The host build is the glibc, AVX2 variant for the running platform. A musl
  // host has to ask for its target explicitly.
  return TARGETS.filter(
    (item) =>
      item.os === process.platform &&
      item.arch === process.arch &&
      item.avx2 !== false &&
      item.abi === undefined,
  );
}

function targetName(item) {
  return [
    item.os === "win32" ? "windows" : item.os,
    item.arch,
    item.abi,
    item.avx2 === false ? "baseline" : undefined,
  ]
    .filter(Boolean)
    .join("-");
}

/**
 * Locates the Koffi native module for a target.
 *
 * The packages are declared as devDependencies rather than installed on demand:
 * a cross-compile that silently produced a binary with the host's native module
 * would fail on the user's machine instead of at build time.
 */
function koffiNative(item) {
  const packageName = `@koromix/koffi-${item.os}-${item.arch}`;
  const triplet = `${item.abi === "musl" ? "musl" : item.os}_${item.arch}`;
  let manifest;
  try {
    manifest = require.resolve(`${packageName}/package.json`);
  } catch {
    throw new Error(`${packageName} is not installed; add it to devDependencies`);
  }
  const file = path.join(path.dirname(manifest), triplet, "koffi.node");
  if (!existsSync(file)) {
    throw new Error(`${packageName} does not contain ${triplet}/koffi.node`);
  }
  return { file, triplet };
}

function nativePlugin(native) {
  return {
    name: "lycwl-native",
    setup(build) {
      build.onResolve({ filter: /^lycwl:native$/ }, () => ({
        path: "lycwl:native",
        namespace: "lycwl",
      }));
      build.onLoad({ filter: /.*/, namespace: "lycwl" }, () => ({
        loader: "js",
        contents: [
          `import file from ${JSON.stringify(native.file)} with { type: "file" };`,
          `export default { file, triplet: ${JSON.stringify(native.triplet)} };`,
          "",
        ].join("\n"),
      }));
      build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: DEVTOOLS_STUB }));
    },
  };
}
