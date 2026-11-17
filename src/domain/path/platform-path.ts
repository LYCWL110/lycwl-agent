export function isPosixPath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}
