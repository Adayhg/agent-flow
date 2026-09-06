import assert from 'node:assert/strict'
import test from 'node:test'
import {
  agentWorkRoleLabel,
  formatAgentWorkLabel,
  inferAgentWorkRole,
  modelFamilyLabel,
} from './agent-role'

test('infers a stable role from bounded work hints', () => {
  assert.equal(inferAgentWorkRole('Run security audit of auth flow'), 'security')
  assert.equal(inferAgentWorkRole('Write regression tests for the parser'), 'validator')
  assert.equal(inferAgentWorkRole('Explore the API documentation'), 'researcher')
  assert.equal(inferAgentWorkRole('something unclassified'), 'specialist')
})

test('formats a readable role/model label without retaining the hint', () => {
  const label = formatAgentWorkLabel(inferAgentWorkRole('Implement the dashboard'), 'gpt-5.6-luna')
  assert.equal(label, 'Implementador · Luna')
  assert.equal(label.includes('dashboard'), false)
  assert.equal(agentWorkRoleLabel('security'), 'Seguridad')
  assert.equal(modelFamilyLabel('vendor-future-v1'), undefined)
})
