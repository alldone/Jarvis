import { PassThrough } from 'node:stream';

export interface InputState {
  enabled: boolean;
  busy: boolean;
  capturing: boolean;
  empty: boolean;
  confirming: boolean;
}

export function classifyVoiceInput(text: string, state: InputState): 'pass' | 'space' | 'cancel' | 'ignore' {
  if (!state.enabled || state.confirming) return 'pass';
  if (state.capturing) return text.includes('\x03') || text === '\x1b' ? 'cancel' : 'ignore';
  if (/^ +$/.test(text) && state.empty) return state.busy ? 'ignore' : 'space';
  return 'pass';
}

/** Filter before readline so voice activation never inserts spaces into the prompt. */
export class VoiceTerminalInput extends PassThrough {
  readonly isTTY: boolean;
  constructor(private source: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode(mode: boolean): unknown }, private classify: (text: string) => ReturnType<typeof classifyVoiceInput>, private onSpace: () => void, private onCancel: () => void) {
    super();
    this.isTTY = Boolean(source.isTTY);
    source.on('data', this.data);
    source.on('end', this.ended);
  }
  private data = (chunk: Buffer) => {
    switch (this.classify(chunk.toString('utf8'))) {
      case 'space': this.onSpace(); break;
      case 'cancel': this.onCancel(); break;
      case 'ignore': break;
      case 'pass': this.write(chunk); break;
    }
  };
  private ended = () => { this.end(); };
  setRawMode(mode: boolean): this { this.source.setRawMode(mode); return this; }
  detach(): void {
    this.source.removeListener('data', this.data);
    this.source.removeListener('end', this.ended);
    this.source.pause();
    this.destroy();
  }
}
