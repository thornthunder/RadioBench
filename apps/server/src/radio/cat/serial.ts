import { SerialPort } from 'serialport';
import type { CatTransport, TransportHandlers } from './transport.ts';

// The FT-710 exposes its serial ports through a Silicon Labs CP2105 dual UART bridge.
const CP2105_VENDOR_ID = '10c4';
const CP2105_PRODUCT_ID = 'ea70';

/**
 * Finds the FT-710's CAT port: interface 0 of the CP2105, which Windows names
 * "Enhanced COM Port". Interface 1 ("Standard COM Port") carries no CAT, only
 * the RTS/DTR lines that key the transmitter, so it must never be picked.
 */
export async function findCatPort(): Promise<string | null> {
  const ports = await SerialPort.list();
  const cat = ports.find(
    (port) =>
      port.vendorId?.toLowerCase() === CP2105_VENDOR_ID &&
      port.productId?.toLowerCase() === CP2105_PRODUCT_ID &&
      /MI_00|if00/i.test(port.pnpId ?? ''),
  );
  return cat?.path ?? null;
}

export class SerialTransport implements CatTransport {
  private readonly port: SerialPort;

  constructor(path: string, baudRate: number, stopBits: 1 | 2) {
    this.port = new SerialPort({
      path,
      baudRate,
      dataBits: 8,
      parity: 'none',
      stopBits,
      // Keeps DTR low while the port opens; see open().
      hupcl: false,
      autoOpen: false,
    });
  }

  async open(handlers: TransportHandlers): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.port.open((error) => (error ? reject(error) : resolve()));
    });
    // RTS high tells a radio that watches it (the CAT RTS menu item on Yaesu sets) that we are
    // listening. DTR stays low: CAT does not use it, and on the wrong port it could key the radio.
    await new Promise<void>((resolve, reject) => {
      this.port.set({ rts: true, dtr: false }, (error) => (error ? reject(error) : resolve()));
    });
    this.port.on('data', (chunk: Buffer) => handlers.onData(chunk.toString('latin1')));
    this.port.on('error', (error: Error) => handlers.onClose(error));
    // serialport passes an error to "close" only when the port vanished, e.g. the cable was pulled.
    this.port.on('close', (error: Error | null) => {
      if (error) handlers.onClose(error);
    });
  }

  write(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.port.write(data, 'latin1', (error) => (error ? reject(error) : resolve()));
    });
  }

  close(): Promise<void> {
    if (!this.port.isOpen) return Promise.resolve();
    return new Promise((resolve) => this.port.close(() => resolve()));
  }
}
