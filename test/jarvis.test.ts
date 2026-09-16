import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, chmod, copyFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigSchema, initProject, loadConfig } from '../src/config/config.js';
import { loadContext, buildPrompt } from '../src/context/context.js';
import { parseCommand } from '../src/cli/commands.js';
import { createProviders } from '../src/providers/agent/registry.js';
import { Orchestrator } from '../src/core/orchestrator.js';
import { claudeDecoder } from '../src/providers/agent/claude.js';
import { decodeCodex } from '../src/providers/agent/codex.js';
import { cdTarget } from '../src/shell/shell.js';
import { clean, Renderer } from '../src/cli/renderer.js';
import { Application } from '../src/cli/application.js';
import { Writable } from 'node:stream';
import { VoiceInputRouter } from '../src/voice/input-router.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
async function fixture(t: test.TestContext) {
  const cwd = await mkdtemp(resolve(tmpdir(), 'jarvis-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const binary = resolve(cwd, 'provider');
  await copyFile(resolve(root, 'test/fixtures/provider.cjs'), binary);
  await chmod(binary, 0o755);
  const config = ConfigSchema.parse({ agents: { providers: { codex: { binary }, claude: { binary } } } });
  const events: { source: string; type: string }[] = [];
  const orchestrator = new Orchestrator(cwd, config, createProviders(config), (source, event) => events.push({ source, type: event.type }));
  t.after(() => orchestrator.close());
  return { cwd, binary, config, orchestrator, events };
}

test('routing preserves provider-specific commands and arguments', () => {
  assert.deepEqual(parseCommand('/claude /custom   with spaces', ['codex', 'claude']), { kind: 'request', provider: 'claude', text: '/custom   with spaces' });
  assert.deepEqual(parseCommand('/unknown hi', ['codex']), { kind: 'request', text: '/unknown hi' });
  assert.deepEqual(parseCommand('! git status', []), { kind: 'shell', text: 'git status' });
  assert.deepEqual(parseCommand('/review check this', []), { kind: 'command', name: 'review', args: 'check this' });
});

test('init is idempotent, config validates, context is scoped to its provider', async t => {
  const { cwd } = await fixture(t);
  assert.equal((await initProject(cwd)).length, 7);
  await writeFile(resolve(cwd, '.jarvis/context.md'), 'User-owned content');
  assert.equal((await initProject(cwd)).length, 0);
  assert.equal((await loadConfig(cwd)).version, 1);
  await writeFile(resolve(cwd, '.jarvis/agents/codex.md'), 'Codex-only instruction');
  await writeFile(resolve(cwd, '.jarvis/agents/claude.md'), 'Claude-only instruction');
  const context = await loadContext(cwd, undefined, 'codex');
  const prompt = buildPrompt({ prompt: 'Controlla', context });
  assert.match(prompt, /User-owned content/);
  assert.match(prompt, /Codex-only instruction/);
  assert.doesNotMatch(prompt, /Claude-only instruction/);
  await writeFile(resolve(cwd, '.jarvis/jarvis.yml'), 'version: 99');
  await assert.rejects(loadConfig(cwd), /Configurazione non valida/);
});

test('symlinks and oversized context documents are rejected', async t => {
  const { cwd } = await fixture(t);
  await mkdir(resolve(cwd, '.jarvis'));
  await symlink(resolve(cwd, 'provider'), resolve(cwd, '.jarvis/context.md'));
  await assert.rejects(loadContext(cwd), /non regolare/);
  await rm(resolve(cwd, '.jarvis/context.md'));
  await writeFile(resolve(cwd, '.jarvis/context.md'), 'a'.repeat(65537));
  await assert.rejects(loadContext(cwd), /troppo grande/);
});

test('real subprocess adapters stream without duplicate result text', async t => {
  const { orchestrator, events } = await fixture(t);
  assert.equal(await orchestrator.run('Ciao'), 'Risultato Codex di prova.\n');
  assert.equal(await orchestrator.run('Hello', 'claude'), 'Risultato Claude di prova.\n');
  assert.equal(events.filter(event => event.type === 'text').length, 2);
  assert.equal(events.filter(event => event.type === 'done').length, 2);
});

test('review runs primary, independent read-only reviewer and read-only synthesis sequentially', async t => {
  const { orchestrator, events } = await fixture(t);
  const calls: { id: string; input: any }[] = [];
  for (const [id, provider] of orchestrator.providers) {
    const original = provider.send.bind(provider);
    provider.send = input => { calls.push({ id, input }); return original(input); };
  }
  await orchestrator.run('Previous conversation');
  calls.length = 0;
  await orchestrator.review('Controlla il progetto');
  assert.deepEqual(calls.map(call => call.id), ['codex', 'claude', 'codex']);
  assert.equal(calls[1]!.input.readOnly, true);
  assert.equal(calls[1]!.input.history, undefined);
  assert.equal(calls[2]!.input.readOnly, true);
  assert.match(calls[1]!.input.prompt, /Risultato Codex/);
  assert.match(calls[2]!.input.prompt, /Risultato Claude/);
  assert.equal(events.filter(event => event.type === 'done').length, 4);
});

test('review checks missing second provider before starting primary', async t => {
  const { orchestrator } = await fixture(t);
  orchestrator.providers.get('claude')!.availability = async () => ({ available: false, detail: 'Missing Claude' });
  let started = false;
  orchestrator.providers.get('codex')!.send = async function* () { started = true; yield { type: 'done' }; };
  await assert.rejects(orchestrator.review('Task'), /Missing Claude/);
  assert.equal(started, false);
  assert.equal(orchestrator.busy, false);
});

test('failures release task lock and next requests remain usable', async t => {
  const { orchestrator } = await fixture(t);
  for (const mode of ['SIMULATE_EXIT', 'SIMULATE_BAD_JSON', 'SIMULATE_INCOMPLETE', 'SIMULATE_ERROR']) {
    if (mode === 'SIMULATE_ERROR') await assert.rejects(orchestrator.run(mode), /provider failure/);
    else await assert.rejects(orchestrator.run(mode));
    assert.equal(orchestrator.busy, false);
    assert.match(await orchestrator.run('Try again'), /Risultato/);
  }
});

test('cancellation stops the subprocess and concurrent requests are rejected', async t => {
  const { orchestrator } = await fixture(t);
  let ready!: () => void;
  const started = new Promise<void>(resolveReady => { ready = resolveReady; });
  const provider = orchestrator.providers.get('codex')!;
  const send = provider.send.bind(provider);
  provider.send = async function* (input) {
    for await (const event of send(input)) { if (event.type === 'status') ready(); yield event; }
  };
  const running = orchestrator.run('SIMULATE_HANG');
  const rejected = assert.rejects(running, /annullata/);
  await started;
  await assert.rejects(orchestrator.run('Concurrent'), /già in corso/);
  await orchestrator.interrupt();
  await rejected;
  assert.match(await orchestrator.run('After cancellation'), /Risultato/);
});

test('missing binaries are detected independently; routing fallback is opt-in', async t => {
  const { cwd, config } = await fixture(t);
  config.agents.providers.codex!.binary = resolve(cwd, 'not-installed');
  config.agents.autoRouting = true;
  const orchestrator = new Orchestrator(cwd, config, createProviders(config), () => {});
  t.after(() => orchestrator.close());
  const availability = await orchestrator.availability();
  assert.equal(availability.find(item => item.id === 'codex')!.available, false);
  assert.equal(availability.find(item => item.id === 'claude')!.available, true);
  assert.match(await orchestrator.run('Ciao'), /Claude/);
  await assert.rejects(orchestrator.run('Ciao', 'codex'), /non trovato/);
});

test('passthrough preserves raw slash input and Codex reports unsupported native commands', async t => {
  const { orchestrator } = await fixture(t);
  const provider = orchestrator.providers.get('claude')!;
  let received = '';
  const passthrough = provider.passthrough!.bind(provider);
  provider.passthrough = (command, input) => { received = command; return passthrough(command, input); };
  await orchestrator.run('/my-skill hello  world', 'claude');
  assert.equal(received, '/my-skill hello  world');
  await assert.rejects(orchestrator.run('/model', 'codex'), /native codex/);
});

test('decoder handles errors, tool calls, file changes, and permission denial', () => {
  const decode = claudeDecoder();
  assert.equal(decode({ type: 'result', is_error: true, errors: ['denied'] })[0]!.type, 'error');
  assert.equal(decode({ type: 'result', permission_denials: [{ tool_name: 'Bash' }] })[0]!.type, 'approval');
  assert.equal(decodeCodex({ type: 'item.started', item: { type: 'command_execution', command: 'pwd' } })[0]!.type, 'tool');
  assert.deepEqual(decodeCodex({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'file.ts' }] } }), [{ type: 'file-change', path: 'file.ts' }]);
});

test('standalone cd supports spaces and rejects compound shell syntax', () => {
  assert.equal(cdTarget('cd "a b"'), 'a b');
  assert.equal(cdTarget('pwd'), undefined);
  assert.throws(() => cdTarget('cd a && pwd'), /separato/);
  assert.throws(() => cdTarget('cd $(bad)'), /separato/);
  assert.equal(clean('\x1b[31mtext\x1b[0m\x07'), 'text');
});

test('application confirms shell commands and preserves cwd across requests', async t => {
  const { cwd, config } = await fixture(t);
  const other = resolve(cwd, 'other project');
  await mkdir(other);
  let asked = 0;
  let executed = 0;
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const app = new Application(cwd, config, new Renderer(output), {
    interactive: false,
    confirm: async () => { asked++; return false; },
    inherit: async () => { executed++; return 0; },
  });
  t.after(() => app.orchestrator.close());
  await app.execute('! touch must-not-exist');
  assert.equal(asked, 1);
  assert.equal(executed, 0);
  await app.execute('! cd "other project"');
  assert.equal(app.orchestrator.cwd, await realpath(other));
  await app.execute('/status');
  assert.equal(app.orchestrator.cwd, await realpath(other));
  await assert.rejects(app.execute('/btw additional information'), /NON inviata/);
});

test('provider commands select a persistent agent with or without an initial request', async t => {
  const { cwd, config } = await fixture(t);
  let output = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  const app = new Application(cwd, config, new Renderer(stream), {
    interactive: false, confirm: async () => false, inherit: async () => 0,
  });
  t.after(() => app.orchestrator.close());
  await app.execute('/claude');
  assert.equal(app.orchestrator.active, 'claude');
  await app.execute('Controlla il progetto');
  assert.match(output, /AI destinataria: claude/);
  await app.execute('/codex Ciao');
  assert.equal(app.orchestrator.active, 'codex');
  await app.execute('Continua');
  assert.match(output, /AI destinataria: codex/);
});

test('voice reuses the selected agent; explicit spoken switches persist for both input modes', async t => {
  const { orchestrator } = await fixture(t);
  let voiceReadOnly: boolean | undefined;
  let voiceAllowEdits: boolean | undefined;
  const claude = orchestrator.providers.get('claude')!;
  const send = claude.send.bind(claude);
  claude.send = input => { voiceReadOnly = input.readOnly; voiceAllowEdits = input.allowEdits; return send(input); };
  const events: string[] = [];
  const voice = new VoiceInputRouter(orchestrator, (_source, event) => {
    if (event.type === 'status') events.push(event.status);
  });
  await orchestrator.use('claude');
  assert.match((await voice.accept({ text: 'Controlla il codice' }))!, /Claude/);
  assert.equal(voiceReadOnly, false);
  assert.equal(voiceAllowEdits, true);
  assert.equal(orchestrator.active, 'claude');
  assert.match((await voice.accept({ text: 'Codex, controlla il codice' }))!, /Codex/);
  assert.equal(orchestrator.active, 'codex');
  assert.match(await orchestrator.run('Continua da tastiera'), /Codex/);
  assert.equal(await voice.accept({ text: 'usa Claude' }), undefined);
  assert.equal(orchestrator.active, 'claude');
  assert.match((await voice.accept({ text: 'Confronta Codex e Claude' }))!, /Claude/);
  assert.match(events.join('\n'), /Voce: Controlla il codice/);
});

test('voice edit mode gives Claude scoped file and local git tools', async t => {
  const { cwd, orchestrator } = await fixture(t);
  const log = resolve(cwd, 'provider-calls.jsonl');
  const previous = process.env.JARVIS_TEST_LOG;
  process.env.JARVIS_TEST_LOG = log;
  t.after(() => {
    if (previous === undefined) delete process.env.JARVIS_TEST_LOG;
    else process.env.JARVIS_TEST_LOG = previous;
  });
  await orchestrator.use('claude');
  const voice = new VoiceInputRouter(orchestrator, () => {});
  await voice.accept({ text: 'Aggiungi Hello World in fondo al README e fai un commit locale' });
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { args: string[] });
  const args = calls.at(-1)!.args;
  const allowed = args.slice(args.indexOf('--allowedTools') + 1);
  assert.ok(args.includes('--allowedTools'));
  assert.ok(allowed.includes('Read'));
  assert.ok(allowed.includes('Edit'));
  assert.ok(allowed.includes('Write'));
  assert.ok(allowed.includes('Bash(git add *)'));
  assert.ok(allowed.includes('Bash(git commit *)'));
  assert.ok(!allowed.some(tool => tool.includes('push')));
});

test('explicit selection never silently falls back to a different agent', async t => {
  const { orchestrator } = await fixture(t);
  orchestrator.config.agents.autoRouting = true;
  await orchestrator.use('claude');
  orchestrator.providers.get('claude')!.availability = async () => ({ available: false, detail: 'Claude missing now' });
  await assert.rejects(orchestrator.run('Hello'), /Claude missing now/);
  assert.equal(orchestrator.active, 'claude');
});

test('built CLI starts outside its installation, accepts piped commands, and requires a terminal for voice', async t => {
  const { cwd } = await fixture(t);
  const cli = resolve(root, 'bin/jarvis.js');
  const version = await exec(process.execPath, [cli, '--version'], { cwd });
  assert.equal(version.stdout.trim(), '0.1.0');
  await exec(process.execPath, [cli, 'init'], { cwd });
  assert.equal((await loadConfig(cwd)).version, 1);
  const child = spawn(process.execPath, [cli], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const completed = new Promise(resolveCode => child.once('close', resolveCode));
  child.stdin.end('/status\n/help\n/exit\n');
  assert.equal(await completed, 0);
  assert.match(output, /Stato: pronto/);
  assert.match(output, /comandi/);
  await assert.rejects(exec(process.execPath, [cli, '--voice'], { cwd }), /terminale interattivo/);
  await assert.rejects(exec(process.execPath, [cli, '--live'], { cwd }), /Live mode non ancora/);
});
