import { describeScopeMode, scopeModeNumber, type ScopeModeInfo } from '@radiobench/protocol';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';
import { FilterDisplay, ReceiverSettings, StatusStrip } from './Bars.tsx';
import { Header } from './Header.tsx';
import { Meter } from './Meter.tsx';
import { ScopeView } from './ScopeView.tsx';
import { Screens } from './Screens.tsx';

const NEXT_PLACEMENT = { CENTER: 'CURSOR', CURSOR: 'FIX', FIX: 'CENTER' } as const;

/** The row of touch keys under the scope. */
function SoftKeys() {
  const { state, set } = useRadio();
  const { show, multi, setMulti } = useUi();
  const mode = state?.scopeMode ?? null;
  const info = mode === null ? null : describeScopeMode(mode);
  const change = (to: Partial<ScopeModeInfo>) => {
    if (info) set('scopeMode', scopeModeNumber({ ...info, ...to }));
  };

  return (
    <div className="soft-keys">
      <button
        type="button"
        disabled={!info}
        onClick={() => info && change({ placement: NEXT_PLACEMENT[info.placement] })}
      >
        {info?.placement ?? 'CENTER'}
      </button>
      <button
        type="button"
        disabled={!info}
        className={info?.view === '3DSS' ? 'soft-on' : ''}
        title="Switches the radio's own display between 3DSS and waterfall"
        onClick={() =>
          info && change({ view: info.view === '3DSS' ? 'waterfall' : '3DSS', expanded: false })
        }
      >
        3DSS
      </button>
      <button
        type="button"
        className={multi ? 'soft-on' : ''}
        title="Shows the audio oscilloscope and audio spectrum beside the scope, on this page only"
        onClick={() => setMulti(!multi)}
      >
        MULTI
      </button>
      <button
        type="button"
        disabled={!info || info.view === '3DSS'}
        className={info?.expanded ? 'soft-on' : ''}
        onClick={() => info && change({ expanded: !info.expanded })}
      >
        EXPAND
      </button>
      <button type="button" disabled={!info} onClick={() => show('span')}>
        SPAN
      </button>
      <button type="button" disabled={!info} onClick={() => show('speed')}>
        SPEED
      </button>
    </div>
  );
}

/** The radio's display, laid out as the FT-710 lays it out. */
export function Display() {
  const { state, request } = useRadio();
  const offline = !state
    ? 'Server unreachable — retrying'
    : state.link === 'connected'
      ? null
      : // While the link is retried, the reason the last try failed stays on show.
        (state.linkError ?? `Connecting to the radio${state.port ? ` on ${state.port}` : ''}…`);

  return (
    <div className="lcd">
      <div className="lcd-inner">
        <div className="lcd-top">
          <Meter />
          <Header />
        </div>
        <div className="lcd-mid">
          <ReceiverSettings />
          <FilterDisplay />
        </div>
        <StatusStrip />
        <ScopeView />
        <SoftKeys />
        <Screens />
        {offline ? (
          <div className="lcd-offline">
            <p>{offline}</p>
            {state ? (
              <button type="button" onClick={() => request({ type: 'power', on: true })}>
                SWITCH THE RADIO ON
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
