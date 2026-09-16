import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';

export interface SpeechOutput {
  speak(text: string): Promise<void>;
  stop(): void;
  close(): Promise<void>;
}

/** macOS system speech. Arguments are passed directly to `say`, never through a shell. */
export class MacOSSayOutput implements SpeechOutput {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  constructor(private options: { locale?: string; voice?: string; rate?: number } = {}) {}

  async speak(text: string): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('Risposta vocale disponibile attualmente solo su macOS.');
    const clean = speechText(text);
    if (!clean) return;
    this.stop();
    this.stopped = false;
    const args: string[] = [];
    if (this.options.voice) args.push('-v', this.options.voice);
    if (this.options.rate) args.push('-r', String(this.options.rate));
    const child = spawn('say', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let stderr = '';
    child.stdout.resume();
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2000); });
    child.stdin.end(clean);
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        this.child = undefined;
        if (this.stopped) return reject(new Error('Risposta vocale interrotta.'));
        if (code !== 0) reject(new Error(`Sintesi vocale terminata con codice ${code}: ${stderr.trim()}`));
        else resolve();
      });
    });
  }

  stop(): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.stopped = true;
    child.kill('SIGTERM');
  }

  async close(): Promise<void> {
    this.stop();
  }
}

/** Keep code readable on screen but avoid making a speech engine read markdown syntax aloud. */
export function speechText(text: string, maxChars = 20000): string {
  return stripVTControlCharacters(text)
    .replace(/```[\s\S]*?```/g, ' ') // code is available in the terminal
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars)
    .trim();
}
