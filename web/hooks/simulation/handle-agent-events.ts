import {
  type Agent,
  type TimelineEntry,
  emptyContextBreakdown,
} from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { AGENT_SPAWN_DISTANCE } from '@/lib/canvas-constants'
import { pushTimelineBlock, type ProcessEventContext, type MutableEventState } from './process-event'
import { edgeId, asString, asBoolean } from './types'

/** Return the first non-empty string in a list of payload fields. */
function firstString(payload: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const value = payload[field]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Resolve an event's internal agent key. Codex events carry a stable id,
 * whereas the legacy Claude protocol identifies agents by their display name.
 * An explicit id always wins; name lookup is only the compatibility path.
 */
function resolveAgentId(payload: Record<string, unknown>, state: MutableEventState): string {
  const explicitId = firstString(payload, ['id', 'agentId'])
  if (explicitId) return explicitId

  const legacyReference = firstString(payload, ['agent', 'name'])
  if (!legacyReference) return ''
  if (state.agents.has(legacyReference)) return legacyReference

  // A legacy-shaped event can still arrive after a stable-id spawn. Resolve
  // its display name only when there is no explicit id to disambiguate it.
  for (const [id, agent] of state.agents) {
    if (agent.name === legacyReference) return id
  }
  return legacyReference
}

export function handleAgentSpawn(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const displayName = firstString(payload, ['name'])
  const agentId = firstString(payload, ['id', 'agentId']) || displayName
  if (!agentId) return
  const name = displayName || agentId
  const parentId = firstString(payload, ['parentId', 'parent'])
  const isMain = asBoolean(payload.isMain)
  const task = typeof payload.task === 'string' ? payload.task : undefined
  const model = typeof payload.model === 'string' ? payload.model : undefined
  const runtime = payload.runtime === 'codex' ? 'codex' as const : undefined

  // If the agent already exists (e.g. session resuming after inactivity),
  // reactivate it instead of replacing — preserves accumulated stats.
  const existing = state.agents.get(agentId)
  if (existing) {
    state.agents.set(agentId, {
      ...existing,
      ...(displayName ? { name: displayName } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      state: 'idle',
      ...(task ? { task } : {}),
      ...(model ? { model, tokensMax: ctx.getContextWindowSize(model) } : {}),
      ...(runtime ? { runtime } : {}),
    })
    return
  }

  let x = 0, y = 0
  if (parentId) {
    const parent = state.agents.get(parentId)
    if (parent) {
      // Collect angles of existing siblings so we can avoid spawning too close
      const siblingAngles: number[] = []
      for (const a of state.agents.values()) {
        if (a.parentId === parentId && a.id !== agentId) {
          siblingAngles.push(Math.atan2(a.y - parent.y, a.x - parent.x))
        }
      }

      let angle: number
      if (siblingAngles.length === 0) {
        // First child: use hash-based angle
        const hash = agentId.split('').reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0)
        angle = (Math.abs(hash) % 360) * (Math.PI / 180)
      } else {
        // Find the largest angular gap between existing siblings and place in the middle
        siblingAngles.sort((a, b) => a - b)
        let bestGap = 0
        let bestMid = 0
        for (let i = 0; i < siblingAngles.length; i++) {
          const next = i + 1 < siblingAngles.length ? siblingAngles[i + 1] : siblingAngles[0] + Math.PI * 2
          const gap = next - siblingAngles[i]
          if (gap > bestGap) {
            bestGap = gap
            bestMid = siblingAngles[i] + gap / 2
          }
        }
        angle = bestMid
      }

      x = parent.x + Math.cos(angle) * AGENT_SPAWN_DISTANCE
      y = parent.y + Math.sin(angle) * AGENT_SPAWN_DISTANCE
    }
  }

  const agent: Agent = {
    id: agentId, name, state: 'idle',
    parentId: parentId || null,
    tokensUsed: 0, tokensMax: ctx.getContextWindowSize(model),
    contextBreakdown: emptyContextBreakdown(),
    toolCalls: 0, timeAlive: 0,
    x, y, vx: 0, vy: 0,
    pinned: false, isMain,
    ...(runtime ? { runtime } : {}),
    ...(model ? { model } : {}),
    task,
    spawnTime: currentTime,
    opacity: 0, scale: 0.3,
    messageBubbles: [],
  }
  state.agents.set(agentId, agent)

  if (parentId) {
    state.edges.push({ id: edgeId(parentId, agentId), from: parentId, to: agentId, type: 'parent-child', opacity: 0 })
  }

  const timelineEntry: TimelineEntry = {
    id: `timeline-${agentId}`,
    agentId,
    agentName: name,
    startTime: currentTime,
    blocks: [],
  }
  pushTimelineBlock(timelineEntry, currentTime, { type: 'idle', label: 'Starting', color: COLORS.idle }, ctx)
  state.timelineEntries.set(agentId, timelineEntry)

  state.conversations.set(agentId, [])

  if (!ctx.skipForceSync) {
    setTimeout(() => ctx.syncForceSimulation(state.agents, state.edges), 0)
  }
}

export function handleAgentComplete(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentId = resolveAgentId(payload, state)
  const agent = state.agents.get(agentId)
  if (agent && agent.state !== 'complete') {
    state.agents.set(agentId, { ...agent, state: 'complete', completeTime: currentTime })

    const entry = state.timelineEntries.get(agentId)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'complete', label: 'Done', color: COLORS.complete, endTime: currentTime }, ctx)
      entry.endTime = currentTime
    }

    const agentsToComplete = [agentId]
    for (const [childId, childAgent] of state.agents) {
      if (childAgent.parentId === agentId && childAgent.state !== 'complete') {
        state.agents.set(childId, { ...childAgent, state: 'complete', completeTime: currentTime })
        agentsToComplete.push(childId)
        const childEntry = state.timelineEntries.get(childId)
        if (childEntry) {
          pushTimelineBlock(childEntry, currentTime, { type: 'complete', label: 'Done', color: COLORS.complete, endTime: currentTime }, ctx)
          childEntry.endTime = currentTime
        }
      }
    }

    for (const [tcId, tc] of state.toolCalls) {
      if (agentsToComplete.includes(tc.agentId) && tc.state === 'running') {
        state.toolCalls.set(tcId, { ...tc, state: 'complete', completeTime: currentTime })
      }
    }
  }
}

export function handlePermissionRequested(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentId = resolveAgentId(payload, state) || 'Orchestrator'
  const agent = state.agents.get(agentId)
  if (agent && agent.state !== 'complete') {
    state.agents.set(agentId, {
      ...agent,
      state: 'waiting_permission',
    })

    const entry = state.timelineEntries.get(agentId)
    if (entry) {
      pushTimelineBlock(entry, currentTime, { type: 'idle', label: 'Permission', color: COLORS.waiting_permission }, ctx)
    }
  }
}

export function handleAgentIdle(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const idleId = resolveAgentId(payload, state)
  const idleAgent = state.agents.get(idleId)
  if (idleAgent && (idleAgent.state === 'tool_calling' || idleAgent.state === 'waiting_permission')) {
    state.agents.set(idleId, { ...idleAgent, state: 'thinking', currentTool: undefined })
  }
}

export function handleModelDetected(
  payload: Record<string, unknown>,
  state: MutableEventState,
  ctx: ProcessEventContext,
): void {
  const agentId = resolveAgentId(payload, state)
  const model = asString(payload.model)
  const agent = state.agents.get(agentId)
  if (agent) {
    state.agents.set(agentId, {
      ...agent,
      model,
      tokensMax: ctx.getContextWindowSize(model),
    })
  }
}
