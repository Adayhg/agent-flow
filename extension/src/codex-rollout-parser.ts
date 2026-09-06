/**
 * Parser for Codex rollout JSONL files at ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Codex writes five top-level record types. This parser handles all of them:
 *
 *   session_meta  — first line; carries cwd, cli_version, session id, base
 *                   instructions (system prompt)
 *   turn_context  — per turn; carries the authoritative model id for that turn
 *                   plus approval/sandbox policy. May change mid-session.
 *   response_item — OpenAI Responses API-shaped turn data: messages, function
 *                   calls, function call outputs, custom tool calls, reasoning
 *   event_msg     — Codex lifecycle events: task_started/complete, token_count,
 *                   agent_reasoning (plaintext thinking), exec_command_end, etc.
 *   compacted     — auto-compaction marker with replacement_history
 *
 * Dedup strategy:
 *   Messages     — emitted from response_item.message only. event_msg's
 *                   agent_message / user_message are mirrors of the response_item
 *                   content (sometimes imperfect for user messages) and are
 *                   skipped. System-injected user content (IDE context,
 *                   subagent notifications) is filtered.
 *   Reasoning    — emitted from event_msg.agent_reasoning only. response_item's
 *                   reasoning payload carries encrypted_content + summary[] and
 *                   isn't useful for display.
 *   Tool results — emitted from function_call_output / custom_tool_call_output
 *                   only. event_msg.exec_command_end / patch_apply_end are
 *                   parallel signals and are skipped.
 *
 * Collaboration calls are represented as ordinary Responses `function_call`
 * items.  The important detail is that the arguments are not a tool payload:
 * `spawn_agent` takes `{ task_name, message, ... }`, while its successful
 * result is either `{ task_name }` (older rollouts) or `{ agent_id, nickname }`
 * (newer rollouts).  Messages and prompts are deliberately never copied into
 * agent events; only identity metadata is surfaced.
 */

import { AgentEvent } from './protocol'
import {
  ORCHESTRATOR_NAME, HASH_PREFIX_MAX, MESSAGE_MAX, PREVIEW_MAX, RESULT_MAX,
  SESSION_ID_DISPLAY,
  SYSTEM_PROMPT_BASE_TOKENS, SYSTEM_CONTENT_PREFIXES,
} from './constants'
import {
  summarizeInput, summarizeResult, extractInputData, extractFilePath,
  buildDiscovery, detectError,
} from './tool-summarizer'
import { estimateTokenCost, estimateTokensFromText } from './token-estimator'
import { createLogger } from './logger'

const log = createLogger('CodexRolloutParser')

// ─── State ─────────────────────────────────────────────────────────────────

export interface CodexContextBreakdown {
  systemPrompt: number
  userMessages: number
  toolResults: number
  reasoning: number
  subagentResults: number
}

export interface PendingCodexToolCall {
  name: string
  args: string
  startTime: number
  filePath?: string
}

export interface CodexRolloutState {
  /** Model id from the most recent turn_context. Authoritative. */
  model: string | null
  /** Cwd from session_meta, updated by turn_context. */
  cwd: string | null
  /** Session/thread id from session_meta, when present. */
  sessionId: string | null
  /** Parent thread id from session_meta, when this is a nested rollout. */
  parentThreadId: string | null
  /** Label for the session (set from first non-system user message). */
  label: string | null
  /** Pending tool calls, keyed by call_id. */
  pendingToolCalls: Map<string, PendingCodexToolCall>
  /** Content hashes of already-emitted messages (for dedup across replays). */
  seenMessageHashes: Set<string>
  /** Running token breakdown. */
  contextBreakdown: CodexContextBreakdown
  /** Orchestrator agent_spawn emitted flag. */
  spawnEmitted: boolean
  /** Last emitted model id, so we only emit model_detected when it changes. */
  lastEmittedModel: string | null
  /** Authoritative total tokens from the last event_msg.token_count, if any. */
  lastReportedTokens: number | null
  /** Authoritative model_context_window from event_msg.token_count, if any. */
  reportedContextWindow: number | null
  /** Collaboration calls waiting for their function_call_output. */
  pendingCollaborationCalls: Map<string, PendingCollaborationCall>
  /** Reliable child identities observed in successful spawn results. */
  subagentIdentities: Map<string, CodexSubagentIdentity>
  /** Stable ids for which spawn events have already been emitted. */
  emittedSubagentIds: Set<string>
  /** Dispatch/return de-duplication keys. */
  emittedCollaborationEvents: Set<string>
}

export function createCodexRolloutState(): CodexRolloutState {
  return {
    model: null,
    cwd: null,
    sessionId: null,
    parentThreadId: null,
    label: null,
    pendingToolCalls: new Map(),
    seenMessageHashes: new Set(),
    contextBreakdown: {
      systemPrompt: SYSTEM_PROMPT_BASE_TOKENS,
      userMessages: 0,
      toolResults: 0,
      reasoning: 0,
      subagentResults: 0,
    },
    spawnEmitted: false,
    lastEmittedModel: null,
    lastReportedTokens: null,
    reportedContextWindow: null,
    pendingCollaborationCalls: new Map(),
    subagentIdentities: new Map(),
    emittedSubagentIds: new Set(),
    emittedCollaborationEvents: new Set(),
  }
}

// ─── Delegate ──────────────────────────────────────────────────────────────

export interface CodexParserDelegate {
  /** Emit an agent event (sessionId is attached by the watcher, not here). */
  emit(event: AgentEvent): void
  /** Elapsed seconds since the session started. */
  elapsed(): number
  /** Called when a session label is derived from the first user message. */
  setLabel?(label: string): void
  /**
   * The stable visual identity assigned by the watcher after it has resolved
   * the rollout parent graph.  It is deliberately metadata-only: rollout
   * prompts and task text are never used as agent names.
   */
  principal?: CodexRolloutPrincipal
}

/** The visual identity for one rollout inside its Codex thread family. */
export interface CodexRolloutPrincipal {
  id: string
  name: string
  isMain: boolean
  parentId?: string
  /** A missing-but-observed root thread. The watcher de-duplicates this event
   * across every child rollout in the same family. */
  rootPlaceholder?: { id: string; name: string }
}

// ─── Record shapes (structural typing, all fields optional) ────────────────

interface RolloutRecord {
  type?: string
  payload?: unknown
}

interface MessageContent {
  type?: string
  text?: string
}

interface MessagePayload {
  role?: string
  content?: MessageContent[] | string
}

interface FunctionCallPayload {
  name?: string
  arguments?: string
  call_id?: string
}

interface FunctionCallOutputPayload {
  call_id?: string
  output?: unknown
}

interface CustomToolCallPayload {
  name?: string
  input?: string
  call_id?: string
}

interface CustomToolCallOutputPayload {
  call_id?: string
  output?: unknown
}

interface WebSearchCallPayload {
  status?: string
  action?: { type?: string; query?: string }
}

interface SessionMetaPayload {
  id?: string
  session_id?: string
  parent_thread_id?: string
  cwd?: string
  cli_version?: string
  base_instructions?: { text?: string }
}

type CollaborationToolName = 'spawn_agent' | 'send_message' | 'followup_task' | 'wait_agent'

interface PendingCollaborationCall {
  name: CollaborationToolName
  taskName?: string
  target?: string
  targets?: string[]
  model?: string
}

interface CodexSubagentIdentity {
  id: string
  name: string
  task?: string
  model?: string
  /** Fixed role key inferred from task_name; task text is never emitted. */
  workRole?: string
  parentId: string
}

function codexWorkRole(hint: string | undefined): string {
  const value = (hint || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().slice(0, 256)
  if (/orchestrat|coordina|supervis|dispatch|delegat|manager/.test(value)) return 'orchestrator'
  if (/security|seguridad|secure|vulnerab|auth|permission|secret|threat|audit/.test(value)) return 'security'
  if (/test|qa|validat|verif|check|lint|review|regression|quality|prueba/.test(value)) return 'validator'
  if (/research|investig|search|browse|explor|discover|documentacion|docs?\b|read|grep|find/.test(value)) return 'researcher'
  if (/implement|build|code|develop|edit|write|patch|fix|refactor|feature|program/.test(value)) return 'implementer'
  if (/document|readme|guide|manual|changelog/.test(value)) return 'documenter'
  if (/design|diseñ|visual|ui|ux|frontend|css|layout/.test(value)) return 'designer'
  if (/deploy|release|publish|github|merge|integrat|pr\b|pipeline|ship/.test(value)) return 'integrator'
  if (/analys|analiz|inspect|diagnos|metrics|kpi|report/.test(value)) return 'analyst'
  return 'specialist'
}

interface TurnContextPayload {
  model?: string
  cwd?: string
  personality?: string
}

interface CompactedPayload {
  message?: string
  replacement_history?: Array<{ type?: string; role?: string; content?: MessageContent[] | string }>
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

/** Flatten message content into a single trimmed string. */
function flattenContent(content: MessageContent[] | string | undefined): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(c => String(c?.text || '')).join('').trim()
}

/** Markers identifying Codex-injected user messages that contain no real user prompt. */
const CODEX_PURE_INJECTION_PREFIXES = [
  '# AGENTS.md instructions for', // project-level instructions
  '<environment_context>',         // per-turn environment metadata
  '<turn_aborted>',                // interruption marker
  '<subagent_notification>',       // reserved for future subagent support
]

/** Marker the Codex IDE wrapper places before the actual user prompt. */
const CODEX_REQUEST_MARKER = '## My request for Codex:'

/**
 * Extract the real user-authored text from a Codex user message.
 *
 * Codex's IDE wrapper inlines open tabs, active file, diagnostics, etc.
 * before the user's actual request, separated by a "## My request for Codex:"
 * header. For pure injections (AGENTS.md, env context, aborts) we return null
 * so the caller skips the message entirely.
 *
 * Returns null for pure injections, the extracted prompt for wrapped messages,
 * or the original text (trimmed) otherwise.
 */
function extractCodexUserText(raw: string): string | null {
  const text = raw.trim()
  if (!text) return null
  if (SYSTEM_CONTENT_PREFIXES.some(p => text.startsWith(p))) return null
  if (CODEX_PURE_INJECTION_PREFIXES.some(p => text.startsWith(p))) return null
  if (text.startsWith('# Context from my IDE setup:')) {
    const idx = text.indexOf(CODEX_REQUEST_MARKER)
    if (idx < 0) return null // IDE context with no request — skip
    return text.slice(idx + CODEX_REQUEST_MARKER.length).trim() || null
  }
  return text
}

/** Parse tool-call arguments — Codex encodes them as a JSON string. */
function parseArgsJson(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch { return undefined }
}

function isCollaborationTool(name: string): name is CollaborationToolName {
  return name === 'spawn_agent' || name === 'send_message' || name === 'followup_task' || name === 'wait_agent'
}

/** Parse a tool result without exposing its text to the event stream. */
function parseStructuredOutput(raw: unknown): unknown {
  let value = raw
  for (let i = 0; i < 2; i++) {
    if (isRecord(value) && 'output' in value) {
      value = value.output
      continue
    }
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
        continue
      } catch { /* plain result text */ }
    }
    break
  }
  return value
}

function safeIdentityPart(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim()
  // IDs/nicknames are metadata. Do not turn arbitrary prompt text into an id.
  if (!value || value.length > 256 || /[\r\n]/.test(value)) return undefined
  return value
}

function collaborationReference(raw: unknown): string | undefined {
  const direct = safeIdentityPart(raw)
  if (direct) return direct
  if (!isRecord(raw)) return undefined
  return safeIdentityPart(
    raw.agent_id || raw.id || raw.thread_id || raw.nickname || raw.name || raw.task_name,
  )
}

/** Extract an output string from a function_call_output payload.
 *  Codex sometimes encodes output as a JSON object with nested .output. */
function extractOutputString(raw: FunctionCallOutputPayload['output']): string {
  if (typeof raw === 'string') {
    // May itself be a JSON envelope: try to unwrap .output
    try {
      const parsed = JSON.parse(raw)
      if (isRecord(parsed) && typeof parsed.output === 'string') return parsed.output
    } catch { /* raw string, return as-is */ }
    return raw
  }
  if (isRecord(raw) && typeof raw.output === 'string') return raw.output
  return ''
}

/** Pull the first "*** Update File: /path" line out of an apply_patch body. */
function extractPatchFilePath(patch: string): string | undefined {
  const m = patch.match(/^\*\*\* (?:Update File|Add File|Delete File):\s*(.+)$/m)
  return m ? m[1].trim() : undefined
}

// ─── Parser ────────────────────────────────────────────────────────────────

export class CodexRolloutParser {
  constructor(private delegate: CodexParserDelegate) {}

  /** Parse a single JSONL line. Silently skips unparseable/unknown lines. */
  processLine(line: string, state: CodexRolloutState): void {
    const trimmed = line.trim()
    if (!trimmed) return

    let record: RolloutRecord
    try { record = JSON.parse(trimmed) as RolloutRecord }
    catch { return /* partial line at file tail; resume on next read */ }

    switch (record.type) {
      case 'session_meta':
        this.handleSessionMeta(record.payload as SessionMetaPayload, state, false)
        this.ensureSpawned(state)
        this.emitContextUpdate(state)
        return
      case 'turn_context':
        this.ensureSpawned(state)
        return this.handleTurnContext(record.payload as TurnContextPayload, state)
      case 'response_item':
        this.ensureSpawned(state)
        return this.handleResponseItem(record.payload, state)
      case 'event_msg':
        this.ensureSpawned(state)
        return this.handleEventMsg(record.payload, state)
      case 'compacted':
        this.ensureSpawned(state)
        return this.handleCompacted(record.payload as CompactedPayload, state)
      // Ignore unknown types (forward-compatible).
    }
  }

  // ─── Orchestrator lifecycle ──────────────────────────────────────────────

  private ensureSpawned(state: CodexRolloutState): void {
    if (state.spawnEmitted) return
    state.spawnEmitted = true
    const principal = this.principalFor(state)
    if (principal.rootPlaceholder) {
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'agent_spawn',
        payload: {
          id: principal.rootPlaceholder.id,
          name: principal.rootPlaceholder.name,
          isMain: true,
          task: 'Observed parent session',
          runtime: 'codex',
          placeholder: true,
        },
      })
    }
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_spawn',
      payload: {
        id: principal.id,
        name: principal.name,
        ...(principal.parentId ? { parentId: principal.parentId } : {}),
        isMain: principal.isMain,
        ...(principal.isMain ? { task: 'Codex session' } : {}),
        runtime: 'codex',
      },
    })
  }

  /** Use watcher-resolved graph metadata when available. The fallback keeps
   * standalone parser use safe: a child rollout creates an observed-parent
   * placeholder and is never promoted to the main agent. */
  private principalFor(state: CodexRolloutState): CodexRolloutPrincipal {
    if (this.delegate.principal) return this.delegate.principal
    const id = state.sessionId || ORCHESTRATOR_NAME
    const parentId = state.parentThreadId || undefined
    if (!parentId) {
      return { id, name: ORCHESTRATOR_NAME, isMain: true }
    }
    return {
      id,
      name: `Codex agent ${id.slice(0, SESSION_ID_DISPLAY)}`,
      isMain: false,
      parentId,
      rootPlaceholder: { id: parentId, name: ORCHESTRATOR_NAME },
    }
  }

  // ─── session_meta ────────────────────────────────────────────────────────

  private handleSessionMeta(
    payload: SessionMetaPayload | undefined,
    state: CodexRolloutState,
    emitUpdate = true,
  ): void {
    if (!payload) return
    const sessionId = safeIdentityPart(payload.id || payload.session_id)
    if (sessionId) state.sessionId = sessionId
    const parentThreadId = safeIdentityPart(payload.parent_thread_id)
    if (parentThreadId) state.parentThreadId = parentThreadId
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd
    // Estimate system-prompt tokens from base_instructions if present
    const sys = payload.base_instructions?.text
    if (typeof sys === 'string' && sys.length > 0) {
      state.contextBreakdown.systemPrompt = Math.max(
        estimateTokensFromText(sys),
        SYSTEM_PROMPT_BASE_TOKENS,
      )
    }
    if (emitUpdate) this.emitContextUpdate(state)
  }

  // ─── turn_context ────────────────────────────────────────────────────────

  private handleTurnContext(payload: TurnContextPayload | undefined, state: CodexRolloutState): void {
    if (!payload) return
    if (typeof payload.cwd === 'string') state.cwd = payload.cwd
    if (typeof payload.model === 'string' && payload.model !== state.lastEmittedModel) {
      state.model = payload.model
      state.lastEmittedModel = payload.model
      this.delegate.emit({
        time: this.delegate.elapsed(),
        type: 'model_detected',
        payload: { agent: this.currentAgentId(state), model: payload.model },
      })
    }
  }

  // ─── response_item ───────────────────────────────────────────────────────

  private handleResponseItem(payload: unknown, state: CodexRolloutState): void {
    if (!isRecord(payload)) return
    const itemType = payload.type
    switch (itemType) {
      case 'message':
        return this.handleMessage(payload as MessagePayload, state)
      case 'function_call':
        return this.handleFunctionCall(payload as FunctionCallPayload, state)
      case 'function_call_output':
        return this.handleFunctionCallOutput(payload as FunctionCallOutputPayload, state)
      case 'custom_tool_call':
        return this.handleCustomToolCall(payload as CustomToolCallPayload, state)
      case 'custom_tool_call_output':
        return this.handleCustomToolCallOutput(payload as CustomToolCallOutputPayload, state)
      case 'web_search_call':
        return this.handleWebSearchCall(payload as WebSearchCallPayload, state)
      // `reasoning` items carry encrypted_content + a short summary; we emit
      // plaintext reasoning from event_msg.agent_reasoning instead.
    }
  }

  private handleMessage(payload: MessagePayload, state: CodexRolloutState): void {
    const role = payload.role
    if (role !== 'user' && role !== 'assistant') return // skip 'developer' and other injected roles

    const rawText = flattenContent(payload.content)
    if (!rawText) return

    // Codex wraps real user prompts inside IDE-context blocks; extract the
    // actual prompt and skip pure injection messages entirely.
    const text = role === 'user' ? extractCodexUserText(rawText) : rawText
    if (!text) return

    const hash = `${role}:${text.slice(0, HASH_PREFIX_MAX)}`
    if (state.seenMessageHashes.has(hash)) return
    state.seenMessageHashes.add(hash)

    if (role === 'user') {
      state.contextBreakdown.userMessages += estimateTokensFromText(text)
      if (!state.label) {
        state.label = text.slice(0, PREVIEW_MAX)
        this.delegate.setLabel?.(state.label)
      }
    }

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: {
        agent: this.currentAgentId(state),
        role,
        content: text.slice(0, MESSAGE_MAX),
      },
    })
    this.emitContextUpdate(state)
  }

  private handleFunctionCall(payload: FunctionCallPayload, state: CodexRolloutState): void {
    const name = payload.name || 'unknown'
    const callId = payload.call_id
    if (!callId) return

    const args = parseArgsJson(payload.arguments)
    if (isCollaborationTool(name)) {
      this.handleCollaborationCall(name, args, callId, state)
      return
    }
    const argsSummary = summarizeInput(name, args)
    const filePath = extractFilePath(args)

    state.pendingToolCalls.set(callId, {
      name, args: argsSummary, startTime: Date.now(), filePath,
    })

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: this.currentAgentId(state),
        tool: name,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(name, args ?? {}),
      },
    })
  }

  private handleFunctionCallOutput(payload: FunctionCallOutputPayload, state: CodexRolloutState): void {
    const callId = payload.call_id
    if (!callId) return
    const collaboration = state.pendingCollaborationCalls.get(callId)
    if (collaboration) {
      state.pendingCollaborationCalls.delete(callId)
      this.handleCollaborationOutput(collaboration, payload.output, state)
      return
    }
    const pending = state.pendingToolCalls.get(callId)
    if (!pending) return
    state.pendingToolCalls.delete(callId)

    const output = extractOutputString(payload.output)
    const resultSummary = summarizeResult(output).slice(0, RESULT_MAX)
    const tokenCost = estimateTokenCost(pending.name, output)
    state.contextBreakdown.toolResults += tokenCost

    const isError = detectError(output)
    const discovery = buildDiscovery(pending.name, pending.filePath, output)

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: this.currentAgentId(state),
        tool: pending.name,
        result: resultSummary,
        tokenCost,
        ...(isError ? { isError: true, errorMessage: resultSummary } : {}),
        ...(discovery ? { discovery } : {}),
      },
    })
    this.emitContextUpdate(state)
  }

  private handleCustomToolCall(payload: CustomToolCallPayload, state: CodexRolloutState): void {
    const name = payload.name || 'unknown'
    const callId = payload.call_id
    if (!callId) return

    // Custom tool input is a raw string (e.g. the full apply_patch body), not JSON.
    const rawInput = typeof payload.input === 'string' ? payload.input : ''
    const argsSummary = summarizeInput(name, { patch: rawInput })
    const filePath = extractPatchFilePath(rawInput)

    state.pendingToolCalls.set(callId, {
      name, args: argsSummary, startTime: Date.now(), filePath,
    })

    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: this.currentAgentId(state),
        tool: name,
        args: argsSummary,
        preview: `${name}: ${argsSummary}`.slice(0, PREVIEW_MAX),
        inputData: extractInputData(name, { patch: rawInput }),
      },
    })
  }

  private handleCustomToolCallOutput(payload: CustomToolCallOutputPayload, state: CodexRolloutState): void {
    // Same shape as function_call_output for our purposes.
    this.handleFunctionCallOutput(payload, state)
  }

  private currentAgentId(state: CodexRolloutState): string {
    return this.delegate.principal?.id || state.sessionId || ORCHESTRATOR_NAME
  }

  /**
   * Track a collaboration call and emit only a safe, metadata-only tool card.
   * Real Codex rollouts contain the complete child prompt in `message`; it is
   * intentionally not passed to summarizeInput, extractInputData, or events.
   */
  private handleCollaborationCall(
    name: CollaborationToolName,
    args: Record<string, unknown> | undefined,
    callId: string,
    state: CodexRolloutState,
  ): void {
    const taskName = safeIdentityPart(args?.task_name)
    const target = collaborationReference(args?.target)
    const targets = Array.isArray(args?.targets)
      ? args!.targets.map(collaborationReference).filter((x): x is string => !!x)
      : undefined
    const model = safeIdentityPart(args?.model)
    state.pendingCollaborationCalls.set(callId, {
      name, taskName, target, targets, model,
    })

    const safeArgs = taskName || target || (targets && targets.length > 0 ? `${targets.length} targets` : '') || name
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: this.currentAgentId(state),
        tool: name,
        args: safeArgs.slice(0, PREVIEW_MAX),
        preview: `${name}: ${safeArgs}`.slice(0, PREVIEW_MAX),
      },
    })
  }

  private handleCollaborationOutput(
    call: PendingCollaborationCall,
    rawOutput: unknown,
    state: CodexRolloutState,
  ): void {
    const structured = parseStructuredOutput(rawOutput)
    const output = typeof structured === 'string' ? structured : ''
    const outputRecord = isRecord(structured) ? structured : undefined

    // Keep collaboration tool cards balanced without reflecting result text.
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: this.currentAgentId(state),
        tool: call.name,
        result: 'completed',
        tokenCost: 0,
      },
    })

    if (call.name === 'spawn_agent') {
      const child = this.identityFromSpawn(call, outputRecord, state)
      if (child) this.emitSubagent(child, state)
      return
    }

    const references = call.targets ?? (call.target ? [call.target] : [])
    if (references.length === 0) return // wait_agent(timeout_ms) has no child identity
    for (const reference of references) {
      const child = this.resolveSubagent(reference, state)
      if (!child) continue
      if (call.name === 'wait_agent') {
        this.emitSubagentReturn(child, state)
      } else {
        this.emitSubagentDispatch(child, state, call.name)
      }
    }
  }

  private identityFromSpawn(
    call: PendingCollaborationCall,
    output: Record<string, unknown> | undefined,
    state: CodexRolloutState,
  ): CodexSubagentIdentity | undefined {
    // New schema: successful output has an opaque stable id and nickname.
    const id = safeIdentityPart(output?.agent_id || output?.id || output?.thread_id)
    // Do not promote task_name (or any task text) to an agent name. A missing
    // nickname still has a stable, opaque-id-derived display name.
    if (!id) return undefined
    const name = safeIdentityPart(output?.nickname || output?.name)
      || `Codex agent ${id.slice(0, SESSION_ID_DISPLAY)}`
    const stableId = id
    const parentId = safeIdentityPart(output?.parent_id || output?.parentId || output?.parent) || this.currentAgentId(state)
    return {
      id: stableId,
      name,
      parentId,
      ...((safeIdentityPart(output?.model) || call.model)
        ? { model: safeIdentityPart(output?.model) || call.model }
        : {}),
      workRole: codexWorkRole(call.taskName || safeIdentityPart(output?.role)),
    }
  }

  private resolveSubagent(reference: string, state: CodexRolloutState): CodexSubagentIdentity | undefined {
    const byId = state.subagentIdentities.get(reference)
    if (byId) return byId
    const byName = Array.from(state.subagentIdentities.values()).filter(child => child.name === reference)
    // A nominal target is safe only when it resolves to exactly one stable id.
    // Unknown and homonymous targets must not create a fabricated relation.
    return byName.length === 1 ? byName[0] : undefined
  }

  private emitSubagent(child: CodexSubagentIdentity, state: CodexRolloutState): void {
    if (state.emittedSubagentIds.has(child.id)) return
    state.emittedSubagentIds.add(child.id)
    state.subagentIdentities.set(child.id, child)
    this.emitSubagentDispatch(child, state, 'spawn_agent')
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'agent_spawn',
      payload: {
        id: child.id,
        name: child.name,
        parentId: child.parentId,
        parent: this.parentName(child.parentId, state),
        isMain: false,
        task: child.task || child.name,
        ...(child.model ? { model: child.model } : {}),
        ...(child.workRole ? { workRole: child.workRole } : {}),
        runtime: 'codex',
      },
    })
  }

  private emitSubagentDispatch(child: CodexSubagentIdentity, state: CodexRolloutState, operation: string): void {
    const key = `dispatch:${operation}:${child.id}`
    if (state.emittedCollaborationEvents.has(key)) return
    state.emittedCollaborationEvents.add(key)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'subagent_dispatch',
      payload: {
        parent: this.parentName(child.parentId, state),
        parentId: child.parentId,
        child: child.name,
        childId: child.id,
        task: operation === 'spawn_agent' ? (child.task || child.name) : operation,
      },
    })
  }

  private emitSubagentReturn(child: CodexSubagentIdentity, state: CodexRolloutState): void {
    const key = `return:${child.id}`
    if (state.emittedCollaborationEvents.has(key)) return
    state.emittedCollaborationEvents.add(key)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'subagent_return',
      payload: {
        parent: this.parentName(child.parentId, state),
        parentId: child.parentId,
        child: child.name,
        childId: child.id,
        summary: 'completed',
      },
    })
  }

  private parentName(parentId: string, state: CodexRolloutState): string {
    return state.subagentIdentities.get(parentId)?.name || parentId
  }

  private handleWebSearchCall(payload: WebSearchCallPayload, state: CodexRolloutState): void {
    const query = String(payload.action?.query || '')
    if (!query) return
    // Web search is self-contained — emit start + end together.
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_start',
      payload: {
        agent: this.currentAgentId(state),
        tool: 'WebSearch',
        args: query,
        preview: `WebSearch: ${query}`.slice(0, PREVIEW_MAX),
        inputData: { query },
      },
    })
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'tool_call_end',
      payload: {
        agent: this.currentAgentId(state),
        tool: 'WebSearch',
        result: payload.status || 'completed',
        tokenCost: 0,
      },
    })
  }

  // ─── event_msg ───────────────────────────────────────────────────────────

  private handleEventMsg(payload: unknown, state: CodexRolloutState): void {
    if (!isRecord(payload)) return
    switch (payload.type) {
      case 'agent_reasoning':
        return this.handleAgentReasoning(payload, state)
      case 'token_count':
        return this.handleTokenCount(payload, state)
      // Other event_msg types are either mirrors of response_item content
      // (agent_message, user_message, exec_command_end, patch_apply_end) or
      // metadata we don't currently surface (task_started, task_complete,
      // turn_aborted, context_compacted — the latter paired with the
      // top-level `compacted` record which we handle authoritatively).
    }
  }

  /** Codex reports authoritative token usage per turn. Prefer it over our
   *  text-length estimates whenever info is populated.
   *
   *  - `last_token_usage.input_tokens` = size of this turn's prompt = current
   *    context fill (what the gauge should show).
   *  - `total_token_usage.input_tokens` = cumulative across the session — used
   *    for billing, not context fill.
   *  - `model_context_window` = authoritative tokensMax for this model. */
  private handleTokenCount(payload: Record<string, unknown>, state: CodexRolloutState): void {
    const info = payload.info
    if (!isRecord(info)) return

    if (typeof info.model_context_window === 'number' && info.model_context_window > 0) {
      state.reportedContextWindow = info.model_context_window
    }

    const last = info.last_token_usage
    if (isRecord(last) && typeof last.input_tokens === 'number' && last.input_tokens > 0) {
      state.lastReportedTokens = last.input_tokens
      const reasoning = typeof last.reasoning_output_tokens === 'number' ? last.reasoning_output_tokens : 0
      // Re-slice the breakdown so it sums to the authoritative total.
      // Codex doesn't expose user/tool split, so bucket everything non-reasoning
      // under toolResults as a catch-all (systemPrompt is estimated from
      // base_instructions and kept constant).
      state.contextBreakdown.reasoning = reasoning
      state.contextBreakdown.userMessages = 0
      state.contextBreakdown.subagentResults = 0
      state.contextBreakdown.toolResults = Math.max(
        0,
        last.input_tokens - state.contextBreakdown.systemPrompt - reasoning,
      )
    }

    this.emitContextUpdate(state, { authoritative: true })
  }

  private handleAgentReasoning(payload: Record<string, unknown>, state: CodexRolloutState): void {
    const text = typeof payload.text === 'string' ? payload.text.trim() : ''
    if (!text) return

    const hash = `thinking:${text.slice(0, HASH_PREFIX_MAX)}`
    if (state.seenMessageHashes.has(hash)) return
    state.seenMessageHashes.add(hash)

    state.contextBreakdown.reasoning += estimateTokensFromText(text)
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'message',
      payload: {
        agent: this.currentAgentId(state),
        role: 'thinking',
        content: text.slice(0, MESSAGE_MAX),
      },
    })
    this.emitContextUpdate(state)
  }

  // ─── compacted ───────────────────────────────────────────────────────────

  private handleCompacted(payload: CompactedPayload | undefined, state: CodexRolloutState): void {
    if (!payload) return
    // After compaction, the model's working context is limited to
    // replacement_history. Recompute userMessages/reasoning token totals
    // from that new baseline; keep systemPrompt.
    let userTokens = 0
    let toolResultTokens = 0
    for (const entry of payload.replacement_history ?? []) {
      if (entry?.role === 'user') {
        userTokens += estimateTokensFromText(flattenContent(entry.content))
      } else if (entry?.role === 'tool' || entry?.type === 'tool_result') {
        toolResultTokens += estimateTokensFromText(flattenContent(entry.content))
      }
    }
    state.contextBreakdown.userMessages = userTokens
    state.contextBreakdown.toolResults = toolResultTokens
    state.contextBreakdown.reasoning = 0
    state.contextBreakdown.subagentResults = 0
    // systemPrompt stays — it's the base instructions, still counted.
    this.emitContextUpdate(state)
    log.info('Context compacted — token breakdown reset from replacement_history')
  }

  // ─── Shared helpers ──────────────────────────────────────────────────────

  private emitContextUpdate(
    state: CodexRolloutState,
    opts: { authoritative?: boolean } = {},
  ): void {
    const bd = state.contextBreakdown
    const estimated = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
    // Prefer the authoritative total from event_msg.token_count when available.
    const tokens = state.lastReportedTokens ?? estimated
    // Flag events where Codex just reported token_count so the UI can smooth
    // the estimate→authoritative transition instead of jumping. Non-authoritative
    // updates still ride on lastReportedTokens once it's been set, but the
    // breakdown itself is our estimate until the next token_count arrives.
    this.delegate.emit({
      time: this.delegate.elapsed(),
      type: 'context_update',
      payload: {
        agent: this.currentAgentId(state),
        tokens,
        breakdown: { ...bd },
        ...(state.reportedContextWindow ? { tokensMax: state.reportedContextWindow } : {}),
        ...(opts.authoritative ? { isAuthoritative: true } : {}),
      },
    })
  }
}
