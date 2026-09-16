import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export async function gitSnapshot(cwd: string): Promise<string> {
  const commands = [
    ['status', '--short'],
    ['log', '-3', '--oneline'],
    ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
    ['show', '--no-ext-diff', '--no-textconv', '--format=short', 'HEAD', '--'],
  ];
  const results = await Promise.all(commands.map(async args => {
    try {
      const { stdout } = await exec('git', ['-c', 'core.fsmonitor=false', ...args], {
        cwd, timeout: 5000, maxBuffer: 256 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' },
      });
      return `git ${args.join(' ')}\n${stdout.slice(0, 32000)}${stdout.length > 32000 ? '\n[truncated]' : ''}`;
    } catch { return `git ${args.join(' ')}: unavailable (no repository/commit, timeout or output limit)`; }
  }));
  return results.join('\n\n');
}
