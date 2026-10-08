import {
  DIGI_MODES,
  DIGI_SLOT_MS,
  type Decode,
  type DecodeBatch,
  type DigiMode,
  type RadioState,
} from '@radiobench/protocol';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatFrequency, mainFrequencyKey } from '../lib/controls.ts';
import { Key } from '../panel/Key.tsx';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';

/** The dial frequencies the modes are worked on, as WSJT-X lists them. */
const DIAL_HZ: Record<DigiMode, { band: string; hz: number }[]> = {
  FT8: [
    { band: '160 m', hz: 1_840_000 },
    { band: '80 m', hz: 3_573_000 },
    { band: '60 m', hz: 5_357_000 },
    { band: '40 m', hz: 7_074_000 },
    { band: '30 m', hz: 10_136_000 },
    { band: '20 m', hz: 14_074_000 },
    { band: '17 m', hz: 18_100_000 },
    { band: '15 m', hz: 21_074_000 },
    { band: '12 m', hz: 24_915_000 },
    { band: '10 m', hz: 28_074_000 },
    { band: '6 m', hz: 50_313_000 },
  ],
  FT4: [
    { band: '80 m', hz: 3_575_000 },
    { band: '40 m', hz: 7_047_500 },
    { band: '30 m', hz: 10_140_000 },
    { band: '20 m', hz: 14_080_000 },
    { band: '17 m', hz: 18_104_000 },
    { band: '15 m', hz: 21_140_000 },
    { band: '12 m', hz: 24_919_000 },
    { band: '10 m', hz: 28_180_000 },
    { band: '6 m', hz: 50_318_000 },
  ],
};

/** Both modes are sent in upper sideband; the radio's data mode keeps the audio path flat. */
const SUITABLE_MODES: RadioState['modeMain'][] = ['DATA-U', 'USB'];

/** 14:30:15 UTC, as WSJT-X labels its slots. */
function utc(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function withSign(value: number, digits = 0): string {
  return (value > 0 ? '+' : value === 0 ? ' ' : '') + value.toFixed(digits);
}

/** The callsign stands as a word of the message, not as part of a longer one. */
function mentions(text: string, call: string): boolean {
  return call !== '' && text.split(/[\s<>]+/).includes(call);
}

function rowClass(decode: Decode, myCall: string): string {
  if (mentions(decode.text, myCall)) return 'digi-mine';
  if (decode.text.startsWith('CQ ')) return 'digi-cq';
  return decode.ap ? 'digi-ap' : '';
}

/** The decoder's status in a few words. */
function describe(
  status: 'off' | 'idle' | 'running' | 'unavailable' | null,
  detail: string | null,
  threads: number | undefined,
  depth: number | undefined,
): string {
  switch (status) {
    case null:
      return 'The server cannot be reached';
    case 'off':
      return 'Audio is switched off on the server, so there is nothing to decode';
    case 'unavailable':
      return detail ?? 'The radio’s audio cannot be captured';
    case 'idle':
      return 'Switch on to see who is on the band';
    case 'running':
      return `Decoding${threads && threads > 1 ? ` on ${threads} threads` : ''}, ${['fast', 'normal', 'deep'][(depth ?? 2) - 1]}`;
  }
}

/** Decodes of one slot, under a line that says when it was and where the radio was. */
function SlotRows({ batch, myCall }: { batch: DecodeBatch; myCall: string }) {
  return (
    <>
      <tr className="digi-slot">
        <td colSpan={5}>
          {utc(batch.slotStart)}
          {batch.dialHz !== null ? ` · ${formatFrequency(batch.dialHz)}` : ''}
          {batch.radioMode ? ` ${batch.radioMode}` : ''}
          {' · '}
          {batch.decodes.length === 0
            ? 'nothing decoded'
            : `${batch.decodes.length} decode${batch.decodes.length === 1 ? '' : 's'}`}
        </td>
      </tr>
      {[...batch.decodes]
        .sort((a, b) => a.hz - b.hz)
        .map((decode, index) => (
          <tr key={index} className={rowClass(decode, myCall)}>
            <td>{utc(batch.slotStart)}</td>
            <td className="digi-number">{withSign(decode.snr)}</td>
            <td className="digi-number">{withSign(decode.dt, 1)}</td>
            <td className="digi-number">{decode.hz}</td>
            <td className="digi-text">
              {decode.text}
              {decode.ap ? <span className="digi-flag"> a{decode.ap}</span> : null}
            </td>
          </tr>
        ))}
    </>
  );
}

/**
 * The FT8/FT4 monitor under the radio: what the server decodes from the received audio,
 * slot by slot, so that one can see who is about before starting WSJT-X for real.
 */
export function DigiPanel() {
  const { state, decoder, decodes, set } = useRadio();
  const ui = useUi();
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [now, setNow] = useState(() => Date.now());

  // The clock and the slot bar move on their own.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const slotMs = DIGI_SLOT_MS[ui.digiMode];
  const batches = decodes.filter((batch) => batch.mode === ui.digiMode);
  const running = decoder?.status === 'running' && ui.decoding;
  const dialKey = state ? mainFrequencyKey(state) : 'frequencyA';
  const dialHz = state?.[dialKey] ?? null;
  const onBand = DIAL_HZ[ui.digiMode].find((entry) => entry.hz === dialHz);
  const wrongMode =
    running && state?.modeMain && !SUITABLE_MODES.includes(state.modeMain) ? state.modeMain : null;

  // The list follows the newest decodes unless the reader has scrolled back.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stuck.current) element.scrollTop = element.scrollHeight;
  }, [batches.length]);

  return (
    <section className="digi" aria-label="FT8 and FT4 monitor">
      <div className="digi-bar">
        <Key
          className="digi-key"
          lit={running ? 'green' : false}
          disabled={!decoder || decoder.status === 'off'}
          title={describe(
            decoder?.status ?? null,
            decoder?.detail ?? null,
            decoder?.threads,
            decoder?.depth,
          )}
          onPress={() => ui.setDecoding(!ui.decoding)}
        >
          DECODE
        </Key>
        <div className="digi-modes" role="radiogroup" aria-label="Mode to decode">
          {DIGI_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`digi-mode ${mode === ui.digiMode ? 'digi-mode-on' : ''}`}
              aria-pressed={mode === ui.digiMode}
              onClick={() => ui.setDigiMode(mode)}
            >
              {mode}
            </button>
          ))}
        </div>
        <select
          className="digi-tune"
          value={onBand ? onBand.hz : ''}
          disabled={state?.link !== 'connected'}
          aria-label={`Tune the radio to a ${ui.digiMode} frequency`}
          title={`Tunes the radio to the ${ui.digiMode} frequency of a band, in DATA-U`}
          onChange={(event) => {
            const hz = Number(event.target.value);
            if (!hz) return;
            set('modeMain', 'DATA-U');
            set(dialKey, hz);
          }}
        >
          <option value="">{onBand ? `${onBand.band} ${ui.digiMode}` : 'Tune to…'}</option>
          {DIAL_HZ[ui.digiMode].map((entry) => (
            <option key={entry.hz} value={entry.hz}>
              {entry.band} · {formatFrequency(entry.hz)}
            </option>
          ))}
        </select>
        <label className="digi-call">
          My call
          <input
            type="text"
            value={ui.myCall}
            placeholder="e.g. K1ABC"
            spellCheck={false}
            autoCapitalize="characters"
            onChange={(event) => ui.setMyCall(event.target.value)}
          />
        </label>
        <span
          className={`digi-status ${decoder?.status === 'unavailable' ? 'digi-status-bad' : ''}`}
        >
          {ui.decoding
            ? describe(
                decoder?.status ?? null,
                decoder?.detail ?? null,
                decoder?.threads,
                decoder?.depth,
              )
            : describe(decoder ? 'idle' : null, null, undefined, undefined)}
        </span>
        <span className="digi-clock" title="UTC, and how far the current slot has got">
          {utc(now)}
          <span className="digi-slot-bar">
            <span style={{ width: `${((now % slotMs) / slotMs) * 100}%` }} />
          </span>
        </span>
      </div>
      {wrongMode ? (
        <p className="digi-hint">
          The radio is on {wrongMode}; {ui.digiMode} is sent in upper sideband (DATA-U or USB).
        </p>
      ) : null}
      <div
        className="digi-list"
        ref={scroller}
        onScroll={(event) => {
          const element = event.currentTarget;
          stuck.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
        }}
      >
        <table className="digi-table">
          <thead>
            <tr>
              <th>UTC</th>
              <th>dB</th>
              <th>DT</th>
              <th>Hz</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((batch) => (
              <SlotRows key={batch.slotStart} batch={batch} myCall={ui.myCall} />
            ))}
            {batches.length === 0 ? (
              <tr className="digi-empty">
                <td colSpan={5}>
                  {running
                    ? `Listening. ${ui.digiMode} slots end every ${slotMs / 1000} s; the first decodes follow a couple of seconds after the first whole slot.`
                    : `No ${ui.digiMode} decodes yet.`}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}
