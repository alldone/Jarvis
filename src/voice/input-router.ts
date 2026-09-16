import type { Orchestrator } from '../core/orchestrator.js';
import type { EventSink } from '../core/types.js';
import type { Transcript } from '../providers/voice.js';

/** Text and speech share Orchestrator.active. Spoken input never executes shell commands. */
export class VoiceInputRouter {
  constructor(private orchestrator: Orchestrator, private emit: EventSink) {}

  async accept(transcript: Transcript): Promise<string | undefined> {
    const text = transcript.text.trim();
    if (!text) throw new Error('Trascrizione vuota: nessuna richiesta inviata.');
    if (this.orchestrator.busy) throw new Error('Task in corso: richiesta vocale NON inviata.');
    this.emit('JARVIS', { type: 'status', status: `Voce: ${text}` });
    // Only an explicit leading name/selection phrase changes the active provider.
    // A name mentioned in the body (e.g. "confronta Codex e Claude") is ordinary text.
    const match = /^(?:(?:usa|seleziona|passa a|use|switch to)\s+)?([a-z][a-z0-9-]*)(?:\s*[,.:;]\s*|\s+|$)([\s\S]*)$/i.exec(text);
    const candidate = match?.[1]?.toLowerCase();
    if (candidate && (this.orchestrator.providers.has(candidate) || Object.hasOwn(this.orchestrator.config.agents.providers, candidate))) {
      const request = (match?.[2] ?? '').trim();
      if (!request) {
        await this.orchestrator.use(candidate);
        return undefined;
      }
      return this.orchestrator.run(request, candidate, {
        readOnly: !this.orchestrator.config.voice.allowEdits,
        allowEdits: this.orchestrator.config.voice.allowEdits,
      });
    }
    return this.orchestrator.run(text, undefined, {
      readOnly: !this.orchestrator.config.voice.allowEdits,
      allowEdits: this.orchestrator.config.voice.allowEdits,
    });
  }
}
