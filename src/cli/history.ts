import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { DashboardOutput } from './dashboard.js';

/** A bounded, memory-only transcript; never writes prompts or responses to disk. */
export class Transcript {
  private entries: string[] = [];
  private size = 0;
  constructor(private limit = 2_000_000) {}
  append(text: string): void {
    const entry = text.slice(-this.limit);
    this.entries.push(entry);
    this.size += entry.length;
    while (this.size > this.limit && this.entries.length > 1) this.size -= this.entries.shift()!.length;
  }
  text(): string { return this.entries.join(''); }
  replace(text: string): void { this.entries = []; this.size = 0; if (text) this.append(text); }
}

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function cellWidth(text: string): number {
  if (/^\p{Mark}+$/u.test(text)) return 0;
  const cp = text.codePointAt(0)!;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)
    || cp >= 0x1100 && (cp <= 0x115f || cp >= 0x2e80 && cp <= 0xa4cf
      || cp >= 0xac00 && cp <= 0xd7a3 || cp >= 0xf900 && cp <= 0xfaff
      || cp >= 0xfe10 && cp <= 0xfe6f || cp >= 0xff01 && cp <= 0xff60
      || cp >= 0xffe0 && cp <= 0xffe6 || cp >= 0x20000) ? 2 : 1;
}

export function wrapTranscript(text: string, columns: number): string[] {
  const width = Math.max(2, columns);
  const result: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')) {
    let row = '', used = 0;
    for (const { segment } of segments.segment(line.replace(/\t/g, '    '))) {
      const cells = cellWidth(segment);
      if (used + cells > width) { result.push(row); row = ''; used = 0; }
      row += segment; used += cells;
    }
    result.push(row);
  }
  return result;
}

/** Read-only viewport. The snapshot stays still while agents continue working. */
export class HistoryView {
  active = false;
  private snapshot = '';
  private lines: string[] = [];
  private top = 0;
  private paintedHeight = 1;
  constructor(private output: DashboardOutput, private onClose: () => void) {}
  private get height(): number { return Math.max(1, (this.output.rows ?? 24) - 2); }
  private get width(): number { return Math.max(2, (this.output.columns ?? 80) - 2); }
  private get last(): number { return Math.max(0, this.lines.length - this.height); }
  open(text: string): void {
    if (this.active) return;
    this.active = true;
    this.snapshot = text;
    this.lines = wrapTranscript(text, this.width);
    this.top = this.last;
    this.output.on('resize', this.resize);
    this.output.write('\x1b[r\x1b[?25l\x1b[?1000h\x1b[?1006h');
    this.draw();
  }
  private resize = () => {
    const previousLast = Math.max(0, this.lines.length - this.paintedHeight);
    const ratio = previousLast ? this.top / previousLast : 1;
    this.lines = wrapTranscript(this.snapshot, this.width);
    this.top = Math.round(ratio * this.last);
    this.draw();
  };
  handle(key: string): boolean {
    if (!this.active) return false;
    if (['q', '\x1b', '\x03'].includes(key)) { this.close(); return true; }
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(key);
    if (mouse) {
      const button = Number(mouse[1]) & ~28; // Ignore Shift/Alt/Ctrl modifiers.
      if (button === 64) this.top -= 3;
      else if (button === 65) this.top += 3;
      else if (button === 0 && mouse[4] === 'M' && Number(mouse[2]) >= this.width + 1) {
        this.top = Math.round((Number(mouse[3]) - 2) / Math.max(1, this.height - 1) * this.last);
      }
    } else if (['\x1b[5~', 'b'].includes(key)) this.top -= this.height;
    else if (['\x1b[6~', ' ', 'f'].includes(key)) this.top += this.height;
    else if (['\x1b[A', '\x1bOA', 'k'].includes(key)) this.top--;
    else if (['\x1b[B', '\x1bOB', 'j', '\r'].includes(key)) this.top++;
    else if (['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~', 'g'].includes(key)) this.top = 0;
    else if (['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~', 'G'].includes(key)) this.top = this.last;
    this.top = Math.max(0, Math.min(this.last, this.top));
    this.draw();
    return true;
  }
  private draw(): void {
    this.paintedHeight = this.height;
    const thumbSize = Math.max(1, Math.round(this.height * Math.min(1, this.height / this.lines.length)));
    const thumbStart = this.last ? Math.round(this.top / this.last * (this.height - thumbSize)) : 0;
    const fit = (text: string) => wrapTranscript(text, this.width)[0] ?? '';
    let frame = '\x1b[H\x1b[2J' + fit('Cronologia · ↑↓ PgUp/PgDn · rotella · Home/End · q/Esc esci');
    for (let i = 0; i < this.height; i++) {
      frame += `\x1b[${i + 2};1H${this.lines[this.top + i] ?? ''}`;
      frame += `\x1b[${i + 2};${this.width + 1}H${i >= thumbStart && i < thumbStart + thumbSize ? '█' : '│'}`;
    }
    const end = Math.min(this.lines.length, this.top + this.height);
    frame += `\x1b[${this.height + 2};1H${fit(`${this.top + 1}–${end}/${this.lines.length} · ${Math.round(end / this.lines.length * 100)}% · istantanea; i task continuano`)}`;
    this.output.write(frame);
  }
  close(restore = true): void {
    if (!this.active) return;
    this.active = false;
    this.output.removeListener('resize', this.resize);
    this.output.write('\x1b[?1000l\x1b[?1006l\x1b[?25h');
    if (restore) this.onClose();
  }
}

/** Route wheel input even before the history view is open; never leak mouse reports into prompts. */
export function navigateHistory(view: HistoryView, key: string, open: () => void): boolean {
  if (view.handle(key)) return true;
  const mouse = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(key);
  if (key === '\x1b[5~' || (mouse && (Number(mouse[1]) & ~28) === 64 && mouse[2] === 'M')) {
    open();
    view.handle(mouse ? '\x1b[<64;1;1M' : key);
    return true;
  }
  return Boolean(mouse);
}

/** Decode terminal sequences before readline, including sequences split across chunks. */
export class NavigationInput extends PassThrough {
  readonly isTTY: boolean;
  private pending = '';
  private decoder = new StringDecoder('utf8');
  private escapeTimer?: NodeJS.Timeout;
  constructor(private source: NodeJS.ReadStream, private consume: (key: string) => boolean) {
    super();
    this.isTTY = Boolean(source.isTTY);
    source.on('data', this.data);
    source.on('end', this.ended);
  }
  private data = (chunk: Buffer) => {
    clearTimeout(this.escapeTimer);
    this.pending += this.decoder.write(chunk);
    while (this.pending) {
      let key: string;
      if (this.pending.startsWith('\x1b')) {
        const match = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|[^\[O])/s.exec(this.pending);
        if (!match) {
          this.escapeTimer = setTimeout(() => {
            const rest = this.pending; this.pending = '';
            if (!this.consume(rest)) this.write(rest);
          }, 50);
          return;
        }
        key = match[0];
      } else key = String.fromCodePoint(this.pending.codePointAt(0)!);
      this.pending = this.pending.slice(key.length);
      if (!this.consume(key)) this.write(key);
    }
  };
  private ended = () => { this.end(); };
  setRawMode(mode: boolean): this { this.source.setRawMode(mode); return this; }
  detach(): void {
    clearTimeout(this.escapeTimer);
    this.source.removeListener('data', this.data);
    this.source.removeListener('end', this.ended);
    this.source.pause();
    this.destroy();
  }
}
