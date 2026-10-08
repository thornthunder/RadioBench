import type { RadioState } from '@radiobench/protocol';
import { formatFrequency, mainFrequency, settingText, subFrequency } from '../lib/controls.ts';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';

/** What the radio shows where "VFO-A" stands: the VFO, or the kind of memory in use. */
function sourceLabel(state: RadioState): string {
  switch (state.vfoState) {
    case 'memory':
      return `M-${state.memoryChannel?.slice(1) ?? '--'}`;
    case 'memory-tune':
      return 'MT';
    case 'qmb':
      return 'QMB';
    case 'pms':
      return `M-${state.memoryChannel ?? 'P'}`;
    default:
      return `VFO-${state.mainVfo ?? 'A'}`;
  }
}

const CLAR_LABELS = { off: '', rx: 'CLAR RX', tx: 'CLAR TX', rxtx: 'CLAR RXTX' };

/** The top of the display: both frequencies with their modes, and the [FUNC] knob's function. */
export function Header() {
  const { state } = useRadio();
  const { show, levelAdjust } = useUi();
  if (!state) return <div className="lcd-header" />;

  const main = mainFrequency(state);
  const sub = subFrequency(state);
  const clar = state.clar ?? 'off';
  const offset = state.clarOffsetHz ?? 0;
  // While a level is being adjusted with the knob, the radio shows that level here.
  const funcLabel = levelAdjust
    ? `${levelAdjust === 'noiseBlankerLevel' ? 'NB' : 'DNR'} LEVEL ${settingText(levelAdjust, state)}`
    : state.funcKnob === 'NONE' || state.funcKnob === null
      ? ''
      : state.funcKnob;

  return (
    <div className="lcd-header">
      <div className="vfo-tags">
        <span className="tag">{sourceLabel(state)}</span>
        <button
          type="button"
          className="tag tag-mode"
          onClick={() => show('mode')}
          title="Choose the mode"
        >
          {state.modeMain ?? '---'}
        </button>
        <span className="tag tag-dim">VFO-{state.mainVfo === 'B' ? 'A' : 'B'}</span>
        <span className="tag tag-mode tag-sub">{state.modeSub ?? '---'}</span>
      </div>
      <div className="vfo-frequencies">
        <button
          type="button"
          className={`frequency-main ${state.transmitting ? 'frequency-tx' : ''}`}
          onClick={() => show('keypad')}
          title="Enter a frequency"
        >
          {main === null ? '--.---.---' : formatFrequency(main)}
        </button>
        <div className="vfo-second-row">
          <span className="vfo-flags">
            {state.lock ? <b className="flag flag-red">LOCK</b> : null}
            {state.split ? <b className="flag flag-red">SPLIT</b> : null}
            {state.fineTuning === 'fine' ? <b className="flag">FINE</b> : null}
            {state.fineTuning === 'fast' ? <b className="flag">FAST</b> : null}
            {state.narrow ? <b className="flag">NAR</b> : null}
          </span>
          {clar === 'off' ? (
            <span className="frequency-sub">
              {sub === null ? '--.---.---' : formatFrequency(sub)}
            </span>
          ) : (
            <span className="frequency-sub frequency-clar">
              <b>{CLAR_LABELS[clar]}</b> {offset >= 0 ? '+' : '-'}
              {Math.abs(offset)}Hz
            </span>
          )}
          <button
            type="button"
            className="func-box"
            onClick={() => show('func')}
            title="Functions of the FUNC knob"
          >
            {funcLabel || 'FUNC'}
          </button>
        </div>
      </div>
    </div>
  );
}
