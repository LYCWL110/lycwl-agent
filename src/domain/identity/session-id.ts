/** Shared by explicit CLI and TUI resume; IDs must remain single safe path segments. */
export function isSessionId(value: string): boolean {
  return (
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u.test(value) &&
    !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(value)
  );
}
