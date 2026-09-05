const { spawnSync } = require('node:child_process')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const suites = [
  {
    name: 'web',
    cwd: path.join(root, 'web'),
    args: ['--import', 'tsx', '--test', 'hooks/**/*.test.ts', 'lib/**/*.test.ts'],
  },
  {
    name: 'extension',
    cwd: path.join(root, 'extension'),
    args: ['--import', 'tsx', '--test', 'test/**/*.test.ts'],
  },
]

for (const suite of suites) {
  console.log(`\n[test] ${suite.name}`)
  const result = spawnSync(process.execPath, suite.args, {
    cwd: suite.cwd,
    stdio: 'inherit',
    shell: false,
  })

  if (result.error) {
    console.error(`[test] ${suite.name} failed to start: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
