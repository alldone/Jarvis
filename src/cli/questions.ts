/** One cancellable question at a time. Answers never reach an agent as new tasks. */
export class Questions {
  private current?: { options?: string[]; resolve: (answer: string | undefined) => void };
  get pending(): boolean { return Boolean(this.current); }
  constructor(private display: (text: string) => void, private prompt: () => void) {}
  ask(question: string, options?: string[]): Promise<string | undefined> {
    if (this.current) return Promise.reject(new Error('Una domanda è già in attesa di risposta.'));
    this.display(question + (options ? '\n' + options.map((option, i) => `  ${i + 1}) ${option}`).join('\n') : '')
      + '\nEsc, Ctrl+C o /cancel per annullare.');
    return new Promise(resolve => { this.current = { options, resolve }; this.prompt(); });
  }
  accept(line: string): boolean {
    if (!this.current) return false;
    const value = line.trim();
    if (value === '/cancel') { this.cancel(); return true; }
    const options = this.current.options;
    if (!value || options && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > options.length)) {
      this.display(options ? `Inserisci un numero da 1 a ${options.length}.` : 'Inserisci una risposta oppure /cancel.');
      this.prompt();
      return true;
    }
    const { resolve } = this.current;
    this.current = undefined;
    resolve(value);
    return true;
  }
  cancel(): void {
    const question = this.current;
    this.current = undefined;
    question?.resolve(undefined);
  }
}
