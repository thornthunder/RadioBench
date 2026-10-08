import { SCOPE_SPANS_HZ, describeScopeMode, widthHz, type RadioState } from '@radiobench/protocol';
import { settingText } from '../lib/controls.ts';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';

/** The four settings the radio keeps on show: touch one to change it. */
export function ReceiverSettings() {
  const { state, set } = useRadio();
  const { show } = useUi();
  const text = (key: 'attenuator' | 'preamp' | 'autoNotch' | 'agc') =>
    state ? settingText(key, state) : '—';

  return (
    <div className="settings-boxes">
      <button type="button" onClick={() => show('att')}>
        <span>ATT</span>
        {text('attenuator')}
      </button>
      <button type="button" onClick={() => show('ipo')}>
        <span>IPO</span>
        {text('preamp')}
      </button>
      <button type="button" onClick={() => state && set('autoNotch', !state.autoNotch)}>
        <span>DNF</span>
        {text('autoNotch')}
      </button>
      <button type="button" onClick={() => show('agc')}>
        <span>AGC</span>
        {text('agc')}
      </button>
    </div>
  );
}

/** The widest passband the drawing has room for. */
const FULL_WIDTH_HZ = 4000;

/**
 * The radio's picture of the receive filter: the passband as set by WIDTH and SHIFT, with
 * the manual notch and the contour or APF marked in it. Touch it for the DSP functions.
 */
export function FilterDisplay() {
  const { state } = useRadio();
  const { show } = useUi();
  if (!state?.modeMain) return <div className="filter-display" />;

  const width = widthHz(state.modeMain, state.width ?? 0);
  const half = Math.max(3, Math.min(1, width / FULL_WIDTH_HZ) * 34);
  const centre = 50 + ((state.ifShiftHz ?? 0) / 1200) * 12;
  const left = centre - half;
  const right = centre + half;
  // Positions of the notch and contour within the passband, by their audio frequency.
  const within = (hz: number) => left + Math.min(1, hz / Math.max(width, 1)) * (right - left);

  return (
    <button
      type="button"
      className="filter-display"
      onClick={() => show('dsp')}
      title="DSP functions"
    >
      <svg viewBox="0 0 100 26" preserveAspectRatio="none" aria-label="Filter passband">
        <line x1="0" y1="23" x2="100" y2="23" className="filter-base" />
        <path
          d={`M ${left - 4} 23 L ${left} 5 L ${right} 5 L ${right + 4} 23 Z`}
          className="filter-band"
        />
        {state.manualNotch && state.manualNotchHz !== null ? (
          <path
            d={`M ${within(state.manualNotchHz) - 2.5} 5 L ${within(state.manualNotchHz)} 20 L ${within(state.manualNotchHz) + 2.5} 5`}
            className="filter-notch"
          />
        ) : null}
        {state.contour && state.contourHz !== null ? (
          <path
            d={`M ${within(state.contourHz) - 5} 5 Q ${within(state.contourHz)} 16 ${within(state.contourHz) + 5} 5`}
            className="filter-contour"
          />
        ) : null}
        {state.apf ? (
          <path
            d={`M ${centre - 3} 5 L ${centre} 0 L ${centre + 3} 5`}
            className="filter-contour"
          />
        ) : null}
      </svg>
      <span className="filter-width">{width}Hz</span>
    </button>
  );
}

function scopeSummary(state: RadioState): string {
  if (state.scopeMode === null || state.scopeSpan === null) return '';
  const span = SCOPE_SPANS_HZ[state.scopeSpan] ?? 0;
  const spanText = span >= 1_000_000 ? `${span / 1_000_000}MHz` : `${span / 1000}kHz`;
  return `${describeScopeMode(state.scopeMode).placement} ${state.scopeSpeed ?? ''} SPAN ${spanText}`;
}

/** The row of indicators above the scope: what is switched on, and how the scope is set. */
export function StatusStrip() {
  const { state } = useRadio();
  const icon = (label: string, active: boolean | null | undefined, blink = false) => (
    <span className={`icon ${active ? 'icon-on' : ''} ${blink ? 'icon-blink' : ''}`}>{label}</span>
  );

  return (
    <div className="status-strip">
      <div className="icons">
        {icon('PROC', state?.processor)}
        {icon('KEYER', state?.keyer)}
        {icon('MONI', state?.monitor)}
        {icon('TUNE', state?.tuner, state?.tuning)}
        {icon('BK-IN', state?.breakIn)}
        {icon(
          state?.repeaterShift === 'minus' ? '−' : '+',
          !!state && state.repeaterShift !== 'simplex' && state.repeaterShift !== null,
        )}
        {icon(state?.ctcss === 'enc' ? 'ENC' : 'TSQ', !!state?.ctcss && state.ctcss !== 'off')}
        {icon('DNF', state?.autoNotch)}
        {icon('NB', state?.noiseBlanker)}
        {icon('DNR', state?.noiseReduction)}
      </div>
      <div className="scope-summary">{state ? scopeSummary(state) : ''}</div>
    </div>
  );
}
