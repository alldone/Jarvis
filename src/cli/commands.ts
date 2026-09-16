export type Command =
  | { kind: 'request'; text: string; provider?: string }
  | { kind: 'command'; name: string; args: string }
  | { kind: 'shell'; text: string }
  | { kind: 'empty' };

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
  const commands = ['use', 'review', 'agents', 'status', 'context', 'help', 'exit', 'quit', 'native', 'cancel', 'clear', 'btw', 'debate'];
  if (commands.includes(name)) return { kind: 'command', name, args };
  return { kind: 'request', text };
}

export const HELP = `JARVIS v0.1 — comandi
  /use <agente>           Cambia agente attivo
  /codex <richiesta>      Invia una richiesta a Codex
  /claude <richiesta>     Invia una richiesta a Claude
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

Le richieste sono di sola lettura per default. Per modifiche con approvazioni usa /native.
I comandi slash sconosciuti sono inoltrati al provider se supportati.
Claude -p supporta skill, non tutti i comandi interattivi; Codex richiede /native.
La v0.1 mantiene gli ultimi scambi in memoria, senza salvare trascrizioni JARVIS.
/btw, /debate, voce e sessioni native persistenti sono previsti nelle prossime versioni.`;
