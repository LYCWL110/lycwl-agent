/**
 * Spill storage port.
 *
 * The coordinator needs somewhere to put an oversized tool result, but it must not
 * know where that is: the adapter owns the path and the durability rules. Keeping
 * the type here is what lets the application layer depend on the capability rather
 * than on the file system.
 */
export {};
