'use client'

import { useMemo, type CSSProperties, type KeyboardEvent } from 'react'
import type {
  OfficeAgent,
  OfficeAgentState,
  OfficeEdge,
  OfficeProjection,
  OfficeZone,
} from '@/lib/office'
import styles from './office.module.css'

type RoomId = 'entrance' | 'meetings' | 'library' | 'desks' | 'lab' | 'decisions' | 'incidents' | 'deliveries'

interface RoomDefinition {
  id: RoomId
  label: string
  hint: string
  x: number
  y: number
  width: number
  height: number
}

interface PlacedAgent {
  agent: OfficeAgent
  room: RoomDefinition
  x: number
  y: number
}

const ROOMS: readonly RoomDefinition[] = [
  { id: 'entrance', label: 'Entrada', hint: 'Agentes disponibles', x: 22, y: 22, width: 198, height: 150 },
  { id: 'meetings', label: 'Reuniones', hint: 'Coordinación', x: 260, y: 22, width: 226, height: 150 },
  { id: 'library', label: 'Biblioteca', hint: 'Investigación', x: 526, y: 22, width: 226, height: 150 },
  { id: 'lab', label: 'Laboratorio', hint: 'Herramientas', x: 792, y: 22, width: 186, height: 150 },
  { id: 'desks', label: 'Escritorios', hint: 'Trabajo en curso', x: 22, y: 218, width: 334, height: 184 },
  { id: 'decisions', label: 'Decisiones', hint: 'Esperando permiso', x: 396, y: 218, width: 214, height: 184 },
  { id: 'incidents', label: 'Incidencias', hint: 'Necesita atención', x: 650, y: 218, width: 328, height: 184 },
  { id: 'deliveries', label: 'Entregas', hint: 'Trabajo terminado', x: 260, y: 448, width: 480, height: 154 },
]

const STATE_LABELS: Record<OfficeAgentState, string> = {
  unknown: 'Sin clasificar',
  planning: 'Planificando',
  researching: 'Investigando',
  editing: 'Editando',
  executing: 'Ejecutando',
  waiting_approval: 'Esperando aprobación',
  blocked: 'Bloqueado',
  completed: 'Completado',
  idle: 'Disponible',
  stale: 'Sin actividad reciente',
}

function roomForZone(zone: OfficeZone): RoomId {
  switch (zone) {
    case 'planning': return 'meetings'
    case 'researching': return 'library'
    case 'editing': return 'desks'
    case 'executing': return 'lab'
    case 'waiting_approval': return 'decisions'
    case 'blocked': return 'incidents'
    case 'completed': return 'deliveries'
    case 'idle':
    case 'stale': return 'entrance'
    case 'unknown': return 'entrance'
  }
}

function placeAgents(agents: readonly OfficeAgent[]): PlacedAgent[] {
  const grouped = new Map<RoomId, OfficeAgent[]>()
  for (const room of ROOMS) grouped.set(room.id, [])
  for (const agent of agents) grouped.get(roomForZone(agent.zone))?.push(agent)

  const placements: PlacedAgent[] = []
  for (const room of ROOMS) {
    const occupants = [...(grouped.get(room.id) ?? [])]
      .sort((left, right) => left.slot - right.slot || left.id.localeCompare(right.id))
    const columns = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(occupants.length))))
    const rows = Math.max(1, Math.ceil(occupants.length / columns))

    occupants.forEach((agent, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      // Keep the avatar well inside its room even when many agents arrive at once.
      const x = room.x + room.width * ((column + 1) / (columns + 1))
      const y = room.y + 48 + (room.height - 68) * ((row + 0.55) / rows)
      placements.push({ agent, room, x, y })
    })
  }
  return placements
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return (words.slice(0, 2).map(word => word[0]).join('') || 'A').toUpperCase()
}

function visibleName(agent: OfficeAgent): string {
  return agent.workLabel || agent.name
}

function avatarHue(key: string): number {
  let value = 0
  for (let index = 0; index < key.length; index += 1) value = (value * 31 + key.charCodeAt(index)) % 360
  return value
}

export interface OfficeViewProps {
  /** Privacy-scoped source. This is the preferred Office contract. */
  projection?: OfficeProjection
  /** Alternative Office contract when the caller already holds the two parts. */
  agents?: ReadonlyMap<string, OfficeAgent>
  edges?: readonly OfficeEdge[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onClearSelection?: () => void
  className?: string
  ariaLabel?: string
}

/**
 * Read-only office representation of the current agent graph.
 * It deliberately has no simulation or mutation controls: selecting an agent is
 * delegated to its parent so the existing selection state remains authoritative.
 */
export function OfficeView({
  projection,
  agents: agentMap,
  edges: suppliedEdges,
  selectedAgentId = null,
  onSelectAgent,
  onClearSelection,
  className,
  ariaLabel = 'Oficina de agentes',
}: OfficeViewProps) {
  const agents = useMemo(() => Array.from((projection?.agents ?? agentMap ?? new Map<string, OfficeAgent>()).values()), [projection, agentMap])
  const placements = useMemo(() => placeAgents(agents), [agents])
  const placementById = useMemo(() => new Map(placements.map(placement => [placement.agent.id, placement])), [placements])
  const hierarchy = useMemo(
    () => (projection?.edges ?? suppliedEdges ?? []).filter(edge => placementById.has(edge.parentId) && placementById.has(edge.childId)),
    [projection, suppliedEdges, placementById],
  )
  const selected = selectedAgentId ? placementById.get(selectedAgentId)?.agent ?? null : null

  const selectAt = (nextIndex: number) => {
    const next = placements[(nextIndex + placements.length) % placements.length]
    if (next) onSelectAgent?.(next.agent.id)
  }

  const handleAgentKeyDown = (event: KeyboardEvent<HTMLButtonElement>, agentId: string) => {
    const index = placements.findIndex(placement => placement.agent.id === agentId)
    if (index < 0) return

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      selectAt(index + 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      selectAt(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      selectAt(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      selectAt(placements.length - 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClearSelection?.()
    }
  }

  return (
    <section className={[styles.office, className].filter(Boolean).join(' ')} aria-label={ariaLabel}>
      <div className={styles.srOnly} aria-live="polite">
        {selected ? `${visibleName(selected)}: ${STATE_LABELS[selected.state]}` : `${agents.length} agentes en la oficina`}
      </div>

      <div className={styles.stage}>
        <div className={styles.floor} aria-hidden="true">
          {ROOMS.map(room => (
            <div
              className={`${styles.room} ${styles[`room_${room.id}`]}`}
              key={room.id}
              style={{ '--room-x': room.x, '--room-y': room.y, '--room-w': room.width, '--room-h': room.height } as CSSProperties}
            >
              <span className={styles.roomLabel}>{room.label}</span>
              <span className={styles.roomHint}>{room.hint}</span>
              <span className={styles.roomFurniture} />
            </div>
          ))}
        </div>

        <svg className={styles.edges} viewBox="0 0 1000 630" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <marker id="office-arrow" markerWidth="7" markerHeight="7" refX="5" refY="3.5" orient="auto">
              <path d="M0,0 L7,3.5 L0,7 Z" className={styles.edgeArrow} />
            </marker>
          </defs>
          {hierarchy.map(edge => {
            const from = placementById.get(edge.parentId)
            const to = placementById.get(edge.childId)
            if (!from || !to) return null
            const midX = (from.x + to.x) / 2
            return (
              <path
                className={styles.edge}
                d={`M ${from.x} ${from.y - 15} C ${midX} ${from.y - 48}, ${midX} ${to.y - 48}, ${to.x} ${to.y - 18}`}
                key={edge.id}
                markerEnd="url(#office-arrow)"
                opacity={0.72}
              />
            )
          })}
        </svg>

        <div className={styles.agentLayer}>
          {placements.map(({ agent, room, x, y }) => (
            <OfficeAgent
              agent={agent}
              isSelected={selectedAgentId === agent.id}
              key={agent.id}
              onKeyDown={handleAgentKeyDown}
              onSelect={onSelectAgent}
              room={room}
              style={{ '--agent-x': `${x / 10}%`, '--agent-y': `${y / 6.3}%` } as CSSProperties}
            />
          ))}
        </div>
      </div>

      <div className={styles.mobileList} aria-label="Lista de agentes">
        {placements.map(({ agent, room }) => (
          <OfficeAgent
            agent={agent}
            isSelected={selectedAgentId === agent.id}
            key={agent.id}
            onKeyDown={handleAgentKeyDown}
            onSelect={onSelectAgent}
            room={room}
          />
        ))}
      </div>

      {selected && (
        <aside className={styles.detail} aria-label={`Detalle de ${visibleName(selected)}`}>
          <div className={styles.detailTitle}>
            <span className={styles.detailDot} data-state={selected.state} />
            <strong>{visibleName(selected)}</strong>
            <button className={styles.dismiss} type="button" onClick={onClearSelection} aria-label="Cerrar detalle">×</button>
          </div>
          <span>{STATE_LABELS[selected.state]}</span>
          <span className={styles.zoneLabel}>Zona: {ROOMS.find(room => room.id === roomForZone(selected.zone))?.label}</span>
          {selected.workLabel && selected.name !== selected.workLabel && <span className={styles.sourceName}>Origen: {selected.name}</span>}
          {selected.model && <span className={styles.modelName}>{selected.model}</span>}
          <code className={styles.agentId}>{selected.id}</code>
        </aside>
      )}
    </section>
  )
}

interface OfficeAgentProps {
  agent: OfficeAgent
  room: RoomDefinition
  isSelected: boolean
  onSelect?: (agentId: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>, agentId: string) => void
  style?: CSSProperties
}

function OfficeAgent({ agent, room, isSelected, onSelect, onKeyDown, style }: OfficeAgentProps) {
  const stateLabel = STATE_LABELS[agent.state]
  const name = visibleName(agent)
  return (
    <button
      aria-pressed={isSelected}
      aria-label={`${name}, ${stateLabel}, ${room.label}`}
      className={styles.agent}
      data-state={agent.state}
      data-avatar={agent.avatar.family}
      data-avatar-key={agent.avatar.key}
      onClick={() => onSelect?.(agent.id)}
      onKeyDown={event => onKeyDown(event, agent.id)}
      style={{ ...style, '--avatar-hue': avatarHue(agent.avatar.key) } as CSSProperties}
      title={`${name} · ${stateLabel}`}
      type="button"
    >
      <span className={styles.avatar} aria-hidden="true">
        <span className={styles.hair} />
        <span className={styles.face}>{initials(name)}</span>
        <span className={styles.body} />
      </span>
      <span className={styles.agentName}>{name}</span>
      <span className={styles.stateBadge}>{stateLabel}</span>
    </button>
  )
}
