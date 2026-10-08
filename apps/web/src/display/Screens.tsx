import {
  BANDS,
  CONTROLS,
  DSP_KNOB_FUNCTIONS,
  MODES,
  SCOPE_SPANS_HZ,
  SCOPE_SPEEDS,
  TX_METERS,
  isValidSetting,
  widthHz,
  type FuncKnobFunction,
  type MenuScreen,
  type RadioState,
  type SettingKey,
} from '@radiobench/protocol';
import { useState, type ReactNode } from 'react';
import {
  DSP_TARGETS,
  FUNC_TARGETS,
  mainFrequencyKey,
  settingText,
  useNudge,
} from '../lib/controls.ts';
import { useRadio } from '../radio.tsx';
import { useUi, type Screen } from '../ui.tsx';
import { MemoryScreen, MessageScreen, PowerScreen, SettingsScreen } from './MoreScreens.tsx';

/**
 * A screen put up over the normal display, with the radio's [BACK] in its corner. A full one
 * covers the frequencies too, for screens that need the room.
 */
export function ScreenFrame({
  title,
  full = false,
  children,
}: {
  title: string;
  full?: boolean;
  children: ReactNode;
}) {
  const { show } = useUi();
  return (
    <div className={`screen ${full ? 'screen-full' : ''}`}>
      <header>
        <span>{title}</span>
        <button type="button" className="screen-back" onClick={() => show(null)}>
          BACK
        </button>
      </header>
      {children}
    </div>
  );
}

interface Option {
  label: string;
  active: boolean;
  choose(): void;
}

/** A screen that offers a handful of values to pick one from. */
function Choice({
  title,
  options,
  columns = 4,
}: {
  title: string;
  options: Option[];
  columns?: number;
}) {
  const { show } = useUi();
  return (
    <ScreenFrame title={title}>
      <div className="screen-grid" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)` }}>
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={option.active ? 'chosen' : ''}
            onClick={() => {
              option.choose();
              show(null);
            }}
          >
            {option.label}
          </button>
        ))}
      </div>
    </ScreenFrame>
  );
}

function Keypad() {
  const { state, set } = useRadio();
  const { show } = useUi();
  const [entry, setEntry] = useState('');
  const hz = Math.round(Number(entry) * 1_000_000);
  const valid = entry !== '' && isValidSetting('frequencyA', hz);

  const enter = () => {
    if (!state || !valid) return;
    set(mainFrequencyKey(state), hz);
    show(null);
  };

  return (
    <ScreenFrame title="FREQUENCY (MHz)">
      <div className="keypad">
        <output>{entry || ' '}</output>
        {['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '.'].map((key) => (
          <button
            key={key}
            type="button"
            onClick={() =>
              setEntry((text) => (key === '.' && text.includes('.') ? text : text + key))
            }
          >
            {key}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setEntry((text) => text.slice(0, -1))}
          aria-label="Delete"
        >
          ⌫
        </button>
        <button type="button" className="keypad-wide" onClick={() => setEntry('')}>
          CLR
        </button>
        <button type="button" className="keypad-wide chosen" disabled={!valid} onClick={enter}>
          ENT
        </button>
      </div>
    </ScreenFrame>
  );
}

type FuncCell =
  /** Makes the [FUNC] knob adjust a setting; touched again, switches what it belongs to on or off. */
  | { label: string; knob: FuncKnobFunction; power?: 'processor' | 'monitor' }
  | { label: string; toggle: SettingKey }
  | { label: string; step: SettingKey; by: number }
  /** Opens another screen. */
  | { label: string; opens: Screen }
  /** Opens one of the setting screens. */
  | { label: string; menu: MenuScreen }
  /** Starts and stops the radio's recording of what it receives. */
  | { label: string; recorder: true }
  /** Something the radio does not let a PC do; why is shown when pointed at. */
  | { label: string; unavailable: string };

/** The radio's function screen, row by row. */
const FUNC_CELLS: FuncCell[] = [
  { label: 'LEVEL', knob: 'LEVEL' },
  { label: 'PEAK', knob: 'PEAK' },
  { label: 'MARKER', toggle: 'scopeMarker' },
  { label: 'COLOR', knob: 'COLOR' },
  { label: 'CONTRAST', knob: 'CONTRAST' },
  { label: 'DIMMER', knob: 'DIMMER' },
  { label: 'M-GROUP', knob: 'M-GROUP' },

  { label: 'MIC GAIN', knob: 'MIC GAIN' },
  { label: 'MIC EQ', toggle: 'micEq' },
  { label: 'PROC LEVEL', knob: 'PROC LEVEL', power: 'processor' },
  { label: 'AMC LEVEL', knob: 'AMC LEVEL' },
  { label: 'VOX GAIN', knob: 'VOX GAIN' },
  { label: 'VOX DELAY', knob: 'VOX DELAY' },
  { label: 'ANTI VOX', knob: 'ANTI VOX' },

  { label: 'RF POWER', knob: 'RF POWER' },
  { label: 'MONI LEVEL', knob: 'MONI LEVEL', power: 'monitor' },
  { label: 'KEYER', toggle: 'keyer' },
  { label: 'BK-IN', toggle: 'breakIn' },
  { label: 'CW SPEED', knob: 'CW SPEED' },
  { label: 'CW PITCH', knob: 'CW PITCH' },
  { label: 'BK-DELAY', knob: 'BK-DELAY' },

  { label: 'MESSAGE', opens: 'message' },
  { label: 'RECORD', recorder: true },
  { label: 'PLAY', opens: 'message' },
  { label: 'TXW', toggle: 'txw' },
  { label: 'MEMORY', opens: 'memory' },
  { label: 'AESS', step: 'aessLevel', by: 10 },
  { label: 'AESS-CF', toggle: 'aessCutoff' },

  { label: 'RADIO SETTING', menu: 'RADIO SETTING' },
  { label: 'CW SETTING', menu: 'CW SETTING' },
  { label: 'OPERATION SETTING', menu: 'OPERATION SETTING' },
  { label: 'DISPLAY SETTING', menu: 'DISPLAY SETTING' },
  {
    label: 'EXTENSION SETTING',
    unavailable: 'The radio does not let a PC reach these settings',
  },
];

function FuncScreen() {
  const { state, set, request } = useRadio();
  const { show, showMenu } = useUi();
  const nudge = useNudge();
  if (!state) return null;

  const toggle = (key: SettingKey) => {
    if (key === 'aessCutoff') set(key, state.aessCutoff === '700Hz' ? '1000Hz' : '700Hz');
    else if (CONTROLS[key].kind === 'bool') set(key, !state[key] as never);
  };

  return (
    <div className="screen screen-func">
      <div className="func-grid">
        {FUNC_CELLS.map((cell, index) => {
          if ('unavailable' in cell) {
            return (
              <button key={index} type="button" disabled title={cell.unavailable}>
                <span>{cell.label}</span>
              </button>
            );
          }
          if ('opens' in cell || 'menu' in cell) {
            const open = () => ('menu' in cell ? showMenu(cell.menu) : show(cell.opens));
            return (
              <button key={index} type="button" onClick={open}>
                <span>{cell.label}</span>
              </button>
            );
          }
          if ('recorder' in cell) {
            return (
              <button
                key={index}
                type="button"
                className={state.recording ? 'recording' : ''}
                title="Records the received audio on the radio's SD card"
                onClick={() => request({ type: 'record', on: !state.recording })}
              >
                <span>{cell.label}</span>
                {state.recording ? 'ON' : 'OFF'}
              </button>
            );
          }
          if ('toggle' in cell) {
            return (
              <button key={index} type="button" onClick={() => toggle(cell.toggle)}>
                <span>{cell.label}</span>
                {settingText(cell.toggle, state)}
              </button>
            );
          }
          if ('step' in cell) {
            return (
              <div key={index} className="func-stepper">
                <span>{cell.label}</span>
                <div>
                  <button
                    type="button"
                    onClick={() => nudge(cell.step, -cell.by)}
                    aria-label={`${cell.label} down`}
                  >
                    −
                  </button>
                  {settingText(cell.step, state)}
                  <button
                    type="button"
                    onClick={() => nudge(cell.step, cell.by)}
                    aria-label={`${cell.label} up`}
                  >
                    +
                  </button>
                </div>
              </div>
            );
          }
          const target = FUNC_TARGETS[cell.knob];
          const selected = state.funcKnob === cell.knob;
          const power = cell.power;
          return (
            <button
              key={index}
              type="button"
              className={selected ? 'chosen' : ''}
              title={power ? 'Touch again to switch it on or off' : 'Adjust with the FUNC knob'}
              onClick={() => {
                if (selected && power) set(power, !state[power]);
                else set('funcKnob', cell.knob);
              }}
            >
              <span>{cell.label}</span>
              {target ? settingText(target, state) : ''}
            </button>
          );
        })}
        <button type="button" className="screen-back" onClick={() => show(null)}>
          BACK
        </button>
      </div>
    </div>
  );
}

/** The functions of the [STEP·MCH/DSP] knob: pick one to adjust it with the knob. */
function DspScreen() {
  const { state, set } = useRadio();
  const { show, setDspAdjust } = useUi();
  if (!state) return null;
  const switches = { NOTCH: 'manualNotch', CONTOUR: 'contour', APF: 'apf' } as const;

  return (
    <ScreenFrame title="DSP">
      <div className="screen-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
        {DSP_KNOB_FUNCTIONS.filter((name) => name !== 'NONE').map((name) => {
          const target = DSP_TARGETS[name];
          const power = switches[name as keyof typeof switches];
          const value =
            name === 'WIDTH' && state.modeMain
              ? `${widthHz(state.modeMain, state.width ?? 0)}Hz`
              : target
                ? settingText(target, state)
                : '';
          return (
            <button
              key={name}
              type="button"
              className={state.dspKnob === name ? 'chosen' : ''}
              onClick={() => {
                set('dspKnob', name);
                // Choosing a filter to adjust brings it into play, as it does on the radio.
                if (power && !state[power]) set(power, true);
                setDspAdjust(true);
                show(null);
              }}
            >
              <span>{name}</span>
              {power && !state[power] ? 'OFF' : value}
            </button>
          );
        })}
      </div>
      <div
        className="screen-grid screen-switches"
        style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}
      >
        {Object.entries(switches).map(([name, key]) => (
          <button key={key} type="button" onClick={() => set(key, !state[key])}>
            {name} {state[key] ? 'ON' : 'OFF'}
          </button>
        ))}
      </div>
    </ScreenFrame>
  );
}

const AGC_CHOICES = ['auto', 'fast', 'mid', 'slow', 'off'] as const;

function spanLabel(hz: number): string {
  return hz >= 1_000_000 ? `${hz / 1_000_000} MHz` : `${hz / 1000} kHz`;
}

function choiceScreen(screen: string, state: RadioState, radio: ReturnType<typeof useRadio>) {
  const { set, act } = radio;
  switch (screen) {
    case 'mode':
      return (
        <Choice
          title="MODE"
          options={MODES.map((mode) => ({
            label: mode,
            active: state.modeMain === mode,
            choose: () => set('modeMain', mode),
          }))}
        />
      );
    case 'band':
      return (
        <Choice
          title="BAND (MHz)"
          options={BANDS.map((band, index) => ({
            label: band,
            active: false,
            choose: () => act('bandSelect', index),
          }))}
        />
      );
    case 'att':
      return (
        <Choice
          title="ATT"
          options={CONTROLS.attenuator.values.map((value) => ({
            label: value,
            active: state.attenuator === value,
            choose: () => set('attenuator', value),
          }))}
        />
      );
    case 'ipo':
      return (
        <Choice
          title="IPO"
          columns={3}
          options={CONTROLS.preamp.values.map((value) => ({
            label: value,
            active: state.preamp === value,
            choose: () => set('preamp', value),
          }))}
        />
      );
    case 'agc':
      return (
        <Choice
          title="AGC"
          columns={5}
          options={AGC_CHOICES.map((value) => ({
            label: value.toUpperCase(),
            active: value === 'auto' ? !!state.agc?.startsWith('auto') : state.agc === value,
            choose: () => set('agc', value),
          }))}
        />
      );
    case 'meter':
      return (
        <Choice
          title="TX METER"
          columns={6}
          options={TX_METERS.map((value) => ({
            label: value,
            active: state.txMeter === value,
            choose: () => set('txMeter', value),
          }))}
        />
      );
    case 'span':
      return (
        <Choice
          title="SPAN"
          columns={5}
          options={SCOPE_SPANS_HZ.map((hz, index) => ({
            label: spanLabel(hz),
            active: state.scopeSpan === index,
            choose: () => set('scopeSpan', index),
          }))}
        />
      );
    case 'speed':
      return (
        <Choice
          title="SPEED"
          columns={6}
          options={SCOPE_SPEEDS.map((value) => ({
            label: value,
            active: state.scopeSpeed === value,
            choose: () => set('scopeSpeed', value),
          }))}
        />
      );
    default:
      return null;
  }
}

/** Whichever screen is up over the normal display, if any. */
export function Screens() {
  const radio = useRadio();
  const { screen } = useUi();
  if (!screen || !radio.state) return null;
  if (screen === 'keypad') return <Keypad />;
  if (screen === 'func') return <FuncScreen />;
  if (screen === 'dsp') return <DspScreen />;
  if (screen === 'memory') return <MemoryScreen />;
  if (screen === 'message') return <MessageScreen />;
  if (screen === 'menu') return <SettingsScreen />;
  if (screen === 'power') return <PowerScreen />;
  return choiceScreen(screen, radio.state, radio);
}
