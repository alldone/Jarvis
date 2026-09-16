import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('JARVIS: the native push-to-talk helper currently supports macOS only.');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const app = resolve(root, 'dist/native/JARVIS Voice.app');
const contents = resolve(app, 'Contents');
const bin = resolve(contents, 'MacOS/jarvis-voice');
const plist = resolve(root, 'native/macos/Info.plist');
mkdirSync(resolve(contents, 'MacOS'), { recursive: true });
mkdirSync(resolve(root, 'dist/native/module-cache'), { recursive: true });
copyFileSync(plist, resolve(contents, 'Info.plist'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`JARVIS: cannot build voice helper. Install Xcode Command Line Tools (xcode-select --install). ${result.error?.message ?? ''}`);
    process.exit(result.status || 1);
  }
}
run('swiftc', ['-swift-version', '5', '-O', '-module-cache-path', resolve(root, 'dist/native/module-cache'),
  resolve(root, 'native/macos/Voice.swift'), '-o', bin,
  '-framework', 'AVFoundation', '-framework', 'Speech', '-framework', 'AppKit',
  '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist]);
run('codesign', ['--force', '--sign', '-', app]);
console.log('JARVIS: macOS push-to-talk helper built.');
