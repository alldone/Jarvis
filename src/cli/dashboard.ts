import type { AgentEvent } from '../core/types.js';
import { stripVTControlCharacters } from 'node:util';

const safe = (text: string): string => stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f]/g, ' ');
interface Row { state: 'running' | 'done' | 'error'; detail: string; preview?: string; started: number; ended?: number }
export interface DashboardOutput extends NodeJS.WritableStream { columns?: number; rows?: number }

/** A reserved header keeps the activity panel separate from the scrolling transcript. */
export class Dashboard {
  private rows = new Map<string, Row>();
  private timer?: NodeJS.Timeout;
  private active = 'codex';
  private voice = '';
  private enabled = false;
  private suspended = false;
  private lastPaint = '';
  private readonly header = 8;
  private resizeHandler = () => this.layout();

  constructor(private output: DashboardOutput, private now = Date.now) {}

  setActive(id: string): void { this.active = safe(id); this.draw(); }
  setVoice(status: string): void { this.voice = safe(status); this.draw(); }

  event(source: string, event: AgentEvent): void {
    if (source.toUpperCase() === 'JARVIS') return;
    let row = this.rows.get(source);
    if (event.type === 'status' || event.type === 'tool' || event.type === 'file-change') {
      if (!row || row.state !== 'running') row = { state: 'running', detail: '', started: this.now() };
      row.detail = event.type === 'status' ? event.status : event.type === 'tool' ? `${event.name}${event.detail ? ': ' + event.detail : ''}` : `File: ${event.path}`;
      this.rows.set(source, row);
    } else if (event.type === 'text' && row) row.preview = event.text;
    else if (event.type === 'approval' && row) row.detail = 'Autorizzazione richiesta';
    else if (event.type === 'done' || event.type === 'error') {
      row ??= { state: 'running', detail: '', started: this.now() };
      row.state = event.type === 'done' ? 'done' : 'error';
      if (event.type === 'error') row.detail = event.error.message;
      row.ended = this.now();
      this.rows.set(source, row);
    }
    this.draw();
  }

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.output.write('\x1b[?1049h\x1b[2J');
    this.output.on('resize', this.resizeHandler);
    this.layout();
    this.timer = setInterval(() => this.draw(), 125);
    this.timer.unref();
  }

  private layout(preserveCursor = false): void {
    if (!this.enabled) return;
    this.lastPaint = '';
    const height = this.output.rows ?? 24;
    if (preserveCursor) this.output.write('\x1b7');
    this.output.write('\x1b[r');
    if (height >= 14) this.output.write(`\x1b[${this.header + 1};${height}r\x1b[${this.header + 1};1H`);
    if (preserveCursor) this.output.write('\x1b8');
    this.draw();
  }

  /** Pure layout generation is tested without requiring a real terminal. */
  frames(): { source: string; column: number; lines: string[] }[] {
    const columns = this.output.columns ?? 80;
    if ((this.output.rows ?? 24) < 14 || columns < 40) return [];
    let entries: [string, Row | undefined][] = this.rows.size ? [...this.rows].slice(-2) : [[this.active, undefined]];
    if (columns < 76 && entries.length > 1) {
      entries = [entries.find(([id, row]) => id === this.active && row?.state === 'running')
        ?? entries.find(([, row]) => row?.state === 'running') ?? entries.find(([id]) => id === this.active) ?? entries[0]!];
    }
    const width = Math.min(58, Math.floor((columns - entries.length - 1) / entries.length));
    const inner = width - 4;
    const fit = (text: string) => { const value = Array.from(safe(text)); return value.length > inner ? value.slice(0, inner - 1).join('') + '…' : value.join('').padEnd(inner); };
    const box = (text: string) => `│ ${fit(text)} │`;
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'][Math.floor(this.now() / 125) % 8];
    return entries.map(([id, row], index) => {
      const seconds = row ? Math.floor(((row.ended ?? this.now()) - row.started) / 1000) : 0;
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      const state = !row ? '○ Pronto' : row.state === 'running' ? `${spinner} Al lavoro` : row.state === 'done' ? '✓ Completato' : '✗ Interrotto / errore';
      return {
        source: id,
        column: columns - width + 1 - index * (width + 1),
        lines: ['┌' + '─'.repeat(width - 2) + '┐', box(`${id.toUpperCase()}${id === this.active ? ' · AI selezionata' : ''}`),
          '├' + '─'.repeat(width - 2) + '┤', box(`${state} · ${time}`),
          box(row?.detail || 'In attesa di una richiesta'), box(row?.preview || ''),
          box(this.voice || '/status · /cancel'), '└' + '─'.repeat(width - 2) + '┘'],
      };
    });
  }

  private draw(): void {
    if (!this.enabled || this.suspended) return;
    const frames = this.frames();
    if (!frames.length) return;
    const snapshot = JSON.stringify(frames);
    if (snapshot === this.lastPaint) return;
    this.lastPaint = snapshot;
    // DEC save/restore preserves the input cursor while the header updates.
    const cleared = Array.from({ length: this.header }, (_, index) => `\x1b[${index + 1};1H\x1b[2K`).join('');
    this.output.write('\x1b7' + cleared + frames.map(frame => {
      const color = frame.source === 'codex' ? '\x1b[36m' : '\x1b[33m';
      return frame.lines.map((line, index) => `\x1b[${index + 1};${frame.column}H${color}${line}\x1b[0m`).join('');
    }).join('') + '\x1b8');
  }

  stop(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.suspended = false;
    clearInterval(this.timer);
    this.output.removeListener('resize', this.resizeHandler);
    this.output.write('\x1b[r\x1b[?1049l');
  }

  pause(): void {
    if (!this.enabled) return;
    this.suspended = true;
    clearInterval(this.timer);
    this.output.removeListener('resize', this.resizeHandler);
    this.output.write('\x1b7\x1b[r\x1b8');
  }

  resume(): void {
    if (!this.enabled) { this.start(); return; }
    if (!this.suspended) return;
    this.suspended = false;
    this.output.on('resize', this.resizeHandler);
    this.layout(true);
    this.timer = setInterval(() => this.draw(), 125);
    this.timer.unref();
  }
}
