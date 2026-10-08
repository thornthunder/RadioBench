import { AUDIO_SAMPLE_RATE } from '@radiobench/protocol';
import type { AudioDevice } from './audio.ts';

// The part of @kmamal/sdl that is used here.
interface SdlDevice {
  type: 'recording' | 'playback';
  name?: string;
}
interface SdlStream {
  readonly queued: number;
  play(): void;
  close(): void;
}
interface Recorder extends SdlStream {
  dequeue(buffer: Buffer): number;
}
interface Player extends SdlStream {
  enqueue(buffer: Buffer): void;
}
interface Sdl {
  audio: {
    devices: SdlDevice[];
    openDevice(device: SdlDevice, options: object): SdlStream;
  };
}

const FORMAT = { channels: 1, frequency: AUDIO_SAMPLE_RATE, format: 's16lsb' } as const;
/** Samples the sound card hands over at a time: 16 ms at 16 kHz. */
const BUFFERED_SAMPLES = 256;
/** Microphone audio is dropped rather than queued beyond this: about a third of a second. */
const MAX_QUEUED_BYTES = AUDIO_SAMPLE_RATE * 2 * 0.35;

const NOTHING = new Uint8Array(0);

let loading: Promise<Sdl> | null = null;

/** The SDL library is loaded on first use; where it is missing, audio alone is unavailable. */
function loadSdl(): Promise<Sdl> {
  loading ??= import('@kmamal/sdl').then(
    (module) => ((module as { default?: unknown }).default ?? module) as Sdl,
    () => {
      loading = null;
      throw new Error('The audio library (SDL) could not be loaded on this computer');
    },
  );
  return loading;
}

/**
 * The radio's USB sound device, through SDL. The radio's received audio is one of the
 * computer's recording devices, and what is played to its playback device is the audio the
 * radio transmits. SDL converts between their native format and the one RadioBench uses.
 */
export class SdlAudioDevice implements AudioDevice {
  private readonly inputName: string;
  private readonly outputName: string;
  private recorder: Recorder | null = null;
  private player: Player | null = null;

  /** The names are matched against part of the device names Windows shows. */
  constructor(inputName: string, outputName: string) {
    this.inputName = inputName;
    this.outputName = outputName;
  }

  async openInput(): Promise<void> {
    const sdl = await loadSdl();
    const device = sdl.audio.devices.find(
      (candidate) => candidate.type === 'recording' && candidate.name?.includes(this.inputName),
    );
    if (!device) {
      throw new Error(
        `No recording device named "${this.inputName}" was found. Is the radio's USB cable connected?`,
      );
    }
    this.recorder = sdl.audio.openDevice(device, {
      ...FORMAT,
      buffered: BUFFERED_SAMPLES,
    }) as Recorder;
    this.recorder.play();
  }

  read(): Uint8Array {
    const recorder = this.recorder;
    if (!recorder || recorder.queued < 2) return NOTHING;
    const buffer = Buffer.alloc(recorder.queued & ~1);
    return buffer.subarray(0, recorder.dequeue(buffer));
  }

  closeInput(): void {
    this.recorder?.close();
    this.recorder = null;
  }

  async openOutput(): Promise<void> {
    const sdl = await loadSdl();
    const device = sdl.audio.devices.find(
      (candidate) => candidate.type === 'playback' && candidate.name?.includes(this.outputName),
    );
    if (!device) throw new Error(`No playback device named "${this.outputName}" was found`);
    this.player = sdl.audio.openDevice(device, {
      ...FORMAT,
      buffered: BUFFERED_SAMPLES,
    }) as Player;
    this.player.play();
  }

  write(samples: Uint8Array): void {
    const player = this.player;
    // A queue that only grows means audio is arriving faster than it plays; better a gap than a lag.
    if (!player || player.queued > MAX_QUEUED_BYTES) return;
    player.enqueue(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  closeOutput(): void {
    this.player?.close();
    this.player = null;
  }
}
