import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { CodexSessionWatcher, resolveCodexThreadGroups } from '../src/codex-session-watcher'
import type { AgentEvent } from '../src/protocol'
import type { SessionLifecycleEvent } from '../src/session-runtime'

function stableId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
}

function dayDir(home: string): string {
  const now = new Date()
  return path.join(
    home,
    'sessions',
    String(now.getFullYear()),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  )
}

interface RolloutFixture {
  id: string
  parentId?: string
  /** This is only a filename sort key; mtime remains current for discovery. */
  timestamp: string
}

function collectFamily(rollouts: RolloutFixture[]): {
  events: AgentEvent[]
  lifecycle: SessionLifecycleEvent[]
  detected: string[]
  sessions: ReturnType<CodexSessionWatcher['getActiveSessions']>
} {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-codex-family-'))
  const home = path.join(temp, 'codex-home')
  const workspace = path.join(temp, 'workspace')
  fs.mkdirSync(workspace)
  const rolloutDir = dayDir(home)
  fs.mkdirSync(rolloutDir, { recursive: true })
  for (const rollout of rollouts) {
    const name = `rollout-${rollout.timestamp}-${rollout.id}.jsonl`
    const payload = {
      id: rollout.id,
      cwd: workspace,
      ...(rollout.parentId ? { parent_thread_id: rollout.parentId } : {}),
    }
    fs.writeFileSync(path.join(rolloutDir, name), `${JSON.stringify({ type: 'session_meta', payload })}\n`)
  }

  const previousCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  const watcher = new CodexSessionWatcher(workspace)
  const events: AgentEvent[] = []
  const lifecycle: SessionLifecycleEvent[] = []
  const detected: string[] = []
  const eventSubscription = watcher.onEvent(event => events.push(event))
  const lifecycleSubscription = watcher.onSessionLifecycle(event => lifecycle.push(event))
  const detectedSubscription = watcher.onSessionDetected(id => detected.push(id))
  try {
    watcher.start()
    return { events, lifecycle, detected, sessions: watcher.getActiveSessions() }
  } finally {
    eventSubscription.dispose()
    lifecycleSubscription.dispose()
    detectedSubscription.dispose()
    watcher.dispose()
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    fs.rmSync(temp, { recursive: true, force: true })
  }
}

function spawns(events: AgentEvent[]): AgentEvent[] {
  return events.filter(event => event.type === 'agent_spawn')
}

describe('CodexSessionWatcher family grouping', () => {
  it('exports pure parent-chain grouping without creating a watcher or fs.watch handle', () => {
    const root = stableId(100)
    const child = stableId(101)
    const grandchild = stableId(102)
    const groups = resolveCodexThreadGroups([
      { sessionId: grandchild, parentThreadId: child },
      { sessionId: child, parentThreadId: root },
      { sessionId: root, parentThreadId: null },
    ])

    assert.deepEqual(Array.from(groups.entries()), [
      [grandchild, root],
      [child, root],
      [root, root],
    ])
  })

  it('groups three direct child rollouts under one discovered root despite adversarial filename order', () => {
    const root = stableId(1)
    const children = [stableId(2), stableId(3), stableId(4)]
    // The root sorts after every child. Discovery must still parse root metadata
    // before emitting any event, then attach by hierarchy depth.
    const result = collectFamily([
      ...children.map((id, index) => ({ id, parentId: root, timestamp: `2026-09-05T09-00-0${index}` })),
      { id: root, timestamp: '2026-09-05T23-59-59' },
    ])

    assert.deepEqual(result.sessions.map(session => session.id), [root])
    assert.deepEqual(result.detected, [root])
    assert.equal(result.lifecycle.filter(event => event.type === 'started').length, 1)
    assert.ok(result.events.every(event => event.sessionId === root))

    const family = spawns(result.events)
    assert.equal(family.length, 4)
    assert.ok(family.some(event => event.payload.id === root && event.payload.isMain === true))
    for (const child of children) {
      const spawn = family.find(event => event.payload.id === child)
      assert.ok(spawn)
      assert.equal(spawn!.payload.isMain, false)
      assert.equal(spawn!.payload.parentId, root)
      assert.equal(typeof spawn!.payload.task, 'undefined')
    }
  })

  it('resolves a grandchild through its rollout parent chain to the same root and preserves both edges', () => {
    const root = stableId(10)
    const child = stableId(11)
    const grandchild = stableId(12)
    const result = collectFamily([
      { id: grandchild, parentId: child, timestamp: '2026-09-05T09-00-00' },
      { id: child, parentId: root, timestamp: '2026-09-05T10-00-00' },
      { id: root, timestamp: '2026-09-05T11-00-00' },
    ])

    assert.deepEqual(result.sessions.map(session => session.id), [root])
    assert.ok(result.events.every(event => event.sessionId === root))
    const childSpawn = spawns(result.events).find(event => event.payload.id === child)
    const grandchildSpawn = spawns(result.events).find(event => event.payload.id === grandchild)
    assert.ok(childSpawn)
    assert.ok(grandchildSpawn)
    // The web simulation turns these parentId fields into root→child→grandchild edges.
    assert.equal(childSpawn!.payload.parentId, root)
    assert.equal(grandchildSpawn!.payload.parentId, child)
    assert.equal(childSpawn!.payload.isMain, false)
    assert.equal(grandchildSpawn!.payload.isMain, false)
  })

  it('emits exactly one observed-parent placeholder when the root has no rollout', () => {
    const missingRoot = stableId(20)
    const child = stableId(21)
    const result = collectFamily([{ id: child, parentId: missingRoot, timestamp: '2026-09-05T12-00-00' }])

    assert.deepEqual(result.sessions.map(session => session.id), [missingRoot])
    assert.deepEqual(result.detected, [missingRoot])
    const family = spawns(result.events)
    assert.equal(family.length, 2)
    const placeholder = family.find(event => event.payload.id === missingRoot)
    const childSpawn = family.find(event => event.payload.id === child)
    assert.ok(placeholder)
    assert.ok(childSpawn)
    assert.equal(placeholder!.payload.placeholder, true)
    assert.equal(placeholder!.payload.isMain, true)
    assert.equal(childSpawn!.payload.isMain, false)
    assert.equal(childSpawn!.payload.parentId, missingRoot)
  })

  it('keeps an unparented rollout as its own ordinary session', () => {
    const root = stableId(30)
    const result = collectFamily([{ id: root, timestamp: '2026-09-05T13-00-00' }])

    assert.deepEqual(result.sessions.map(session => session.id), [root])
    const family = spawns(result.events)
    assert.equal(family.length, 1)
    assert.equal(family[0].payload.id, root)
    assert.equal(family[0].payload.isMain, true)
    assert.equal(family[0].payload.placeholder, undefined)
  })
})
