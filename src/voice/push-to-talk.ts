import type { VoiceCapture, VoiceCaptureEvent } from './macos.js';
import type { Transcript } from '../providers/voice.js';

export type VoiceState = 'starting' | 'idle' | 'activating' | 'listening' | 'transcribing' | 'routing' | 'responding' | 'closed';

/** Owns one utterance at a time. Key auto-repeat cannot start a second capture. */
export class PushToTalk {
  state: VoiceState = 'starting';
  private spaceHeld = false;
  private cancelled = false;
  private pending?: Promise<void>;
  constructor(private capture: VoiceCapture, private hooks: {
    message(text: string): void;
    receive(transcript: Transcript): Promise<string | undefined>;
    speak?(text: string): Promise<void>;
    stopSpeaking?(): void;
    settled(): void;
    minConfidence: number;
  }) {}

  get busy(): boolean { return !['idle', 'closed'].includes(this.state); }

  async start(): Promise<void> {
    try { await this.capture.start(event => this.event(event)); }
    catch (error) { this.state = 'closed'; await this.capture.close(); throw error; }
  }

  press(): void {
    if (this.state !== 'idle' || this.spaceHeld) return;
    this.cancelled = false;
    this.spaceHeld = true;
    this.state = 'activating';
    this.capture.record();
  }

  private event(event: VoiceCaptureEvent): void {
    if (this.state === 'closed') return;
    switch (event.type) {
      case 'ready':
        this.state = 'idle';
        this.hooks.message('Voce pronta · microfono spento. Tieni premuto SPAZIO sul prompt vuoto; rilascia per inviare.');
        break;
      case 'released': this.spaceHeld = false; break;
      case 'listening':
        if (this.cancelled) { this.capture.cancel(); return; }
        this.state = 'listening'; this.hooks.message('● MICROFONO ACCESO · Parla tenendo premuto SPAZIO.');
        break;
      case 'transcribing':
        if (this.cancelled) return;
        this.state = 'transcribing'; this.hooks.message('Microfono spento · trascrizione in corso…');
        break;
      case 'transcript': {
        if (this.cancelled || this.state !== 'transcribing') return;
        const transcript = event.transcript;
        if (transcript.confidence !== undefined && transcript.confidence < this.hooks.minConfidence) {
          this.hooks.message(`Trascrizione incerta, NON inviata: ${transcript.text}. Riprova.`);
          this.state = 'idle'; this.hooks.settled(); return;
        }
        this.state = 'routing';
        this.pending = this.hooks.receive(transcript).then(async response => {
          if (response?.trim() && this.hooks.speak && !this.cancelled) {
            this.state = 'responding';
            this.hooks.message('JARVIS sta rispondendo a voce…');
            await this.hooks.speak(response);
          }
        }).catch(error => {
          if (!this.cancelled) this.hooks.message((error as Error).message);
        }).finally(() => {
          if (this.state !== 'closed') { this.state = 'idle'; this.hooks.settled(); }
        });
        break;
      }
      case 'cancelled':
        this.hooks.message(event.message);
        if (this.state !== 'routing') { this.state = 'idle'; this.hooks.settled(); }
        break;
      case 'error':
        this.cancelled = true;
        this.state = event.fatal ? 'closed' : 'idle';
        this.hooks.message(`${event.message} Microfono spento.`);
        this.hooks.settled();
        break;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.hooks.stopSpeaking?.();
    this.capture.cancel();
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.cancelled = true;
    this.hooks.stopSpeaking?.();
    await this.capture.close();
    await this.pending;
  }
}
