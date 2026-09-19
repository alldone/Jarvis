import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AgentEvent, Availability } from '../../core/types.js';
import { killTree, resolveExecutable, spawnCommand } from '../../shell/command.js';

export async function findBinary(binary: string): Promise<Availability> {
  const path = await resolveExecutable(binary);
  if (path) return { available: true, detail: path };
  return { available: false, detail: `${binary} non trovato nel PATH; installa la CLI e completa il login nativo.` };
}

// JSON from provider executables is validated by each decoder at the boundary.
export type WireEvent = Record<string, any>;
export class ProcessRunner {
  private child?: ChildProcess;
  private stopped = false;

  async *run(binary: string, args: string[], cwd: string, input: string,
    decode: (event: WireEvent) => AgentEvent[], env?: NodeJS.ProcessEnv): AsyncGenerator<AgentEvent> {
    if (this.child) throw new Error('Il provider sta già lavorando.');
    this.stopped = false;
    const child = await spawnCommand(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    this.child = child;
    let failure: Error | undefined;
    let stderr = '';
    const closed = new Promise<number | null>(resolveClose => {
      child.once('error', error => { failure = error; });
      child.once('close', code => resolveClose(code));
    });
    child.stderr!.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.stdin!.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure = error; });
    child.stdin!.end(input);
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let protocolFailed = false;
    let completed = false;
    const parseLine = (line: string): AgentEvent[] => {
      if (!line.trim()) return [];
      let value: unknown;
      try { value = JSON.parse(line); }
      catch { throw new Error('Output non JSON ricevuto dalla CLI; controlla versione e configurazione del provider.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Evento provider non valido.');
      return decode(value as WireEvent);
    };
    try {
      for await (const chunk of child.stdout!) {
        pending += decoder.write(chunk as Buffer);
        if (pending.length > 2 * 1024 * 1024) throw new Error('Evento provider oltre il limite di 2 MiB.');
        let newline: number;
        while ((newline = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          for (const event of parseLine(line)) {
            if (event.type === 'error') protocolFailed = true;
            if (event.type === 'done') completed = true;
            else yield event;
          }
        }
      }
      pending += decoder.end();
      for (const event of parseLine(pending)) {
        if (event.type === 'error') protocolFailed = true;
        if (event.type === 'done') completed = true;
        else yield event;
      }
      const code = await closed;
      if (this.stopped) throw new Error('Operazione annullata.');
      if (failure) throw failure;
      // Providers often emit a useful structured error on stdout and then exit non-zero.
      // Do not replace that message with the generic exit status.
      if (code !== 0 && !protocolFailed) throw new Error(`${binary} terminato con codice ${code}: ${stderr.trim() || 'nessun dettaglio disponibile'}`);
      if (!completed && !protocolFailed) throw new Error(`Risposta incompleta da ${binary}: manca l'evento finale. ${stderr.trim()}`);
      if (!protocolFailed) yield { type: 'done' };
    } catch (error) {
      yield { type: 'error', error: error as Error };
    } finally {
      if (child.exitCode === null && child.signalCode === null) await this.interrupt();
      await closed;
      this.child = undefined;
    }
  }

  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopped = true;
    const signal = (name: NodeJS.Signals) => killTree(child, name);
    signal('SIGTERM');
    await new Promise<void>(resolveClose => {
      const timer = setTimeout(() => { signal('SIGKILL'); }, 1500);
      child.once('close', () => { clearTimeout(timer); resolveClose(); });
    });
  }
}
