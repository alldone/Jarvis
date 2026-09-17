import { readFileSync } from 'node:fs';

/** Single source of truth: works from both src/ (tsx) and dist/ (build), two levels below the package root. */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
