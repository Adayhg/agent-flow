import { COLORS } from '@/lib/colors'
import type { MutableEventState } from './process-event'
import { edgeId, asString, LABEL_LEN_SHORT } from './types'

/** Codex supplies stable relation ids; Claude events only have display names. */
function relationId(payload: Record<string, unknown>, idField: string, nameField: string): string {
  return typeof payload[idField] === 'string' && payload[idField]
    ? payload[idField] as string
    : asString(payload[nameField])
}

export function handleSubagentDispatch(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const parentId = relationId(payload, 'parentId', 'parent')
  const childId = relationId(payload, 'childId', 'child')
  const eid = edgeId(parentId, childId)
  const task = asString(payload.task)

  state.particles.push({
    id: `p-disp-${currentTime}-${eid}`,
    edgeId: eid, progress: 0,
    type: 'dispatch', color: COLORS.dispatch,
    size: 6, trailLength: 0.2,
    label: task.slice(0, LABEL_LEN_SHORT),
  })
}

export function handleSubagentReturn(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const parentId = relationId(payload, 'parentId', 'parent')
  const childId = relationId(payload, 'childId', 'child')
  const eid = edgeId(parentId, childId)
  const summary = asString(payload.summary)

  state.particles.push({
    id: `p-ret-${currentTime}-${eid}`,
    edgeId: eid, progress: 1,
    type: 'return', color: COLORS.return,
    size: 5, trailLength: 0.2,
    label: summary.slice(0, LABEL_LEN_SHORT),
  })
}
