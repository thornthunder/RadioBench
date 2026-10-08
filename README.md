# RadioBench

Operate a Yaesu FT-710 from the PC it is plugged into, and from any browser on the same network.

One server process runs on the shack PC. It talks to the radio over the USB cable and serves a
web page over HTTP that is laid out as the radio's own front panel: its display, keys, knobs and
main dial, with the radio's audio. The same page is the interface everywhere: open it on the
shack PC, or from a laptop or phone on the LAN.

RadioBench is built for a trusted home network. It has no login and no encryption, so do not
expose its port to the internet.

It is free software under the GNU GPL v3 (see [LICENSE](LICENSE)); the FT8/FT4 decoder it uses
is a port of WSJT-X and carries the same licence.

## Installing on Windows

For the shack PC, RadioBench comes as a small installer that puts it in the Start menu and in
the tray, and keeps it up to date by itself.

1. Download `RadioBench-Setup-<version>.exe` from the
   [latest release](https://github.com/thornthunder/RadioBench/releases/latest) and run it. It
   installs for the current user only, with no administrator rights. The installer is not
   code-signed, so Windows SmartScreen will warn: choose "More info", then "Run anyway".
2. Install Yaesu's USB driver for the FT-710 if you have not already (the virtual COM port
   driver that WSJT-X and the Yaesu software use), and plug the radio in.
3. Start RadioBench from the Start menu. A window opens with the radio's front panel, and a
   dial icon appears in the tray; closing the window leaves RadioBench running in the tray,
   serving the rest of the network. The first time, Windows Firewall asks whether to allow
   RadioBench on private networks: allow it, or phones and laptops cannot connect.
4. For the spectrum scope, set MENU → OPERATION SETTING → GENERAL → SCU-LAN10 to ON on the
   radio. Only then does the scope port appear on USB; the SCU-LAN10 unit itself is not needed.

The tray menu has the rest: the addresses to open on other devices (and a browser-only view
on this PC), whether browsers may put the radio on the air ("Allow transmitting", off until you
switch it on), a simulated radio for trying things out, starting with Windows, the settings
file and the log, and "Check for updates…". Updates are also looked for every few hours; a new
release downloads in the background and is installed when you say so, or when RadioBench is
next quit.

RadioBench and other radio software cannot use the radio's CAT port at the same time. Quit
RadioBench from the tray before starting WSJT-X, or the other way round. From a script or a
shortcut, `RadioBench.exe --quit` stops the running RadioBench, and `RadioBench.exe --hidden`
starts it in the tray without opening the window.

## Status

Working, and checked against a real FT-710 (firmware 01-12):

- Finds the radio's CAT port and baud rate by itself
- Reads the whole front panel: both VFOs and their modes, and some 70 settings. Frequencies,
  S-meter and transmit status are refreshed several times a second, the rest every few seconds,
  so changes made on the radio itself show up too
- Shows the radio's own spectrum scope, about 30 sweeps a second, as trace and waterfall or as
  a 3DSS picture, with the audio oscilloscope and audio spectrum of the MULTI view
- Plays the radio's received audio in the browser
- Decodes FT8 and FT4 from the received audio and lists them under the panel (checked with
  signals made up on the PC; see the FT8/FT4 monitor below)
- Reads all 296 items of the setting menus, the memory channels and the CW text memories
- The radio accepts RadioBench's commands for changing things: settings, menu items, memory
  channels, memory names and CW texts were each written back to it exactly as they were

Working against the built-in simulator, not yet tried on the real radio:

- Changing anything to a new value. Every key, knob, touch area and screen of the page was
  operated in a browser against the simulator
- Things the radio does once: band change, A/B, V/M, M►V, QMB, zero-in, DSP reset, scanning,
  setting the clock, recording
- Switching the radio off and on
- The transmit controls (MOX, VOX, antenna tuning, sending CW and voice memories, microphone
  audio) and their safeguards; see Transmitting
- Reconnecting when the link to the radio drops
- Recovering the scope after its data is disturbed, as is reported to happen while transmitting
- The scope's frequency scale with the radio's scope in cursor or fixed mode

Not built:

- Recording a voice memory, and the CW memories keyed in by paddle (only the typed texts)
- Memory groups, and the clarifier, tone and repeater shift of a stored memory channel

Not possible from a PC, because the radio offers no command for it:

- The EXTENSION SETTING screen and everything to do with the SD card
- Erasing a memory channel, and emptying a CW text memory
- Switching the radio's own screen to its MULTI view. The page has its own.

[docs/ft-710-interface.md](docs/ft-710-interface.md) records what is known about the radio's USB
interfaces, including where Yaesu's manuals turned out to differ from the radio.

## Running from source

Requirements:

- Windows, and Node.js 24 or later
- The radio's USB cable and the Yaesu virtual COM port driver (the one WSJT-X needs)
- No other program holding the radio's CAT port: only one program can use it at a time
- For the spectrum scope, SCU-LAN10 set to ON on the radio (see above). FTDI's `LibFT4222-64.dll`
  comes with the repository; see [apps/server/vendor/README.md](apps/server/vendor/README.md)

Audio needs nothing extra: the radio's sound device is the "USB Audio Device" Windows already
lists. Without any of these the rest still works, and the page says what is unavailable and why.

```sh
npm install
npm run build     # builds the web client
npm start         # starts the server
```

`npm run desktop` builds everything and starts the tray application from source instead.

The server prints the addresses it can be reached at, for example `http://localhost:81` and
`http://192.168.0.166:81`, and the same over HTTPS on port 444. The first time, Windows
Firewall asks whether to allow Node.js on private networks; allow it, or other devices cannot
connect.

To try it without the radio, `npm run start:sim` runs against a built-in simulated FT-710.

### HTTPS and the certificate

Browsers hand the microphone only to pages served over HTTPS, so the interface is also served
at `https://<address>:444`. The server makes its own certificate the first time it starts and
keeps it in `apps/server/certs/`; it names the PC's hostname and addresses, and is remade when
those change or it nears expiry.

A browser does not know this certificate, so it warns the first time. Either accept the warning
(Chrome and Edge: "Advanced", then proceed), or install the certificate so that the warning
goes away for good: download it from `http://<address>:81/certificate` and add it to the
device's trusted root certificates (on Windows, open the file, Install Certificate, Local
Machine, Trusted Root Certification Authorities). Audio over plain HTTP keeps working either
way; only the microphone needs HTTPS.

### Behind a reverse proxy

A web server that already has HTTPS can put RadioBench under a path of its own, such as
`https://myserver/ft710/`. Point the proxy at the plain HTTP port, `http://<shack-pc>:81`:
the proxy's own HTTPS is what the browser sees, so the microphone works, and the server's
self-signed port 444 is best left out of it (a proxy that does not trust that certificate
answers 502). The page uses relative paths, so the prefix is stripped by the proxy and the
server never sees it; opened as `/ft710` without the slash, the page moves itself to `/ft710/`.
The proxy must pass WebSockets through (`/ws` carries everything live): on IIS with ARR that
is the "WebSocket Protocol" feature, on nginx the `Upgrade`/`Connection` headers. RadioBench has no
authentication of its own; if the proxy is reachable from the Internet, make the proxy require
a login, since whoever reaches the page can key the transmitter when `RADIOBENCH_TX` is on.

### If the port is in use

The server stops with "Port 81 is in use by another program" when something else holds the
port; set `RADIOBENCH_HTTP_PORT` to another one. Prefer a port below 1024. On some PCs Windows
hands out every port from 1024 up for outgoing connections
(`netsh int ipv4 show dynamicport tcp` shows the range), and any program can then hold a port
in that range for a while by chance.

## Using the panel

The page works like the radio:

- **Keys** are pressed with a click or tap. Holding one for a good half second gives its second
  function, as on the radio: [A/B] held copies the upper VFO to the lower, [QMB] held stores,
  [CLAR] held clears the offset, [FINE/FAST] held is FAST, [NB] and [DNR] held let the [FUNC]
  knob set their level, [TUNE] held starts tuning, [DSP RESET] held resets the filters, [V/M]
  held brings up the memory channels, and [LOCK] held asks whether to switch the radio off.
- **Knobs and the main dial** turn with the mouse wheel, by dragging them round, or with the
  arrow keys. A click without turning presses a knob: [FUNC] brings up the function screen,
  [STEP·MCH/DSP] the DSP functions.
- **The display** takes touches where the radio's does: the mode, the frequency (for the
  keypad), the meter, ATT, IPO, DNF and AGC, the filter picture, the keys under the scope, and
  the scope itself, which tunes to the frequency touched.
- **The function screen** ([FUNC] pressed) gives the radio's adjustments, and from its bottom
  row the setting screens: RADIO, CW, OPERATION and DISPLAY SETTING and the five presets, every
  item with its current value. MESSAGE holds the CW texts and voice memories, MEMORY the memory
  channels.
- **Under the scope**, [3DSS] switches the radio (and the page) between waterfall and 3DSS.
  [MULTI] adds the audio oscilloscope and audio spectrum, on the page only.
- **PHONES** plays the radio's received audio in this browser, with a volume slider. It is
  independent of the radio's own AF GAIN. Two things can keep it silent: browsers hold sound
  back until the page has been clicked or tapped (the panel says so; one touch anywhere frees it), and the
  sound goes to the browser's default output, which on the shack PC may be the radio's own
  "Speakers (USB Audio Device)" rather than the PC's speakers. Chrome and Edge let you pick the
  output under the slider; the list appears once the page may use the microphone ("Choose
  output…" asks for that), because browsers hide output devices until then.

The key lamps, the ring around the dial and the BUSY/TX lamp follow the radio. When the radio
does not answer, the display says so and offers to switch it on.

### The FT8/FT4 monitor

Under the radio sits a receive-only decoder for seeing who is on the band before starting
WSJT-X for real. [DECODE] switches it on; [FT8] and [FT4] choose the mode; "Tune to…" puts the
radio on a band's usual frequency in DATA-U. Each slot (15 s for FT8, 7.5 s for FT4, cut by the
PC's clock from the top of the UTC minute, as WSJT-X does it) is listed with the time, the dial
frequency and its decodes: UTC, signal-to-noise ratio in dB, the sender's clock offset DT in
seconds, the audio frequency in Hz and the message, as WSJT-X shows them. CQ calls are green;
with your callsign filled in under "My call", messages that mention it are shown in red.
Decodes appear a second or two after each slot ends; the PC's clock must be right to within a
second or so, as for WSJT-X.

The decoding is done on the server by [ft8ts](https://github.com/e04/ft8ts), a TypeScript port
of WSJT-X's own decoder, in threads of its own so that the radio link is never held up. One
decoder serves every browser; it runs while any of them has [DECODE] on. `RADIOBENCH_DECODE_DEPTH`
sets how hard it tries. ft8ts is GPL-3.0, like WSJT-X; that matters only if RadioBench is ever
given to others.

## Transmitting

Everything that puts the radio on the air is refused unless the server is started with
`RADIOBENCH_TX=on`: MOX, VOX, antenna tuning, sending a CW text or voice memory, and
microphone audio. It is off by default because none of it has been tried on a real radio yet.
With it on, the server releases MOX by itself when the browser that switched it on
disconnects, after three minutes, and when the server stops.

**MIC** sends this browser's microphone to the radio's USB audio input; the lamp turns green
once the server confirms the radio is being fed. For the radio to transmit it, the mode's MOD
SOURCE (RADIO SETTING) must be USB, or AUTO with the radio keyed from the page. The page has
to be open over HTTPS (or on the shack PC as `localhost`) for the browser to allow the
microphone at all; see HTTPS and the certificate above.

## Developing

```sh
npm run dev        # server + web client with live reload, real radio
npm run dev:sim    # the same against the simulator
npm test
npm run typecheck
npm run format
```

In development, open the address Vite prints (`http://localhost:5173`); it forwards API and
WebSocket traffic to the server on port 81.

### Releasing

The installer is built by GitHub Actions ([release.yml](.github/workflows/release.yml))
whenever a version tag is pushed:

```sh
npm version minor          # or patch; updates package.json and makes the tag
git push --follow-tags
```

The workflow compiles everything, stages a copy with only the runtime dependencies
([scripts/package.mjs](scripts/package.mjs)), packages it with electron-builder, and attaches
`RadioBench-Setup-<version>.exe` and `latest.yml` to the release for the tag. Installed copies
read `latest.yml` to find the update. `npm run package` does the same on your own PC (the
installer lands in `release/dist/`), and `npm run package:dir` only lays out the unpacked
application for a quick try. The desktop application is Electron: its own Node.js runs the
compiled server as a child process, so the server never knows the difference.

## Configuration

The installed application keeps its settings in `%APPDATA%\RadioBench\settings.json` (tray
menu → "Settings file…"), with the same meaning as the variables below: `catPort`, `catBaud`,
`httpPort`, `httpsPort`, `allowTransmit`, `scope`, `audio`, `decodeDepth`, `openAtLogin`. Its
log is in `%APPDATA%\RadioBench\logs\`. When run from source, the server reads these
environment variables, or a `.env` file in the repository root (copy `.env.example`).

Defaults need no configuration. To change them, copy [.env.example](.env.example) to `.env`:

| Variable                   | Default                  | Meaning                                                |
| -------------------------- | ------------------------ | ------------------------------------------------------ |
| `RADIOBENCH_HTTP_HOST`     | `0.0.0.0`                | Address to listen on; `127.0.0.1` keeps it to this PC  |
| `RADIOBENCH_HTTP_PORT`     | `81`                     | Port of the web interface                              |
| `RADIOBENCH_HTTPS`         | `on`                     | `on` or `off`: also serve over HTTPS                   |
| `RADIOBENCH_HTTPS_PORT`    | `444`                    | Port of the HTTPS interface                            |
| `RADIOBENCH_CAT_PORT`      | `auto`                   | `auto`, `sim`, or a port name such as `COM3`           |
| `RADIOBENCH_CAT_BAUD`      | `auto`                   | `auto`, or the radio's CAT-1 RATE setting              |
| `RADIOBENCH_CAT_STOP_BITS` | `2`                      | `1` or `2`                                             |
| `RADIOBENCH_SCOPE`         | `on`                     | `on` or `off`                                          |
| `RADIOBENCH_FT4222_DLL`    | in `apps/server/vendor/` | Path to FTDI's `LibFT4222-64.dll`                      |
| `RADIOBENCH_AUDIO`         | `on`                     | `on` or `off`                                          |
| `RADIOBENCH_AUDIO_IN`      | `USB Audio Device`       | Part of the name of the radio's recording device       |
| `RADIOBENCH_AUDIO_OUT`     | `USB Audio Device`       | Part of the name of the radio's playback device        |
| `RADIOBENCH_DECODE_DEPTH`  | `3`                      | FT8/FT4 decoding depth: `1` fast, `2` normal, `3` deep |
| `RADIOBENCH_TX`            | `off`                    | `on` lets clients put the radio on the air             |

## Layout

```
packages/protocol/   What server and browser exchange: settings, menu table, messages, encoding
apps/server/         Node.js server
  src/radio/cat/       CAT over the serial port: transport, client, command codec, simulator
  src/radio/scope/     Spectrum scope: FT4222 port, frame reader and parser, simulator
  src/radio/audio/     The radio's USB sound device, both ways
  src/radio/digi/      FT8/FT4 decoding: slots cut from the received audio, ft8ts in worker threads
  src/radio/radio.ts   Connection upkeep, the command and polling loop, radio state
  src/http/            HTTP and HTTPS servers with the WebSocket, and the certificate
  certs/               The server's own certificate, made on first start (not in the repository)
  vendor/              FTDI's library goes here (not in the repository)
apps/web/            The front panel, in React, built with Vite
  src/display/         The radio's display and the screens it puts up
  src/panel/           Keys, knobs and the main dial
  src/digi/            The FT8/FT4 monitor under the radio
apps/desktop/        The Windows tray application (Electron): runs the server, shows the panel, updates itself
scripts/package.mjs  Stages and packages the installer
docs/                Notes on the FT-710's USB interfaces
```

The server keeps one `RadioState` object, read from the radio by polling, and sends every
browser what changes in it over a WebSocket. Scope sweeps and audio travel over the same socket
as compact binary messages. Browsers send settings and actions back the same way. Menu values,
memory channels and CW texts are read from the radio when a browser asks for them. The server
runs its TypeScript directly on Node.js, so only the web client has a build step.
