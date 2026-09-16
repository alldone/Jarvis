import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentInput, AgentProvider, ProjectContext } from '../../core/types.js';
import type { ProviderConfig } from '../../config/config.js';
import { buildPrompt } from '../../context/context.js';
import { findBinary, ProcessRunner, type WireEvent } from './process.js';

export function decodeCodex(event: WireEvent): AgentEvent[] {
  const item = event.item;
  if (event.type === 'turn.completed') return [{ type: 'done' }];
  if (event.type === 'turn.failed' || event.type === 'error') {
    return [{ type: 'error', error: new Error(event.error?.message ?? event.message ?? 'Errore Codex') }];
  }
  if (event.type === 'thread.started') return [{ type: 'status', status: 'Sessione avviata' }];
  if (event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
    return [{ type: 'text', text: item.text + '\n' }];
  }
  if (event.type === 'item.started' && item?.type === 'command_execution') {
    return [{ type: 'tool', name: 'shell', detail: item.command }];
  }
  if (event.type === 'item.completed' && item?.type === 'file_change' && Array.isArray(item.changes)) {
    return item.changes.filter((change: WireEvent) => typeof change.path === 'string')
      .map((change: WireEvent) => ({ type: 'file-change', path: change.path }));
  }
  return [];
}

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly binary: string;
  private runner = new ProcessRunner();
  constructor(private config: ProviderConfig) { this.binary = config.binary ?? 'codex'; }
  availability() { return findBinary(this.binary); }
  async isAvailable() { return (await this.availability()).available; }
  async startSession(context: ProjectContext) { return { id: randomUUID(), cwd: context.cwd }; }
  send(input: AgentInput): AsyncIterable<AgentEvent> {
    const args = ['-a', 'never', 'exec', '--json', '--ephemeral', '--skip-git-repo-check',
      '--sandbox', input.readOnly ? 'read-only' : this.config.sandbox, '--color', 'never'];
    if (this.config.model) args.push('--model', this.config.model);
    args.push('-');
    return this.runner.run(this.binary, args, input.context.cwd, buildPrompt(input), decodeCodex);
  }
  async *passthrough(): AsyncGenerator<AgentEvent> {
    yield { type: 'error', error: new Error('Codex exec non esegue comandi slash interattivi. Usa /native codex e inserisci il comando nella CLI originale.') };
  }
  nativeArgs(context: ProjectContext): string[] {
    const args = ['--cd', context.cwd, '--ask-for-approval', 'on-request', '--sandbox', 'workspace-write'];
    if (this.config.model) args.push('--model', this.config.model);
    return args;
  }
  interrupt() { return this.runner.interrupt(); }
  close() { return this.interrupt(); }
}
