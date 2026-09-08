/**
 * Shared relay module — receives agent events and streams them to SSE clients.
 * Used by both the dev relay server and the standalone app.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { readNewFileLines, foldPathCase } from '../extension/src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines } from '../extension/src/subagent-watcher'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import {
  INACTIVITY_TIMEOUT_MS, SCAN_INTERVAL_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
} from '../extension/src/constants'
import { setLogLevel } from '../extension/src/logger'
import type { TelemetryClient } from './telemetry'

const MAX_EVENT_BUFFER = 5000
const MAX_EXTERNAL_BODY_BYTES = 256 * 1024
const MAX_EXTERNAL_DEDUPE_KEYS = 10000
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

let relayCreated = false
let verbose = false
let sessionEventCount = 0
type EventSource = 'local' | 'vps' | 'unknown'
type RuntimeName = 'claude' | 'codex' | 'unknown'
let relaySource: EventSource = 'vps'
let relayHostId = os.hostname()
let ingestToken = ''
let relayEventSink: ((event: AgentEvent) => void) | null = null
let relayLifecycleSink: ((event: RelayLifecycleEvent) => void) | null = null
/** Distinct model IDs seen across all watched sessions during this relay session.
 *  Populated from `model_detected` events (emitted by both the Claude transcript
 *  parser and the Codex rollout parser). Read at session_end for telemetry. */
const observedModels = new Set<string>()
const externalSessions = new Map<string, SessionInfo>()
const externalDedupeKeys = new Set<string>()

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'unknown'
}

/** Namespace session IDs so local and VPS sessions can never collide. */
function publicSessionId(source: EventSource, hostId: string, runtime: RuntimeName, sessionId: string): string {
  return `${source}:${safeSegment(hostId)}:${runtime}:${sessionId}`
}

function publicOrigin(source?: EventSource, hostId?: string, runtime?: RuntimeName) {
  return {
    source: source || relaySource,
    hostId: hostId || relayHostId,
    runtime: runtime || 'unknown',
  } as const
}

function publicEvent(event: AgentEvent, runtime?: RuntimeName): AgentEvent {
  const origin = publicOrigin(event.source, event.hostId, runtime || event.runtime)
  return {
    ...event,
    source: origin.source,
    hostId: origin.hostId,
    runtime: origin.runtime,
    ...(event.sessionId ? { sessionId: publicSessionId(origin.source, origin.hostId, origin.runtime, event.sessionId) } : {}),
  }
}

function publicSession(info: SessionInfo, runtime: RuntimeName, source: EventSource = relaySource, hostId = relayHostId): SessionInfo {
  return {
    ...info,
    id: publicSessionId(source, hostId, runtime, info.id),
    source,
    hostId,
    runtime,
  }
}

// agent-flow-app version. Inlined by esbuild at bundle time via `define`.
// In dev (running from source via tsx), falls back to reading app/package.json.
declare const AGENT_FLOW_APP_VERSION: string | undefined
function resolveAgentFlowVersion(): string {
  try {
    if (typeof AGENT_FLOW_APP_VERSION === 'string' && AGENT_FLOW_APP_VERSION) {
      return AGENT_FLOW_APP_VERSION
    }
  } catch { /* ReferenceError in unbundled dev — fall through */ }
  try {
    const pkgPath = path.join(__dirname, '..', 'app', 'package.json')
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'
    }
  } catch { /* ignore */ }
  return '0.0.0'
}

function log(...args: unknown[]) {
  if (verbose) console.log(...args)
}

// ─── SSE client management ──────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()

function sendSSE(res: http.ServerResponse, data: unknown) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {
    sseClients.delete(res)
  }
}

function broadcast(data: string) {
  for (const res of sseClients) {
    try { res.write(`data: ${data}\n\n`) } catch {
      sseClients.delete(res)
    }
  }
}

// ─── Event buffering ────────────────────────────────────────────────────────

const eventBuffer = new Map<string, AgentEvent[]>()

function broadcastEvent(event: AgentEvent, runtime?: RuntimeName) {
  // A remote forwarder can subscribe to the raw, un-namespaced event before
  // this relay adds its public source/host/runtime namespace. The hosted
  // relay performs that namespacing exactly once on ingest.
  relayEventSink?.({
    ...event,
    source: event.source || relaySource,
    hostId: event.hostId || relayHostId,
    runtime: event.runtime || runtime || 'unknown',
  })
  const observedEvent = publicEvent(event, runtime)
  sessionEventCount++
  if (observedEvent.type === 'model_detected') {
    const m = (observedEvent.payload as { model?: unknown } | undefined)?.model
    if (typeof m === 'string' && m.length > 0) observedModels.add(m)
  }
  const sid = observedEvent.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  log(`[event] ${observedEvent.type} (session ${sid})`)

  if (observedEvent.sessionId) {
    let buf = eventBuffer.get(observedEvent.sessionId) || []
    buf.push(observedEvent)
    if (buf.length > MAX_EVENT_BUFFER) {
      buf = buf.slice(buf.length - MAX_EVENT_BUFFER)
    }
    eventBuffer.set(observedEvent.sessionId, buf)

    const external = externalSessions.get(observedEvent.sessionId)
    if (external) {
      external.lastActivityTime = Date.now()
      external.status = 'active'
    }
  }

  broadcast(JSON.stringify({ type: 'agent-event', event: observedEvent }))
}

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string, runtime: RuntimeName = 'unknown') {
  relayLifecycleSink?.({
    type,
    sessionId,
    label,
    runtime,
    source: relaySource,
    hostId: relayHostId,
  })
  const session = publicSession({
    id: sessionId, label, status: type === 'ended' ? 'completed' : 'active',
    startTime: Date.now(), lastActivityTime: Date.now(),
  }, runtime)
  if (type === 'started') {
    broadcast(JSON.stringify({ type: 'session-started', session }))
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId: session.id }))
  } else if (type === 'updated') {
    broadcast(JSON.stringify({ type: 'session-updated', sessionId: session.id, label }))
  }
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) return (Date.now() - session.sessionStartTime) / 1000
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  const bd = session.contextBreakdown
  const total = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, tokens: total, breakdown: { ...bd } },
    sessionId,
  })
}

function emitEvent(event: AgentEvent, sessionId?: string) {
  broadcastEvent(sessionId ? { ...event, sessionId } : event, 'claude')
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label, 'claude'),
  emitContextUpdate,
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  getLastActivityTime: (sessionId: string) => sessions.get(sessionId)?.lastActivityTime,
  resetInactivityTimer: (sessionId: string) => resetInactivityTimer(sessionId),
}

function resetInactivityTimer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const wasCompleted = session.sessionCompleted
  session.lastActivityTime = Date.now()
  session.sessionCompleted = false

  if (wasCompleted) {
    broadcastEvent({
      time: elapsed(sessionId),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
      sessionId,
    }, 'claude')
    broadcastSessionLifecycle('started', sessionId, session.label, 'claude')
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
      session.sessionCompleted = true
      broadcastEvent({
        time: elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME },
        sessionId,
      }, 'claude')
      broadcastSessionLifecycle('ended', sessionId, session.label, 'claude')
    }
  }, INACTIVITY_TIMEOUT_MS)
}

function watchSession(sessionId: string, filePath: string) {
  const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
  const session: WatchedSession = {
    sessionId, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0,
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: defaultLabel, labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)

  const stat = fs.statSync(filePath)
  const catchUpEntries = parser.prescanExistingContent(filePath, stat.size, session)
  session.fileSize = stat.size
  parser.extractSessionLabel(catchUpEntries, session)

  broadcastSessionLifecycle('started', sessionId, session.label, 'claude')
  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true, task: session.label, ...(session.model ? { model: session.model } : {}) },
    sessionId,
  }, 'claude')
  session.sessionDetected = true

  emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
  parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

  session.fileWatcher = fs.watch(filePath, (eventType) => {
    if (eventType === 'change') readNewLines(sessionId)
  })

  session.pollTimer = setInterval(() => {
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
    scanSubagentsDir(watcherDelegate, parser, sessionId)
  }, POLL_FALLBACK_MS)

  session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)

  log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize)
  if (!result) return
  session.fileSize = result.newSize
  for (const line of result.lines) {
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  handlePermissionDetection(watcherDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)
}

// ─── Session scanner ────────────────────────────────────────────────────────

function scanForActiveSessions(workspace: string, watchAll = false) {
  if (!fs.existsSync(CLAUDE_DIR)) return

  const dirsToScan: string[] = []
  if (watchAll) {
    try {
      for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
        if (dir.isDirectory()) dirsToScan.push(path.join(CLAUDE_DIR, dir.name))
      }
    } catch { /* ignore an unavailable Claude directory */ }
  }

  let resolved = workspace
  try { resolved = fs.realpathSync(resolved) } catch {}
  const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')

  // Case-folded on Windows — VS Code/shells report `c:\...` while Claude Code
  // encodes `C--...`, so exact string matching never found the project dir there.
  if (!watchAll) {
    const encodedFolded = foldPathCase(encoded)
    try {
      for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        const nameFolded = foldPathCase(dir.name)
        if (nameFolded === encodedFolded || nameFolded.startsWith(encodedFolded + '-')) {
          dirsToScan.push(path.join(CLAUDE_DIR, dir.name))
        }
      }
    } catch {
      // readdir failed — fall back to the exact-match dir if it exists
      const projectDir = path.join(CLAUDE_DIR, encoded)
      if (fs.existsSync(projectDir)) dirsToScan.push(projectDir)
    }
  }

  for (const dirPath of dirsToScan) {
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = path.basename(file, '.jsonl')

        let newestMtime = stat.mtimeMs
        const subagentsDir = path.join(dirPath, sessionId, 'subagents')
        try {
          if (fs.existsSync(subagentsDir)) {
            for (const subFile of fs.readdirSync(subagentsDir)) {
              if (!subFile.endsWith('.jsonl')) continue
              const subStat = fs.statSync(path.join(subagentsDir, subFile))
              if (subStat.mtimeMs > newestMtime) newestMtime = subStat.mtimeMs
            }
          }
        } catch {}

        const ageSeconds = (Date.now() - newestMtime) / 1000
        if (ageSeconds <= ACTIVE_SESSION_AGE_S && !sessions.has(sessionId)) {
          watchSession(sessionId, filePath)
        }
      }
    } catch {}
  }
}

// ─── Discovery file ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch {}
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

let discoveryFilePath: string | null = null

function writeDiscoveryFile(port: number, workspace: string) {
  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  const hash = hashWorkspace(workspace)
  discoveryFilePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  fs.writeFileSync(discoveryFilePath, JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n')
}

function removeDiscoveryFile() {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Handle an incoming SSE connection */
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Accept privacy-filtered events from an existing local runtime channel. */
  handleIngest: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Clean up all resources */
  dispose: () => void
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  telemetry?: TelemetryClient
  /** Which runtimes to watch. Defaults to AGENT_FLOW_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-flow-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
  /** Origin metadata used when this relay forwards local sessions upstream. */
  source?: EventSource
  hostId?: string
  /** Subscribe to raw local events/lifecycle without starting an HTTP server. */
  onEvent?: (event: AgentEvent) => void
  onSessionLifecycle?: (event: RelayLifecycleEvent) => void
  /** Watch every Claude/Codex session, regardless of the workspace path. */
  watchAll?: boolean
}

export interface RelayLifecycleEvent {
  type: 'started' | 'ended' | 'updated'
  sessionId: string
  label: string
  runtime: RuntimeName
  source: EventSource
  hostId: string
}

interface ExternalIngestBody {
  source?: EventSource
  hostId?: string
  runtime?: RuntimeName
  lifecycle?: 'started' | 'ended' | 'updated'
  session?: {
    id?: string
    label?: string
    status?: 'active' | 'completed'
    startTime?: number
    lastActivityTime?: number
  }
  event?: Partial<AgentEvent>
  events?: Array<Partial<AgentEvent>>
}

const EXTERNAL_EVENT_TYPES = new Set<AgentEvent['type']>([
  'agent_spawn', 'agent_complete', 'agent_idle', 'message', 'context_update',
  'model_detected', 'tool_call_start', 'tool_call_end', 'subagent_dispatch',
  'subagent_return', 'permission_requested', 'error',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeExternalPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {}
  // Keep only bounded metadata. In particular, prompts, task text, arguments,
  // file paths, and tool results must never be forwarded by the local bridge.
  const allowed = new Set(['agent', 'name', 'parent', 'child', 'model', 'isMain', 'isError', 'tool', 'role', 'workRole', 'id', 'tokens'])
  const result: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!allowed.has(key)) continue
    if (typeof raw === 'string') result[key] = raw.slice(0, 160)
    else if (typeof raw === 'number' || typeof raw === 'boolean') result[key] = raw
  }
  if (isRecord(value.breakdown)) {
    const breakdown: Record<string, number> = {}
    for (const [key, raw] of Object.entries(value.breakdown)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) breakdown[key] = raw
    }
    if (Object.keys(breakdown).length) result.breakdown = breakdown
  }
  return result
}

function normalizeExternalEvent(raw: unknown, defaults: { hostId: string; runtime: RuntimeName; sessionId?: string }): AgentEvent | null {
  if (!isRecord(raw) || typeof raw.type !== 'string' || !EXTERNAL_EVENT_TYPES.has(raw.type as AgentEvent['type'])) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : defaults.sessionId
  if (!sessionId) return null
  const time = typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : Date.now() / 1000
  const sequence = typeof raw.sequence === 'number' && Number.isFinite(raw.sequence) ? raw.sequence : undefined
  return {
    time,
    type: raw.type as AgentEvent['type'],
    payload: safeExternalPayload(raw.payload),
    sessionId,
    source: 'local',
    hostId: defaults.hostId,
    runtime: defaults.runtime,
    ...(sequence === undefined ? {} : { sequence }),
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > MAX_EXTERNAL_BODY_BYTES) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(data)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

function resolveRuntimeMode(explicit?: RelayRuntimeMode): RelayRuntimeMode {
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_FLOW_RUNTIME
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const { workspace } = options
  verbose = options.verbose ?? false
  // Keep warnings visible without --verbose — actionable hints (e.g. "Codex
  // sessions exist but none match this workspace") must reach the user.
  if (!verbose) setLogLevel('warn')
  if (relayCreated) {
    throw new Error('createRelay() can only be called once per process')
  }
  relayCreated = true
  relaySource = options.source || (process.env.AGENT_FLOW_SOURCE === 'local' ? 'local' : 'vps')
  relayHostId = options.hostId || process.env.AGENT_FLOW_HOST_ID || os.hostname()
  ingestToken = process.env.AGENT_FLOW_INGEST_TOKEN || ''
  relayEventSink = options.onEvent || null
  relayLifecycleSink = options.onSessionLifecycle || null
  externalSessions.clear()
  externalDedupeKeys.clear()

  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanInterval: NodeJS.Timeout | null = null
  let projectDirWatcher: fs.FSWatcher | null = null

  if (wantClaude) {
    hookServer = new HookServer()
    const hookPort = await hookServer.start()
    if (hookPort === HOOK_SERVER_NOT_STARTED) {
      throw new Error('Failed to start hook server (port in use)')
    }

    hookServer.onEvent((event: AgentEvent) => {
      broadcastEvent({ ...event, runtime: 'claude' }, 'claude')
    })

    writeDiscoveryFile(hookPort, workspace)

    scanForActiveSessions(workspace, options.watchAll === true)
    scanInterval = setInterval(() => scanForActiveSessions(workspace, options.watchAll === true), SCAN_INTERVAL_MS)

    const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
    const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = path.join(CLAUDE_DIR, encoded)
    if (fs.existsSync(projectDir)) {
      try {
        projectDirWatcher = fs.watch(projectDir, (_eventType, filename) => {
          if (filename?.endsWith('.jsonl')) scanForActiveSessions(workspace)
        })
      } catch {}
    }
  }

  // ─── Codex runtime ────────────────────────────────────────────────────────
  // Watch Codex rollouts in parallel. No-op if ~/.codex/sessions doesn't
  // exist or no sessions match the current workspace.
  // We don't subscribe to onSessionDetected — it fires together with the
  // lifecycle 'started' event in CodexSessionWatcher.attachSession, so
  // wiring both would double-broadcast session-started to SSE clients.
  let codexWatcher: CodexSessionWatcher | null = null
  if (wantCodex) {
    codexWatcher = new CodexSessionWatcher(options.watchAll === true ? null : workspace)
    codexWatcher.onEvent((event) => broadcastEvent(event, 'codex'))
    codexWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label, 'codex')
    })
    codexWatcher.start()
  }

  const telemetry = options.telemetry
  const sessionStart = Date.now()
  let relayDisposed = false
  const relaySessionId = `relay-${process.pid}-${Math.floor(sessionStart / 1000)}`
  sessionEventCount = 0

  const agentFlowVersion = resolveAgentFlowVersion()

  const baseEvent = () => ({
    session_id: relaySessionId,
    agent_flow_version: agentFlowVersion,
    os: os.platform(),
    arch: os.arch(),
  })

  telemetry?.emit({ ...baseEvent(), event_type: 'session_start' })

  process.on('uncaughtException', (err) => {
    try {
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'error',
        error_class: err?.constructor?.name ?? 'Error',
      })
    } catch { /* don't let the handler itself crash */ }
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  const upsertExternalSession = (rawId: string, hostId: string, runtime: RuntimeName, input?: ExternalIngestBody['session']): SessionInfo => {
    const id = publicSessionId('local', hostId, runtime, rawId)
    const existing = externalSessions.get(id)
    const next: SessionInfo = {
      id,
      label: typeof input?.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 160) : `Local ${runtime} ${rawId.slice(0, SESSION_ID_DISPLAY)}`,
      status: input?.status === 'completed' ? 'completed' : 'active',
      startTime: typeof input?.startTime === 'number' ? input.startTime : existing?.startTime ?? Date.now(),
      lastActivityTime: typeof input?.lastActivityTime === 'number' ? input.lastActivityTime : Date.now(),
      source: 'local', hostId, runtime,
    }
    externalSessions.set(id, next)
    if (!existing) {
      broadcast(JSON.stringify({ type: 'session-started', session: next }))
    } else if (existing.label !== next.label) {
      broadcast(JSON.stringify({ type: 'session-updated', sessionId: id, label: next.label }))
    }
    return next
  }

  const rememberExternalEvent = (event: AgentEvent): boolean => {
    const raw = `${event.hostId}|${event.runtime}|${event.sessionId}|${event.sequence ?? ''}|${event.type}|${JSON.stringify(event.payload)}`
    const key = crypto.createHash('sha256').update(raw).digest('hex')
    if (externalDedupeKeys.has(key)) return false
    externalDedupeKeys.add(key)
    if (externalDedupeKeys.size > MAX_EXTERNAL_DEDUPE_KEYS) {
      const oldest = externalDedupeKeys.values().next().value
      if (typeof oldest === 'string') externalDedupeKeys.delete(oldest)
    }
    return true
  }

  return {
    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })

      sseClients.add(res)
      log(`[sse] Client connected (${sseClients.size} total)`)

      req.on('close', () => {
        sseClients.delete(res)
        log(`[sse] Client disconnected (${sseClients.size} total)`)
      })

      // Send current session list (Claude + Codex)
      const sessionList: SessionInfo[] = []
      for (const session of sessions.values()) {
        if (!session.sessionDetected) continue
        sessionList.push(publicSession({
          id: session.sessionId, label: session.label,
          status: session.sessionCompleted ? 'completed' : 'active',
          startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
        }, 'claude'))
      }
      if (codexWatcher) {
        sessionList.push(...codexWatcher.getActiveSessions().map(session => publicSession(session, 'codex')))
      }
      sessionList.push(...externalSessions.values())
      if (sessionList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: sessionList })
      }

      // Replay buffered events for the most recent active session
      const sorted = [...sessionList].sort((a, b) => {
        const aActive = a.status === 'active' ? 1 : 0
        const bActive = b.status === 'active' ? 1 : 0
        if (aActive !== bActive) return bActive - aActive
        return b.lastActivityTime - a.lastActivityTime
      })
      if (sorted.length > 0) {
        const buffered = eventBuffer.get(sorted[0].id)
        if (buffered) {
          sendSSE(res, { type: 'agent-event-batch', events: buffered })
        }
      }
    },

    handleIngest(req: http.IncomingMessage, res: http.ServerResponse) {
      const suppliedToken = typeof req.headers.authorization === 'string'
        ? req.headers.authorization.replace(/^Bearer\s+/i, '')
        : typeof req.headers['x-agent-flow-token'] === 'string' ? req.headers['x-agent-flow-token'] : ''
      if (!ingestToken) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: 'ingest-disabled' }))
        return
      }
      if (suppliedToken !== ingestToken) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ error: 'unauthorized' }))
        return
      }

      void readJsonBody(req).then(raw => {
        if (!isRecord(raw)) throw new Error('invalid-payload')
        const body = raw as ExternalIngestBody
        if (body.source && body.source !== 'local') throw new Error('source-must-be-local')
        if (typeof body.hostId !== 'string' || !body.hostId.trim()) throw new Error('host-id-required')
        if (body.runtime !== 'claude' && body.runtime !== 'codex') throw new Error('runtime-required')
        const hostId = body.hostId.trim().slice(0, 80)
        const runtime = body.runtime
        const incoming = [
          ...(Array.isArray(body.events) ? body.events : []),
          ...(body.event ? [body.event] : []),
        ]
        const defaultSessionId = body.session?.id || incoming.find(item => isRecord(item) && typeof item.sessionId === 'string')?.sessionId
        let session: SessionInfo | undefined
        if (defaultSessionId) session = upsertExternalSession(defaultSessionId, hostId, runtime, body.session)

        let accepted = 0
        for (const rawEvent of incoming) {
          const event = normalizeExternalEvent(rawEvent, { hostId, runtime, sessionId: defaultSessionId })
          if (!event || !rememberExternalEvent(event)) continue
          if (!session || session.id !== publicSessionId('local', hostId, runtime, event.sessionId!)) {
            session = upsertExternalSession(event.sessionId!, hostId, runtime, body.session)
          }
          broadcastEvent(event, runtime)
          accepted++
        }

        const ended = body.lifecycle === 'ended' || body.session?.status === 'completed'
        if (ended && session) {
          const completed = { ...session, status: 'completed' as const, lastActivityTime: Date.now() }
          externalSessions.set(session.id, completed)
          broadcast(JSON.stringify({ type: 'session-ended', sessionId: session.id }))
        }

        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ accepted, sessionId: session?.id ?? null }))
      }).catch(error => {
        const message = error instanceof Error ? error.message : 'invalid-payload'
        const status = message === 'body-too-large' ? 413 : message === 'unauthorized' ? 401 : 400
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(JSON.stringify({ error: message }))
        }
      })
    },

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      const models = [...observedModels].sort().join(',').slice(0, 128)
      const runtimes = [wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(',')
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'session_end',
        duration_s: Math.round((Date.now() - sessionStart) / 1000),
        event_count: sessionEventCount,
        models: models || undefined,
        runtimes: runtimes || undefined,
      })
      if (wantClaude) {
        removeDiscoveryFile()
        hookServer?.dispose()
        if (scanInterval) clearInterval(scanInterval)
        projectDirWatcher?.close()
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          if (session.pollTimer) clearInterval(session.pollTimer)
          if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
        }
      }
      codexWatcher?.dispose()
      relayEventSink = null
      relayLifecycleSink = null
    },
  }
}
