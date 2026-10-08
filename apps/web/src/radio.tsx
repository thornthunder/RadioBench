import {
  DIGI_BATCHES_KEPT,
  RX_AUDIO_KIND,
  TX_AUDIO_KIND,
  WS_PATH,
  decodeAudio,
  decodeScopeFrame,
  encodeAudio,
  type Action,
  type AudioState,
  type ClientMessage,
  type DecodeBatch,
  type DecoderState,
  type MemoryChannel,
  type RadioState,
  type ScopeFrame,
  type ScopeState,
  type ServerMessage,
  type SettingKey,
  type SettingValue,
} from '@radiobench/protocol';
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

const RECONNECT_DELAY_MS = 1500;
const ERROR_SHOWN_MS = 6000;

type ScopeListener = (frame: ScopeFrame) => void;
type AudioListener = (samples: Uint8Array) => void;

export interface RadioApi {
  /** Latest state from the server; null while the server cannot be reached. */
  state: RadioState | null;
  /** State of the spectrum scope; null while the server cannot be reached. */
  scope: ScopeState | null;
  /** State of the radio's audio; null while the server cannot be reached. */
  audio: AudioState | null;
  /** State of the FT8/FT4 decoder; null while the server cannot be reached. */
  decoder: DecoderState | null;
  /** Decodes of the last slots, oldest first, once they have been asked for. */
  decodes: DecodeBatch[];
  /** Menu values read so far: the characters of the radio's reply, by menu item id. */
  menu: Record<string, string>;
  /** The memory channels in use; null until they have been asked for. */
  memories: MemoryChannel[] | null;
  /** The CW text memories; null until they have been asked for. */
  messages: string[] | null;
  /** Why the last command this client sent failed, for a few seconds after it did. */
  error: string | null;
  set<K extends SettingKey>(key: K, value: SettingValue<K>): void;
  act(action: Action, value?: number): void;
  /** Sends any other command. */
  request(message: ClientMessage): void;
  /**
   * Calls the listener with every scope sweep; returns a function that unsubscribes it.
   * Sweeps arrive about 30 times a second, so they bypass React state.
   */
  subscribeScope(listener: ScopeListener): () => void;
  /** Calls the listener with received audio, once the server has been asked to send it. */
  subscribeAudio(listener: AudioListener): () => void;
  /** Sends microphone audio to the radio: 16-bit samples at the protocol's rate. */
  sendAudio(samples: Int16Array): void;
}

const RadioContext = createContext<RadioApi | null>(null);

/** Keeps a WebSocket open to the RadioBench server, reconnecting whenever it drops. */
export function RadioProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RadioState | null>(null);
  const [scope, setScope] = useState<ScopeState | null>(null);
  const [audio, setAudio] = useState<AudioState | null>(null);
  const [decoder, setDecoder] = useState<DecoderState | null>(null);
  const [decodes, setDecodes] = useState<DecodeBatch[]>([]);
  const [menu, setMenu] = useState<Record<string, string>>({});
  const [memories, setMemories] = useState<MemoryChannel[] | null>(null);
  const [messages, setMessages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const scopeListeners = useRef(new Set<ScopeListener>());
  const audioListeners = useRef(new Set<AudioListener>());

  useEffect(() => {
    let disposed = false;
    let retry: number | undefined;

    const receive = (message: ServerMessage) => {
      switch (message.type) {
        case 'state':
          return setState(message.state);
        case 'patch':
          return setState((current) => (current ? { ...current, ...message.patch } : current));
        case 'scope':
          return setScope(message.scope);
        case 'audio':
          return setAudio(message.audio);
        case 'decoder':
          return setDecoder(message.decoder);
        case 'decodes':
          // The server's recent slots may repeat ones already here: one entry per slot.
          return setDecodes((current) => {
            const bySlot = new Map(
              current.map((batch) => [`${batch.mode}@${batch.slotStart}`, batch]),
            );
            for (const batch of message.batches)
              bySlot.set(`${batch.mode}@${batch.slotStart}`, batch);
            return [...bySlot.values()]
              .sort((a, b) => a.slotStart - b.slotStart)
              .slice(-DIGI_BATCHES_KEPT);
          });
        case 'menu':
          return setMenu((current) => ({ ...current, ...message.values }));
        case 'memories':
          return setMemories(message.channels);
        case 'messages':
          return setMessages(message.texts);
        case 'error':
          return setError(message.message);
      }
    };

    const connect = () => {
      // Relative to the page, so that a reverse proxy may serve it under a path of its own.
      const url = new URL(WS_PATH.replace(/^\//, ''), document.baseURI);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
        if (typeof event.data === 'string') {
          receive(JSON.parse(event.data) as ServerMessage);
          return;
        }
        const samples = decodeAudio(RX_AUDIO_KIND, event.data);
        if (samples) {
          for (const listener of audioListeners.current) listener(samples);
          return;
        }
        const frame = decodeScopeFrame(event.data);
        if (frame) for (const listener of scopeListeners.current) listener(frame);
      };
      socket.onclose = () => {
        if (disposed) return;
        setState(null);
        setScope(null);
        setAudio(null);
        retry = window.setTimeout(connect, RECONNECT_DELAY_MS);
      };
    };
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), ERROR_SHOWN_MS);
    return () => window.clearTimeout(timer);
  }, [error]);

  // The functions below keep their identity for the life of the page, so that effects which
  // depend on them (the scope's drawing loop, for one) are not restarted by every change of state.
  const request = useCallback((message: ClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);
  const set = useCallback<RadioApi['set']>(
    (key, value) => request({ type: 'set', key, value }),
    [request],
  );
  const act = useCallback<RadioApi['act']>(
    (action, value) =>
      request({ type: 'action', action, ...(value === undefined ? {} : { value }) }),
    [request],
  );
  const subscribeScope = useCallback<RadioApi['subscribeScope']>((listener) => {
    scopeListeners.current.add(listener);
    return () => {
      scopeListeners.current.delete(listener);
    };
  }, []);
  const subscribeAudio = useCallback<RadioApi['subscribeAudio']>((listener) => {
    audioListeners.current.add(listener);
    return () => {
      audioListeners.current.delete(listener);
    };
  }, []);
  const sendAudio = useCallback((samples: Int16Array) => {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return;
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    // The frame is a fresh array that fills its buffer, so the buffer is the frame.
    socket.send(encodeAudio(TX_AUDIO_KIND, bytes).buffer as ArrayBuffer);
  }, []);

  const api = useMemo<RadioApi>(
    () => ({
      state,
      scope,
      audio,
      decoder,
      decodes,
      menu,
      memories,
      messages,
      error,
      set,
      act,
      request,
      subscribeScope,
      subscribeAudio,
      sendAudio,
    }),
    [
      state,
      scope,
      audio,
      decoder,
      decodes,
      menu,
      memories,
      messages,
      error,
      set,
      act,
      request,
      subscribeScope,
      subscribeAudio,
      sendAudio,
    ],
  );

  return <RadioContext.Provider value={api}>{children}</RadioContext.Provider>;
}

export function useRadio(): RadioApi {
  const api = useContext(RadioContext);
  if (!api) throw new Error('useRadio needs a RadioProvider above it');
  return api;
}
