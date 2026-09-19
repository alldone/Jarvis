import { createInterface, type Interface } from 'node:readline';
import type { Config } from '../config/config.js';
import { Application, type TerminalAccess } from './application.js';
import { Renderer, clean } from './renderer.js';
import { complete } from './commands.js';
import { Dashboard } from './dashboard.js';
import { PushToTalk } from '../voice/push-to-talk.js';
import { MacOSVoiceCapture } from '../voice/macos.js';
import { VoiceInputRouter } from '../voice/input-router.js';
import { VoiceTerminalInput, classifyVoiceInput } from '../voice/terminal-input.js';
import { MacOSSayOutput } from '../voice/speech-output.js';
import { HistoryView, NavigationInput, navigateHistory, wrapTranscript } from './history.js';
import { Questions } from './questions.js';

/** off: silent text mode · auto: voice when possible, text fallback · required: voice or exit. */
export type VoiceMode = 'off' | 'auto' | 'required';

async function askWorkspaceTrust(config: Config, cwd: string, rl: Interface, renderer: Renderer, interactive: boolean, autoApprove: boolean): Promise<void> {
  if (!interactive) return;
  const answer = autoApprove ? 's' : await new Promise<string>(resolve => {
    rl.question(`Autorizzi Jarvis a scrivere nella cartella corrente?\n  ${cwd}\n[s/N] `, resolve);
  });
  const trusted = /^(s|si|sì|y|yes)$/i.test(answer.trim());
  if (trusted) {
    for (const settings of Object.values(config.agents.providers)) {
      settings.sandbox = 'workspace-write';
      settings.permissionMode = 'acceptEdits';
    }
    renderer.message('Cartella autorizzata: agenti in modalità read-write per questa sessione.');
  } else {
    renderer.message('Cartella non autorizzata: agenti in sola lettura.');
  }
}

export async function runRepl(cwd: string, config: Config, yes = false, agent?: string, voiceMode: VoiceMode = config.voice.enabled ? 'auto' : 'off'): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (voiceMode === 'required' && !interactive) throw new Error('--voice richiede un terminale interattivo locale.');
  // Voice is macOS-only today: elsewhere the default quietly means text mode; --voice still reports why.
  const voiceEnabled = interactive && (voiceMode === 'required' || (voiceMode === 'auto' && process.platform === 'darwin'));
  const dashboard = interactive && process.env.TERM !== 'dumb' ? new Dashboard(process.stdout) : undefined;
  const renderer = new Renderer(process.stdout, dashboard);
  let inherited = false;
  let closed = false;
  let historyReady = false;
  let confirmation: ((answer: boolean) => void) | undefined;
  let voice: PushToTalk | undefined;
  let speech: MacOSSayOutput | undefined;
  const questions = new Questions(text => renderer.message(text), () => {
    rl.setPrompt('risposta> '); rl.prompt();
  });
  const history = dashboard ? new HistoryView(process.stdout, () => {
    renderer.suspended = false;
    const lines = wrapTranscript(renderer.transcript.text().trimEnd(), Math.max(2, (process.stdout.columns ?? 80) - 1));
    dashboard.restoreTranscript(lines);
    if (!closed && !inherited) prompt(true);
  }) : undefined;
  const openHistory = () => {
    if (!historyReady || !history || history.active || inherited || confirmation || questions.pending || voice?.busy) return;
    renderer.suspended = true;
    dashboard?.pause();
    history.open(renderer.transcript.text());
  };
  const navigation = dashboard ? new NavigationInput(process.stdin, key => {
    if (inherited) return false;
    if (questions.pending && (key === '\x1b' || key === '\x03')) { questions.cancel(); return true; }
    if (history && navigateHistory(history, key, openHistory)) return true;
    return false;
  }) : undefined;
  const source = navigation ?? process.stdin;
  const input = voiceEnabled ? new VoiceTerminalInput(source, text => classifyVoiceInput(text, {
    enabled: !inherited && voice?.state !== 'closed',
    busy: app.busy || Boolean(voice?.busy),
    capturing: Boolean(voice && ['activating', 'listening', 'transcribing', 'starting', 'responding'].includes(voice.state)),
    empty: !rl.line.trim(), confirming: Boolean(confirmation) || questions.pending,
  }), () => voice?.press(), () => voice?.cancel()) : source;
  // Readline's recall list stays in memory; project session persistence is separate.
  const rl: Interface = createInterface({
    input, output: process.stdout, terminal: interactive, prompt: 'jarvis> ',
    historySize: interactive ? 200 : 0, removeHistoryDuplicates: true,
    completer: interactive ? (line: string) => complete(line, app.orchestrator.providers.keys()) : undefined,
  });
  rl.on('close', () => { closed = true; });
  const terminal: TerminalAccess = {
    interactive,
    history: history ? openHistory : undefined,
    ask: interactive ? (question, options) => questions.ask(question, options) : undefined,
    async confirm(message) {
      if (yes) return true;
      if (!interactive) throw new Error('Conferma shell richiesta: usa un terminale oppure --yes per autorizzare esplicitamente.');
      process.stdout.write(`${clean(message)} [s/N] `);
      return new Promise(resolve => { confirmation = resolve; });
    },
    async inherit(task, keepTranscript) {
      inherited = true;
      rl.pause();
      process.stdin.pause();
      if (keepTranscript) dashboard?.pause(); else dashboard?.stop();
      if (interactive) process.stdin.setRawMode(false);
      try { return await task(); }
      finally {
        inherited = false;
        if (!closed) {
          if (keepTranscript) dashboard?.resume(); else dashboard?.start();
          if (interactive) process.stdin.setRawMode(true);
          rl.resume();
          process.stdin.resume();
        }
      }
    },
  };
  const app = new Application(cwd, config, renderer, terminal);
  const prompt = (preserveCursor = false) => {
    if (history?.active || questions.pending) return;
    rl.setPrompt(`jarvis[${clean(app.orchestrator.active)}]> `);
    renderer.setActive(app.orchestrator.active);
    rl.prompt(preserveCursor);
  };
  const interrupt = () => {
    if (inherited) return;
    if (questions.pending) { questions.cancel(); return; }
    if (history?.active) { history.close(); return; }
    if (voice?.state === 'starting') { void voice.close(); rl.close(); return; }
    if (voice?.busy && voice.state !== 'routing') { voice.cancel(); return; }
    if (confirmation) { const resolve = confirmation; confirmation = undefined; resolve(false); return; }
    if (app.orchestrator.busy) void app.orchestrator.interrupt().catch(error => renderer.message(error.message));
    else rl.close();
  };
  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  const terminate = () => { void voice?.close(); rl.close(); };
  process.on('SIGTERM', terminate);
  const execute = async (line: string) => {
    try { return await app.execute(line); }
    catch (error) { renderer.message((error as Error).message); if (!interactive) process.exitCode = 1; return true; }
  };
  try {
    // Register the iterator before asynchronous startup so piped input isn't lost.
    const lines = interactive ? undefined : rl[Symbol.asyncIterator]();
    dashboard?.start();
    await askWorkspaceTrust(config, cwd, rl, renderer, interactive, yes);
    await app.initialize();
    if (agent) await app.orchestrator.use(agent);
    renderer.setActive(app.orchestrator.active);
    await app.banner();
    if (history) renderer.message('Cronologia: scorri verso l’alto con rotella/trackpad, oppure Pagina su o /history · q/Esc per tornare.');
    if (voiceEnabled) {
      const capture = new MacOSVoiceCapture({
        locale: config.voice.language.input === 'auto' ? 'it-IT' : config.voice.language.input,
        localOnly: config.voice.stt.localOnly, maxSeconds: config.voice.pushToTalk.maxSeconds,
      });
      speech = new MacOSSayOutput({ locale: config.voice.language.input === 'auto' ? 'it-IT' : config.voice.language.input });
      voice = new PushToTalk(capture, {
        minConfidence: config.voice.pushToTalk.minConfidence,
        message(text) { dashboard?.setVoice(text); renderer.message(text); },
        async receive(transcript) {
          const router = new VoiceInputRouter(app.orchestrator, (source, event) => renderer.event(source, event));
          try { return await router.accept(transcript); }
          finally { await app.saveSession(); }
        },
        speak: async text => {
          dashboard?.setVoice('Risposta vocale in riproduzione');
          try { await speech!.speak(text); }
          catch (error) {
            renderer.message(`Risposta vocale non disponibile: ${(error as Error).message}`);
            dashboard?.setVoice('Risposta vocale non disponibile · testo mostrato');
          }
        },
        stopSpeaking: () => speech?.stop(),
        settled() {
          dashboard?.setVoice(voice?.state === 'closed' ? 'Voce disattivata · microfono spento' : 'Microfono spento · tieni SPAZIO per parlare');
          if (!closed && !inherited) prompt();
        },
      });
      renderer.message(`Attivazione voce (${config.voice.language.input}); autorizza microfono e riconoscimento vocale se richiesto da macOS.`);
      renderer.message(config.voice.allowEdits
        ? 'Voce con scrittura file abilitata · commit, push e azioni distruttive richiedono una richiesta esplicita.'
        : 'Voce in sola lettura · imposta voice.allowEdits: true per consentire modifiche ai file.');
      if (!config.voice.stt.localOnly) renderer.message('Trascrizione Apple online autorizzata dalla configurazione: l’audio può essere inviato ad Apple.');
      try { await voice.start(); }
      catch (error) {
        if (voiceMode === 'required') throw error;
        renderer.message(`Voce non disponibile: ${(error as Error).message} Continuo in modalità testo (usa --novoice per non riprovare).`);
        dashboard?.setVoice('Voce non disponibile · solo testo');
      }
    }
    historyReady = true;
    if (!interactive) {
      while (true) {
        const next = await lines!.next();
        if (next.done || !await execute(next.value)) break;
      }
    } else {
      if (closed) return;
      await new Promise<void>(resolve => {
        const tasks = new Set<Promise<void>>();
        rl.on('line', line => {
          if (questions.accept(line)) return;
          if (confirmation) {
            const answer = confirmation; confirmation = undefined;
            answer(/^(s|si|sì|y|yes)$/i.test(line.trim()));
            return;
          }
          const task = execute(line).then(keepGoing => {
            if (!keepGoing) rl.close();
            else if (!closed && !inherited && !confirmation) prompt();
          });
          tasks.add(task);
          void task.finally(() => tasks.delete(task));
        });
        rl.once('close', () => {
          closed = true;
          confirmation?.(false);
          confirmation = undefined;
          questions.cancel();
          void app.orchestrator.close().then(() => voice?.close()).then(() => speech?.close()).then(() => Promise.allSettled(tasks)).finally(resolve);
        });
        prompt();
      });
    }
  } finally {
    closed = true;
    questions.cancel();
    rl.close();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    await app.orchestrator.close();
    await voice?.close();
    await speech?.close();
    if (input instanceof VoiceTerminalInput) input.detach();
    navigation?.detach();
    history?.close(false);
    dashboard?.stop();
    await app.saveSession();
  }
}
