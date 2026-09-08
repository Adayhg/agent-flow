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

## Expected response

The relay returns `202` with the number of accepted events. Duplicate events
are ignored using their source, session, sequence, type, and bounded payload.
The endpoint returns `503` until a token is configured on the VPS and `401`
for an invalid token.
