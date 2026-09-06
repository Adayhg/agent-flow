# Office mode

Office mode is the default, read-only presentation introduced by the MVP. It
is a privacy-scoped projection over Agent Flow's existing Claude Code and Codex
events and materialized graph; it is not a replacement event store.

## Local architecture

The local relay/parser watches the existing Claude Code project transcripts and
Codex rollout JSONL files (honouring `CODEX_HOME` when set), then streams
observed events to the web UI over a localhost SSE connection. The Office
projection consumes only the small event/graph contract it needs:

- bounded agent name, model ID, state/zone, session ID, and relationship evidence;
- no prompt or transcript payload, file path, or tool argument in the Office
  projection;
- no Office persistence and no writes to `.codex`.

The projection is pure and replayable. It can consume events or adapt the
already materialized Graph state. Unknown event types are ignored instead of
being converted into invented agent states. A stale decoration is applied
when the event clock has no recent observation (120 seconds by default).

## Discovery, identity, and nesting

New Claude Code and Codex sessions/agents are discovered automatically as the
local watchers observe them. Office IDs are deterministic opaque IDs derived
from the source agent ID and session ID. This keeps an identity stable across
render/replay while preventing same-named agents in separate sessions from
colliding.

## Work-based names

The UI assigns each agent a short role label from a closed Spanish vocabulary:
Orquestador, Seguridad, Validador, Investigador, Implementador, Documentador,
Diseñador, Integrador, Analista, or Especialista. The role is inferred from
bounded work hints such as a Codex `task_name`, a tool name, or the model family.
The original task/prompt is never copied into the label. The stable opaque ID
remains visible in the detail panel so agents with the same role are still
distinguishable.

Nested agents are connected only by explicit `agent_spawn` or
`subagent_dispatch` evidence (or an existing Graph parent-child edge). Matching
names alone never create a parent/child relationship, and a parent that has
not yet been observed is not invented.

## Models and states

Model IDs are displayed as reported; there is no catalogue that blocks Terra,
Luna, or future providers/models. IDs containing Terra or Luna select the
corresponding avatar family. Other IDs use a deterministic generated avatar
key while preserving the original model ID.

Zones mirror evidence-backed states such as planning, researching, editing,
executing, waiting for approval, blocked, completed, idle, unknown, and stale.
These are observations, not a claim about hidden reasoning or the full state
of a runtime.

## Privacy and localhost

Office is local and read-only. It deliberately omits prompts, paths, and tool
arguments from its view contract, and it does not write `.codex`. Telemetry is
disabled by default for the MVP/demo, so no environment setting is required:

```bash
pnpm run dev
```

To opt in, set `AGENT_FLOW_TELEMETRY=true`; `DO_NOT_TRACK=1` always prevails.
In PowerShell, use `$env:AGENT_FLOW_TELEMETRY="true"` before running the
command.

The relay and standalone UI use localhost (the relay's SSE endpoint is bound
to `127.0.0.1`). This is a local workflow, not a hosted deployment.

## Start, demo, test, and build

From the repository root:

```bash
pnpm run dev
```

Open the reported `http://localhost:3000` URL. For a no-runtime visual check,
use `pnpm run dev:demo`. Useful verification commands are:

```bash
pnpm run test
pnpm --filter agent-flow-web run build
pnpm run build:all
```

The focused Office projection tests live in
`web/lib/office/project-office.test.ts`; the commands above are the repository
test/build entry points and do not constitute a production deployment or
canary.

## Rollback and honest limitations

To roll back the presentation, close the local Agent Flow/Office process and
reopen the visualizer, then select **Graph**. Switching back to **Office** is
equally reversible; no data migration is required.

States and relationships are based only on events actually observed by the
watcher/parser. Missing, delayed, interrupted, or unfamiliar events can leave
an agent unknown, stale, or incomplete. Office must not be read as proof of
intent, hidden work, or a complete execution history. No 30-minute canary or
deployment is claimed here because neither was executed as part of this MVP.
