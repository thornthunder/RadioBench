export interface TransportHandlers {
  onData(chunk: string): void;
  /** Called when the link goes away other than through close(). */
  onClose(error: Error): void;
}

/** A character pipe to the radio's CAT port: the real serial port, or the simulator. */
export interface CatTransport {
  open(handlers: TransportHandlers): Promise<void>;
  write(data: string): Promise<void>;
  close(): Promise<void>;
}
