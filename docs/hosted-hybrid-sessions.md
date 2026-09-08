# Hosted hybrid sessions

The production Office can aggregate sessions observed on the VPS and events
forwarded by an existing local runtime channel. The VPS remains the only
public source of truth; no local Agent Flow server is required.

## Ingest contract

Send a `POST` to `/agent-flow/ingest` with `Authorization: Bearer
<AGENT_FLOW_INGEST_TOKEN>`:

```json
{
  "source": "local",
  "hostId": "windows-main",
  "runtime": "claude",
  "session": {
    "id": "session-id",
    "label": "Local Claude session",
    "status": "active"
  },
  "events": [
    {
      "time": 12.4,
      "sequence": 7,
      "type": "agent_spawn",
      "sessionId": "session-id",
      "payload": {
        "name": "Terra",
        "model": "Terra",
        "isMain": true
      }
    }
  ]
}
```

Only bounded lifecycle metadata is forwarded. Prompt text, task descriptions,
tool arguments, file paths, and tool results are deliberately removed at the
relay boundary. Events are namespaced by origin, host, runtime, and session so
equal local/VPS identifiers never collide.

## Runtime sources

- VPS Claude/Codex sessions continue to be watched directly from their JSONL
  sources.
- A local Claude hook or existing Codex bridge may use this endpoint if that
  channel is already available.
- A new Windows daemon, server, or Agent Flow installation is not required.
- If a runtime exposes no outgoing hook or bridge, it cannot be observed live
  under the no-local-service constraint; the Office will not fabricate it.

## Ephemeral Windows bridge

The repository includes `scripts/connect-hosted.ps1` for the local Claude/Codex
apps. It obtains the ingest token through the existing VPS SSH access, keeps it
only in the process environment, and starts a temporary filesystem watcher.
It does not install a Windows service, scheduled task, or resident web server.

Run it from the repository folder and stop it with `Ctrl+C`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\connect-hosted.ps1
```

The bridge watches all recent local sessions by default and forwards only
bounded role/model/tool metadata. Prompts, file paths, arguments, tool results,
and task text are removed before the HTTP request is made. If the bridge is
not running, the hosted Office continues to show VPS sessions normally.

For a launcher-style workflow, double-click `open-agent-flow-office.cmd` in the
repository root. It opens the hosted PWA and starts one bridge instance; a
second click reuses the existing connection. Run `stop-agent-flow-office.ps1`
when local sessions should stop being forwarded.

## Expected response

The relay returns `202` with the number of accepted events. Duplicate events
are ignored using their source, session, sequence, type, and bounded payload.
The endpoint returns `503` until a token is configured on the VPS and `401`
for an invalid token.
