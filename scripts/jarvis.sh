#!/usr/bin/env bash
# Builds whatever is missing or stale, then launches JARVIS in the caller's directory.
# Usage: scripts/jarvis.sh [jarvis options]   e.g. scripts/jarvis.sh --agent claude  (voice is on by default; --novoice for silent mode)
# JARVIS_FORCE_BUILD=1 rebuilds everything.
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")/.." && pwd)"
FORCE="${JARVIS_FORCE_BUILD:-0}"
if [[ -t 2 && -z "${NO_COLOR:-}" ]]; then label=$'\033[1;35mJARVIS ›\033[0m'; else label='JARVIS ›'; fi
say() { printf '%s %s\n' "$label" "$1" >&2; }
fail() { say "$1"; exit 1; }

# True when $1 is missing or older than any of the following files/directories.
stale() {
  local target="$1"; shift
  [[ "$FORCE" == "1" || ! -e "$target" ]] && return 0
  [[ -n "$(find "$@" -type f -newer "$target" -print -quit 2>/dev/null)" ]]
}

# Voice is the default: build its helper unless --novoice; only an explicit --voice makes failures fatal.
wants_voice=1 requires_voice=0
for arg in "$@"; do
  case "$arg" in --novoice) wants_voice=0 ;; --voice) requires_voice=1 ;; esac
done

command -v node >/dev/null || fail "Node.js non trovato: installa Node.js 22 o successivo."
major="$(node -p 'process.versions.node.split(".")[0]')"
(( major >= 22 )) || fail "Node.js $(node -v) non supportato: serve la versione 22 o successiva."

if stale "$ROOT/node_modules/.package-lock.json" "$ROOT/package.json" "$ROOT/package-lock.json"; then
  say "Installazione dipendenze…"
  (cd "$ROOT" && npm install --no-audit --no-fund) >&2
fi

if stale "$ROOT/dist/cli/main.js" "$ROOT/src" "$ROOT/tsconfig.json" "$ROOT/package.json"; then
  say "Compilazione TypeScript…"
  (cd "$ROOT" && npm run --silent build) >&2
fi

if [[ "$(uname -s)" == "Darwin" ]]; then
  helper="$ROOT/dist/native/JARVIS Voice.app/Contents/MacOS/jarvis-voice"
  if (( wants_voice )) && stale "$helper" "$ROOT/native/macos"; then
    if command -v swiftc >/dev/null; then
      say "Compilazione helper vocale macOS…"
      (cd "$ROOT" && npm run --silent build:voice) >&2 || {
        (( requires_voice )) && fail "Helper vocale non compilato: --voice non disponibile."
        say "Helper vocale non compilato: JARVIS partirà in modalità testo."
      }
    elif (( requires_voice )); then
      fail "swiftc mancante: esegui xcode-select --install per usare --voice."
    else
      say "swiftc mancante (xcode-select --install): JARVIS partirà in modalità testo."
    fi
  fi
fi

exec node "$ROOT/bin/jarvis.js" "$@"
