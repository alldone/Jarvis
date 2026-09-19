#!/usr/bin/env node
// Deterministic CLI boundary fixture: no network, authentication, or model usage.
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const claude = args.includes('--print');
  const opencode = args.includes('--format');
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  if (process.env.JARVIS_TEST_LOG) fs.appendFileSync(process.env.JARVIS_TEST_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), permissions: process.env.OPENCODE_PERMISSION }) + '\n');
  if (prompt.includes('SIMULATE_HANG')) {
    emit(opencode ? { type: 'step_start', sessionID: 'fixture' } : claude ? { type: 'system', subtype: 'init' } : { type: 'thread.started', thread_id: 'fixture' });
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt.includes('SIMULATE_EXIT')) {
    process.stderr.write('authentication failed');
    process.exitCode = 7;
    return;
  }
  if (prompt.includes('SIMULATE_BAD_JSON')) { process.stdout.write('invalid protocol\n'); return; }
  if (prompt.includes('SIMULATE_INCOMPLETE')) { emit({ type: 'status' }); return; }
  if (prompt.includes('SIMULATE_ERROR')) {
    emit(opencode ? { type: 'error', error: { data: { message: 'provider failure' } } } : claude ? { type: 'result', is_error: true, errors: ['provider failure'] } : { type: 'turn.failed', error: { message: 'provider failure' } });
    if (!claude) process.exitCode = 7;
    return;
  }
  const answer = opencode ? 'Risultato OpenCode di prova.' : claude ? 'Risultato Claude di prova.' : 'Risultato Codex di prova.';
  if (opencode) {
    emit({ type: 'step_start', sessionID: 'fixture' });
    emit({ type: 'step_finish', part: { reason: 'tool-calls' } });
    emit({ type: 'text', part: { text: answer } });
    emit({ type: 'step_finish', part: { reason: 'stop' } });
  } else if (claude) {
    emit({ type: 'system', subtype: 'init' });
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
    emit({ type: 'result', result: answer, is_error: false });
  } else {
    emit({ type: 'thread.started', thread_id: 'fixture' });
    emit({ type: 'item.completed', item: { type: 'agent_message', text: answer } });
    emit({ type: 'turn.completed' });
  }
});
