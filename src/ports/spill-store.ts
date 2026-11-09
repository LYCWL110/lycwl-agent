/**
 * Spill storage port.
 *
 * The coordinator needs somewhere to put an oversized tool result, but it must not
 * know where that is: the adapter owns the path and the durability rules. Keeping
 * the type here is what lets the application layer depend on the capability rather
 * than on the file system.
 */

export type SpillStore = Readonly<{
  /**
   * Store the text and report where it went.
   *
   * Returns a null reference when the text could not be stored, which the caller
   * treats as "keep it inline": a storage failure must not turn a successful tool
   * call into an error.
   */
  spill: (input: {
    toolCallId: string;
    toolName: string;
    text: string;
  }) => Promise<Readonly<{ reference: string | null; readable: boolean }>>;
}>;
