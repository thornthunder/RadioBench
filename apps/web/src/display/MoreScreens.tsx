import {
  CW_MESSAGES,
  CW_MESSAGE_LENGTH,
  MEMORY_CHANNELS,
  MEMORY_TAG_LENGTH,
  MENU,
  MENU_SCREENS,
  VOICE_MEMORIES,
  decodeMenuValue,
  menuValueText,
  type MenuItem,
} from '@radiobench/protocol';
import { useEffect, useMemo, useState } from 'react';
import { formatFrequency } from '../lib/controls.ts';
import { useRadio } from '../radio.tsx';
import { useUi } from '../ui.tsx';
import { ScreenFrame } from './Screens.tsx';

const channelName = (number: number) => String(number).padStart(3, '0');
const numbered = (count: number) => Array.from({ length: count }, (_, index) => index + 1);

/** The memory channels: recall one, store the VFO in one, name one, and scan. */
export function MemoryScreen() {
  const { memories, request, act } = useRadio();
  const { show } = useUi();
  const [selected, setSelected] = useState<string | null>(null);
  const [storeIn, setStoreIn] = useState<number | null>(null);
  const [name, setName] = useState('');

  useEffect(() => request({ type: 'memoryList' }), [request]);

  // Where the VFO is stored unless told otherwise: the lowest channel not yet in use.
  const firstFree = useMemo(() => {
    const used = new Set(memories?.map((memory) => memory.channel));
    return numbered(MEMORY_CHANNELS).find((number) => !used.has(channelName(number))) ?? 1;
  }, [memories]);
  const storeChannel = storeIn ?? firstFree;

  return (
    <ScreenFrame title="MEMORY" full>
      <div className="memory">
        <ul className="memory-list">
          {memories === null ? <li>Reading the memory channels…</li> : null}
          {memories?.length === 0 ? <li>No memory channel is in use.</li> : null}
          {memories?.map((memory) => (
            <li key={memory.channel}>
              <button
                type="button"
                className={selected === memory.channel ? 'chosen' : ''}
                onClick={() => {
                  setSelected(memory.channel);
                  setName(memory.tag);
                  setStoreIn(Number(memory.channel));
                }}
              >
                <b>{memory.channel}</b>
                <span>{formatFrequency(memory.frequencyHz)}</span>
                <span>{memory.mode}</span>
                <span>{memory.tag}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="memory-actions">
          <button
            type="button"
            disabled={!selected}
            onClick={() => {
              if (selected) request({ type: 'memoryRecall', channel: selected });
              show(null);
            }}
          >
            RECALL
          </button>
          <label>
            CH
            <input
              type="number"
              min={1}
              max={MEMORY_CHANNELS}
              value={storeChannel}
              onChange={(event) => setStoreIn(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            disabled={!(storeChannel >= 1 && storeChannel <= MEMORY_CHANNELS)}
            title="Stores the frequency and mode of the upper VFO in this channel"
            onClick={() => request({ type: 'memoryStore', channel: channelName(storeChannel) })}
          >
            STORE VFO
          </button>
          <input
            value={name}
            maxLength={MEMORY_TAG_LENGTH}
            placeholder="NAME"
            aria-label="Name of the selected channel"
            onChange={(event) => setName(event.target.value.replaceAll(';', ''))}
          />
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && request({ type: 'memoryTag', channel: selected, tag: name })}
          >
            SET NAME
          </button>
          <span className="memory-scan">
            <button type="button" onClick={() => act('scanUp')}>
              SCAN ▲
            </button>
            <button type="button" onClick={() => act('scanDown')}>
              SCAN ▼
            </button>
            <button type="button" onClick={() => act('scanStop')}>
              STOP
            </button>
          </span>
        </div>
      </div>
    </ScreenFrame>
  );
}

/** The CW text memories and the voice memories: edit, send, play, and record what is received. */
export function MessageScreen() {
  const { messages, state, request } = useRadio();
  const [drafts, setDrafts] = useState<Record<number, string>>({});

  useEffect(() => request({ type: 'messageList' }), [request]);

  return (
    <ScreenFrame title="MESSAGE" full>
      <div className="messages">
        {numbered(CW_MESSAGES).map((number) => {
          const stored = messages?.[number - 1] ?? '';
          const text = drafts[number] ?? stored;
          return (
            <div key={number} className="message-row">
              <b>CW {number}</b>
              <input
                value={text}
                maxLength={CW_MESSAGE_LENGTH}
                aria-label={`CW text memory ${number}`}
                onChange={(event) => {
                  // What Morse has signs for, in capitals as the radio keeps it.
                  const typed = event.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9 !"#$%&'()*+,\-./:<=>?@[\\\]^_]/g, '');
                  setDrafts((current) => ({ ...current, [number]: typed }));
                }}
              />
              <button
                type="button"
                disabled={text === stored || text === ''}
                title={
                  text === '' ? 'The radio cannot be given an empty text from a PC' : undefined
                }
                onClick={() => {
                  request({ type: 'messageStore', number, text });
                  setDrafts(({ [number]: _saved, ...rest }) => rest);
                }}
              >
                SAVE
              </button>
              <button
                type="button"
                title="Sends this text in CW. The radio transmits."
                onClick={() => request({ type: 'messagePlay', number })}
              >
                SEND
              </button>
            </div>
          );
        })}
        <div className="message-row message-voice">
          <b>VOICE</b>
          {numbered(VOICE_MEMORIES).map((number) => (
            <button
              key={number}
              type="button"
              title="Plays this voice memory. The radio transmits."
              onClick={() => request({ type: 'voicePlay', number })}
            >
              PLAY {number}
            </button>
          ))}
          <button
            type="button"
            className="chosen"
            onClick={() => {
              request({ type: 'messagePlay', number: 0 });
              request({ type: 'voicePlay', number: 0 });
            }}
          >
            STOP
          </button>
          <button
            type="button"
            className={state?.recording ? 'recording' : ''}
            title="Records the received audio on the radio's SD card"
            onClick={() => request({ type: 'record', on: !state?.recording })}
          >
            {state?.recording ? 'RECORDING' : 'RECORD'}
          </button>
        </div>
      </div>
    </ScreenFrame>
  );
}

/** One menu item with the control that changes it. */
function MenuRow({ item, raw }: { item: MenuItem; raw: string | undefined }) {
  const { request } = useRadio();
  const value = raw === undefined ? null : decodeMenuValue(item, raw);
  const [draft, setDraft] = useState<string | null>(null);
  const set = (next: number | string) => request({ type: 'menuSet', id: item.id, value: next });
  const spec = item.value;

  let control;
  if (value === null) {
    control = <span className="menu-unknown">{raw === undefined ? '…' : raw}</span>;
  } else if (spec.kind === 'choice') {
    control = (
      <select
        value={value}
        onChange={(event) => set(Number(event.target.value))}
        aria-label={item.name}
      >
        {spec.options.map((label, index) =>
          label === '' ? null : (
            <option key={index} value={index}>
              {label}
            </option>
          ),
        )}
      </select>
    );
  } else if (spec.kind === 'number') {
    const step = (clicks: number) => {
      const next = Math.min(spec.max, Math.max(spec.min, Number(value) + clicks * spec.step));
      // Steps of a tenth must not pick up binary fractions on the way.
      set(Number(next.toFixed(3)));
    };
    control = (
      <span className="menu-stepper">
        <button type="button" onClick={() => step(-1)} aria-label={`${item.name} down`}>
          −
        </button>
        <output>{menuValueText(item, value)}</output>
        <button type="button" onClick={() => step(1)} aria-label={`${item.name} up`}>
          +
        </button>
      </span>
    );
  } else {
    const text = draft ?? String(value);
    control = (
      <span className="menu-stepper">
        <input
          value={text}
          maxLength={spec.maxLength}
          aria-label={item.name}
          onChange={(event) => setDraft(event.target.value.replaceAll(';', ''))}
        />
        <button
          type="button"
          disabled={draft === null || draft === String(value)}
          onClick={() => {
            set(text);
            setDraft(null);
          }}
        >
          SET
        </button>
      </span>
    );
  }

  return (
    <li>
      <span>{item.name}</span>
      {control}
    </li>
  );
}

/** The radio's setting screens: RADIO, CW, OPERATION and DISPLAY SETTING, and the presets. */
export function SettingsScreen() {
  const { menu, request, act } = useRadio();
  const { menuScreen, showMenu } = useUi();
  const [chosenGroup, setChosenGroup] = useState<string | null>(null);

  const groups = useMemo(
    () => [...new Set(MENU.filter((item) => item.screen === menuScreen).map((item) => item.group))],
    [menuScreen],
  );
  const group = chosenGroup !== null && groups.includes(chosenGroup) ? chosenGroup : groups[0];
  const items = useMemo(
    () => MENU.filter((item) => item.screen === menuScreen && item.group === group),
    [menuScreen, group],
  );

  // The values are read from the radio each time a group is opened.
  useEffect(
    () => request({ type: 'menuRead', ids: items.map((item) => item.id) }),
    [items, request],
  );

  return (
    <ScreenFrame title="SETTING" full>
      <div className="menu">
        <nav className="menu-screens">
          {MENU_SCREENS.map((screen) => (
            <button
              key={screen}
              type="button"
              className={screen === menuScreen ? 'chosen' : ''}
              onClick={() => showMenu(screen)}
            >
              {screen}
            </button>
          ))}
        </nav>
        <ul className="menu-groups">
          {groups.map((name) => (
            <li key={name}>
              <button
                type="button"
                className={name === group ? 'chosen' : ''}
                onClick={() => setChosenGroup(name)}
              >
                {name}
              </button>
            </li>
          ))}
          <li>
            <button
              type="button"
              title="Sets the radio's clock to the server's time, in UTC"
              onClick={() => act('syncClock')}
            >
              SET CLOCK
            </button>
          </li>
        </ul>
        <ul className="menu-items">
          {items.map((item) => (
            <MenuRow key={item.id} item={item} raw={menu[item.id]} />
          ))}
        </ul>
      </div>
    </ScreenFrame>
  );
}

/** Asked before the radio is switched off: there is no walking over to switch it back on. */
export function PowerScreen() {
  const { request } = useRadio();
  const { show } = useUi();
  return (
    <ScreenFrame title="POWER">
      <div className="power">
        <p>Switch the radio off?</p>
        <button
          type="button"
          className="recording"
          onClick={() => {
            request({ type: 'power', on: false });
            show(null);
          }}
        >
          SWITCH OFF
        </button>
        <button type="button" onClick={() => show(null)}>
          CANCEL
        </button>
      </div>
    </ScreenFrame>
  );
}
