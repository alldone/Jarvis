import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent } from '../core/types.js';
import type { Dashboard } from './dashboard.js';

export const clean = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
export class Renderer {
  constructor(private output: NodeJS.WritableStream = process.stdout, private dashboard?: Dashboard) {}
  setActive(id: string): void { this.dashboard?.setActive(id); }
  message(text: string, source = 'JARVIS'): void { this.output.write(`${source.toUpperCase()} › ${clean(text)}\n`); }
  event(source: string, event: AgentEvent): void {
    this.dashboard?.event(source, event);
    switch (event.type) {
      case 'text': this.message(event.text.trimEnd(), source); break;
      case 'status': this.message(event.status, source); break;
      case 'tool': this.message(`⚙ ${event.name}${event.detail ? `: ${event.detail}` : ''}`, source); break;
      case 'file-change': this.message(`Modificato: ${event.path}`, source); break;
      case 'approval': this.message(event.request.description, source); break;
      // The command boundary renders failures once and keeps the REPL alive.
      case 'error': case 'done': break;
    }
  }
}
