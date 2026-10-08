import { DigiPanel } from './digi/DigiPanel.tsx';
import { Display } from './display/Display.tsx';
import { LeftKeys, RightPanel } from './panel/FrontPanel.tsx';
import { RadioProvider, useRadio } from './radio.tsx';
import { UiProvider } from './ui.tsx';

function Rig() {
  const { state, error } = useRadio();
  const link = !state
    ? 'Server unreachable'
    : state.link === 'connected'
      ? `FT-710 on ${state.port}${state.firmware ? ` · firmware ${state.firmware}` : ''}`
      : (state.linkError ?? 'Connecting…');

  return (
    <main className="bench">
      <div className="rig">
        <header className="rig-brand">
          <b>RadioBench</b>
          <span>HF/50MHz TRANSCEIVER FT-710</span>
          <span className={`link ${state?.link === 'connected' ? 'link-up' : 'link-down'}`}>
            {link}
          </span>
        </header>
        <LeftKeys />
        <Display />
        <RightPanel />
      </div>
      <DigiPanel />
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </main>
  );
}

export function App() {
  return (
    <RadioProvider>
      <UiProvider>
        <Rig />
      </UiProvider>
    </RadioProvider>
  );
}
