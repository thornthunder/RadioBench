import {
  AUDIO_SPECTRUM_BINS,
  AUDIO_WAVE_COLUMNS,
  SCOPE_BINS,
  describeScopeMode,
  isValidSetting,
} from '@radiobench/protocol';
import { useEffect, useRef, useState } from 'react';
import { formatFrequency, mainFrequency, mainFrequencyKey } from '../lib/controls.ts';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';

const SPECTRUM_HEIGHT = 110;
const WATERFALL_HEIGHT = 150;
const STREAM_HEIGHT = SPECTRUM_HEIGHT + WATERFALL_HEIGHT;
const AUDIO_PANE_HEIGHT = 100;
/**
 * Sweeps averaged into one line of the waterfall, which steadies the noise so that weak
 * signals show. At the radio's 30 sweeps a second, three make it cover about 15 seconds.
 */
const SWEEPS_PER_ROW = 3;
/** How many of those lines the 3DSS view keeps, front to back: about five seconds. */
const STREAM_DEPTH = 48;

// Display range, in the radio's uncalibrated 0–255 units, relative to the noise floor.
const BELOW_FLOOR = 10;
const RANGE = 110;
/** How quickly the displayed noise floor follows the measured one: the share taken per sweep. */
const FLOOR_SMOOTHING = 0.05;

const TRACE_COLOR = '#e8ecf4';
const TRACE_FILL = 'rgba(70, 120, 255, 0.35)';
const AUDIO_COLOR = '#6fe3a0';

/** Colours from weakest to strongest, as [position, red, green, blue]. */
const COLOR_STOPS = [
  [0, 2, 4, 18],
  [0.25, 14, 40, 120],
  [0.5, 40, 150, 190],
  [0.75, 245, 210, 66],
  [0.9, 240, 80, 45],
  [1, 255, 255, 255],
] as const;

/** The colour for each of 256 levels, as RGB triples laid end to end. */
const PALETTE = (() => {
  const palette = new Uint8ClampedArray(256 * 3);
  for (let level = 0; level < 256; level++) {
    const at = level / 255;
    const upper = COLOR_STOPS.findIndex(([position]) => position >= at);
    const to = COLOR_STOPS[Math.max(upper, 1)]!;
    const from = COLOR_STOPS[Math.max(upper, 1) - 1]!;
    const mix = (at - from[0]) / (to[0] - from[0]);
    for (let channel = 0; channel < 3; channel++) {
      palette[level * 3 + channel] =
        from[channel + 1]! + (to[channel + 1]! - from[channel + 1]!) * mix;
    }
  }
  return palette;
})();

/** The level a fifth of the sweep's points lie below: a steady estimate of the noise floor. */
function noiseFloor(bins: Uint8Array): number {
  const counts = new Uint16Array(256);
  for (const value of bins) counts[value]!++;
  let seen = 0;
  for (let level = 0; level < 256; level++) {
    seen += counts[level]!;
    if (seen >= bins.length / 5) return level;
  }
  return 255;
}

/** An offset from the centre of the sweep, worded as on the radio's scale: "-40k", "+2.5k". */
function offsetLabel(hz: number): string {
  const k = hz / 1000;
  return `${k > 0 ? '+' : ''}${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/**
 * Draws the 3DSS picture: the recent lines one behind another, the newest in front and the
 * older ones smaller and higher up, each drawn as a ridge whose colour rises with its height.
 * `lines` holds levels of 0–255 per point; `newest` says which line is the latest.
 */
function drawStream(image: ImageData, lines: Uint8Array[], newest: number): void {
  const { data, width, height } = image;
  data.fill(0);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const tallest = height * 0.45;

  // From the back forward, so that nearer ridges cover the ones behind them.
  for (let back = lines.length - 1; back >= 0; back--) {
    const line = lines[(newest - back + lines.length) % lines.length]!;
    const distance = back / (lines.length - 1);
    const scale = 1 - 0.4 * distance;
    const base = Math.round(height - 3 - distance * height * 0.5);
    const left = Math.round((width - width * scale) / 2);
    const columns = Math.round(width * scale);
    const dim = 1 - 0.45 * distance;

    for (let column = 0; column < columns; column++) {
      const level = line[Math.floor(column / scale)]! / 255;
      const top = base - Math.round(level * tallest * scale);
      for (let y = base; y >= top && y >= 0; y--) {
        // The colour goes with how high up the ridge the pixel is, as on the radio.
        const color = Math.round(((base - y) / tallest / scale) * 255) * 3;
        const at = (y * width + left + column) * 4;
        data[at] = PALETTE[color]! * dim;
        data[at + 1] = PALETTE[color + 1]! * dim;
        data[at + 2] = PALETTE[color + 2]! * dim + 28 * dim;
      }
    }
  }
}

/**
 * The radio's spectrum scope. Like the radio it shows either the current sweep over a
 * waterfall or the 3DSS picture, and in the MULTI view the audio oscilloscope and audio
 * spectrum beside it. As on the radio, touching the scope tunes to the frequency touched.
 */
export function ScopeView() {
  const { state, scope, set, subscribeScope } = useRadio();
  const { multi } = useUi();
  const spectrumRef = useRef<HTMLCanvasElement>(null);
  const waterfallRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLCanvasElement>(null);
  const [sweep, setSweep] = useState<{ startHz: number; spanHz: number } | null>(null);

  const stream =
    state?.scopeMode !== null && state?.scopeMode !== undefined
      ? describeScopeMode(state.scopeMode).view === '3DSS'
      : false;
  // The drawing loop below is set up once; it looks here to see what is on show.
  const showing = useRef({ stream, multi });
  showing.current = { stream, multi };

  useEffect(() => {
    const spectrum = spectrumRef.current?.getContext('2d');
    const waterfall = waterfallRef.current?.getContext('2d');
    const streamContext = streamRef.current?.getContext('2d');
    const wave = waveRef.current?.getContext('2d');
    const audio = audioRef.current?.getContext('2d');
    if (!spectrum || !waterfall || !streamContext || !wave || !audio) return;

    const row = waterfall.createImageData(SCOPE_BINS, 1);
    row.data.fill(255);
    const streamImage = streamContext.createImageData(SCOPE_BINS, STREAM_HEIGHT);
    const lines = Array.from({ length: STREAM_DEPTH }, () => new Uint8Array(SCOPE_BINS));
    let newest = 0;
    const sums = new Uint16Array(SCOPE_BINS);
    let sweepsInRow = 0;
    let floor: number | null = null;

    return subscribeScope(({ startHz, spanHz, bins, audioSpectrum, audioWave }) => {
      const measured = noiseFloor(bins);
      floor = floor === null ? measured : floor + (measured - floor) * FLOOR_SMOOTHING;
      const bottom = floor - BELOW_FLOOR;
      const level = (value: number) => Math.min(1, Math.max(0, (value - bottom) / RANGE));

      for (let bin = 0; bin < SCOPE_BINS; bin++) sums[bin]! += bins[bin]!;

      if (!showing.current.stream) {
        spectrum.clearRect(0, 0, SCOPE_BINS, SPECTRUM_HEIGHT);
        spectrum.beginPath();
        spectrum.moveTo(0, SPECTRUM_HEIGHT);
        for (let bin = 0; bin < SCOPE_BINS; bin++) {
          spectrum.lineTo(bin + 0.5, SPECTRUM_HEIGHT - level(bins[bin]!) * (SPECTRUM_HEIGHT - 2));
        }
        spectrum.lineTo(SCOPE_BINS, SPECTRUM_HEIGHT);
        spectrum.fillStyle = TRACE_FILL;
        spectrum.fill();
        spectrum.strokeStyle = TRACE_COLOR;
        spectrum.stroke();
      }

      if (++sweepsInRow === SWEEPS_PER_ROW) {
        // A new line: into the waterfall at the top, and to the front of the 3DSS picture.
        newest = (newest + 1) % STREAM_DEPTH;
        const line = lines[newest]!;
        for (let bin = 0; bin < SCOPE_BINS; bin++) {
          const value = Math.round(level(sums[bin]! / SWEEPS_PER_ROW) * 255);
          line[bin] = value;
          row.data[bin * 4] = PALETTE[value * 3]!;
          row.data[bin * 4 + 1] = PALETTE[value * 3 + 1]!;
          row.data[bin * 4 + 2] = PALETTE[value * 3 + 2]!;
        }
        waterfall.drawImage(waterfall.canvas, 0, 1);
        waterfall.putImageData(row, 0, 0);
        if (showing.current.stream) {
          drawStream(streamImage, lines, newest);
          streamContext.putImageData(streamImage, 0, 0);
        }
        sums.fill(0);
        sweepsInRow = 0;
      }

      if (showing.current.multi) {
        // The oscilloscope: for each column the stroke the radio draws there.
        wave.clearRect(0, 0, AUDIO_WAVE_COLUMNS, AUDIO_PANE_HEIGHT);
        wave.strokeStyle = AUDIO_COLOR;
        wave.beginPath();
        for (let column = 0; column < AUDIO_WAVE_COLUMNS; column++) {
          const from = (audioWave[column * 2]! / 255) * AUDIO_PANE_HEIGHT;
          const to = (audioWave[column * 2 + 1]! / 255) * AUDIO_PANE_HEIGHT;
          wave.moveTo(column + 0.5, AUDIO_PANE_HEIGHT - from);
          wave.lineTo(column + 0.5, AUDIO_PANE_HEIGHT - to - 1);
        }
        wave.stroke();

        audio.clearRect(0, 0, AUDIO_SPECTRUM_BINS, AUDIO_PANE_HEIGHT);
        audio.fillStyle = AUDIO_COLOR;
        for (let bin = 0; bin < AUDIO_SPECTRUM_BINS; bin++) {
          const height = (audioSpectrum[bin]! / 255) * AUDIO_PANE_HEIGHT;
          audio.fillRect(bin, AUDIO_PANE_HEIGHT - height, 1, height);
        }
      }

      setSweep((current) =>
        current?.startHz === startHz && current.spanHz === spanHz ? current : { startHz, spanHz },
      );
    });
  }, [subscribeScope]);

  const tuned = state ? mainFrequency(state) : null;
  const marker = sweep && tuned !== null ? (tuned - sweep.startHz) / sweep.spanHz : null;
  const showMarker = state?.scopeMarker !== false && marker !== null && marker >= 0 && marker <= 1;
  const centreHz = sweep ? sweep.startHz + sweep.spanHz / 2 : null;

  const tuneToTouch = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!sweep || !state) return;
    const box = event.currentTarget.getBoundingClientRect();
    const touched = sweep.startHz + ((event.clientX - box.left) / box.width) * sweep.spanHz;
    // No finer than the screen can be pointed at.
    const grain = sweep.spanHz >= 20_000 ? 100 : 10;
    const hz = Math.round(touched / grain) * grain;
    const key = mainFrequencyKey(state);
    if (isValidSetting(key, hz)) set(key, hz);
  };

  return (
    <div className={`scope ${stream ? 'scope-stream' : ''} ${multi ? 'scope-multi' : ''}`}>
      <div className="scope-picture" onPointerDown={tuneToTouch} title="Touch to tune">
        <canvas
          ref={spectrumRef}
          className="scope-trace"
          width={SCOPE_BINS}
          height={SPECTRUM_HEIGHT}
        />
        <canvas
          ref={waterfallRef}
          className="scope-fall"
          width={SCOPE_BINS}
          height={WATERFALL_HEIGHT}
        />
        <canvas ref={streamRef} className="scope-3dss" width={SCOPE_BINS} height={STREAM_HEIGHT} />
        {showMarker && !stream ? (
          <div className="scope-marker" style={{ left: `${marker * 100}%` }} />
        ) : null}
        {scope && scope.status !== 'running' ? (
          <p className="scope-notice">
            {scope.status === 'off' ? 'The scope is switched off on the server' : scope.detail}
          </p>
        ) : null}
      </div>
      <div className="scope-scale">
        {sweep && centreHz !== null
          ? [-0.4, -0.2, 0, 0.2, 0.4].map((part) => (
              <span key={part} style={{ left: `${(0.5 + part) * 100}%` }}>
                {part === 0 ? formatFrequency(centreHz) : offsetLabel(part * sweep.spanHz)}
              </span>
            ))
          : null}
      </div>
      <div className="scope-audio">
        <figure>
          <canvas ref={waveRef} width={AUDIO_WAVE_COLUMNS} height={AUDIO_PANE_HEIGHT} />
          <figcaption>OSCILLOSCOPE</figcaption>
        </figure>
        <figure>
          <canvas ref={audioRef} width={AUDIO_SPECTRUM_BINS} height={AUDIO_PANE_HEIGHT} />
          <figcaption>AF-FFT</figcaption>
        </figure>
      </div>
    </div>
  );
}
