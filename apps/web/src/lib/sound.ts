import { AUDIO_SAMPLE_RATE } from '@radiobench/protocol';

/** How far ahead of the clock audio is scheduled: enough to ride out uneven arrival over Wi-Fi. */
const LEAD_SECONDS = 0.12;
/** Audio that has piled up beyond this is skipped, so that what is heard does not fall behind. */
const MAX_AHEAD_SECONDS = 0.6;

/** An AudioContext that may be able to choose its output device (Chrome and Edge can). */
type SinkableContext = AudioContext & { setSinkId?: (deviceId: string) => Promise<void> };

/** Whether this browser lets a page pick the output device for its sound. */
export function outputChoiceSupported(): boolean {
  return 'setSinkId' in AudioContext.prototype && !!navigator.mediaDevices?.enumerateDevices;
}

export interface OutputDevice {
  /** The browser's id for the device; "" is the browser's default. */
  deviceId: string;
  label: string;
}

/**
 * The output devices to choose from. Until the page has had microphone permission the browser
 * hides them, leaving at most a nameless default.
 */
export async function listOutputs(): Promise<OutputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((device) => device.kind === 'audiooutput')
    .map((device, index) => ({
      deviceId: device.deviceId,
      label:
        device.label || (device.deviceId === 'default' ? 'Default output' : `Output ${index + 1}`),
    }));
}

/** Asks for microphone permission, which is what makes the browser show its output devices. */
export async function unlockOutputs(): Promise<OutputDevice[]> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  for (const track of stream.getTracks()) track.stop();
  return listOutputs();
}

/** Plays the radio's received audio as it arrives. */
export class Speaker {
  private readonly context: SinkableContext = new AudioContext();
  private readonly gain = this.context.createGain();
  private nextStart = 0;

  constructor(volume: number) {
    this.gain.gain.value = volume;
    this.gain.connect(this.context.destination);
    // A context can start out suspended under the browser's autoplay rules.
    void this.context.resume();
  }

  /** Whether the browser is letting the sound through. */
  get running(): boolean {
    return this.context.state === 'running';
  }

  /**
   * Asks the browser to let the sound through. Under its autoplay rules this only works from
   * within a user's click or key press, so it is called from those.
   */
  resume(): void {
    if (this.context.state === 'suspended') void this.context.resume();
  }

  /** Plays through the given output device; "" means the browser's default. */
  async setOutput(deviceId: string): Promise<void> {
    if (this.context.setSinkId) await this.context.setSinkId(deviceId);
  }

  /** Queues samples for playing: 16-bit little-endian mono at the protocol's rate. */
  play(samples: Uint8Array): void {
    const count = samples.length >> 1;
    if (count === 0) return;
    if (this.context.state === 'suspended') void this.context.resume();
    const now = this.context.currentTime;
    if (this.nextStart > now + MAX_AHEAD_SECONDS) return;
    // After a gap, start a little ahead again rather than right now.
    if (this.nextStart < now + 0.02) this.nextStart = now + LEAD_SECONDS;

    const buffer = this.context.createBuffer(1, count, AUDIO_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    const view = new DataView(samples.buffer, samples.byteOffset, samples.byteLength);
    for (let i = 0; i < count; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(this.nextStart);
    this.nextStart += buffer.duration;
  }

  setVolume(volume: number): void {
    this.gain.gain.value = volume;
  }

  close(): void {
    void this.context.close();
  }
}

/** Whether this page may use the microphone: browsers allow that only on https or localhost. */
export function microphoneAllowed(): boolean {
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * Captures the microphone and hands it over as 16-bit samples at the protocol's rate.
 * Resolves to a function that stops the capture.
 */
export async function openMicrophone(
  onSamples: (samples: Int16Array) => void,
): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode is the old way, but the only one that needs no separate worklet file.
  const processor = context.createScriptProcessor(2048, 1, 1);
  const ratio = context.sampleRate / AUDIO_SAMPLE_RATE;
  let position = 0;

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const output = new Int16Array(Math.floor((input.length - position) / ratio) + 1);
    let count = 0;
    // Each output sample is the average of the input samples it spans.
    for (; position + ratio <= input.length; position += ratio) {
      let sum = 0;
      const from = Math.floor(position);
      const to = Math.floor(position + ratio);
      for (let i = from; i < to; i++) sum += input[i] ?? 0;
      const sample = sum / Math.max(1, to - from);
      output[count++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    position -= input.length;
    if (count > 0) onSamples(output.subarray(0, count));
  };

  // The processor only runs while it leads somewhere; a silent path to the output does that.
  const mute = context.createGain();
  mute.gain.value = 0;
  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  return () => {
    processor.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    void context.close();
  };
}
