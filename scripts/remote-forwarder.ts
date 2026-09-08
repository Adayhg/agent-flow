#!/usr/bin/env node
/**
 * Ephemeral local bridge for the hosted Office.
 *
 * It reuses the existing Claude/Codex filesystem watchers but does not open a
 * public/local web server. Only bounded metadata is sent upstream. Start it
 * for the period in which local sessions should be visible and stop with
 * Ctrl+C; no Windows service or scheduled task is installed.
 */
import * as os from 'os'
import { createRelay, RelayLifecycleEvent } from './relay'
import { AgentEvent } from '../extension/src/protocol'

const DEFAULT_REMOTE_URL = 'https://launcher.104-248-32-222.sslip.io/agent-flow/ingest'
const ALLOWED_PAYLOAD_KEYS = new Set([
  'agent', 'name', 'parent', 'child', 'model', 'isMain', 'isError', 'tool',
  'role', 'workRole', 'id', 'tokens',
])

function safePayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!ALLOWED_PAYLOAD_KEYS.has(key)) continue
    if (typeof raw === 'string') result[key] = raw.slice(0, 160)
    else if (typeof raw === 'number' || typeof raw === 'boolean') result[key] = raw
  }
  const breakdown = (value as Record<string, unknown>).breakdown
  if (breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)) {
    const bounded: Record<string, number> = {}
    for (const [key, raw] of Object.entries(breakdown as Record<string, unknown>)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) bounded[key] = raw
    }
    if (Object.keys(bounded).length > 0) result.breakdown = bounded
  }
  return result
}

function safeEvent(event: AgentEvent): AgentEvent {
  return {
    time: Number.isFinite(event.time) ? event.time : Date.now() / 1000,
    type: event.type,
    payload: safePayload(event.payload),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(typeof event.sequence === 'number' ? { sequence: event.sequence } : {}),
    source: 'local',
    hostId: HOST_ID,
    runtime: event.runtime === 'claude' || event.runtime === 'codex' ? event.runtime : RUNTIME,
  }
}

function safeLabel(event: RelayLifecycleEvent): string {
  const prefix = event.runtime === 'codex' ? 'Codex' : 'Claude'
  return `${prefix} ${event.sessionId.slice(0, 8)}`
}

const REMOTE_URL = process.env.AGENT_FLOW_REMOTE_URL || DEFAULT_REMOTE_URL
const TOKEN = process.env.AGENT_FLOW_INGEST_TOKEN || ''
const HOST_ID = process.env.AGENT_FLOW_HOST_ID || os.hostname()
const RUNTIME = process.env.AGENT_FLOW_RUNTIME === 'claude' || process.env.AGENT_FLOW_RUNTIME === 'codex'
  ? process.env.AGENT_FLOW_RUNTIME
  : 'unknown'

if (!TOKEN) {
  console.error('Missing AGENT_FLOW_INGEST_TOKEN. Use the hosted launcher so the token is obtained without printing it.')
  process.exit(2)
}

let chain = Promise.resolve()
let acceptEvents = true
const activeSessions = new Map<string, RelayLifecycleEvent>()

function enqueue(body: Record<string, unknown>): void {
  if (!acceptEvents) return
  chain = chain.then(async () => {
    const response = await fetch(REMOTE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`hosted ingest returned HTTP ${response.status}`)
  }).catch((error: unknown) => {
    // Keep watching after a transient network failure. The Office is an
    // observability view; a failed update must not stop Claude/Codex sessions.
    const message = error instanceof Error ? error.message : 'unknown ingest error'
    console.error(`[agent-flow] ${message}`)
  })
}

function sendLifecycle(event: RelayLifecycleEvent): void {
  const key = `${event.runtime}:${event.sessionId}`
  if (event.type === 'ended') activeSessions.delete(key)
  else activeSessions.set(key, event)
  const session = {
    id: event.sessionId,
    label: safeLabel(event),
    status: event.type === 'ended' ? 'completed' : 'active',
    lastActivityTime: Date.now(),
  }
  enqueue({
    source: 'local',
    hostId: HOST_ID,
    runtime: event.runtime === 'claude' || event.runtime === 'codex' ? event.runtime : RUNTIME,
    lifecycle: event.type,
    session,
  })
}

async function main(): Promise<void> {
  const workspace = process.env.AGENT_FLOW_WORKSPACE || process.cwd()
  const watchAll = process.env.AGENT_FLOW_WATCH_ALL !== '0'
  const relay = await createRelay({
    workspace,
    runtime: RUNTIME === 'unknown' ? 'auto' : RUNTIME,
    source: 'local',
    hostId: HOST_ID,
    watchAll,
    enableClaudeHookServer: false,
    verbose: process.env.AGENT_FLOW_VERBOSE === '1',
    onEvent: (event) => enqueue({
      source: 'local',
      hostId: HOST_ID,
      runtime: event.runtime === 'claude' || event.runtime === 'codex' ? event.runtime : RUNTIME,
      event: safeEvent(event),
    }),
    onSessionLifecycle: sendLifecycle,
  })

  console.log(`[agent-flow] connected to hosted Office (${watchAll ? 'all local sessions' : workspace})`)
  console.log('[agent-flow] Ctrl+C disconnects; no local service remains installed')

  const cleanup = async () => {
    if (!acceptEvents) return
    for (const event of [...activeSessions.values()]) {
      sendLifecycle({ ...event, type: 'ended' })
    }
    acceptEvents = false
    relay.dispose()
    await chain
    process.exit(0)
  }
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('SIGHUP', cleanup)
}

main().catch((error: unknown) => {
  console.error('[agent-flow] unable to connect:', error instanceof Error ? error.message : error)
  process.exit(1)
})
