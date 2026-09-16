import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

const provider = z.object({
  enabled: z.boolean().default(true),
  binary: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  sandbox: z.enum(['read-only', 'workspace-write']).default('read-only'),
  permissionMode: z.enum(['default', 'acceptEdits']).default('default'),
});
export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  project: z.object({ name: z.string().optional() }).default({}),
  agents: z.object({
    default: z.string().min(1).default('codex'),
    autoRouting: z.boolean().default(false),
    providers: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), provider).default({
      codex: provider.parse({}), claude: provider.parse({}),
    }),
  }).prefault({}),
  orchestration: z.object({
    reviewProvider: z.string().default('claude'),
    preventConcurrentFileWrites: z.boolean().default(true),
    autoReview: z.boolean().default(false),
  }).prefault({}),
  shell: z.object({ enabled: z.boolean().default(true), confirmDestructive: z.boolean().default(true) }).prefault({}),
  voice: z.object({
    enabled: z.boolean().default(false),
    allowEdits: z.boolean().default(true),
    language: z.object({ input: z.string().default('it-IT') }).passthrough().prefault({}),
    stt: z.object({ provider: z.literal('apple').default('apple'), localOnly: z.boolean().default(true) }).prefault({}),
    pushToTalk: z.object({ shortcut: z.literal('Space').default('Space'), maxSeconds: z.number().min(1).max(120).default(45), minConfidence: z.number().min(0).max(1).default(0.45) }).prefault({}),
  }).passthrough().prefault({}),
});
export type Config = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof provider>;

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export async function loadConfig(cwd: string): Promise<Config> {
  const file = resolve(cwd, '.jarvis/jarvis.yml');
  try {
    const config = ConfigSchema.parse(parse(await readFile(file, 'utf8')) ?? {});
    if (config.orchestration.autoReview) throw new Error('autoReview non disponibile nella v0.1: usa /review.');
    return config;
  } catch (error) {
    if (isMissing(error)) return ConfigSchema.parse({});
    throw new Error(`Configurazione non valida (${file}): ${(error as Error).message}`);
  }
}

export async function initProject(cwd: string): Promise<string[]> {
  await mkdir(resolve(cwd, '.jarvis/agents'), { recursive: true });
  const config = ConfigSchema.parse({ project: { name: basename(cwd) } });
  const files: Record<string, string> = {
    'jarvis.yml': stringify(config),
    'context.md': '# Contesto del progetto\n\nDescrivi obiettivi, stack e convenzioni. Non inserire credenziali.\n',
    'architecture.md': '# Architettura\n\nDescrivi componenti e vincoli.\n',
    'decisions.md': '# Decisioni tecniche\n',
    'agents/codex.md': '# Istruzioni per Codex\n',
    'agents/claude.md': '# Istruzioni per Claude\n',
    '.gitignore': 'sessions/\ncache/\naudio/\n',
  };
  const created: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    try {
      await writeFile(resolve(cwd, '.jarvis', name), content, { flag: 'wx', mode: 0o600 });
      created.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  return created;
}
