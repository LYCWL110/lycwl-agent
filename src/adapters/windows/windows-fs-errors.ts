/**
 * Maps Node filesystem errors to the Harness safe failure codes.
 *
 * Raw OS messages and absolute paths never reach model context: only these codes
 * do. Unknown errno values fail closed with a generic code.
 */
export type FsFailure =
  | "not_found"
  | "access_denied"
  | "locked"
  | "not_a_regular_file"
  | "read_failed";

export function mapFsError(error: unknown): FsFailure {
  if (typeof error !== "object" || error === null) return "read_failed";
  const code = (error as { code?: unknown }).code;
  if (typeof code !== "string") return "read_failed";
  switch (code) {
    case "ENOENT":
      return "not_found";
    case "EACCES":
    case "EPERM":
      return "access_denied";
    case "EBUSY":
      return "locked";
    case "EISDIR":
      return "not_a_regular_file";
    default:
      return "read_failed";
  }
}
