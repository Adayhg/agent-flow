/**
 * Watches Codex rollout JSONL files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Codex writes one JSONL file per session. Each file begins with a session_meta
 * record carrying the cwd, from which we match against the active VS Code
 * workspace. Discovery scans the past few days of session directories (to catch
 * sessions started near midnight), filters by cwd match and recency, and tails
 * matching files.
 *
 * No SQLite dependency — the canonical source is the filesystem. Respects
 * CODEX_HOME for non-default installs.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { AgentEvent, SessionInfo } from './protocol'
import {
  ACTIVE_SESSION_AGE_S, INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME,
  POLL_FALLBACK_MS, SCAN_INTERVAL_MS, SESSION_ID_DISPLAY,
} from './constants'
import { readNewFileLines } from './fs-utils'
import { createLogger } from './logger'
import {
  CodexRolloutParser, CodexRolloutState, createCodexRolloutState,
  type CodexRolloutPrincipal,
} from './codex-rollout-parser'
import type { AgentSessionWatcher, SessionLifecycleEvent } from './session-runtime'
import { TypedEventEmitter } from './typed-event-emitter'

const log = createLogger('CodexSessionWatcher')

/** Number of past YYYY/MM/DD directories to scan during discovery.
 *  3 covers sessions near midnight + timezone-drift. */
const SCAN_DAYS = 3

/** Extract the session UUID from a rollout filename.
 *  Filenames look like: rollout-2026-04-22T09-15-00-{uuid}.jsonl */
const SESSION_ID_FROM_FILENAME = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]{36})\.jsonl$/

interface WatchedCodexSession {
  sessionId: string
  /** Stable root id shared by every rollout in one Codex thread family. */
  groupSessionId: string
  agentName: string
  isMain: boolean
  filePath: string
  fileWatcher: fs.FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  inactivityTimer: NodeJS.Timeout | null
  fileSize: number
  /** Leftover bytes past the last newline from the previous read — prepended
   *  to the next chunk so a JSONL line split across reads gets reassembled. */
  fileTail: string
  sessionStartTime: number
  lastActivityTime: number
  sessionDetected: boolean
  sessionCompleted: boolean
  label: string
  rolloutState: CodexRolloutState
  parser: CodexRolloutParser
}

/** Metadata available in the first session_meta record. Kept separately from
 * live tail state so discovery can resolve a whole parent graph before parsing
 * any rollout content. */
interface CodexSessionMetadata {
  sessionId: string
  parentThreadId: string | null
  cwd: string | null
  filePath: string
  stat: fs.Stats
}

/** Minimal metadata needed to resolve a Codex rollout family. Exported so
 * callers and tests can validate grouping without starting filesystem watches. */
export interface CodexThreadMetadata {
  sessionId: string
  parentThreadId: string | null
}

/**
 * Resolve every rollout id to one stable family/root id using only explicit
 * parent_thread_id metadata. A known parent with no rollout is retained as the
 * conservative root; malformed cycles use their lowest observed id so every
 * member still lands in one deterministic family.
 */
export function resolveCodexThreadGroups(
  records: Iterable<CodexThreadMetadata>,
): Map<string, string> {
  const byId = new Map<string, CodexThreadMetadata>()
  for (const record of records) byId.set(record.sessionId, record)

  const rootFor = (sessionId: string): string => {
    const chain: string[] = []
    let current = sessionId
    while (true) {
      const cycleAt = chain.indexOf(current)
      if (cycleAt >= 0) return chain.slice(cycleAt).sort()[0]
      chain.push(current)
      const metadata = byId.get(current)
      if (!metadata?.parentThreadId) return current
      const parentId = metadata.parentThreadId
      if (!byId.has(parentId)) return parentId
      current = parentId
    }
  }

  const groups = new Map<string, string>()
  for (const id of byId.keys()) groups.set(id, rootFor(id))
  return groups
}

/** One visual session, which may be backed by several rollout files. */
interface CodexSessionGroup {
  sessionId: string
  label: string
  lifecycleEnded: boolean
  completionEmitted: boolean
  /** agent_spawn is idempotent at the group boundary, including placeholders. */
  emittedAgentIds: Set<string>
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
}

function sessionsRoot(): string {
  return path.join(codexHome(), 'sessions')
}

/** Walk the past SCAN_DAYS of sessions/YYYY/MM/DD directories relative to `now`.
 *  Codex's CLI partitioning can use either local or UTC dates depending on the
 *  platform; yield both to be safe. The 3-day window + dedup-via-Set makes this
 *  trivially cheap. */
function recentSessionDirs(now: Date): string[] {
  const root = sessionsRoot()
  const seen = new Set<string>()
  for (let i = 0; i < SCAN_DAYS; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    for (const [y, m, day] of [
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
    ]) {
      const dir = path.join(root,
        String(y),
        String(m).padStart(2, '0'),
        String(day).padStart(2, '0'))
      if (!seen.has(dir)) seen.add(dir)
    }
  }
  return Array.from(seen)
}

function safeMetadataId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= 256 && !/[\r\n]/.test(normalized)
    ? normalized
    : null
}

/** Read the first line of a rollout file to extract session_meta metadata.
 *
 *  UTF-8 safety: `\n` is 0x0a, which never appears as a continuation byte in
 *  a multi-byte UTF-8 sequence (continuation bytes are 0x80–0xBF), so slicing
 *  at the byte-indexed newline is guaranteed to land on a character boundary.
 *
 *  session_meta is typically well under 4KB, but base_instructions (which
 *  newer Codex versions embed in full, including AGENTS.md content) can push
 *  it far larger — keep reading in chunks until the first newline, up to a
 *  1MB cap. Past the cap we give up: JSON.parse fails on the truncated object
 *  and we return null rather than emit a corrupted cwd. */
function readSessionMetadata(filePath: string, fallbackSessionId: string): Pick<CodexSessionMetadata, 'sessionId' | 'parentThreadId' | 'cwd'> | null {
  const CHUNK_SIZE = 65536
  const MAX_FIRST_LINE = 1048576
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const chunks: Buffer[] = []
      let total = 0
      let end = -1
      while (total < MAX_FIRST_LINE) {
        const buf = Buffer.alloc(CHUNK_SIZE)
        const read = fs.readSync(fd, buf, 0, buf.length, total)
        if (read <= 0) break
        const filled = buf.subarray(0, read)
        // indexOf bounded to the filled portion — unwritten bytes are zero and
        // would never match 0x0a, but an explicit end offset makes this obvious.
        const newlineAt = filled.indexOf(0x0a)
        chunks.push(filled)
        total += read
        if (newlineAt >= 0) { end = total - read + newlineAt; break }
      }
      const data = Buffer.concat(chunks)
      const line = data.subarray(0, end >= 0 ? end : data.length).toString('utf-8')
       const parsed = JSON.parse(line) as {
         type?: string
         payload?: { id?: unknown; session_id?: unknown; parent_thread_id?: unknown; cwd?: unknown }
       }
       if (parsed.type !== 'session_meta') return null
       const payload = parsed.payload
       return {
         sessionId: safeMetadataId(payload?.id) || safeMetadataId(payload?.session_id) || fallbackSessionId,
         parentThreadId: safeMetadataId(payload?.parent_thread_id),
         cwd: typeof payload?.cwd === 'string' ? payload.cwd : null,
       }
    } finally { fs.closeSync(fd) }
  } catch { return null }
}

// ─── Watcher ───────────────────────────────────────────────────────────────

export class CodexSessionWatcher implements AgentSessionWatcher {
  private dirWatchers = new Map<string, fs.FSWatcher>()
  private sessions = new Map<string, WatchedCodexSession>()
  /** All eligible rollout metadata seen during this watcher's lifetime. */
  private sessionMetadata = new Map<string, CodexSessionMetadata>()
  /** Visual sessions keyed by their resolved root thread id. */
  private groups = new Map<string, CodexSessionGroup>()
  private workspacePath: string | null = null
  private scanInterval: NodeJS.Timeout | null = null
  /** One-shot flag so the cwd-mismatch hint is logged at most once per process. */
  private cwdMismatchWarned = false

  private readonly _onEvent = new TypedEventEmitter<AgentEvent>()
  private readonly _onSessionDetected = new TypedEventEmitter<string>()
  private readonly _onSessionLifecycle = new TypedEventEmitter<SessionLifecycleEvent>()

  readonly onEvent = this._onEvent.event
  readonly onSessionDetected = this._onSessionDetected.event
  readonly onSessionLifecycle = this._onSessionLifecycle.event

  /** Workspace path used as a cwd filter — Codex sessions are attached only if
   *  their session_meta.cwd matches this path (or is under it). Pass null/undefined
   *  to attach to any Codex session (useful when no workspace is open). */
  constructor(private readonly workspace?: string | null) {}

  isActive(): boolean {
    for (const s of this.sessions.values()) {
      if (s.sessionDetected && !s.sessionCompleted) return true
    }
    return false
  }

  isSessionActive(sessionId: string): boolean {
    const group = this.groups.get(sessionId)
    if (group) return this.groupIsActive(group.sessionId)
    const s = this.sessions.get(sessionId)
    return !!s && s.sessionDetected && !s.sessionCompleted
  }

  getActiveSessions(): SessionInfo[] {
    return Array.from(this.groups.values())
      .map(group => this.sessionInfoForGroup(group))
      .filter((info): info is SessionInfo => info !== null)
  }

  replaySessionStart(sessionIds?: string[]): void {
    for (const group of this.groups.values()) {
      if (!this.groupHasDetectedSession(group.sessionId)) continue
      if (sessionIds && !sessionIds.includes(group.sessionId)) continue
      this._onSessionLifecycle.fire({ type: 'started', sessionId: group.sessionId, label: group.label })
    }
  }

  start(): void {
    if (this.workspace) {
      try { this.workspacePath = fs.realpathSync(this.workspace) }
      catch { this.workspacePath = this.workspace }
    }

    this.scanForSessions()
    this.scanInterval = setInterval(() => this.scanForSessions(), SCAN_INTERVAL_MS)

    // Watch the sessions root for new day directories appearing.
    const root = sessionsRoot()
    if (fs.existsSync(root)) {
      try {
        const rootWatcher = fs.watch(root, { recursive: false }, () => this.scanForSessions())
        this.dirWatchers.set(root, rootWatcher)
      } catch (err) { log.debug('Root dir watch failed:', err) }
    }

    log.info(`Watching ${root} for workspace ${this.workspacePath ?? '<any>'}`)
  }

  private scanForSessions(): void {
    const now = new Date()
    let skippedByCwd = 0
    const candidates = new Map<string, CodexSessionMetadata>()
    for (const dir of recentSessionDirs(now)) {
      if (!fs.existsSync(dir)) continue

      // Watch this day's directory so we pick up new rollout files quickly
      if (!this.dirWatchers.has(dir)) {
        try {
          const w = fs.watch(dir, () => this.scanForSessions())
          this.dirWatchers.set(dir, w)
        } catch (err) { log.debug('Dir watch failed:', dir, err) }
      }

      let entries: string[]
      try { entries = fs.readdirSync(dir).sort() }
      catch { continue }

      for (const name of entries) {
        if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
        const filePath = path.join(dir, name)

        // Recency filter — skip stale files
        let stat: fs.Stats
        try { stat = fs.statSync(filePath) } catch { continue }
        if (stat.size === 0) continue
        const ageS = (Date.now() - stat.mtimeMs) / 1000
        if (ageS > ACTIVE_SESSION_AGE_S) continue

        const metadata = readSessionMetadata(filePath, this.sessionIdFor(filePath))
        if (!metadata) continue

        // Workspace filter — only attach if cwd matches (or no workspace set)
        if (this.workspacePath) {
          const cwd = metadata.cwd
          if (cwd === null) continue
          const resolvedCwd = this.resolvePath(cwd)
          if (!resolvedCwd || !this.pathMatchesWorkspace(resolvedCwd)) {
            skippedByCwd++
            continue
          }
        }

        const discovered: CodexSessionMetadata = { ...metadata, filePath, stat }
        this.sessionMetadata.set(discovered.sessionId, discovered)
        if (!this.sessions.has(discovered.sessionId)) candidates.set(discovered.sessionId, discovered)
      }
    }

    // Discovery is intentionally two-phase. A child file can sort before its
    // root (or a grandchild before its parent); resolve every observed parent
    // edge before attaching a parser so all events share the same group id.
    const groupIds = resolveCodexThreadGroups(this.sessionMetadata.values())
    const depthFor = (metadata: CodexSessionMetadata): number => {
      let depth = 0
      let current = metadata
      const seen = new Set<string>()
      while (current.parentThreadId && !seen.has(current.sessionId)) {
        seen.add(current.sessionId)
        depth++
        const parent = this.sessionMetadata.get(current.parentThreadId)
        if (!parent) break
        current = parent
      }
      return depth
    }
    const ordered = Array.from(candidates.values()).sort((a, b) => {
      const groupOrder = (groupIds.get(a.sessionId) || a.sessionId).localeCompare(groupIds.get(b.sessionId) || b.sessionId)
      if (groupOrder !== 0) return groupOrder
      const depthOrder = depthFor(a) - depthFor(b)
      return depthOrder !== 0 ? depthOrder : a.sessionId.localeCompare(b.sessionId)
    })
    for (const metadata of ordered) {
      this.attachSession(metadata, groupIds.get(metadata.sessionId) || metadata.sessionId)
    }

    // Recent Codex activity exists but none of it belongs to this workspace —
    // the #1 reason users see no Codex events. Say so once, loudly enough to
    // survive the standalone app's default log level.
    if (skippedByCwd > 0 && this.sessions.size === 0 && !this.cwdMismatchWarned) {
      this.cwdMismatchWarned = true
      log.warn(
        `Found ${skippedByCwd} recent Codex session(s), but none ran in ${this.workspacePath}. ` +
        `Codex sessions are only shown for the current workspace — launch the visualizer from the ` +
        `directory where Codex runs (or open that folder in VS Code).`,
      )
    }
  }

  private sessionIdFor(filePath: string): string {
    const m = path.basename(filePath).match(SESSION_ID_FROM_FILENAME)
    return m ? m[1] : path.basename(filePath, '.jsonl')
  }

  private resolvePath(p: string): string | null {
    try { return fs.realpathSync(p) } catch { return p }
  }

  /** Windows filesystems are case-insensitive and tools disagree on drive-letter
   *  case (VS Code reports `c:\...`, Codex writes `C:\...`) — compare folded there. */
  private pathMatchesWorkspace(p: string): boolean {
    if (!this.workspacePath) return true
    const fold = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s
    const candidate = fold(p)
    const workspace = fold(this.workspacePath)
    if (candidate === workspace) return true
    return candidate.startsWith(workspace + path.sep)
  }

  private ensureGroup(groupSessionId: string): CodexSessionGroup {
    let group = this.groups.get(groupSessionId)
    if (!group) {
      group = {
        sessionId: groupSessionId,
        label: `Codex ${groupSessionId.slice(0, SESSION_ID_DISPLAY)}`,
        lifecycleEnded: false,
        completionEmitted: false,
        emittedAgentIds: new Set(),
      }
      this.groups.set(groupSessionId, group)
    }
    return group
  }

  private sessionsInGroup(groupSessionId: string): WatchedCodexSession[] {
    return Array.from(this.sessions.values()).filter(session => session.groupSessionId === groupSessionId)
  }

  private groupIsActive(groupSessionId: string): boolean {
    return this.sessionsInGroup(groupSessionId).some(session => session.sessionDetected && !session.sessionCompleted)
  }

  private groupHasDetectedSession(groupSessionId: string): boolean {
    return this.sessionsInGroup(groupSessionId).some(session => session.sessionDetected)
  }

  private sessionInfoForGroup(group: CodexSessionGroup): SessionInfo | null {
    const sessions = this.sessionsInGroup(group.sessionId)
    if (sessions.length === 0) return null
    return {
      id: group.sessionId,
      label: group.label,
      status: this.groupIsActive(group.sessionId) ? 'active' : 'completed',
      startTime: Math.min(...sessions.map(session => session.sessionStartTime)),
      lastActivityTime: Math.max(...sessions.map(session => session.lastActivityTime)),
    }
  }

  /** Re-emit a rollout event against its family id. Stable agent_spawn ids are
   * deduplicated here because Codex can describe the same child both in its
   * parent's spawn result and in the child's own rollout. */
  private emitForGroup(session: WatchedCodexSession, event: AgentEvent): void {
    if (event.type === 'agent_spawn') {
      const id = typeof event.payload.id === 'string' ? event.payload.id : null
      if (id) {
        const group = this.ensureGroup(session.groupSessionId)
        if (group.emittedAgentIds.has(id)) return
        group.emittedAgentIds.add(id)
      }
    }
    this._onEvent.fire({ ...event, sessionId: session.groupSessionId })
  }

  private principalFor(metadata: CodexSessionMetadata, groupSessionId: string): CodexRolloutPrincipal {
    const rootMetadata = this.sessionMetadata.get(groupSessionId)
    const rootHasRollout = !!rootMetadata && rootMetadata.parentThreadId === null
    const isMain = metadata.sessionId === groupSessionId && rootHasRollout
    return {
      id: metadata.sessionId,
      name: isMain ? ORCHESTRATOR_NAME : `Codex agent ${metadata.sessionId.slice(0, SESSION_ID_DISPLAY)}`,
      isMain,
      ...(metadata.parentThreadId ? { parentId: metadata.parentThreadId } : {}),
      ...(!rootHasRollout ? {
        rootPlaceholder: { id: groupSessionId, name: ORCHESTRATOR_NAME },
      } : {}),
    }
  }

  private attachSession(metadata: CodexSessionMetadata, groupSessionId: string): void {
    const { sessionId, filePath, stat } = metadata
    const group = this.ensureGroup(groupSessionId)
    const principal = this.principalFor(metadata, groupSessionId)
    const label = `Codex ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
    const wasGroupActive = this.groupIsActive(groupSessionId)

    // Build the parser once per session so the delegate closures capture the
    // right session reference and re-emission is stateless on this side.
    const parser = new CodexRolloutParser({
      emit: (event) => {
        const s = this.sessions.get(sessionId)
        if (s) this.emitForGroup(s, event)
      },
      elapsed: () => {
        const s = this.sessions.get(sessionId)
        return s ? (Date.now() - s.sessionStartTime) / 1000 : 0
      },
      setLabel: (newLabel) => {
        const s = this.sessions.get(sessionId)
        // A user message is useful as a title only for a real root rollout.
        // Never derive the synthetic parent's name/title from a child prompt.
        if (!s || !s.isMain || !s.label.startsWith('Codex ')) return
        s.label = newLabel
        const currentGroup = this.ensureGroup(s.groupSessionId)
        currentGroup.label = newLabel
        this._onSessionLifecycle.fire({ type: 'updated', sessionId: s.groupSessionId, label: newLabel })
      },
      principal,
    })

    const session: WatchedCodexSession = {
      sessionId,
      groupSessionId,
      agentName: principal.name,
      isMain: principal.isMain,
      filePath,
      fileWatcher: null,
      pollTimer: null,
      inactivityTimer: null,
      fileSize: 0,
      fileTail: '',
      sessionStartTime: stat.birthtimeMs || stat.mtimeMs,
      lastActivityTime: stat.mtimeMs,
      sessionDetected: false,
      sessionCompleted: false,
      label,
      rolloutState: createCodexRolloutState(),
      parser,
    }
    this.sessions.set(sessionId, session)

    // Drain existing content first, so late-opening panels see full history.
    this.readNewLines(sessionId)

    session.sessionDetected = true
    if (!wasGroupActive) {
      group.lifecycleEnded = false
      group.completionEmitted = false
      this._onSessionDetected.fire(groupSessionId)
      this._onSessionLifecycle.fire({ type: 'started', sessionId: groupSessionId, label: group.label })
    }

    try {
      session.fileWatcher = fs.watch(filePath, () => this.readNewLines(sessionId))
    } catch (err) { log.debug('File watch failed:', filePath, err) }

    // fs.watch on macOS sometimes silently stops after long idle — poll as backup.
    session.pollTimer = setInterval(() => this.readNewLines(sessionId), POLL_FALLBACK_MS)

    this.resetInactivityTimer(sessionId)
    log.info(`Attached to rollout ${sessionId.slice(0, SESSION_ID_DISPLAY)} in group ${groupSessionId.slice(0, SESSION_ID_DISPLAY)} at ${filePath}`)
  }

  private readNewLines(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
    if (!result) return
    session.fileSize = result.newSize
    session.fileTail = result.tail
    session.lastActivityTime = Date.now()

    const wasGroupActive = this.groupIsActive(session.groupSessionId)
    // Re-activate if the session had been marked complete on inactivity —
    // new content means the user resumed the Codex CLI.
    if (session.sessionCompleted) {
      session.sessionCompleted = false
      if (!wasGroupActive) {
        const group = this.ensureGroup(session.groupSessionId)
        group.lifecycleEnded = false
        group.completionEmitted = false
        this._onSessionLifecycle.fire({ type: 'started', sessionId: session.groupSessionId, label: group.label })
      }
      log.info(`Session ${sessionId.slice(0, SESSION_ID_DISPLAY)} re-activated after idle`)
    }

    for (const line of result.lines) {
      try { session.parser.processLine(line, session.rolloutState) }
      catch (err) { log.debug('Parser threw on line:', err) }
    }

    this.resetInactivityTimer(sessionId)
  }

  private resetInactivityTimer(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    if (session.inactivityTimer) { clearTimeout(session.inactivityTimer) }
    session.inactivityTimer = setTimeout(() => {
      if (session.sessionCompleted) return
      session.sessionCompleted = true
      // Child rollouts complete independently. A real root remains alive until
      // the whole family is idle, otherwise the UI would complete active
      // descendants when its own rollout pauses first.
      if (!session.isMain) {
        this.emitForGroup(session, {
          time: (Date.now() - session.sessionStartTime) / 1000,
          type: 'agent_complete',
          payload: { id: session.sessionId, name: session.agentName },
        })
      }
      if (!this.groupIsActive(session.groupSessionId)) {
        const group = this.ensureGroup(session.groupSessionId)
        if (!group.completionEmitted) {
          group.completionEmitted = true
          this.emitForGroup(session, {
            time: (Date.now() - session.sessionStartTime) / 1000,
            type: 'agent_complete',
            payload: { id: session.groupSessionId, name: ORCHESTRATOR_NAME, sessionEnd: true },
          })
        }
        if (!group.lifecycleEnded) {
          group.lifecycleEnded = true
          this._onSessionLifecycle.fire({ type: 'ended', sessionId: session.groupSessionId, label: group.label })
        }
      }
    }, INACTIVITY_TIMEOUT_MS)
  }

  dispose(): void {
    if (this.scanInterval) { clearInterval(this.scanInterval) }
    for (const w of this.dirWatchers.values()) w.close()
    this.dirWatchers.clear()
    for (const s of this.sessions.values()) {
      s.fileWatcher?.close()
      if (s.pollTimer) clearInterval(s.pollTimer)
      if (s.inactivityTimer) clearTimeout(s.inactivityTimer)
    }
    this.sessions.clear()
    this.sessionMetadata.clear()
    this.groups.clear()
    this._onEvent.dispose()
    this._onSessionDetected.dispose()
    this._onSessionLifecycle.dispose()
  }
}
