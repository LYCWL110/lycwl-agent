/**
 * Build-time module supplied by the plugin in `build.mjs`.
 *
 * It cannot exist on disk: the path differs per target, and the native module
 * has to be imported with `{ type: "file" }` so `bun build --compile` embeds it.
 * The declaration lets `tsc` check `native-shim.ts` while the bundler supplies
 * the value.
 */
declare module "lycwl:native" {
  const target: Readonly<{
    /** Path to the embedded Koffi module, valid only inside the bundle. */
    file: string;
    /** Koffi's directory name for the target, e.g. `linux_x64` or `musl_x64`. */
    triplet: string;
  }>;
  export default target;
}
