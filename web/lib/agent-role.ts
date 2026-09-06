export const AGENT_WORK_ROLES = ['orchestrator', 'security', 'validator', 'researcher', 'implementer', 'documenter', 'designer', 'integrator', 'analyst', 'specialist'] as const
export type AgentWorkRole = typeof AGENT_WORK_ROLES[number]

const ROLE_LABELS: Record<AgentWorkRole, string> = {
  orchestrator: 'Orquestador', security: 'Seguridad', validator: 'Validador', researcher: 'Investigador',
  implementer: 'Implementador', documenter: 'Documentador', designer: 'Diseñador', integrator: 'Integrador',
  analyst: 'Analista', specialist: 'Especialista',
}

const ROLE_MATCHERS: ReadonlyArray<readonly [AgentWorkRole, RegExp]> = [
  ['orchestrator', /orchestrat|coordina|supervis|dispatch|delegat|manager/],
  ['security', /security|seguridad|secure|vulnerab|auth|permission|secret|threat|audit/],
  ['validator', /test|qa|validat|verif|check|lint|review|regression|quality|prueba/],
  ['researcher', /research|investig|search|browse|explor|discover|documentacion|docs?\b|read|grep|find/],
  ['implementer', /implement|build|code|develop|edit|write|patch|fix|refactor|feature|program/],
  ['documenter', /document|readme|guide|manual|release notes|changelog/],
  ['designer', /design|diseñ|visual|ui|ux|frontend|css|layout/],
  ['integrator', /deploy|release|publish|github|merge|integrat|pr\b|pipeline|ship/],
  ['analyst', /analys|analiz|inspect|diagnos|metrics|kpi|report/],
]

function normaliseHint(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().slice(0, 256)
    : ''
}

export function isAgentWorkRole(value: unknown): value is AgentWorkRole {
  return typeof value === 'string' && (AGENT_WORK_ROLES as readonly string[]).includes(value)
}

/** Classifies bounded hints; the original task text is never returned. */
export function inferAgentWorkRole(...hints: unknown[]): AgentWorkRole {
  const haystack = hints.map(normaliseHint).filter(Boolean).join(' ')
  for (const [role, matcher] of ROLE_MATCHERS) if (matcher.test(haystack)) return role
  return 'specialist'
}

export function agentWorkRoleLabel(role: AgentWorkRole): string { return ROLE_LABELS[role] }

export function modelFamilyLabel(model?: string): string | undefined {
  const value = normaliseHint(model)
  if (!value) return undefined
  if (value.includes('terra')) return 'Terra'
  if (value.includes('luna')) return 'Luna'
  if (value.includes('codex') || value.includes('gpt')) return 'Codex'
  if (value.includes('claude')) return 'Claude'
  return undefined
}

export function formatAgentWorkLabel(role: AgentWorkRole, model?: string): string {
  const family = modelFamilyLabel(model)
  return family ? `${agentWorkRoleLabel(role)} · ${family}` : agentWorkRoleLabel(role)
}
