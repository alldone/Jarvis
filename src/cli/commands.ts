export type Command =
  | { kind: 'request'; text: string; provider?: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'shell'; text: string }
  | { kind: 'empty' };

export const COMMANDS = ['use', 'review', 'agents', 'status', 'context', 'help', 'exit', 'quit', 'native', 'cancel', 'clear', 'btw', 'debate'] as const;

export function parseCommand(line: string, providerIds: Iterable<string>): Command {
  const text = line.trim();
  if (!text) return { kind: 'empty' };
  if (text.startsWith('!')) return { kind: 'shell', text: text.slice(1).trim() };
  if (!text.startsWith('/')) return { kind: 'request', text };
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)!;
  if (!match) return { kind: 'request', text };
  const name = match[1]!;
  const args = match[2] ?? '';
  if ([...providerIds].includes(name)) return { kind: 'request', provider: name, text: args };
  if ((COMMANDS as readonly string[]).includes(name)) return { kind: 'command', name, args };
  return { kind: 'request', text };
}

/** Optimal string alignment distance: adjacent transpositions count as one typo. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i || j));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  }
  return d[a.length]![b.length]!;
}

/** Returns a JARVIS command or agent name that an unknown slash command probably misspells. */
export function suggestCommand(name: string, providerIds: Iterable<string>): string | undefined {
  const lower = name.toLowerCase();
  const limit = lower.length < 5 ? 1 : 2;
  let best: { name: string; score: number } | undefined;
  for (const candidate of [...COMMANDS, ...providerIds]) {
    if (candidate === name) return undefined;
    const score = distance(lower, candidate);
    if (score <= limit && (!best || score < best.score)) best = { name: candidate, score };
  }
  return best?.name;
}

/** readline completer: slash commands first, then agent names for commands that take one. */
export function complete(line: string, providerIds: Iterable<string>): [string[], string] {
  const ids = [...providerIds];
  const agentArg = /^\/(use|native)\s+(\S*)$/.exec(line);
  if (agentArg) {
    const hits = ids.filter(id => id.startsWith(agentArg[2]!));
    return [hits, agentArg[2]!];
  }
  const contextArg = /^\/context\s+(\S*)$/.exec(line);
  if (contextArg) return [['add ', 'refresh'].filter(value => value.startsWith(contextArg[1]!)), contextArg[1]!];
  if (!/^\/\S*$/.test(line)) return [[], line];
  const names = [...new Set([...ids, ...COMMANDS])].map(name => `/${name}`);
  return [names.filter(name => name.startsWith(line)).sort(), line];
}

export const HELP = `JARVIS — comandi
  /use <agente>           Cambia agente attivo
  /codex [richiesta]      Seleziona Codex e, se presente, invia la richiesta
  /claude [richiesta]     Seleziona Claude e, se presente, invia la richiesta
  /review <richiesta>     Task, review indipendente, sintesi
  /agents                Mostra disponibilità delle CLI
  /status                Mostra progetto, agente e stato
  /context               Mostra il contesto attivo
  /context add <testo>    Aggiunge contesto versionabile
  /context refresh       Rilegge il contesto dal disco
  /clear                 Cancella la conversazione in memoria
  /native [agente]        Apre la CLI originale (permessi e slash nativi)
  /cancel                Interrompe il task corrente (anche Ctrl+C)
  ! <comando>            Esegue nella directory corrente, con conferma
  ! cd "percorso"        Cambia directory per l'intera sessione
  /help                  Mostra questo messaggio
  /exit                  Esce

Tastiera: Tab completa comandi e agenti; ↑/↓ richiamano gli input della sessione.
Le richieste testuali rispettano i permessi del provider. La voce consente scrittura file se voice.allowEdits è true (default).
Commit, push, cancellazioni e azioni distruttive richiedono sempre una richiesta esplicita.
L'agente selezionato resta attivo per testo e voce. La voce è attiva di default (macOS): tieni premuto SPAZIO sul prompt vuoto.
Avvia con --novoice per la modalità silenziosa.
Rilascia per inviare; Esc/Ctrl+C annulla la registrazione.
I comandi slash sconosciuti sono inoltrati al provider se supportati; se somigliano a un comando JARVIS,
JARVIS chiede conferma della grafia: usa /<agente> /comando per inoltrarli comunque.
Claude -p supporta skill, non tutti i comandi interattivi; Codex richiede /native.
JARVIS mantiene gli ultimi scambi in memoria, senza salvare trascrizioni.
/btw, /debate, wake word e sessioni native persistenti sono previsti nelle prossime versioni.`;
