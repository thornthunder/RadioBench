import electron from 'electron';
import electronUpdater from 'electron-updater';

// Both are CommonJS modules without static exports, so neither can be imported by name.
const { app, dialog } = electron;
const { autoUpdater } = electronUpdater;

/** How often RadioBench looks for a new release on GitHub while it runs. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** The first look, a little after starting. */
const FIRST_CHECK_MS = 15 * 1000;

/**
 * Keeps RadioBench up to date from the project's GitHub releases: a new release is
 * downloaded in the background and installed when the user agrees, or at the latest when
 * RadioBench is next quit.
 */
export class Updater {
  private readonly log: (line: string) => void;
  private manual = false;
  private ready: string | null = null;

  constructor(log: (line: string) => void) {
    this.log = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = {
      info: (message: unknown) => log(`[update] ${String(message)}`),
      warn: (message: unknown) => log(`[update] ${String(message)}`),
      error: (message: unknown) => log(`[update] ${String(message)}`),
      debug: () => undefined,
    };
    autoUpdater.on('update-available', (info) => {
      log(`[update] version ${info.version} is available; downloading`);
    });
    autoUpdater.on('update-not-available', () => {
      if (this.manual) {
        void dialog.showMessageBox({
          type: 'info',
          title: 'RadioBench',
          message: `RadioBench ${app.getVersion()} is the latest version.`,
        });
      }
      this.manual = false;
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.ready = info.version;
      this.manual = false;
      void this.offerRestart(info.version);
    });
    autoUpdater.on('error', (error) => {
      log(`[update] ${error.message}`);
      if (this.manual) {
        void dialog.showMessageBox({
          type: 'warning',
          title: 'RadioBench',
          message: 'Could not check for updates.',
          detail: error.message,
        });
      }
      this.manual = false;
    });
  }

  /** Looks now and then; does nothing when not installed from a release. */
  start(): void {
    if (!app.isPackaged) {
      this.log('[update] not installed from a release; not checking for updates');
      return;
    }
    setTimeout(() => void this.check(false), FIRST_CHECK_MS);
    setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  /** Looks for an update; a manual check reports its outcome in a dialog. */
  async check(manual: boolean): Promise<void> {
    if (!app.isPackaged) {
      if (manual) {
        await dialog.showMessageBox({
          type: 'info',
          title: 'RadioBench',
          message: 'Updates are only checked for when RadioBench is installed from a release.',
        });
      }
      return;
    }
    if (this.ready) {
      await this.offerRestart(this.ready);
      return;
    }
    this.manual = manual;
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported through the error event.
    }
  }

  private async offerRestart(version: string): Promise<void> {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'RadioBench',
      message: `RadioBench ${version} is ready to install.`,
      detail:
        'Restart RadioBench now to finish updating, or keep working: it installs when RadioBench is next quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  }
}
