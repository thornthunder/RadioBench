import {
  CONTROLS,
  delayMs,
  stepSetting,
  widthHz,
  widthsHz,
  type DspKnobFunction,
  type FuncKnobFunction,
  type RadioState,
  type SettingKey,
} from '@radiobench/protocol';
import { useCallback, useRef } from 'react';
import { useRadio } from '../radio.tsx';

/** The setting each function of the [FUNC] knob adjusts. M-GROUP has none RadioBench can reach. */
export const FUNC_TARGETS: Partial<Record<FuncKnobFunction, SettingKey>> = {
  LEVEL: 'scopeLevel',
  PEAK: 'scopePeak',
  COLOR: 'scopeColor',
  CONTRAST: 'contrast',
  DIMMER: 'dimmer',
  'MIC GAIN': 'micGain',
  'PROC LEVEL': 'processorLevel',
  'AMC LEVEL': 'amcLevel',
  'VOX GAIN': 'voxGain',
  'VOX DELAY': 'voxDelay',
  'ANTI VOX': 'antiVox',
  'RF POWER': 'power',
  'MONI LEVEL': 'monitorLevel',
  'CW SPEED': 'keySpeed',
  'CW PITCH': 'keyPitchHz',
  'BK-DELAY': 'breakInDelay',
};

/** The setting each DSP function of the [STEP·MCH/DSP] knob adjusts. */
export const DSP_TARGETS: Partial<Record<DspKnobFunction, SettingKey>> = {
  SHIFT: 'ifShiftHz',
  WIDTH: 'width',
  NOTCH: 'manualNotchHz',
  CONTOUR: 'contourHz',
  APF: 'apfHz',
};

/** How long a value just sent stands in for the one the radio has yet to report back. */
const PENDING_MS = 500;

/**
 * Returns a function that moves a numeric setting by an amount, as a turned knob does.
 * Turning sends values faster than the radio reports them back, so each change builds on
 * the value last sent rather than on the one last heard.
 */
export function useNudge(): (key: SettingKey, amount: number) => void {
  const { state, set } = useRadio();
  const pending = useRef(new Map<SettingKey, { value: number; at: number }>());

  return useCallback(
    (key, amount) => {
      const reported = state?.[key];
      if (typeof reported !== 'number') return;
      const sent = pending.current.get(key);
      const now = performance.now();
      const from = sent && now - sent.at < PENDING_MS ? sent.value : reported;
      // The step count is in units of the setting's own step.
      const spec = CONTROLS[key];
      const clicks = spec.kind === 'number' ? amount / spec.step : 0;
      let value = stepSetting(key, from, clicks);
      if (key === 'width' && state?.modeMain) {
        // The widths on offer depend on the mode, and setting 0 stands for the mode's default
        // width: turning the knob starts from where that default sits among the others.
        const widths = widthsHz(state.modeMain);
        const start = from === 0 ? widths.indexOf(widthHz(state.modeMain, 0)) + 1 : from;
        value = Math.min(widths.length, Math.max(1, start + clicks));
      }
      pending.current.set(key, { value, at: now });
      if (value !== from) set(key, value as never);
    },
    [state, set],
  );
}

/** The frequency setting of the main VFO, the one the dial tunes. */
export function mainFrequencyKey(state: RadioState): 'frequencyA' | 'frequencyB' {
  return state.mainVfo === 'B' ? 'frequencyB' : 'frequencyA';
}

export function mainFrequency(state: RadioState): number | null {
  return state[mainFrequencyKey(state)];
}

export function subFrequency(state: RadioState): number | null {
  return state.mainVfo === 'B' ? state.frequencyA : state.frequencyB;
}

const isWideMode = (mode: string | null) =>
  mode === 'AM' || mode === 'AM-N' || !!mode?.includes('FM');
const isDataMode = (mode: string | null) =>
  !!mode && (mode.startsWith('DATA') || mode.startsWith('RTTY') || mode === 'PSK');

/** How far one click of the main dial moves the frequency, as the radio's own dial does. */
export function dialStepHz(state: RadioState): number {
  const wide = isWideMode(state.modeMain);
  if (state.fineTuning === 'fine') return wide ? 10 : 1;
  const menuStep = isDataMode(state.modeMain) ? state.dialStepDataHz : state.dialStepSsbCwHz;
  const step = wide ? 100 : (menuStep ?? 10);
  return state.fineTuning === 'fast' ? step * 10 : step;
}

/** 14074000 as "14.074.000": MHz, kHz and Hz groups, as on the radio. */
export function formatFrequency(hz: number): string {
  const digits = String(Math.max(0, hz)).padStart(9, '0');
  return `${Number(digits.slice(0, 3))}.${digits.slice(3, 6)}.${digits.slice(6)}`;
}

const AGC_LABELS: Record<string, string> = {
  off: 'OFF',
  fast: 'FAST',
  mid: 'MID',
  slow: 'SLOW',
  auto: 'AUTO',
  'auto-fast': 'AUTO',
  'auto-mid': 'AUTO',
  'auto-slow': 'AUTO',
};

const UNITS: Partial<Record<SettingKey, string>> = {
  power: 'W',
  keySpeed: 'wpm',
  keyPitchHz: 'Hz',
  aessLevel: '%',
  ifShiftHz: 'Hz',
  manualNotchHz: 'Hz',
  contourHz: 'Hz',
  apfHz: 'Hz',
};

/** A setting's value as the radio's display words it. */
export function settingText(key: SettingKey, state: RadioState): string {
  const value = state[key];
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
  switch (key) {
    case 'agc':
      return AGC_LABELS[value as string] ?? '—';
    case 'scopeLevel':
      return `${(value as number).toFixed(1)}dB`;
    case 'scopePeak':
      return `LV${value}`;
    case 'voxDelay':
    case 'breakInDelay':
      return `${delayMs(value as number)}ms`;
    case 'processorLevel':
      return state.processor ? String(value) : 'OFF';
    case 'monitorLevel':
      return state.monitor ? String(value) : 'OFF';
    default:
      return `${value}${UNITS[key] ?? ''}`;
  }
}
