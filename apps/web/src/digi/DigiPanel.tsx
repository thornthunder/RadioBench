import {
  DIGI_SLOT_MS,
  MONITOR_MODES,
  type CwState,
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

/** Both slot modes are sent in upper sideband; the radio's data mode keeps the audio path flat. */
const SUITABLE_MODES: RadioState['modeMain'][] = ['DATA-U', 'USB'];
/** In a CW mode the radio's narrow filter helps, and the decoder follows the radio's pitch. */
const CW_MODES: RadioState['modeMain'][] = ['CW-U', 'CW-L'];

/** How the Morse decoding is going, in a few words. */
function describeCw(cw: CwState | undefined): string {
  if (!cw) return 'Decoding Morse';
  const pitch = cw.pitchHz !== null ? ` at ${cw.pitchHz} Hz` : '';
  if (!cw.signal) return `Listening for Morse${pitch}`;
  return `Decoding Morse${pitch}${cw.wpm !== null ? ` · ${cw.wpm} WPM` : ''}`;
}

/** The Morse text, with the operator's callsign picked out wherever it occurs. */
function CwText({ text, myCall }: { text: string; myCall: string }) {
  if (myCall === '') return <>{text}</>;
  const parts = text.split(myCall);
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? <span className="digi-mine">{myCall}</span> : null}
          {part}
        </span>
      ))}
    </>
  );
}

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
 * The monitor under the radio: what the server decodes from the received audio, slot by
 * slot for FT8 and FT4 so that one can see who is about before starting WSJT-X for real, or
 * as it comes for Morse.
 */
export function DigiPanel() {
  const { state, decoder, decodes, cw, clearCw, set } = useRadio();
  const ui = useUi();
  const scroller = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [now, setNow] = useState(() => Date.now());

  // The clock and the slot bar move on their own.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const slotMode: DigiMode | null = ui.digiMode === 'CW' ? null : ui.digiMode;
  const morse = slotMode === null;
  const slotMs = slotMode ? DIGI_SLOT_MS[slotMode] : null;
  const batches = decodes.filter((batch) => batch.mode === ui.digiMode);
  const running = decoder?.status === 'running' && ui.decoding;
  const dialKey = state ? mainFrequencyKey(state) : 'frequencyA';
  const dialHz = state?.[dialKey] ?? null;
  const onBand = slotMode ? DIAL_HZ[slotMode].find((entry) => entry.hz === dialHz) : undefined;
  const suitable = morse ? CW_MODES : SUITABLE_MODES;
  const wrongMode =
    running && state?.modeMain && !suitable.includes(state.modeMain) ? state.modeMain : null;
  const cwText = cw?.text ?? '';

  // The list follows the newest decodes unless the reader has scrolled back.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && stuck.current) element.scrollTop = element.scrollHeight;
  }, [batches.length, cwText.length]);

  return (
    <section className="digi" aria-label="FT8, FT4 and Morse monitor">
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
          {MONITOR_MODES.map((mode) => (
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
        {slotMode ? (
          <select
            className="digi-tune"
            value={onBand ? onBand.hz : ''}
            disabled={state?.link !== 'connected'}
            aria-label={`Tune the radio to a ${slotMode} frequency`}
            title={`Tunes the radio to the ${slotMode} frequency of a band, in DATA-U`}
            onChange={(event) => {
              const hz = Number(event.target.value);
              if (!hz) return;
              set('modeMain', 'DATA-U');
              set(dialKey, hz);
            }}
          >
            <option value="">{onBand ? `${onBand.band} ${slotMode}` : 'Tune to…'}</option>
            {DIAL_HZ[slotMode].map((entry) => (
              <option key={entry.hz} value={entry.hz}>
                {entry.band} · {formatFrequency(entry.hz)}
              </option>
            ))}
          </select>
        ) : (
          <button
            type="button"
            className="digi-clear"
            disabled={cwText === ''}
            title="Empties the text in this browser"
            onClick={clearCw}
          >
            Clear
          </button>
        )}
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
          {!ui.decoding
            ? describe(decoder ? 'idle' : null, null, undefined, undefined)
            : running && morse
              ? describeCw(cw?.state)
              : describe(
                  decoder?.status ?? null,
                  decoder?.detail ?? null,
                  decoder?.threads,
                  decoder?.depth,
                )}
        </span>
        <span className="digi-clock" title="UTC, and how far the current slot has got">
          {utc(now)}
          {slotMs ? (
            <span className="digi-slot-bar">
              <span style={{ width: `${((now % slotMs) / slotMs) * 100}%` }} />
            </span>
          ) : null}
        </span>
      </div>
      {wrongMode ? (
        <p className="digi-hint">
          {morse
            ? `The radio is on ${wrongMode}; in a CW mode its narrow filter helps, and the decoder follows the radio's CW pitch.`
            : `The radio is on ${wrongMode}; ${ui.digiMode} is sent in upper sideband (DATA-U or USB).`}
        </p>
      ) : null}
      {morse ? (
        <div className="digi-list" ref={scroller}>
          <pre className="cw-text">
            {cwText === '' ? (
              <span className="cw-empty">
                {running
                  ? 'Listening. Text appears as it is decoded; the speed and the tone are shown above.'
                  : 'No Morse decoded yet.'}
              </span>
            ) : (
              <CwText text={cwText} myCall={ui.myCall} />
            )}
            {running ? (
              <span className={`cw-cursor ${cw?.state.signal ? 'cw-cursor-on' : ''}`} />
            ) : null}
          </pre>
        </div>
      ) : null}
      <div
        className="digi-list"
        ref={morse ? undefined : scroller}
        hidden={morse}
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
                    ? `Listening. ${ui.digiMode} slots end every ${(slotMs ?? 0) / 1000} s; the first decodes follow a couple of seconds after the first whole slot.`
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
