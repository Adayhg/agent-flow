'use client'

import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type {
  OfficeAgent,
  OfficeAgentState,
  OfficeEdge,
  OfficeProjection,
  OfficeZone,
} from '@/lib/office'
import { AGENT_WORK_ROLES, agentWorkRoleLabel, modelFamilyLabel, type AgentWorkRole } from '@/lib/agent-role'
import styles from './office.module.css'

type RoomId = 'entrance' | 'meetings' | 'library' | 'desks' | 'lab' | 'decisions' | 'incidents' | 'deliveries'

interface RoomDefinition {
  id: RoomId
  label: string
  hint: string
  icon: string
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
  { id: 'entrance', label: 'Entrada', hint: 'Agentes disponibles', icon: '✦', x: 22, y: 22, width: 198, height: 150 },
  { id: 'meetings', label: 'Reuniones', hint: 'Coordinación', icon: '◌', x: 260, y: 22, width: 226, height: 150 },
  { id: 'library', label: 'Biblioteca', hint: 'Investigación', icon: '▤', x: 526, y: 22, width: 226, height: 150 },
  { id: 'lab', label: 'Laboratorio', hint: 'Herramientas', icon: '⚙', x: 792, y: 22, width: 186, height: 150 },
  { id: 'desks', label: 'Escritorios', hint: 'Trabajo en curso', icon: '▥', x: 22, y: 218, width: 334, height: 184 },
  { id: 'decisions', label: 'Decisiones', hint: 'Esperando permiso', icon: '⚖', x: 396, y: 218, width: 214, height: 184 },
  { id: 'incidents', label: 'Incidencias', hint: 'Necesita atención', icon: '!', x: 650, y: 218, width: 328, height: 184 },
  { id: 'deliveries', label: 'Entregas', hint: 'Trabajo terminado', icon: '✓', x: 260, y: 448, width: 480, height: 154 },
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

const STATE_MARKS: Record<OfficeAgentState, string> = {
  unknown: '•',
  planning: '⌁',
  researching: '⌕',
  editing: '✎',
  executing: '▶',
  waiting_approval: '!',
  blocked: '×',
  completed: '✓',
  idle: '·',
  stale: '…',
}

const ROLE_MARKS: Record<AgentWorkRole, string> = {
  orchestrator: '◆',
  security: '◈',
  validator: '✓',
  researcher: '⌕',
  implementer: '⌘',
  documenter: '▤',
  designer: '✦',
  integrator: '⇄',
  analyst: '▥',
  specialist: '★',
}

interface StandbyAgentDefinition {
  id: string
  name: string
  role: AgentWorkRole
  model?: string
  avatar: 'terra' | 'luna' | 'generated'
  room: RoomId
  x: number
  y: number
}

/** Decorative, non-observed positions shown only while no session is active. */
const STANDBY_AGENTS: readonly StandbyAgentDefinition[] = [
  { id: 'standby-terra', name: 'Terra', role: 'orchestrator', model: 'Terra', avatar: 'terra', room: 'entrance', x: 82, y: 124 },
  { id: 'standby-luna', name: 'Luna', role: 'researcher', model: 'Luna', avatar: 'luna', room: 'meetings', x: 372, y: 124 },
  { id: 'standby-specialist', name: 'Especialista', role: 'specialist', avatar: 'generated', room: 'library', x: 638, y: 124 },
]

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

type OfficeFilterValue = 'all'
type StateFilter = OfficeAgentState | OfficeFilterValue
type RoleFilter = AgentWorkRole | OfficeFilterValue

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
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all')
  const [search, setSearch] = useState('')
  const [zoom, setZoom] = useState(1)
  const agents = useMemo(() => Array.from((projection?.agents ?? agentMap ?? new Map<string, OfficeAgent>()).values()), [projection, agentMap])
  const visibleAgents = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return agents.filter(agent => {
      if (stateFilter !== 'all' && agent.state !== stateFilter) return false
      if (roleFilter !== 'all' && agent.workRole !== roleFilter) return false
      if (!query) return true
      return `${agent.name} ${agent.workLabel ?? ''}`.toLocaleLowerCase().includes(query)
    })
  }, [agents, roleFilter, search, stateFilter])
  const placements = useMemo(() => placeAgents(visibleAgents), [visibleAgents])
  const placementById = useMemo(() => new Map(placements.map(placement => [placement.agent.id, placement])), [placements])
  const hierarchy = useMemo(
    () => (projection?.edges ?? suppliedEdges ?? []).filter(edge => placementById.has(edge.parentId) && placementById.has(edge.childId)),
    [projection, suppliedEdges, placementById],
  )
  const selected = selectedAgentId ? placementById.get(selectedAgentId)?.agent ?? null : null
  const showStandby = agents.length === 0 && !search.trim() && stateFilter === 'all' && roleFilter === 'all'
  const roomCounts = useMemo(() => {
    const counts = new Map<RoomId, number>()
    for (const placement of placements) counts.set(placement.room.id, (counts.get(placement.room.id) ?? 0) + 1)
    return counts
  }, [placements])

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
        {selected
          ? `${visibleName(selected)}: ${STATE_LABELS[selected.state]}`
          : showStandby
            ? 'No hay una sesión activa. Tres agentes preparados aparecen en la sala de espera.'
            : `${visibleAgents.length} agentes visibles de ${agents.length}`}
      </div>

      <div className={styles.officeToolbar} aria-label="Controles de oficina">
        <label className={styles.filterField}>
          <span>Buscar</span>
          <input
            aria-label="Buscar agente por nombre o rol"
            onChange={event => setSearch(event.target.value)}
            placeholder="Nombre o rol"
            type="search"
            value={search}
          />
        </label>
        <label className={styles.filterField}>
          <span>Estado</span>
          <select aria-label="Filtrar por estado" onChange={event => setStateFilter(event.target.value as StateFilter)} value={stateFilter}>
            <option value="all">Todos</option>
            {Object.entries(STATE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className={styles.filterField}>
          <span>Rol</span>
          <select aria-label="Filtrar por rol" onChange={event => setRoleFilter(event.target.value as RoleFilter)} value={roleFilter}>
            <option value="all">Todos</option>
            {AGENT_WORK_ROLES.map(role => <option key={role} value={role}>{agentWorkRoleLabel(role)}</option>)}
          </select>
        </label>
        <div className={styles.zoomControls} aria-label="Zoom de la oficina">
          <button aria-label="Alejar" disabled={zoom <= 0.85} onClick={() => setZoom(value => Math.max(.85, Number((value - .15).toFixed(2))))} type="button">−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button aria-label="Acercar" disabled={zoom >= 1.3} onClick={() => setZoom(value => Math.min(1.3, Number((value + .15).toFixed(2))))} type="button">+</button>
          <button aria-label="Restablecer zoom" disabled={zoom === 1} onClick={() => setZoom(1)} type="button">Reset</button>
        </div>
        {(search || stateFilter !== 'all' || roleFilter !== 'all') && (
          <button className={styles.clearFilters} onClick={() => { setSearch(''); setStateFilter('all'); setRoleFilter('all') }} type="button">Limpiar</button>
        )}
      </div>

      <div className={styles.stageViewport}>
        <div className={styles.stage} style={{ '--office-zoom': zoom } as CSSProperties}>
          <div className={styles.floor} aria-hidden="true">
            {ROOMS.map(room => (
              <div
                className={`${styles.room} ${styles[`room_${room.id}`]}`}
                key={room.id}
                style={{ '--room-x': room.x, '--room-y': room.y, '--room-w': room.width, '--room-h': room.height } as CSSProperties}
              >
                <span className={styles.roomIcon} aria-hidden="true">{room.icon}</span>
                <span className={styles.roomLabel}>{room.label}</span>
                <span className={styles.roomHint}>{room.hint}</span>
                <span className={styles.roomCount}>{roomCounts.get(room.id) ?? 0}</span>
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
          {showStandby && (
            <div className={styles.standbyLayer} aria-label="Agentes preparados en espera">
              {STANDBY_AGENTS.map(standby => <StandbyAgent definition={standby} key={standby.id} />)}
              <div className={styles.waitingBanner} role="status">
                <strong>Sala de espera</strong>
                <span>Agentes preparados para entrar en acción</span>
              </div>
            </div>
          )}
          {visibleAgents.length === 0 && !showStandby && (
            <div className={styles.emptyState} role="status">
              <strong>Ningún agente coincide</strong>
              <span>Cambia o limpia los filtros para volver a ver agentes.</span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.officeLegend} aria-label="Leyenda de oficina">
        <span><i data-tone="active" /> Activo</span>
        <span><i data-tone="waiting" /> Permiso</span>
        <span><i data-tone="standby" /> En espera</span>
        <span><i data-tone="blocked" /> Bloqueado</span>
        <span><i data-tone="complete" /> Completado</span>
        <span className={styles.connectionCount}>{hierarchy.length} conexiones</span>
      </div>

      <div className={styles.mobileList} aria-label={showStandby ? 'Agentes en espera' : 'Lista de agentes'}>
        {showStandby
          ? STANDBY_AGENTS.map(standby => <StandbyAgent definition={standby} key={standby.id} mobile />)
          : placements.map(({ agent, room }) => (
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

interface StandbyAgentProps {
  definition: StandbyAgentDefinition
  mobile?: boolean
}

function StandbyAgent({ definition, mobile = false }: StandbyAgentProps) {
  const roleLabel = agentWorkRoleLabel(definition.role)
  const familyLabel = modelFamilyLabel(definition.model)
  const roleMark = ROLE_MARKS[definition.role]
  const className = [styles.agent, styles.standbyAgent, mobile ? styles.standbyMobile : ''].filter(Boolean).join(' ')
  return (
    <div
      aria-label={`${definition.name}, ${roleLabel}, En espera`}
      className={className}
      data-avatar={definition.avatar}
      data-avatar-key={definition.id}
      data-role={definition.role}
      data-state="idle"
      role="img"
      style={{ '--agent-x': `${definition.x / 10}%`, '--agent-y': `${definition.y / 6.3}%`, '--avatar-hue': avatarHue(definition.id) } as CSSProperties}
      title={`${definition.name} · En espera`}
    >
      <span className={styles.avatar} aria-hidden="true">
        <span className={styles.hair} />
        <span className={styles.face}>{initials(definition.name)}</span>
        <span className={styles.body} />
        <span className={styles.avatarAccessory}>{roleMark}</span>
      </span>
      <span className={styles.agentName}>{definition.name}</span>
      <span className={styles.roleBadge}><span aria-hidden="true">{roleMark}</span>{roleLabel}{familyLabel ? ` · ${familyLabel}` : ''}</span>
      <span className={styles.stateBadge}><span aria-hidden="true">…</span>En espera</span>
    </div>
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
  const roleLabel = agent.workRole ? agentWorkRoleLabel(agent.workRole) : 'Especialista'
  const familyLabel = modelFamilyLabel(agent.model)
  const roleMark = agent.workRole ? ROLE_MARKS[agent.workRole] : ROLE_MARKS.specialist
  const stateMark = STATE_MARKS[agent.state]
  return (
    <button
      aria-pressed={isSelected}
      aria-label={`${name}, ${roleLabel}${familyLabel ? `, ${familyLabel}` : ''}, ${stateLabel}, ${room.label}`}
      className={styles.agent}
      data-role={agent.workRole ?? 'specialist'}
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
        <span className={styles.avatarAccessory}>{roleMark}</span>
      </span>
      <span className={styles.agentName}>{name}</span>
      <span className={styles.roleBadge}><span aria-hidden="true">{roleMark}</span>{roleLabel}{familyLabel ? ` · ${familyLabel}` : ''}</span>
      <span className={styles.stateBadge}><span aria-hidden="true">{stateMark}</span>{stateLabel}</span>
    </button>
  )
}
