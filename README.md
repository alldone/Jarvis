<div align="center">

# JARVIS

**One terminal. Multiple coding agents. Shared project context.**

A local-first development orchestrator for Codex and Claude Code.<br>
Choose an agent, keep the conversation moving, and bring in a second perspective when you need one.

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Status](https://img.shields.io/badge/status-early%20development-orange)
![License](https://img.shields.io/badge/license-PolyForm%20Small%20Business%201.0.0-purple)

[Quick start](#quick-start) · [Usage](#usage) · [Configuration](#configuration) · [Architecture](#architecture) · [Roadmap](#roadmap) · [License](#license)

</div>

---

JARVIS gives your coding agents a shared entry point. It coordinates their native CLIs, supplies project context, and presents their work in one terminal. Work with one agent, switch to another, or ask one to review the other's result.

It follows a simple rule: **the agent you select stays selected**. After `/claude`, subsequent requests go to Claude until you choose another agent. Text and voice share that selection, so you do not have to repeat an agent's name with every spoken request.

```text
jarvis[codex]> /claude
jarvis[claude]> Explain how authentication works in this project.
jarvis[claude]> Which edge cases are missing from the tests?
jarvis[claude]> /codex Check the token refresh flow as well.
jarvis[codex]> /review Review the latest commit for regressions.
```

> **Early release.** The CLI includes live agent panels, macOS hold-Space push-to-talk, and spoken responses through the system synthesizer. Custom wake words and live conversation remain planned. See [current limitations](#current-limitations).

## What you can do today

- **Switch agents without switching terminals.** Use `/codex`, `/claude`, `/opencode`, or `/use`; the prompt shows the active agent and each request announces its recipient.
- **Resume work by project.** Sessions save recent conversation and transcript in the working directory; `/sessions` lists them and `/session` manages them.
- **Get a second review.** `/review` runs the primary task, asks another agent to inspect the result, and produces a final synthesis.
- **Keep project instructions together.** Store shared context and provider-specific guidance in versionable `.jarvis/` files.
- **Keep native tools accessible.** `/native` opens the original CLI with its interactive commands and approval flow, then returns you to JARVIS.
- **Run local commands.** `!` executes shell commands in the current project; `! cd` changes the directory for the session.
- **Stay in control.** Automated requests default to read-only access, shell commands require confirmation by default, and running agent tasks can be cancelled.
- **Speak while holding Space.** On macOS, record from an empty prompt, release to transcribe, and send to the selected agent. Recognition runs on-device by default.
- **Watch each agent work.** Separate live panels show status, elapsed time, the latest operation, and a response preview.

## Quick start

### Prerequisites

- **Node.js 22 or later** and npm.
- At least one supported CLI installed and authenticated: [Codex](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/overview), or [OpenCode](https://opencode.ai/docs/cli/).
- At least two available CLIs for cross-agent review or debate.

Authenticate through the provider's own CLI before using JARVIS. JARVIS reuses that authentication; it does not ask for or store API keys.

### Install

One npm package works on every supported platform; the macOS voice helper is prebuilt as a universal binary inside it.

| Platform | Text, agents, panels, shell | Push-to-talk and spoken answers |
| --- | --- | --- |
| macOS (Apple Silicon and Intel, 12+) | ✓ | ✓ (voice on by default, `--novoice` for silent mode) |
| Linux | ✓ | Not yet — starts in text mode |
| Windows 10/11 (PowerShell, Windows Terminal) | ✓ | Not yet — starts in text mode |

From the npm registry:

```bash
npm install -g jarvis-dev-orchestrator
```

Or straight from a GitHub Release, without the npm registry (replace the version):

```bash
npm install -g https://github.com/alldone/Jarvis/releases/download/v0.1.0/jarvis-dev-orchestrator-0.1.0.tgz
```

Both install the `jarvis` command. Update with the same command; remove with `npm uninstall -g jarvis-dev-orchestrator`. On Windows, `! <command>` runs through `cmd.exe`, and npm-installed provider CLIs (`codex.cmd`, `claude.cmd`) are detected automatically.

### Install from source

From your local checkout:

```bash
npm install
npm run build
npm link
```

Then open any project:

```bash
cd /path/to/your-project
jarvis init
jarvis
```

`jarvis init` is optional. It creates project context files without overwriting existing ones. JARVIS also starts in directories that are not Git repositories.

Or skip the manual build steps: `scripts/jarvis.sh` installs dependencies, compiles TypeScript and (on macOS) the voice helper only when they are missing or out of date, then starts JARVIS in your current directory. Options are passed through, and `JARVIS_FORCE_BUILD=1` rebuilds everything:

```bash
cd /path/to/your-project
/path/to/jarvis/scripts/jarvis.sh --agent claude
```

To run without installing the command globally, use these commands from the JARVIS checkout:

```bash
npm start -- --cwd /path/to/your-project
npm start -- init --cwd /path/to/your-project
```

### Run a single request

```bash
jarvis run --agent codex "Explain the repository structure"
jarvis run --agent claude "Find gaps in the authentication tests"
jarvis run --review "Review the latest commit for regressions"
```

Pass `-` to read the request from standard input, and use `jarvis agents` to check provider executables from scripts (exit code 1 when none is ready):

```bash
git diff | jarvis run --review -
jarvis agents
```

Use `--cwd /path/to/project` to set the working directory explicitly. `jarvis --help` lists the CLI options.

### Speak with push-to-talk (macOS)

Build the native helper once from the JARVIS checkout. This requires Xcode Command Line Tools (`xcode-select --install` if missing):

```bash
npm run build:voice
npm start
# Or, after npm link:
jarvis --agent claude
# Silent mode, no microphone or spoken answers:
jarvis --novoice
```

Allow microphone and speech recognition access when macOS asks. Wait for the voice-ready message, then:

1. Leave the terminal prompt empty.
2. **Hold Space** and speak when the microphone indicator turns on.
3. **Release Space** to stop capture and transcribe the command.
4. Read the transcript, destination agent, and response in the terminal.

You do not need to name the selected agent again. “Codex, check the tests” explicitly changes it; “check the tests” uses the current selection. Spaces inside a typed sentence remain normal spaces.

**Escape or Ctrl+C** cancels a recording. Losing application focus cancels it too; the maximum hold time is 45 seconds by default. Very short presses and low-confidence transcripts are not sent. Audio is streamed in memory and is not saved to disk. Voice requests can edit files by default, using the provider's workspace-write/accept-edits controls. Commits, pushes, deletions, and other destructive actions still require an explicit request.

The native helper checks the physical Space key, so this mode requires a local macOS keyboard session and does not work over SSH. JARVIS also reads the completed response aloud through macOS's built-in `say` synthesizer while retaining the full answer on screen. Starting another recording or pressing Escape/Ctrl+C interrupts speech.

### Continue a task with Claude

Once Claude is selected, both typed and spoken requests stay on Claude until you explicitly switch agents. Voice editing is enabled by default, so ordinary file changes do not require `/native`:

```text
/claude
Hold Space → “Add the requested change to the project and run the tests.”
```

For Claude voice sessions JARVIS enables file editing and a scoped set of local Git/test commands. A spoken request can explicitly ask for a local commit, for example “commit these changes locally”; `git push` is not included in the voice allow-list. Set `voice.allowEdits: false` in `.jarvis/jarvis.yml` to make spoken requests read-only.

## Usage

### Agent selection

Both forms select Claude for future requests:

```text
/claude
/claude Inspect the API error handling.
```

Switch back with `/codex` or `/use codex`. An explicit choice is never silently replaced by automatic routing. If that provider becomes unavailable, JARVIS reports the error.

The prompt shows the selection, for example `jarvis[claude]>`. During a review, each stage is labelled with the agent actually performing it.

### Live activity panels

The first agent's panel appears in the upper-right corner. When a second agent starts, its own panel is added to the left. Each panel has an independent timer, activity indicator, latest tool operation, and response preview; completed work remains visible when the next agent takes over.

The transcript and command prompt scroll below the panels. On narrow terminals, the running agent takes priority in a single compact panel; very small terminals omit the panels. Shell commands and native CLIs temporarily receive the full terminal, and JARVIS restores its layout when they return. Non-interactive output stays plain text.

Press **Page Up** (Fn+↑ on Mac keyboards) or enter `/history` to read earlier output in a full-screen viewer with a clickable scrollbar. Use ↑/↓, Page Up/Page Down, Home/End or the mouse wheel; **q**, **Escape** or **Ctrl+C** returns to the prompt and preserves any unfinished input. The viewer holds a stable snapshot while agents continue working; returning restores the latest output and panels. The transcript retains up to two million characters, including typed requests and agent output, and is saved with the project session by default. Output from inherited shell commands and native CLI sessions is not captured. `/clear` resets model conversation context, not the visible transcript.

### Cross-agent review

```text
/review Check the latest commit for concurrency bugs.
```

The workflow is sequential:

```text
Your request → Primary agent → Independent reviewer → Final synthesis
```

JARVIS checks that two distinct providers are available before starting. The reviewer receives the original request, the primary result, project context, and a bounded Git snapshot. It does not receive the primary agent's earlier conversation. Both the reviewer and the synthesis stage run with read-only permissions.

The final synthesis is instructed to distinguish confirmed findings, disagreements, and unverified claims. A complete `/review` workflow makes **three provider requests**.

### Independent debate

Use `/debate [request]` to compare approaches before implementing them. In an interactive terminal JARVIS asks how many AI agents to use and, when needed, which participants to include. With no request it also asks for the topic. Numbered choices reject invalid input; Escape, Ctrl+C or `/cancel` cancels before any agent starts.

To skip questions, use `/debate --agents codex,claude,opencode <request>` or `jarvis run --debate --agents codex,claude,opencode "<request>"`. Non-interactive calls without a list use two providers. Each participant independently analyzes the same request and Git snapshot, without previous conversation or access to the other answers. The active agent synthesizes the results if included; otherwise the first participant does. Every stage is read-only. With N participants, a successful debate makes N+1 provider requests.

All selected providers must be available before any starts. If an analysis fails or you use `/cancel`, JARVIS interrupts the analyses and skips synthesis. A successful synthesis becomes context for follow-up requests. `--debate` and `--review` are mutually exclusive.

### Project sessions

JARVIS resumes the most recently saved session in the current directory by default, including the selected agent, up to 24,000 characters of conversation per agent and the scrollable transcript. Completed tasks and ordinary exits save to `.jarvis/sessions/`. `! cd` saves the current session and loads the destination directory's session; returning to the original directory restores its work. Canonical paths prevent a symlink alias from creating a separate project identity.

Use `/sessions` (or `jarvis sessions --cwd <directory>`) to list saved sessions. `/session new [name]` starts an empty conversation; `/session resume <id|last>` switches to a saved one; `/session resume` presents an interactive selector. IDs may be abbreviated to an unambiguous prefix of at least four characters. `/session rename <name>` changes the title. `/session fork [name]` saves a separate copy of the current context and transcript. Session switching is blocked during agent work.

Session files are atomically replaced, have owner-only permissions on Unix, and are excluded from Git even without `jarvis init`. Stale concurrent writers are rejected instead of overwriting newer state; use `/session fork` to preserve local work separately. Invalid files and directory mismatches are reported rather than silently imported. These are **JARVIS sessions**: the adapters start fresh native provider runs and pass the saved recent context; native CLI session IDs and full native tool histories are not resumed.

Set `sessions.autoResume: false` to start a new session at launch, or `sessions.enabled: false` for memory-only operation. A crash during a task can lose work since the last save; provider-generated file changes are not rolled back.

### OpenCode

OpenCode participates in normal requests, voice routing, reviews and debates. Use `/opencode`, `/use opencode`, or `/native opencode`. Its adapter uses the installed CLI's JSON output and native authentication; set `agents.providers.opencode.model` to a `provider/model` identifier if needed. Existing project configurations that explicitly list only Codex and Claude should add `opencode: { enabled: true }` under `agents.providers`.

Automated runs use a scoped OpenCode agent and explicit permissions: file inspection by default, file edits and scoped local Git/test commands when edit mode is enabled. Independent analyses always deny edits, shell tools and delegation. Plugin loading and automatic sharing are disabled for these runs. Slash commands requiring the native interface use `/native opencode`. See the official [CLI](https://opencode.ai/docs/cli/) and [permissions](https://opencode.ai/docs/permissions/) references.

### Command reference

| Command | What it does |
| --- | --- |
| `/codex [request]` | Select Codex and optionally send a request |
| `/claude [request]` | Select Claude and optionally send a request |
| `/opencode [request]` | Select OpenCode and optionally send a request |
| `/use <agent>` | Change the active agent |
| `/review <request>` | Run a task, cross-review, and synthesis |
| `/debate [request]` | Choose participants, then independent read-only analyses and synthesis |
| `/history` | Browse the in-memory transcript with a scrollbar |
| `/sessions` | List sessions saved in this directory |
| `/session [new\|resume\|rename\|fork]` | Inspect or manage the current project session |
| `/agents` | Show whether each provider executable is available |
| `/status` | Show the working directory, active agent, and task status |
| `/context` | Display the context for the active agent |
| `/context add <text>` | Append text to the project's `context.md` |
| `/context refresh` | Reload context from disk |
| `/clear` | Clear JARVIS's in-memory conversation |
| `/native [agent]` | Open the original interactive CLI |
| `/cancel` | Stop the running agent task |
| `! <command>` | Execute a local shell command |
| `! cd "path"` | Change the session's working directory |
| `/help` | Show interactive help |
| `/exit` | Exit JARVIS |

**Tab** completes slash commands and agent names; **↑/↓** recall inputs from the current session. A mistyped JARVIS command such as `/stauts` is not forwarded to the provider: JARVIS suggests the closest command, and `/<agent> /command` forwards it anyway. Output labels are colored on terminals; set `NO_COLOR=1` to disable.

**Ctrl+C** cancels a running agent task; when idle, it exits JARVIS. In the history viewer it only closes the viewer. While a task is running, `/status`, `/cancel` and `/history` remain available. Other inputs are explicitly rejected so they are not silently lost.

### Native commands and passthrough

Unknown slash commands are handed to the selected provider unchanged when its automated interface supports them. JARVIS does not maintain a copy of every provider's command list.

```text
/claude /my-skill inspect the API
```

There are provider-specific limits:

- **Claude:** print mode can invoke skills, but does not support every command from the interactive interface.
- **Codex:** `exec` does not run interactive slash commands. JARVIS reports this and directs you to `/native codex`.

For native interactive features such as model selection or provider-specific background commands, use `/native`, then enter the command in the original CLI. Exiting that CLI returns you to JARVIS. Its conversation is not imported into JARVIS's history.

### Shell commands

```text
! git status
! npm test
! cd "../another project"
```

With the default configuration, every shell command asks for confirmation. JARVIS does not try to classify arbitrary shell code as safe. `--yes` explicitly skips those confirmations for the session.

Use `! cd` as a separate command. Changing directories saves the current session, reloads the destination project's configuration and restores its session. Shell aliases, exported variables, and other shell state do not persist between commands.

## Project context

`jarvis init` creates:

```text
.jarvis/
├── jarvis.yml          # Project and provider settings
├── context.md          # Goals, stack, and conventions
├── architecture.md     # Components and constraints
├── decisions.md        # Explicit technical decisions
├── agents/
│   ├── codex.md        # Codex-specific instructions
│   ├── claude.md       # Claude-specific instructions
│   └── opencode.md     # OpenCode-specific instructions
├── sessions/           # Local conversation snapshots, excluded from Git
└── .gitignore          # Excludes sessions, cache, and audio
```

Each request reloads the shared documents and only the selected provider's instruction file. Each document is limited to 64 KiB. Context updates are explicit: JARVIS does not automatically rewrite your project memory.

Review requests also include Git status, recent commit summaries, the current diff against `HEAD`, and the latest commit's diff. Snapshot output is bounded; missing or truncated information is marked in the material sent to the agents.

**Keep secrets out of these files.** Project context is sent to the coding provider handling the request.

## Configuration

Settings live in `.jarvis/jarvis.yml`. A minimal configuration uses safe defaults:

```yaml
version: 1

project:
  name: my-project

agents:
  default: codex
  autoRouting: false
  providers:
    codex:
      enabled: true
      sandbox: read-only
    claude:
      enabled: true
      permissionMode: default
    opencode:
      enabled: true
      sandbox: read-only

sessions:
  enabled: true
  autoResume: true

orchestration:
  reviewProvider: claude

shell:
  enabled: true
  confirmDestructive: true

voice:
  enabled: true
  allowEdits: true
  language:
    input: it-IT
  stt:
    provider: apple
    localOnly: true
  pushToTalk:
    shortcut: Space
    maxSeconds: 45
    minConfidence: 0.45
```

Each provider also accepts an optional `binary` path and `model` name. Models remain provider configuration; the orchestration core does not depend on a particular model.

`autoRouting: true` enables availability-based fallback when the default agent is missing. It does not perform semantic task routing, and it never overrides an explicit agent selection.

Voice is on by default (`voice.enabled: true`). If it cannot start — helper not built, not macOS, SSH, missing permissions — JARVIS says why and continues in text mode. `--novoice` starts a silent session (no microphone, no spoken answers); `voice.enabled: false` makes that the project default. `--voice` makes voice mandatory and exits if it is unavailable. Set `voice.language.input` to a locale such as `it-IT` or `en-US`; this Apple adapter maps `auto` to `it-IT` and does not yet detect languages automatically. Voice settings are read at startup; restart after changing them.

If on-device recognition is unavailable, enable or download the matching Dictation language in macOS settings. JARVIS fails visibly instead of silently sending audio to a cloud service. Setting `voice.stt.localOnly: false` explicitly allows Apple's network-based speech recognition; JARVIS announces this at startup. No OpenAI or Anthropic API key is needed for Apple transcription.

### Allowing edits

Automated tasks are read-only by default:

| Provider | Default automated access |
| --- | --- |
| Codex | Native `read-only` sandbox |
| Claude | `Read`, `Glob`, and `Grep` tools; MCP servers excluded |

Voice is the deliberate write path: with `voice.allowEdits: true` (the default), JARVIS starts Codex in its workspace-write sandbox and starts Claude with `Read/Edit/Write` plus scoped local `git status/diff/add/commit` and test commands. Claude's voice allow-list does not include `git push`; provider sandbox and permission controls still apply. Set `voice.allowEdits: false` when spoken requests must remain read-only.

Use `/native` for editing workflows that need interactive permission decisions. To authorize edits in automated requests, explicitly configure the provider:

```yaml
agents:
  providers:
    codex:
      enabled: true
      sandbox: workspace-write
    claude:
      enabled: true
      permissionMode: acceptEdits
```

These settings permit edits for keyboard-driven automated requests according to each provider's own controls. They do not enable a permission-bypass mode. Actions that would require a new interactive approval are denied in automated runs. `/native` remains available for provider-native interactive commands; it is not needed for ordinary voice edits. Review and synthesis stages remain read-only regardless of these settings.

## Local-first, with clear boundaries

JARVIS runs on your machine. Configuration, process management, shell execution, and project memory are local. **Local-first does not mean offline:** requests and supplied context go to your chosen coding provider, whose own tools may read additional repository files.

JARVIS does not manage provider credentials. By default, project sessions save recent conversation and the terminal transcript locally; do not put secrets into requests you intend to retain. Disable this with `sessions.enabled: false`. Codex and Claude automated runs request ephemeral native sessions; OpenCode uses its native session storage. Providers' own logging, hooks, settings and data policies still apply. Native interactive sessions use the provider's normal persistence behavior.

Only one JARVIS task runs at a time. This avoids concurrent writes by agents within the same JARVIS session; it is not a cross-process file lock. Use the tool in projects you trust, particularly when enabling shell commands, provider customizations, or edits.

## Architecture

```text
Terminal input ───────────────┐
                             ▼
Apple STT → VoiceInputRouter → Orchestrator → AgentProvider
                                  │              ├── Codex CLI
                                  │              ├── Claude CLI
                                  │              └── OpenCode CLI
                                  ▼
                         Normalized event stream
                                  │
                                  ▼
                         Terminal renderer
```

The orchestration core depends on a common `AgentProvider` interface. Adapters own process invocation, provider-specific options, and event decoding. Adding a provider requires an adapter and a registry entry; model-specific logic stays outside the core.

```text
src/
├── cli/                 # Entry point, REPL, commands, rendering
├── core/                # Orchestration and shared contracts
├── config/              # YAML loading and schema validation
├── context/             # Project instructions and Git snapshots
├── providers/
│   ├── agent/           # Codex/Claude adapters and process runner
│   └── voice.ts         # STT, TTS, and wake-word contracts
├── shell/               # Local execution and directory handling
└── voice/               # Push-to-talk state, capture bridge, shared routing
native/macos/            # Swift microphone/STT helper and privacy declarations
scripts/                 # Optional native helper build
test/                    # Isolated tests and simulated CLI processes
```

### Shared voice routing

Voice is another input to the same orchestrator. The active agent is shared between keyboard and speech:

```text
Select Claude once → Say “Check the tests” → Claude receives the request
Say “Codex, check the API” → Codex becomes active for future requests
```

`VoiceInputRouter` accepts transcripts, displays the recognized text, and routes to the current agent. Voice runs allow file edits when `voice.allowEdits` is true (the default); the prompt still requires explicit intent for commits, pushes, deletes, and other destructive actions. When the agent finishes, JARVIS reads the response through macOS's built-in `say` speech synthesizer and keeps the full answer visible in the terminal. An optional leading agent name changes the selection; mentioning an agent later in an ordinary sentence does not. The macOS capture helper starts only after a Space press reaches JARVIS's empty prompt, checks the physical key's release, and uses Apple Speech for recognition. It does not install a global keyboard event listener or record ambient audio while idle.

The next voice steps are richer voices, automatic language detection, other operating systems, selectable audio devices, and optional local wake words. The full design is in [JARVIS_V01.md](JARVIS_V01.md).

## Development

```bash
npm install
npm run dev       # Run the TypeScript entry point
npm run build     # Compile the CLI
npm run build:voice # Build the optional macOS speech helper
npm run check     # Build and run the test suite
```

Tests use temporary workspaces and simulated provider executables. They exercise the subprocess boundary without requiring credentials, network access, or model usage. Coverage includes persistent selection, voice routing, Space auto-repeat, cancellation, confidence checks, independent panel layout, cross-review, context isolation, malformed output, missing providers, shell confirmation, and CLI startup outside the installation directory. Native microphone quality and physical key behavior also need a manual test on macOS with permissions granted.

When changing an adapter, also verify its arguments against the installed provider's `--help`. The current Claude adapter uses `--permission-prompts`, verified against Claude Code **2.1.270**; older releases may require an update.

Contributions should keep the core provider-neutral, make failures visible, and preserve native permission controls. Include focused tests for behavioral changes and update the documentation when user-facing behavior changes.

## Releasing

Releases are built by GitHub Actions. CI (`.github/workflows/ci.yml`) runs the test suite and installs the packed CLI on Linux, Windows, macOS Apple Silicon and macOS Intel with Node 22 and 24.

```bash
npm version patch        # or minor / major / prerelease --preid beta
git push --follow-tags
```

The tag starts `.github/workflows/release.yml` on a macOS runner, which:

1. checks that the tag matches `package.json`, then runs the tests;
2. builds the universal (arm64 + x86_64) voice helper with `npm run build:voice:universal`;
3. packs the npm tarball, writes `SHA256SUMS` and smoke-tests the install;
4. creates the GitHub Release with the tarball attached (tags containing `-` are marked as pre-releases);
5. publishes to npm only when the repository variable `NPM_PUBLISH` is `true`, using the `NPM_TOKEN` secret or npm trusted publishing, with provenance. Pre-releases go to the `next` dist-tag.

## Current limitations

- **Early release:** provider interfaces can change; an installed executable does not guarantee valid authentication, connectivity, quota, or compatible flags.
- **Bounded session context:** project sessions restore recent text and the transcript; full native provider tool histories are not resumed.
- **Partial native passthrough:** interactive-only slash commands require `/native`.
- **No background instructions yet:** `/btw` returns an explicit not-implemented message.
- **macOS voice only:** hold-Space capture and text-to-speech need the native helper, a local keyboard, microphone/speech permissions, an available recognition language, and the macOS `say` utility. Wake words and `--live` are not implemented.
- **Voice edits follow configuration:** `voice.allowEdits` defaults to true and can be disabled for read-only voice. Provider permission controls still apply; low-confidence recognition is rejected when confidence is supplied by Apple.
- **No automatic review or semantic routing:** use `/review`; automatic routing currently means availability-based fallback.
- **Terminal messages are currently Italian:** requests can be written in English or Italian, and agents are instructed to respond in the request's language.

## Roadmap

| Release | Focus | Status |
| --- | --- | --- |
| **v0.1** | CLI, agent adapters, project context, shell access, cross-review | Implemented, early release |
| **v0.2** | Persistent native sessions, side instructions, debate, stronger task coordination | Project sessions, configurable debate and interactive choices implemented; native resume and side instructions planned |
| **v0.3** | Turn-based voice, STT/TTS, push-to-talk, quiet mode, audio device selection | macOS push-to-talk/STT implemented; remaining features planned |
| **v0.4** | Custom local wake words, aliases, sensitivity, cooldown, feedback suppression | Planned |
| **v0.5** | Low-latency live conversation and interruption | Planned |

Spoken responses through the macOS system synthesizer are already available ahead of the full v0.3 voice release.

For detailed requirements and acceptance criteria, see the [product and technical specification](JARVIS_V01.md).

## License

JARVIS is source-available under the [PolyForm Small Business License 1.0.0](LICENSE.md).

Free for personal use, evaluation, research and teaching, and free at work for companies with fewer
than 100 people and under 1,000,000 USD of revenue in the prior tax year. Larger companies, and
anyone embedding JARVIS in a product or service they sell, need a commercial license:
see [COMMERCIAL.md](COMMERCIAL.md).

Contributions are welcome, but by opening a pull request you assign the copyright in your
contribution to the project owner, so the dual licensing above stays possible.

## Integration references

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Running Claude Code programmatically](https://code.claude.com/docs/en/headless)
- [Apple Speech on-device recognition](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition)
- [macOS physical key state](https://developer.apple.com/documentation/coregraphics/cgeventsource/keystate(_:key:))

JARVIS is an independent project and is not affiliated with OpenAI or Anthropic.
