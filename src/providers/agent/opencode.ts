import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentInput, AgentProvider, ProjectContext } from '../../core/types.js';
import type { ProviderConfig } from '../../config/config.js';
import { buildPrompt } from '../../context/context.js';
import { findBinary, ProcessRunner, type WireEvent } from './process.js';

export function opencodeDecoder(): (event: WireEvent) => AgentEvent[] {
  let session: string | undefined;
  return event => {
    if (typeof event.sessionID === 'string') {
      session ??= event.sessionID;
      if (event.sessionID !== session) return [];
    }
    if (event.type === 'error') return [{ type: 'error', error: new Error(event.error?.data?.message ?? event.error?.message ?? event.error?.name ?? 'Errore OpenCode') }];
    const part = event.part;
    if (event.type === 'step_start') return [{ type: 'status', status: 'OpenCode in elaborazione…' }];
    if (event.type === 'text' && typeof part?.text === 'string') return [{ type: 'text', text: part.text + '\n' }];
    if (event.type === 'tool_use' && typeof part?.tool === 'string') {
      const events: AgentEvent[] = [{ type: 'tool', name: part.tool, detail: part.state?.title }];
      if (part.state?.status === 'completed' && ['edit', 'write', 'apply_patch'].includes(part.tool) && typeof part.state.input?.filePath === 'string') {
        events.push({ type: 'file-change', path: part.state.input.filePath });
      }
      return events;
    }
    if (event.type === 'step_finish' && part?.reason === 'stop') return [{ type: 'done' }];
    if (event.type === 'step_finish' && ['length', 'content-filter', 'error'].includes(part?.reason)) {
      return [{ type: 'error', error: new Error(`OpenCode: risposta interrotta (${part.reason}).`) }];
    }
    return [];
  };
}

export class OpenCodeProvider implements AgentProvider {
  readonly id = 'opencode';
  readonly binary: string;
  private runner = new ProcessRunner();
  constructor(private config: ProviderConfig) { this.binary = config.binary ?? 'opencode'; }
  availability() { return findBinary(this.binary); }
  async isAvailable() { return (await this.availability()).available; }
  async startSession(context: ProjectContext) { return { id: randomUUID(), cwd: context.cwd }; }
  send(input: AgentInput): AsyncIterable<AgentEvent> {
    const edits = !input.readOnly && (input.allowEdits || this.config.sandbox === 'workspace-write' || this.config.permissionMode === 'acceptEdits');
    const permission = {
      '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow',
      ...(edits ? { edit: 'allow', bash: { '*': 'deny', 'git status*': 'allow', 'git diff*': 'allow',
        'git add *': 'allow', 'git commit*': 'allow', 'npm test*': 'allow', 'npm run test*': 'allow' } } : {}),
    };
    const inheritedConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
    const env = {
      ...process.env,
      OPENCODE_PERMISSION: JSON.stringify(permission),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...inheritedConfig, share: 'disabled', formatter: false,
        permission, agent: { 'jarvis-run': { description: 'JARVIS scoped agent', mode: 'primary', permission } } }),
      OPENCODE_AUTO_SHARE: 'false', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
    };
    const args = ['run', '--format', 'json', '--pure', '--agent', 'jarvis-run'];
    if (this.config.model) args.push('--model', this.config.model);
    return this.runner.run(this.binary, args, input.context.cwd, buildPrompt(input), opencodeDecoder(), env);
  }
  async *passthrough(): AsyncGenerator<AgentEvent> {
    yield { type: 'error', error: new Error('Per i comandi slash di OpenCode usa /native opencode.') };
  }
  nativeArgs(context: ProjectContext): string[] {
    return [context.cwd, ...(this.config.model ? ['--model', this.config.model] : [])];
  }
  interrupt() { return this.runner.interrupt(); }
  close() { return this.interrupt(); }
}
