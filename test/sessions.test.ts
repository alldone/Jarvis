import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionManager, type ConversationState } from '../src/core/session-manager.js';
import { Questions } from '../src/cli/questions.js';

const state: ConversationState = { active: 'codex', explicitlySelected: true, history: { codex: 'Previous request and answer' } };
async function folder(t: test.TestContext) {
  const cwd = await mkdtemp(resolve(tmpdir(), 'jarvis-sessions-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test('sessions persist context and transcript, stay project-local and reject stale writers', async t => {
  const cwd = await folder(t);
  const manager = new SessionManager(cwd);
  assert.deepEqual(await manager.list(), []);
  const session = await manager.create(state, 'API work');
  session.transcript = 'TU › hello\nCODEX › world\n';
  await manager.save(session);
  const next = new SessionManager(cwd);
  const restored = await next.load(session.id.slice(0, 8));
  assert.deepEqual(restored, session);
  restored.title = 'Renamed';
  await next.save(restored);
  await assert.rejects(manager.save(session), /aggiornata da un altro/);
  assert.equal((await manager.load('last')).title, 'Renamed');
  assert.equal(await readFile(resolve(cwd, '.jarvis/sessions/.gitignore'), 'utf8'), '*\n');
  if (process.platform !== 'win32') assert.equal((await stat(resolve(cwd, `.jarvis/sessions/${session.id}.json`))).mode & 0o777, 0o600);
  const other = new SessionManager(await folder(t));
  assert.deepEqual(await other.list(), []);
  await assert.rejects(other.save(session), /cartella diversa/);
  await assert.rejects(manager.load('../session'), /ID sessione/);
});

test('sessions refuse corrupted files and symlinked storage', async t => {
  const cwd = await folder(t);
  const manager = new SessionManager(cwd);
  const session = await manager.create(state);
  await manager.save(session);
  await writeFile(resolve(cwd, `.jarvis/sessions/${session.id}.json`), '{');
  await assert.rejects(manager.list());
  if (process.platform !== 'win32') {
    const other = await folder(t);
    await mkdir(resolve(other, '.jarvis'));
    await symlink(resolve(cwd, '.jarvis/sessions'), resolve(other, '.jarvis/sessions'));
    await assert.rejects(new SessionManager(other).list(), /non regolare/);
  }
});

test('questions validate choices, handle free text, cancel and never submit invalid input', async () => {
  const displayed: string[] = [];
  let prompts = 0;
  const questions = new Questions(text => displayed.push(text), () => { prompts++; });
  const choice = questions.ask('How many?', ['Two', 'Three']);
  assert.equal(questions.pending, true);
  questions.accept('hello'); questions.accept('3'); questions.accept('');
  assert.equal(questions.pending, true);
  questions.accept('2');
  assert.equal(await choice, '2');
  assert.equal(prompts, 4);
  const text = questions.ask('Request?');
  questions.accept('Compare architectures');
  assert.equal(await text, 'Compare architectures');
  const cancelled = questions.ask('Next?');
  questions.accept('/cancel');
  assert.equal(await cancelled, undefined);
  assert.equal(questions.accept('ordinary request'), false);
});
