# JARVIS — Product & Technical Specification

## Vision
JARVIS is a local-first conversational development orchestrator that provides one terminal and, progressively, one voice interface for multiple coding agents such as Codex and Claude Code. It does not replace their native CLIs: it coordinates them, preserves project context, routes work, enables cross-review, and keeps native commands accessible.

The target experience is simple: the developer says or types what they want; JARVIS decides which agent should work, can ask a second agent to review, and returns one coherent answer.

## Product principles
1. **Local-first.** Repository access, wake-word detection, project configuration and secrets should remain local whenever possible.
2. **Provider-neutral core.** Codex and Claude are initial providers, not hard-coded architectural assumptions.
3. **Native CLI compatibility.** JARVIS must preserve useful native provider commands rather than reimplementing every command.
4. **Human control.** Destructive commands, commits, pushes and sensitive actions must respect explicit permissions and the provider's approval model.
5. **Project memory.** Versionable context lives under `.jarvis/`.
6. **Voice is an interface, not the core.** Speech providers are replaceable and optional.
7. **Open-space ready.** Voice activation must support customizable local wake words, push-to-talk, quiet mode and configurable audio output.
8. **Multilingual by design.** Italian and English, including mixed technical speech, are first-class use cases.
9. **Extensible commercial architecture.** Core functionality can remain open while advanced orchestration/voice/team features can be layered without forking the architecture.

---

# 1. Core CLI

## Interactive shell

```text
$ jarvis

JARVIS › Ready.
         Codex  ✓
         Claude ✓
         Project: current-repository

jarvis> controlla l'ultimo commit
```

Natural-language input is sent to the active agent or routed by the orchestrator when automatic routing is enabled.

## Core commands

```text
/use codex
/use claude
/codex <request>
/claude <request>
/review <request>
/debate <request>
/agents
/status
/context
/help
/exit
```

`/review` uses one agent for the primary task and another for independent review. `/debate` requests independent analyses and produces a synthesis without silently modifying the workspace.

## Shell passthrough

Commands beginning with `!` execute in the current local workspace:

```text
! git status
! git diff
! npm test
! ./mvnw test
```

The working directory must be preserved across the JARVIS session.

## Native provider passthrough
Unknown slash commands are passed unchanged to the active provider when supported.

```text
/use claude
/btw controlla anche SecurityConfig
```

JARVIS must not maintain a fragile hard-coded copy of every provider-specific command.

Explicit routing must also be possible:

```text
/claude /btw controlla anche il DTO
/codex analizza l'ultimo diff
```

---

# 2. Multi-agent orchestration

## Agent abstraction

```ts
interface AgentProvider {
  id: string;
  isAvailable(): Promise<boolean>;
  startSession(context: ProjectContext): Promise<AgentSession>;
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  passthrough?(command: string): AsyncIterable<AgentEvent>;
  interrupt?(): Promise<void>;
  close(): Promise<void>;
}
```

Initial implementations:

```text
CodexProvider
ClaudeProvider
```

Future providers must be addable without changing the orchestrator contract.

## Orchestrator responsibilities
- select provider automatically or honor explicit routing;
- maintain active provider/session;
- coordinate review and debate workflows;
- normalize provider events into a common event stream;
- retain task relationships and handoffs;
- prevent simultaneous agents from unknowingly overwriting the same files;
- summarize results to the user;
- expose cancellation/interruption.

## Event model

```ts
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'status'; status: string }
  | { type: 'tool'; name: string; detail?: unknown }
  | { type: 'file-change'; path: string }
  | { type: 'approval'; request: ApprovalRequest }
  | { type: 'error'; error: Error }
  | { type: 'done' };
```

JARVIS renders one unified stream while retaining the source agent identity.

---

# 3. Background instructions and `/btw`

JARVIS should support adding information while an agent is already working.

```text
CODEX › running tests...

jarvis> /btw controlla anche che MongoConfig non venga duplicata

JARVIS › Added to the current task.
```

The implementation must distinguish:
- provider-native `/btw`, when the active provider supports it;
- a JARVIS side instruction queued against the current task;
- a new independent task.

Side instructions must never be silently lost. The UI must indicate whether an instruction was delivered immediately, queued, or requires a new provider turn.

---

# 4. Project context and memory

Each repository may contain:

```text
.jarvis/
├── jarvis.yml
├── context.md
├── architecture.md
├── decisions.md
├── agents/
│   ├── codex.md
│   └── claude.md
└── sessions/
```

`context.md` contains stable project context. `architecture.md` describes architecture and constraints. `decisions.md` records explicit technical decisions. Provider files contain provider-specific instructions. Session persistence must avoid storing credentials or unnecessary sensitive transcripts.

JARVIS must support:

```text
/context
/context add <text>
/context refresh
```

Automatic context updates should require configurable user approval.

---

# 5. Voice architecture

Voice is implemented through replaceable interfaces.

```ts
interface SpeechToTextProvider {
  transcribe(audio: AudioInput, options: STTOptions): Promise<Transcript>;
  stream?(audio: AsyncIterable<AudioChunk>, options: STTOptions): AsyncIterable<TranscriptEvent>;
}

interface TextToSpeechProvider {
  synthesize(text: string, options: TTSOptions): Promise<AudioOutput>;
  stream?(text: AsyncIterable<string>, options: TTSOptions): AsyncIterable<AudioChunk>;
}

interface WakeWordProvider {
  start(config: WakeWordConfig): AsyncIterable<WakeWordEvent>;
  stop(): Promise<void>;
}
```

Cloud and local providers must be interchangeable.

## Voice modes

```bash
jarvis --voice
jarvis --live
```

`--voice` is turn-based speech: activate, speak, transcribe, execute, answer.

`--live` is the future low-latency conversational mode with streaming audio, interruption and continuous session handling.

## Languages
JARVIS must support:
- Italian;
- English;
- automatic language detection where supported;
- mixed Italian/English technical vocabulary.

Example:

> "Jarvis, controlla SecurityConfig perché il request matcher sembra eseguito prima del token validation filter."

Identifiers, filenames, class names, method names and technical terms should be preserved whenever possible. Repository vocabulary may be supplied to the STT provider as contextual hints when supported.

The user's spoken language and the language used internally with coding agents are separate concerns. A user may speak Italian, JARVIS may optimize an agent prompt in English, and JARVIS may return the final explanation in Italian.

---

# 6. Custom wake word

## Requirement
The activation name is **not hard-coded to "Jarvis"**. Every installation/user can choose the word or phrase that activates voice recognition.

Examples:

```text
Jarvis
Micu
Talianu
Friday
Computer
Assistente
```

This is especially important in open spaces where multiple developers may use JARVIS simultaneously.

Example:

```text
Workstation A → "Jarvis"
Workstation B → "Micu"
Workstation C → "Talianu"
Workstation D → "Friday"
```

Each workstation listens only for its configured wake word(s).

## Configuration

```yaml
voice:
  enabled: true
  activationMode: both # wakeword | push-to-talk | both

  wakeWord:
    enabled: true
    phrase: "jarvis"
    aliases:
      - "micu"
      - "talianu"
    sensitivity: 0.72
    requireWakeWord: true
    localDetection: true

  language:
    input: auto
    output: auto
    preferred:
      - it
      - en

  output:
    mode: speech # speech | text | both
    device: default
    quietMode: false

  pushToTalk:
    enabled: true
    shortcut: "Alt+Space"
```

`aliases` are optional alternative activation phrases. Deployments may instead configure exactly one phrase to reduce false activations.

## CLI configuration

```bash
jarvis config wake-word "micu"
jarvis config wake-word --add-alias "talianu"
jarvis config activation both
jarvis config quiet-mode on
```

Interactive equivalents:

```text
/wakeword micu
/wakeword alias add talianu
/voice on
/voice off
/quiet on
/quiet off
```

## Local detection requirement
Wake-word detection should preferably occur **locally on the workstation**. Continuous ambient audio must not be sent to a cloud STT service merely to determine whether the activation word was spoken.

Normal flow:

```text
Microphone
   ↓
local wake-word detector
   ↓ "Micu"
activation event
   ↓
record/stream command audio
   ↓
STT provider
   ↓
JARVIS orchestrator
   ↓
Codex / Claude
   ↓
TTS provider
   ↓
selected audio output
```

Only audio captured after activation should be sent to a remote speech service, subject to the selected provider and configuration.

## Wake-word engine abstraction
The implementation must not bind the core to one wake-word library.

```ts
type WakeWordConfig = {
  phrases: string[];
  sensitivity: number;
  localOnly: boolean;
};

type WakeWordEvent = {
  phrase: string;
  confidence?: number;
  timestamp: number;
};
```

A provider can use a local keyword-spotting engine or another implementation later.

---

# 7. Open-space mode

JARVIS must explicitly support shared/noisy workplaces.

## Activation options
1. **Wake word** — hands-free.
2. **Push-to-talk** — no continuous command recognition.
3. **Both** — wake word or keyboard shortcut.

## Quiet mode
In quiet mode JARVIS can listen for activation but returns responses only as terminal text/desktop notification.

```text
/quiet on
```

A later version may support short audio acknowledgements while keeping detailed responses textual.

## Audio output
Users must be able to choose the output device, especially headphones/headsets in offices.

```yaml
voice:
  output:
    device: "AirPods"
```

Do not assume the system default speaker is appropriate.

## Accidental activation protection
Configurable safeguards:
- sensitivity threshold;
- minimum confidence where supported;
- cooldown after activation;
- maximum command duration;
- optional confirmation for destructive actions;
- ignore TTS output from JARVIS itself to prevent feedback loops;
- optional push-to-talk-only policy in sensitive environments.

---

# 8. Voice interaction state machine

```text
IDLE
 ↓ wake word / push-to-talk
ACTIVATED
 ↓
LISTENING
 ↓ silence / key release
TRANSCRIBING
 ↓
ROUTING
 ↓
AGENT_WORKING
 ↓
RESPONDING
 ↓
IDLE
```

Live mode additionally supports:

```text
RESPONDING → INTERRUPTED → LISTENING
```

The terminal must always show the current state so the user knows whether the microphone is listening.

---

# 9. Privacy and security

- Never store provider API keys in `.jarvis/`.
- Prefer provider-native credential stores/environment mechanisms.
- Wake-word detection should be local by default.
- Clearly indicate when microphone capture begins and ends.
- Provide a hardware/software mute shortcut.
- Never execute destructive shell commands solely because a low-confidence transcription appears to request them.
- Voice-triggered destructive operations require the same or stronger approval controls as typed operations.
- Do not silently upload repository files to a speech provider.
- Voice transcripts should have configurable retention: `none`, `session`, or `persistent`.
- Sensitive session history should be excluded from Git by default.

Suggested `.gitignore` entries:

```text
.jarvis/sessions/*
.jarvis/cache/*
.jarvis/audio/*
```

---

# 10. Configuration model

Example `.jarvis/jarvis.yml`:

```yaml
version: 1

project:
  name: "my-project"

agents:
  default: codex
  autoRouting: true
  providers:
    codex:
      enabled: true
    claude:
      enabled: true

orchestration:
  reviewProvider: claude
  preventConcurrentFileWrites: true
  autoReview: false

shell:
  enabled: true
  confirmDestructive: true

voice:
  enabled: false
  activationMode: both

  wakeWord:
    enabled: true
    phrase: "jarvis"
    aliases: []
    sensitivity: 0.72
    requireWakeWord: true
    localDetection: true

  language:
    input: auto
    output: auto
    preferred: [it, en]

  stt:
    provider: openai
    mode: turn

  tts:
    provider: openai
    voice: default

  pushToTalk:
    enabled: true
    shortcut: "Alt+Space"

  output:
    mode: both
    device: default
    quietMode: false

  privacy:
    transcriptRetention: session
    saveAudio: false
```

Provider/model names belong in provider configuration and must not leak into the core interfaces.

---

# 11. Proposed source structure

```text
jarvis/
├── src/
│   ├── cli/
│   │   ├── repl.ts
│   │   ├── commands.ts
│   │   └── renderer.ts
│   ├── core/
│   │   ├── orchestrator.ts
│   │   ├── router.ts
│   │   ├── command-bus.ts
│   │   ├── event-bus.ts
│   │   ├── task-manager.ts
│   │   └── session-manager.ts
│   ├── providers/
│   │   ├── agent/
│   │   │   ├── codex/
│   │   │   └── claude/
│   │   ├── stt/
│   │   ├── tts/
│   │   └── wakeword/
│   ├── voice/
│   │   ├── voice-controller.ts
│   │   ├── microphone.ts
│   │   ├── audio-output.ts
│   │   ├── push-to-talk.ts
│   │   └── state-machine.ts
│   ├── context/
│   ├── config/
│   ├── shell/
│   └── security/
├── .jarvis/
├── package.json
└── README.md
```

---

# 12. Product editions — architectural preparation

No license/paywall behavior is required for v0.1, but the architecture must allow capabilities to be packaged separately later.

Possible direction:

**JARVIS Core**
- CLI;
- provider abstraction;
- one active agent;
- shell passthrough;
- project context;
- local/basic voice providers where available.

**JARVIS Pro**
- advanced multi-agent orchestration;
- automatic cross-review;
- richer persistent project memory;
- realtime voice;
- advanced wake-word/open-space features;
- notifications and automation.

**JARVIS Team**
- shared policies/context;
- audit trail;
- repository integrations;
- team configuration;
- centralized usage/governance features.

The exact commercial split is intentionally not fixed by this specification.

---

# 13. Delivery roadmap

## v0.1 — usable CLI
- TypeScript/Node CLI;
- Codex + Claude adapters;
- interactive REPL;
- `/use`, `/codex`, `/claude`, `/agents`, `/review`;
- `!` shell passthrough;
- unknown `/` provider passthrough;
- `.jarvis/` project context;
- readable provider availability errors.

## v0.2 — persistent multi-agent
- persistent provider sessions where supported;
- unified streaming event bus;
- robust `/btw`/side-instruction behavior;
- `/debate`;
- task cancellation;
- conflict protection for concurrent edits.

## v0.3 — Voice
- `SpeechToTextProvider`;
- `TextToSpeechProvider`;
- Italian/English/auto language;
- push-to-talk;
- `jarvis --voice`;
- selectable audio output;
- quiet mode.

## v0.4 — Open-space / Wake word
- `WakeWordProvider`;
- customizable activation phrase (`Jarvis`, `Micu`, `Talianu`, etc.);
- aliases;
- local wake-word detection;
- sensitivity/cooldown;
- wake-word + push-to-talk combined mode;
- self-audio feedback suppression.

## v0.5 — Live
- low-latency streaming conversation;
- interruption/barge-in;
- continuous voice session;
- richer notifications;
- provider/model selection and usage telemetry controlled by user settings.

---

# 14. v0.1 acceptance criteria

1. `npm run build` succeeds.
2. `jarvis` starts from an arbitrary repository.
3. Codex and Claude availability are detected independently.
4. Missing provider binaries produce readable errors and do not crash the REPL.
5. `!` commands execute in the current working directory.
6. Project context is injected into agent requests.
7. `/use`, `/codex`, `/claude`, `/agents` and `/review` work.
8. Unknown provider commands can be passed through without JARVIS needing to know every command in advance.
9. No API keys are stored by JARVIS.
10. The codebase already exposes interfaces/extension points for STT, TTS and wake-word providers, even if their concrete implementation ships later.

# Definition of success
The first meaningful success is not feature count. It is this workflow:

```text
$ jarvis

jarvis> controllate l'ultimo commit

JARVIS › Codex is analysing the implementation.
         Claude is reviewing it independently.

JARVIS › Both agents identified the same issue.
         Do you want the explanation or should I prepare a fix?
```

The voice milestone is reached when the same workflow can start with a personalized activation phrase:

> **"Micu, fai controllare a Claude quello che Codex ha appena modificato."**

and JARVIS can execute the orchestration and answer in the user's chosen language without requiring the keyboard.
