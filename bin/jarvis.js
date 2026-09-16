#!/usr/bin/env node
import('../dist/cli/main.js').catch((error) => {
  console.error(error.code === 'ERR_MODULE_NOT_FOUND'
    ? 'JARVIS › Build mancante. Esegui npm install e npm run build nella directory di JARVIS.'
    : `JARVIS › ${error.message}`);
  process.exitCode = 1;
});
