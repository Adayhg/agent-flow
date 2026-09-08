# Agent Flow

Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work. [Demo video here](https://www.youtube.com/watch?v=Ud6eDrFN-TA). 

![Agent Flow visualization](https://res.cloudinary.com/dxlvclh9c/image/upload/v1773924941/screenshot_e7yox3.png)

## Why Agent Flow?

I built Agent Flow while developing [CraftMyGame](https://craftmygame.com), a game creation platform driven by AI agents. Debugging agent behavior was painful, so we made it visual. Now we're sharing it.

Claude Code is powerful, but its execution is a black box — you see the final result, not the journey. Agent Flow makes the invisible visible:

- **Understand agent behavior** — See how Claude breaks down problems, which tools it reaches for, and how subagents coordinate
- **Debug tool call chains** — When something goes wrong, trace the exact sequence of decisions and tool calls that led there
- **See where time is spent** — Identify slow tool calls, unnecessary branching, or redundant work at a glance
- **Learn by watching** — Build intuition for how to write better prompts by observing how Claude interprets and executes them

## Features

- **Live agent visualization**: Watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows
- **Claude Code + Codex**: Auto-detects sessions from both runtimes concurrently and shows them side-by-side, or restrict to one via the `agentVisualizer.runtime` setting
- **Claude Code hooks**: Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Hosted hybrid bridge**: Optional ephemeral Windows bridge forwards filtered local Claude/Codex session metadata to the VPS Office without installing a local service
- **Codex rollout tailing**: Reads `~/.codex/sessions/**/rollout-*.jsonl` (respects `CODEX_HOME`) and surfaces tool calls, reasoning, and authoritative token counts from Codex's own event stream
- **Multi-session support**: Track multiple concurrent agent sessions with tabs
- **Interactive canvas**: Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels**: Review the full execution timeline, file attention heatmap, and message transcript
- **JSONL log file support**: Point at any JSONL event log to replay or watch agent activity
- **Office mode (MVP)**: The visualizer opens in a privacy-scoped office view by default; the existing Graph view remains available as a reversible toggle

## Office mode (MVP)

Office is a read-only projection of the event stream already consumed by Agent
Flow. It places observed agents into evidence-backed work zones and shows
parent/child relationships only when a corresponding spawn or dispatch event
exists. It does not create a second source of truth or persist layout state.

The projection discovers new Claude Code and Codex agents as events arrive.
Agent identities are deterministic and session-scoped, so equal names in
different sessions remain distinct and nested agents can be represented. Terra
and Luna receive their named avatar families; other and future model IDs are
kept as reported without a hard-coded model catalogue.

Agents also receive a short work-based label (for example, `Seguridad · Terra`
or `Validador · Luna`). Labels come from a closed vocabulary inferred from
bounded work hints; prompts and task text are not copied into the UI. The
opaque agent ID remains available for exact identification.

Office intentionally exposes only bounded names, model IDs, states, zones, and
relationship evidence. Prompts, transcript text, file paths, and tool
arguments are not passed to the Office view. The implementation is local and
read-only: it does not write to `.codex`.

For the local/demo workflow, use the commands below and open the displayed
localhost URL. Office is the initial view; select **Graph** to return to the
original canvas, and **Office** to switch back.

## Getting Started

### Quick Start (no VS Code required)

```bash
npx agent-flow-app
```

This starts the visualizer in your browser. Start a Claude Code session in another terminal — events will stream in real-time.

Options:
- `--port <number>` — change the server port (default: 3001)
- `--no-open` — don't open the browser automatically
- `--verbose` — show detailed event logs

### Standalone Web App (from source)

```bash
git clone https://github.com/patoles/agent-flow.git
cd agent-flow
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal — events will stream to the browser in real-time.

The relay binds to localhost for the local workflow. It reads the existing
Claude Code and Codex event sources; it does not require a hosted service.

### Hosted VPS Office

For an internal office that remains available when a workstation is retired,
run the agents, relay, and Next.js server on the same VPS. The browser then
opens the launcher path (for example `/agent-flow/`) and receives the relay
over the same HTTPS origin; no local server or local transcript copy is
needed.

The hosted build uses these public-build variables:

```bash
NEXT_PUBLIC_BASE_PATH=/agent-flow
NEXT_PUBLIC_RELAY_URL=/agent-flow/events
NEXT_PUBLIC_DEMO=0
```

To make the currently running local Claude/Codex sessions visible in that
hosted Office, run the ephemeral bridge from this repository (it does not
install a Windows service or local web server):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\connect-hosted.ps1
```

Stop it with `Ctrl+C` when local sessions no longer need to be shown.

For a one-click launch, double-click `open-agent-flow-office.cmd` in the
repository root. It opens the hosted PWA and starts the temporary bridge; use
`stop-agent-flow-office.ps1` to disconnect it.

The production units, reverse-proxy locations, PWA manifest, and network-only
service worker are in [`deploy/agent-flow/`](deploy/agent-flow/). Keep the
private web and relay listeners behind the launcher's existing authentication;
never publish the relay port directly or cache authenticated agent data.

For a hybrid office that also receives bounded events from an existing local
Claude/Codex channel, see [`docs/hosted-hybrid-sessions.md`](docs/hosted-hybrid-sessions.md).
This uses the VPS as the aggregator and does not require a new Windows service.

### VS Code Extension

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Flow: Open Agent Flow**
3. Start a Claude Code or Codex session in your workspace — Agent Flow will auto-detect it

Agent Flow automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Flow: Configure Claude Code Hooks** from the Command Palette.

### Runtime selection

By default Agent Flow watches both Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) concurrently in all three entry points (VS Code extension, `pnpm run dev`, `npx agent-flow-app`). Sessions are shown side-by-side and tagged by runtime. If you only use one, the other is a harmless no-op — no visible effect, no user action needed.

To restrict to one runtime:

- **VS Code extension:** set `agentVisualizer.runtime` to `"auto"` / `"claude"` / `"codex"` in your settings
- **`pnpm run dev` and `npx agent-flow-app`:** set the `AGENT_FLOW_RUNTIME` environment variable to `claude` or `codex` (defaults to watching both)

For non-default Codex installs, set the `CODEX_HOME` environment variable.

### JSONL Event Log

You can also point Agent Flow at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. Agent Flow will tail the file and visualize events as they arrive

## Commands

| Command | Description |
|---------|-------------|
| `Agent Flow: Open Agent Flow` | Open the visualizer panel |
| `Agent Flow: Open Agent Flow to Side` | Open in a side editor column |
| `Agent Flow: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Flow: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Flow |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.runtime` | `"auto"` | Which agent runtime(s) to watch: `"auto"` (both), `"claude"`, or `"codex"` |
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Requirements

- [Node.js](https://nodejs.org/) 20+ (LTS recommended)
- [pnpm](https://pnpm.io/)
- Claude Code CLI
- For the VS Code extension: a VSCode-compatible IDE 1.85+ (e.g. [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.sh/), [Windsurf](https://windsurf.com/))

## Development

```bash
pnpm i              # install dependencies for all packages
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start dev server + event relay
```

`pnpm run dev` starts both the Next.js dev server and an event relay that receives Claude Code events and streams them to the browser via SSE.

Other scripts:

| Script | Description |
|--------|-------------|
| `pnpm run dev:demo` | Start with demo/mock data |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=patoles/agent-flow&type=date&legend=bottom-right)](https://www.star-history.com/?repos=patoles%2Fagent-flow&type=date&legend=bottom-right)


## Author

Created by [Simon Patole](https://github.com/patoles), for [CraftMyGame](https://craftmygame.com).

## Privacy & Telemetry

Telemetry is disabled by default for the Office MVP/local demo and creates no
install ID or telemetry directory. To opt in explicitly, set:

```bash
AGENT_FLOW_TELEMETRY=true pnpm run dev
```

In PowerShell, use `$env:AGENT_FLOW_TELEMETRY="true"` before starting the
command. Only the explicit value `true` (case-insensitive) opts in;
`DO_NOT_TRACK=1` always disables telemetry, even when opt-in is set.
The same variables can be exported before using another local entry point.
When telemetry is enabled by a published entry point, only aggregate events
are sent; prompts, file paths, tool calls, user info, and environment variables
are not sent. Office itself has no telemetry path and does not write `.codex`.

- **Turn off:** unset `AGENT_FLOW_TELEMETRY` (the default) or use
  `export DO_NOT_TRACK=1`
  (disabled installs write zero state to disk — no `~/.agent-flow/` directory)
- **Inspect the payload:** `cat ~/.agent-flow/telemetry/events.jsonl`
- **Full schema + exact fields:** see the v0.8.1 entry in
  [extension/CHANGELOG.md](extension/CHANGELOG.md) or the `serialize()` function
  in [scripts/telemetry.ts](scripts/telemetry.ts)
- **Reset your anonymous identity:** delete `~/.agent-flow/installation-id` —
  a fresh random UUIDv4 will be generated on next run

## MVP limitations and rollback

Office states are derived only from events observed by the relay/parser. An
unseen event, an interrupted session, or an unfamiliar event type can leave an
agent as `unknown`, `stale`, or otherwise incomplete; the view does not infer
intent or claim a complete execution history.

Rollback is reversible: close the local Office/Agent Flow process and reopen
the visualizer, then select **Graph**. No deployment or canary is implied by
this MVP documentation.


## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

The name "Agent Flow" and associated logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.
