import { readFile, appendFile, mkdir, lstat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { isMissing } from '../config/config.js';
import type { ProjectContext } from '../core/types.js';

const MAX_DOCUMENT_BYTES = 64 * 1024;
export async function loadContext(cwd: string, name?: string, provider?: string): Promise<ProjectContext> {
  const documents: Record<string, string> = {};
  const paths = ['context.md', 'architecture.md', 'decisions.md'];
  if (provider && /^[a-z][a-z0-9-]*$/.test(provider)) paths.push(`agents/${provider}.md`);
  for (const path of paths) {
    try {
      const file = resolve(cwd, '.jarvis', path);
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Contesto non regolare: ${path}`);
      if (stat.size > MAX_DOCUMENT_BYTES) throw new Error(`Contesto troppo grande: ${path} (massimo 64 KiB)`);
      documents[path] = await readFile(file, 'utf8');
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return { cwd, name: name ?? basename(cwd), documents };
}

export function formatContext(context: ProjectContext): string {
  return Object.entries(context.documents).map(([path, text]) => `--- .jarvis/${path} ---\n${text}`).join('\n\n');
}

export function buildPrompt(input: import('../core/types.js').AgentInput): string {
  return [
    'You are working through JARVIS. Follow the user request and respond in their language.',
    'Never commit, push, delete data, or perform sensitive external actions without explicit user authorization. If native approval is required, explain that the user must use /native.',
    input.readOnly ? 'This is an independent read-only analysis. Do not change files or take external actions.' : '',
    `Project: ${input.context.name}\nWorking directory: ${input.context.cwd}`,
    formatContext(input.context),
    input.history ? `Recent conversation (context only):\n${input.history}` : '',
    `User request:\n${input.prompt}`,
  ].filter(Boolean).join('\n\n');
}

export async function addContext(cwd: string, text: string): Promise<void> {
  if (!text.trim()) throw new Error('Uso: /context add <testo>');
  await mkdir(resolve(cwd, '.jarvis'), { recursive: true });
  const file = resolve(cwd, '.jarvis/context.md');
  try {
    if (!(await lstat(file)).isFile()) throw new Error('context.md deve essere un file regolare.');
  } catch (error) { if (!isMissing(error)) throw error; }
  await appendFile(file, `\n${text.trim()}\n`, { mode: 0o600 });
}
