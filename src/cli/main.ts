#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initProject, loadConfig } from '../config/config.js';
import { Application } from './application.js';
import { Renderer } from './renderer.js';
import { runRepl } from './repl.js';
import { VERSION } from './version.js';

const USAGE = `JARVIS v${VERSION} — orchestratore locale per Codex e Claude

  jarvis                         Terminale interattivo
  jarvis init                    Crea .jarvis/ senza sovrascrivere file
  jarvis agents                  Verifica le CLI dei provider (exit 1 se nessuna è pronta)
  jarvis run "richiesta"          Esegue una richiesta e termina
  jarvis run --review "richiesta" Task + review indipendente + sintesi
  jarvis run - < file             Legge la richiesta da stdin (es. git diff | jarvis run -)

  --cwd <directory>              Directory di lavoro (default: corrente)
  --agent <nome>                 Agente iniziale
  --yes                          Autorizza i comandi ! senza conferma
  --novoice                      Modalità silenziosa: niente microfono né risposte vocali
  --voice                        Voce obbligatoria: errore se non disponibile
  --help                         Mostra aiuto
  --version                      Mostra versione

Prerequisiti: Node.js 22+, almeno una CLI installata e autenticata.
Voce attiva di default su macOS (tieni premuto Spazio): richiede npm run build:voice.
Se la voce non è disponibile JARVIS prosegue in modalità testo. Live mode non ancora disponibile.`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('jarvis run - legge da stdin: collega un input, ad esempio git diff | jarvis run -');
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      cwd: { type: 'string' }, agent: { type: 'string' }, yes: { type: 'boolean', default: false },
      review: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }, voice: { type: 'boolean' }, novoice: { type: 'boolean' }, live: { type: 'boolean' },
    }, allowPositionals: true,
  });
  if (values.help || positionals[0] === 'help') { console.log(USAGE); return; }
  if (values.version) { console.log(VERSION); return; }
  if (values.live) throw new Error('Live mode non ancora disponibile. Usa --voice per il push-to-talk.');
  const cwd = await realpath(resolve(values.cwd ?? process.cwd()));
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Non è una directory: ${cwd}`);
  const [command, ...rest] = positionals;
  if (values.voice && values.novoice) throw new Error('--voice e --novoice sono alternativi.');
  if (values.voice && command) throw new Error('--voice è disponibile nel REPL: jarvis --voice [--agent <nome>].');
  if (command === 'init') {
    if (rest.length || values.review) throw new Error('Uso: jarvis init [--cwd <directory>]');
    const created = await initProject(cwd);
    console.log(`JARVIS › ${created.length ? `Creati ${created.length} file in ${cwd}/.jarvis/` : 'Contesto già inizializzato; nessun file sovrascritto.'}`);
    return;
  }
  const config = await loadConfig(cwd);
  if (command === 'agents') {
    if (rest.length || values.review) throw new Error('Uso: jarvis agents [--cwd <directory>]');
    const app = new Application(cwd, config, new Renderer(), { interactive: false, confirm: async () => false, inherit: task => task() });
    try {
      await app.agents();
      if (!(await app.orchestrator.availability()).some(row => row.available)) process.exitCode = 1;
    } finally { await app.orchestrator.close(); }
    return;
  }
  if (command === 'run') {
    if (!rest.length) throw new Error('Uso: jarvis run [--review] [--agent <nome>] "richiesta" | -');
    const request = rest.length === 1 && rest[0] === '-' ? await readStdin() : rest.join(' ');
    if (!request.trim()) throw new Error('Richiesta vuota: nessun input ricevuto.');
    const renderer = new Renderer();
    const app = new Application(cwd, config, renderer, {
      interactive: false, confirm: async () => values.yes,
      inherit: task => task(),
    });
    const interrupt = () => { void app.orchestrator.interrupt(); };
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', interrupt);
    try {
      if (values.agent) await app.orchestrator.use(values.agent);
      if (values.review) await app.orchestrator.review(request);
      else await app.orchestrator.run(request);
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      await app.orchestrator.close();
    }
    return;
  }
  if (command || values.review) throw new Error(`Comando non valido.\n${USAGE}`);
  const voice = values.novoice ? 'off' : values.voice ? 'required' : config.voice.enabled ? 'auto' : 'off';
  await runRepl(cwd, config, values.yes, values.agent, voice);
}

main().catch(error => {
  const hint = (error as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS') ? '\nUsa jarvis --help per le opzioni.' : '';
  console.error(`JARVIS › ${(error as Error).message}${hint}`);
  process.exitCode = 1;
});
