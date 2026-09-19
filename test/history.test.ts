import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { HistoryView, NavigationInput, navigateHistory, Transcript, wrapTranscript } from '../src/cli/history.js';
import { Renderer } from '../src/cli/renderer.js';
import { Dashboard } from '../src/cli/dashboard.js';

test('transcript is bounded and renderer retains output while viewing history', () => {
  const transcript = new Transcript(10);
  transcript.append('12345'); transcript.append('67890'); transcript.append('abc');
  assert.equal(transcript.text(), '67890abc');
  transcript.append('012345678901234');
  assert.equal(transcript.text(), '5678901234');
  let output = '';
  const renderer = new Renderer(new Writable({ write(c, _e, done) { output += c; done(); } }));
  renderer.suspended = true;
  renderer.message('\x1b[2Janswer', 'codex');
  assert.equal(output, '');
  assert.equal(renderer.transcript.text(), 'CODEX › answer\n');
});

test('history wraps long lines, tabs, emoji and wide characters without losing text', () => {
  assert.deepEqual(wrapTranscript('abcdefgh\nx\ty', 4), ['abcd', 'efgh', 'x   ', ' y']);
  assert.deepEqual(wrapTranscript('你好ab👩‍💻e\u0301', 4), ['你好', 'ab👩‍💻', 'e\u0301']);
});

test('history scrolls with pages, wheel and scrollbar, handles resize and restores terminal modes', () => {
  let output = '', restored = 0;
  const stream = Object.assign(new Writable({ write(c, _e, done) { output += c; done(); } }), { columns: 80, rows: 10 });
  const view = new HistoryView(stream, () => { restored++; });
  view.open(Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
  assert.match(output, /93–100\/100/);
  assert.match(output, /█/);
  output = ''; view.handle('\x1b[5~');
  assert.match(output, /85–92\/100/);
  output = ''; view.handle('\x1b[<64;20;5M');
  assert.match(output, /82–89\/100/);
  output = ''; view.handle('\x1b[H');
  assert.match(output, /1–8\/100/);
  output = ''; view.handle('\x1b[<0;79;9M');
  assert.match(output, /93–100\/100/);
  stream.columns = 45; stream.rows = 15; output = ''; stream.emit('resize');
  assert.match(output, /88–100\/100/);
  view.handle('q');
  assert.equal(restored, 1);
  assert.equal(view.active, false);
  assert.equal(stream.listenerCount('resize'), 0);
  assert.ok(output.endsWith('\x1b[?1000l\x1b[?1006l\x1b[?25h'));
});

test('wheel opens agent logs directly, consumes clicks and preserves new output on return', () => {
  let output = '';
  const stream = Object.assign(new Writable({ write(c, _e, done) { output += c; done(); } }), { columns: 80, rows: 24 });
  const dashboard = new Dashboard(stream);
  const renderer = new Renderer(stream, dashboard);
  const view = new HistoryView(stream, () => {
    renderer.suspended = false;
    dashboard.restoreTranscript(wrapTranscript(renderer.transcript.text(), 79));
  });
  const open = () => {
    renderer.suspended = true;
    dashboard.pause();
    view.open(renderer.transcript.text());
  };
  dashboard.start();
  assert.ok(output.includes('\x1b[?1000h\x1b[?1006h'));
  for (let i = 0; i < 80; i++) renderer.message(`log ${i}`, i % 2 ? 'codex' : 'JARVIS');
  output = '';
  assert.equal(navigateHistory(view, '\x1b[<64;20;12M', open), true);
  assert.equal(view.active, true);
  assert.match(output, /JARVIS › log/);
  assert.match(output, /CODEX › log/);
  assert.match(output, /█/);
  output = '';
  renderer.event('opencode', { type: 'text', text: 'new answer while scrolling' });
  assert.equal(output, '');
  navigateHistory(view, 'q', open);
  assert.match(output, /OPENCODE › new answer while scrolling/);
  assert.ok(output.includes('\x1b[?1000h\x1b[?1006h'));
  assert.equal(navigateHistory(view, '\x1b[<0;20;12M', open), true);
  assert.equal(navigateHistory(view, '\x1b[<65;20;12M', open), true);
  assert.equal(view.active, false);
  assert.equal(navigateHistory(view, 'a', open), false);
  // A blocked history opener (e.g. during a confirmation) must still swallow mouse reports.
  navigateHistory(view, '\x1b[<64;20;12M', () => {});
  assert.equal(view.active, false);
  output = ''; dashboard.pause();
  assert.ok(output.includes('\x1b[?1000l\x1b[?1006l'));
  output = ''; dashboard.resume();
  assert.ok(output.includes('\x1b[?1000h\x1b[?1006h'));
  output = ''; dashboard.stop();
  assert.ok(output.includes('\x1b[?1000l\x1b[?1006l'));
});

test('navigation reassembles fragmented escape and Unicode input and preserves ordinary input', async () => {
  const source = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const keys: string[] = [];
  const input = new NavigationInput(source as unknown as NodeJS.ReadStream, key => {
    if (key.startsWith('\x1b')) { keys.push(key); return true; }
    return false;
  });
  let passed = '';
  input.on('data', chunk => { passed += chunk; });
  source.write('ciao'); source.write('\x1b['); source.write('5~');
  source.write('\x1b[<64;'); source.write('12;4M');
  const unicode = Buffer.from('è');
  source.write(unicode.subarray(0, 1)); source.write(unicode.subarray(1));
  source.write('\x1b');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(passed, 'ciaoè');
  assert.deepEqual(keys, ['\x1b[5~', '\x1b[<64;12;4M', '\x1b']);
  input.detach();
  assert.equal(source.listenerCount('data'), 0);
});

test('leaving history repaints recent output and restores agent panels and scroll region', () => {
  let output = '';
  const stream = Object.assign(new Writable({ write(c, _e, done) { output += c; done(); } }), { columns: 80, rows: 24 });
  const dashboard = new Dashboard(stream);
  dashboard.start(); dashboard.pause();
  dashboard.event('codex', { type: 'text', text: 'arrived while reading' });
  output = '';
  dashboard.restoreTranscript(['old answer', 'arrived while reading']);
  assert.match(output, /\x1b\[9;24r/);
  assert.match(output, /old answer\r\narrived while reading/);
  dashboard.stop();
  assert.equal(stream.listenerCount('resize'), 0);
});
