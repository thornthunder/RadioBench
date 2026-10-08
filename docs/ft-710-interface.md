# FT-710 USB interfaces

What the radio exposes over its single USB cable, and what RadioBench needs from each part.
Each fact is marked with how it is known:

- **Measured** — observed on the development radio and PC (Windows 10) on 2026-10-06.
- **Reported** — taken from Yaesu's documentation or other projects' write-ups (listed at the
  end); not yet confirmed here.

## What is behind the USB socket

The radio contains a USB hub. Three devices sit behind it:

| Device                                 | Purpose                       | Status in RadioBench |
| -------------------------------------- | ----------------------------- | -------------------- |
| Silicon Labs CP2105 dual serial bridge | CAT control, PTT/keying lines | CAT in use           |
| USB audio codec                        | Receive and transmit audio    | In use               |
| FTDI FT4222 USB-to-SPI bridge          | The radio's spectrum scope    | In use               |

Measured: the hub is `VID_04B4 PID_6560`; the CP2105 is `VID_10C4 PID_EA70`; the audio codec is
`VID_0D8C PID_0013` and appears in Windows as "USB Audio Device"; the FT4222 is
`VID_0403 PID_601C`. The FT4222 is only on the hub while the radio's SCU-LAN10 menu setting is
ON (see below); with it OFF the device is absent altogether.

## Serial ports (CAT)

The CP2105 provides two COM ports:

- **Enhanced COM Port** (USB interface 0; COM3 on the development PC) carries CAT. Measured.
- **Standard COM Port** (USB interface 1; COM6) carries no CAT. Its RTS and DTR lines can key the
  transmitter, depending on the radio's PTT and keying menu settings. Reported, from Yaesu's
  driver notes; RadioBench never opens this port, so it has not been tried.

RadioBench picks the Enhanced port by USB IDs and interface number, so the COM number does not
matter.

Measured on the development radio:

- It answered at **9600 baud**. The factory setting of MENU → OPERATION SETTING → GENERAL →
  CAT-1 RATE is reported to be 38400, so this radio's setting has been changed. RadioBench tries
  each rate the menu offers (38400, 9600, 19200, 4800, 115200) until the radio answers.
- 8 data bits, no parity, 2 stop bits works.
- `ID;` is answered with `ID0800;`.
- At the wrong baud rate the port opens normally and the radio simply does not answer.

### Commands

CAT commands are ASCII and end in `;`. The authority is Yaesu's _FT-710 CAT Operation Reference
Manual_; `apps/server/src/radio/cat/codec.ts` holds every command RadioBench uses, and its test
keeps the replies of the development radio (firmware 01-12) as fixtures. What was measured:

- **Reads.** All 80-odd read commands RadioBench uses were sent and answered in the manual's
  formats. For nearly every setting the reply is the read command followed by the value, and
  the set command is that same string.
- **Sets.** 62 settings were written back with the value just read, which cannot change
  anything. 59 were accepted. `KR` (keyer), `CS` (CW spot) and `OS` (repeater shift) were
  refused with `?;` in DATA-U; they belong to CW and FM. `BI;` (break-in) cannot even be read
  in DATA-U. Setting anything to a new value has not been tried on the real radio.
- **`?;`** is the radio's answer to a command it does not accept, including ones that do not
  apply in the present mode. It arrives within 10 ms.
- **Timing at 9600 baud.** A reply takes 10–36 ms depending on its length. Reads can follow one
  another without any pause: 40 of 40 were answered with no gap at all. So RadioBench reads
  everything by polling, and does not use the radio's auto-information mode (`AI`).
- **Model ID** is `0800`; `VE0;` gives the main firmware version (`VE00112` for 01-12).
- `SQ;` is refused; the squelch is read with `SQ0;`, whatever the manual's table suggests.

Not tried, from the manual: `TX1;` and `MX1;` key the transmitter and `AC003;` starts antenna
tuning, which transmits. `TX;`, `MX;` and `AC;` without a parameter only read. Reported
elsewhere: the radio wants about 20 ms after a command that makes it do something. RadioBench
waits that long after every set command, which is also how long it gives the radio to object.

Some things the manual settles that are easy to get wrong:

- `FA`/`FB` are always VFO-A and VFO-B, but `MD0`/`MD1` are the main and sub band: `VS` says
  which VFO is the main one.
- `PR01`/`PR02` are processor off/on: 1 is off. `PR1x` is the microphone equaliser.
- `GT0x` is set with 0–4 (4 = AUTO) but reports 0–6, where 4–6 name the automatic choice.
- `CO03` gives the APF frequency as 0–50 for −250 to +250 Hz.
- `SS06` numbers the scope modes: 0–2 are 3DSS centre/cursor/fix; then waterfall centre,
  cursor and fix in threes, each enlarged then normal, with every third number unused.
- The menu is read with `EX` plus three two-digit numbers. `EX030102` is what the RF GAIN/SQL
  knob controls, `EX030501` and `EX030502` the dial steps, `EX030503` the channel step.

### The setting menus

`EX` plus screen, group and item (two digits each) reads a menu item; the same followed by the
value sets it. `packages/protocol/src/menu.ts` holds all 296 items, transcribed from the CAT
manual's table and then checked against the radio: every item answers, with a value of the
length and kind the table gives, and nothing answers beyond the table. Four kinds of value were
written back unchanged and accepted: a signed number (`EX010101+01`), a number, a choice, and
text (`EX040101ZR1JT       `, padded with spaces to twelve characters).

Where the radio differs from the CAT manual's table:

- DISPLAY has a sixth item, POP-UP TIME, at `040103`; SCREEN SAVER, LED DIMMER and MOUSE POINTER
  SPEED follow at 04–06. The Operation Manual lists it; the CAT manual does not.
- TONE FREQ (`010321`) takes three characters, not two.
- CW WEIGHT (`020203`) is numbered 00–20 for 2.5–4.5; the radio answers `05` for 3.0.
- MARK FREQUENCY (`010515`) counts from 0, not from 1 as printed.
- MIC SCAN (`030116`) is 0 for OFF and 1 for ON, the reverse of what is printed.

The last two are inferred from a radio answering `1` with those items at their defaults (2125 Hz
and ON). EXTENSION SETTING cannot be reached with `EX` at all.

### Memories, messages and power

- `MC;` gives the current memory channel; `MRnnn;` a channel's contents in the layout of `IF;`;
  `MTnnn;` its name as a flag and twelve characters. An empty channel answers `?;`.
- `MW` writes a channel, in the layout `MR` reports it, with one difference: the field after the
  mode must be 1 ("memory"). With the 0 that `MR` reports there, the radio refuses the command.
  Measured by writing channel 001 back unchanged.
- `KMn;` gives a CW text memory; an empty one answers a bare `KM;`. To store a text, send it
  as it is. **The manual says to end it with `}`, but the radio then keeps the brace as part of
  the text.** A text cannot be emptied: without text, the command is the read.
- `PS;` answers `PS1;`. Switching off (`PS0;`) and on (`PS1;` twice, about a second apart, as
  Yaesu documents for this family of radios) have not been tried on the real radio.
- Not tried either: `KY` (send a CW memory), `PB` (play a voice memory), `LM` (record), `SC`
  (scan), `DT` (set the clock), beyond reading their state.

Only one program can hold the CAT port. While RadioBench runs, WSJT-X and similar programs cannot
use the port directly; other consoles solve this by offering a secondary virtual CAT port.

## Spectrum scope (FT4222)

The scope shown on the radio's display is also sent out over the FT4222, for Yaesu's SCU-LAN10
network unit. It is the radio's real scope, not an FFT of the audio. The wfview project worked
out how to read it; the settings and frame layout below are theirs, and everything marked
measured has been confirmed on the development radio.

### Getting the port to appear

- Measured: the FT4222 only appears on USB once MENU → OPERATION SETTING → GENERAL → SCU-LAN10
  is ON. The SCU-LAN10 unit itself is not needed.
- Measured: Windows then installs FTDI's D2XX driver by itself (`ftd2xx.dll` 3.2.21.1 in
  `System32`). The driver lists two devices, "FT4222 A" and "FT4222 B"; A carries the scope.
- Reading it also takes FTDI's LibFT4222 (`LibFT4222-64.dll`, 1.4.8 measured), which does not
  come with the driver. See `apps/server/vendor/README.md`.
- Measured: no CAT command is needed to start the stream; it runs as soon as the port is read.
  Reported, and not tried: the scope can also be switched over CAT with the extended-menu
  commands `EX040101` (scope output on) and `EX040200` (centre mode).
- Measured: only one program can open the port. A second one gets D2XX status 3
  (device not opened).

### Reading it

The PC is the SPI master and simply clocks data out of the radio:

- Open "FT4222 A" by description; USB timeouts 100 ms, latency timer 2 ms.
- `FT4222_SPIMaster_Init`: single-line SPI, clock idle high, sample on the leading edge, slave
  select 0. Then `FT4222_SetClock` to 24 MHz.
- `FT4222_SPIMaster_SingleRead` of 4096 bytes at a time, without ending the transaction.

Measured clock rates, with the 24 MHz system clock:

| Divider | SPI clock | Reads per second | Result                                          |
| ------- | --------- | ---------------- | ----------------------------------------------- |
| 64      | 375 kHz   | 11               | Clean; every read a new sweep (wfview's choice) |
| 32      | 750 kHz   | 22               | Clean; every read a new sweep                   |
| 16      | 1.5 MHz   | 43               | Clean; about 30 new sweeps a second             |
| 8       | 3 MHz     | 81               | Clean; about 30 new sweeps a second             |
| 4       | 6 MHz     | 146              | Corrupt                                         |

So the radio produces about 30 sweeps a second, and reading faster only repeats them.
RadioBench uses 1.5 MHz and drops the repeats. After the corrupt run at 6 MHz the next few
frames were misaligned as well; reopening the port a moment later gave aligned frames again.

### Frame layout

The stream is a bare sequence of 4096-byte frames:

| Offset | Length | Content                                                                  |
| ------ | ------ | ------------------------------------------------------------------------ |
| 0      | 850    | Sweep of the main receiver, one byte per point, inverted (0 = strongest) |
| 850    | 850    | Sweep of a second receiver; all zero on the FT-710                       |
| 1700   | 200    | Spectrum of the received audio, inverted like the sweep                  |
| 1900   | 400    | Oscilloscope trace of the audio: 200 columns, two bytes each             |
| 2300   | 600    | The same two for a second receiver; all zero on the FT-710               |
| 2900   | 150    | Radio status, see below                                                  |
| 3050   | 1030   | Zeros                                                                    |
| 4080   | 16     | The marker `ff 01 ee 01`, four times                                     |

Measured, in the status block (offsets within the block):

| Offset | Length | Content                                                                      |
| ------ | ------ | ---------------------------------------------------------------------------- |
| 17     | 1      | Scope mode; 4 seen, with the sweep centred on VFO-A                          |
| 32     | 1      | Span index: 0–9 for 1, 2, 5, 10, 20, 50, 100, 200, 500 kHz and 1 MHz; 8 seen |
| 60     | 1      | Mode of VFO-A in the scope's own numbering; 9 = DATA-U seen                  |
| 64     | 5      | VFO-A frequency, ten BCD digits in Hz                                        |
| 89     | 5      | VFO-B frequency (per wfview)                                                 |
| 110    | 1      | S-meter, tracking what `SM0;` returns                                        |
| 132    | 4      | VFO-A frequency, big-endian binary in Hz                                     |

Measured, for the audio data: the spectrum falls away above the receive filter's width (at 175
of 200 points with a 3500 Hz filter, so the 200 points span about 4 kHz). Each oscilloscope
column holds the two ends of the stroke the radio draws there, the higher value first, around a
centre of about 128. Both are present whether or not the radio's own screen shows its MULTI view.

Reported by wfview and not confirmed here: scope modes 0, 3, 4 and 5 are centre modes, 1 and
6–8 cursor modes, 2, 9 and 10 fixed modes; and in the cursor and fixed modes the four bytes at
offset 144 hold the sweep's start frequency (in centre mode they repeat the VFO-A frequency).
RadioBench relies on both for its frequency scale outside centre mode.

The first byte of the first frame after opening the port was wrong once (0 instead of a sweep
value), so RadioBench discards that frame.

Reported, and not tried because it means transmitting: frames are corrupted while the radio
transmits, so the stream has to be re-synchronised after each transmission. RadioBench checks
every frame's end marker, re-aligns on it when frames arrive shifted, and reopens the port when
no valid frame arrives for about half a second.

## Audio

- Reported: the codec runs at 16-bit, 48 kHz, using the audio driver built into Windows.
- Measured: Windows lists it as "Speakers (USB Audio Device)" and "Microphone (USB Audio Device)",
  with a number in front of the name that depends on the PC. The microphone device is the
  radio's received audio; what is played to the speakers device is the radio's transmit audio.
- Measured: RadioBench reads it through SDL (`@kmamal/sdl`), which converts to the 16 kHz mono
  it sends to browsers. Received audio is there whatever the AF GAIN knob is set to, and loud:
  FT8 signals reached full scale. The playback device opens and takes audio; what the radio
  does with it on the air has not been tried.
- From the manual: the radio transmits USB audio when the mode's MOD SOURCE menu item is USB, or
  AUTO and the radio is keyed over CAT.

## Prior work

The scope protocol was reverse-engineered by the wfview project, and the other programs build on
that. Useful as references when building the missing parts:

- **wfview** — open source; the origin of the FT-710 scope work.
- **710 Console** (M7XTD) — Windows front panel for the FT-710 with scope, audio and remote use.
- **VLSC's write-up** of a browser-based FT-710 remote with an open-source backend; the source of
  the CAT timing and transmit-corruption notes above.
- **n1mm-scope-bridge** — streams the FT-710 scope into N1MM Logger+.
- **POTACAT** — has an FT-710 scope window, though its authors say it is untested on a real radio.
- **FT-710 CAT Operation Reference Manual** (Yaesu) — the authority on CAT commands.
