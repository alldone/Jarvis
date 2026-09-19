import { loadConfig, type Config } from '../config/config.js';
import { addContext, formatContext, loadContext } from '../context/context.js';
import { Orchestrator } from '../core/orchestrator.js';
import { createProviders } from '../providers/agent/registry.js';
import { cdTarget, changeDirectory, runInherited, runShell } from '../shell/shell.js';
import { HELP, parseCommand, suggestCommand } from './commands.js';
import { Renderer, clean } from './renderer.js';
import { VERSION } from './version.js';
import { SessionManager, type SavedSession } from '../core/session-manager.js';

export interface TerminalAccess {
  confirm(message: string): Promise<boolean>;
  inherit(task: () => Promise<number>, keepTranscript?: boolean): Promise<number>;
  interactive: boolean;
  history?(): void;
  ask?(question: string, options?: string[]): Promise<string | undefined>;
}

export class Application {
  orchestrator: Orchestrator;
  private handling = false;
  private initialized?: Promise<void>;
  private sessions: SessionManager;
  session?: SavedSession;
  get busy(): boolean { return this.handling || this.orchestrator.busy; }
  constructor(cwd: string, config: Config, readonly renderer: Renderer, readonly terminal: TerminalAccess) {
    this.orchestrator = this.makeOrchestrator(cwd, config);
    this.sessions = new SessionManager(cwd);
  }
  initialize(): Promise<void> {
    return this.initialized ??= this.loadSession();
  }
  private async loadSession(): Promise<void> {
    if (!this.orchestrator.config.sessions.enabled) return;
    const available = this.orchestrator.config.sessions.autoResume ? await this.sessions.list() : [];
    this.session = available.length ? await this.sessions.load(available[0]!.id)
      : await this.sessions.create(this.orchestrator.snapshot());
    this.orchestrator.restore(this.session.conversation);
    this.renderer.transcript.replace(clean(this.session.transcript));
  }
  async saveSession(): Promise<void> {
    if (!this.session) return;
    this.session.conversation = this.orchestrator.snapshot();
    this.session.transcript = this.renderer.transcript.text();
    await this.sessions.save(this.session);
  }
  private sessionLabel(): string {
    return this.session ? `${this.session.id.slice(0, 8)} · ${this.session.title}` : 'temporanea (salvataggio disattivato)';
  }
  private async manageSession(args: string): Promise<void> {
    if (!this.orchestrator.config.sessions.enabled) throw new Error('Sessioni disattivate: imposta sessions.enabled: true.');
    const [action = '', ...rest] = args.trim().split(/\s+/);
    const value = rest.join(' ');
    if (!action) { this.renderer.message(`Sessione: ${this.sessionLabel()}`); return; }
    if (action === 'new' || action === 'fork') {
      if (value.length > 120) throw new Error('Il nome deve contenere al massimo 120 caratteri.');
      if (action === 'new') await this.saveSession();
      const state = this.orchestrator.snapshot();
      if (action === 'new') state.history = {};
      this.session = await this.sessions.create(state, value || 'Nuova sessione');
      this.orchestrator.restore(state);
      if (action === 'new') this.renderer.transcript.replace('');
    } else if (action === 'resume') {
      let selector = value;
      if (!selector && this.terminal.ask) {
        const sessions = await this.sessions.list();
        if (!sessions.length) throw new Error('Nessuna sessione salvata in questa cartella.');
        const choice = await this.terminal.ask('Quale sessione vuoi riprendere?', sessions.map(s => `${s.id.slice(0, 8)} · ${s.title} · ${s.updatedAt}`));
        if (!choice) return;
        selector = sessions[Number(choice) - 1]!.id;
      }
      if (!selector) throw new Error('Uso: /session resume <id|last>');
      const next = await this.sessions.load(selector);
      if (next.id === this.session?.id) { this.renderer.message(`Sessione già attiva: ${this.sessionLabel()}`); return; }
      await this.saveSession();
      this.session = next;
      this.orchestrator.restore(next.conversation);
      this.renderer.transcript.replace(clean(next.transcript));
    } else if (action === 'rename' && value) {
      if (value.length > 120) throw new Error('Il nome deve contenere al massimo 120 caratteri.');
      this.session!.title = value;
    } else throw new Error('Uso: /session [new [nome]|fork [nome]|resume <id|last>|rename <nome>]');
    this.renderer.setActive(this.orchestrator.active);
    this.renderer.message(`Sessione: ${this.sessionLabel()}. /history per la cronologia.`);
  }
  private async debate(args: string): Promise<void> {
    const explicit = /^--agents\s+(\S+)\s+([\s\S]+)$/.exec(args);
    let request = explicit?.[2] ?? args;
    let participants = explicit?.[1]?.split(',');
    if (args.startsWith('--agents') && !explicit) throw new Error('Uso: /debate --agents codex,claude,opencode <richiesta>');
    if (this.terminal.ask && !participants) {
      if (!request.trim()) {
        const answer = await this.terminal.ask('Qual è la richiesta da discutere?');
        if (!answer) { this.renderer.message('Debate annullato.'); return; }
        request = answer;
      }
      const available = (await this.orchestrator.availability()).filter(p => p.available).map(p => p.id);
      if (available.length < 2) throw new Error('Il debate richiede almeno due provider disponibili.');
      const counts = Array.from({ length: available.length - 1 }, (_, i) => i + 2);
      const choice = await this.terminal.ask('Quante AI vuoi nel debate?', counts.map(n => `${n} AI · ${n} analisi + 1 sintesi`));
      if (!choice) { this.renderer.message('Debate annullato.'); return; }
      const count = counts[Number(choice) - 1]!;
      if (count === available.length) participants = available;
      else {
        const groups: string[][] = [];
        const select = (start: number, group: string[]) => {
          if (group.length === count) { groups.push(group); return; }
          for (let i = start; i < available.length; i++) select(i + 1, [...group, available[i]!]);
        };
        select(0, []);
        const selected = await this.terminal.ask('Quali AI partecipano?', groups.map(group => group.join(' + ')));
        if (!selected) { this.renderer.message('Debate annullato.'); return; }
        participants = groups[Number(selected) - 1]!;
      }
    }
    await this.orchestrator.debate(request, participants);
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
    await this.initialize();
    this.renderer.message(`v${VERSION} · ${this.orchestrator.cwd}`);
    await this.agents();
    this.renderer.message(`Agente attivo: ${this.orchestrator.active}. /help per i comandi.`);
    this.renderer.message(`Sessione: ${this.sessionLabel()}. /sessions per l'elenco.`);
  }

  async execute(line: string): Promise<boolean> {
    await this.initialize();
    const providerIds = new Set(['codex', 'claude', 'opencode', ...this.orchestrator.providers.keys()]);
    const command = parseCommand(line, providerIds);
    if (command.kind === 'empty') return true;
    if (command.kind === 'command' && command.name === 'history') {
      if (!this.terminal.history) throw new Error('/history richiede un terminale interattivo.');
      this.terminal.history();
      return true;
    }
    if (command.kind === 'request' && !command.provider && command.text.startsWith('/')) {
      const name = /^\/(\S+)/.exec(command.text)![1]!;
      const suggestion = suggestCommand(name, providerIds);
      if (suggestion) {
        throw new Error(`Comando /${name} NON inviato: forse intendevi /${suggestion}? Per inoltrarlo comunque: /${this.orchestrator.active} ${command.text}`);
      }
    }
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
      this.renderer.transcript.append(`TU › ${clean(line)}\n`);
      const orchestrator = this.orchestrator;
      if (command.kind === 'request') {
        if (this.session?.title === 'Nuova sessione' && command.text) this.session.title = clean(command.text).replace(/\s+/g, ' ').slice(0, 120);
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
          await this.saveSession();
          const previousManager = this.sessions;
          const previousSession = this.session;
          this.sessions = new SessionManager(cwd);
          const previous = this.orchestrator;
          this.orchestrator = next;
          this.session = undefined;
          try { await this.loadSession(); }
          catch (error) {
            this.orchestrator = previous; this.sessions = previousManager; this.session = previousSession;
            throw error;
          }
          await orchestrator.close();
          if (!this.session) this.renderer.transcript.replace('');
          this.renderer.message(`Directory: ${cwd}. Sessione: ${this.sessionLabel()}.`);
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
          if (!command.args.trim()) throw new Error(`Uso: /use <agente>. Abilitati: ${[...orchestrator.providers.keys()].join(', ') || 'nessuno'}.`);
          await orchestrator.use(command.args.trim());
          break;
        case 'agents': await this.agents(); break;
        case 'sessions': {
          const sessions = await this.sessions.list();
          this.renderer.message(sessions.length ? sessions.map(s => `${s.id === this.session?.id ? '*' : ' '} ${s.id.slice(0, 8)} · ${s.title} · ${s.updatedAt}`).join('\n') : 'Nessuna sessione salvata in questa cartella.');
          break;
        }
        case 'session': await this.manageSession(command.args); break;
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
        case 'debate': await this.debate(command.args); break;
        case 'exit': case 'quit': return false;
      }
      return true;
    } finally {
      try { await this.saveSession(); }
      finally { this.handling = false; }
    }
  }
}
