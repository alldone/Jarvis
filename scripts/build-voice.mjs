import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// --universal builds one helper for Apple Silicon and Intel Macs (used for releases).
const universal = process.argv.includes('--universal');
const minimumMacOS = '12.0';

if (process.platform !== 'darwin') {
  console.log('JARVIS: the native push-to-talk helper currently supports macOS only.');
  process.exit(0);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const app = resolve(root, 'dist/native/JARVIS Voice.app');
const contents = resolve(app, 'Contents');
const bin = resolve(contents, 'MacOS/jarvis-voice');
const plist = resolve(root, 'native/macos/Info.plist');
const cache = resolve(root, 'dist/native/module-cache');
mkdirSync(resolve(contents, 'MacOS'), { recursive: true });
mkdirSync(cache, { recursive: true });
copyFileSync(plist, resolve(contents, 'Info.plist'));
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    console.error(`JARVIS: cannot build voice helper. Install Xcode Command Line Tools (xcode-select --install). ${result.error?.message ?? ''}`);
    process.exit(result.status || 1);
  }
}
function compile(output, target) {
  run('swiftc', ['-swift-version', '5', '-O', '-module-cache-path', cache,
    ...(target ? ['-target', target] : []),
    resolve(root, 'native/macos/Voice.swift'), '-o', output,
    '-framework', 'AVFoundation', '-framework', 'Speech', '-framework', 'AppKit',
    '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist]);
}
if (universal) {
  const slices = ['arm64', 'x86_64'].map(arch => ({ arch, output: resolve(root, `dist/native/jarvis-voice-${arch}`) }));
  for (const slice of slices) compile(slice.output, `${slice.arch}-apple-macos${minimumMacOS}`);
  run('lipo', ['-create', ...slices.map(slice => slice.output), '-output', bin]);
  for (const slice of slices) rmSync(slice.output, { force: true });
} else {
  compile(bin);
}
run('codesign', ['--force', '--sign', '-', app]);
console.log(`JARVIS: macOS push-to-talk helper built${universal ? ' (universal: arm64 + x86_64)' : ''}.`);
