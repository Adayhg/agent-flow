import type { AgentWorkRole } from '../agent-role'

/**
 * A deliberately small, UI-agnostic view of a running agent.  This is not a
 * second source of truth: it is a privacy-conscious projection of the event
 * stream already understood by the visualizer.
 */
export type OfficeAgentState =
  | 'unknown'
  | 'planning'
  | 'researching'
  | 'editing'
  | 'executing'
  | 'waiting_approval'
  | 'blocked'
  | 'completed'
  | 'idle'
  | 'stale'

/** The office zone intentionally mirrors the evidence-backed agent state. */
export type OfficeZone = OfficeAgentState

export interface OfficeAvatar {
  /** A stable presentational key; consumers choose the actual artwork. */
  key: string
  /** Known families get a friendly key; every other model gets a generated one. */
  family: 'terra' | 'luna' | 'generated'
}

export interface OfficeAgent {
  /** Opaque, deterministic ID scoped to sessionId + source agent ID. */
  id: string
  /** Opaque source session identifier used to keep aggregate views navigable. */
  sessionId?: string
  /** Short UI label for the source session; prompt text is never copied here. */
  sessionLabel?: string
  /** Source identifier used only to route a selection back to the graph. */
  sourceAgentId?: string
  /** A short label only. Task text, messages and tool arguments are excluded. */
  name: string
  /** Fixed-vocabulary semantic role, never the original prompt. */
  workRole?: AgentWorkRole
  /** Localized role label with an optional model family. */
  workLabel?: string
  parentId: string | null
  state: OfficeAgentState
  zone: OfficeZone
  /** The original reported model, without imposing a catalogue of valid models. */
  model?: string
  avatar: OfficeAvatar
  /** A deterministic placement hint for a UI, not persisted layout state. */
  slot: number
  /** Event-clock timestamp in seconds, as supplied by SimulationEvent.time. */
  lastActivityAt: number
}

export interface OfficeEdge {
  id: string
  parentId: string
  childId: string
  evidence: 'agent_spawn' | 'subagent_dispatch'
}

export interface OfficeProjection {
  agents: ReadonlyMap<string, OfficeAgent>
  edges: readonly OfficeEdge[]
}

/**
 * A widening of SimulationEvent used at the boundary: a relay can send a
 * future event type before this package has learned about it. Such events are
 * safely ignored instead of being coerced into a misleading office state.
 */
export interface OfficeEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
}

export interface OfficeProjectionOptions {
  /** Defaults to the newest event timestamp (so replay output is stable). */
  now?: number
  /** In event-clock seconds. Set to Infinity to disable stale decoration. */
  staleAfterSeconds?: number
}

/** Existing visualizer graph state adapted without exposing UI implementation details. */
export interface OfficeGraphSource {
  sessionId?: string
  agents: Iterable<import('../agent-types').Agent>
  edges: Iterable<import('../agent-types').Edge>
}
