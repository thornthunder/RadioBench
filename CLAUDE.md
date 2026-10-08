# RadioBench

A server on the shack PC that controls a Yaesu FT-710 over USB and serves a web front panel to
the LAN. See [README.md](README.md) for what works and how to run it, and
[docs/ft-710-interface.md](docs/ft-710-interface.md) for the radio's USB interfaces and CAT
commands. LAN-only by design: no authentication or TLS is wanted.

## Radio safety

A real transmitter is attached to the development PC.

- Never key it without the user asking for that specific action. That rules out `TX1;` and any
  other CAT command that starts a transmission or a tune cycle, from code under test, scripts or
  manual probes. `TX;` with no parameter is a read and is safe.
- Never open the CP2105's Standard COM Port (interface 1, COM6 on this PC). Its RTS/DTR lines can
  key the transmitter.
- Use the simulator (`--sim`, or `SimulatedTransport` in tests) unless the real radio is needed.
  Against the real radio, reads are fine, and so is writing a setting back with exactly the
  value just read; ask before sending anything that changes its settings.
- "Writing back" means sending the radio's own reply, character for character. A command built
  from the reply (another command word, an added terminator) is a new command and can change
  things: following the manual, a `}` was once added when writing a CW text back, and the radio
  kept it as part of the user's text (it was put right at once). When a format has to be tried
  that way, read the value back straight after and restore it if it differs. Do not write to
  memory channels, CW texts or voice memories that the user may care about without asking.
- Transmit controls (MOX, VOX, tuning) are refused by the server unless `RADIOBENCH_TX=on`.
  Leave that off when testing against the real radio, and keep the safeguards working: MOX is
  released when its client disconnects, after a time limit, and on shutdown.
- To test against the real radio while the user may be running their own copy, use other
  ports (`RADIOBENCH_HTTP_PORT=82`, `RADIOBENCH_HTTPS_PORT=8444`) and never stop a server you
  did not start. "Could not open COM3: Access denied" means the user's own software has the
  radio: leave it alone and test against the simulator instead.
- Stop any server you started when done. It holds the CAT port and the scope port, which blocks
  the user's other radio software.
- Reading the scope port is harmless, but do not clock it faster than the 1.5 MHz the code
  uses: at 6 MHz the data corrupts.

## Commands

```sh
npm run dev:sim     # server + web with live reload, simulated radio
npm run dev         # the same, real radio
npm test            # vitest, all workspaces
npm run typecheck
npm run format      # prettier
npm run build       # web client; the server runs from source
npm run build:all   # every workspace to JavaScript, as the desktop application needs
npm run desktop     # the tray application from source
npm run package:dir # the unpacked desktop application in release/dist/win-unpacked
npm run package     # the installer in release/dist
```

## Conventions

- npm workspaces: `packages/protocol` (shared wire types), `apps/server`, `apps/web`,
  `apps/desktop`.
- The server runs as TypeScript directly on Node 24 (type stripping, no compile step). So:
  relative imports carry the `.ts` extension, and enums, namespaces and constructor parameter
  properties are not allowed (`erasableSyntaxOnly`).
- Anything sent between server and browser is defined in `packages/protocol`, including the
  validation of incoming client messages. It must not import Node or DOM APIs.
- A setting of the radio is declared once, in `CONTROLS` (`packages/protocol/src/controls.ts`);
  the state type, validation and the page's ranges all follow from it. To add one: add it
  there, then its decode rule, encoder and read command in `radio/cat/codec.ts`, and an entry
  in the simulator. Take the format from Yaesu's CAT manual and confirm it with a read on the
  real radio; `codec.test.ts` keeps real replies as fixtures and checks that every set command
  equals the reply for the same value.
- The setting menus are a table, `packages/protocol/src/menu.ts`, transcribed from the CAT
  manual and checked item by item against the radio. Yaesu's manuals are wrong in places (see
  `docs/ft-710-interface.md`); where the radio and a manual disagree, the radio is right, and
  the simulator should behave as the radio does.
- Audio goes through `@kmamal/sdl`, loaded on first use so that a PC without it only loses
  audio. Browsers allow the microphone only on https or localhost, so the interface is served
  over HTTPS too (port 444; 443 is Windows's), with a self-signed certificate the server makes
  in `apps/server/certs/` (git-ignored). The same `createHttpServer` builds both listeners.
- FT8/FT4 decoding (`radio/digi/`) uses `@e04/ft8ts`, a TypeScript port of WSJT-X's decoder
  (GPL-3.0). It must never run on the main thread: FT8 goes through ft8ts's worker pool, FT4
  through `ft4-worker.ts`. Slots are cut by the wall clock (`Date.now()`), so the simulated
  audio device keeps to the wall clock too, and the decoder is tested with a clock of its own.
  ft8ts's encoder needs `samplesPerSymbol` for any rate other than 12 kHz.
- All CAT traffic goes through `CatClient`, one command at a time, and is scheduled by the one
  loop in `Radio`: waiting commands first, otherwise reads. State changes only through what the
  radio says (`decode`), apart from a setting being taken as set once the radio has accepted it.
- The page mimics the FT-710: keep the layout and wording of the radio's display and panel
  (`docs` and Yaesu's Operation Manual are the reference), and give a control the behaviour its
  counterpart on the radio has, including what holding a key does.
- The scope is read through FTDI's `LibFT4222-64.dll` via koffi. The DLL lives in
  `apps/server/vendor/` together with FTDI's licence terms, which allow distributing it in any
  form as long as the licence information stays with it; keep the two together, and do not
  replace the DLL with a copy that is not FTDI's own signed build. Frame parsing is tested
  against a frame captured from the real radio (`radio/scope/fixtures/`).
- The project is GPL-3.0-or-later (the FT8/FT4 decoder is a port of WSJT-X). New dependencies
  must be GPL-compatible.
- `apps/desktop` is the installable form: Electron, whose own Node.js runs the compiled server
  (`apps/server/dist`) as a child process with `ELECTRON_RUN_AS_NODE`, with settings from
  `%APPDATA%\RadioBench\settings.json` turned into the server's `RADIOBENCH_*` variables. Paths
  are relative to `apps/desktop/dist/main.js` and the same in the source tree and the staged
  application, so nothing is special-cased on `app.isPackaged` but the updater. Native
  dependencies must be N-API (koffi, serialport and @kmamal/sdl are), so that they load in
  Electron without rebuilding; the package is not asar'd for the same reason. Releases are made
  by tagging (`npm version`, `git push --follow-tags`): `.github/workflows/release.yml` runs
  `scripts/package.mjs --publish`, and electron-updater reads the release's `latest.yml`.
- Two things to know when running Electron from the agent's shell: VS Code's extension host
  sets `ELECTRON_RUN_AS_NODE=1`, which the shell inherits, so any `electron.exe` or
  `RadioBench.exe` launched from it runs as plain Node and exits quietly; unset it first
  (`Remove-Item Env:ELECTRON_RUN_AS_NODE`). And the `electron` and `electron-updater` modules
  are CommonJS without static exports, so they are imported as defaults and destructured.
  Packaged builds refuse Chromium switches such as `--remote-debugging-port`; test the panel
  through the server's ports with the headless browser instead, and read
  `%APPDATA%\RadioBench\logs\desktop.log` and `server.log`.
- ESET on this PC holds freshly written files for a while, which fails electron-builder's
  deletions and even `Remove-Item` of a previous `release/dist`; `scripts/package.mjs` gives
  electron-builder an Electron copy with nothing left to delete and builds beside a folder it
  cannot remove.
- `tsconfig.build.json` files compile the TypeScript that is distributed (`protocol`, `server`,
  `desktop`) with `rewriteRelativeImportExtensions`; a `new URL('./x.ts', import.meta.url)`
  is not rewritten, so pick the extension from `import.meta.url` as `engine.ts` does.
- The web interface is on port 81. This PC hands out every port from 1024 up for outgoing
  connections, so a higher port gets taken by other programs now and again (8710, the first
  choice, was). Keep any port you pick below 1024; 80 is taken by Windows itself.
- There is no linter: typescript-eslint does not support TypeScript 7 yet. `tsc` strict mode and
  Prettier are the checks.
