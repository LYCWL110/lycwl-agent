import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import type { CredentialVault } from "../ports/credential-vault.ts";

/**
 * Fixed vault reference for the web-search credential.
 *
 * The purpose field still separates it from a provider key: a search key can
 * never answer a provider lookup, even if the reference name is reused. Keeping
 * the name fixed means the runtime resolver and `lycwl --search-key` agree
 * without adding a configuration field for a non-secret.
 */
export const SEARCH_CREDENTIAL_REFERENCE = "search-main";

export type SearchKeyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: "cancelled" | "empty" | "vault_failure"; detail?: string }>;

export type SearchKeyOptions = Readonly<{
  vault: Pick<CredentialVault, "write">;
  /** Injected for tests; defaults to a hidden terminal prompt. */
  ask?: (question: string) => Promise<string | null>;
  /** Injected for tests; defaults to stderr. */
  write?: (text: string) => void;
}>;

/**
 * Store a Tavily key through the credential boundary.
 *
 * The value never appears in argv, stdout, stderr or an event. An empty answer
 * cancels instead of writing a blank secret, and a vault failure is reported by
 * its safe code rather than by the secret.
 */
export async function storeSearchKey(options: SearchKeyOptions): Promise<SearchKeyResult> {
  const write = options.write ?? ((text: string) => process.stderr.write(text));
  const answer = await (options.ask ?? askHidden)("Tavily API key (input hidden): ");
  if (answer === null) {
    write("no answer; the search key was not written\n");
    return { ok: false, code: "cancelled" };
  }
  const secret = answer.trim();
  if (secret.length === 0) {
    write("empty key; the search key was not written\n");
    return { ok: false, code: "empty" };
  }
  const written = await options.vault.write({
    reference: SEARCH_CREDENTIAL_REFERENCE,
    purpose: "search_api_key",
    secret,
  });
  if (!written.ok) {
    write(`the search key was not written: ${written.code}\n`);
    return { ok: false, code: "vault_failure", detail: written.code };
  }
  write(`search key stored under reference ${SEARCH_CREDENTIAL_REFERENCE}\n`);
  return { ok: true };
}

/**
 * Read one line without echoing it to the terminal.
 *
 * `readline` echoes to its `output` stream, so the prompt goes to the real
 * terminal and the interface gets a sink instead. This works on Windows and
 * Linux without a platform-specific `stty` call. A non-interactive stdin, Ctrl+C
 * or a closed stream returns null, which the caller treats as cancellation.
 */
export function askHidden(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  process.stdout.write(question);
  const sink = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  }) as Writable & { isTTY: boolean; columns: number; rows: number };
  sink.isTTY = true;
  sink.columns = 80;
  sink.rows = 24;

  const readline = createInterface({ input: process.stdin, output: sink, terminal: true });
  let settled = false;
  return new Promise<string | null>((resolve) => {
    readline.question("", (answer) => {
      settled = true;
      readline.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    readline.once("SIGINT", () => {
      if (settled) return;
      settled = true;
      readline.close();
      process.stdout.write("\n");
      resolve(null);
    });
    readline.once("close", () => {
      if (settled) return;
      settled = true;
      process.stdout.write("\n");
      resolve(null);
    });
  });
}
