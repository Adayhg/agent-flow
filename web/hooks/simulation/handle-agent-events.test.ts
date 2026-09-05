import assert from 'node:assert/strict'
import test from 'node:test'
import {
  handleAgentComplete,
  handleAgentIdle,
  handleAgentSpawn,
  handleModelDetected,
  handlePermissionRequested,
} from './handle-agent-events'
import { handleSubagentDispatch, handleSubagentReturn } from './handle-subagent-events'
import { createEmptyState } from './types'
import type { ProcessEventContext } from './process-event'

const context = (): ProcessEventContext => ({
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 100,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
})

test('uses stable Codex ids for duplicate display names and lifecycle events', () => {
  const state = createEmptyState()
  const ctx = context()

  handleAgentSpawn({ id: 'root-1', name: 'Orchestrator', isMain: true }, 0, state, ctx)
  handleAgentSpawn({ id: 'worker-1', name: 'worker', parentId: 'root-1' }, 1, state, ctx)
  handleAgentSpawn({ agentId: 'worker-2', name: 'worker', parentId: 'root-1' }, 2, state, ctx)
  // A repeated spawn for the same id reactivates that node; it must not merge
  // with the other node that happens to have the same display name.
  handleAgentSpawn({ id: 'worker-1', name: 'worker', parentId: 'root-1' }, 3, state, ctx)

  assert.equal(state.agents.size, 3)
  assert.equal(state.agents.get('worker-1')?.name, 'worker')
  assert.equal(state.agents.get('worker-2')?.name, 'worker')
  assert.equal(state.agents.get('worker-1')?.parentId, 'root-1')
  assert.equal(state.agents.get('worker-2')?.parentId, 'root-1')
  assert.deepEqual(
    state.edges.map(edge => edge.id),
    ['edge-root-1-worker-1', 'edge-root-1-worker-2'],
  )

  handleSubagentDispatch({
    parentId: 'root-1', childId: 'worker-2', parent: 'worker', child: 'worker', task: 'inspect',
  }, 4, state)
  handleSubagentReturn({
    parentId: 'root-1', childId: 'worker-2', parent: 'worker', child: 'worker', summary: 'done',
  }, 5, state)
  assert.equal(state.particles[0]?.edgeId, 'edge-root-1-worker-2')
  assert.equal(state.particles[1]?.edgeId, 'edge-root-1-worker-2')

  handleModelDetected({ agentId: 'worker-2', agent: 'worker', model: 'gpt-5.6-terra' }, state, ctx)
  assert.equal(state.agents.get('worker-2')?.model, 'gpt-5.6-terra')
  assert.equal(state.agents.get('worker-1')?.model, undefined)

  handlePermissionRequested({ agentId: 'worker-2', agent: 'worker' }, 6, state, ctx)
  assert.equal(state.agents.get('worker-2')?.state, 'waiting_permission')
  handleAgentIdle({ agentId: 'worker-2', name: 'worker' }, state)
  assert.equal(state.agents.get('worker-2')?.state, 'thinking')

  handleAgentComplete({ id: 'worker-2', name: 'worker' }, 7, state, ctx)
  assert.equal(state.agents.get('worker-2')?.state, 'complete')
  assert.notEqual(state.agents.get('worker-1')?.state, 'complete')
})

test('retains name-based Claude relation fallback', () => {
  const state = createEmptyState()
  const ctx = context()
  handleAgentSpawn({ name: 'orchestrator', isMain: true }, 0, state, ctx)
  handleAgentSpawn({ name: 'worker', parent: 'orchestrator' }, 1, state, ctx)

  handleSubagentDispatch({ parent: 'orchestrator', child: 'worker', task: 'inspect' }, 2, state)
  assert.equal(state.particles[0]?.edgeId, 'edge-orchestrator-worker')
  handleAgentComplete({ name: 'worker' }, 3, state, ctx)
  assert.equal(state.agents.get('worker')?.state, 'complete')
})
