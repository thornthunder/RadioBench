// Builds the installable desktop application: compiles everything, stages a self-contained
// copy with only the runtime dependencies, and hands it to electron-builder.
//
//   node scripts/package.mjs        builds release/dist/RadioBench-Setup-<version>.exe
//   node scripts/package.mjs --dir  unpacked application only (release/dist/win-unpacked)
//
// Uploading to the GitHub release is left to the release workflow (gh release upload):
// electron-builder's own publisher has been seen to exit with an upload still under way.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const stage = join(root, 'release', 'app');
const out = join(root, 'release', 'dist');
const dirOnly = process.argv.includes('--dir');

const run = (command, args, cwd = root) => {
  console.log(`> ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
};

const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const serverPackage = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'));
const desktopPackage = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

/** The version installed for a dependency, from the lockfile, so that the release matches. */
function lockedVersion(name) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry) throw new Error(`${name} is not in package-lock.json`);
  return entry.version;
}

const dll = join(root, 'apps/server/vendor/LibFT4222-64.dll');
if (!existsSync(dll)) {
  throw new Error(`${dll} is missing; the scope needs it (see apps/server/vendor/README.md)`);
}

console.log('# building');
run('npm', ['run', 'build', '-w', '@radiobench/protocol']);
run('npm', ['run', 'build', '-w', '@radiobench/web']);
run('npm', ['run', 'build', '-w', '@radiobench/server']);
run('npm', ['run', 'build', '-w', '@radiobench/desktop']);

console.log('# staging');
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, 'apps/web/dist'), join(stage, 'apps/web/dist'), { recursive: true });
cpSync(join(root, 'apps/server/dist'), join(stage, 'apps/server/dist'), { recursive: true });
cpSync(join(root, 'apps/server/vendor'), join(stage, 'apps/server/vendor'), { recursive: true });
cpSync(join(root, 'apps/desktop/dist'), join(stage, 'apps/desktop/dist'), { recursive: true });
cpSync(join(root, 'apps/desktop/static'), join(stage, 'apps/desktop/static'), { recursive: true });
cpSync(join(root, 'apps/desktop/build'), join(stage, 'build'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));

// A directory emptied for reuse. On Windows a file scanner tends to hold freshly written
// files for a while; a directory it still holds is left alone and a fresh one used instead.
const fresh = (dir) => {
  try {
    rmSync(dir, { recursive: true, force: true });
    return dir;
  } catch {
    const other = `${dir}-${Date.now()}`;
    console.log(`${dir} is in use; using ${other}`);
    return other;
  }
};

// Only what runs: the server's and the desktop application's dependencies, at the versions
// of the lockfile. Electron itself is what electron-builder packages.
const dependencies = {};
for (const name of Object.keys({ ...serverPackage.dependencies, ...desktopPackage.dependencies })) {
  if (name.startsWith('@radiobench/')) continue;
  dependencies[name] = lockedVersion(name);
}
// The protocol package is shared source that the compiled server imports as a package. It is
// packed as a tarball and installed like any other dependency: electron-builder takes along
// the node_modules of the declared dependencies, and a package merely copied in gets lost.
const protocolDir = fresh(join(root, 'release', 'protocol'));
cpSync(join(root, 'packages/protocol/dist'), join(protocolDir, 'dist'), { recursive: true });
writeFileSync(
  join(protocolDir, 'package.json'),
  JSON.stringify(
    {
      name: '@radiobench/protocol',
      version: rootPackage.version,
      type: 'module',
      exports: { '.': './dist/index.js' },
      files: ['dist'],
    },
    null,
    2,
  ),
);
const tarball = `radiobench-protocol-${rootPackage.version}.tgz`;
run('npm', ['pack', '--silent', '--pack-destination', stage], protocolDir);
dependencies['@radiobench/protocol'] = `file:./${tarball}`;
writeFileSync(
  join(stage, 'package.json'),
  JSON.stringify(
    {
      name: 'radiobench',
      productName: 'RadioBench',
      version: rootPackage.version,
      description: rootPackage.description,
      author: 'thornthunder',
      license: 'GPL-3.0-or-later',
      homepage: 'https://github.com/thornthunder/RadioBench',
      private: true,
      type: 'module',
      main: 'apps/desktop/dist/main.js',
      dependencies,
      devDependencies: { electron: lockedVersion('electron') },
      // Newer npm runs a dependency's install script only when allowed here. These three
      // fetch or pick their native binaries in it.
      allowScripts: { '@kmamal/sdl': true, koffi: true, '@serialport/bindings-cpp': true },
    },
    null,
    2,
  ),
);
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts=false'], stage);
if (!existsSync(join(stage, 'node_modules/@radiobench/protocol/dist/index.js'))) {
  throw new Error('The protocol package did not get installed into the staged application');
}

console.log('# packaging');
// electron-builder is given the Electron that npm installed, without the two files it would
// otherwise delete after copying: a failed deletion fails the whole build.
// npm's install of the electron package downloads the runtime in a postinstall step, which
// some environments skip (CI caches among them); fetched here if it is not there.
const installedElectron = join(root, 'node_modules/electron/dist');
if (
  !existsSync(join(installedElectron, process.platform === 'win32' ? 'electron.exe' : 'electron'))
) {
  console.log('# fetching the Electron runtime');
  run(
    'node',
    [join(root, 'node_modules/electron/install.js')],
    join(root, 'node_modules/electron'),
  );
}
const electronDist = fresh(join(root, 'release', 'electron'));
cpSync(installedElectron, electronDist, {
  recursive: true,
  filter: (source) => !/[\\/](resources[\\/]default_app\.asar|version)$/.test(source),
});
const output = fresh(out);
const args = [
  'electron-builder',
  '--config',
  join(root, 'electron-builder.yml'),
  '--projectDir',
  stage,
  `-c.directories.output=${output}`,
  `-c.electronDist=${electronDist}`,
  '--win',
  ...(dirOnly ? ['--dir'] : []),
  '--publish',
  'never',
];
run('npx', args);
console.log(`# done: ${output}`);
