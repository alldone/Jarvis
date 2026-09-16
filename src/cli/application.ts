import { loadConfig, type Config } from '../config/config.js';
import { addContext, formatContext, loadContext } from '../context/context.js';
import { Orchestrator } from '../core/orchestrator.js';
import { createProviders } from '../providers/agent/registry.js';
import { cdTarget, changeDirectory, runInherited, runShell } from '../shell/shell.js';
import { HELP, parseCommand } from './commands.js';
import { Renderer } from './renderer.js';

export interface TerminalAccess {
  confirm(message: string): Promise<boolean>;
  inherit(task: () => Promise<number>, keepTranscript?: boolean): Promise<number>;
  interactive: boolean;
}

export class Application {
  orchestrator: Orchestrator;
  private handling = false;
  get busy(): boolean { return this.handling || this.orchestrator.busy; }
  constructor(cwd: string, config: Config, readonly renderer: Renderer, readonly terminal: TerminalAccess) {
    this.orchestrator = this.makeOrchestrator(cwd, config);
  }
  private makeOrchestrator(cwd: string, config: Config): Orchestrator {
    return new Orchestrator(cwd, config, createProviders(config), (source, event) => {
      this.renderer.setActive(this.orchestrator.active);
      this.renderer.event(source, event);
    });
  }

  async agents(): Promise<void> {
    const rows = await this.orchestrator.availability();
    if (!rows.length) this.renderer.message('Nessun provider abilitato.');
    for (const row of rows) this.renderer.message(`${row.id.padEnd(8)} ${row.available ? '✓' : '✗'} ${row.detail}`);
  }
  async banner(): Promise<void> {
    this.renderer.message(`v0.1.0 · ${this.orchestrator.cwd}`);
    await this.agents();
    this.renderer.message(`Agente attivo: ${this.orchestrator.active}. /help per i comandi.`);
  }

  async execute(line: string): Promise<boolean> {
    const command = parseCommand(line, new Set(['codex', 'claude', ...this.orchestrator.providers.keys()]));
    if (command.kind === 'empty') return true;
    if (command.kind === 'command' && command.name === 'cancel') {
      await this.orchestrator.interrupt();
      this.renderer.message('Interruzione richiesta.');
      return true;
    }
    if (command.kind === 'command' && command.name === 'status') {
      this.renderer.message(`Directory: ${this.orchestrator.cwd}\nAgente: ${this.orchestrator.active}\nStato: ${this.orchestrator.busy ? 'in esecuzione' : 'pronto'}`);
      return true;
    }
    if (command.kind === 'command' && command.name === 'btw') {
      throw new Error('Istruzione NON inviata: /btw sarà disponibile nella v0.2. Attendi e inviala come nuova richiesta.');
    }
    if (this.busy) throw new Error('Operazione in corso: il nuovo input NON è stato inviato. Usa /cancel o attendi.');
    this.handling = true;
    try {
      const orchestrator = this.orchestrator;
      if (command.kind === 'request') {
        if (command.provider && !command.text) await orchestrator.use(command.provider);
        else await orchestrator.run(command.text, command.provider);
        return true;
      }
      if (command.kind === 'shell') {
        if (!orchestrator.config.shell.enabled) throw new Error('Shell disabilitata nella configurazione.');
        if (!command.text) throw new Error('Uso: ! <comando>');
        const destination = cdTarget(command.text);
        if (destination !== undefined) {
          const cwd = await changeDirectory(orchestrator.cwd, destination);
          const config = await loadConfig(cwd);
          const next = this.makeOrchestrator(cwd, config);
          await orchestrator.close();
          this.orchestrator = next;
          this.renderer.message(`Directory: ${cwd}. Configurazione ricaricata; conversazione azzerata.`);
          return true;
        }
        if (orchestrator.config.shell.confirmDestructive && !await this.terminal.confirm(`Eseguire in ${orchestrator.cwd}: ${command.text}?`)) {
          this.renderer.message('Comando annullato.');
          return true;
        }
        const code = await this.terminal.inherit(() => runShell(command.text, orchestrator.cwd), true);
        if (code !== 0) throw new Error(`Shell terminata con codice ${code}.`);
        return true;
      }
      switch (command.name) {
        case 'use':
          await orchestrator.use(command.args);
          break;
        case 'agents': await this.agents(); break;
        case 'review': await orchestrator.review(command.args); break;
        case 'help': this.renderer.message(HELP); break;
        case 'clear': orchestrator.resetHistory(); this.renderer.message('Conversazione in memoria cancellata.'); break;
        case 'context': {
          if (command.args.startsWith('add ')) {
            await addContext(orchestrator.cwd, command.args.slice(4));
            this.renderer.message('Contesto aggiornato.');
          } else if (!command.args || command.args === 'refresh') {
            const context = await loadContext(orchestrator.cwd, orchestrator.config.project.name, orchestrator.active);
            this.renderer.message(command.args ? 'Contesto riletto. Viene ricaricato anche a ogni richiesta.' : formatContext(context) || 'Nessun contesto. Esegui jarvis init oppure /context add <testo>.');
          } else throw new Error('Uso: /context [add <testo>|refresh]');
          break;
        }
        case 'native': {
          if (!this.terminal.interactive) throw new Error('/native richiede un terminale interattivo.');
          const provider = await orchestrator.requireProvider(command.args || orchestrator.active);
          await orchestrator.use(provider.id);
          const context = await loadContext(orchestrator.cwd, orchestrator.config.project.name, provider.id);
          this.renderer.message(`Apro ${provider.id}. Usa i comandi slash e le approvazioni della CLI; uscendo tornerai a JARVIS.`);
          // Codex has no separate context argument for the native TUI: provide a startup prompt.
          const args = provider.nativeArgs(context);
          if (provider.id === 'codex' && Object.keys(context.documents).length) {
            args.push(`Read this project context and wait for the user's next request:\n${formatContext(context)}`);
          }
          const code = await this.terminal.inherit(() => runInherited(provider.binary, args, orchestrator.cwd));
          if (code !== 0) throw new Error(`${provider.id} terminato con codice ${code}.`);
          this.renderer.message('Sessione nativa terminata.');
          break;
        }
        case 'debate': throw new Error('/debate è previsto nella v0.2; usa /review per una revisione incrociata.');
        case 'exit': case 'quit': return false;
      }
      return true;
    } finally { this.handling = false; }
  }
}
