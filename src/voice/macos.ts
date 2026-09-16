import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Transcript } from '../providers/voice.js';

export type VoiceCaptureEvent =
  | { type: 'ready' | 'listening' | 'transcribing' | 'released' }
  | { type: 'transcript'; transcript: Transcript }
  | { type: 'cancelled'; message: string }
  | { type: 'error'; message: string; fatal: boolean };

export interface VoiceCapture {
  start(emit: (event: VoiceCaptureEvent) => void): Promise<void>;
  record(): void;
  cancel(): void;
  close(): Promise<void>;
}

export function decodeVoiceEvent(value: unknown): VoiceCaptureEvent {
  if (!value || typeof value !== 'object') throw new Error('Evento vocale non valido.');
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case 'ready': case 'listening': case 'transcribing': case 'released': return { type: event.type };
    case 'transcript': {
      if (typeof event.text !== 'string' || !event.text.trim() || event.text.length > 16000) throw new Error('Trascrizione non valida.');
      const confidence = typeof event.confidence === 'number' && Number.isFinite(event.confidence) && event.confidence >= 0 && event.confidence <= 1 ? event.confidence : undefined;
      return { type: 'transcript', transcript: { text: event.text, language: typeof event.language === 'string' ? event.language : undefined, confidence } };
    }
    case 'cancelled': return { type: 'cancelled', message: typeof event.message === 'string' ? event.message : 'Registrazione annullata.' };
    case 'error': return { type: 'error', message: typeof event.message === 'string' ? event.message : 'Errore vocale.', fatal: event.fatal === true };
    default: throw new Error('Evento vocale sconosciuto.');
  }
}

export class MacOSVoiceCapture implements VoiceCapture {
  private child?: ChildProcessWithoutNullStreams;
  private completed?: Promise<void>;
  private closing = false;
  constructor(private options: { locale: string; localOnly: boolean; maxSeconds: number }) {}

  async start(emit: (event: VoiceCaptureEvent) => void): Promise<void> {
    if (process.platform !== 'darwin') throw new Error('Push-to-talk con Spazio è attualmente disponibile su macOS.');
    if (process.env.SSH_CONNECTION || process.env.SSH_TTY) throw new Error('Il push-to-talk richiede una tastiera locale; non è disponibile via SSH.');
    // Compiled modules live under dist/voice; native binaries live under dist/native.
    const compiledBinary = fileURLToPath(new URL('../native/JARVIS Voice.app/Contents/MacOS/jarvis-voice', import.meta.url));
    let executable = compiledBinary;
    try { await access(executable, constants.X_OK); }
    catch {
      // tsx development entry point still uses the compiled native helper.
      executable = fileURLToPath(new URL('../../dist/native/JARVIS Voice.app/Contents/MacOS/jarvis-voice', import.meta.url));
      try { await access(executable, constants.X_OK); }
      catch { throw new Error('Helper vocale mancante. Dalla cartella JARVIS esegui npm run build:voice (richiede Xcode Command Line Tools).'); }
    }
    const args = ['--locale', this.options.locale, '--max-seconds', String(this.options.maxSeconds)];
    if (!this.options.localOnly) args.push('--allow-network');
    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.completed = new Promise(resolve => child.once('close', () => resolve()));
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.stdin.on('error', () => {}); // The close/error events own process failure reporting.
    await new Promise<void>((resolveReady, reject) => {
      let ready = false;
      const timeout = setTimeout(() => {
        reject(new Error('Attivazione voce scaduta. Controlla i permessi macOS e riprova.'));
        void this.close();
      }, 120000);
      const events = createInterface({ input: child.stdout });
      events.on('line', line => {
        try {
          if (line.length > 32000) throw new Error('Evento vocale troppo grande.');
          const event = decodeVoiceEvent(JSON.parse(line));
          if (event.type === 'ready') { ready = true; clearTimeout(timeout); resolveReady(); }
          if (event.type === 'error' && event.fatal && !ready) { clearTimeout(timeout); reject(new Error(event.message)); }
          emit(event);
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
          emit({ type: 'error', message: (error as Error).message, fatal: true });
          void this.close();
        }
      });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('close', code => {
        clearTimeout(timeout);
        events.close();
        if (!ready) reject(new Error(`Helper vocale terminato (${code}). ${stderr}`));
        else if (!this.closing) emit({ type: 'error', message: `Helper vocale terminato (${code}); microfono spento. ${stderr}`, fatal: true });
      });
    });
  }

  record(): void { this.child?.stdin.write('start\n'); }
  cancel(): void { this.child?.stdin.write('cancel\n'); }
  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    this.closing = true;
    child.stdin.end('close\n');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await this.completed; } finally { clearTimeout(timer); this.child = undefined; }
  }
}
