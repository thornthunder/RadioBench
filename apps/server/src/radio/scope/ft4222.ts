import { existsSync } from 'node:fs';
import koffi from 'koffi';
import type { ScopeSource } from './source.ts';

// The radio's scope port is an FTDI FT4222 USB-to-SPI bridge with the PC as SPI master.
// FTDI's driver lists its SPI interface under this name.
const DEVICE_DESCRIPTION = 'FT4222 A';

// SPI settings, from the wfview project: single-line SPI, clock idle high, data sampled on
// the leading edge, slave select 0.
const SPI_IO_SINGLE = 1;
const CLK_IDLE_HIGH = 1;
const CLK_LEADING = 0;
const SLAVE_SELECT_0 = 0x01;
// A 24 MHz system clock divided by 16 clocks the port at 1.5 MHz: about 43 frames a second,
// enough to catch every sweep the radio produces (about 30 a second). Measured on an FT-710:
// reads are clean at 3 MHz and corrupt at 6 MHz, so this leaves a factor of four in hand.
const SYS_CLK_24 = 1;
const CLK_DIV_16 = 4;

const FT_OPEN_BY_DESCRIPTION = 2;
const FT_OK = 0;
const FT_DEVICE_NOT_FOUND = 2;
const FT_DEVICE_NOT_OPENED = 3;
const USB_TIMEOUT_MS = 100;
const USB_LATENCY_MS = 2;

type Handle = unknown;
type ReadCallback = (error: Error | null, status: number) => void;

interface Api {
  openEx(description: string, flags: number, handle: [Handle]): number;
  setTimeouts(handle: Handle, readMs: number, writeMs: number): number;
  setLatencyTimer(handle: Handle, ms: number): number;
  close(handle: Handle): number;
  spiMasterInit(
    handle: Handle,
    ioLine: number,
    clockDivider: number,
    polarity: number,
    phase: number,
    slaveSelect: number,
  ): number;
  setClock(handle: Handle, clock: number): number;
  unInitialize(handle: Handle): number;
  singleRead: {
    async(
      handle: Handle,
      buffer: Buffer,
      length: number,
      lengthRead: [number],
      endTransaction: boolean,
      callback: ReadCallback,
    ): void;
  };
}

let api: Api | null = null;

/** Loads FTDI's two libraries: the D2XX driver's own, and LibFT4222 which builds on it. */
function loadApi(libraryPath: string): Api {
  if (api) return api;
  if (!existsSync(libraryPath)) {
    throw new Error(`FTDI's LibFT4222 library is missing; it is expected at ${libraryPath}`);
  }
  const d2xx = koffi.load('ftd2xx.dll');
  const ft4222 = koffi.load(libraryPath);
  api = {
    openEx: d2xx.func(
      'uint32_t FT_OpenEx(const char *arg, uint32_t flags, _Out_ void **handle)',
    ) as Api['openEx'],
    setTimeouts: d2xx.func(
      'uint32_t FT_SetTimeouts(void *handle, uint32_t read, uint32_t write)',
    ) as Api['setTimeouts'],
    setLatencyTimer: d2xx.func(
      'uint32_t FT_SetLatencyTimer(void *handle, uint8_t ms)',
    ) as Api['setLatencyTimer'],
    close: d2xx.func('uint32_t FT_Close(void *handle)') as Api['close'],
    spiMasterInit: ft4222.func(
      'int FT4222_SPIMaster_Init(void *handle, int ioLine, int clockDiv, int cpol, int cpha, uint8_t ssoMap)',
    ) as Api['spiMasterInit'],
    setClock: ft4222.func('int FT4222_SetClock(void *handle, int clock)') as Api['setClock'],
    unInitialize: ft4222.func('int FT4222_UnInitialize(void *handle)') as Api['unInitialize'],
    singleRead: ft4222.func(
      'int FT4222_SPIMaster_SingleRead(void *handle, _Out_ uint8_t *buffer, uint16_t size, _Out_ uint16_t *sizeRead, bool endTransaction)',
    ) as unknown as Api['singleRead'],
  };
  return api;
}

function check(step: string, status: number): void {
  if (status !== FT_OK) throw new Error(`Setting up the scope port failed (${step}: ${status})`);
}

/** The FT-710's scope port, read through FTDI's LibFT4222. */
export class Ft4222Source implements ScopeSource {
  private readonly libraryPath: string;
  private handle: Handle = null;

  constructor(libraryPath: string) {
    this.libraryPath = libraryPath;
  }

  async open(): Promise<void> {
    const ftdi = loadApi(this.libraryPath);
    const handle: [Handle] = [null];
    const status = ftdi.openEx(DEVICE_DESCRIPTION, FT_OPEN_BY_DESCRIPTION, handle);
    if (status === FT_DEVICE_NOT_FOUND) {
      throw new Error(
        'The scope port of the radio was not found. Is SCU-LAN10 set to ON under MENU → OPERATION SETTING → GENERAL?',
      );
    }
    if (status === FT_DEVICE_NOT_OPENED) {
      throw new Error('The scope port of the radio is in use by another program');
    }
    if (status !== FT_OK) throw new Error(`Opening the scope port failed (FTDI status ${status})`);
    this.handle = handle[0];
    try {
      check('timeouts', ftdi.setTimeouts(this.handle, USB_TIMEOUT_MS, USB_TIMEOUT_MS));
      check('latency', ftdi.setLatencyTimer(this.handle, USB_LATENCY_MS));
      check(
        'SPI',
        ftdi.spiMasterInit(
          this.handle,
          SPI_IO_SINGLE,
          CLK_DIV_16,
          CLK_IDLE_HIGH,
          CLK_LEADING,
          SLAVE_SELECT_0,
        ),
      );
      check('clock', ftdi.setClock(this.handle, SYS_CLK_24));
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  // The read takes as long as the frame takes to clock out, so it runs off the main thread.
  read(length: number): Promise<Uint8Array> {
    const ftdi = loadApi(this.libraryPath);
    const buffer = Buffer.alloc(length);
    const lengthRead: [number] = [0];
    return new Promise((resolve, reject) => {
      ftdi.singleRead.async(this.handle, buffer, length, lengthRead, false, (error, status) => {
        if (error) reject(error);
        else if (status !== FT_OK || lengthRead[0] !== length) {
          reject(new Error(`Reading the scope port failed (FTDI status ${status})`));
        } else resolve(buffer);
      });
    });
  }

  async close(): Promise<void> {
    if (this.handle === null || !api) return;
    api.unInitialize(this.handle);
    api.close(this.handle);
    this.handle = null;
  }
}
