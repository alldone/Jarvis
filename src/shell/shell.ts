import { spawn } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function cdTarget(command: string): string | undefined {
  if (!/^cd(?:\s|$)/.test(command)) return undefined;
  const value = command.slice(2).trim();
  if (!value) return homedir();
  if (/^"[^"$`]*"$/.test(value) || /^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/[\s;&|<>$`\\()]/.test(value)) throw new Error('Usa ! cd "percorso" come comando separato.');
  return value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
}

export async function changeDirectory(cwd: string, path: string): Promise<string> {
  const destination = await realpath(resolve(cwd, path));
  if (!(await stat(destination)).isDirectory()) throw new Error(`Non è una directory: ${destination}`);
  return destination;
}

export async function runInherited(binary: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolveCode, reject) => {
    const child = spawn(binary, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolveCode(code ?? 130));
  });
}

export function runShell(command: string, cwd: string): Promise<number> {
  return runInherited(process.env.SHELL ?? '/bin/sh', ['-c', command], cwd);
}
