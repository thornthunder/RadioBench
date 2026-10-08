import { CONTROLS, type SettingKey } from '@radiobench/protocol';
import {
  DSP_TARGETS,
  FUNC_TARGETS,
  dialStepHz,
  mainFrequencyKey,
  useNudge,
} from '../lib/controls.ts';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';
import { Key } from './Key.tsx';
import { Knob } from './Knob.tsx';

const NEXT_CLAR = { off: 'rx', rx: 'tx', tx: 'rxtx', rxtx: 'off' } as const;
/** The filters that switch on when the knob starts adjusting them. */
const DSP_SWITCHES = { NOTCH: 'manualNotch', CONTOUR: 'contour', APF: 'apf' } as const;

// Colours of the ring around the main dial, as the radio leaves the factory.
const RING_VFO_A = '#3d8bff';
const RING_VFO_B = '#35c46a';
const RING_MEMORY = '#f2f4f8';
const RING_OFFSET = '#ff4d4d';

/** The keys down the left edge of the radio. */
export function LeftKeys() {
  const { state, audio, set, act } = useRadio();
  const ui = useUi();
  const off = state?.link !== 'connected';
  const noTx = 'Transmit controls are switched off on the server (RADIOBENCH_TX)';
  const txOff = !state?.txEnabled;

  return (
    <div className="left-keys">
      <Key
        disabled={off}
        lit={state?.lock ? 'orange' : false}
        onPress={() => set('lock', !state?.lock)}
        onHold={() => ui.show('power')}
        title="Locks the dial and the STEP knob; hold to switch the radio off"
      >
        LOCK
      </Key>
      <Key
        disabled={off}
        lit={state?.tuning ? 'red' : state?.tuner ? 'orange' : false}
        onPress={() => set('tuner', !state?.tuner)}
        onHold={() => act('tuneStart')}
        title={
          txOff
            ? `Antenna tuner on/off. Holding it starts tuning, which transmits. ${noTx}`
            : 'Antenna tuner on/off; hold to start tuning (transmits)'
        }
      >
        TUNE
      </Key>
      <div className="key-pair">
        <Key
          disabled={off}
          lit={state?.vox ? 'orange' : false}
          onPress={() => set('vox', !state?.vox)}
          title={txOff ? noTx : 'Voice-operated transmit'}
        >
          VOX
        </Key>
        <Key
          disabled={off}
          lit={state?.mox ? 'red' : false}
          onPress={() => set('mox', !state?.mox)}
          title={txOff ? noTx : 'Keys the transmitter until pressed again'}
        >
          MOX
        </Key>
      </div>
      <button
        type="button"
        className={`jack ${ui.listening ? 'jack-on' : ''}`}
        disabled={!audio || audio.status === 'off'}
        title={
          audio?.status === 'unavailable'
            ? (audio.detail ?? 'Audio is unavailable')
            : 'Listen to the radio in this browser'
        }
        onClick={() => ui.setListening(!ui.listening)}
      >
        PHONES
      </button>
      {ui.listening ? (
        <div className="listen-controls">
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={ui.volume}
            aria-label="Volume in this browser"
            onChange={(event) => ui.setVolume(Number(event.target.value))}
          />
          {ui.outputs.length > 1 ? (
            <select
              className="output"
              value={ui.output}
              aria-label="Where this browser plays the radio"
              title="Where this browser plays the radio. Not the radio's own USB Audio Device."
              onChange={(event) => ui.setOutput(event.target.value)}
            >
              <option value="">Default output</option>
              {ui.outputs
                .filter((device) => device.deviceId !== 'default' && device.deviceId !== '')
                .map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </option>
                ))}
            </select>
          ) : ui.outputsHidden ? (
            <button
              type="button"
              className="output-find"
              title="The browser shows its output devices only once the page may use the microphone"
              onClick={ui.findOutputs}
            >
              Choose output…
            </button>
          ) : null}
          {ui.listenProblem ? <p className="listen-problem">{ui.listenProblem}</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        className={`jack jack-mic ${ui.talking ? (audio?.talking ? 'jack-on' : 'jack-waiting') : ''}`}
        disabled={ui.talkProblem !== null}
        title={
          ui.talkProblem ??
          (ui.talking
            ? audio?.talking
              ? 'The radio is receiving this microphone'
              : 'Waiting for the radio to take the microphone'
            : "Send this browser's microphone to the radio")
        }
        onClick={() => ui.setTalking(!ui.talking)}
      >
        MIC
      </button>
    </div>
  );
}

/** Everything to the right of the display: the keys, the knobs and the main dial. */
export function RightPanel() {
  const { state, set, act } = useRadio();
  const ui = useUi();
  const nudge = useNudge();
  const off = state?.link !== 'connected';

  /** Turns a setting by knob clicks, each click being one step of that setting. */
  const turn = (key: SettingKey | undefined | null, clicks: number, stepsPerClick = 1) => {
    if (!key) return;
    const spec = CONTROLS[key];
    if (spec.kind === 'number') nudge(key, clicks * stepsPerClick * spec.step);
  };

  const turnDial = (clicks: number) => {
    if (!state || state.lock) return;
    // With the clarifier on, the dial sets its offset instead of the frequency.
    if (state.clar && state.clar !== 'off') {
      nudge('clarOffsetHz', clicks * (state.fineTuning === 'fine' ? 1 : 10));
    } else nudge(mainFrequencyKey(state), clicks * dialStepHz(state));
  };

  const turnFunc = (clicks: number) => {
    if (!state) return;
    if (ui.levelAdjust) {
      ui.adjustLevel(ui.levelAdjust);
      turn(ui.levelAdjust, clicks);
    } else turn(state.funcKnob ? FUNC_TARGETS[state.funcKnob] : null, clicks);
  };

  const turnStep = (clicks: number) => {
    if (!state || state.lock) return;
    if (ui.dspAdjust && state.dspKnob) {
      const power = DSP_SWITCHES[state.dspKnob as keyof typeof DSP_SWITCHES];
      if (power && !state[power]) set(power, true);
      turn(DSP_TARGETS[state.dspKnob], clicks);
    } else if (state.vfoState === 'memory') {
      act(clicks > 0 ? 'channelUp' : 'channelDown');
    } else nudge(mainFrequencyKey(state), clicks * (state.channelStepHz ?? 5000));
  };

  const squelch = state?.rfSqlKnob === 'SQL';
  const ring =
    state?.split || (state?.clar && state.clar !== 'off')
      ? RING_OFFSET
      : state?.vfoState && state.vfoState !== 'vfo'
        ? RING_MEMORY
        : state?.mainVfo === 'B'
          ? RING_VFO_B
          : RING_VFO_A;

  return (
    <div className="right-panel">
      <div className="key-row key-row-top">
        <Key disabled={off} onPress={() => ui.show(ui.screen === 'mode' ? null : 'mode')}>
          MODE
        </Key>
        <Key
          disabled={off}
          lit={state?.cwSpot ? 'orange' : false}
          onPress={() => act('zeroIn')}
          onHold={() => set('cwSpot', true)}
          onRelease={() => set('cwSpot', false)}
          title="Press to zero in on a CW signal; hold for the spot tone"
        >
          ZIN/SPOT
        </Key>
        <Key
          disabled={off}
          lit={state?.split ? 'orange' : false}
          onPress={() => set('split', !state?.split)}
        >
          SPLIT
        </Key>
        <Key
          disabled={off}
          lit={state?.clar && state.clar !== 'off' ? 'red' : false}
          onPress={() => set('clar', NEXT_CLAR[state?.clar ?? 'off'])}
          onHold={() => act('clarClear')}
          title="Clarifier: RX, TX, both, off; hold to clear the offset"
        >
          CLAR
        </Key>
        <Key
          disabled={off}
          lit={state?.noiseBlanker ? 'orange' : false}
          onPress={() => set('noiseBlanker', !state?.noiseBlanker)}
          onHold={() => ui.adjustLevel('noiseBlankerLevel')}
          title="Noise blanker; hold, then turn FUNC for its level"
        >
          NB
        </Key>
      </div>

      <div className="key-row">
        <Key disabled={off} onPress={() => act('memoryToVfo')}>
          M►V
        </Key>
        <Key
          disabled={off}
          lit={state?.vfoState === 'memory'}
          onPress={() => act('vfoMemory')}
          onHold={() => ui.show('memory')}
          title="VFO or memory; hold for the memory channels"
        >
          V/M
        </Key>
        <Key
          disabled={off}
          onPress={() => act('swapVfo')}
          onHold={() => act('copyMainToSub')}
          title="Swap VFO-A and VFO-B; hold to copy the upper one to the lower"
        >
          A/B
        </Key>
        <Key disabled={off} onPress={() => ui.show(ui.screen === 'band' ? null : 'band')}>
          BAND
        </Key>
        <Key
          disabled={off}
          lit={state?.vfoState === 'qmb'}
          onPress={() => act('qmbRecall')}
          onHold={() => act('qmbStore')}
          title="Recall a quick memory; hold to store one"
        >
          QMB
        </Key>
      </div>

      <div className="controls-grid">
        <div className="at-func">
          <Knob
            label="FUNC"
            disabled={off}
            onTurn={turnFunc}
            onPress={() => ui.show(ui.screen === 'func' ? null : 'func')}
          />
        </div>
        <div className="at-dnr">
          <Key
            disabled={off}
            lit={state?.noiseReduction ? 'orange' : false}
            onPress={() => set('noiseReduction', !state?.noiseReduction)}
            onHold={() => ui.adjustLevel('noiseReductionLevel')}
            title="Digital noise reduction; hold, then turn FUNC for its level"
          >
            DNR
          </Key>
        </div>
        <div className="at-led">
          <span
            className={`busy-tx ${state?.transmitting ? 'busy-tx-tx' : state?.busy ? 'busy-tx-busy' : ''}`}
          />
          BUSY/TX
        </div>
        <div className="at-nar">
          <Key
            disabled={off}
            lit={state?.narrow ? 'orange' : false}
            onPress={() => set('narrow', !state?.narrow)}
          >
            NAR
          </Key>
        </div>
        <div className="at-rf">
          <Knob
            label="RF GAIN/SQL"
            disabled={off}
            position={
              state ? (squelch ? (state.squelch ?? 0) / 100 : (state.rfGain ?? 0) / 255) : null
            }
            readout={
              state
                ? `${squelch ? 'SQL' : 'RF'} ${squelch ? (state.squelch ?? '—') : (state.rfGain ?? '—')}`
                : ''
            }
            onTurn={(clicks) => turn(squelch ? 'squelch' : 'rfGain', clicks, squelch ? 2 : 5)}
          />
        </div>

        <div className="at-dial">
          <Knob
            label=""
            size="dial"
            disabled={off}
            degreesPerClick={3.6}
            ring={ring}
            onTurn={turnDial}
          />
        </div>

        <div className="at-step">
          <Knob
            label={
              <>
                STEP·MCH/<b>DSP</b>
              </>
            }
            lit={ui.dspAdjust}
            disabled={off}
            readout={ui.dspAdjust ? (state?.dspKnob ?? '') : ''}
            onTurn={turnStep}
            onPress={() => ui.show(ui.screen === 'dsp' ? null : 'dsp')}
          />
        </div>
        <div className="at-af">
          <Knob
            label="AF GAIN"
            disabled={off}
            position={state ? (state.afGain ?? 0) / 255 : null}
            readout={state?.afGain ?? ''}
            onTurn={(clicks) => turn('afGain', clicks, 4)}
          />
        </div>
        <div className="at-reset">
          <Key
            disabled={off}
            onPress={() => ui.setDspAdjust(false)}
            onHold={() => act('dspReset')}
            title="Ends adjusting with the DSP knob; hold to reset shift, width, notch, contour and APF"
          >
            DSP RESET
          </Key>
        </div>
        <div className="at-fine">
          <Key
            disabled={off}
            lit={state?.fineTuning && state.fineTuning !== 'off' ? 'orange' : false}
            onPress={() => set('fineTuning', state?.fineTuning === 'fine' ? 'off' : 'fine')}
            onHold={() => set('fineTuning', state?.fineTuning === 'fast' ? 'off' : 'fast')}
            title="Fine tuning; hold for fast tuning"
          >
            FINE/FAST
          </Key>
        </div>
      </div>
    </div>
  );
}
