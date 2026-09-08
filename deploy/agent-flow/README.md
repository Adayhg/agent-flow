# Agent Flow Office on the VPS

This is the production shape for the internal launcher/PWA. The Windows
checkout is only a development/review source; the runtime lives on the VPS.

## Runtime contract

- App root: `/home/discanary/apps/agent-flow-office`
- Watch root: `/home/discanary` so new Claude/Codex sessions and their subagents
  under the VPS user's workspaces are incorporated automatically.
- Private web listener: `172.17.0.1:8612` (kept separate from the existing Mantenimiento service on `8610`)
- Private SSE relay: `172.17.0.1:3001`
- Public path: `/agent-flow/` on the already authenticated launcher host
- Browser SSE path: `/agent-flow/events`
- Workspace observed by the relay: `/home/discanary/apps/agent-flow-office`
- Claude and Codex session data remain on the VPS under the `discanary` account
- A future local source can submit bounded, authenticated lifecycle events to
  `/agent-flow/ingest`; this is an optional hook/bridge channel, not a new
  Windows service. The relay rejects the route until a token is configured.

The relay must run on the same host as the agents. It is not a GitHub Actions
job and it is not a Windows process.

For a pre-production preview, keep the same code and use a separate checkout,
path, and ports (for example `/agent-flow-preview/`, `8611`, and `3002`) with
`AGENT_FLOW_RELAY_PORT=3002`. Never point the preview proxy at the production
ports.

## New agent onboarding contract

The Office is event-driven, so adding a subagent to a supported Claude or Codex
session does not require a new page or another deployment. The runtime emits
the existing lifecycle events (`agent_spawn`, `model_detected`,
`subagent_dispatch`, and the normal tool or completion events). A future runtime
adapter can use the same contract. The projection keeps an opaque
session-scoped identity, derives a bounded work label, and gives an
unrecognised future model a stable generated avatar. Task text is not copied
into the Office view. This keeps new Terra, Luna, Codex, Claude, or future
model IDs visible without exposing their prompts or requiring a catalogue edit.

## Build an approved release on the VPS

Run only after the corresponding GitHub PR has been reviewed and the release
identity has been recorded:

```bash
cd /home/discanary/apps/agent-flow-office
pnpm install --frozen-lockfile
node scripts/build-relay.js
NEXT_PUBLIC_BASE_PATH=/agent-flow \
NEXT_PUBLIC_RELAY_URL=/agent-flow/events \
NEXT_PUBLIC_DEMO=0 \
pnpm --dir web build
```

The web build embeds the public path and SSE route. Do not use the development
server in production.

## Services

Install the two unit files in this directory, then perform a controlled
`daemon-reload`, enable, and start. The release operator must verify the
effective unit files before starting them; a merge alone is not deployment
evidence.

```bash
sudo install -m 0644 deploy/agent-flow/agent-flow-relay.service /etc/systemd/system/
sudo install -m 0644 deploy/agent-flow/agent-flow-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agent-flow-relay.service agent-flow-web.service
```

The relay needs write access to `/home/discanary/.claude/agent-flow` for Claude
hook discovery. If that directory cannot be created, stop the release and fix
the VPS ownership/permissions; do not silently publish an office that cannot
observe the configured runtime.

To enable the optional ingress, create an environment file owned by `discanary`
at `/home/discanary/apps/agent-flow-office/.relay.env` with mode `0600` and one
line:

```text
AGENT_FLOW_INGEST_TOKEN=<long-random-token>
```

Keep that value out of GitHub and out of the URL. The local runtime channel,
when available, sends `Authorization: Bearer <token>` to the public ingest
location documented below.

## Nginx Proxy Manager route

Create the route on the existing authenticated launcher host. Keep the private
ports inaccessible from the Internet and reuse the launcher's existing access
policy. The custom locations are documented in
`nginx-proxy-manager-locations.md`.

After the proxy change, verify all of the following from an authenticated
browser session:

1. `https://<launcher-host>/agent-flow/` returns the Office UI.
2. `https://<launcher-host>/agent-flow/healthz` returns the web service JSON.
3. The private relay `http://172.17.0.1:3001/healthz` returns the relay service JSON.
4. `/agent-flow/manifest.webmanifest` and `/agent-flow/sw.js` are reachable.
5. `/agent-flow/events` remains an open SSE stream (proxy buffering disabled).
6. A real VPS agent session appears with its role label and lifecycle events.
7. Reopening the page from another device still shows the remote office.

Do not cache the authenticated HTML, SSE stream, transcripts, tool output, or
operational results in the PWA service worker.
