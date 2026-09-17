import { spawn as crossSpawn } from 'cross-spawn';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, resolve } from 'node:path';

const windows = process.platform === 'win32';

/** Resolves a command like the OS shell would, including PATHEXT on Windows (codex → codex.cmd). */
export async function resolveExecutable(binary: string, env = process.env): Promise<string | undefined> {
  const explicit = isAbsolute(binary) || binary.includes('/') || (windows && binary.includes('\\'));
  const bases = explicit ? [resolve(binary)] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean).map(path => resolve(path, binary));
  // Without an extension Windows only runs PATHEXT matches; npm's extension-less sh shim must be skipped.
  const extensions = windows && !extname(binary)
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(ext => ext.toLowerCase())
    : [''];
  for (const base of bases) {
    for (const ext of extensions) {
      try { await access(base + ext, windows ? constants.F_OK : constants.X_OK); return base + ext; } catch { /* next candidate */ }
    }
  }
  return undefined;
}

/**
 * npm installs Windows CLIs as .cmd shims. cmd.exe cannot carry multi-line arguments (project context),
 * so run the shim's JavaScript entry point with Node directly when the standard npm shim layout is found.
 */
export function npmShimTarget(shim: string): string | undefined {
  return /"%(?:~?dp0%?)\\?([^"%]+\.(?:c|m)?js)"\s+%\*/i.exec(shim)?.[1];
}

async function unwrapNpmShim(path: string): Promise<{ command: string; args: string[] } | undefined> {
  if (!/\.cmd$/i.test(path)) return undefined;
  try {
    const target = npmShimTarget(await readFile(path, 'utf8'));
    return target ? { command: process.execPath, args: [resolve(dirname(path), target)] } : undefined;
  } catch { return undefined; }
}

/** Spawns provider CLIs portably: plain spawn on Unix; npm-shim unwrapping or escaped cmd.exe on Windows. */
export async function spawnCommand(binary: string, args: string[], options: SpawnOptions): Promise<ChildProcess> {
  if (!windows) return spawn(binary, args, options);
  const path = await resolveExecutable(binary);
  const shim = path ? await unwrapNpmShim(path) : undefined;
  if (shim) return spawn(shim.command, [...shim.args, ...args], options);
  return crossSpawn(path ?? binary, args, options);
}

/** Stops a child and everything it started (npm shims and shells spawn grandchildren). */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (windows) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill(signal));
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
