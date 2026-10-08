import { DIGI_MODES, type DigiMode, type MenuScreen, type SettingKey } from '@radiobench/protocol';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Speaker,
  listOutputs,
  microphoneAllowed,
  openMicrophone,
  outputChoiceSupported,
  unlockOutputs,
  type OutputDevice,
} from './lib/sound.ts';
import { remember, remembered } from './lib/storage.ts';
import { useRadio } from './radio.tsx';

// Where this browser's preferences are kept between visits.
const OUTPUT_KEY = 'radiobench.output';
const DECODING_KEY = 'radiobench.decoding';
const DIGI_MODE_KEY = 'radiobench.digiMode';
const MY_CALL_KEY = 'radiobench.myCall';

/** The screens the radio's display puts up over its normal view. */
export type Screen =
  | 'mode'
  | 'band'
  | 'func'
  | 'keypad'
  | 'att'
  | 'ipo'
  | 'agc'
  | 'meter'
  | 'span'
  | 'speed'
  | 'dsp'
  | 'memory'
  | 'message'
  | 'menu'
  | 'power';

/** How long the [FUNC] knob keeps adjusting a level after [NB] or [DNR] was held. */
const LEVEL_ADJUST_MS = 3000;

/**
 * State of the front panel that lives in the page rather than in the radio: which screen
 * is up, what the two multi-purpose knobs are doing, and this browser's own audio.
 */
export interface PanelUi {
  screen: Screen | null;
  show(screen: Screen | null): void;
  /** Which of the setting screens the menu shows. */
  menuScreen: MenuScreen;
  showMenu(screen: MenuScreen): void;
  /** The level the [FUNC] knob adjusts for a few seconds, instead of its usual function. */
  levelAdjust: SettingKey | null;
  /** Starts, or keeps alive, the adjusting of a level with the [FUNC] knob. */
  adjustLevel(key: SettingKey): void;
  /** Whether the [STEP·MCH/DSP] knob adjusts its DSP function rather than stepping the VFO. */
  dspAdjust: boolean;
  setDspAdjust(active: boolean): void;
  /** Whether the scope shares the display with the audio oscilloscope and spectrum. */
  multi: boolean;
  setMulti(multi: boolean): void;

  /** Whether this browser is playing the radio's received audio. */
  listening: boolean;
  setListening(on: boolean): void;
  /** Loudness of the received audio in this browser, 0–1. */
  volume: number;
  setVolume(volume: number): void;
  /** The output devices this browser can play the radio on; empty where it cannot choose. */
  outputs: OutputDevice[];
  /** The chosen output device's id; "" is the browser's default. */
  output: string;
  setOutput(deviceId: string): void;
  /** Whether the browser could show its output devices but has not been allowed to yet. */
  outputsHidden: boolean;
  /** Asks the browser for the permission that makes it show its output devices. */
  findOutputs(): void;
  /** Why no sound is coming out, if the browser is holding it back. */
  listenProblem: string | null;
  /** Whether this browser's microphone is being sent to the radio. */
  talking: boolean;
  setTalking(on: boolean): void;
  /** Why the microphone cannot be used, if it cannot. */
  talkProblem: string | null;

  /** Whether this browser wants the FT8/FT4 decodes shown under the radio. */
  decoding: boolean;
  setDecoding(on: boolean): void;
  /** The digital mode this browser asked the server to decode. */
  digiMode: DigiMode;
  setDigiMode(mode: DigiMode): void;
  /** The operator's callsign, for picking out decodes meant for them; "" if not given. */
  myCall: string;
  setMyCall(call: string): void;
}

const UiContext = createContext<PanelUi | null>(null);

export function UiProvider({ children }: { children: ReactNode }) {
  const { audio, state, request, subscribeAudio, sendAudio } = useRadio();
  const [screen, show] = useState<Screen | null>(null);
  const [menuScreen, setMenuScreen] = useState<MenuScreen>('RADIO SETTING');
  const [levelAdjust, setLevelAdjust] = useState<SettingKey | null>(null);
  const [dspAdjust, setDspAdjust] = useState(false);
  const [multi, setMulti] = useState(false);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [outputs, setOutputs] = useState<OutputDevice[]>([]);
  const [output, setOutputState] = useState(() => remembered(OUTPUT_KEY) ?? '');
  const [listenProblem, setListenProblem] = useState<string | null>(null);
  const [talking, setTalking] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [decoding, setDecodingState] = useState(() => remembered(DECODING_KEY) === 'on');
  const [digiMode, setDigiModeState] = useState<DigiMode>(() => {
    const kept = remembered(DIGI_MODE_KEY);
    return (DIGI_MODES as readonly string[]).includes(kept ?? '') ? (kept as DigiMode) : 'FT8';
  });
  const [myCall, setMyCallState] = useState(() => remembered(MY_CALL_KEY) ?? '');
  const levelTimer = useRef<number | undefined>(undefined);
  const speaker = useRef<Speaker | null>(null);

  const setOutput = useCallback((deviceId: string) => {
    setOutputState(deviceId);
    remember(OUTPUT_KEY, deviceId);
  }, []);
  const setDecoding = useCallback((on: boolean) => {
    setDecodingState(on);
    remember(DECODING_KEY, on ? 'on' : 'off');
  }, []);
  const setDigiMode = useCallback((mode: DigiMode) => {
    setDigiModeState(mode);
    remember(DIGI_MODE_KEY, mode);
  }, []);
  const setMyCall = useCallback((call: string) => {
    const clean = call
      .toUpperCase()
      .replace(/[^A-Z0-9/]/g, '')
      .slice(0, 12);
    setMyCallState(clean);
    remember(MY_CALL_KEY, clean);
  }, []);

  const adjustLevel = useCallback((key: SettingKey) => {
    setLevelAdjust(key);
    window.clearTimeout(levelTimer.current);
    levelTimer.current = window.setTimeout(() => setLevelAdjust(null), LEVEL_ADJUST_MS);
  }, []);

  const showMenu = useCallback((menu: MenuScreen) => {
    setMenuScreen(menu);
    show('menu');
  }, []);

  // Received audio plays for as long as it is wanted and the server is there to send it.
  const serverUp = audio !== null;
  useEffect(() => {
    if (!listening || !serverUp) return;
    const player = new Speaker(volume);
    speaker.current = player;
    void player.setOutput(output).catch(() => setOutput(''));
    const unsubscribe = subscribeAudio((samples) => player.play(samples));
    request({ type: 'listen', on: true });
    // The browser may keep the sound back until the page has been clicked: let any click or
    // key press through to the player, and say so on the panel while that is still needed.
    const unblock = () => player.resume();
    document.addEventListener('pointerdown', unblock, true);
    document.addEventListener('keydown', unblock, true);
    const check = window.setInterval(
      () =>
        setListenProblem(
          player.running
            ? null
            : 'The browser is holding the sound back: click or tap anywhere on the page',
        ),
      500,
    );
    return () => {
      document.removeEventListener('pointerdown', unblock, true);
      document.removeEventListener('keydown', unblock, true);
      window.clearInterval(check);
      setListenProblem(null);
      request({ type: 'listen', on: false });
      unsubscribe();
      player.close();
      speaker.current = null;
    };
    // The volume and output device are left out on purpose: they are applied to the running
    // player below, not by starting a new one.
  }, [listening, serverUp, request, subscribeAudio]);

  useEffect(() => speaker.current?.setVolume(volume), [volume]);
  useEffect(() => {
    void speaker.current?.setOutput(output).catch(() => setOutput(''));
  }, [output, setOutput]);

  // The output devices to choose from, kept up to date as they come and go.
  useEffect(() => {
    if (!listening || !outputChoiceSupported()) return;
    const refresh = () => void listOutputs().then(setOutputs);
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh);
  }, [listening]);
  // The browser shows a nameless default at most until the page has had microphone permission.
  const outputsHidden =
    listening && outputChoiceSupported() && microphoneAllowed() && outputs.length <= 1;
  const findOutputs = useCallback(() => {
    unlockOutputs().then(setOutputs, () => {
      // Permission refused: the browser's default output it is.
    });
  }, []);

  // Decodes are asked for while wanted and the server is there; the mode goes along, and
  // a change of it is passed on at once.
  useEffect(() => {
    if (!decoding || !serverUp) return;
    request({ type: 'decode', on: true, mode: digiMode });
    return () => request({ type: 'decode', on: false });
  }, [decoding, serverUp, digiMode, request]);

  const canTalk = !!audio?.canTalk && !!state?.txEnabled;
  useEffect(() => {
    if (!talking || !canTalk) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    openMicrophone(sendAudio).then(
      (close) => {
        if (cancelled) close();
        else stop = close;
      },
      (error: unknown) => {
        setMicError(error instanceof Error ? error.message : String(error));
        setTalking(false);
      },
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [talking, canTalk, sendAudio]);

  const talkProblem = !audio
    ? 'The server cannot be reached'
    : !state?.txEnabled || !audio.canTalk
      ? 'Transmit controls are switched off on the server (RADIOBENCH_TX)'
      : !microphoneAllowed()
        ? 'Browsers only allow the microphone over https: open the https address the server prints'
        : micError;

  const ui = useMemo<PanelUi>(
    () => ({
      screen,
      show,
      menuScreen,
      showMenu,
      levelAdjust,
      adjustLevel,
      dspAdjust,
      setDspAdjust,
      multi,
      setMulti,
      listening,
      setListening,
      volume,
      setVolume,
      outputs,
      output,
      setOutput,
      outputsHidden,
      findOutputs,
      listenProblem,
      talking: talking && canTalk,
      setTalking: (on) => {
        setMicError(null);
        setTalking(on);
      },
      talkProblem,
      decoding,
      setDecoding,
      digiMode,
      setDigiMode,
      myCall,
      setMyCall,
    }),
    [
      screen,
      menuScreen,
      showMenu,
      levelAdjust,
      adjustLevel,
      dspAdjust,
      multi,
      listening,
      volume,
      outputs,
      output,
      setOutput,
      outputsHidden,
      findOutputs,
      listenProblem,
      talking,
      canTalk,
      talkProblem,
      decoding,
      setDecoding,
      digiMode,
      setDigiMode,
      myCall,
      setMyCall,
    ],
  );
  return <UiContext.Provider value={ui}>{children}</UiContext.Provider>;
}

export function useUi(): PanelUi {
  const ui = useContext(UiContext);
  if (!ui) throw new Error('useUi needs a UiProvider above it');
  return ui;
}
