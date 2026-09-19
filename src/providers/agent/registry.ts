import type { Config } from '../../config/config.js';
import type { AgentProvider } from '../../core/types.js';
import { CodexProvider } from './codex.js';
import { ClaudeProvider } from './claude.js';
import { OpenCodeProvider } from './opencode.js';

export function createProviders(config: Config): Map<string, AgentProvider> {
  const factories = { codex: CodexProvider, claude: ClaudeProvider, opencode: OpenCodeProvider };
  const providers = new Map<string, AgentProvider>();
  for (const [id, settings] of Object.entries(config.agents.providers)) {
    if (!settings.enabled) continue;
    const Factory = factories[id as keyof typeof factories];
    if (!Factory) throw new Error(`Provider non registrato: ${id}`);
    providers.set(id, new Factory(settings));
  }
  return providers;
}
