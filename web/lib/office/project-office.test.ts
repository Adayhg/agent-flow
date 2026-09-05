import assert from 'node:assert/strict'
import test from 'node:test'
import { officeAgentId, projectOffice, projectOfficeGraph } from './project-office'
import type { Agent, Edge } from '../agent-types'
import type { OfficeEvent } from './types'

const event = (type: string, payload: Record<string, unknown>, time = 1, sessionId = 'session-a'): OfficeEvent => ({
  time,
  type,
  payload,
  sessionId,
})

test('deduplicates duplicate spawns and keeps stable session-scoped IDs', () => {
  const projection = projectOffice([
    event('agent_spawn', { name: 'worker', model: 'gpt-5.6-terra' }),
    event('agent_spawn', { name: 'worker', model: 'gpt-5.6-terra' }),
  ])

  assert.equal(projection.agents.size, 1)
  assert.ok(projection.agents.has(officeAgentId('session-a', 'worker')))
})

test('registers an unknown agent immediately after the initial projection and remains idempotent', () => {
  const sessionId = 'office-contract-session'
  const initial = projectOffice([], { now: 100 })
  assert.equal(initial.agents.size, 0)

  const spawn = event(
    'agent_spawn',
    { name: 'future-agent', model: 'vendor-future-v1' },
    101,
    sessionId,
  )
  const startedAt = performance.now()
  const first = projectOffice([spawn])
  const elapsedMs = performance.now() - startedAt
  const agentId = officeAgentId(sessionId, 'future-agent')

  assert.ok(elapsedMs < 2_000, `projection took ${elapsedMs.toFixed(1)}ms`)
  assert.equal(first.agents.size, 1)
  assert.equal(first.agents.get(agentId)?.model, 'vendor-future-v1')
  assert.equal(first.agents.get(agentId)?.avatar.family, 'generated')

  const replay = projectOffice([spawn, { ...spawn, time: 102 }])
  assert.equal(replay.agents.size, 1)
  assert.deepEqual(replay.agents.get(agentId), first.agents.get(agentId))
})

test('same agent name in separate sessions has separate identities', () => {
  const projection = projectOffice([
    event('agent_spawn', { name: 'worker' }, 1, 'session-a'),
    event('agent_spawn', { name: 'worker' }, 1, 'session-b'),
  ])

  assert.equal(projection.agents.size, 2)
  assert.notEqual(officeAgentId('session-a', 'worker'), officeAgentId('session-b', 'worker'))
})

test('does not claim a parent until the parent itself is observed', () => {
  const childId = officeAgentId('session-a', 'child')
  const parentId = officeAgentId('session-a', 'parent')
  const beforeParent = projectOffice([event('agent_spawn', { name: 'child', parent: 'parent' })])
  assert.equal(beforeParent.agents.get(childId)?.parentId, null)
  assert.equal(beforeParent.edges.length, 0)

  const afterParent = projectOffice([
    event('agent_spawn', { name: 'child', parent: 'parent' }),
    event('agent_spawn', { name: 'parent' }, 2),
  ])
  assert.equal(afterParent.agents.get(childId)?.parentId, parentId)
  assert.equal(afterParent.edges[0]?.evidence, 'agent_spawn')
})

test('keeps Terra and Luna explicit while accepting model IDs outside a catalogue', () => {
  const projection = projectOffice([
    event('agent_spawn', { name: 'terra', model: 'gpt-5.6-terra' }),
    event('agent_spawn', { name: 'luna', model: 'gpt-5.6-luna' }),
    event('agent_spawn', { name: 'future', model: 'acme-next-42' }),
  ])

  assert.equal(projection.agents.get(officeAgentId('session-a', 'terra'))?.avatar.family, 'terra')
  assert.equal(projection.agents.get(officeAgentId('session-a', 'luna'))?.avatar.family, 'luna')
  assert.deepEqual(projection.agents.get(officeAgentId('session-a', 'future'))?.avatar.family, 'generated')
  assert.equal(projection.agents.get(officeAgentId('session-a', 'future'))?.model, 'acme-next-42')
})

test('ignores an unknown event type rather than inventing an agent or state', () => {
  const projection = projectOffice([event('relay_future_event', { agent: 'not-created' })])
  assert.equal(projection.agents.size, 0)
})

test('hydrates a previously unknown agent without regressing a newer state', () => {
  const workerId = officeAgentId('session-a', 'worker')
  const projection = projectOffice([
    event('tool_call_start', { agent: 'worker', tool: 'apply_patch' }, 10),
    event('agent_spawn', { name: 'worker', model: 'gpt-5.6-terra' }, 2),
  ])
  const worker = projection.agents.get(workerId)

  assert.equal(worker?.state, 'editing')
  assert.equal(worker?.model, 'gpt-5.6-terra')
  assert.equal(worker?.avatar.family, 'terra')
})

test('adapts graph agents and only joins a parent when a parent-child edge exists', () => {
  const parent: Agent = {
    id: 'parent', name: 'Parent', state: 'idle', parentId: null,
    tokensUsed: 0, tokensMax: 0, contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0, timeAlive: 0, x: 0, y: 0, vx: 0, vy: 0, pinned: false, isMain: true,
    spawnTime: 1, opacity: 1, scale: 1, messageBubbles: [],
  }
  const child: Agent = { ...parent, id: 'child', name: 'Child', parentId: 'parent', isMain: false }
  const edge: Edge = { id: 'parent-child', from: 'parent', to: 'child', type: 'parent-child', opacity: 1 }

  const withoutEdge = projectOfficeGraph({ sessionId: 'graph-session', agents: [parent, child], edges: [] })
  assert.equal(withoutEdge.agents.get(officeAgentId('graph-session', 'child'))?.parentId, null)

  const withEdge = projectOfficeGraph({ sessionId: 'graph-session', agents: [parent, child], edges: [edge] })
  assert.equal(withEdge.agents.get(officeAgentId('graph-session', 'child'))?.parentId, officeAgentId('graph-session', 'parent'))
})
