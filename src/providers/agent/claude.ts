import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentInput, AgentProvider, ProjectContext } from '../../core/types.js';
import type { ProviderConfig } from '../../config/config.js';
import { buildPrompt, formatContext } from '../../context/context.js';
import { findBinary, ProcessRunner, type WireEvent } from './process.js';

export function claudeDecoder(): (event: WireEvent) => AgentEvent[] {
  let hasText = false;
  return event => {
    if (event.parent_tool_use_id) return [];
    if (event.type === 'system' && event.subtype === 'init') return [{ type: 'status', status: 'Sessione avviata' }];
    if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      const result: AgentEvent[] = [];
      for (const block of event.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          hasText = true;
          result.push({ type: 'text', text: block.text + '\n' });
        } else if (block.type === 'tool_use' && typeof block.name === 'string') {
          result.push({ type: 'tool', name: block.name });
        }
      }
      return result;
    }
    if (event.type === 'result') {
      const result: AgentEvent[] = [];
      if (Array.isArray(event.permission_denials) && event.permission_denials.length) {
        result.push({ type: 'approval', request: { description: 'Il provider ha negato strumenti che richiedono autorizzazione. Usa /native claude per approvarli.' } });
      }
      if (event.is_error) result.push({ type: 'error', error: new Error(event.errors?.join('\n') || event.result || 'Errore Claude') });
      else {
        if (!hasText && typeof event.result === 'string') result.push({ type: 'text', text: event.result + '\n' });
        result.push({ type: 'done' });
      }
      return result;
    }
    return [];
  };
}

export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly binary: string;
  private runner = new ProcessRunner();
  constructor(private config: ProviderConfig) { this.binary = config.binary ?? 'claude'; }
  availability() { return findBinary(this.binary); }
  async isAvailable() { return (await this.availability()).available; }
  async startSession(context: ProjectContext) { return { id: randomUUID(), cwd: context.cwd }; }
  private args(readOnly: boolean): string[] {
    const args = ['--print', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--permission-mode', readOnly ? 'dontAsk' : 'acceptEdits', '--permission-prompts', 'none'];
    if (readOnly) args.push('--tools', 'Read,Glob,Grep', '--strict-mcp-config');
    if (this.config.model) args.push('--model', this.config.model);
    return args;
  }
  send(input: AgentInput): AsyncIterable<AgentEvent> {
    return this.runner.run(this.binary, this.args(input.readOnly || this.config.permissionMode !== 'acceptEdits'),
      input.context.cwd, buildPrompt(input), claudeDecoder());
  }
  passthrough(command: string, input: AgentInput): AsyncIterable<AgentEvent> {
    const args = this.args(input.readOnly || this.config.permissionMode !== 'acceptEdits');
    const context = formatContext(input.context);
    if (context) args.push('--append-system-prompt', context);
    return this.runner.run(this.binary, args, input.context.cwd, command, claudeDecoder());
  }
  nativeArgs(context: ProjectContext): string[] {
    const args: string[] = [];
    if (this.config.model) args.push('--model', this.config.model);
    const contextText = formatContext(context);
    if (contextText) args.push('--append-system-prompt', contextText);
    return args;
  }
  interrupt() { return this.runner.interrupt(); }
  close() { return this.interrupt(); }
}
