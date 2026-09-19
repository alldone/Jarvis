import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isMissing } from '../config/config.js';

const agent = z.string().regex(/^[a-z][a-z0-9-]*$/);
export const ConversationSchema = z.object({
  active: agent,
  explicitlySelected: z.boolean(),
  history: z.record(agent, z.string().max(24000)),
});
export type ConversationState = z.infer<typeof ConversationSchema>;
const SessionSchema = z.object({
  version: z.literal(1), id: z.string().uuid(), cwd: z.string(),
  title: z.string().min(1).max(120),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
  conversation: ConversationSchema,
  transcript: z.string().max(2_000_000),
});
export type SavedSession = z.infer<typeof SessionSchema>;
export type SessionSummary = Pick<SavedSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>;
const uuidFile = /^[0-9a-f-]{36}\.json$/;

/** Per-directory sessions, atomically replaced and protected against stale writers. */
export class SessionManager {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly cwd: string) {}
  private get directory(): string { return resolve(this.cwd, '.jarvis/sessions'); }

  private async checkDirectory(create: boolean): Promise<boolean> {
    for (const directory of [resolve(this.cwd, '.jarvis'), this.directory]) {
      if (create) {
        try { await mkdir(directory, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Directory sessioni non regolare: ${directory}`);
      } catch (error) { if (isMissing(error) && !create) return false; throw error; }
    }
    return true;
  }

  private async read(id: string): Promise<SavedSession> {
    if (!z.string().uuid().safeParse(id).success) throw new Error('ID sessione non valido.');
    const path = resolve(this.directory, `${id}.json`);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16_000_000) throw new Error(`File sessione non valido: ${id}`);
    const parsed = SessionSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
    if (!parsed.success || parsed.data.id !== id) throw new Error(`Sessione danneggiata: ${id}`);
    if (parsed.data.cwd !== await realpath(this.cwd)) throw new Error(`La sessione ${id} appartiene a un'altra cartella.`);
    return parsed.data;
  }

  async list(): Promise<SessionSummary[]> {
    if (!await this.checkDirectory(false)) return [];
    const result: SessionSummary[] = [];
    for (const name of await readdir(this.directory)) {
      if (!uuidFile.test(name)) continue;
      const { id, title, createdAt, updatedAt } = await this.read(name.slice(0, -5));
      result.push({ id, title, createdAt, updatedAt });
    }
    return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
  }

  async load(selector: string): Promise<SavedSession> {
    if (!/^[0-9a-f-]{4,36}$/.test(selector) && selector !== 'last') throw new Error('Usa un ID sessione (anche abbreviato) oppure last.');
    const sessions = await this.list();
    const matches = selector === 'last' ? sessions.slice(0, 1) : sessions.filter(session => session.id.startsWith(selector));
    if (matches.length !== 1) throw new Error(matches.length ? 'ID ambiguo: specifica più caratteri.' : 'Sessione non trovata in questa cartella.');
    return this.read(matches[0]!.id);
  }

  async create(conversation: ConversationState, title = 'Nuova sessione'): Promise<SavedSession> {
    const now = new Date().toISOString();
    return SessionSchema.parse({ version: 1, id: randomUUID(), cwd: await realpath(this.cwd), title,
      createdAt: now, updatedAt: now, revision: 0, conversation, transcript: '' });
  }

  save(session: SavedSession): Promise<void> {
    const operation = this.queue.then(() => this.write(session));
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async write(session: SavedSession): Promise<void> {
    await this.checkDirectory(true);
    // Also protect projects that have never run `jarvis init`.
    const ignore = resolve(this.directory, '.gitignore');
    try { await writeFile(ignore, '*\n', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const checked = SessionSchema.parse(session);
    if (checked.cwd !== await realpath(this.cwd)) throw new Error('Sessione di una cartella diversa.');
    const lockPath = resolve(this.directory, `${checked.id}.lock`);
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Sessione in scrittura da un altro processo. Riprova tra poco.');
      throw error;
    }
    const temporary = resolve(this.directory, `${checked.id}.${randomUUID()}.tmp`);
    try {
      let previous: SavedSession | undefined;
      try { previous = await this.read(checked.id); } catch (error) { if (!isMissing(error)) throw error; }
      if ((previous?.revision ?? 0) !== checked.revision) throw new Error('Sessione aggiornata da un altro Jarvis. Usa /session fork per salvare separatamente il lavoro corrente.');
      const updatedAt = new Date().toISOString();
      await writeFile(temporary, JSON.stringify({ ...checked, updatedAt, revision: checked.revision + 1 }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, resolve(this.directory, `${checked.id}.json`));
      session.revision = checked.revision + 1;
      session.updatedAt = updatedAt;
    } finally {
      await unlink(temporary).catch(error => { if (!isMissing(error)) throw error; });
      await lock.close();
      await unlink(lockPath);
    }
  }
}
