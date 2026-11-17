# ADR-0088: Ship standalone binaries built with Bun

- Status: Accepted (2026-11-17)
- Related: ADR-0023 (credential vault), ADR-0038 (unencrypted credential file), ADR-0086 (Linux platform adapters)

## Decision

Build the shipped artifacts with `bun build --compile`, one executable per
target, instead of Node's single-executable support. Node's version requires
assembling the artifact on the target platform; cross-compiling the Windows
binaries from a Linux host is the requirement that decides this.

Targets are Windows and Linux only, matching the platform adapters that exist:
x64 and arm64, glibc and musl, with an AVX2-free baseline variant for x64. The
build refuses to run below Bun 1.4.4. On 1.3.14, and with every Koffi version
tried, the process panics in `napi_reference_unref` during garbage collection as
soon as a library handle exists, which makes the binary unusable a few hundred
milliseconds after startup. The failure is in Bun's N-API finalizer handling and
cannot be detected at build time, so the version is checked rather than assumed.

Koffi keeps its native module per target, and `require` cannot load a `.node`
from Bun's `/$bunfs`. Each build imports the module for its own target with
`{ type: "file" }` so the compiler embeds it, and the entry point writes those
bytes to a real directory before anything calls `koffi.load`, then points
`process.resourcesPath` at that directory. The directory is keyed by the
content digest so an upgraded binary never reuses an older module, it is created
with owner-only permissions, and its ownership is checked before use because
`tmpdir()` is world-writable on POSIX. The platform packages are declared as
devDependencies: a missing one fails the build, where resolving them on demand
would produce a binary carrying the host's native module and fail on the user's
machine instead.

Ink imports `react-devtools-core` from a branch guarded by `DEV`, and the
bundler resolves that specifier statically. A build plugin redirects it to a
stub. Marking it external is not an alternative: the compiled binary resolves it
from `/$bunfs` at runtime and aborts. Adding the package as a dependency would
put a dev-only tool in the shipped artifact.

Keeping Koffi was chosen over removing it. The Linux file lease is its only use
on Linux and could be replaced with a directory lock, but on Windows it provides
two guarantees the alternative does not: a job object with kill-on-close, so a
harness crash cannot leave a process tree running, and Credential Manager access.
Replacing them cannot be verified on this project's development hardware, and the
upstream defect that motivated the question is fixed.

## Verification and limits

All nine targets build, and each artifact was checked to embed the native module
for its own target rather than the host's, including the glibc and musl variants
of the same package. The Linux x64 artifact runs: the TUI renders in a
pseudo-terminal, it starts from an unrelated working directory, and the file
lease excludes a second owner, reacquires after release and survives a forced
garbage collection inside the compiled binary.

The Windows artifacts are not executed here; only their PE headers and embedded
native modules were inspected. The musl artifacts cannot run on a glibc host. A
release is not verified until a Windows machine runs the original test suite
against the Windows binary, and musl targets are exercised on a musl system.
