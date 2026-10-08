/**
 * The byte stream of the radio's scope port: the real FT4222 device, or the simulator.
 * The stream has no framing of its own; see reader.ts for how frames are found in it.
 */
export interface ScopeSource {
  /** Opens the port; rejects with a message fit for display when it cannot be used. */
  open(): Promise<void>;
  /** Reads exactly this many bytes. */
  read(length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
