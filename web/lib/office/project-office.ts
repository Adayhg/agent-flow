import type { Agent, Edge, SimulationEvent } from '../agent-types'
import type {
  OfficeAgent,
  OfficeAgentState,
  OfficeAvatar,
  OfficeEdge,
  OfficeEvent,
  OfficeGraphSource,
  OfficeProjection,
  OfficeProjectionOptions,
} from './types'

const DEFAULT_SESSION_ID = 'default-session'
const DEFAULT_STALE_AFTER_SECONDS = 120
const SLOT_COUNT = 12

interface MutableOfficeState {
  agents: Map<string, OfficeAgent>
  /** Child -> parent evidence. An edge is materialized only after both exist. */
  parentEvidence: Map<string, { parentId: string; evidence: OfficeEdge['evidence'] }>
}

/** FNV-1a produces deterministic, browser-safe opaque identifiers without a dependency. */
function hash(value: string, seed = 0x811c9dc5): string {
  let result = seed >>> 0
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193) >>> 0
  }
  return (`00000000${result.toString(16)}`).slice(-8)
}

function sourceKey(sessionId: string, agentId: string): string {
  return `${sessionId.length}:${sessionId}\u0000${agentId.length}:${agentId}`
}

/** Stable across render/replay, and distinct between different sessions in practice. */
export function officeAgentId(sessionId: string | undefined, agentId: string): string {
  const key = sourceKey(sessionId || DEFAULT_SESSION_ID, agentId)
  return `office-${hash(key)}-${hash(key, 0x9e3779b9)}`
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function eventTime(event: OfficeEvent): number {
  return Number.isFinite(event.time) ? event.time : 0
}

function displayName(agentId: string): string {
  // Do not retain task/message content. Agent names are bounded to avoid making
  // an accidental payload-sized identifier part of the projection.
  return agentId.replace(/\s+/g, ' ').slice(0, 96)
}

function avatarFor(agentId: string, model?: string): OfficeAvatar {
  const normalized = model?.toLowerCase()
  if (normalized?.includes('terra')) return { family: 'terra', key: 'terra' }
  if (normalized?.includes('luna')) return { family: 'luna', key: 'luna' }

  // Unknown and future model IDs are preserved in `model`; their artwork is
  // deterministic rather than being rejected or silently relabelled.
  return { family: 'generated', key: `generated-${hash(model || agentId)}` }
}

function slotFor(sessionId: string, agentId: string): number {
  return parseInt(hash(sourceKey(sessionId, agentId)).slice(0, 6), 16) % SLOT_COUNT
}

function ensureAgent(state: MutableOfficeState, sessionId: string, sourceAgentId: string, at: number): OfficeAgent {
  const id = officeAgentId(sessionId, sourceAgentId)
  const existing = state.agents.get(id)
  if (existing) return existing

  const agent: OfficeAgent = {
    id,
    name: displayName(sourceAgentId),
    parentId: null,
    state: 'unknown',
    zone: 'unknown',
    avatar: avatarFor(sourceAgentId),
    slot: slotFor(sessionId, sourceAgentId),
    lastActivityAt: at,
  }
  state.agents.set(id, agent)
  resolveKnownParent(state, id)
  resolveChildrenForParent(state, id)
  return agent
}

function replaceAgent(state: MutableOfficeState, agent: OfficeAgent, changes: Partial<OfficeAgent>): OfficeAgent {
  const next = { ...agent, ...changes }
  state.agents.set(agent.id, next)
  return next
}

function resolveKnownParent(state: MutableOfficeState, childId: string): void {
  const relation = state.parentEvidence.get(childId)
  const child = state.agents.get(childId)
  if (!relation || !child || !state.agents.has(relation.parentId)) return
  if (child.parentId !== relation.parentId) replaceAgent(state, child, { parentId: relation.parentId })
}

function resolveChildrenForParent(state: MutableOfficeState, parentId: string): void {
  for (const [childId, relation] of state.parentEvidence) {
    if (relation.parentId === parentId) resolveKnownParent(state, childId)
  }
}

function recordParentEvidence(
  state: MutableOfficeState,
  parentId: string,
  childId: string,
  evidence: OfficeEdge['evidence'],
): void {
  // This is the only route to a parentId: same-name guesses are never used.
  state.parentEvidence.set(childId, { parentId, evidence })
  resolveKnownParent(state, childId)
}

function setState(state: MutableOfficeState, agent: OfficeAgent, nextState: OfficeAgentState, at: number): void {
  // A delayed event can enrich metadata, but it must not roll the visible
  // state backwards over a more recent observation.
  if (at < agent.lastActivityAt) return
  replaceAgent(state, agent, { state: nextState, zone: nextState, lastActivityAt: at })
}

function stateForTool(tool: string): OfficeAgentState {
  const normalized = tool.toLowerCase()
  if (/(todo|plan)/.test(normalized)) return 'planning'
  if (/(search|fetch|read|grep|glob|find|research|browse)/.test(normalized)) return 'researching'
  if (/(edit|write|patch|replace)/.test(normalized)) return 'editing'
  // A tool invocation is direct evidence of work, but no claim is made about
  // its domain when the tool is unfamiliar.
  return 'executing'
}

function stateForThinking(content: unknown): OfficeAgentState {
  const normalized = text(content)?.toLowerCase()
  if (!normalized) return 'unknown'
  if (/(blocked|failed|failure|error)/.test(normalized)) return 'blocked'
  if (/(approval|permission|approve)/.test(normalized)) return 'waiting_approval'
  if (/(planning|plan |planing)/.test(normalized)) return 'planning'
  if (/(research|searching|investigat)/.test(normalized)) return 'researching'
  if (/(editing|writing|implementing|patching)/.test(normalized)) return 'editing'
  if (/(executing|running|testing|deploying)/.test(normalized)) return 'executing'
  return 'unknown'
}

function actor(payload: Record<string, unknown>, field: 'agent' | 'name' | 'parent' | 'child'): string | undefined {
  return text(payload[field])
}

function eventAgent(
  state: MutableOfficeState,
  sessionId: string,
  agentId: string | undefined,
  at: number,
): OfficeAgent | undefined {
  return agentId ? ensureAgent(state, sessionId, agentId, at) : undefined
}

function applyEvent(state: MutableOfficeState, event: OfficeEvent): void {
  const sessionId = event.sessionId || DEFAULT_SESSION_ID
  const at = eventTime(event)
  const payload = event.payload || {}

  switch (event.type) {
    case 'agent_spawn': {
      const sourceAgentId = actor(payload, 'name')
      const agent = eventAgent(state, sessionId, sourceAgentId, at)
      if (!agent || !sourceAgentId) return

      const model = text(payload.model)
      const changes: Partial<OfficeAgent> = {}
      if (model) changes.model = model
      if (model) changes.avatar = avatarFor(sourceAgentId, model)
      if (Object.keys(changes).length) replaceAgent(state, agent, changes)
      const parentSourceId = actor(payload, 'parent')
      if (parentSourceId) {
        recordParentEvidence(state, officeAgentId(sessionId, parentSourceId), agent.id, 'agent_spawn')
      }
      return
    }

    case 'agent_complete': {
      const agent = eventAgent(state, sessionId, actor(payload, 'name'), at)
      if (agent) setState(state, agent, 'completed', at)
      return
    }

    case 'agent_idle': {
      const agent = eventAgent(state, sessionId, actor(payload, 'name'), at)
      if (agent) setState(state, agent, 'idle', at)
      return
    }

    case 'permission_requested': {
      const agent = eventAgent(state, sessionId, actor(payload, 'agent') || actor(payload, 'name'), at)
      if (agent) setState(state, agent, 'waiting_approval', at)
      return
    }

    case 'tool_call_start': {
      const agent = eventAgent(state, sessionId, actor(payload, 'agent'), at)
      const tool = text(payload.tool)
      if (agent) setState(state, agent, tool ? stateForTool(tool) : 'executing', at)
      return
    }

    case 'tool_call_end': {
      const agent = eventAgent(state, sessionId, actor(payload, 'agent'), at)
      if (!agent) return
      // Error status is explicit. A successful tool result alone does not tell
      // us what the agent is doing next, so it returns to unknown.
      setState(state, agent, payload.isError === true ? 'blocked' : 'unknown', at)
      return
    }

    case 'message': {
      const agent = eventAgent(state, sessionId, actor(payload, 'agent'), at)
      if (!agent) return
      const next = payload.role === 'thinking' ? stateForThinking(payload.content) : 'unknown'
      setState(state, agent, next, at)
      return
    }

    case 'context_update': {
      const agent = eventAgent(state, sessionId, actor(payload, 'agent'), at)
      if (agent) setState(state, agent, 'unknown', at)
      return
    }

    case 'model_detected': {
      const sourceAgentId = actor(payload, 'agent') || actor(payload, 'name')
      const agent = eventAgent(state, sessionId, sourceAgentId, at)
      const model = text(payload.model)
      if (agent && model && sourceAgentId) {
        replaceAgent(state, agent, { model, avatar: avatarFor(sourceAgentId, model) })
      }
      return
    }

    case 'subagent_dispatch': {
      const parent = eventAgent(state, sessionId, actor(payload, 'parent'), at)
      const child = eventAgent(state, sessionId, actor(payload, 'child'), at)
      if (parent) setState(state, parent, 'planning', at)
      if (parent && child) recordParentEvidence(state, parent.id, child.id, 'subagent_dispatch')
      return
    }

    case 'subagent_return': {
      const parent = eventAgent(state, sessionId, actor(payload, 'parent'), at)
      const child = eventAgent(state, sessionId, actor(payload, 'child'), at)
      if (parent) setState(state, parent, 'unknown', at)
      if (child) setState(state, child, 'unknown', at)
      return
    }

    default:
      // Forward-compatible and deliberately no-op. Unknown relay events are
      // not evidence for a particular person, zone, or model.
  }
}

function edgesFor(state: MutableOfficeState): OfficeEdge[] {
  const edges: OfficeEdge[] = []
  for (const [childId, relation] of state.parentEvidence) {
    const child = state.agents.get(childId)
    if (!child || child.parentId !== relation.parentId || !state.agents.has(relation.parentId)) continue
    edges.push({
      id: `office-edge-${relation.parentId}-${childId}`,
      parentId: relation.parentId,
      childId,
      evidence: relation.evidence,
    })
  }
  return edges.sort((a, b) => a.id.localeCompare(b.id))
}

function withStaleState(agent: OfficeAgent, now: number, staleAfterSeconds: number): OfficeAgent {
  if (!Number.isFinite(staleAfterSeconds) || staleAfterSeconds < 0) return agent
  if (agent.state === 'completed' || agent.state === 'blocked' || agent.state === 'waiting_approval') return agent
  if (now - agent.lastActivityAt <= staleAfterSeconds) return agent
  return { ...agent, state: 'stale', zone: 'stale' }
}

function stateFromGraphAgent(agent: Agent): OfficeAgentState {
  switch (agent.state) {
    case 'tool_calling': return 'executing'
    case 'complete': return 'completed'
    case 'error': return 'blocked'
    case 'waiting_permission': return 'waiting_approval'
    case 'idle': return 'idle'
    // The graph's "thinking" and "paused" labels do not provide enough
    // evidence to choose an Office work zone.
    case 'thinking':
    case 'paused': return 'unknown'
  }
}

function applyGraphAgent(state: MutableOfficeState, sessionId: string, source: Agent): void {
  const at = Number.isFinite(source.completeTime) ? source.completeTime!
    : Number.isFinite(source.spawnTime) ? source.spawnTime
      : 0
  const agent = ensureAgent(state, sessionId, source.id, at)
  const changes: Partial<OfficeAgent> = {
    name: displayName(source.name),
    state: stateFromGraphAgent(source),
    zone: stateFromGraphAgent(source),
    lastActivityAt: at,
  }
  if (source.model) {
    changes.model = source.model
    changes.avatar = avatarFor(source.id, source.model)
  }
  replaceAgent(state, agent, changes)
}

function applyGraphEdge(state: MutableOfficeState, sessionId: string, edge: Edge): void {
  if (edge.type !== 'parent-child') return
  const parentId = officeAgentId(sessionId, edge.from)
  const childId = officeAgentId(sessionId, edge.to)
  // Graph edges are direct parent-child evidence, but never cause a phantom
  // parent/child record to be invented.
  if (state.agents.has(parentId) && state.agents.has(childId)) {
    recordParentEvidence(state, parentId, childId, 'agent_spawn')
  }
}

function projectionFromState(state: MutableOfficeState, options: OfficeProjectionOptions, newestEventTime: number): OfficeProjection {
  const now = options.now ?? newestEventTime
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS
  const agents = new Map<string, OfficeAgent>()
  for (const [id, agent] of state.agents) agents.set(id, withStaleState(agent, now, staleAfterSeconds))
  return { agents, edges: edgesFor(state) }
}

/**
 * Derive an Office projection from existing Agent/Edge/SimulationEvent inputs.
 * The function is pure and does not retain source payloads, making it suitable
 * for replay, live updates, and tests alike.
 */
export function projectOffice(
  events: readonly (SimulationEvent | OfficeEvent)[],
  options: OfficeProjectionOptions = {},
): OfficeProjection {
  const state: MutableOfficeState = {
    agents: new Map(),
    parentEvidence: new Map(),
  }

  let newestEventTime = 0
  for (const event of events) {
    newestEventTime = Math.max(newestEventTime, eventTime(event))
    applyEvent(state, event)
  }

  return projectionFromState(state, options, newestEventTime)
}

/**
 * Adapt the already materialized Agent/Edge graph. Graph edges, not matching
 * names or source `parentId` fields, are the evidence used to connect people.
 */
export function projectOfficeGraph(source: OfficeGraphSource, options: OfficeProjectionOptions = {}): OfficeProjection {
  const sessionId = source.sessionId || DEFAULT_SESSION_ID
  const state: MutableOfficeState = {
    agents: new Map(),
    parentEvidence: new Map(),
  }
  let newestEventTime = 0

  for (const agent of source.agents) {
    applyGraphAgent(state, sessionId, agent)
    newestEventTime = Math.max(newestEventTime, state.agents.get(officeAgentId(sessionId, agent.id))?.lastActivityAt ?? 0)
  }
  for (const edge of source.edges) applyGraphEdge(state, sessionId, edge)

  return projectionFromState(state, options, newestEventTime)
}
