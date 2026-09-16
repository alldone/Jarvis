#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initProject, loadConfig } from '../config/config.js';
import { Application } from './application.js';
import { Renderer } from './renderer.js';
import { runRepl } from './repl.js';

const USAGE = `JARVIS v0.1.0 — orchestratore locale per Codex e Claude

  jarvis                         Terminale interattivo
  jarvis init                    Crea .jarvis/ senza sovrascrivere file
  jarvis run "richiesta"          Esegue una richiesta e termina
  jarvis run --review "richiesta" Task + review indipendente + sintesi

  --cwd <directory>              Directory di lavoro (default: corrente)
  --agent <nome>                 Agente iniziale
  --yes                          Autorizza i comandi ! senza conferma
  --voice                        macOS: tieni premuto Spazio per parlare
  --help                         Mostra aiuto
  --version                      Mostra versione

Prerequisiti: Node.js 22+, almeno una CLI installata e autenticata.
Voce macOS: richiede npm run build:voice. Live mode non ancora disponibile.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      cwd: { type: 'string' }, agent: { type: 'string' }, yes: { type: 'boolean', default: false },
      review: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' }, voice: { type: 'boolean' }, live: { type: 'boolean' },
    }, allowPositionals: true,
  });
  if (values.help) { console.log(USAGE); return; }
  if (values.version) { console.log('0.1.0'); return; }
  if (values.live) throw new Error('Live mode non ancora disponibile. Usa --voice per il push-to-talk.');
  const cwd = await realpath(resolve(values.cwd ?? process.cwd()));
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Non è una directory: ${cwd}`);
  const [command, ...rest] = positionals;
  if (values.voice && command) throw new Error('--voice è disponibile nel REPL: jarvis --voice [--agent <nome>].');
  if (command === 'init') {
    if (rest.length || values.review) throw new Error('Uso: jarvis init [--cwd <directory>]');
    const created = await initProject(cwd);
    console.log(`JARVIS › ${created.length ? `Creati ${created.length} file in ${cwd}/.jarvis/` : 'Contesto già inizializzato; nessun file sovrascritto.'}`);
    return;
  }
  const config = await loadConfig(cwd);
  if (command === 'run') {
    if (!rest.length) throw new Error('Uso: jarvis run [--review] "richiesta"');
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
      if (values.review) await app.orchestrator.review(rest.join(' '));
      else await app.orchestrator.run(rest.join(' '));
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      await app.orchestrator.close();
    }
    return;
  }
  if (command || values.review) throw new Error(`Comando non valido.\n${USAGE}`);
  await runRepl(cwd, config, values.yes, values.agent, values.voice || config.voice.enabled);
}

main().catch(error => { console.error(`JARVIS › ${(error as Error).message}`); process.exitCode = 1; });
