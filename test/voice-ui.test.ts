import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { PushToTalk } from '../src/voice/push-to-talk.js';
import { classifyVoiceInput } from '../src/voice/terminal-input.js';
import { decodeVoiceEvent, type VoiceCapture, type VoiceCaptureEvent } from '../src/voice/macos.js';
import { Dashboard } from '../src/cli/dashboard.js';
import { ConfigSchema } from '../src/config/config.js';
import { speechText } from '../src/voice/speech-output.js';

class FakeCapture implements VoiceCapture {
  emit: (event: VoiceCaptureEvent) => void = () => {};
  recordings = 0;
  cancellations = 0;
  async start(emit: (event: VoiceCaptureEvent) => void) { this.emit = emit; emit({ type: 'ready' }); }
  record() { this.recordings++; this.emit({ type: 'listening' }); }
  cancel() { this.cancellations++; this.emit({ type: 'cancelled', message: 'cancelled' }); }
  async close() {}
}

function setup(receive = async (_text: string) => {}) {
  const capture = new FakeCapture();
  const messages: string[] = [];
  const received: string[] = [];
  const ptt = new PushToTalk(capture, {
    minConfidence: 0.45,
    message: text => messages.push(text),
    receive: async transcript => { received.push(transcript.text); await receive(transcript.text); },
    settled() {},
  });
  return { capture, ptt, messages, received };
}

test('Space opens one capture and dispatches once, only after release and transcription', async () => {
  const { capture, ptt, received } = setup();
  await ptt.start();
  ptt.press(); ptt.press(); ptt.press();
  assert.equal(capture.recordings, 1);
  assert.equal(ptt.state, 'listening');
  capture.emit({ type: 'transcript', transcript: { text: 'too early' } });
  assert.deepEqual(received, []);
  capture.emit({ type: 'released' });
  capture.emit({ type: 'transcribing' });
  capture.emit({ type: 'transcript', transcript: { text: 'Controlla i test', confidence: 0.9 } });
  capture.emit({ type: 'transcript', transcript: { text: 'duplicate' } });
  assert.deepEqual(received, ['Controlla i test']);
  await ptt.close();
});

test('cancellation rejects late transcripts and requires a physical release before another recording', async () => {
  const { capture, ptt, received } = setup();
  await ptt.start();
  ptt.press(); ptt.cancel(); ptt.press();
  assert.equal(capture.recordings, 1);
  capture.emit({ type: 'transcribing' });
  capture.emit({ type: 'transcript', transcript: { text: 'must not send' } });
  assert.deepEqual(received, []);
  capture.emit({ type: 'released' });
  ptt.press();
  assert.equal(capture.recordings, 2);
  await ptt.close();
});

test('uncertain speech is visible but never sent', async () => {
  const { capture, ptt, messages, received } = setup();
  await ptt.start(); ptt.press();
  capture.emit({ type: 'released' }); capture.emit({ type: 'transcribing' });
  capture.emit({ type: 'transcript', transcript: { text: 'delete something', confidence: 0.1 } });
  assert.deepEqual(received, []);
  assert.match(messages.join('\n'), /NON inviata/);
  assert.equal(ptt.state, 'idle');
  await ptt.close();
});

test('a completed voice answer is spoken once and can be interrupted', async () => {
  const capture = new FakeCapture();
  const spoken: string[] = [];
  let stopCalls = 0;
  let finish!: () => void;
  const speechDone = new Promise<void>(resolve => { finish = resolve; });
  const ptt = new PushToTalk(capture, {
    minConfidence: 0,
    message() {},
    receive: async () => 'The answer is ready.',
    speak: async text => { spoken.push(text); await speechDone; },
    stopSpeaking: () => { stopCalls++; finish(); },
    settled() {},
  });
  await ptt.start(); ptt.press();
  capture.emit({ type: 'released' }); capture.emit({ type: 'transcribing' });
  capture.emit({ type: 'transcript', transcript: { text: 'Answer me' } });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(spoken, ['The answer is ready.']);
  assert.equal(ptt.state, 'responding');
  ptt.cancel();
  assert.equal(stopCalls, 1);
  await ptt.close();
});

test('recognition failures unlock recording but do not retrigger while Space remains held', async () => {
  const { capture, ptt } = setup();
  await ptt.start(); ptt.press();
  capture.emit({ type: 'error', message: 'timeout', fatal: false });
  ptt.press();
  assert.equal(capture.recordings, 1);
  capture.emit({ type: 'released' }); ptt.press();
  assert.equal(capture.recordings, 2);
  capture.emit({ type: 'error', message: 'helper exited', fatal: true });
  ptt.press();
  assert.equal(ptt.state, 'closed');
  assert.equal(capture.recordings, 2);
  await ptt.close();
});

test('closing rejects all later events and waits for an already dispatched request', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const { capture, ptt, received } = setup(() => pending);
  await ptt.start(); ptt.press();
  capture.emit({ type: 'released' }); capture.emit({ type: 'transcribing' });
  capture.emit({ type: 'transcript', transcript: { text: 'one' } });
  let closed = false;
  const closing = ptt.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  capture.emit({ type: 'transcript', transcript: { text: 'late' } });
  finish(); await closing;
  assert.deepEqual(received, ['one']);
  assert.equal(ptt.state, 'closed');
});

test('Space remains ordinary input within text, confirmations, and native sessions', () => {
  const idle = { enabled: true, busy: false, capturing: false, empty: true, confirming: false };
  assert.equal(classifyVoiceInput(' ', idle), 'space');
  assert.equal(classifyVoiceInput(' ', { ...idle, empty: false }), 'pass');
  assert.equal(classifyVoiceInput(' ', { ...idle, confirming: true }), 'pass');
  assert.equal(classifyVoiceInput(' ', { ...idle, enabled: false }), 'pass');
  assert.equal(classifyVoiceInput(' ', { ...idle, busy: true }), 'ignore');
  assert.equal(classifyVoiceInput('a sentence with spaces', idle), 'pass');
  assert.equal(classifyVoiceInput('\x1b[200~ pasted text\x1b[201~', idle), 'pass');
  assert.equal(classifyVoiceInput('\x03', { ...idle, capturing: true }), 'cancel');
  assert.equal(classifyVoiceInput('\x1b', { ...idle, capturing: true }), 'cancel');
});

test('voice protocol validates transcripts and confidence', () => {
  assert.throws(() => decodeVoiceEvent({ type: 'transcript', text: '' }), /non valida/);
  assert.throws(() => decodeVoiceEvent({ type: 'unexpected' }), /sconosciuto/);
  const event = decodeVoiceEvent({ type: 'transcript', text: 'hello', confidence: 0.8 });
  assert.equal(event.type, 'transcript');
  if (event.type === 'transcript') assert.equal(event.transcript.confidence, 0.8);
  assert.equal(ConfigSchema.parse({}).voice.pushToTalk.shortcut, 'Space');
  assert.equal(ConfigSchema.parse({}).voice.stt.localOnly, true);
});

test('speech output removes markup and bounds content before synthesis', () => {
  assert.equal(speechText('# Result\n\n`file.ts` is fixed.\n\n```ts\nsecret();\n```\nSee https://example.com'), 'Result file.ts is fixed. See link');
  assert.equal(speechText('  hello   world  ', 5), 'hello');
});

test('independent agent panels grow from the upper right towards the left', () => {
  const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { columns: 120, rows: 30 });
  let now = 0;
  const ui = new Dashboard(stream, () => now);
  ui.event('codex', { type: 'status', status: 'Analisi' });
  ui.event('codex', { type: 'tool', name: 'shell', detail: 'npm test' });
  now = 12000;
  ui.event('claude', { type: 'status', status: 'Revisione' });
  const frames = ui.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.source, 'codex');
  assert.ok(frames[0]!.column > frames[1]!.column);
  assert.ok(frames[1]!.column + frames[1]!.lines[0]!.length < frames[0]!.column);
  assert.match(frames[0]!.lines.join('\n'), /0:12/);
  assert.match(frames[0]!.lines.join('\n'), /npm test/);
  ui.event('codex', { type: 'text', text: 'All tests passed' });
  ui.event('codex', { type: 'done' });
  now = 25000;
  assert.match(ui.frames()[0]!.lines.join('\n'), /0:12/);
  assert.match(ui.frames()[0]!.lines.join('\n'), /All tests passed/);
  assert.match(ui.frames()[1]!.lines.join('\n'), /0:13/);
});

test('panels adapt to small terminals and strip escape sequences from provider data', () => {
  const stream = Object.assign(new Writable({ write(_chunk, _encoding, done) { done(); } }), { columns: 60, rows: 24 });
  const ui = new Dashboard(stream);
  ui.event('codex', { type: 'status', status: 'old' });
  ui.event('codex', { type: 'done' });
  ui.event('claude', { type: 'status', status: '\x1b[2Jworking' });
  const frames = ui.frames();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.source, 'claude');
  assert.doesNotMatch(frames[0]!.lines.join('\n'), /\x1b/);
  assert.ok(frames[0]!.lines.every(line => Array.from(line).length <= 58));
  stream.rows = 10;
  assert.deepEqual(ui.frames(), []);
});

test('dashboard restores the terminal screen and scroll region on shutdown', () => {
  let output = '';
  const stream = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }), { columns: 120, rows: 30 });
  const ui = new Dashboard(stream);
  ui.start();
  assert.match(output, /\x1b\[\?1049h/);
  assert.match(output, /\x1b\[9;30r/);
  ui.stop();
  assert.ok(output.endsWith('\x1b[r\x1b[?1049l'));
  assert.equal(stream.listenerCount('resize'), 0);
});

test('shell handoff keeps output on the same screen and restores the input cursor', () => {
  let output = '';
  const stream = Object.assign(new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } }), { columns: 120, rows: 30 });
  const ui = new Dashboard(stream);
  ui.start(); output = '';
  ui.pause();
  assert.doesNotMatch(output, /1049/);
  assert.equal(stream.listenerCount('resize'), 0);
  ui.resume();
  assert.doesNotMatch(output, /1049/);
  assert.match(output, /\x1b7\x1b\[r\x1b\[9;30r\x1b\[9;1H\x1b8/);
  ui.stop();
});
