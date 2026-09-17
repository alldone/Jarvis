import { stripVTControlCharacters } from 'node:util';
import type { AgentEvent } from '../core/types.js';
import type { Dashboard } from './dashboard.js';

export const clean = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
const COLORS: Record<string, string> = { JARVIS: '\x1b[1;35m', CODEX: '\x1b[36m', CLAUDE: '\x1b[33m' };

/** Colors only real terminals, honouring the NO_COLOR and FORCE_COLOR conventions. */
export function supportsColor(output: NodeJS.WritableStream, env = process.env): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== '0';
  return Boolean((output as NodeJS.WriteStream).isTTY) && env.TERM !== 'dumb';
}

export class Renderer {
  private color: boolean;
  constructor(private output: NodeJS.WritableStream = process.stdout, private dashboard?: Dashboard, color = supportsColor(output)) {
    this.color = color;
  }
  setActive(id: string): void { this.dashboard?.setActive(id); }
  message(text: string, source = 'JARVIS'): void {
    const label = clean(source.toUpperCase());
    const prefix = this.color ? `${COLORS[label] ?? '\x1b[1m'}${label} ›\x1b[0m` : `${label} ›`;
    this.output.write(`${prefix} ${clean(text)}\n`);
  }
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
